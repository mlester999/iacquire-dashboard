// CRM tools for a client's own AI employees. Synthetic workspaces only: nothing here calls Hermes, a calendar provider or a messaging
// provider, and nothing is sent.
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

const who = vi.hoisted(() => ({ actor: null as null | import("@/server/crm/actor").CrmActor }));
// The settings action resolves its actor from the session; here the test chooses who is acting, and the permission check still runs.
vi.mock("@/server/crm/request", async () => {
  const { assertCan } = await import("@/server/crm/actor");
  return {
    resolveCrmActor: async (_orgId: string | null, permission: import("@/lib/permissions").Permission) => {
      if (!who.actor) throw new Error("No actor chosen for this test.");
      assertCan(who.actor, permission);
      return who.actor;
    },
  };
});
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined, prefetch: () => undefined }),
  usePathname: () => "/crm/settings/ai-tools",
  useSearchParams: () => new URLSearchParams(),
}));

import { withSystem } from "@/server/db";
import { revokeAgentToolAccessAction } from "@/app/actions/crm-agent-tools";
import { AiToolsScreen } from "@/components/crm/agent-tools/ai-tools-screen";
import type { CrmScope } from "@/server/crm/page";
import { sha256 } from "@/server/security/crypto";
import { createContact } from "@/server/crm/contacts";
import { createTag } from "@/server/crm/tags";
import { listPipelines } from "@/server/crm/pipelines";
import { agentActor } from "@/server/crm/actor";
import { decideApproval, executeApproval } from "@/server/approvals/service";
import { createAppointmentType, createCalendar, setHostAvailability } from "@/server/calendars/setup";
import { AGENT_TOOL_NAMES, AGENT_TOOL_SCOPES, ROLE_SCOPES, effectiveScopes, toolManifest, toolsForRole } from "@/server/crm/agent-tools/catalog";
import { issueAgentToolToken, revokeAgentToolAccess, revokeAgentToolTokensForRun, revokeEndedRunTokens, verifyAgentToolToken } from "@/server/crm/agent-tools/tokens";
import { callAgentTool, describeAgentTools, inputHash, stableStringify } from "@/server/crm/agent-tools/service";
import { handleAgentToolHttp } from "@/server/crm/agent-tools/http";
import { requestAgentTask } from "@/server/crm/agent-tools/tasks";
import { getAgentToolsOverview } from "@/server/crm/agent-tools/overview";
import { agentId as roleAgent, createOrg, ctxFor } from "./support/fixtures";
import { crmOrg, type CrmOrg } from "./support/crm";

const ALL = [...AGENT_TOOL_SCOPES];
type Mode = "autonomous" | "approval_required" | "paused";

let a: CrmOrg;
let b: CrmOrg;

async function ready(org: CrmOrg, role: string, mode: Mode = "approval_required") {
  const id = await roleAgent(org.org.id, role);
  await withSystem((db) => db.query("update agent_instances set status = 'online', last_health_ok = true, enabled = true, mode = $2 where id = $1", [id, mode]));
  return id;
}
const setMode = (agent: string, mode: Mode) => withSystem((db) => db.query("update agent_instances set mode = $2 where id = $1", [agent, mode]));

async function startRun(org: CrmOrg, agent: string, status = "running") {
  const { rows } = await withSystem((db) =>
    db.query<{ id: string }>("insert into agent_runs (org_id, agent_instance_id, purpose, idempotency_key, status) values ($1, $2, 'crm_tool', $3, $4) returning id", [org.org.id, agent, `test:${crypto.randomUUID()}`, status]),
  );
  return rows[0].id;
}

async function tokenFor(org: CrmOrg, agent: string, opts: { scopes?: string[]; run?: boolean | string; ttlMinutes?: number } = {}) {
  const runId = opts.run === false ? null : typeof opts.run === "string" ? opts.run : await startRun(org, agent);
  const t = await withSystem((db) => issueAgentToolToken(db, { orgId: org.org.id, agentInstanceId: agent, runId, scopes: opts.scopes ?? ALL, ttlMinutes: opts.ttlMinutes }));
  return { ...t, runId };
}

const call = (token: string | null, tool: string, args: unknown = {}, callId?: string) => callAgentTool({ token, tool, readArgs: async () => args, callId });

const one = async <T extends Record<string, unknown>>(sql: string, params: unknown[]) => (await withSystem((db) => db.query<T>(sql, params))).rows[0];
const count = async (sql: string, params: unknown[]) => Number((await one<{ n: string }>(`select count(*)::text as n from (${sql}) x`, params)).n);

beforeAll(async () => {
  a = await crmOrg({ name: "Agent Tools Co" });
  b = await crmOrg({ name: "Other Tenant Co" });
});

describe("catalog", () => {
  it("narrows every role to its allowlist and keeps hashes stable", () => {
    expect(effectiveScopes("performance_analyst", ALL)).toEqual(["opportunities:read", "reports:read"]);
    expect(effectiveScopes("sales_assistant", ["contacts:read", "reports:read", "made:up"])).toEqual(["contacts:read"]);
    expect(effectiveScopes("not_a_role", ALL)).toEqual([]);
    for (const role of Object.keys(ROLE_SCOPES)) expect(toolsForRole(role).length).toBeGreaterThan(0);
    expect(toolsForRole("performance_analyst")).toEqual(["crm_summary_report"]);
    expect(stableStringify({ b: 1, a: [2, { d: 3, c: undefined }] })).toBe('{"a":[2,{"d":3}],"b":1}');
    expect(inputHash("x", { a: 1, b: 2 })).toBe(inputHash("x", { b: 2, a: 1 }));
    // Every tool publishes a JSON Schema for its arguments, closed to unknown fields.
    const manifest = toolManifest(AGENT_TOOL_NAMES);
    expect(manifest).toHaveLength(14);
    for (const t of manifest) expect(t.input_schema).toMatchObject({ type: "object", additionalProperties: false });
  });
});

describe("tokens", () => {
  it("returns the secret once and stores only its sha256, with the scopes narrowed to the role", async () => {
    const agent = await ready(a, "sales_assistant");
    const t = await tokenFor(a, agent, { scopes: ["contacts:read", "reports:read"] });
    expect(t.token).toMatch(/^iaqat_[A-Za-z0-9_-]{43}$/);
    expect(t.scopes).toEqual(["contacts:read"]);
    const row = await one<Record<string, unknown>>("select * from crm_agent_tokens where id = $1", [t.tokenId]);
    expect(row.token_hash).toBe(sha256(t.token));
    expect(JSON.stringify(row)).not.toContain(t.token.slice(6));
    expect(row.scopes).toEqual(["contacts:read"]);
    const ms = new Date(row.expires_at as Date).getTime() - new Date(row.created_at as Date).getTime();
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(24 * 3600_000);
  });

  it("refuses unknown or disallowed scopes, over-long lifetimes, and another workspace's employee or run", async () => {
    const agent = await ready(a, "sales_assistant");
    const issue = (input: Partial<Parameters<typeof issueAgentToolToken>[1]>) =>
      withSystem((db) => issueAgentToolToken(db, { orgId: a.org.id, agentInstanceId: agent, scopes: ["contacts:read"], ...input }));
    await expect(issue({ scopes: ["contacts:delete"] })).rejects.toThrow(/Unknown tool scope/);
    await expect(issue({ scopes: ["reports:read"] })).rejects.toThrow(/None of those tool scopes/);
    await expect(issue({ ttlMinutes: 24 * 60 + 1 })).rejects.toThrow(/24 hours/);
    const foreign = await roleAgent(b.org.id, "sales_assistant");
    await expect(issue({ agentInstanceId: foreign })).rejects.toThrow(/not found/);
    const otherRun = await startRun(a, await roleAgent(a.org.id, "crm_manager"));
    await expect(issue({ runId: otherRun })).rejects.toThrow(/Run not found/);
    const finished = await startRun(a, agent, "completed");
    await expect(issue({ runId: finished })).rejects.toThrow(/already finished/);
    // The table itself refuses a lifetime over 24 hours, whatever the code does.
    await expect(withSystem((db) => db.query(
      "insert into crm_agent_tokens (org_id, agent_instance_id, token_hash, scopes, expires_at) values ($1, $2, $3, '{contacts:read}', now() + interval '25 hours')",
      [a.org.id, agent, sha256("x")],
    ))).rejects.toThrow();
  });

  it("keeps internal agency employees out of the client-only CRM tool adapter", async () => {
    const agency = await createOrg({ kind: "agency" });
    const employee = await roleAgent(agency.id, "operations_manager");
    await expect(withSystem((db) => issueAgentToolToken(db, {
      orgId: agency.id,
      agentInstanceId: employee,
      scopes: ["tasks:write", "reports:read"],
    }))).rejects.toMatchObject({ code: "not_found" });
  });

  it("stops working when expired, revoked, or when its run ends", async () => {
    const agent = await ready(a, "sales_assistant");
    const expired = await tokenFor(a, agent);
    await withSystem((db) => db.query("update crm_agent_tokens set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' where id = $1", [expired.tokenId]));
    expect((await call(expired.token, "find_contacts", { query: "a" })).httpStatus).toBe(401);

    const revoked = await tokenFor(a, agent);
    expect((await call(revoked.token, "find_contacts", { query: "a" })).httpStatus).toBe(200);
    expect(await withSystem((db) => revokeAgentToolTokensForRun(db, revoked.runId as string))).toBe(1);
    expect((await call(revoked.token, "find_contacts", { query: "a" })).httpStatus).toBe(401);

    const ended = await tokenFor(a, agent);
    await withSystem((db) => db.query("update agent_runs set status = 'completed', finished_at = now() where id = $1", [ended.runId]));
    expect((await call(ended.token, "find_contacts", { query: "a" })).httpStatus).toBe(401);
    expect((await one<{ revoked_at: Date | null }>("select revoked_at from crm_agent_tokens where id = $1", [ended.tokenId])).revoked_at).not.toBeNull();

    const swept = await tokenFor(a, agent);
    await withSystem((db) => db.query("update agent_runs set status = 'failed', finished_at = now() where id = $1", [swept.runId]));
    expect(await withSystem((db) => revokeEndedRunTokens(db))).toBeGreaterThanOrEqual(1);

    for (const bad of [null, "", "Bearer x", "iaqat_short", `iaqat_${"A".repeat(43)}`]) expect((await call(bad, "find_contacts", { query: "a" })).httpStatus).toBe(401);
    expect(await withSystem((db) => verifyAgentToolToken(db, `iaqat_${"B".repeat(43)}`))).toBeNull();
  });

  it("an owner can stop one employee's tool access at once; others can't", async () => {
    const agent = await ready(a, "crm_manager");
    const t1 = await tokenFor(a, agent);
    const t2 = await tokenFor(a, agent, { run: false });
    await expect(revokeAgentToolAccess(a.actor("sales"), agent)).rejects.toThrow(/owners and managers/);
    await expect(revokeAgentToolAccess(a.actor("owner"), await roleAgent(b.org.id, "crm_manager"))).rejects.toThrow(/not found/);
    expect(await revokeAgentToolAccess(a.actor("manager"), agent)).toEqual({ revoked: 2 });
    expect((await call(t1.token, "find_contacts", { query: "a" })).httpStatus).toBe(401);
    expect((await call(t2.token, "find_contacts", { query: "a" })).httpStatus).toBe(401);
  });
});

describe("the organization comes from the token only", () => {
  it("never reaches another workspace's records, whatever ids the arguments name", async () => {
    const mine = await createContact(a.actor("owner"), { firstName: "Isolde", lastName: "Mine", email: "isolde.mine@example.test" });
    const theirs = await createContact(b.actor("owner"), { firstName: "Isolde", lastName: "Theirs", email: "isolde.theirs@example.test" });
    await createTag(b.actor("owner"), { name: "VIP" });
    await createTag(a.actor("owner"), { name: "VIP" });
    const agent = await ready(a, "sales_assistant", "autonomous");
    const t = await tokenFor(a, agent);

    const found = await call(t.token, "find_contacts", { query: "isolde" });
    expect(found.ok && (found.result.contacts as Array<{ id: string }>).map((c) => c.id)).toEqual([mine.id]);
    expect(await call(t.token, "get_contact", { contactId: theirs.id })).toMatchObject({ ok: false, httpStatus: 404 });
    // An organization in the arguments is not honoured; it is refused outright.
    expect(await call(t.token, "get_contact", { contactId: mine.id, orgId: b.org.id })).toMatchObject({ ok: false, httpStatus: 400, code: "invalid_input" });
    expect(await call(t.token, "apply_tag", { contactIds: [theirs.id], tags: ["VIP"] })).toMatchObject({ ok: false, httpStatus: 404 });
    expect(await call(t.token, "update_contact", { contactId: theirs.id, changes: { leadStatus: "qualified" } })).toMatchObject({ ok: false, httpStatus: 404 });
    expect(await count("select 1 from crm_contact_tags where org_id = $1", [b.org.id])).toBe(0);
    expect((await one<{ lead_status: string }>("select lead_status from contacts where id = $1", [theirs.id])).lead_status).toBe("new");

    // In approval-required mode a foreign id never becomes an approval for a person to wave through.
    await setMode(agent, "approval_required");
    expect(await call(t.token, "update_contact", { contactId: theirs.id, changes: { leadStatus: "qualified" } })).toMatchObject({ ok: false, httpStatus: 404 });
    expect(await count("select 1 from approval_requests where kind = 'crm_update' and target_id = $1", [theirs.id])).toBe(0);

    // A token issued for the other workspace's employee only ever sees that workspace.
    const theirAgent = await ready(b, "crm_manager");
    const tb = await tokenFor(b, theirAgent);
    expect(await call(tb.token, "get_contact", { contactId: mine.id })).toMatchObject({ ok: false, httpStatus: 404 });
    const report = await call(tb.token, "crm_summary_report", {});
    expect(report.ok && report.result.contacts).toEqual({ total: 1, newInPeriod: 1 });
  });
});

describe("role allowlist ∩ token scopes", () => {
  it("refuses tools outside either, and the catalog lists only what the token can call", async () => {
    const agent = await ready(a, "sales_assistant", "autonomous");
    const narrow = await tokenFor(a, agent, { scopes: ["contacts:read"] });
    const c = await createContact(a.actor("owner"), { firstName: "Scope", lastName: "Check" });
    expect(await call(narrow.token, "update_contact", { contactId: c.id, changes: { city: "Cebu" } })).toMatchObject({ ok: false, httpStatus: 403 });
    expect(await call(narrow.token, "crm_summary_report", {})).toMatchObject({ ok: false, httpStatus: 403 });
    expect(await call(narrow.token, "delete_contact", { contactId: c.id })).toMatchObject({ ok: false, httpStatus: 404 });

    const analyst = await ready(a, "performance_analyst", "autonomous");
    const ta = await tokenFor(a, analyst);
    expect(ta.scopes).toEqual(["opportunities:read", "reports:read"]);
    expect(await call(ta.token, "find_contacts", { query: "scope" })).toMatchObject({ ok: false, httpStatus: 403 });
    const report = await call(ta.token, "crm_summary_report", { periodDays: 7 });
    expect(report).toMatchObject({ ok: true, status: "done" });
    // Counts only: no names, emails or ids anywhere in the report.
    expect(JSON.stringify(report.ok && report.result)).not.toMatch(/@|Scope|[0-9a-f]{8}-[0-9a-f]{4}/);

    const catalog = await describeAgentTools(narrow.token);
    expect("tools" in catalog && catalog.tools.map((t) => t.name)).toEqual(["find_contacts", "get_contact"]);
    expect("tools" in catalog && catalog.tools[0].input_schema).toMatchObject({ type: "object" });

    // The actor the services see has exactly the scopes' permissions.
    const actor = agentActor({ id: a.org.id, name: "x", timezone: "UTC" }, { id: agent, displayName: "Sales" }, ["contacts.view"]);
    expect([actor.kind, actor.can("contacts.view"), actor.can("contacts.edit"), actor.can("contacts.delete")]).toEqual(["agent", true, false, false]);
  });
});

describe("operating modes", () => {
  it("paused: every call is refused and nothing is recorded as done", async () => {
    const agent = await ready(a, "crm_manager", "paused");
    const t = await tokenFor(a, agent);
    const c = await createContact(a.actor("owner"), { firstName: "Paused", lastName: "Case" });
    expect(await call(t.token, "find_contacts", { query: "paused" })).toMatchObject({ ok: false, httpStatus: 403 });
    expect(await call(t.token, "update_contact", { contactId: c.id, changes: { city: "Davao" } })).toMatchObject({ ok: false, httpStatus: 403 });
    expect(await count("select 1 from approval_requests where target_id = $1", [c.id])).toBe(0);
    expect(await count("select 1 from audit_logs where agent_instance_id = $1 and action like 'crm.agent\\_tool.%' and result = 'denied'", [agent])).toBe(2);
  });

  it("approval required: reads run, writes become one CRM update approval per run and call", async () => {
    const agent = await ready(a, "crm_manager", "approval_required");
    const t = await tokenFor(a, agent);
    const c = await createContact(a.actor("owner"), { firstName: "Approval", lastName: "Needed" });
    expect(await call(t.token, "get_contact", { contactId: c.id })).toMatchObject({ ok: true, status: "done" });
    const args = { contactId: c.id, changes: { leadStatus: "qualified", city: "Iloilo" }, reason: "They asked for a quote on the phone." };
    const first = await call(t.token, "update_contact", args);
    expect(first).toMatchObject({ ok: true, httpStatus: 202, status: "pending_approval" });
    const again = await call(t.token, "update_contact", { ...args, changes: { city: "Iloilo", leadStatus: "qualified" } });
    expect(again.ok && again.approvalId).toBe(first.ok && first.approvalId);
    const ap = await one<{ kind: string; risk: string; status: string; reason: string; action: Record<string, unknown>; agent_instance_id: string; target_label: string }>(
      "select kind, risk, status, reason, action, agent_instance_id, target_label from approval_requests where id = $1", [first.ok ? first.approvalId : null],
    );
    expect(ap).toMatchObject({ kind: "crm_update", risk: "medium", status: "pending", agent_instance_id: agent, target_label: "Approval Needed" });
    expect(ap.reason).toContain("quote on the phone");
    expect(ap.action).toMatchObject({ source: "agent_tool", tool: "update_contact", runId: t.runId });
    expect((await one<{ lead_status: string; city: string | null }>("select lead_status, city from contacts where id = $1", [c.id]))).toEqual({ lead_status: "new", city: null });
    expect(await count("select 1 from crm_activities where contact_id = $1 and kind = 'agent.approval_requested' and actor_kind = 'agent' and agent_id = $2", [c.id, agent])).toBe(1);
    expect(await count("select 1 from notifications where org_id = $1 and kind = 'approval_requested' and link = '/approvals'", [a.org.id])).toBeGreaterThan(0);
  });

  it("autonomous: writes run now through the CRM services, as the employee", async () => {
    const agent = await ready(a, "sales_assistant", "autonomous");
    const t = await tokenFor(a, agent);
    const c = await createContact(a.actor("owner"), { firstName: "Auto", lastName: "Mode" });
    const res = await call(t.token, "update_contact", { contactId: c.id, changes: { leadStatus: "contacted", country: "ph" } });
    expect(res).toMatchObject({ ok: true, status: "done" });
    expect(await one("select lead_status, country from contacts where id = $1", [c.id])).toEqual({ lead_status: "contacted", country: "PH" });
    expect(await count("select 1 from crm_activities where contact_id = $1 and actor_kind = 'agent' and agent_id = $2 and kind = 'contact.status_changed'", [c.id, agent])).toBe(1);
    expect(await count("select 1 from crm_events where entity_id = $1 and type = 'contact.updated' and actor_kind = 'agent' and actor_id = $2", [c.id, agent])).toBe(1);

    const task = await call(t.token, "create_task", { title: "Call back about the quote", contactId: c.id, priority: "high", dueAt: "2026-11-03T14:00:00+08:00" });
    expect(task).toMatchObject({ ok: true, status: "done" });
    expect(await one("select source, priority, contact_id from tasks where id = $1", [task.ok && task.result.taskId])).toEqual({ source: "agent", priority: "high", contact_id: c.id });
    expect(await call(t.token, "update_contact", { contactId: c.id, changes: { timezone: "Mars/Olympus" } })).toMatchObject({ ok: false, httpStatus: 400 });
    expect(await call(t.token, "update_contact", { contactId: c.id, changes: { email: "new@example.test" } })).toMatchObject({ ok: false, httpStatus: 400 });
  });

  it("a change the workspace can't make here (managed in GoHighLevel) is refused, not sent for approval", async () => {
    const g = await crmOrg();
    const agent = await ready(g, "crm_manager", "approval_required");
    const t = await tokenFor(g, agent);
    const c = await createContact(g.actor("owner"), { firstName: "Elsewhere", lastName: "Managed" });
    await withSystem((db) => db.query("update crm_workspaces set mode = 'ghl' where org_id = $1", [g.org.id]));
    const r = await call(t.token, "update_contact", { contactId: c.id, changes: { city: "Cebu" } });
    expect(r).toMatchObject({ ok: false, httpStatus: 409, code: "conflict" });
    expect(!r.ok && r.error).toMatch(/GoHighLevel/);
    expect(await count("select 1 from approval_requests where org_id = $1 and kind = 'crm_update'", [g.org.id])).toBe(0);
    // Reads still work.
    expect(await call(t.token, "get_contact", { contactId: c.id })).toMatchObject({ ok: true, status: "done" });
  });

  it("an iAcquire pause or an inactive workspace stops even an autonomous employee", async () => {
    const c2 = await crmOrg();
    const agent = await ready(c2, "sales_assistant", "autonomous");
    const t = await tokenFor(c2, agent);
    await withSystem((db) => db.query("insert into automation_pauses (org_id, scope, active) values ($1, 'agency', true)", [c2.org.id]));
    const refused = await call(t.token, "find_contacts", { query: "x" });
    expect(refused).toMatchObject({ ok: false, httpStatus: 403 });
    expect(!refused.ok && refused.error).toMatch(/paused automation/);
    await withSystem((db) => db.query("update automation_pauses set active = false where org_id = $1", [c2.org.id]));
    expect((await call(t.token, "find_contacts", { query: "x" })).httpStatus).toBe(200);
    await withSystem((db) => db.query("update organizations set status = 'suspended' where id = $1", [c2.org.id]));
    expect(await call(t.token, "find_contacts", { query: "x" })).toMatchObject({ ok: false, httpStatus: 403 });
  });
});

describe("high-impact changes always wait for a person", () => {
  it("bulk tagging, closing a deal and sending a message need approval even when autonomous", async () => {
    const agent = await ready(a, "sales_assistant", "autonomous");
    const t = await tokenFor(a, agent);
    await createTag(a.actor("owner"), { name: "Hot lead" });
    const c1 = await createContact(a.actor("owner"), { firstName: "Bulk", lastName: "One" });
    const c2 = await createContact(a.actor("owner"), { firstName: "Bulk", lastName: "Two" });

    expect(await call(t.token, "apply_tag", { contactIds: [c1.id], tags: ["hot LEAD"] })).toMatchObject({ ok: true, status: "done" });
    const bulk = await call(t.token, "apply_tag", { contactIds: [c1.id, c2.id], tags: ["Hot lead"] });
    expect(bulk).toMatchObject({ ok: true, status: "pending_approval" });
    expect(await one("select risk from approval_requests where id = $1", [bulk.ok && bulk.approvalId])).toEqual({ risk: "high" });
    expect(await count("select 1 from crm_contact_tags where contact_id = $1", [c2.id])).toBe(0);
    expect(await call(t.token, "apply_tag", { contactIds: [c1.id], tags: ["No such tag"] })).toMatchObject({ ok: false, httpStatus: 404 });

    const pipe = (await listPipelines(a.actor("owner"), { ensureDefault: true }))[0];
    const won = pipe.stages.find((s) => s.kind === "won")!;
    const second = pipe.stages.filter((s) => s.kind === "open")[1];
    const deal = await call(t.token, "create_opportunity", { name: "Roof repair", contactId: c1.id, value: 1200 });
    expect(deal).toMatchObject({ ok: true, status: "done" });
    const dealId = deal.ok ? (deal.result.opportunityId as string) : "";
    // The same call again in the same run is the same deal, not a second one.
    const repeat = await call(t.token, "create_opportunity", { name: "Roof repair", contactId: c1.id, value: 1200 });
    expect(repeat.ok && repeat.result).toMatchObject({ opportunityId: dealId, created: false });
    expect(await call(t.token, "move_opportunity_stage", { opportunityId: dealId, stageId: second.id })).toMatchObject({ ok: true, status: "done" });
    const close = await call(t.token, "move_opportunity_stage", { opportunityId: dealId, stageId: won.id });
    expect(close).toMatchObject({ ok: true, status: "pending_approval" });
    expect(await one("select status, stage_ref from crm_opportunities where id = $1", [dealId])).toEqual({ status: "open", stage_ref: second.id });
    const closedApproval = close.ok ? (close.approvalId as string) : "";
    const closed = await decideApproval(ctxFor(a.people.owner, a.org, "owner"), closedApproval, "approve");
    expect(closed.outcome).toMatchObject({ status: "succeeded" });
    expect(await one("select status, stage_ref from crm_opportunities where id = $1", [dealId])).toEqual({ status: "won", stage_ref: won.id });
  });
});

describe("approved calls (the crm_update executor)", () => {
  it("runs the approved change exactly once, as the employee, and records it", async () => {
    const agent = await ready(a, "crm_manager", "approval_required");
    const t = await tokenFor(a, agent);
    const c = await createContact(a.actor("owner"), { firstName: "Exec", lastName: "Once" });
    const req = await call(t.token, "update_contact", { contactId: c.id, changes: { leadStatus: "qualified" } });
    const approvalId = req.ok ? (req.approvalId as string) : "";
    const ctx = ctxFor(a.people.owner, a.org, "owner");
    const results = await Promise.allSettled([1, 2, 3].map(() => decideApproval(ctx, approvalId, "approve")));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const ap = await one<{ execution_status: string; execution_detail: string }>("select execution_status, execution_detail from approval_requests where id = $1", [approvalId]);
    expect(ap.execution_status).toBe("succeeded");
    expect(ap.execution_detail).toMatch(/^Done:/);
    expect(await one("select lead_status from contacts where id = $1", [c.id])).toEqual({ lead_status: "qualified" });
    expect(await count("select 1 from crm_events where entity_id = $1 and type = 'contact.updated'", [c.id])).toBe(1);
    expect(await executeApproval(a.org.id, approvalId, a.people.owner.id)).toBeNull();
    expect(await count("select 1 from tool_executions where run_id = $1 and tool_name = 'crm.update_contact' and label like '%(approved)'", [t.runId])).toBe(1);
    expect(await count("select 1 from audit_logs where approval_id = $1 and action = 'crm.agent_tool.update_contact' and metadata->>'approved' = 'true'", [approvalId])).toBe(1);
  });

  it("refuses tampered arguments, a pause since the request, and records that vanished", async () => {
    const agent = await ready(a, "crm_manager", "approval_required");
    const t = await tokenFor(a, agent);
    const ctx = ctxFor(a.people.owner, a.org, "owner");
    const c = await createContact(a.actor("owner"), { firstName: "Guard", lastName: "Rails" });

    const tampered = await call(t.token, "update_contact", { contactId: c.id, changes: { city: "Bacolod" } });
    const tid = tampered.ok ? (tampered.approvalId as string) : "";
    await withSystem((db) => db.query("update approval_requests set action = jsonb_set(action, '{input,changes,city}', '\"Elsewhere\"') where id = $1", [tid]));
    expect((await decideApproval(ctx, tid, "approve")).outcome).toMatchObject({ status: "failed" });
    expect(await one("select city from contacts where id = $1", [c.id])).toEqual({ city: null });

    const paused = await call(t.token, "update_contact", { contactId: c.id, changes: { city: "Tacloban" } });
    await setMode(agent, "paused");
    expect((await decideApproval(ctx, paused.ok ? (paused.approvalId as string) : "", "approve")).outcome).toMatchObject({ status: "blocked" });
    expect(await one("select city from contacts where id = $1", [c.id])).toEqual({ city: null });
    await setMode(agent, "approval_required");

    const gone = await call(t.token, "update_contact", { contactId: c.id, changes: { city: "Naga" } });
    await withSystem((db) => db.query("update contacts set deleted_at = now() where id = $1", [c.id]));
    expect((await decideApproval(ctx, gone.ok ? (gone.approvalId as string) : "", "approve")).outcome).toMatchObject({ status: "failed" });

    // A high-risk request needs the owner, not a manager.
    const t2 = await tokenFor(a, await ready(a, "sales_assistant", "autonomous"));
    const x = await createContact(a.actor("owner"), { firstName: "Hi", lastName: "Risk" });
    const y = await createContact(a.actor("owner"), { firstName: "Hi", lastName: "Risk Two" });
    await createTag(a.actor("owner"), { name: "Risky" });
    const bulk = await call(t2.token, "apply_tag", { contactIds: [x.id, y.id], tags: ["Risky"] });
    await expect(decideApproval(ctxFor(a.people.manager, a.org, "admin"), bulk.ok ? (bulk.approvalId as string) : "", "approve")).rejects.toThrow(/owner/);
    expect((await decideApproval(ctx, bulk.ok ? (bulk.approvalId as string) : "", "approve")).outcome).toMatchObject({ status: "succeeded" });
    expect(await count("select 1 from crm_contact_tags ct join crm_tags tg on tg.id = ct.tag_id where tg.name = 'Risky' and ct.org_id = $1 and ct.source = 'agent'", [a.org.id])).toBe(2);
  });

  it("a repeated request after a decision says what happened, and never runs the change again", async () => {
    const agent = await ready(a, "crm_manager", "approval_required");
    const t = await tokenFor(a, agent);
    const ctx = ctxFor(a.people.owner, a.org, "owner");
    const c = await createContact(a.actor("owner"), { firstName: "Decided", lastName: "Already" });

    const declined = { contactId: c.id, changes: { city: "Dumaguete" } };
    const first = await call(t.token, "update_contact", declined);
    await decideApproval(ctx, first.ok ? (first.approvalId as string) : "", "reject", "Not this one.");
    const afterReject = await call(t.token, "update_contact", declined);
    expect(afterReject).toMatchObject({ ok: true, httpStatus: 200, status: "unavailable", approvalId: first.ok && first.approvalId });
    expect(afterReject.ok && afterReject.detail).toMatch(/declined/);
    expect(await one("select city from contacts where id = $1", [c.id])).toEqual({ city: null });

    const approved = { contactId: c.id, changes: { leadScore: 70 } };
    const second = await call(t.token, "update_contact", approved);
    const secondId = second.ok ? (second.approvalId as string) : "";
    expect((await decideApproval(ctx, secondId, "approve")).outcome).toMatchObject({ status: "succeeded" });
    // A person changes the score again; the employee repeating its approved request must not overwrite that.
    await withSystem((db) => db.query("update contacts set lead_score = 40 where id = $1", [c.id]));
    const afterApprove = await call(t.token, "update_contact", approved);
    expect(afterApprove).toMatchObject({ ok: true, httpStatus: 200, status: "done", approvalId: secondId });
    expect(await one("select lead_score from contacts where id = $1", [c.id])).toEqual({ lead_score: 40 });
    expect(await count("select 1 from approval_requests where idempotency_key like $1", [`agent-tool:${t.runId}:%`])).toBe(2);

    // An expired request is reported as expired, not as still waiting.
    const late = { contactId: c.id, changes: { region: "Negros" } };
    const third = await call(t.token, "update_contact", late);
    await withSystem((db) => db.query("update approval_requests set expires_at = now() - interval '1 minute' where id = $1", [third.ok && third.approvalId]));
    const afterExpiry = await call(t.token, "update_contact", late);
    expect(afterExpiry).toMatchObject({ ok: true, status: "unavailable" });
    expect(afterExpiry.ok && afterExpiry.detail).toMatch(/expired/);
  });

  it("a call waiting for approval is never also done directly after the employee becomes autonomous", async () => {
    const agent = await ready(a, "crm_manager", "approval_required");
    const t = await tokenFor(a, agent);
    const c = await createContact(a.actor("owner"), { firstName: "Mode", lastName: "Switch" });
    const args = { title: "Send the brochure", contactId: c.id };
    const asked = await call(t.token, "create_task", args, "task-1");
    expect(asked).toMatchObject({ ok: true, status: "pending_approval" });
    const keyless = { title: "Check the address", contactId: c.id };
    const askedKeyless = await call(t.token, "create_task", keyless);
    await setMode(agent, "autonomous");
    // The same call again (same Idempotency-Key, or identical arguments without one) stays with its approval.
    expect(await call(t.token, "create_task", args, "task-1")).toMatchObject({ ok: true, status: "pending_approval", approvalId: asked.ok && asked.approvalId });
    expect(await call(t.token, "create_task", keyless)).toMatchObject({ ok: true, status: "pending_approval", approvalId: askedKeyless.ok && askedKeyless.approvalId });
    expect(await count("select 1 from tasks where contact_id = $1", [c.id])).toBe(0);
    expect((await decideApproval(ctxFor(a.people.owner, a.org, "owner"), asked.ok ? (asked.approvalId as string) : "", "approve")).outcome).toMatchObject({ status: "succeeded" });
    expect(await count("select 1 from tasks where contact_id = $1", [c.id])).toBe(1);
    // After approval, the replay reports it done and creates nothing more.
    expect(await call(t.token, "create_task", args, "task-1")).toMatchObject({ ok: true, status: "done", approvalId: asked.ok && asked.approvalId });
    expect(await count("select 1 from tasks where contact_id = $1", [c.id])).toBe(1);
    // A new call (new key) by the now-autonomous employee runs straight away.
    expect(await call(t.token, "create_task", { ...args, title: "Follow up next week" }, "task-2")).toMatchObject({ ok: true, status: "done" });
    await setMode(agent, "approval_required");
  });

  it("other CRM updates still have no executor", async () => {
    const { rows } = await withSystem((db) => db.query<{ id: string }>("insert into approval_requests (org_id, kind, title, action) values ($1, 'crm_update', 'Legacy', '{}') returning id", [a.org.id]));
    const r = await decideApproval(ctxFor(a.people.owner, a.org, "owner"), rows[0].id, "approve");
    expect(r.outcome).toMatchObject({ status: "blocked" });
    expect(r.outcome?.detail).toMatch(/Nothing was changed/);
  });
});

describe("rate limit, logging and replays", () => {
  it("limits calls per employee", async () => {
    const agent = await ready(a, "lead_hunter", "autonomous");
    const t = await tokenFor(a, agent);
    const now = Date.now();
    const windows = [Math.floor(now / 60_000) * 60_000, (Math.floor(now / 60_000) + 1) * 60_000].map((ms) => new Date(ms).toISOString());
    await withSystem((db) => db.query(
      "insert into rate_limit_buckets (bucket_key, window_start, hits) values ($1, $2, 60), ($1, $3, 60) on conflict (bucket_key, window_start) do update set hits = 60",
      [`agent-tools:employee:${agent}`, windows[0], windows[1]],
    ));
    const r = await call(t.token, "find_contacts", { query: "x" });
    expect(r).toMatchObject({ ok: false, httpStatus: 429, code: "rate_limited" });
    expect(!r.ok && r.retryAfterSeconds).toBeGreaterThan(0);
    // Counted before the tool is even looked at: unknown or forbidden calls can't be used to flood the log.
    expect(await call(t.token, "no_such_tool", {})).toMatchObject({ ok: false, httpStatus: 429 });
    expect(await call(t.token, "crm_summary_report", {})).toMatchObject({ ok: false, httpStatus: 429 });
    // The limit is per employee: another employee of the same workspace is unaffected.
    const other = await ready(a, "operations_manager", "autonomous");
    expect((await call((await tokenFor(a, other)).token, "find_contacts", { query: "x" })).httpStatus).toBe(200);
  });

  it("logs every call to the audit trail and the run, and never repeats a replayed write", async () => {
    const agent = await ready(a, "appointment_setter", "autonomous");
    const t = await tokenFor(a, agent);
    const c = await createContact(a.actor("owner"), { firstName: "Logged", lastName: "Call" });
    await call(t.token, "get_contact", { contactId: c.id });
    await call(t.token, "get_contact", { contactId: "not-a-uuid" });
    const audit = await withSystem((db) => db.query<{ action: string; result: string; agent_instance_id: string; actor_kind: string; target_id: string | null }>(
      "select action, result, agent_instance_id, actor_kind, target_id from audit_logs where agent_instance_id = $1 and action = 'crm.agent_tool.get_contact' order by id", [agent],
    ));
    expect(audit.rows.map((r) => [r.result, r.actor_kind, r.target_id])).toEqual([["success", "agent", c.id], ["denied", "agent", null]]);
    const runLog = await withSystem((db) => db.query<{ tool_name: string; status: string }>("select tool_name, status from tool_executions where run_id = $1 order by started_at", [t.runId]));
    expect(runLog.rows).toEqual([{ tool_name: "crm.get_contact", status: "completed" }, { tool_name: "crm.get_contact", status: "failed" }]);

    const first = await call(t.token, "create_task", { title: "Confirm the visit" }, "call-123");
    const replay = await call(t.token, "create_task", { title: "Confirm the visit" }, "call-123");
    expect(first).toMatchObject({ ok: true, status: "done" });
    expect(replay).toMatchObject({ ok: true, status: "done", result: { replayed: true } });
    expect(await count("select 1 from tasks where org_id = $1 and title = 'Confirm the visit'", [a.org.id])).toBe(1);
  });
});

describe("conversations, drafts and appointments", () => {
  it("reads only this employee's conversations, drafts without sending, and asks before anything goes out", async () => {
    const agent = await ready(a, "sales_assistant", "autonomous");
    const other = await roleAgent(a.org.id, "appointment_setter");
    const t = await tokenFor(a, agent);
    const c = await createContact(a.actor("owner"), { firstName: "Chat", lastName: "Person", phone: "+639171234567" });
    const conv = async (ai: string) =>
      (await one<{ id: string }>("insert into conversations (org_id, contact_id, channel, thread_key, ai_agent_id, owner_kind) values ($1, $2, 'sms', $3, $4, 'ai') returning id", [a.org.id, c.id, crypto.randomUUID(), ai])).id;
    const mineConv = await conv(agent);
    const otherConv = await conv(other);
    await withSystem(async (db) => {
      await db.query("insert into conversation_messages (org_id, conversation_id, direction, author_kind, body, status, created_at) values ($1, $2, 'inbound', 'contact', 'Is Saturday free?', 'received', now() - interval '2 minutes')", [a.org.id, mineConv]);
      await db.query("insert into conversation_messages (org_id, conversation_id, direction, author_kind, body, status) values ($1, $2, 'internal', 'human', 'Private team note', 'note')", [a.org.id, mineConv]);
    });
    const history = await call(t.token, "get_conversation_history", { conversationId: mineConv });
    expect(history.ok && history.result.messages).toEqual([expect.objectContaining({ from: "customer", text: "Is Saturday free?" })]);
    expect(await call(t.token, "get_conversation_history", { conversationId: otherConv })).toMatchObject({ ok: false, httpStatus: 404 });
    expect(await call(t.token, "get_conversation_history", { conversationId: mineConv, contactId: c.id })).toMatchObject({ ok: false, httpStatus: 400 });

    const draft = await call(t.token, "prepare_message", { conversationId: mineConv, body: "Yes, Saturday at 10 works. Shall I book it?" });
    expect(draft).toMatchObject({ ok: true, status: "draft" });
    const draftId = draft.ok ? (draft.result.draftId as string) : "";
    expect(await one("select status, author_kind, agent_id from conversation_messages where id = $1", [draftId])).toEqual({ status: "draft", author_kind: "ai", agent_id: agent });
    expect(await call(t.token, "prepare_message", { conversationId: otherConv, body: "Hi" })).toMatchObject({ ok: false, httpStatus: 404 });

    const ask = await call(t.token, "request_send_approval", { messageId: draftId, note: "Customer asked about Saturday." });
    expect(ask).toMatchObject({ ok: true, status: "pending_approval" });
    const askAgain = await call(t.token, "request_send_approval", { messageId: draftId });
    expect(askAgain.ok && askAgain.approvalId).toBe(ask.ok && ask.approvalId);
    expect(await one("select kind, status from approval_requests where id = $1", [ask.ok && ask.approvalId])).toEqual({ kind: "follow_up_message", status: "pending" });
    // Nothing was queued or sent, even though the employee is autonomous.
    expect(await count("select 1 from conversation_messages where conversation_id = $1 and status in ('queued', 'sending', 'sent')", [mineConv])).toBe(0);

    // Someone else's draft is not this employee's to send.
    const foreignDraft = (await one<{ id: string }>("insert into conversation_messages (org_id, conversation_id, direction, author_kind, agent_id, body, status) values ($1, $2, 'outbound', 'ai', $3, 'x', 'draft') returning id", [a.org.id, otherConv, other])).id;
    expect(await call(t.token, "request_send_approval", { messageId: foreignDraft })).toMatchObject({ ok: false, httpStatus: 404 });
  });

  it("checks native availability and requests a booking through the normal approval flow", async () => {
    const s = await crmOrg({ timezone: "Asia/Manila" });
    const agent = await ready(s, "appointment_setter", "approval_required");
    const t = await tokenFor(s, agent);
    expect(await call(t.token, "check_availability", {})).toMatchObject({ ok: true, status: "unavailable" });

    const owner = s.actor("owner");
    await setHostAvailability(owner, s.people.owner.id, { timezone: "Asia/Manila", rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMinute: 0, endMinute: 24 * 60 })) });
    const cal = await createCalendar(owner, { name: "Visits", assignment: "single", members: [{ userId: s.people.owner.id }] });
    const type = await createAppointmentType(owner, cal.id, { name: "Site visit", durationMinutes: 60, minNoticeMinutes: 60, maxDaysAhead: 30 });
    const avail = await call(t.token, "check_availability", { appointmentTypeId: type.id, days: 3, limit: 5 });
    expect(avail).toMatchObject({ ok: true, status: "done" });
    const slots = avail.ok ? (avail.result.slots as Array<{ start: string }>) : [];
    expect(slots.length).toBeGreaterThan(0);

    const c = await createContact(owner, { firstName: "Book", lastName: "Me" });
    const req = await call(t.token, "request_appointment", { contactId: c.id, appointmentTypeId: type.id, startAt: slots[0].start });
    expect(req).toMatchObject({ ok: true, status: "pending_approval", httpStatus: 202 });
    expect(await one("select kind from approval_requests where id = $1", [req.ok && req.approvalId])).toEqual({ kind: "appointment_booking" });
    expect(await count("select 1 from appointment_bookings where org_id = $1 and contact_id = $2 and status = 'awaiting_approval' and agent_id = $3", [s.org.id, c.id, agent])).toBe(1);

    const approvalId = req.ok ? (req.approvalId as string) : "";
    const approved = await decideApproval(ctxFor(s.people.owner, s.org, "owner"), approvalId, "approve");
    expect(approved.outcome).toMatchObject({ status: "succeeded" });
    const booking = await one<{ status: string; appointment_id: string }>("select status, appointment_id from appointment_bookings where approval_id = $1 and org_id = $2", [approvalId, s.org.id]);
    expect(booking.status).toBe("booked");
    expect(await one("select provider, origin, booked_via from appointment_refs where id = $1 and org_id = $2", [booking.appointment_id, s.org.id]))
      .toEqual({ provider: "native", origin: "portal_ai", booked_via: "agent" });
    expect(await count("select 1 from conversation_messages where org_id = $1 and status in ('queued', 'sending', 'sent')", [s.org.id])).toBe(0);
  });
});

describe("requestAgentTask (workflow AI step)", () => {
  it("says honestly when nothing will happen, and queues once when the employee can really run", async () => {
    const w = await crmOrg();
    const ask = (roleKey = "crm_manager", stepKey = "ai_1") => withSystem((db) => requestAgentTask(db, { orgId: w.org.id, roleKey, instruction: "Tag new leads from the website as Web.", runId: "11111111-1111-4111-8111-111111111111", stepKey }));
    expect(await ask("chief_of_everything")).toMatchObject({ status: "blocked" });
    const agent = await ready(w, "crm_manager", "paused");
    expect(await ask()).toMatchObject({ status: "blocked", detail: expect.stringMatching(/paused/) });
    await setMode(agent, "approval_required");
    expect(await ask()).toMatchObject({ status: "blocked", detail: expect.stringMatching(/isn't connected/) });

    const cred = await one<{ id: string }>("insert into integration_credentials (org_id, provider, label, ciphertext, fingerprint) values ($1, 'hermes', 'test', 'v1.a.b.c', 'test') returning id", [w.org.id]);
    await withSystem((db) => db.query("update agent_instances set hermes_base_url = 'https://hermes.example.com', credential_id = $2 where id = $1", [agent, cred.id]));
    const remote = await ask();
    expect(remote).toMatchObject({ status: "blocked", detail: expect.stringMatching(/live AI employee runs stay switched off/) });
    expect(await count("select 1 from agent_runs where agent_instance_id = $1", [agent])).toBe(0);

    await withSystem((db) => db.query(
      `update agent_instances set hermes_base_url = 'https://hermes.example.com', last_health_ok = true,
         tool_inventory_contract = 'hermes.api_server.tool_catalog.v1', tool_inventory_digest = $2,
         tool_inventory_verified_at = now(), tool_inventory_expires_at = now() + interval '2 minutes',
         tool_inventory_tool_count = 6
       where id = $1`,
      [agent, "a".repeat(64)],
    ));
    const queued = await ask();
    expect(queued).toMatchObject({ status: "queued" });
    expect((await ask()).agentRunId).toBe(queued.agentRunId);
    expect(await one("select purpose, status, org_id from agent_runs where id = $1", [queued.agentRunId])).toEqual({ purpose: "crm_tool", status: "queued", org_id: w.org.id });
    // Paused, not connected and not verified are each recorded as blocked; the queued request once.
    expect(await count("select 1 from audit_logs where org_id = $1 and action = 'crm.agent_task_requested'", [w.org.id])).toBe(4);

    // The workspace's workflows pause stops the step too, even for a ready employee and a new step.
    await withSystem((db) => db.query("insert into automation_pauses (org_id, scope, active) values ($1, 'workflows', true)", [w.org.id]));
    expect(await ask("crm_manager", "ai_2")).toMatchObject({ status: "blocked", detail: expect.stringMatching(/Workflows are paused/) });
    expect(await count("select 1 from agent_runs where agent_instance_id = $1", [agent])).toBe(1);
    // A malformed contact id is refused before any query (it would otherwise abort the workflow step's transaction).
    await withSystem((db) => db.query("update automation_pauses set active = false where org_id = $1", [w.org.id]));
    expect(await withSystem((db) => requestAgentTask(db, { orgId: w.org.id, roleKey: "crm_manager", instruction: "x", contactId: "nope", runId: "11111111-1111-4111-8111-111111111111", stepKey: "ai_3" }))).toMatchObject({ status: "blocked" });
  });
});

describe("HTTP surface and the settings screen", () => {
  it("maps calls to HTTP and lists the catalog", async () => {
    const agent = await ready(a, "operations_manager", "approval_required");
    const t = await tokenFor(a, agent);
    const req = (over: Partial<Parameters<typeof handleAgentToolHttp>[0]> = {}) => ({
      method: "POST", authorization: `Bearer ${t.token}`, contentType: "application/json", contentLength: null, idempotencyKey: null, ip: "203.0.113.9", readBody: async () => JSON.stringify({ query: "a" }), ...over,
    });
    const unauth = await handleAgentToolHttp(req({ authorization: null }), "find_contacts");
    expect(unauth.status).toBe(401);
    expect(unauth.headers["WWW-Authenticate"]).toMatch(/Bearer/);
    expect((await handleAgentToolHttp(req({ contentType: "text/plain" }), "find_contacts")).status).toBe(400);
    expect((await handleAgentToolHttp(req({ readBody: async () => "{not json" }), "find_contacts")).status).toBe(400);
    expect((await handleAgentToolHttp(req({ readBody: async () => "x".repeat(20_000) }), "find_contacts")).status).toBe(400);
    const ok = await handleAgentToolHttp(req(), "find_contacts");
    expect(ok.status).toBe(200);
    expect(ok.headers["Cache-Control"]).toBe("no-store");
    expect(ok.body).toMatchObject({ ok: true, tool: "find_contacts", status: "done" });
    expect((await handleAgentToolHttp(req({ method: "GET" }), "find_contacts")).status).toBe(405);
    const catalog = await handleAgentToolHttp(req({ method: "GET" }), "catalog");
    expect(catalog.status).toBe(200);
    expect((catalog.body.tools as Array<{ name: string }>).map((x) => x.name)).toEqual(toolsForRole("operations_manager"));
    const ipLogged = await one<{ ip_hash: string | null }>("select ip_hash from audit_logs where agent_instance_id = $1 order by id desc limit 1", [agent]);
    expect(ipLogged.ip_hash).toMatch(/^[0-9a-f]{32}$/);

    // Bad credentials are slowed down per client address; a valid credential from the same address still works.
    const ip = "198.51.100.7";
    const windowMs = 600_000;
    const now = Date.now();
    const starts = [Math.floor(now / windowMs) * windowMs, (Math.floor(now / windowMs) + 1) * windowMs].map((ms) => new Date(ms).toISOString());
    await withSystem((db) => db.query(
      "insert into rate_limit_buckets (bucket_key, window_start, hits) values ($1, $2, 30), ($1, $3, 30) on conflict (bucket_key, window_start) do update set hits = 30",
      [`agent-tools:auth-fail:ip:${sha256(`agent-tools:${ip}`).slice(0, 32)}`, starts[0], starts[1]],
    ));
    const guessed = await handleAgentToolHttp(req({ ip, authorization: `Bearer iaqat_${"C".repeat(43)}` }), "find_contacts");
    expect(guessed.status).toBe(429);
    expect(guessed.headers["Retry-After"]).toBeDefined();
    expect((await handleAgentToolHttp(req({ ip, method: "GET", authorization: null }), "catalog")).status).toBe(429);
    expect((await handleAgentToolHttp(req({ ip }), "find_contacts")).status).toBe(200);
  });

  it("shows owners what each employee may do and every recent call; others can't see it", async () => {
    const view = await getAgentToolsOverview(a.actor("owner"));
    const sales = view.employees.find((e) => e.roleKey === "sales_assistant")!;
    expect(sales.mode).toBe("autonomous");
    expect(sales.tools.find((x) => x.name === "update_contact")?.behaviour).toBe("runs");
    expect(sales.tools.find((x) => x.name === "apply_tag")?.note).toMatch(/more than one contact/);
    expect(sales.tools.find((x) => x.name === "request_send_approval")?.behaviour).toBe("always_asks");
    expect(sales.tools.find((x) => x.name === "crm_summary_report")?.behaviour).toBe("not_for_role");
    const manager = view.employees.find((e) => e.roleKey === "crm_manager")!;
    expect(manager.tools.find((x) => x.name === "update_contact")?.behaviour).toBe("asks_first");
    expect(view.calls.length).toBeGreaterThan(0);
    expect(view.calls.some((c) => c.outcome === "pending_approval" && c.approvalId)).toBe(true);
    expect(view.counts.pendingApprovals).toBeGreaterThan(0);
    expect(view.liveRunsVerified).toBe(false);
    expect(view.canStop).toBe(true);
    await expect(getAgentToolsOverview(a.actor("sales"))).rejects.toThrow();
    const other = await getAgentToolsOverview(b.actor("owner"));
    expect(other.calls.every((c) => !view.calls.some((v) => v.id === c.id))).toBe(true);
  });
});

describe("settings screen and its emergency control", () => {
  const scope = (over: Partial<CrmScope> = {}): CrmScope => ({ base: "/crm", orgId: null, agency: false, readOnly: false, userId: null, timezone: "UTC", currency: "USD", can: {}, ...over });

  it("renders each employee's tools, the honest not-live notice, the call log and the links out", async () => {
    const agent = await ready(a, "sales_assistant", "autonomous");
    await tokenFor(a, agent);
    const overview = await getAgentToolsOverview(a.actor("owner"));
    const html = renderToStaticMarkup(React.createElement(AiToolsScreen, { scope: scope(), overview }));
    expect(html).toContain("AI Employee Tools");
    expect(html).toContain("Not in use yet");
    expect(html).toContain("Sales Assistant");
    expect(html).toContain("Always asks");
    expect(html).toContain("Asks first when it changes more than one contact.");
    expect(html).toContain('href="/approvals"');
    expect(html).toContain('href="/employees"');
    expect(html).toContain('href="/employees/sales-assistant"');
    expect(html).toContain('aria-label="Stop tool access for Sales Assistant"');
    expect(html).toContain("Waiting for approval");
    // Nothing secret reaches the page.
    expect(html).not.toMatch(/iaqat_|token_hash/);
    // An agency viewer, or someone who can't pause, gets no stop button.
    expect(renderToStaticMarkup(React.createElement(AiToolsScreen, { scope: scope({ agency: true, readOnly: true }), overview }))).not.toContain('aria-label="Stop tool access for');
    expect(renderToStaticMarkup(React.createElement(AiToolsScreen, { scope: scope(), overview: { ...overview, canStop: false } }))).not.toContain('aria-label="Stop tool access for');
    // Active workspace pauses are shown where the stop controls are explained.
    expect(html).not.toContain("Customer messaging paused");
    const paused = renderToStaticMarkup(React.createElement(AiToolsScreen, { scope: scope(), overview: { ...overview, pauses: { agency: true, messaging: true, outbound: false } } }));
    expect(paused).toContain("Customer messaging paused");
    expect(paused).not.toContain("Outbound actions paused");
    expect(paused).toContain("Automation is on hold.");
  });

  it("the stop action needs the pause permission and ends every live credential", async () => {
    const agent = await ready(a, "appointment_setter", "autonomous");
    const t = await tokenFor(a, agent);
    who.actor = a.actor("sales");
    expect(await revokeAgentToolAccessAction(null, agent)).toMatchObject({ ok: false, code: "forbidden" });
    who.actor = a.actor("owner");
    expect(await revokeAgentToolAccessAction(null, "not-an-id")).toMatchObject({ ok: false, code: "invalid_input" });
    const res = await revokeAgentToolAccessAction(null, agent);
    expect(res.ok && res.data.revoked).toBeGreaterThanOrEqual(1);
    expect((await call(t.token, "find_contacts", { query: "x" })).httpStatus).toBe(401);
    expect(await count("select 1 from audit_logs where agent_instance_id = $1 and action = 'crm.agent_tool_access_revoked' and actor_user_id = $2", [agent, a.people.owner.id])).toBe(1);
    who.actor = null;
  });
});
