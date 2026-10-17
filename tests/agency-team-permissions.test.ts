import { describe, expect, it } from "vitest";
import { applyInvitation, createInvitation } from "@/server/auth/service";
import { withSystem } from "@/server/db";
import { createOrg, createUser } from "./support/fixtures";

async function canAccess(userId: string, orgId: string) {
  return withSystem(async (db) => (await db.query<{ allowed: boolean }>(
    "select app.user_can_access_org($1,$2) as allowed",
    [userId, orgId],
  )).rows[0]?.allowed === true);
}

describe("agency manager and staff access", () => {
  it("gives managers all current and future clients while staff stay assigned-only", async () => {
    const owner = await createUser({ platformRole: "agency_super_admin" });
    const currentClient = await createOrg({ name: "Manager current client" });
    const futureClient = await createOrg({ name: "Manager future client" });
    const assignedClient = await createOrg({ name: "Staff assigned client" });
    const otherClient = await createOrg({ name: "Staff other client" });

    const managerInvite = await withSystem((db) => createInvitation({
      orgId: null,
      email: `manager-${crypto.randomUUID()}@example.test`,
      platformRole: "agency_manager",
      invitedBy: owner.id,
    }, db));
    expect(managerInvite.delivery).toBeNull();
    const manager = await createUser();
    await withSystem((db) => applyInvitation(db, managerInvite.id, manager.id));
    expect(await canAccess(manager.id, currentClient.id)).toBe(true);
    expect(await canAccess(manager.id, futureClient.id)).toBe(true);

    const staffInvite = await withSystem((db) => createInvitation({
      orgId: null,
      email: `staff-${crypto.randomUUID()}@example.test`,
      platformRole: "agency_staff",
      agencyScopeMode: "assigned_clients",
      initialClientIds: [assignedClient.id],
      invitedBy: owner.id,
    }, db));
    const staff = await createUser();
    await withSystem((db) => applyInvitation(db, staffInvite.id, staff.id));
    expect(await canAccess(staff.id, assignedClient.id)).toBe(true);
    expect(await canAccess(staff.id, otherClient.id)).toBe(false);

    await expect(withSystem((db) => applyInvitation(db, staffInvite.id, staff.id))).rejects.toThrow(/no longer valid/);
  });

  it("rejects invalid staff scopes and applies supported permission withdrawals immediately", async () => {
    const owner = await createUser({ platformRole: "agency_super_admin" });
    const manager = await createUser({ platformRole: "agency_manager" });
    const staff = await createUser({ platformRole: "agency_staff" });

    await expect(createInvitation({
      orgId: null,
      email: `invalid-${crypto.randomUUID()}@example.test`,
      platformRole: "agency_staff",
      agencyScopeMode: "all_clients",
      invitedBy: owner.id,
    })).rejects.toThrow(/assigned-client scope/);

    await expect(createInvitation({
      orgId: null,
      email: `owner-${crypto.randomUUID()}@example.test`,
      platformRole: "agency_super_admin",
      invitedBy: owner.id,
    })).rejects.toThrow(/cannot be granted through an invitation/);

    const before = await withSystem(async (db) => (await db.query<{ allowed: boolean }>(
      "select app.user_has_agency_permission($1,'agency.clients.create') as allowed",
      [manager.id],
    )).rows[0].allowed);
    expect(before).toBe(true);
    await withSystem((db) => db.query(
      `insert into agency_user_permission_overrides(user_id,permission,effect,reason,updated_by)
       values($1,'agency.clients.create','deny','Temporary restriction',$2)`,
      [manager.id, owner.id],
    ));
    const after = await withSystem(async (db) => (await db.query<{ allowed: boolean }>(
      "select app.user_has_agency_permission($1,'agency.clients.create') as allowed",
      [manager.id],
    )).rows[0].allowed);
    expect(after).toBe(false);

    await expect(withSystem((db) => db.query(
      `insert into agency_user_permission_overrides(user_id,permission,effect,updated_by)
       values($1,'agency.integrations.manage','allow',$2)`,
      [staff.id, owner.id],
    ))).rejects.toThrow();
  });
});
