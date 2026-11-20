// /admin/health must not show one client's failures, names or error text to people who may not see that client. Two client tenants each have a failed AI run, a failed approval
// execution and a failed integration check, every one carrying a canary string. This proves on embedded Postgres that:
//   * an agency staff member assigned to client A sees A's rows and counts and nothing of B (no text, no name), and a staff member assigned to nobody sees no client rows;
//   * a Super Admin sees both clients, with names;
//   * the viewer's role is read from the database, so a forged "Super Admin" on a staff session widens nothing, and a person with no agency role is refused;
//   * with the D70 switch on (a support session is needed to read a client's content) the text is replaced by a short code for everybody who has no session on that client,
//     the Super Admin included, and the codes stay.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { getSystemHealth, type SystemHealth } from "@/server/admin/health";
import { setClientContentPolicy } from "@/server/admin/client-content-policy";
import { assignStaff } from "@/server/admin/tenants";
import { agencyUser, agentId, createOrg, createUser } from "./support/fixtures";

const NAME_A = "Scoping Tenant Alpha";
const NAME_B = "Scoping Tenant Bravo";
let world: Awaited<ReturnType<typeof build>>;

async function build() {
  const a = await createOrg({ name: NAME_A });
  const b = await createOrg({ name: NAME_B });
  const superUser = await createUser({ platformRole: "agency_super_admin" });
  const staffA = await createUser({ platformRole: "agency_staff" });
  const staffNone = await createUser({ platformRole: "agency_staff" });
  const outsider = await createUser();
  const admin = agencyUser(superUser, "agency_super_admin");
  await assignStaff(admin, a.id, staffA.id, true);
  const agents = { A: await agentId(a.id, "lead_hunter"), B: await agentId(b.id, "lead_hunter") };
  await withSystem(async (db) => {
    for (const [org, tag, provider] of [[a, "A", "ghl"], [b, "B", "hermes"]] as const) {
      const agent = agents[tag];
      await db.query(
        `insert into agent_runs (org_id, agent_instance_id, purpose, idempotency_key, status, error_code, error_message, started_at, finished_at)
         values ($1, $2, 'chat', $3, 'failed', 'upstream_timeout', $4, now(), now())`,
        [org.id, agent, `health-scope-run-${tag}-${org.id}`, `CANARY_RUN_${tag} the client's own words`],
      );
      await db.query(
        `insert into approval_requests (org_id, agent_instance_id, kind, title, risk, status, execution_status, execution_detail)
         values ($1, $2, 'outreach', $3, 'high', 'approved', 'failed', $4)`,
        [org.id, agent, `Approval ${tag}`, `CANARY_APPROVAL_${tag} could not send`],
      );
      await db.query(
        "insert into integration_status (org_id, provider, status, detail, last_checked_at) values ($1, $2, 'error', $3, now())",
        [org.id, provider, `CANARY_INTEG_${tag} provider said no`],
      );
    }
    await db.query("delete from integration_status where org_id is null and provider = 'slack'");
    await db.query("insert into integration_status (org_id, provider, status, detail, last_checked_at) values (null, 'slack', 'error', 'CANARY_PLATFORM webhook refused', now())");
  });
  return { a, b, admin, superUser, staffA, staffNone, outsider };
}

beforeAll(async () => {
  world = await build();
});
afterEach(async () => {
  await withSystem(async (db) => {
    await db.query("update agency_policy_switches set enabled = false, changed_by = null, changed_at = null, note = null");
    await db.query("delete from crm_support_sessions where org_id = any($1::uuid[])", [[world.a.id, world.b.id]]);
  });
});

const viewer = (u: { id: string }, role: "agency_staff" | "agency_manager" | "agency_super_admin") => ({ id: u.id, platformRole: role });
const dump = (h: SystemHealth) => JSON.stringify(h.recentErrors);
const sources = (h: SystemHealth) => h.recentErrors.map((e) => e.source).sort();
const turnOnD70 = () => setClientContentPolicy(world.admin, { sessionRequired: true, note: "Trying the stricter rule in a test" });
async function openSession(userId: string, orgId: string) {
  await withSystem((db) => db.query(
    "insert into crm_support_sessions (org_id, user_id, mode, reason, expires_at) values ($1, $2, 'read', 'Looking into a support request', now() + interval '30 minutes')", [orgId, userId]));
}
async function enabledAgents(orgId: string) {
  return (await withSystem((db) => db.query<{ n: number }>("select count(*)::int as n from agent_instances where org_id = $1 and enabled", [orgId]))).rows[0].n;
}

describe("a Super Admin sees every client", () => {
  it("lists both clients' failures with their names and text while the D70 switch is off (today's behaviour)", async () => {
    const h = await getSystemHealth(viewer(world.superUser, "agency_super_admin"));
    expect(h.scope).toBe("all_clients");
    const text = dump(h);
    for (const canary of ["CANARY_RUN_A", "CANARY_RUN_B", "CANARY_APPROVAL_A", "CANARY_APPROVAL_B", "CANARY_INTEG_A", "CANARY_INTEG_B", "CANARY_PLATFORM"]) expect(text, canary).toContain(canary);
    expect(h.recentErrors.map((e) => e.org)).toEqual(expect.arrayContaining([NAME_A, NAME_B]));
    expect(h.recentErrors.every((e) => !e.detailWithheld)).toBe(true);
    expect(h.runs24h.failed).toBeGreaterThanOrEqual(2);
  });
});

describe("staff assigned to one client", () => {
  it("sees only that client's failures and counts, never the other client's text or name, and no client names at all", async () => {
    const h = await getSystemHealth(viewer(world.staffA, "agency_staff"));
    expect(h.scope).toBe("assigned_clients");
    const text = dump(h);
    for (const canary of ["CANARY_RUN_A", "CANARY_APPROVAL_A", "CANARY_INTEG_A"]) expect(text, canary).toContain(canary);
    expect(text).not.toMatch(/CANARY_(RUN|APPROVAL|INTEG)_B/);
    expect(JSON.stringify(h)).not.toContain(NAME_B);
    expect(JSON.stringify(h)).not.toContain(NAME_A);
    expect(h.recentErrors.every((e) => e.org === null)).toBe(true);
    // Own client: 1 failed run, 1 failed approval, 1 failed integration check, plus the platform-level row, which carries its code only.
    expect(sources(h)).toEqual(["agent_run", "approval_execution", "integration:ghl", "integration:slack"]);
    const platform = h.recentErrors.find((e) => e.source === "integration:slack")!;
    expect(platform).toMatchObject({ detail: "error", detailWithheld: true });
    expect(text).not.toContain("CANARY_PLATFORM");
    // Counts cover the assigned client only.
    expect(h.runs24h.total).toBe(1);
    expect(h.runs24h.failed).toBe(1);
    expect(h.hermes.total).toBe(await enabledAgents(world.a.id));
  });

  it("does not become a Super Admin by saying so: the role is read from the database", async () => {
    const h = await getSystemHealth(viewer(world.staffA, "agency_super_admin"));
    expect(h.scope).toBe("assigned_clients");
    expect(sources(h)).toEqual(["agent_run", "approval_execution", "integration:ghl", "integration:slack"]);
    expect(dump(h)).not.toMatch(/CANARY_(RUN|APPROVAL|INTEG)_B/);
    expect(JSON.stringify(h)).not.toContain(NAME_B);
    expect(JSON.stringify(h)).not.toContain(NAME_A);
    expect(dump(h)).not.toContain("CANARY_PLATFORM");
  });
});

describe("staff assigned to nobody and people with no agency role", () => {
  it("sees no client's failure, name or text", async () => {
    const h = await getSystemHealth(viewer(world.staffNone, "agency_staff"));
    expect(sources(h)).toEqual(["integration:slack"]);
    expect(dump(h)).not.toContain("CANARY");
    expect(JSON.stringify(h)).not.toContain("Scoping Tenant");
    expect(h.runs24h.total).toBe(0);
    expect(h.hermes.total).toBe(0);
    expect(h.ghl.mapped).toBe(0);
  });

  it("refuses a person with no agency role, whatever the session says", async () => {
    await expect(getSystemHealth(viewer(world.outsider, "agency_staff"))).rejects.toThrow(/Agency access/);
    await expect(getSystemHealth({ id: world.outsider.id, platformRole: "none" })).rejects.toThrow(/Agency access/);
  });
});

describe("with the D70 switch on (a support session is needed to read a client's content)", () => {
  it("keeps the failure codes and withholds the text for a Super Admin with no session, and for assigned staff", async () => {
    await turnOnD70();
    for (const who of [viewer(world.superUser, "agency_super_admin"), viewer(world.staffA, "agency_staff")]) {
      const h = await getSystemHealth(who);
      const text = dump(h);
      expect(text).not.toMatch(/CANARY_(RUN|APPROVAL|INTEG)_[AB]/);
      const byClientSource = h.recentErrors.filter((e) => e.source !== "integration:slack");
      expect(byClientSource.length).toBeGreaterThanOrEqual(3);
      for (const e of byClientSource) expect(e.detailWithheld, e.source).toBe(true);
      expect(byClientSource.map((e) => e.detail)).toEqual(expect.arrayContaining(["upstream_timeout", "execution_failed", "error"]));
    }
    // A Super Admin still reads a platform-level row (it belongs to no client); the staff member does not.
    expect(dump(await getSystemHealth(viewer(world.superUser, "agency_super_admin")))).toContain("CANARY_PLATFORM");
    expect(dump(await getSystemHealth(viewer(world.staffA, "agency_staff")))).not.toContain("CANARY_PLATFORM");
  });

  it("shows the text of the one client the person has an active support session on, and no other", async () => {
    await turnOnD70();
    await openSession(world.superUser.id, world.b.id);
    const h = await getSystemHealth(viewer(world.superUser, "agency_super_admin"));
    const text = dump(h);
    expect(text).toContain("CANARY_RUN_B");
    expect(text).toContain("CANARY_APPROVAL_B");
    expect(text).toContain("CANARY_INTEG_B");
    expect(text).not.toMatch(/CANARY_(RUN|APPROVAL|INTEG)_A/);
    // Names stay for the Super Admin; the client with no session still shows its code.
    expect(h.recentErrors.map((e) => e.org)).toEqual(expect.arrayContaining([NAME_A, NAME_B]));
    expect(h.recentErrors.filter((e) => e.detailWithheld).length).toBe(3);

    await openSession(world.staffA.id, world.a.id);
    const s = await getSystemHealth(viewer(world.staffA, "agency_staff"));
    expect(dump(s)).toContain("CANARY_RUN_A");
    expect(dump(s)).not.toMatch(/CANARY_(RUN|APPROVAL|INTEG)_B/);
  });
});
