import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { dispatchSupportNotice } from "@/server/support/notify";
import {
  listNotifications,
  markNotificationsRead,
  notifyAgency,
  notifyOrgRoles,
  notifyUser,
  unreadCount,
} from "@/server/notifications";
import { addMember, createOrg, createUser } from "./support/fixtures";

async function feed(userId: string, orgId: string | null = null) {
  return listNotifications(userId, { limit: 50, orgId });
}

async function titles(userId: string, orgId: string | null = null) {
  return (await feed(userId, orgId)).items.map((item) => item.title).sort();
}

async function notificationId(title: string, userId: string) {
  const { rows } = await withSystem((db) =>
    db.query<{ id: string; read_at: Date | null }>(
      "select id, read_at from notifications where title = $1 and user_id = $2 order by created_at desc limit 1",
      [title, userId],
    ),
  );
  return rows[0];
}

async function assign(userId: string, orgId: string) {
  await withSystem((db) => db.query("insert into staff_assignments (org_id, user_id) values ($1, $2)", [orgId, userId]));
}

async function unassign(userId: string, orgId: string) {
  await withSystem((db) => db.query("delete from staff_assignments where org_id = $1 and user_id = $2", [orgId, userId]));
}

describe("notification authorization after agency access changes", () => {
  it("hides one client's history after revocation without hiding another client or direct mail", async () => {
    const clientA = await createOrg({ name: "Notif Client A" });
    const clientB = await createOrg({ name: "Notif Client B" });
    const ownerA = await createUser();
    const superAdmin = await createUser({ platformRole: "agency_super_admin" });
    const manager = await createUser({ platformRole: "agency_manager" });
    const staff = await createUser({ platformRole: "agency_staff" });
    await addMember(clientA.id, ownerA.id, "owner");
    await assign(staff.id, clientA.id);
    await assign(staff.id, clientB.id);

    await withSystem(async (db) => {
      await notifyAgency(db, clientA.id, { kind: "system", title: "Client A agency alert" });
      await notifyAgency(db, clientB.id, { kind: "system", title: "Client B agency alert" });
      await notifyAgency(db, null, { kind: "system", title: "Agency-wide alert", link: "/admin/health" });
      await notifyUser(db, staff.id, clientA.id, { kind: "system", title: "Client A direct staff mail" });
      await notifyUser(db, staff.id, null, { kind: "system", title: "Internal direct mail" });
      await notifyUser(db, ownerA.id, clientA.id, { kind: "system", title: "Client A direct owner mail" });
      await notifyOrgRoles(db, clientA.id, ["owner"], { kind: "system", title: "Client A role mail" });
    });

    expect(await titles(staff.id)).toEqual([
      "Client A agency alert",
      "Client A direct staff mail",
      "Client B agency alert",
      "Internal direct mail",
    ]);
    expect(await titles(manager.id)).toEqual(["Client A agency alert", "Client B agency alert"]);
    expect(await titles(superAdmin.id)).toEqual(["Agency-wide alert", "Client A agency alert", "Client B agency alert"]);
    expect(await titles(ownerA.id, clientA.id)).toEqual(["Client A direct owner mail", "Client A role mail"]);

    const stored = await withSystem((db) =>
      db.query<{ audience: string; org_id: string | null }>(
        "select audience, org_id from notifications where title in ('Client A agency alert','Client A direct staff mail','Internal direct mail','Agency-wide alert') order by title",
      ),
    );
    expect(stored.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ audience: "agency", org_id: clientA.id }),
        expect.objectContaining({ audience: "direct", org_id: null }),
        expect.objectContaining({ audience: "agency", org_id: null }),
      ]),
    );

    const aAlert = await notificationId("Client A agency alert", staff.id);
    const bAlert = await notificationId("Client B agency alert", staff.id);
    expect(aAlert).toBeTruthy();
    expect(bAlert).toBeTruthy();

    // Revocation is a live authorization check, not a write-time snapshot.
    await unassign(staff.id, clientA.id);
    expect(await titles(staff.id)).toEqual(["Client B agency alert", "Internal direct mail"]);
    expect(await unreadCount(staff.id)).toBe((await feed(staff.id)).unread);

    const visible = await withUser(staff.id, (db) => db.query<{ title: string }>("select title from notifications order by title"));
    expect(visible.rows.map((row) => row.title).sort()).toEqual(["Client B agency alert", "Internal direct mail"]);

    const hidden = await withUser(staff.id, (db) => db.query("select title from notifications where id = $1", [aAlert.id]));
    expect(hidden.rows).toEqual([]);

    // The RLS update policy uses the same predicate, so even a direct update cannot mark it read.
    const hiddenUpdate = await withUser(staff.id, (db) =>
      db.query("update notifications set read_at = now() where id = $1 returning id", [aAlert.id]),
    );
    expect(hiddenUpdate.rows).toEqual([]);

    // A guessed id cannot mark the hidden row read through the app action either.
    await markNotificationsRead(staff.id, [aAlert.id]);
    expect((await notificationId("Client A agency alert", staff.id))?.read_at).toBeNull();

    // Removing access to A did not affect B.
    await markNotificationsRead(staff.id, "all");
    expect((await notificationId("Client B agency alert", staff.id))?.read_at).not.toBeNull();
    expect((await notificationId("Client A agency alert", staff.id))?.read_at).toBeNull();

    // Restoring access restores the same history; nothing was deleted.
    await assign(staff.id, clientA.id);
    expect(await titles(staff.id)).toContain("Client A agency alert");

    // The central predicate used by RLS, the feed, the count and email delivery agrees.
    const allowed = await withSystem((db) =>
      db.query<{ allowed: boolean }>("select app.notification_visible($1, 'agency', $2) as allowed", [staff.id, clientA.id]),
    );
    expect(allowed.rows[0]?.allowed).toBe(true);
    await unassign(staff.id, clientA.id);
    const denied = await withSystem((db) =>
      db.query<{ allowed: boolean }>("select app.notification_visible($1, 'agency', $2) as allowed", [staff.id, clientA.id]),
    );
    expect(denied.rows[0]?.allowed).toBe(false);

    // A client account loses its own client mail when membership is revoked.
    await withSystem((db) =>
      db.query("delete from organization_memberships where org_id = $1 and user_id = $2", [clientA.id, ownerA.id]),
    );
    expect(await titles(ownerA.id, clientA.id)).toEqual([]);

    // Agency-wide mail is governed by the permission that received it, not by being an agency account.
    await withSystem((db) => db.query("update users set platform_role = 'agency_manager' where id = $1", [superAdmin.id]));
    expect(await titles(superAdmin.id)).not.toContain("Agency-wide alert");
  });

  it("keeps manager all-client scope, assigned scope and role changes consistent across the inbox and count", async () => {
    const clientA = await createOrg({ name: "Scope Client A" });
    const clientB = await createOrg({ name: "Scope Client B" });
    const manager = await createUser({ platformRole: "agency_manager" });
    const staff = await createUser({ platformRole: "agency_staff" });
    const ownerA = await createUser();
    await addMember(clientA.id, ownerA.id, "owner");
    await assign(manager.id, clientA.id);
    await assign(staff.id, clientA.id);

    await withSystem(async (db) => {
      await notifyAgency(db, clientA.id, { kind: "system", title: "Scope A alert" });
      await notifyAgency(db, clientB.id, { kind: "system", title: "Scope B alert" });
      await notifyOrgRoles(db, clientA.id, ["owner"], { kind: "system", title: "Scope A client mail" });
    });

    expect(await titles(manager.id)).toEqual(["Scope A alert", "Scope B alert"]);
    expect(await unreadCount(manager.id)).toBe(2);

    // An agency manager can be narrowed to assigned clients; that must be live.
    await withSystem((db) =>
      db.query("insert into agency_user_client_scopes (user_id, scope_mode) values ($1, 'assigned_clients') on conflict (user_id) do update set scope_mode = excluded.scope_mode", [
        manager.id,
      ]),
    );
    expect(await titles(manager.id)).toEqual(["Scope A alert"]);
    await unassign(manager.id, clientA.id);
    expect(await titles(manager.id)).toEqual([]);

    // A role change moves the same account from the agency feed to the client feed.
    await withSystem((db) => db.query("update users set platform_role = 'none' where id = $1", [staff.id]));
    await addMember(clientA.id, staff.id, "owner");
    await withSystem((db) => notifyOrgRoles(db, clientA.id, ["owner"], { kind: "system", title: "Staff as client owner mail" }));
    expect(await titles(staff.id, clientA.id)).toEqual(["Staff as client owner mail"]);
    expect(await titles(staff.id)).toEqual(["Staff as client owner mail"]);

    await withSystem((db) => db.query("update users set platform_role = 'agency_staff' where id = $1", [staff.id]));
    expect(await titles(staff.id)).toEqual(["Scope A alert"]);
    expect(await unreadCount(staff.id)).toBe(1);
  });

  it("makes the dropdown and the full inbox use the same feed and count model", async () => {
    const clientA = await createOrg({ name: "Parity Client A" });
    const staff = await createUser({ platformRole: "agency_staff" });
    await assign(staff.id, clientA.id);
    await withSystem(async (db) => {
      for (let i = 0; i < 15; i += 1) {
        await notifyAgency(db, clientA.id, { kind: "system", title: `Parity alert ${String(i).padStart(2, "0")}` });
      }
    });

    const dropdown = await listNotifications(staff.id, { limit: 12 });
    const inbox = await listNotifications(staff.id, { limit: 50 });
    expect(dropdown.items).toHaveLength(12);
    expect(dropdown.items.map((item) => item.id)).toEqual(inbox.items.slice(0, 12).map((item) => item.id));
    expect(dropdown.unread).toBe(inbox.unread);
    expect(await unreadCount(staff.id)).toBe(inbox.unread);
  });

  it("records support notifications against the client organisation with agency audience", async () => {
    const client = await createOrg({ name: "Support Scope Client" });
    const owner = await createUser();
    const staff = await createUser({ platformRole: "agency_staff" });
    await addMember(client.id, owner.id, "owner");
    await assign(staff.id, client.id);
    const ticket = await withSystem(async (db) => {
      const { rows } = await db.query<{ id: string; ref: string }>(
        "insert into support_tickets (org_id, subject, created_by) values ($1, 'Scope ticket', $2) returning id, ref",
        [client.id, owner.id],
      );
      return rows[0];
    });

    await withSystem((db) =>
      dispatchSupportNotice(db, {
        event: "assigned",
        ticket: { id: ticket.id, org_id: client.id, ref: ticket.ref, subject: "Scope ticket" },
        eventKey: `scope:${crypto.randomUUID()}`,
        recipients: [{ userId: staff.id, audience: "agency" }],
        title: "Support ticket assigned",
      }),
    );

    const row = await withSystem((db) =>
      db.query<{ audience: string; org_id: string | null }>("select audience, org_id from notifications where title = 'Support ticket assigned'"),
    );
    expect(row.rows[0]).toEqual({ audience: "agency", org_id: client.id });

    await unassign(staff.id, client.id);
    expect(await titles(staff.id)).not.toContain("Support ticket assigned");
  });
});
