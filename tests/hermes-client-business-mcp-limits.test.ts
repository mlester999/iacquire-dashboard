// The client tier's rate limits: every tool call and context read of one workspace is counted together, and every one made for one person, so a busy workspace or person cannot use up
// another's allowance. Counted once the turn and its person are known, never on a plain tool listing, and a refusal by a limit creates nothing. Two synthetic workspaces; real handler.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import {
  auditRows, callBody, clientSideEffects, endClientTurns, postClient, provisionedClient, refused, setClientProposals, setClientTier, setProposalsSwitch, startClientTurn, toolJson, toolText,
  withoutAudit, type ClientTenant,
} from "./support/client-business-mcp";

let a: ClientTenant;
let b: ClientTenant;

type Who = keyof ClientTenant["crm"]["people"];

const FIND = { query: "Chicagoan" };
const hits = async (bucket: string) => Number((await withSystem((db) => db.query<{ n: string | null }>("select sum(hits)::text as n from rate_limit_buckets where bucket_key = $1", [bucket]))).rows[0].n ?? 0);
const userBucket = (t: ClientTenant, userId: string) => `${RATE_LIMITS.clientBusinessMcpByUser.name}:${t.org.id}:${userId}`;
const orgBucket = (t: ClientTenant) => `${RATE_LIMITS.clientBusinessMcpByOrg.name}:${t.org.id}`;
const employeeBucket = (t: ClientTenant, role: AgentRoleKey) => `${RATE_LIMITS.agentToolCallsByEmployee.name}:${t.agents[role]}`;

/** The limits are fixed windows of a minute. A test that fills one must not straddle the minute, or its own counts would be split between two windows. */
async function withinOneWindow() {
  const left = RATE_LIMITS.clientBusinessMcpByUser.windowSeconds * 1000 - (Date.now() % (RATE_LIMITS.clientBusinessMcpByUser.windowSeconds * 1000));
  if (left < 6_000) await new Promise((resolve) => setTimeout(resolve, left + 100));
}

async function ask(t: ClientTenant, role: AgentRoleKey, tool: string, args: Record<string, unknown> = {}) {
  return postClient(t.credentials[role], callBody(tool, args));
}

const served = (rpc: Awaited<ReturnType<typeof ask>>) => !refused(rpc) && (toolJson(rpc) as { ok?: boolean } | null)?.ok !== false;

beforeAll(async () => {
  a = await provisionedClient({ name: "Chicago Roofing", timezone: "America/Chicago", tag: "Chicagoan", phone: "+13125550101" });
  b = await provisionedClient({ name: "Manila Dental", timezone: "Asia/Manila", tag: "Manilan", phone: "+639171234501", entitled: AGENT_ROLE_KEYS.filter((role) => role !== "sales_assistant") });
}, 240_000);

beforeEach(async () => {
  await withSystem((db) => db.query("delete from rate_limit_buckets"));
  setClientTier(true);
  await withinOneWindow();
});

afterEach(async () => {
  for (const t of [a, b]) for (const role of AGENT_ROLE_KEYS) await endClientTurns(t, role);
  vi.unstubAllEnvs();
  resetEnvCache();
});

afterAll(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

describe("what is counted, and how many times", () => {
  it("counts one tool call once for the person and once for the workspace, and the per-employee rule as it always did", async () => {
    await startClientTurn(a, "crm_manager", a.owner.id);
    expect(served(await ask(a, "crm_manager", "find_contacts", FIND))).toBe(true);
    expect(await hits(userBucket(a, a.owner.id))).toBe(1);
    expect(await hits(orgBucket(a))).toBe(1);
    // The route counts the employee once and the shared tool engine once more: the same two as before this tier had limits of its own. This handler adds no third.
    expect(await hits(employeeBucket(a, "crm_manager"))).toBe(2);
    // Another workspace's buckets are untouched.
    expect(await hits(orgBucket(b))).toBe(0);
  });

  it("counts a context read too, and a plain tool listing not at all (no turn, no person, nothing read)", async () => {
    await startClientTurn(a, "crm_manager", a.owner.id);
    for (let i = 0; i < 5; i += 1) expect((await postClient(a.credentials.crm_manager)).status).toBe(200);
    expect(await hits(userBucket(a, a.owner.id))).toBe(0);
    expect(await hits(orgBucket(a))).toBe(0);
    expect(served(await ask(a, "crm_manager", "get_role_workspace_context"))).toBe(true);
    expect(await hits(userBucket(a, a.owner.id))).toBe(1);
    expect(await hits(orgBucket(a))).toBe(1);
  });

  it("does not count a call that has no valid turn: nobody can be named for it yet", async () => {
    await endClientTurns(a, "crm_manager");
    const rpc = await ask(a, "crm_manager", "find_contacts", FIND);
    expect(refused(rpc)).toBe(true);
    expect(await hits(userBucket(a, a.owner.id))).toBe(0);
    expect(await hits(orgBucket(a))).toBe(0);
  });
});

describe("the per-person limit", () => {
  it("refuses the call past the limit whichever employee it goes through, for that person only, and creates nothing", async () => {
    const roles = ["appointment_setter", "lead_hunter", "crm_manager"] as const;
    for (const role of roles) await startClientTurn(a, role, a.owner.id);
    const limit = RATE_LIMITS.clientBusinessMcpByUser.limit;
    // The allowance is used up directly in the bucket, leaving the last three calls (one through each employee) to go through the real handler: a run of dozens of full round trips
    // could outlast what is left of the minute on a slow machine, and the window would roll over before the call past the limit.
    for (let i = 0; i < limit - roles.length; i += 1) await consumeRateLimit(RATE_LIMITS.clientBusinessMcpByUser, `${a.org.id}:${a.owner.id}`);
    for (const [i, role] of roles.entries()) expect(served(await ask(a, role, "find_contacts", FIND)), `call ${limit - roles.length + i + 1}`).toBe(true);
    expect(await hits(userBucket(a, a.owner.id))).toBe(limit);

    const before = await clientSideEffects();
    const over = await ask(a, "lead_hunter", "find_contacts", FIND);
    expect(refused(over)).toBe(true);
    expect(toolJson(over)).toMatchObject({ status: "unavailable", message: expect.stringMatching(/Too many business tool requests for this person/) });
    expect(toolText(over)).toMatch(/Wait \d+ seconds/);
    expect(toolText(over)).not.toContain("Chicagoan Prospect");
    // The other employees of the same person are refused too, and the refusal asked for nothing: no token, approval, record or notice.
    expect(refused(await ask(a, "appointment_setter", "get_role_workspace_context"))).toBe(true);
    const after = await clientSideEffects();
    expect({ ...withoutAudit(after), agent_runs: 0 }).toEqual({ ...withoutAudit(before), agent_runs: 0 });
    // The refusal is on record in this workspace, naming the person and the scope only.
    const denied = (await auditRows("hermes.business_mcp.read", a.org.id)).filter((row) => row.metadata.reason === "rate_limited");
    expect(denied.length).toBeGreaterThanOrEqual(2);
    expect(denied[0]).toMatchObject({ org_id: a.org.id, actor_user_id: a.owner.id, result: "denied", metadata: { tier: "client", reason: "rate_limited", scope: "person", role: "lead_hunter", tool: "find_contacts" } });
    expect(Object.keys(denied[0].metadata).sort()).toEqual(["jti", "reason", "role", "scope", "tier", "tool"]);

    // A colleague in the same workspace has an allowance of their own, and so does the other workspace's owner.
    await startClientTurn(a, "appointment_setter", a.crm.people.sales.id);
    expect(served(await ask(a, "appointment_setter", "find_contacts", FIND))).toBe(true);
    await startClientTurn(b, "crm_manager", b.owner.id);
    expect(served(await ask(b, "crm_manager", "find_contacts", { query: "Manilan" }))).toBe(true);
    expect(await hits(userBucket(b, b.owner.id))).toBe(1);
  });

  it("does not spend the workspace's allowance on a call the person's own limit refused", async () => {
    await startClientTurn(a, "crm_manager", a.owner.id);
    for (let i = 0; i < RATE_LIMITS.clientBusinessMcpByUser.limit; i += 1) await consumeRateLimit(RATE_LIMITS.clientBusinessMcpByUser, `${a.org.id}:${a.owner.id}`);
    const orgBefore = await hits(orgBucket(a));
    expect(refused(await ask(a, "crm_manager", "find_contacts", FIND))).toBe(true);
    expect(await hits(orgBucket(a))).toBe(orgBefore);
  });
});

describe("the per-workspace limit", () => {
  it("refuses every person and every employee of the workspace past the limit, including a change someone asks for, and serves the other workspace", async () => {
    setClientProposals(true);
    await setProposalsSwitch(a.org.id, true);
    // The workspace has used exactly its allowance: the next call, from anyone, is the one past it.
    for (let i = 0; i < RATE_LIMITS.clientBusinessMcpByOrg.limit; i += 1) await consumeRateLimit(RATE_LIMITS.clientBusinessMcpByOrg, a.org.id);

    const before = await clientSideEffects();
    const tries: Array<[Who, AgentRoleKey, string, Record<string, unknown>]> = [
      ["owner", "crm_manager", "find_contacts", FIND],
      ["sales", "appointment_setter", "find_contacts", FIND],
      ["owner", "lead_hunter", "get_role_workspace_context", {}],
      ["owner", "appointment_setter", "create_task", { title: "Past the limit" }],
    ];
    for (const [who, role, tool, args] of tries) {
      await startClientTurn(a, role, a.crm.people[who].id);
      const rpc = await ask(a, role, tool, args);
      expect(refused(rpc), `${role} ${tool}`).toBe(true);
      expect(toolText(rpc), `${role} ${tool}`).toMatch(/Too many business tool requests for this workspace/);
      expect(toolText(rpc), `${role} ${tool}`).not.toMatch(/Chicagoan Prospect|pending_approval/);
    }
    const after = await clientSideEffects();
    expect({ ...withoutAudit(after), agent_runs: 0 }).toEqual({ ...withoutAudit(before), agent_runs: 0 });
    expect(after.approval_requests).toBe(before.approval_requests);
    expect(after.crm_agent_tokens).toBe(before.crm_agent_tokens);
    // Listing the tools is not counted, so the gateway can still describe the employee.
    expect((await postClient(a.credentials.crm_manager)).status).toBe(200);
    // The other workspace is served as usual, for every kind of call.
    await startClientTurn(b, "crm_manager", b.owner.id);
    expect(served(await ask(b, "crm_manager", "find_contacts", { query: "Manilan" }))).toBe(true);
    expect(served(await ask(b, "crm_manager", "get_role_workspace_context"))).toBe(true);
    expect(await hits(orgBucket(b))).toBe(2);
    expect((await auditRows("hermes.business_mcp.read", b.org.id)).filter((row) => row.metadata.reason === "rate_limited")).toHaveLength(0);
  });
});

describe("the failure limit, and whose audit rows are whose", () => {
  it("lets a genuine credential through from an address that keeps failing, and counts that call in the usual way", async () => {
    const ip = "203.0.113.91";
    for (let i = 0; i < 32; i += 1) await postClient("not-a-credential", undefined, ip);
    expect((await postClient("not-a-credential", undefined, ip)).status).toBe(429);
    await startClientTurn(a, "crm_manager", a.owner.id);
    const rpc = await postClient(a.credentials.crm_manager, callBody("find_contacts", FIND), ip);
    expect(rpc.status).toBe(200);
    expect(toolText(rpc)).toContain("Chicagoan Prospect");
    expect(await hits(userBucket(a, a.owner.id))).toBe(1);
  });

  it("writes every row of a workspace's traffic to that workspace, and none of it to the other", async () => {
    await startClientTurn(a, "crm_manager", a.owner.id);
    await startClientTurn(b, "crm_manager", b.owner.id);
    await ask(a, "crm_manager", "find_contacts", FIND);
    await ask(b, "crm_manager", "find_contacts", { query: "Manilan" });
    await ask(a, "crm_manager", "get_role_workspace_context");
    await ask(b, "crm_manager", "get_role_workspace_context");
    for (let i = 0; i < RATE_LIMITS.clientBusinessMcpByUser.limit; i += 1) await consumeRateLimit(RATE_LIMITS.clientBusinessMcpByUser, `${a.org.id}:${a.owner.id}`);
    await ask(a, "crm_manager", "find_contacts", FIND);
    const agentsOf = (t: ClientTenant) => AGENT_ROLE_KEYS.map((role) => t.agents[role]);
    const stray = await withSystem((db) => db.query<{ n: number }>(
      `select count(*)::int as n from audit_logs
        where (action like 'hermes.%business_mcp%' or action like 'crm.agent_tool.%')
          and ((agent_instance_id = any($1::uuid[]) and org_id <> $3) or (agent_instance_id = any($2::uuid[]) and org_id <> $4))`,
      [agentsOf(a), agentsOf(b), a.org.id, b.org.id],
    ));
    expect(stray.rows[0].n).toBe(0);
    for (const t of [a, b]) {
      const own = await withSystem((db) => db.query<{ n: number }>("select count(*)::int as n from audit_logs where org_id = $1 and (action like 'hermes.%business_mcp%' or action like 'crm.agent_tool.%')", [t.org.id]));
      expect(own.rows[0].n).toBeGreaterThan(0);
    }
    // Nothing a refusal wrote names anything but ids and reason codes.
    for (const row of await auditRows("hermes.business_mcp.read", a.org.id)) expect(JSON.stringify(row.metadata)).not.toMatch(/Chicagoan|Manilan|iamcpc1|iaqat_/);
  });

  it("states the two rules with their own names, apart from the per-employee rule", () => {
    expect(RATE_LIMITS.clientBusinessMcpByOrg.name).toMatch(/^client-business-mcp:/);
    expect(RATE_LIMITS.clientBusinessMcpByUser.name).toMatch(/^client-business-mcp:/);
    expect(RATE_LIMITS.clientBusinessMcpByOrg.name).not.toBe(RATE_LIMITS.clientBusinessMcpByUser.name);
    // A workspace's allowance covers its people's together, so it is never smaller than one person's.
    expect(RATE_LIMITS.clientBusinessMcpByOrg.limit).toBeGreaterThanOrEqual(RATE_LIMITS.clientBusinessMcpByUser.limit);
  });
});
