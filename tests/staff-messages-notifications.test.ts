import { describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { listNotifications, markNotificationsRead, notifyAgency, notifyStaff, notifyStaffBatch, notifyUser, unreadCount } from "@/server/notifications";
import { deliverNotificationEmails } from "@/server/ops/notification-email";
import { emailIncludesBody, shouldEmail } from "@/lib/ops";
import { addMember, createOrg, createUser } from "./support/fixtures";
import { agencyOrgId, disable, enable, rows, setRole, staffPerson } from "./support/staff-messages";

// The notification audience 'staff' (migration 0096): a notice for an active agency account and for nobody else, never in a client's feed, never emailed with its body.

const KINDS = ["staff_message_direct", "staff_message_mention", "staff_message_added", "staff_workload_alert", "staff_work_overdue"] as const;
const titles = async (userId: string) => (await listNotifications(userId, { limit: 100 })).items.map((i) => i.title).sort();

describe("notifyStaff", () => {
  it("writes a staff notice for the person, with no workspace, and drops a repeat of the same unread burst", async () => {
    const p = await staffPerson("agency_staff");
    const first = await withSystem((db) => notifyStaff(db, p.id, { kind: "staff_message_direct", title: "New direct message", body: "From Maya.", link: "/admin/messages/abc", dedupeKey: "staffmsg:abc:4" }));
    const again = await withSystem((db) => notifyStaff(db, p.id, { kind: "staff_message_direct", title: "New direct message", body: "From Maya.", dedupeKey: "staffmsg:abc:4" }));
    const later = await withSystem((db) => notifyStaff(db, p.id, { kind: "staff_message_direct", title: "New direct message", dedupeKey: "staffmsg:abc:9" }));
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(again).toBeNull();
    expect(later).not.toBeNull();
    const stored = await rows<{ audience: string; org_id: string | null; kind: string; link: string | null; severity: string }>("select audience, org_id, kind, link, severity from notifications where user_id = $1 order by created_at", [p.id]);
    expect(stored).toEqual([
      { audience: "staff", org_id: null, kind: "staff_message_direct", link: "/admin/messages/abc", severity: "info" },
      { audience: "staff", org_id: null, kind: "staff_message_direct", link: null, severity: "info" },
    ]);
  });

  it("accepts all five staff kinds and refuses a person who is not an agency account (the notice is not written for a client user)", async () => {
    const p = await staffPerson("agency_staff");
    for (const kind of KINDS) expect(await withSystem((db) => notifyStaff(db, p.id, { kind, title: kind })), kind).not.toBeNull();
    const client = await createUser();
    expect(await withSystem((db) => notifyStaff(db, client.id, { kind: "staff_message_direct", title: "Never for a client" }))).toBeNull();
    const none = await staffPerson("none");
    expect(await withSystem((db) => notifyStaff(db, none.id, { kind: "staff_message_direct", title: "Never for a person with no agency role" }))).toBeNull();
    expect(await rows("select 1 from notifications where user_id = any($1::uuid[])", [[client.id, none.id]])).toEqual([]);
    expect(await rows("select 1 from notifications where user_id = $1 and audience <> 'staff'", [p.id])).toEqual([]);
  });

  it("writes a batch in one statement and reports who got a notice", async () => {
    const [a, b, c] = [await staffPerson(), await staffPerson(), await staffPerson()];
    const sent = await withSystem((db) =>
      notifyStaffBatch(db, [
        { userId: a.id, kind: "staff_message_direct", title: "T1", dedupeKey: "k1" },
        { userId: b.id, kind: "staff_message_mention", title: "T2", dedupeKey: "k2" },
        { userId: c.id, kind: "staff_message_added", title: "T3" },
      ]),
    );
    expect(sent.sort()).toEqual([a.id, b.id, c.id].sort());
    const again = await withSystem((db) => notifyStaffBatch(db, [{ userId: a.id, kind: "staff_message_direct", title: "T1", dedupeKey: "k1" }, { userId: b.id, kind: "staff_message_mention", title: "T2 again", dedupeKey: "k3" }]));
    expect(again).toEqual([b.id]);
    expect(await withSystem((db) => notifyStaffBatch(db, []))).toEqual([]);
  });

  it("cuts a long title and body and drops a link that is not an internal path", async () => {
    const p = await staffPerson();
    await withSystem((db) => notifyStaff(db, p.id, { kind: "staff_message_direct", title: "t".repeat(500), body: "b".repeat(5000), link: "https://example.test/x" }));
    const [row] = await rows<{ title: string; body: string; link: string | null }>("select title, body, link from notifications where user_id = $1", [p.id]);
    expect(row.title).toHaveLength(200);
    expect(row.body).toHaveLength(1000);
    expect(row.link).toBeNull();
  });
});

describe("the agency feed", () => {
  it("lists a staff notice for an active agency person, counts it, and lets them mark it read, alongside their agency mail", async () => {
    const p = await staffPerson("agency_staff");
    await withSystem(async (db) => {
      await notifyStaff(db, p.id, { kind: "staff_message_direct", title: "A staff notice" });
      await notifyUser(db, p.id, null, { kind: "system", title: "Internal direct mail" });
      // Agency-wide mail goes to the holders of the security permission only; this person does not hold it.
      await notifyAgency(db, null, { kind: "system", title: "Agency-wide alert" });
    });
    expect(await titles(p.id)).toEqual(["A staff notice", "Internal direct mail"]);
    expect(await unreadCount(p.id)).toBe(2);
    const feed = await listNotifications(p.id, { limit: 10 });
    expect(feed.unread).toBe(2);
    const staff = feed.items.find((i) => i.title === "A staff notice");
    expect(staff?.kind).toBe("staff_message_direct");
    await markNotificationsRead(p.id, [staff?.id as string]);
    expect(await unreadCount(p.id)).toBe(1);
    await markNotificationsRead(p.id, "all");
    expect(await unreadCount(p.id)).toBe(0);
  });

  it("is reached through the database policy too: the person reads their own staff notices and no one else's", async () => {
    const [a, b] = [await staffPerson(), await staffPerson()];
    await withSystem(async (db) => {
      await notifyStaff(db, a.id, { kind: "staff_message_direct", title: "For A" });
      await notifyStaff(db, b.id, { kind: "staff_message_direct", title: "For B" });
    });
    const seen = await withUser(a.id, (db) => db.query<{ title: string }>("select title from notifications order by title"));
    expect(seen.rows.map((r) => r.title)).toEqual(["For A"]);
  });
});

describe("a person who is no longer an active agency account", () => {
  it("loses every staff notice at once: a demoted person's feed, count and mark-read never show them, and they are not deleted", async () => {
    const p = await staffPerson("agency_staff");
    const org = await createOrg();
    await withSystem((db) => notifyStaff(db, p.id, { kind: "staff_message_mention", title: "You were mentioned", body: "Maya mentioned you in #general." }));
    expect(await unreadCount(p.id)).toBe(1);
    // The same person becomes a client user of a workspace.
    await setRole(p.id, "none");
    await addMember(org.id, p.id, "owner");
    const feed = await listNotifications(p.id, { limit: 50, orgId: org.id });
    expect(feed.items.map((i) => i.title)).toEqual([]);
    expect(feed.unread).toBe(0);
    expect(await unreadCount(p.id)).toBe(0);
    await markNotificationsRead(p.id, "all", { orgId: org.id });
    expect(await withUser(p.id, (db) => db.query("select 1 from notifications"))).toMatchObject({ rows: [] });
    // Nothing was deleted or marked read: it is simply not theirs to see any more.
    expect(await rows<{ read_at: Date | null }>("select read_at from notifications where user_id = $1 and audience = 'staff'", [p.id])).toEqual([{ read_at: null }]);
    // Back on the team, they see it again.
    await setRole(p.id, "agency_staff");
    expect(await titles(p.id)).toEqual(["You were mentioned"]);
  });

  it("loses them when disabled", async () => {
    const p = await staffPerson("agency_manager");
    await withSystem((db) => notifyStaff(db, p.id, { kind: "staff_message_direct", title: "Hello" }));
    expect(await titles(p.id)).toEqual(["Hello"]);
    await disable(p.id);
    expect(await withUser(p.id, (db) => db.query("select 1 from notifications"))).toMatchObject({ rows: [] });
    await enable(p.id);
    expect(await titles(p.id)).toEqual(["Hello"]);
  });

  it("does not put a client user's feed anywhere near the staff audience", async () => {
    const org = await createOrg();
    const owner = await createUser();
    await addMember(org.id, owner.id, "owner");
    // Even a row forced into the table for a client user (a bug elsewhere) is invisible in the client feed: the client branch lists 'client' and 'direct' only.
    await withSystem((db) => db.query("insert into notifications (audience, org_id, user_id, kind, title) values ('staff', null, $1, 'staff_message_direct', 'Forced')", [owner.id]));
    await withSystem((db) => notifyUser(db, owner.id, org.id, { kind: "system", title: "Client mail" }));
    expect((await listNotifications(owner.id, { limit: 50, orgId: org.id })).items.map((i) => i.title)).toEqual(["Client mail"]);
    expect(await unreadCount(owner.id)).toBe(1);
    await markNotificationsRead(owner.id, "all", { orgId: org.id });
    expect(await rows<{ read_at: Date | null }>("select read_at from notifications where user_id = $1 and audience = 'staff'", [owner.id])).toEqual([{ read_at: null }]);
  });
});

describe("email", () => {
  it("never carries a staff notice's body, and does not send one at all unless the person asked for everything", () => {
    for (const kind of KINDS) {
      expect(emailIncludesBody(kind), kind).toBe(false);
      expect(shouldEmail(kind, "info", "important"), kind).toBe(false);
      expect(shouldEmail(kind, "warning", "important"), `${kind} as a warning`).toBe(false);
      expect(shouldEmail(kind, "info", "off"), kind).toBe(false);
    }
  });

  it("is skipped by the email job, with a reason recorded, and nothing is queued for the person", async () => {
    const p = await staffPerson("agency_staff");
    const id = await withSystem((db) => notifyStaff(db, p.id, { kind: "staff_message_direct", title: "New direct message", body: "From Maya." }));
    const before = await rows<{ n: string }>("select count(*)::text as n from email_outbox where to_email = $1", [p.email]);
    await deliverNotificationEmails({ limit: 200 });
    const delivery = await rows<{ status: string; skip_reason: string | null }>("select status, skip_reason from notification_deliveries where notification_id = $1", [id]);
    expect(delivery).toEqual([{ status: "skipped", skip_reason: expect.stringContaining("Not an email-worthy") }]);
    const after = await rows<{ n: string }>("select count(*)::text as n from email_outbox where to_email = $1", [p.email]);
    expect(after[0].n).toBe(before[0].n);
  });
});

describe("the agency workspace", () => {
  it("is the one workspace a staff notice may be tied to, and none is", async () => {
    const org = await agencyOrgId();
    expect(org).toMatch(/^[0-9a-f-]{36}$/);
    const p = await staffPerson();
    await withSystem((db) => notifyStaff(db, p.id, { kind: "staff_message_direct", title: "Hello" }));
    expect(await rows("select 1 from notifications where user_id = $1 and org_id is not null", [p.id])).toEqual([]);
  });
});
