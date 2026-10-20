// A health check is a workforce write: it records a tool-inventory attestation, changes the employee's
// status and upserts integration health. It therefore requires `agency.workforce.manage` plus the existing
// assigned-client scope, while a Super Admin keeps access and internal system refreshes keep working.
// These tests cover the database permission/scope rules and the service boundary that every caller crosses.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { connectHermesProfile, createConfigVersion, runHealthCheck } from "@/server/workforce/service";
import { defaultSettings } from "@/server/workforce/compiler";
import { addMember, agentId, createOrg, createUser } from "./support/fixtures";
import { startMockHermes, type MockHermes } from "./support/mock-hermes";

const KEY = "h".repeat(40);

let mock: MockHermes;
let client: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
let superAdmin: { id: string };
let manager: { id: string };
let staff: { id: string };
let owner: { id: string };
let clientAgent: string;
let otherAgent: string;

async function connectAndConfigure(orgId: string, agent: string, profile: string) {
  await connectHermesProfile({ agentId: agent, baseUrl: mock.url, profile, apiKey: KEY, agencyUserId: superAdmin.id });
  await withSystem((db) => createConfigVersion(db, {
    orgId,
    agentId: agent,
    settings: defaultSettings("sales_assistant"),
    source: "agency",
    userId: superAdmin.id,
    apply: true,
  }));
}

async function permission(userId: string, orgId: string) {
  const { rows } = await withSystem((db) => db.query<{ manage: boolean | null; access: boolean }>(
    `select app.user_has_agency_permission($1,'agency.workforce.manage') as manage,
            app.user_can_access_org($1,$2) as access`,
    [userId, orgId],
  ));
  return { manage: rows[0]?.manage === true, access: rows[0]?.access === true };
}

async function employeeState(agent: string) {
  const { rows } = await withSystem((db) => db.query<{ status: string; tool_inventory_digest: string | null; last_health_check_at: Date | null }>(
    "select status, tool_inventory_digest, last_health_check_at from agent_instances where id = $1",
    [agent],
  ));
  return rows[0];
}

beforeAll(async () => {
  mock = await startMockHermes({
    "c-health-permissions-sales": { key: KEY },
    "c-health-permissions-other": { key: KEY },
  });
  client = await createOrg({ name: "Health permissions client" });
  other = await createOrg({ name: "Health permissions other client" });
  superAdmin = await createUser({ platformRole: "agency_super_admin" });
  manager = await createUser({ platformRole: "agency_manager" });
  staff = await createUser({ platformRole: "agency_staff" });
  owner = await createUser();
  await withSystem(async (db) => {
    await db.query("insert into staff_assignments(org_id,user_id,assigned_by) values($1,$2,$3)", [client.id, staff.id, superAdmin.id]);
    await db.query("insert into staff_assignments(org_id,user_id,assigned_by) values($1,$2,$3)", [client.id, manager.id, superAdmin.id]);
    // Restrict the manager to assigned clients so an out-of-scope health check can be exercised.
    await db.query("insert into agency_user_client_scopes(user_id,scope_mode,updated_by) values($1,'assigned_clients',$2)", [manager.id, superAdmin.id]);
  });
  await addMember(client.id, owner.id, "owner");
  clientAgent = await agentId(client.id, "sales_assistant");
  otherAgent = await agentId(other.id, "sales_assistant");
  await connectAndConfigure(client.id, clientAgent, "c-health-permissions-sales");
  await connectAndConfigure(other.id, otherAgent, "c-health-permissions-other");
}, 60000);

afterAll(() => mock.close());

describe("health-check permission matrix", () => {
  it("keeps management and client scope separate", async () => {
    expect(await permission(superAdmin.id, client.id)).toEqual({ manage: true, access: true });
    expect(await permission(superAdmin.id, other.id)).toEqual({ manage: true, access: true });
    expect(await permission(manager.id, client.id)).toEqual({ manage: true, access: true });
    expect(await permission(manager.id, other.id)).toEqual({ manage: true, access: false });
    expect(await permission(staff.id, client.id)).toEqual({ manage: false, access: true });
    expect(await permission(staff.id, other.id)).toEqual({ manage: false, access: false });
    expect(await permission(owner.id, client.id)).toEqual({ manage: false, access: true });
  });
});

describe("runHealthCheck authorization", () => {
  it("refuses agency staff who can view but not manage, before resolving credentials or contacting the gateway", async () => {
    const before = await employeeState(clientAgent);
    const requestCount = mock.requests.length;
    await expect(runHealthCheck(clientAgent, { userId: staff.id, kind: "agency" })).rejects.toMatchObject({ code: "forbidden" });
    expect(await employeeState(clientAgent)).toEqual(before);
    expect(mock.requests).toHaveLength(requestCount);
  });

  it("refuses a manager outside the client scope and a client user using the agency path", async () => {
    const before = await employeeState(otherAgent);
    await expect(runHealthCheck(otherAgent, { userId: manager.id, kind: "agency" })).rejects.toMatchObject({ code: "forbidden" });
    expect(await employeeState(otherAgent)).toEqual(before);

    await expect(runHealthCheck(clientAgent, { userId: owner.id, kind: "agency" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(runHealthCheck(clientAgent, { userId: owner.id, kind: "user" })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("allows a Super Admin to health-check a customer-owned employee", async () => {
    const result = await runHealthCheck(clientAgent, { userId: superAdmin.id, kind: "agency" });
    expect(result).toMatchObject({ ok: true, status: "online" });
    const state = await employeeState(clientAgent);
    expect(state.status).toBe("online");
    expect(state.tool_inventory_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(state.last_health_check_at).toBeTruthy();
  });

  it("allows an assigned manager and leaves internal system refreshes independent of agency permissions", async () => {
    expect(await runHealthCheck(clientAgent, { userId: manager.id, kind: "agency" })).toMatchObject({ ok: true, status: "online" });
    expect(await runHealthCheck(clientAgent, { userId: null, kind: "system" })).toMatchObject({ ok: true, status: "online" });
  });
});
