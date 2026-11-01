// list_opportunities: the one read tool added for the client business tier. Synthetic workspaces only; nothing here calls Hermes or sends anything.
// It reads through the same deal service people use (listOpportunities(actor)), so it returns only the caller's own workspace's deals and needs sales.view twice over
// (the employee's scope and the person's own role). It is offered only on a call that names the person asking, and it is in no internal agency employee's tool list.
import { beforeAll, describe, expect, it } from "vitest";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { withSystem } from "@/server/db";
import { agentActor } from "@/server/crm/actor";
import { AGENT_TOOLS, AGENT_TOOL_SCOPES, ROLE_SCOPES, TOOL_INPUTS, toolManifest, toolsForRole } from "@/server/crm/agent-tools/catalog";
import { HANDLERS } from "@/server/crm/agent-tools/handlers";
import { issueAgentToolToken } from "@/server/crm/agent-tools/tokens";
import { callAgentTool } from "@/server/crm/agent-tools/service";
import { createContact } from "@/server/crm/contacts";
import { closeOpportunity, createOpportunity } from "@/server/crm/opportunities";
import { listPipelines } from "@/server/crm/pipelines";
import { businessMcpToolNamesForRole } from "@/server/workforce/hermes-business-mcp-policy";
import { agentId as roleAgent } from "./support/fixtures";
import { crmOrg, type CrmOrg } from "./support/crm";

const ALL = [...AGENT_TOOL_SCOPES];
const ROLES_WITH_DEALS: AgentRoleKey[] = ["operations_manager", "sales_assistant", "crm_manager", "performance_analyst"];

let a: CrmOrg;
let b: CrmOrg;
let pipelineA: string;
let pipelineB: string;

const one = async <T extends Record<string, unknown>>(sql: string, params: unknown[]) => (await withSystem((db) => db.query<T>(sql, params))).rows[0];
const count = async (sql: string, params: unknown[]) => Number((await one<{ n: string }>(`select count(*)::text as n from (${sql}) x`, params)).n);

async function ready(org: CrmOrg, role: string) {
  const id = await roleAgent(org.org.id, role);
  await withSystem((db) => db.query("update agent_instances set status = 'online', last_health_ok = true, enabled = true, mode = 'autonomous' where id = $1", [id]));
  return id;
}

async function list(org: CrmOrg, role: string, who: string | null | undefined, args: unknown = {}) {
  const agent = await ready(org, role);
  const run = await one<{ id: string }>("insert into agent_runs (org_id, agent_instance_id, purpose, idempotency_key, status) values ($1, $2, 'crm_tool', $3, 'running') returning id", [org.org.id, agent, `test:${crypto.randomUUID()}`]);
  const t = await withSystem((db) => issueAgentToolToken(db, { orgId: org.org.id, agentInstanceId: agent, runId: run.id, scopes: ALL, ttlMinutes: 5 }));
  return callAgentTool({ token: t.token, tool: "list_opportunities", readArgs: async () => args, onBehalfOfUserId: who });
}

const names = (reply: Awaited<ReturnType<typeof list>>) => (reply.ok ? (reply.result.deals as Array<{ name: string }>).map((d) => d.name).sort() : []);

beforeAll(async () => {
  a = await crmOrg({ name: "Deals Roofing" });
  b = await crmOrg({ name: "Deals Dental" });
  pipelineA = (await listPipelines(a.actor("owner"), { ensureDefault: true }))[0].id;
  pipelineB = (await listPipelines(b.actor("owner"), { ensureDefault: true }))[0].id;
  const ca = await createContact(a.actor("owner"), { firstName: "Roof", lastName: "Buyer", phone: "+13125550101" });
  await createOpportunity(a.actor("owner"), { name: "A Open Roof", contactId: ca.id, pipelineId: pipelineA, value: 8500, currency: "USD" });
  await createOpportunity(a.actor("owner"), { name: "A Open Gutters", pipelineId: pipelineA, value: 900, currency: "USD" });
  const won = await createOpportunity(a.actor("owner"), { name: "A Won Siding", pipelineId: pipelineA, value: 4000, currency: "USD" });
  await closeOpportunity(a.actor("owner"), won.id, "won");
  const lost = await createOpportunity(a.actor("owner"), { name: "A Lost Fence", pipelineId: pipelineA, value: 700, currency: "USD" });
  await closeOpportunity(a.actor("owner"), lost.id, "lost", { lostReason: "Chose another company" });
  await createOpportunity(b.actor("owner"), { name: "B Secret Crown Deal", pipelineId: pipelineB, value: 2500, currency: "PHP" });
});

describe("what the tool is", () => {
  it("is a read tool on the opportunities:read scope, needing the CRM and sales views, offered only to the client tier", () => {
    const def = AGENT_TOOLS.list_opportunities;
    expect(def).toMatchObject({ name: "list_opportunities", kind: "read", scope: "opportunities:read", clientOnly: true });
    expect([...def.permissions].sort()).toEqual(["crm.view", "sales.view"]);
    expect(def.alwaysApproval).toBeUndefined();
  });

  it("takes only a status, a limit of at most 25 and a pipeline, and refuses anything else", () => {
    const schema = TOOL_INPUTS.list_opportunities;
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ status: "won", limit: 25, pipelineId: crypto.randomUUID() }).success).toBe(true);
    expect(schema.safeParse({ limit: 26 }).success).toBe(false);
    expect(schema.safeParse({ limit: 0 }).success).toBe(false);
    expect(schema.safeParse({ status: "all" }).success).toBe(false);
    expect(schema.safeParse({ pipelineId: "not-an-id" }).success).toBe(false);
    expect(schema.safeParse({ orgId: crypto.randomUUID() }).success).toBe(false);
    expect(toolManifest(["list_opportunities"])[0].input_schema).toMatchObject({ type: "object", additionalProperties: false });
  });

  it("is reachable for exactly the roles that hold the deals scope, through the client list, and through no internal agency list", () => {
    for (const role of AGENT_ROLE_KEYS) {
      const holdsScope = ROLE_SCOPES[role].includes("opportunities:read");
      expect(toolsForRole(role, { includeClientOnly: true }).includes("list_opportunities"), role).toBe(holdsScope);
      expect(ROLES_WITH_DEALS.includes(role), role).toBe(holdsScope);
      // The default list, which the token API and the internal tier derive from, never carries it.
      expect(toolsForRole(role).includes("list_opportunities"), role).toBe(false);
      expect(businessMcpToolNamesForRole(role, false)).not.toContain("list_opportunities");
      expect(businessMcpToolNamesForRole(role, true)).not.toContain("list_opportunities");
    }
  });
});

describe("it returns only the caller's own workspace's deals", () => {
  it("lists a workspace's open deals and never another workspace's, by any filter", async () => {
    const mine = await list(a, "sales_assistant", a.people.owner.id);
    expect(mine).toMatchObject({ ok: true, status: "done" });
    expect(names(mine)).toEqual(["A Open Gutters", "A Open Roof"]);
    expect(mine.ok && mine.result.total).toBe(2);
    expect(JSON.stringify(mine)).not.toMatch(/Secret Crown|Dental/);

    const theirs = await list(b, "sales_assistant", b.people.owner.id);
    expect(names(theirs)).toEqual(["B Secret Crown Deal"]);
    expect(JSON.stringify(theirs)).not.toMatch(/Roof|Gutters|Siding|Fence/);

    // Naming the other workspace's pipeline finds nothing: the organization comes from the employee, never from the arguments.
    const crossed = await list(a, "sales_assistant", a.people.owner.id, { pipelineId: pipelineB });
    expect(crossed).toMatchObject({ ok: true, result: { total: 0, deals: [] } });
    const own = await list(a, "sales_assistant", a.people.owner.id, { pipelineId: pipelineA });
    expect(names(own)).toEqual(["A Open Gutters", "A Open Roof"]);
  });

  it("offers closed deals only when asked for", async () => {
    expect(names(await list(a, "crm_manager", a.people.owner.id))).not.toEqual(expect.arrayContaining(["A Won Siding"]));
    expect(names(await list(a, "crm_manager", a.people.owner.id, { status: "won" }))).toEqual(["A Won Siding"]);
    const lost = await list(a, "crm_manager", a.people.owner.id, { status: "lost" });
    expect(names(lost)).toEqual(["A Lost Fence"]);
    expect(lost.ok && (lost.result.deals as Array<{ lostReason: string }>)[0].lostReason).toBe("Chose another company");
  });

  it("honours the limit, says how many there are in all, and rejects a larger one", async () => {
    const one1 = await list(a, "operations_manager", a.people.owner.id, { limit: 1 });
    expect(one1.ok && (one1.result.deals as unknown[]).length).toBe(1);
    expect(one1.ok && one1.result.total).toBe(2);
    expect(await list(a, "operations_manager", a.people.owner.id, { limit: 26 })).toMatchObject({ ok: false, httpStatus: 400, code: "invalid_input" });
    expect(await list(a, "operations_manager", a.people.owner.id, { orgId: b.org.id })).toMatchObject({ ok: false, httpStatus: 400 });
  });

  it("gives each deal's stage, pipeline, value and contact, and nothing that names a teammate", async () => {
    const mine = await list(a, "performance_analyst", a.people.owner.id);
    const roof = (mine.ok ? (mine.result.deals as Array<Record<string, unknown>>) : []).find((d) => d.name === "A Open Roof");
    expect(roof).toMatchObject({ status: "open", value: 8500, currency: "USD", stage: "New Lead", contact: { name: expect.stringContaining("Roof") } });
    expect(roof && "owner" in roof).toBe(false);
  });

  it("changes nothing: no deal, no approval and no task is created or moved", async () => {
    const before = [
      await count("select 1 from crm_opportunities where org_id = $1", [a.org.id]),
      await count("select 1 from approval_requests where org_id = $1", [a.org.id]),
      await count("select 1 from tasks where org_id = $1", [a.org.id]),
      await count("select 1 from crm_opportunity_history where org_id = $1", [a.org.id]),
    ];
    await list(a, "sales_assistant", a.people.owner.id, { status: "open" });
    const after = [
      await count("select 1 from crm_opportunities where org_id = $1", [a.org.id]),
      await count("select 1 from approval_requests where org_id = $1", [a.org.id]),
      await count("select 1 from tasks where org_id = $1", [a.org.id]),
      await count("select 1 from crm_opportunity_history where org_id = $1", [a.org.id]),
    ];
    expect(after).toEqual(before);
  });
});

describe("who may use it", () => {
  it("is refused to a role without the deals scope, and to a call that names no person", async () => {
    for (const role of ["lead_hunter", "appointment_setter"]) {
      expect(await list(a, role, a.people.owner.id), role).toMatchObject({ ok: false, httpStatus: 403, code: "forbidden" });
    }
    for (const who of [undefined, null]) expect(await list(a, "sales_assistant", who)).toMatchObject({ ok: false, httpStatus: 403, code: "forbidden" });
  });

  it("is refused to a person who may not see deals, whichever employee asks, and to a person of another workspace", async () => {
    const person = a.people.support.id;
    expect(await list(a, "sales_assistant", person)).toMatchObject({ ok: true });
    await withSystem((db) => db.query("insert into member_permission_overrides (org_id, user_id, permission, effect, reason) values ($1, $2, 'sales.view', 'revoke', 'test')", [a.org.id, person]));
    const denied = await list(a, "sales_assistant", person);
    expect(denied).toMatchObject({ ok: false, httpStatus: 403, code: "forbidden" });
    expect(JSON.stringify(denied)).not.toMatch(/A Open|Roof/);
    await withSystem((db) => db.query("delete from member_permission_overrides where org_id = $1 and user_id = $2", [a.org.id, person]));
    expect(await list(a, "sales_assistant", b.people.owner.id)).toMatchObject({ ok: false, httpStatus: 403 });
  });

  it("is forbidden at the handler too when the actor lacks sales.view", async () => {
    const actor = agentActor({ id: a.org.id, name: a.org.name, timezone: "UTC" }, { id: crypto.randomUUID(), displayName: "No Deals" }, ["crm.view"]);
    const ctx = { actor, agent: { id: actor.agentId as string, roleKey: "sales_assistant", displayName: "No Deals" }, runId: null, approvalId: null, callKey: "k", now: new Date() };
    await expect(HANDLERS.list_opportunities.run(ctx, {}, null)).rejects.toMatchObject({ code: "forbidden" });
  });
});
