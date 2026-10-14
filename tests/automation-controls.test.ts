import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { automationGate, assertAutomationAllowed } from "@/server/automation/gate";
import { getControlState, setAgencyPause, setAgentMode, setClientPause } from "@/server/automation/controls";
import { addMember, agencyUser, agentId, createOrg, createUser, ctxFor } from "./support/fixtures";

type Org = Awaited<ReturnType<typeof createOrg>>;
let org: Org;
let other: Org;
let owner: { id: string; email: string };
let manager: { id: string; email: string };
let member: { id: string; email: string };
let staff: { id: string; email: string };
let superAdmin: { id: string; email: string };
let agencyOrg: Org;

const gate = (orgId: string, agent: string | null, scope: Parameters<typeof automationGate>[1]["scope"], approvalId?: string) =>
  withSystem((db) => automationGate(db, { orgId, agentId: agent, scope, approvalId }));

async function makeReady(orgId: string, agent: string) {
  await withSystem((db) => db.query("update agent_instances set status = 'online', last_health_ok = true, enabled = true where id = $1 and org_id = $2", [agent, orgId]));
}
async function activate(orgId: string) {
  await withSystem(async (db) => {
    await db.query(
      `insert into client_setup_instances (org_id, state, activated_at) values ($1, 'activated', now())
       on conflict (org_id) do update set state = 'activated', activated_at = now()`,
      [orgId],
    );
  });
}

beforeAll(async () => {
  org = await createOrg({ name: "Gate Co" });
  other = await createOrg({ name: "Other Co" });
  agencyOrg = await createOrg({ name: "Agency HQ", kind: "agency" });
  owner = await createUser();
  manager = await createUser();
  member = await createUser();
  staff = await createUser({ platformRole: "agency_staff" });
  superAdmin = await createUser({ platformRole: "agency_super_admin" });
  await addMember(org.id, owner.id, "owner");
  await addMember(org.id, manager.id, "admin");
  await addMember(org.id, member.id, "member");
  await withSystem((db) => db.query("insert into staff_assignments (org_id, user_id) values ($1, $2)", [org.id, staff.id]));
});

describe("employee operating modes", () => {
  it("new employees start in approval-required mode, never autonomous", async () => {
    const { rows } = await withSystem((db) => db.query<{ mode: string }>("select distinct mode from agent_instances where org_id = $1", [org.id]));
    expect(rows).toEqual([{ mode: "approval_required" }]);
  });

  it("an employee that has not passed its connection check cannot act", async () => {
    const agent = await agentId(org.id, "sales_assistant");
    const d = await gate(org.id, agent, "reply");
    expect(d).toMatchObject({ decision: "blocked", reason: "agent_not_ready" });
  });

  it("approval-required employees need a current approval from this tenant", async () => {
    const agent = await agentId(org.id, "sales_assistant");
    await makeReady(org.id, agent);
    expect(await gate(org.id, agent, "reply")).toMatchObject({ decision: "needs_approval" });

    const make = (orgId: string, status: string, expires: string | null) =>
      withSystem(async (db) => {
        const { rows } = await db.query<{ id: string }>(
          `insert into approval_requests (org_id, kind, title, status, decided_at, expires_at) values ($1, 'follow_up_message', 'x', $2, now(), ${expires ? `now() + interval '${expires}'` : "null"}) returning id`,
          [orgId, status],
        );
        return rows[0].id;
      });
    expect((await gate(org.id, agent, "reply", await make(org.id, "approved", "1 hour"))).decision).toBe("allow");
    expect((await gate(org.id, agent, "reply", await make(org.id, "pending", null))).decision).toBe("needs_approval");
    expect((await gate(org.id, agent, "reply", await make(org.id, "rejected", null))).decision).toBe("needs_approval");
    expect((await gate(org.id, agent, "reply", await make(org.id, "approved", "-1 hour"))).decision).toBe("needs_approval");
    // An approval granted to another tenant is worthless here.
    expect((await gate(org.id, agent, "reply", await make(other.id, "approved", null))).decision).toBe("needs_approval");
  });

  it("only the owner can enable autonomous mode, with confirmation, health and activation", async () => {
    const agent = await agentId(org.id, "lead_hunter");
    const ownerCtx = ctxFor(owner, org, "owner");
    await expect(setAgentMode(ctxFor(manager, org, "admin"), { agentId: agent, mode: "autonomous", confirmAutonomous: true })).rejects.toThrow(/business owner/);
    await expect(setAgentMode(ctxFor(member, org, "member"), { agentId: agent, mode: "paused" })).rejects.toThrow(/owners and managers/);
    await expect(setAgentMode(ownerCtx, { agentId: agent, mode: "autonomous" })).rejects.toThrow(/Confirm/);
    await expect(setAgentMode(ownerCtx, { agentId: agent, mode: "autonomous", confirmAutonomous: true })).rejects.toThrow(/connection check/);
    await makeReady(org.id, agent);
    await expect(setAgentMode(ownerCtx, { agentId: agent, mode: "autonomous", confirmAutonomous: true })).rejects.toThrow(/activates your workspace/);
    await activate(org.id);
    expect(await setAgentMode(ownerCtx, { agentId: agent, mode: "autonomous", confirmAutonomous: true })).toEqual({ mode: "autonomous", changed: true });
    expect((await gate(org.id, agent, "followup")).decision).toBe("allow");
    // Same mode again is a no-op, not a second audit entry.
    expect(await setAgentMode(ownerCtx, { agentId: agent, mode: "autonomous", confirmAutonomous: true })).toEqual({ mode: "autonomous", changed: false });
  });

  it("a paused employee stops all new work and customer actions, and the state survives a restart", async () => {
    const agent = await agentId(org.id, "lead_hunter");
    await setAgentMode(ctxFor(manager, org, "admin"), { agentId: agent, mode: "paused", reason: "Reviewing replies" });
    for (const scope of ["reply", "followup", "outbound", "job"] as const) {
      expect(await gate(org.id, agent, scope)).toMatchObject({ decision: "blocked", reason: "agent_paused" });
    }
    // Nothing is held in memory: a fresh read (a restarted worker) sees the same answer.
    const { rows } = await withSystem((db) => db.query<{ mode: string; mode_reason: string }>("select mode, mode_reason from agent_instances where id = $1", [agent]));
    expect(rows[0]).toEqual({ mode: "paused", mode_reason: "Reviewing replies" });
    await expect(withSystem((db) => assertAutomationAllowed(db, { orgId: org.id, agentId: agent, scope: "reply" }))).rejects.toThrow(/paused/);
    // A manager can resume into approval-required (the safe direction).
    await setAgentMode(ctxFor(manager, org, "admin"), { agentId: agent, mode: "approval_required" });
    expect((await gate(org.id, agent, "reply")).decision).toBe("needs_approval");
  });

  it("records an audit event for every mode change", async () => {
    const { rows } = await withSystem((db) => db.query<{ n: string }>("select count(*)::text as n from audit_logs where org_id = $1 and action = 'agent.mode_changed'", [org.id]));
    expect(Number(rows[0].n)).toBeGreaterThanOrEqual(3);
  });

  it("refuses to change an employee that belongs to another tenant", async () => {
    const foreign = await agentId(other.id, "sales_assistant");
    await expect(setAgentMode(ctxFor(owner, org, "owner"), { agentId: foreign, mode: "paused" })).rejects.toThrow(/not found/i);
    const { rows } = await withSystem((db) => db.query<{ mode: string }>("select mode from agent_instances where id = $1", [foreign]));
    expect(rows[0].mode).toBe("approval_required");
    // And a forged agent id never satisfies the gate for this tenant.
    expect(await gate(org.id, foreign, "reply")).toMatchObject({ decision: "blocked", reason: "agent_missing" });
  });
});

describe("emergency pauses", () => {
  it("pausing customer-facing messaging blocks replies and follow-ups but not background jobs", async () => {
    const agent = await agentId(org.id, "sales_assistant");
    await withSystem((db) => db.query("update agent_instances set mode = 'autonomous' where id = $1", [agent]));
    await setClientPause(ctxFor(manager, org, "admin"), { scope: "messaging", paused: true, reason: "Wrong price quoted" });
    expect(await gate(org.id, agent, "reply")).toMatchObject({ decision: "blocked", reason: "messaging_paused" });
    expect(await gate(org.id, agent, "followup")).toMatchObject({ decision: "blocked", reason: "messaging_paused" });
    expect((await gate(org.id, agent, "job")).decision).toBe("allow");
    // Other tenants are unaffected.
    const otherAgent = await agentId(other.id, "sales_assistant");
    await makeReady(other.id, otherAgent);
    expect((await gate(other.id, otherAgent, "reply")).decision).toBe("needs_approval");
    await setClientPause(ctxFor(manager, org, "admin"), { scope: "messaging", paused: false });
    expect((await gate(org.id, agent, "reply")).decision).toBe("allow");
  });

  it("pausing outbound blocks follow-ups and campaigns but still allows replies to customers who wrote in", async () => {
    const agent = await agentId(org.id, "sales_assistant");
    await setClientPause(ctxFor(owner, org, "owner"), { scope: "outbound", paused: true });
    expect(await gate(org.id, agent, "followup")).toMatchObject({ decision: "blocked", reason: "outbound_paused" });
    expect(await gate(org.id, agent, "outbound")).toMatchObject({ decision: "blocked", reason: "outbound_paused" });
    expect((await gate(org.id, agent, "reply")).decision).toBe("allow");
    await setClientPause(ctxFor(owner, org, "owner"), { scope: "outbound", paused: false });
  });

  it("members cannot pause, and unknown scopes are rejected", async () => {
    await expect(setClientPause(ctxFor(member, org, "member"), { scope: "messaging", paused: true })).rejects.toThrow(/owners and managers/);
    await expect(setClientPause(ctxFor(owner, org, "owner"), { scope: "agency" as never, paused: true })).rejects.toThrow(/Unknown/);
  });

  it("agency pause stops everything including autonomous work; only a super admin can lift it", async () => {
    const agent = await agentId(org.id, "sales_assistant");
    await setAgencyPause(agencyUser(staff, "agency_staff"), { orgId: org.id, paused: true, reason: "Complaint under investigation" });
    for (const scope of ["reply", "followup", "outbound", "job"] as const) {
      expect(await gate(org.id, agent, scope)).toMatchObject({ decision: "blocked", reason: "agency_paused" });
    }
    await expect(setAgencyPause(agencyUser(staff, "agency_staff"), { orgId: org.id, paused: false, reason: "" })).rejects.toThrow(/super admin/);
    // The client can see that a pause exists but never the agency's internal reason.
    const rows = await withUser(owner.id, (db) => db.query<{ scope: string; active: boolean; reason: string | null }>("select scope, active, reason from automation_pauses where org_id = $1 and scope = 'agency'", [org.id]));
    expect(rows.rows).toEqual([{ scope: "agency", active: true, reason: null }]);
    const audit = await withSystem((db) => db.query<{ metadata: { reason?: string } }>("select metadata from audit_logs where org_id = $1 and action = 'automation.agency_paused'", [org.id]));
    expect(audit.rows[0].metadata.reason).toBe("Complaint under investigation");
    // A client user cannot even attempt to pause or resume the agency scope.
    await expect(setAgencyPause({ id: owner.id, platformRole: "none" }, { orgId: org.id, paused: false, reason: "" })).rejects.toThrow(/Agency access/);
    await setAgencyPause(agencyUser(superAdmin, "agency_super_admin"), { orgId: org.id, paused: false, reason: "" });
    expect((await gate(org.id, agent, "reply")).decision).toBe("allow");
  });

  it("staff cannot pause a client they are not assigned to, and cannot pause the platform", async () => {
    await expect(setAgencyPause(agencyUser(staff, "agency_staff"), { orgId: other.id, paused: true, reason: "x" })).rejects.toThrow(/not assigned/);
    await expect(setAgencyPause(agencyUser(staff, "agency_staff"), { orgId: null, paused: true, reason: "x" })).rejects.toThrow(/super admin/);
  });

  it("a platform-wide pause stops every tenant and survives until a super admin lifts it", async () => {
    // Make sure the agency workspace has an owner-less row to hold the global switch.
    expect(agencyOrg.id).toBeTruthy();
    await setAgencyPause(agencyUser(superAdmin, "agency_super_admin"), { orgId: null, paused: true, reason: "Provider incident" });
    const a = await agentId(org.id, "sales_assistant");
    const b = await agentId(other.id, "sales_assistant");
    expect(await gate(org.id, a, "reply")).toMatchObject({ decision: "blocked", reason: "agency_paused" });
    expect(await gate(other.id, b, "job")).toMatchObject({ decision: "blocked", reason: "agency_paused" });
    await setAgencyPause(agencyUser(superAdmin, "agency_super_admin"), { orgId: null, paused: false, reason: "" });
    expect((await gate(org.id, a, "reply")).decision).toBe("allow");
  });

  it("reports the control state to the interface", async () => {
    await setClientPause(ctxFor(owner, org, "owner"), { scope: "messaging", paused: true, reason: "Holiday" });
    const state = await withSystem((db) => getControlState(db, org.id));
    expect(state.pauses.messaging).toMatchObject({ active: true, reason: "Holiday" });
    expect(state.pauses.agency.active).toBe(false);
    expect(state.employees).toHaveLength(6);
    await setClientPause(ctxFor(owner, org, "owner"), { scope: "messaging", paused: false });
  });

  it("autonomous mode is refused while an agency pause is active", async () => {
    const agent = await agentId(org.id, "crm_manager");
    await makeReady(org.id, agent);
    await setAgencyPause(agencyUser(superAdmin, "agency_super_admin"), { orgId: org.id, paused: true, reason: "Review" });
    await expect(setAgentMode(ctxFor(owner, org, "owner"), { agentId: agent, mode: "autonomous", confirmAutonomous: true })).rejects.toThrow(/paused automation/);
    await setAgencyPause(agencyUser(superAdmin, "agency_super_admin"), { orgId: org.id, paused: false, reason: "" });
  });
});
