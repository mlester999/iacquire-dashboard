// The proposals phase of the client business tools: with the deployment's proposals flag AND the workspace's own switch on, a client's employee may ASK for a change, and only ever as an
// approval request a person must approve. Nothing it calls changes a CRM record, a message or a booking is never offered, and an approval that was asked for through this tier is blocked at
// execution once the feature is switched off. Two synthetic workspaces; every call goes through the real handler as a gateway would make it.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { ROLE_ABILITIES } from "@/lib/employee-tool-policy";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { decideApproval, createApproval } from "@/server/approvals/service";
import { callAgentTool, MAX_PENDING_CLIENT_PROPOSALS } from "@/server/crm/agent-tools/service";
import { issueAgentToolToken } from "@/server/crm/agent-tools/tokens";
import type { AgentToolName } from "@/server/crm/agent-tools/catalog";
import { listPipelines } from "@/server/crm/pipelines";
import { createTag } from "@/server/crm/tags";
import { defaultSettings } from "@/server/workforce/compiler";
import { clientBusinessMcpToolNamesForRole } from "@/server/workforce/hermes-client-business-mcp-policy";
import { clientToolGate } from "@/server/workforce/hermes-client-business-mcp-gate";
import {
  auditRows, callBody, clientSideEffects, endClientTurns, personContext, postClient, provisionedClient, refused, setClientProposals, setProposalsSwitch, startClientTurn, temporarily, toolJson,
  toolText, withoutAudit, type ClientTenant,
} from "./support/client-business-mcp";

const CONTEXT = "get_role_workspace_context";
const NEVER_OFFERED = ["request_appointment", "prepare_message", "request_send_approval"];

// What each role may PROPOSE, written out on purpose (the policy module's own test pins the same table): a change here is a change a client's employee can ask for.
const WRITES: Record<AgentRoleKey, string[]> = {
  operations_manager: ["create_task"],
  lead_hunter: ["apply_tag", "create_task", "remove_tag"],
  appointment_setter: ["apply_tag", "create_task", "remove_tag", "update_contact"],
  sales_assistant: ["apply_tag", "create_opportunity", "create_task", "move_opportunity_stage", "remove_tag", "update_contact"],
  crm_manager: ["apply_tag", "create_opportunity", "create_task", "move_opportunity_stage", "remove_tag", "update_contact"],
  performance_analyst: [],
};

let a: ClientTenant;
let b: ClientTenant;
let dealId = "";
let openStageId = "";
let wonStageId = "";

type Who = keyof ClientTenant["crm"]["people"];

/** A fresh turn started by this person, then one call as the employee. */
async function call(t: ClientTenant, role: AgentRoleKey, tool: string, args: Record<string, unknown> = {}, who: Who = "owner") {
  await startClientTurn(t, role, t.crm.people[who].id);
  return postClient(t.credentials[role], callBody(tool, args));
}

const reply = (rpc: Awaited<ReturnType<typeof call>>) => toolJson(rpc) as Record<string, unknown> & { status?: string; approvalId?: string; detail?: string; code?: string };
const approvalCount = async (orgId: string) => Number((await withSystem((db) => db.query<{ n: number }>("select count(*)::int as n from approval_requests where org_id = $1", [orgId]))).rows[0].n);
const liveTokens = async () => Number((await withSystem((db) => db.query<{ n: number }>("select count(*)::int as n from crm_agent_tokens where revoked_at is null and expires_at > now()"))).rows[0].n);
const names = (rpc: Awaited<ReturnType<typeof postClient>>) => (rpc.json?.result?.tools ?? []).map((tool) => tool.name).sort();

/** One hash per kind of CRM record a proposal must not touch. A contact's "last activity" (and the update stamp that follows it) is left out: recording that a person was asked is the timeline's own entry, not a change to the contact. */
async function crmFingerprint(t: ClientTenant) {
  return withSystem(async (db) => {
    const hash = async (sql: string) => (await db.query<{ h: string }>(sql, [t.org.id])).rows[0].h;
    return {
      contacts: await hash("select md5(coalesce(string_agg((to_jsonb(c) - 'last_activity_at' - 'updated_at')::text, '|' order by c.id), '')) as h from contacts c where org_id = $1"),
      opportunities: await hash("select md5(coalesce(string_agg(to_jsonb(o)::text, '|' order by o.id), '')) as h from crm_opportunities o where org_id = $1"),
      tasks: await hash("select md5(coalesce(string_agg(to_jsonb(k)::text, '|' order by k.id), '')) as h from tasks k where org_id = $1"),
      contactTags: await hash("select md5(coalesce(string_agg(to_jsonb(g)::text, '|' order by g.contact_id, g.tag_id), '')) as h from crm_contact_tags g where org_id = $1"),
      appointments: await hash("select md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by x.id), '')) as h from appointment_bookings x where org_id = $1"),
    };
  });
}

async function approvalRow(id: string) {
  const { rows } = await withSystem((db) => db.query<{
    org_id: string; requested_by: string | null; kind: string; risk: string; status: string; execution_status: string; execution_detail: string | null; agent_instance_id: string | null;
    action: Record<string, unknown>; hours: number;
  }>(
    `select org_id, requested_by, kind, risk, status, execution_status, execution_detail, agent_instance_id, action, extract(epoch from (expires_at - created_at)) / 3600 as hours
       from approval_requests where id = $1`, [id],
  ));
  return rows[0];
}

const contactRow = (t: ClientTenant) => withSystem(async (db) => (await db.query<{ lead_status: string; lead_score: number | null }>("select lead_status, lead_score from contacts where id = $1", [t.contact.id])).rows[0]);

/** The owner's Allowed actions: a new applied configuration that switches these abilities off (an empty list switches everything back on). */
async function switchOff(t: ClientTenant, role: AgentRoleKey, disabledTools: readonly string[]) {
  await withSystem(async (db) => {
    const v = await db.query<{ id: string }>(
      `insert into agent_config_versions (org_id, agent_instance_id, version, settings, summary, compiled_instructions, policy_version, source, status)
       values ($1, $2, (select coalesce(max(version), 0) + 1 from agent_config_versions where agent_instance_id = $2), $3, 's', '# config', 'p', 'onboarding', 'applied') returning id`,
      [t.org.id, t.agents[role], JSON.stringify({ ...defaultSettings(role), disabledTools })],
    );
    await db.query("update agent_instances set active_config_version_id = $2 where id = $1", [t.agents[role], v.rows[0].id]);
  });
}

beforeAll(async () => {
  a = await provisionedClient({ name: "Chicago Roofing", timezone: "America/Chicago", tag: "Chicagoan", phone: "+13125550101" });
  b = await provisionedClient({ name: "Manila Dental", timezone: "Asia/Manila", tag: "Manilan", phone: "+639171234501", entitled: AGENT_ROLE_KEYS.filter((role) => role !== "sales_assistant") });
  for (const t of [a, b]) await createTag(t.crm.actor("owner"), { name: "VIP" });
  dealId = (await withSystem((db) => db.query<{ id: string }>("select id from crm_opportunities where org_id = $1 and name = $2", [a.org.id, a.dealName]))).rows[0].id;
  const pipeline = (await listPipelines(a.crm.actor("owner"), { ensureDefault: true }))[0];
  openStageId = pipeline.stages.filter((stage) => stage.kind === "open")[1].id;
  wonStageId = pipeline.stages.find((stage) => stage.kind === "won")?.id ?? "";
}, 240_000);

beforeEach(async () => {
  await withSystem((db) => db.query("delete from rate_limit_buckets"));
  setClientProposals(true);
  await setProposalsSwitch(a.org.id, true);
  await setProposalsSwitch(b.org.id, true);
});

afterEach(async () => {
  for (const t of [a, b]) for (const role of AGENT_ROLE_KEYS) await endClientTurns(t, role);
  await withSystem((db) => db.query("delete from member_permission_overrides where org_id = any($1::uuid[])", [[a.org.id, b.org.id]]));
  vi.unstubAllEnvs();
  resetEnvCache();
});

afterAll(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

describe("what a client's employee is offered", () => {
  it("lists the role's reads and its changes, and never a message, a booking request or a send request", async () => {
    for (const role of AGENT_ROLE_KEYS) {
      await startClientTurn(a, role, a.owner.id);
      const rpc = await postClient(a.credentials[role]);
      const listed = names(rpc);
      const reads = clientBusinessMcpToolNamesForRole(role).filter((name) => name !== CONTEXT);
      expect(listed, role).toEqual([CONTEXT, ...reads, ...WRITES[role]].sort());
      for (const never of NEVER_OFFERED) expect(listed, `${role} ${never}`).not.toContain(never);
      // A change is marked as one, so a runtime that cares can tell it from a read.
      for (const tool of rpc.json?.result?.tools ?? []) expect(tool.annotations?.readOnlyHint, `${role} ${tool.name}`).toBe(![...WRITES[role]].includes(tool.name));
    }
  });

  it("offers reads only while the deployment's proposals flag is off, whatever the workspace's own switch says", async () => {
    setClientProposals(false);
    for (const role of ["appointment_setter", "sales_assistant", "crm_manager"] as const) {
      const listed = names(await postClient(a.credentials[role]));
      expect(listed, role).toEqual([CONTEXT, ...clientBusinessMcpToolNamesForRole(role).filter((name) => name !== CONTEXT)].sort());
      for (const write of WRITES[role]) expect(listed, `${role} ${write}`).not.toContain(write);
    }
  });

  it("offers reads only to a workspace whose own switch is off, while another workspace's employees are offered their changes", async () => {
    await setProposalsSwitch(a.org.id, false);
    expect(names(await postClient(a.credentials.crm_manager))).not.toContain("update_contact");
    expect(names(await postClient(b.credentials.crm_manager))).toContain("update_contact");
  });
});

describe("every change an employee asks for is only an approval request", () => {
  const cases: Array<[AgentRoleKey, AgentToolName, () => Record<string, unknown>]> = [
    ["appointment_setter", "update_contact", () => ({ contactId: a.contact.id, changes: { leadStatus: "qualified" }, reason: "They asked for a quote" })],
    ["appointment_setter", "apply_tag", () => ({ contactIds: [a.contact.id], tags: ["VIP"] })],
    ["appointment_setter", "remove_tag", () => ({ contactIds: [a.contact.id], tags: ["VIP"] })],
    ["appointment_setter", "create_task", () => ({ title: "Call Chicagoan back", contactId: a.contact.id })],
    ["sales_assistant", "create_opportunity", () => ({ name: "Second roof Chicagoan", contactId: a.contact.id, pipelineId: a.pipelineId, value: 5000, currency: "USD" })],
    ["sales_assistant", "move_opportunity_stage", () => ({ opportunityId: dealId, stageId: openStageId })],
    ["crm_manager", "move_opportunity_stage", () => ({ opportunityId: dealId, stageId: wonStageId })],
  ];

  for (const [role, tool, args] of cases) {
    it(`${role} asking for ${tool} returns pending_approval, changes no record, and records who asked, a 72-hour life and the forced flag`, async () => {
      await startClientTurn(a, role, a.owner.id);
      const before = { crm: await crmFingerprint(a), other: await crmFingerprint(b), approvals: await approvalCount(a.org.id), otherApprovals: await approvalCount(b.org.id) };
      const rpc = await postClient(a.credentials[role], callBody(tool, args()));
      expect(rpc.status).toBe(200);
      const body = reply(rpc);
      expect(body, tool).toMatchObject({ ok: true, httpStatus: 202, status: "pending_approval", tool });
      expect(String(body.detail)).toMatch(/person must approve[\s\S]*Nothing has changed yet/);
      expect(typeof body.approvalId).toBe("string");
      // Nothing it asked for happened, in this workspace or the other, and the only new row is the request.
      expect(await crmFingerprint(a)).toEqual(before.crm);
      expect(await crmFingerprint(b)).toEqual(before.other);
      expect(await approvalCount(a.org.id)).toBe(before.approvals + 1);
      expect(await approvalCount(b.org.id)).toBe(before.otherApprovals);
      expect(await liveTokens()).toBe(0);
      const approval = await approvalRow(body.approvalId as string);
      expect(approval).toMatchObject({ org_id: a.org.id, requested_by: a.owner.id, kind: "crm_update", status: "pending", execution_status: "not_started", agent_instance_id: a.agents[role] });
      expect(approval.action).toMatchObject({ source: "agent_tool", tool, forcedApproval: true });
      expect(approval.hours).toBeCloseTo(72, 1);
      expect(approval.risk).toBe(tool === "move_opportunity_stage" && args().stageId === wonStageId ? "high" : "medium");
    });
  }

  it("keeps a change a request even for an employee switched to autonomous, because this tier forces it", async () => {
    const original = (await withSystem((db) => db.query<{ mode: string }>("select mode from agent_instances where id = $1", [a.agents.appointment_setter]))).rows[0].mode;
    await temporarily("update agent_instances set mode = 'autonomous' where id = $1", "update agent_instances set mode = $2 where id = $1", [a.agents.appointment_setter], async () => {
      const before = await crmFingerprint(a);
      const body = reply(await call(a, "appointment_setter", "update_contact", { contactId: a.contact.id, changes: { leadScore: 77 } }));
      expect(body).toMatchObject({ ok: true, status: "pending_approval" });
      expect(await crmFingerprint(a)).toEqual(before);
      expect(await contactRow(a)).toMatchObject({ lead_score: null });
    }, [a.agents.appointment_setter, original]);
  });

  it("answers the same request twice in one turn with the same approval, and a different request with another", async () => {
    await startClientTurn(a, "appointment_setter", a.owner.id);
    const request = callBody("create_task", { title: "Call the Chicagoan prospect", contactId: a.contact.id });
    const first = reply(await postClient(a.credentials.appointment_setter, request));
    const before = await approvalCount(a.org.id);
    const replay = reply(await postClient(a.credentials.appointment_setter, request));
    // The gateway may retry under a new request id: it is the same request, so it is the same approval.
    const retried = reply(await postClient(a.credentials.appointment_setter, { ...request, id: 991 }));
    expect(replay).toMatchObject({ ok: true, status: "pending_approval", approvalId: first.approvalId });
    expect(retried).toMatchObject({ ok: true, status: "pending_approval", approvalId: first.approvalId });
    expect(await approvalCount(a.org.id)).toBe(before);
    const other = reply(await postClient(a.credentials.appointment_setter, callBody("create_task", { title: "A different task", contactId: a.contact.id })));
    expect(other.approvalId).not.toBe(first.approvalId);
    expect(await approvalCount(a.org.id)).toBe(before + 1);
  });

  it("tells the employee a person declined the exact request when it is asked again, and asks nobody a second time", async () => {
    await startClientTurn(a, "appointment_setter", a.owner.id);
    const request = callBody("create_task", { title: "Task a person will decline", contactId: a.contact.id });
    const first = reply(await postClient(a.credentials.appointment_setter, request));
    await decideApproval(personContext(a), first.approvalId as string, "reject", "Not now.");
    const before = await approvalCount(a.org.id);
    const again = reply(await postClient(a.credentials.appointment_setter, request));
    expect(again).toMatchObject({ ok: true, status: "unavailable", approvalId: first.approvalId });
    expect(String(again.detail)).toMatch(/declined/);
    expect(await approvalCount(a.org.id)).toBe(before);
  });
});

describe("what is never offered cannot be called by name either", () => {
  it("refuses a message, a booking request and a send request, and creates no approval, token, booking or draft", async () => {
    for (const tool of NEVER_OFFERED) {
      await startClientTurn(a, "appointment_setter", a.owner.id);
      const before = await clientSideEffects();
      const rpc = await postClient(a.credentials.appointment_setter, callBody(tool, { conversationId: a.conversationId, contactId: a.contact.id, startAt: "2026-11-03T14:00:00+00:00", body: "hello", messageId: a.conversationId }));
      expect(refused(rpc), tool).toBe(true);
      expect(toolText(rpc), tool).not.toMatch(/pending_approval|"approvalId"/);
      expect({ ...withoutAudit(await clientSideEffects()), agent_runs: 0 }, tool).toEqual({ ...withoutAudit(before), agent_runs: 0 });
    }
    const drafts = await withSystem((db) => db.query<{ n: number }>("select count(*)::int as n from conversation_messages where org_id = $1 and status = 'draft'", [a.org.id]));
    expect(drafts.rows[0].n).toBe(0);
  });

  it("refuses at the gate a change the role may not ask for, a message or booking tool, and any change while proposals are off", async () => {
    const gate = (role: AgentRoleKey, tool: AgentToolName, orgTenant: ClientTenant = a) => withSystem((db) => clientToolGate(db, { orgId: orgTenant.org.id, agentId: orgTenant.agents[role], roleKey: role, tool }));
    expect(await gate("appointment_setter", "update_contact")).toEqual({ ok: true });
    expect(await gate("operations_manager", "create_task")).toEqual({ ok: true });
    // A role whose scopes do not hold the tool's scope is refused even though the tool is a change this tier knows.
    for (const tool of ["update_contact", "create_task", "apply_tag"] as const) expect(await gate("performance_analyst", tool), tool).toMatchObject({ ok: false, reason: "tool_not_available" });
    expect(await gate("operations_manager", "update_contact")).toMatchObject({ ok: false, reason: "tool_not_available" });
    for (const tool of ["request_appointment", "prepare_message", "request_send_approval"] as const) expect(await gate("appointment_setter", tool), tool).toMatchObject({ ok: false, reason: "tool_not_available" });
    await setProposalsSwitch(a.org.id, false);
    expect(await gate("appointment_setter", "update_contact")).toMatchObject({ ok: false, reason: "tool_not_available" });
    // The other workspace is its own: its plan lost the Sales Assistant, and its own switch is still on.
    expect(await gate("sales_assistant", "update_contact", b)).toMatchObject({ ok: false, reason: "role_not_enabled" });
    expect(await gate("crm_manager", "update_contact", b)).toEqual({ ok: true });
  });

  it("refuses a change by name while the proposals flag is off, and asks nobody", async () => {
    setClientProposals(false);
    await startClientTurn(a, "appointment_setter", a.owner.id);
    const before = await clientSideEffects();
    const rpc = await postClient(a.credentials.appointment_setter, callBody("update_contact", { contactId: a.contact.id, changes: { leadStatus: "qualified" } }));
    expect(refused(rpc)).toBe(true);
    expect({ ...withoutAudit(await clientSideEffects()), agent_runs: 0 }).toEqual({ ...withoutAudit(before), agent_runs: 0 });
  });
});

describe("the person is the one who asks", () => {
  const revoke = (who: Who, permission: string) => withSystem((db) => db.query(
    "insert into member_permission_overrides (org_id, user_id, permission, effect) values ($1, $2, $3, 'revoke') on conflict (org_id, user_id, permission) do update set effect = 'revoke'", [a.org.id, a.crm.people[who].id, permission],
  ));

  it("refuses a person who may not edit contacts before any approval exists, while a colleague who may is served by the same employee", async () => {
    // Control: the sales representative may edit contacts, so the request is recorded as theirs.
    const allowed = reply(await call(a, "appointment_setter", "update_contact", { contactId: a.contact.id, changes: { leadStatus: "contacted" } }, "sales"));
    expect(allowed).toMatchObject({ ok: true, status: "pending_approval" });
    expect((await approvalRow(allowed.approvalId as string)).requested_by).toBe(a.crm.people.sales.id);

    await revoke("sales", "contacts.edit");
    await revoke("sales", "tasks.manage");
    for (const [tool, args] of [["update_contact", { contactId: a.contact.id, changes: { leadStatus: "qualified" } }], ["apply_tag", { contactIds: [a.contact.id], tags: ["VIP"] }], ["create_task", { title: "No permission task" }]] as const) {
      await startClientTurn(a, "appointment_setter", a.crm.people.sales.id);
      const before = { approvals: await approvalCount(a.org.id), tokens: (await clientSideEffects()).crm_agent_tokens, crm: await crmFingerprint(a) };
      const rpc = await postClient(a.credentials.appointment_setter, callBody(tool, { ...args }));
      expect(refused(rpc), tool).toBe(true);
      expect(toolJson(rpc), tool).toMatchObject({ ok: false, code: "forbidden", httpStatus: 403 });
      expect(await approvalCount(a.org.id)).toBe(before.approvals);
      expect((await clientSideEffects()).crm_agent_tokens).toBe(before.tokens);
      expect(await crmFingerprint(a)).toEqual(before.crm);
    }
    const denied = (await auditRows("hermes.business_mcp.read", a.org.id)).filter((row) => row.result === "denied" && row.metadata.reason === "person_permission" && row.actor_user_id === a.crm.people.sales.id);
    expect(denied.length).toBeGreaterThanOrEqual(3);
    // The owner, through the same employee, is still served.
    expect(reply(await call(a, "appointment_setter", "create_task", { title: "Owner task" }))).toMatchObject({ ok: true, status: "pending_approval" });
  });

  it("writes one audit row per recorded request in the workspace, naming the person, the employee and the approval, and no row in another workspace", async () => {
    const before = (await auditRows("hermes.client_business_mcp.proposal_requested", a.org.id)).length;
    const body = reply(await call(a, "crm_manager", "create_task", { title: "Audit this task", contactId: a.contact.id }, "manager"));
    expect(body).toMatchObject({ ok: true, status: "pending_approval" });
    const rows = await auditRows("hermes.client_business_mcp.proposal_requested", a.org.id);
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)).toMatchObject({
      org_id: a.org.id, actor_user_id: a.crm.people.manager.id, agent_instance_id: a.agents.crm_manager, result: "success",
      metadata: { tier: "client", tool: "create_task", role: "crm_manager", jti: a.credentialIds.crm_manager },
    });
    expect(Object.keys(rows.at(-1)?.metadata ?? {}).sort()).toEqual(["jti", "outcome", "role", "runId", "tier", "tool"]);
    expect(await auditRows("hermes.client_business_mcp.proposal_requested", b.org.id)).toHaveLength(0);
    // The shared engine's own row for the call names the person too.
    const engine = (await auditRows("crm.agent_tool.create_task", a.org.id)).at(-1);
    expect(engine).toMatchObject({ org_id: a.org.id, metadata: { outcome: "pending_approval", actingUserId: a.crm.people.manager.id } });
  });
});

describe("the gate decides each change on the workspace's current state", () => {
  it("answers unavailable, and asks nobody, for a change to records kept in another system", async () => {
    await temporarily("update crm_workspaces set mode = 'ghl' where org_id = $1", "update crm_workspaces set mode = 'native' where org_id = $1", [a.org.id], async () => {
      for (const [role, tool, args] of [
        ["appointment_setter", "update_contact", { contactId: a.contact.id, changes: { leadStatus: "qualified" } }],
        ["sales_assistant", "create_opportunity", { name: "Elsewhere deal", pipelineId: a.pipelineId }],
      ] as const) {
        await startClientTurn(a, role, a.owner.id);
        const before = await approvalCount(a.org.id);
        const body = reply(await postClient(a.credentials[role], callBody(tool, { ...args })));
        expect(body, tool).toMatchObject({ ok: true, status: "unavailable", result: { available: false } });
        expect(String((body.result as { detail: string }).detail)).toMatch(/another system/);
        expect(await approvalCount(a.org.id)).toBe(before);
      }
    });
  });

  it("answers unavailable for every change when every action of the role is switched off, and asks nobody", async () => {
    await switchOff(a, "crm_manager", ROLE_ABILITIES.crm_manager);
    try {
      const before = await approvalCount(a.org.id);
      const body = reply(await call(a, "crm_manager", "create_task", { title: "Switched off task" }));
      expect(body).toMatchObject({ ok: true, status: "unavailable" });
      expect(String(body.detail)).toMatch(/Allowed actions/);
      expect(await approvalCount(a.org.id)).toBe(before);
    } finally {
      await switchOff(a, "crm_manager", []);
    }
    expect(reply(await call(a, "crm_manager", "create_task", { title: "Switched on again" }))).toMatchObject({ ok: true, status: "pending_approval" });
  });

  it("refuses to ask for more while the employee already has the maximum waiting, answers a request that is already waiting, and takes new ones again once a person has answered", async () => {
    const lead = a.agents.lead_hunter;
    await startClientTurn(a, "lead_hunter", a.owner.id);
    const first = callBody("create_task", { title: "Cap probe one" });
    const waiting = reply(await postClient(a.credentials.lead_hunter, first));
    expect(waiting.status).toBe("pending_approval");
    const fillers: string[] = [];
    await withSystem(async (db) => {
      for (let i = 1; i < MAX_PENDING_CLIENT_PROPOSALS; i += 1) {
        const id = await createApproval(db, {
          orgId: a.org.id, agentId: lead, kind: "crm_update", title: `Filler ${i}`, action: { source: "agent_tool", v: 1, tool: "create_task", input: { title: `Filler ${i}` } }, reason: "Test filler", expectedEffect: "None.",
          risk: "medium", expiresInHours: 72, idempotencyKey: `cap-filler-${a.org.id}-${i}`, actorKind: "agent",
        });
        if (id) fillers.push(id);
      }
    });
    try {
      expect(fillers).toHaveLength(MAX_PENDING_CLIENT_PROPOSALS - 1);
      const before = await approvalCount(a.org.id);
      // Already waiting: answered with the same request, never refused by the cap.
      expect(reply(await postClient(a.credentials.lead_hunter, first))).toMatchObject({ ok: true, status: "pending_approval", approvalId: waiting.approvalId });
      // A new one is refused and nothing is recorded or announced.
      const noticesBefore = (await clientSideEffects()).notifications;
      const refusedBody = reply(await postClient(a.credentials.lead_hunter, callBody("create_task", { title: "Cap probe two" })));
      expect(refusedBody).toMatchObject({ ok: false, code: "rate_limited", httpStatus: 429 });
      expect(await approvalCount(a.org.id)).toBe(before);
      expect((await clientSideEffects()).notifications).toBe(noticesBefore);
      // A person answers one; the next request is taken.
      await withSystem((db) => db.query("update approval_requests set status = 'cancelled' where id = $1", [fillers[0]]));
      expect(reply(await postClient(a.credentials.lead_hunter, callBody("create_task", { title: "Cap probe two" })))).toMatchObject({ ok: true, status: "pending_approval" });
    } finally {
      await withSystem((db) => db.query("update approval_requests set status = 'cancelled' where agent_instance_id = $1 and status = 'pending'", [lead]));
    }
  });
});

describe("a person decides, once, and only in the workspace that was asked", () => {
  it("lets the workspace's owner approve and carries the change out exactly once, as the employee, with the person's name on the request", async () => {
    const original = await contactRow(a);
    const body = reply(await call(a, "appointment_setter", "update_contact", { contactId: a.contact.id, changes: { leadStatus: "qualified", leadScore: 61 } }));
    const id = body.approvalId as string;
    expect(await contactRow(a)).toEqual(original);
    expect(original.lead_status).not.toBe("qualified");
    const ctx = personContext(a);
    // Three decisions started together. The embedded database runs one transaction at a time, so this proves a repeated decision is refused and run once; the atomic compare-and-set
    // that makes simultaneous decisions safe on hosted Postgres is held by the source test below.
    const results = await Promise.allSettled([1, 2, 3].map(() => decideApproval(ctx, id, "approve")));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await contactRow(a)).toEqual({ lead_status: "qualified", lead_score: 61 });
    expect(await approvalRow(id)).toMatchObject({ status: "approved", execution_status: "succeeded", requested_by: a.owner.id });
    const done = await withSystem((db) => db.query<{ n: number }>("select count(*)::int as n from audit_logs where approval_id = $1 and action = 'crm.agent_tool.update_contact' and metadata->>'approved' = 'true'", [id]));
    expect(done.rows[0].n).toBe(1);
    // Asked again in the same turn, the employee is told it was already carried out, and nothing is repeated.
    const fingerprint = await crmFingerprint(a);
    const again = reply(await postClient(a.credentials.appointment_setter, callBody("update_contact", { contactId: a.contact.id, changes: { leadStatus: "qualified", leadScore: 61 } })));
    expect(again).toMatchObject({ ok: true, status: "done", approvalId: id });
    expect(String(again.detail)).toMatch(/not repeated/);
    expect(await crmFingerprint(a)).toEqual(fingerprint);
    await withSystem((db) => db.query("update contacts set lead_status = $2, lead_score = $3 where id = $1", [a.contact.id, original.lead_status, original.lead_score]));
  });

  it("decides with one compare-and-set on the pending status, before anything is carried out", () => {
    const src = readFileSync(path.resolve(import.meta.dirname, "..", "src/server/approvals/service.ts"), "utf8");
    const body = src.slice(src.indexOf("export async function decideApproval"));
    const cas = body.indexOf("where id = $1 and org_id = $2 and status = 'pending'");
    expect(cas).toBeGreaterThan(-1);
    expect(cas).toBeLessThan(body.indexOf("executeApproval("));
  });

  it("refuses another workspace's owner and a member who may not decide, and leaves the request waiting and the record unchanged", async () => {
    const body = reply(await call(a, "appointment_setter", "update_contact", { contactId: a.contact.id, changes: { leadScore: 33 } }));
    const id = body.approvalId as string;
    const before = await crmFingerprint(a);
    await expect(decideApproval(personContext(b), id, "approve")).rejects.toMatchObject({ code: "not_found" });
    await expect(decideApproval(personContext(a, "sales"), id, "approve")).rejects.toMatchObject({ code: "forbidden" });
    expect(await approvalRow(id)).toMatchObject({ status: "pending", execution_status: "not_started" });
    expect(await crmFingerprint(a)).toEqual(before);
    // Another workspace's approvals are not visible to this one either.
    const b2 = reply(await call(b, "crm_manager", "create_task", { title: "Manila task" }));
    await expect(decideApproval(personContext(a), b2.approvalId as string, "approve")).rejects.toMatchObject({ code: "not_found" });
    expect((await approvalRow(b2.approvalId as string)).status).toBe("pending");
  });
});

describe("an approved request is blocked when the feature has been switched off since", () => {
  const variants: Array<[string, () => Promise<unknown>, () => Promise<unknown>]> = [
    ["the workspace's proposals switch", () => setProposalsSwitch(a.org.id, false), () => setProposalsSwitch(a.org.id, true)],
    ["the deployment's proposals flag", async () => setClientProposals(false), async () => setClientProposals(true)],
    [
      "the workspace's business tools switch",
      () => withSystem((db) => db.query("update org_features set enabled = false where org_id = $1 and feature = 'client_business_tools'", [a.org.id])),
      () => withSystem((db) => db.query("update org_features set enabled = true where org_id = $1 and feature = 'client_business_tools'", [a.org.id])),
    ],
  ];

  variants.forEach(([label, off, on], index) => {
    it(`blocks it, says nothing was changed, and does not run it later: ${label}`, async () => {
      const body = reply(await call(a, "appointment_setter", "update_contact", { contactId: a.contact.id, changes: { leadScore: 40 + index } }));
      const id = body.approvalId as string;
      const before = await crmFingerprint(a);
      await off();
      let decided: Awaited<ReturnType<typeof decideApproval>>;
      try {
        decided = await decideApproval(personContext(a), id, "approve");
      } finally {
        await on();
      }
      expect(decided.outcome).toMatchObject({ status: "blocked", detail: "Approved, but this feature is switched off. Nothing was changed." });
      expect(await approvalRow(id)).toMatchObject({ status: "approved", execution_status: "blocked", execution_detail: "Approved, but this feature is switched off. Nothing was changed." });
      expect(await crmFingerprint(a)).toEqual(before);
      expect(await contactRow(a)).toMatchObject({ lead_score: null });
      // With the feature back on, the same approval is not carried out: it was claimed once.
      expect(await withSystem((db) => db.query("select 1 from approval_requests where id = $1 and execution_status = 'queued'", [id]).then((r) => r.rows.length))).toBe(0);
      // The refusal is on record against the employee, as denied.
      const logged = await withSystem((db) => db.query<{ result: string }>("select result from audit_logs where approval_id = $1 and action = 'crm.agent_tool.update_contact'", [id]));
      expect(logged.rows.map((row) => row.result)).toContain("denied");
    });
  });

  it("does not block a request that did not come through this tier, so a change a person asked an employee for another way is unaffected", async () => {
    setClientProposals(false);
    const agent = a.agents.crm_manager;
    await startClientTurn(a, "crm_manager", a.owner.id);
    const run = (await withSystem((db) => db.query<{ id: string }>("select id from agent_runs where agent_instance_id = $1 and status = 'running'", [agent]))).rows[0].id;
    const token = await withSystem((db) => issueAgentToolToken(db, { orgId: a.org.id, agentInstanceId: agent, runId: run, scopes: ["contacts:write"] }));
    const asked = await callAgentTool({ token: token.token, tool: "update_contact", readArgs: async () => ({ contactId: a.contact.id, changes: { leadScore: 52 } }) });
    // The employee is in approval-required mode, so this became a request, but not a forced one.
    expect(asked).toMatchObject({ ok: true, status: "pending_approval" });
    const id = asked.ok ? (asked.approvalId as string) : "";
    expect((await approvalRow(id)).action).toMatchObject({ forcedApproval: false });
    const decided = await decideApproval(personContext(a), id, "approve");
    expect(decided.outcome).toMatchObject({ status: "succeeded" });
    expect(await contactRow(a)).toMatchObject({ lead_score: 52 });
    await withSystem((db) => db.query("update contacts set lead_score = null where id = $1", [a.contact.id]));
  });
});
