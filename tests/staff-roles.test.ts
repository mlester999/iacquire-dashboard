import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { grantableRoles, roleHasPermission, ORG_ROLES, type OrgRole } from "@/lib/permissions";
import { changeMemberRole, inviteMember } from "@/server/settings/service";
import {
  eligibleStaff,
  getMyStaffProfile,
  getOwnerProfile,
  listStaffProfiles,
  setAvailability,
  setEscalationAuthorization,
  setNotificationPreferences,
  setOwnerPriorityMode,
} from "@/server/staff/service";
import { addMember, createOrg, createUser, ctxFor, uid } from "./support/fixtures";

type Person = { id: string; email: string };
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
const people = {} as Record<OrgRole, Person>;
let outsider: Person;

beforeAll(async () => {
  org = await createOrg({ name: "Roles Co" });
  other = await createOrg({ name: "Elsewhere Co" });
  for (const role of ORG_ROLES) {
    people[role] = await createUser({ name: `${role} person` });
    await addMember(org.id, people[role].id, role);
  }
  outsider = await createUser();
  await addMember(other.id, outsider.id, "owner");
});

const as = (role: OrgRole) => ctxFor(people[role], org, role);

describe("client roles", () => {
  it("accepts every client role and rejects unknown ones at the database", async () => {
    const stranger = await createUser();
    await expect(withSystem((db) => db.query("insert into organization_memberships (org_id, user_id, role) values ($1, $2, 'superuser')", [org.id, stranger.id]))).rejects.toThrow();
    await expect(withSystem((db) => db.query("insert into organization_memberships (org_id, user_id, role) values ($1, $2, 'agency_staff')", [org.id, stranger.id]))).rejects.toThrow();
  });

  it("gives each role the right level of access to conversations and records", () => {
    const cases: Array<[OrgRole, Parameters<typeof roleHasPermission>[1], boolean]> = [
      ["viewer", "inbox.view", true],
      ["viewer", "inbox.reply", false],
      ["viewer", "contacts.edit", false],
      ["viewer", "agents.use", false],
      ["support", "inbox.reply", true],
      ["support", "escalations.respond", true],
      ["support", "inbox.assign", false],
      ["support", "agents.configure", false],
      ["sales_rep", "inbox.reply", true],
      ["sales_rep", "escalations.respond", true],
      ["sales_rep", "team.manage", false],
      ["sales_rep", "billing.view", false],
      ["member", "escalations.respond", false],
      ["admin", "inbox.assign", true],
      ["admin", "automation.go_autonomous", false],
      ["owner", "automation.go_autonomous", true],
    ];
    for (const [role, permission, expected] of cases) expect(roleHasPermission(role, permission), `${role} ${permission}`).toBe(expected);
  });

  it("agency roles never receive customer conversation permissions", () => {
    for (const permission of ["inbox.view", "inbox.reply", "inbox.view_all", "contacts.view", "escalations.respond"] as const) {
      expect(roleHasPermission("agency_staff", permission)).toBe(false);
      expect(roleHasPermission("agency_super_admin", permission)).toBe(false);
    }
  });

  it("limits who can grant which role", () => {
    expect(grantableRoles("owner")).toContain("owner");
    expect(grantableRoles("admin")).not.toContain("owner");
    expect(grantableRoles("admin")).toEqual(expect.arrayContaining(["sales_rep", "support", "viewer"]));
    for (const role of ["member", "sales_rep", "support", "viewer"] as OrgRole[]) expect(grantableRoles(role)).toEqual([]);
  });

  it("lets managers invite the new roles but never grant ownership", async () => {
    const invite = await inviteMember(as("admin"), `new-rep-${uid()}@example.test`, "sales_rep");
    expect(invite.id).toBeTruthy();
    await expect(inviteMember(as("admin"), `boss-${uid()}@example.test`, "owner")).rejects.toThrow(/can't grant/);
    await expect(inviteMember(as("support"), `x-${uid()}@example.test`, "viewer")).rejects.toThrow(/Only owners and admins/);
    await expect(inviteMember(as("viewer"), `x-${uid()}@example.test`, "viewer")).rejects.toThrow(/Only owners and admins/);
  });
});

describe("escalation authorization", () => {
  it("creates role-appropriate defaults and keeps viewers out", async () => {
    const team = await listStaffProfiles(as("owner"));
    const byRole = Object.fromEntries(team.map((p) => [p.role, p]));
    expect(byRole.owner.escalationCategories).toHaveLength(9);
    expect(byRole.support.escalationCategories).toEqual(expect.arrayContaining(["complaint", "refund_concern"]));
    expect(byRole.support.escalationCategories).not.toContain("ready_to_close");
    expect(byRole.sales_rep.escalationCategories).toContain("ready_to_close");
    expect(byRole.sales_rep.escalationCategories).not.toContain("complaint");
    expect(byRole.viewer.escalationCategories).toEqual([]);
  });

  it("only notifies people authorized for that kind of escalation", async () => {
    const complaint = await withSystem((db) => eligibleStaff(db, org.id, "complaint"));
    const roles = complaint.map((p) => p.role).sort();
    expect(roles).toEqual(["admin", "owner", "support"]);
    const closing = await withSystem((db) => eligibleStaff(db, org.id, "ready_to_close"));
    expect(closing.map((p) => p.role).sort()).toEqual(["admin", "owner", "sales_rep"]);
    // Nobody from another workspace appears.
    expect([...complaint, ...closing].some((p) => p.userId === outsider.id)).toBe(false);
  });

  it("excludes revoked members", async () => {
    const temp = await createUser();
    await addMember(org.id, temp.id, "support");
    expect((await withSystem((db) => eligibleStaff(db, org.id, "complaint"))).some((p) => p.userId === temp.id)).toBe(true);
    await withSystem((db) => db.query("update organization_memberships set status = 'revoked' where org_id = $1 and user_id = $2", [org.id, temp.id]));
    expect((await withSystem((db) => eligibleStaff(db, org.id, "complaint"))).some((p) => p.userId === temp.id)).toBe(false);
  });

  it("lets managers customize categories but refuses roles that cannot respond", async () => {
    await setEscalationAuthorization(as("admin"), people.member.id, { categories: [] });
    await expect(setEscalationAuthorization(as("admin"), people.viewer.id, { categories: ["complaint"] })).rejects.toThrow(/can't take escalations/);
    await expect(setEscalationAuthorization(as("admin"), people.support.id, { categories: ["not_a_category"] })).rejects.toThrow(/Unknown/);
    await expect(setEscalationAuthorization(as("sales_rep"), people.support.id, { categories: ["complaint"] })).rejects.toThrow(/Only owners and managers/);
    await expect(setEscalationAuthorization(as("admin"), outsider.id, { categories: ["complaint"] })).rejects.toThrow(/not on your team/);
    await setEscalationAuthorization(as("admin"), people.support.id, { categories: ["complaint"], responsibilities: ["support"] });
    const complaint = await withSystem((db) => eligibleStaff(db, org.id, "complaint"));
    expect(complaint.map((p) => p.role)).toContain("support");
    const refund = await withSystem((db) => eligibleStaff(db, org.id, "refund_concern"));
    expect(refund.map((p) => p.role)).not.toContain("support");
  });

  it("moves defaults when a role changes but keeps customized lists", async () => {
    const worker = await createUser();
    await addMember(org.id, worker.id, "member");
    await withSystem((db) => eligibleStaff(db, org.id, "complaint")); // creates profiles
    await changeMemberRole(as("owner"), worker.id, "sales_rep");
    const rep = (await listStaffProfiles(as("owner"))).find((p) => p.userId === worker.id)!;
    expect(rep.escalationCategories).toContain("ready_to_close");
    await setEscalationAuthorization(as("owner"), worker.id, { categories: ["phone_consultation"] });
    await changeMemberRole(as("owner"), worker.id, "support");
    const support = (await listStaffProfiles(as("owner"))).find((p) => p.userId === worker.id)!;
    expect(support.escalationCategories).toEqual(["phone_consultation"]);
    await changeMemberRole(as("owner"), worker.id, "viewer");
    const viewer = (await listStaffProfiles(as("owner"))).find((p) => p.userId === worker.id)!;
    expect(viewer.escalationCategories).toEqual([]);
  });
});

describe("availability and notification preferences", () => {
  it("treats expired Away or Busy as available again", async () => {
    await setAvailability(as("sales_rep"), { availability: "away", note: "At lunch", until: new Date(Date.now() + 3600_000) });
    expect((await getMyStaffProfile(as("sales_rep"))).availability).toBe("away");
    await withSystem((db) => db.query("update staff_profiles set availability_until = now() - interval '1 minute' where org_id = $1 and user_id = $2", [org.id, people.sales_rep.id]));
    expect((await getMyStaffProfile(as("sales_rep"))).availability).toBe("available");
    await expect(setAvailability(as("sales_rep"), { availability: "away", until: new Date(Date.now() - 1000) })).rejects.toThrow(/future/);
    await expect(setAvailability(as("viewer"), { availability: "away" })).rejects.toThrow(/doesn't take escalations/);
  });

  it("requires a phone number and a recorded cost acknowledgement for SMS or WhatsApp alerts", async () => {
    const ctx = as("support");
    await expect(setNotificationPreferences(ctx, { notifyEmail: true, notifySms: true, notifyWhatsapp: false })).rejects.toThrow(/mobile number/);
    await expect(setNotificationPreferences(ctx, { notifyEmail: true, notifySms: true, notifyWhatsapp: false, alertPhone: "0917 123 4567" })).rejects.toThrow(/country code/);
    await expect(setNotificationPreferences(ctx, { notifyEmail: true, notifySms: true, notifyWhatsapp: false, alertPhone: "+639171234567" })).rejects.toThrow(/billed as usage/);
    await setNotificationPreferences(ctx, { notifyEmail: true, notifySms: true, notifyWhatsapp: false, alertPhone: "+63 917 123 4567", acknowledgeCosts: true });
    const me = await getMyStaffProfile(ctx);
    expect(me).toMatchObject({ notifySms: true, notifyWhatsapp: false, notifyEmail: true });
    // The acknowledgement is remembered; switching a channel on later does not re-ask.
    await setNotificationPreferences(ctx, { notifyEmail: true, notifySms: true, notifyWhatsapp: true });
    // Turning everything optional off clears the opt-in so it must be given again.
    await setNotificationPreferences(ctx, { notifyEmail: true, notifySms: false, notifyWhatsapp: false });
    await expect(setNotificationPreferences(ctx, { notifyEmail: true, notifySms: true, notifyWhatsapp: false })).rejects.toThrow(/billed as usage/);
  });

  it("keeps alert phone numbers unreadable to the application role and to colleagues", async () => {
    await setNotificationPreferences(as("sales_rep"), { notifyEmail: true, notifySms: true, notifyWhatsapp: false, alertPhone: "+639181112222", acknowledgeCosts: true });
    await expect(withUser(people.owner.id, (db) => db.query("select alert_phone from staff_profiles where org_id = $1", [org.id]))).rejects.toThrow(/permission denied/);
    const visible = await withUser(people.owner.id, (db) => db.query("select user_id from staff_profiles where org_id = $1", [org.id]));
    expect(visible.rows.length).toBeGreaterThan(3);
  });

  it("does not let another workspace read this team's profiles", async () => {
    const rows = await withUser(outsider.id, (db) => db.query("select user_id from staff_profiles where org_id = $1", [org.id]));
    expect(rows.rows).toEqual([]);
    // A plain viewer cannot read colleagues' profiles beyond team visibility; own row is always readable.
    const own = await withUser(people.viewer.id, (db) => db.query("select user_id from staff_profiles where user_id = $1", [people.viewer.id]));
    expect(own.rows).toHaveLength(1);
  });

  it("only the owner can change how escalations reach them", async () => {
    await expect(setOwnerPriorityMode(as("admin"), "notify_only")).rejects.toThrow(/business owner/);
    await expect(setOwnerPriorityMode(as("owner"), "whenever")).rejects.toThrow(/valid/);
    await setOwnerPriorityMode(as("owner"), "urgent_only");
    expect((await withSystem((db) => getOwnerProfile(db, org.id)))?.ownerPriorityMode).toBe("urgent_only");
    await setOwnerPriorityMode(as("owner"), "first_priority");
  });
});
