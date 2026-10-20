import { withSystem } from "@/server/db";
import { addMember, agencyUser, createOrg, createUser, ctxFor } from "./fixtures";

/**
 * A small world for Support & Requests tests: one client workspace with people in several roles, a second client workspace, and an
 * agency with a Super Admin, a Manager and staff who are (and are not) assigned to the first client.
 */
export async function supportWorld() {
  const org = await createOrg({ name: "Support Co" });
  const otherOrg = await createOrg({ name: "Other Co" });
  const people = {
    owner: await createUser({ name: "Olivia Owner" }),
    admin: await createUser({ name: "Adam Admin" }),
    member: await createUser({ name: "Mia Member" }),
    member2: await createUser({ name: "Max Member" }),
    viewer: await createUser({ name: "Vera Viewer" }),
    outsider: await createUser({ name: "Otto Outsider" }),
  };
  await addMember(org.id, people.owner.id, "owner");
  await addMember(org.id, people.admin.id, "admin");
  await addMember(org.id, people.member.id, "member");
  await addMember(org.id, people.member2.id, "sales_rep");
  await addMember(org.id, people.viewer.id, "viewer");
  await addMember(otherOrg.id, people.outsider.id, "owner");

  const rawSuper = await createUser({ platformRole: "agency_super_admin", name: "Sam Superadmin" });
  const rawManager = await createUser({ platformRole: "agency_manager", name: "Maya Manager" });
  const rawStaff = await createUser({ platformRole: "agency_staff", name: "Stan Staff" });
  const rawStaff2 = await createUser({ platformRole: "agency_staff", name: "Sia Staff" });
  const rawOutStaff = await createUser({ platformRole: "agency_staff", name: "Olga Unassigned" });
  await withSystem(async (db) => {
    for (const s of [rawStaff, rawStaff2]) await db.query("insert into staff_assignments (org_id, user_id, assigned_by) values ($1, $2, $3)", [org.id, s.id, rawSuper.id]);
    // Out-of-scope staff belongs to the other client only.
    await db.query("insert into staff_assignments (org_id, user_id, assigned_by) values ($1, $2, $3)", [otherOrg.id, rawOutStaff.id, rawSuper.id]);
  });
  const agency = {
    superAdmin: agencyUser(rawSuper, "agency_super_admin"),
    manager: agencyUser(rawManager, "agency_manager"),
    staff: agencyUser(rawStaff, "agency_staff"),
    staff2: agencyUser(rawStaff2, "agency_staff"),
    outStaff: agencyUser(rawOutStaff, "agency_staff"),
  };
  const ctx = {
    owner: ctxFor(people.owner, org, "owner"),
    admin: ctxFor(people.admin, org, "admin"),
    member: ctxFor(people.member, org, "member"),
    member2: ctxFor(people.member2, org, "sales_rep"),
    viewer: ctxFor(people.viewer, org, "viewer"),
    outsider: ctxFor(people.outsider, otherOrg, "owner"),
  };
  return { org, otherOrg, people, agency, ctx, raw: { superAdmin: rawSuper, manager: rawManager, staff: rawStaff, staff2: rawStaff2, outStaff: rawOutStaff } };
}

export type SupportWorld = Awaited<ReturnType<typeof supportWorld>>;

export async function ticketRow(id: string) {
  return withSystem(async (db) => (await db.query<Record<string, unknown>>("select * from support_tickets where id = $1", [id])).rows[0]);
}

export async function countRows(sql: string, params: unknown[] = []) {
  return withSystem(async (db) => (await db.query<{ n: number }>(`select count(*)::int as n from (${sql}) x`, params)).rows[0].n);
}

/** Notifications in a person's list, optionally of one kind. */
export async function notificationsFor(userId: string, kind?: string) {
  return withSystem(async (db) => (await db.query<{ kind: string; title: string; body: string | null; link: string | null; dedupe_key: string | null }>(
    "select kind, title, body, link, dedupe_key from notifications where user_id = $1 and ($2::text is null or kind = $2) order by created_at", [userId, kind ?? null],
  )).rows);
}

/** The per-person rate limits are real, so tests that open many requests as one person clear them between tests. */
export async function resetRateLimits() {
  await withSystem((db) => db.query("delete from rate_limit_buckets"));
}
