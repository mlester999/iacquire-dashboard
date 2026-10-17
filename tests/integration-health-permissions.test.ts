import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { listIntegrationManager } from "@/server/integrations/manager";
import { agencyUser, createOrg, createUser } from "./support/fixtures";

describe("agency integration health scope", () => {
  it("allows managers to see only status metadata and blocks staff from global health", async () => {
    const managerAccount = await createUser({ platformRole: "agency_manager" });
    const manager = agencyUser(managerAccount, "agency_manager");
    const staff = agencyUser(await createUser({ platformRole: "agency_staff" }), "agency_staff");
    const secretMarker = `never-return-${crypto.randomUUID()}`;

    await withSystem(async (db) => {
      await db.query(
        `insert into integration_connections(org_id,provider,label,environment,config,status)
         values(null,'hermes','Private gateway label','production',$1::jsonb,'connected')`,
        [JSON.stringify({ accessToken: secretMarker, baseUrl: "https://private-gateway.example" })],
      );
      await db.query(
        "insert into integration_status(org_id,provider,status,detail,last_checked_at) values(null,'ghl','connected',$1,now())",
        [secretMarker],
      );
    });

    const view = await listIntegrationManager(manager, null);
    const hermes = view.connections.find((connection) => connection.provider === "hermes")!;
    expect(hermes).toMatchObject({
      id: null,
      label: "Hermes Agent",
      status: "connected",
      config: {},
      capabilities: {},
      lastError: null,
      fingerprint: null,
      rotatedAt: null,
      hasCredential: false,
      checks: [],
    });
    expect(view.hermesGateways).toEqual([]);
    expect(view.secureStoreReady).toBe(false);
    expect(JSON.stringify(view)).not.toContain(secretMarker);
    expect(JSON.stringify(view)).not.toContain("private-gateway.example");
    await expect(listIntegrationManager(staff, null)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("limits staff to health status for assigned clients and rejects another client's identifier", async () => {
    const admin = await createUser({ platformRole: "agency_super_admin" });
    const staffAccount = await createUser({ platformRole: "agency_staff" });
    const staff = agencyUser(staffAccount, "agency_staff");
    const assigned = await createOrg({ name: "Assigned integration health" });
    const other = await createOrg({ name: "Unassigned integration health" });
    const secretMarker = `client-secret-${crypto.randomUUID()}`;

    await withSystem(async (db) => {
      await db.query("insert into staff_assignments(org_id,user_id,assigned_by) values($1,$2,$3)", [assigned.id, staff.id, admin.id]);
      await db.query(
        `insert into integration_connections(org_id,provider,label,environment,config,status)
         values($1,'ghl','Private client label','production',$2::jsonb,'needs_attention')`,
        [assigned.id, JSON.stringify({ apiKey: secretMarker })],
      );
    });

    const view = await listIntegrationManager(staff, assigned.id);
    const ghl = view.connections.find((connection) => connection.provider === "ghl")!;
    expect(ghl).toMatchObject({ id: null, label: "GoHighLevel", status: "needs_attention", config: {}, hasCredential: false, lastError: null });
    expect(JSON.stringify(view)).not.toContain(secretMarker);
    await expect(listIntegrationManager(staff, other.id)).rejects.toMatchObject({ code: "not_found" });
  });
});
