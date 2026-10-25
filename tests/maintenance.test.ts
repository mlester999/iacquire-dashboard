import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { addMember, agencyUser, createOrg, createUser, ctxFor } from "./support/fixtures";
import { clearSetupPayment } from "./support/billing";
import {
  activateMaintenance, createMaintenanceRequest, getMaintenanceOverview, listAgencyMaintenance, nextRenewal, requestMaintenanceCancellation,
  requestMaintenanceEnrollment, resolveMaintenanceSubscription, updateMaintenanceRequest,
} from "@/server/maintenance/service";

let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
let owner: { id: string; email: string };
let admin: { id: string; email: string };
let member: { id: string; email: string };
let otherOwner: { id: string; email: string };
let staff: ReturnType<typeof agencyUser>;
let superAdmin: ReturnType<typeof agencyUser>;
const ctx = (u = owner, role: "owner" | "admin" | "member" = "owner") => ctxFor(u, org, role);

beforeAll(async () => {
  org = await createOrg({ name: "Maintenance Co" });
  other = await createOrg({ name: "Other Maintenance Co" });
  owner = await createUser();
  admin = await createUser();
  member = await createUser();
  otherOwner = await createUser();
  await addMember(org.id, owner.id, "owner");
  await addMember(org.id, admin.id, "admin");
  await addMember(org.id, member.id, "member");
  await addMember(other.id, otherOwner.id, "owner");
  const s = await createUser({ platformRole: "agency_staff" });
  staff = agencyUser(s, "agency_staff");
  superAdmin = agencyUser(await createUser({ platformRole: "agency_super_admin" }), "agency_super_admin");
  await withSystem((db) => db.query("insert into staff_assignments (org_id, user_id) values ($1, $2)", [org.id, s.id]));
});

describe("optional managed maintenance", () => {
  it("is not available, and never required, before the core system is activated", async () => {
    const o = await getMaintenanceOverview(ctx());
    expect(o.eligible).toBe(false);
    expect(o.eligibilityNote).toMatch(/don't need it/);
    expect(o.plan!.price).toMatchObject({ type: "monthly", minCents: 29900 });
    expect(o.subscription).toBeNull();
    await expect(requestMaintenanceEnrollment(ctx(), { acceptTerms: true })).rejects.toThrow(/activated/);
    // Defect corrections are available to everyone, with no plan.
    const defect = await createMaintenanceRequest(ctx(admin, "admin"), { kind: "core_defect", title: "Calendar sync broke", description: "The appointment setter stopped booking on Tuesday." });
    expect(defect.ref).toMatch(/^MNT-\d+$/);
    const ticket = await withSystem((db) => db.query<{ category: string; request_type: string }>("select category, request_type from support_tickets where id = $1", [defect.ticketId]));
    // A defect is an issue report, so the Issue reports view and the analytics find it.
    expect(ticket.rows[0]).toEqual({ category: "feature_not_working", request_type: "issue" });
    // Managed changes need an active plan.
    await expect(createMaintenanceRequest(ctx(), { kind: "managed_change", title: "Update the FAQ answers", description: "Please refresh the FAQ answers for the assistant." })).rejects.toThrow(/active maintenance plan/);
    await expect(createMaintenanceRequest(ctx(member, "member"), { kind: "core_defect", title: "Something odd", description: "It looks wrong on the overview page." })).rejects.toThrow(/can't open/);
  });

  it("requires an owner to opt in explicitly; nothing starts or bills automatically", async () => {
    await withSystem((db) => db.query("insert into client_setup_instances (org_id, state, activated_at) values ($1, 'activated', now())", [org.id]));
    // Activated but the setup fee is not confirmed: the second paid product waits for the first (tests/payment-gate.test.ts has the full matrix).
    expect((await getMaintenanceOverview(ctx())).eligible).toBe(false);
    await clearSetupPayment(org.id);
    expect((await getMaintenanceOverview(ctx())).eligible).toBe(true);
    await expect(requestMaintenanceEnrollment(ctx(admin, "admin"), { acceptTerms: true })).rejects.toThrow(/owner/);
    await expect(requestMaintenanceEnrollment(ctx(), { acceptTerms: false })).rejects.toThrow(/Confirm/);
    await requestMaintenanceEnrollment(ctx(), { acceptTerms: true, note: "Interested." });
    await expect(requestMaintenanceEnrollment(ctx(), { acceptTerms: true })).rejects.toThrow(/already have/);
    const o = await getMaintenanceOverview(ctx());
    expect(o.subscription!.status).toBe("requested");
    expect(o.subscription!.billingStartOn).toBeNull();
    expect(o.allowance).toBeNull();
    // Still not active: managed requests remain unavailable.
    await expect(createMaintenanceRequest(ctx(), { kind: "managed_change", title: "Update the FAQ answers", description: "Please refresh the FAQ answers for the assistant." })).rejects.toThrow(/active maintenance plan/);
  });

  it("only the agency activates a plan, which sets the billing start", async () => {
    const list = await listAgencyMaintenance(staff);
    const sub = list.subscriptions.find((s) => s.orgId === org.id)!;
    expect(sub.status).toBe("requested");
    expect(sub.eligible).toBe(true);
    const manager = agencyUser(await createUser({ platformRole: "agency_manager" }), "agency_manager");
    expect((await listAgencyMaintenance(manager)).subscriptions.some((s) => s.orgId === org.id)).toBe(true);
    const outsider = agencyUser(await createUser({ platformRole: "agency_staff" }), "agency_staff");
    const paidThroughOn = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    await expect(activateMaintenance(outsider, sub.id, { payment: { verified: true, paidThroughOn } })).rejects.toThrow(/not found/i);
    await activateMaintenance(staff, sub.id, { billingStartOn: "2026-11-01", payment: { verified: true, paidThroughOn } });
    const o = await getMaintenanceOverview(ctx());
    expect(o.subscription!.status).toBe("active");
    expect(o.subscription!.billingStartOn).toBe("2026-11-01");
    // The client's page shows the day the plan is paid through, although the client's own database role cannot read that column (0071 keeps it away on purpose).
    expect(o.subscription!.paidThroughOn).toBe(paidThroughOn);
    expect(o.subscription!.renewalOn).toBeTruthy();
    expect(o.allowance).toEqual(expect.objectContaining({ total: 4, used: 0, remaining: 4 }));
    // The verified payment is on the plan, with who recorded it, and in the audit trail.
    const row = await withSystem((db) => db.query<{ paid_through_on: string; last_payment_verified_by: string | null; last_payment_verified_at: Date | null }>(
      "select paid_through_on::text, last_payment_verified_by, last_payment_verified_at from maintenance_subscriptions where id = $1", [sub.id]));
    expect(row.rows[0]).toMatchObject({ paid_through_on: paidThroughOn, last_payment_verified_by: staff.id });
    expect(row.rows[0].last_payment_verified_at).not.toBeNull();
    const audit = await withSystem((db) => db.query<{ metadata: { paymentVerified?: boolean; paidThroughOn?: string } }>("select metadata from audit_logs where action = 'maintenance.activated' and target_id = $1", [sub.id]));
    expect(audit.rows[0].metadata).toMatchObject({ paymentVerified: true, paidThroughOn });
  });

  it("never starts a plan without a verified payment: not unconfirmed, not for a period that is over, not for years ahead", async () => {
    const other2 = await createOrg({ name: "No Payment Co" });
    const o2 = await createUser();
    await addMember(other2.id, o2.id, "owner");
    await withSystem((db) => db.query("insert into client_setup_instances (org_id, state, activated_at) values ($1, 'activated', now())", [other2.id]));
    await clearSetupPayment(other2.id);
    await withSystem((db) => db.query("insert into staff_assignments (org_id, user_id) values ($1, $2)", [other2.id, staff.id]));
    await requestMaintenanceEnrollment(ctxFor(o2, other2, "owner"), { acceptTerms: true });
    const sub = (await listAgencyMaintenance(staff)).subscriptions.find((s) => s.orgId === other2.id)!;
    const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    await expect(activateMaintenance(staff, sub.id, { payment: { verified: false, paidThroughOn: day(30) } })).rejects.toThrow(/verified the payment/);
    await expect(activateMaintenance(staff, sub.id, {} as never)).rejects.toThrow(/verified the payment/);
    await expect(activateMaintenance(staff, sub.id, { payment: { verified: true, paidThroughOn: "not a date" } })).rejects.toThrow(/valid date/);
    await expect(activateMaintenance(staff, sub.id, { payment: { verified: true, paidThroughOn: day(-10) } })).rejects.toThrow(/already ended/);
    await expect(activateMaintenance(staff, sub.id, { payment: { verified: true, paidThroughOn: day(900) } })).rejects.toThrow(/a year ahead/);
    // Nothing changed: it is still only requested, with no payment recorded.
    const row = await withSystem((db) => db.query<{ status: string; paid_through_on: string | null; last_payment_verified_at: Date | null }>("select status, paid_through_on::text, last_payment_verified_at from maintenance_subscriptions where id = $1", [sub.id]));
    expect(row.rows[0]).toEqual({ status: "requested", paid_through_on: null, last_payment_verified_at: null });
    expect((await getMaintenanceOverview(ctxFor(o2, other2, "owner"))).allowance).toBeNull();
  });

  it("enforces a defined monthly allowance; defects never count; staff can waive", async () => {
    for (let i = 1; i <= 4; i++) {
      await createMaintenanceRequest(ctx(), { kind: "managed_change", title: `Adjustment number ${i}`, description: `Please adjust a rule for item ${i} in the workflow.` });
    }
    await expect(createMaintenanceRequest(ctx(), { kind: "managed_change", title: "One request too many", description: "This should be refused for this calendar month." })).rejects.toThrow(/used all 4/);
    const defect = await createMaintenanceRequest(ctx(), { kind: "core_defect", title: "A real defect", description: "Appointments are booked an hour late since Monday." });
    expect((await getMaintenanceOverview(ctx())).allowance!.used).toBe(4);
    const rows = (await listAgencyMaintenance(staff)).requests.filter((r) => r.orgId === org.id);
    const core = rows.find((r) => r.id === defect.id)!;
    expect(core.countsAgainstAllowance).toBe(false);
    await expect(updateMaintenanceRequest(staff, core.id, { waiveAllowance: true })).rejects.toThrow(/managed requests/);
    // The database itself refuses to charge a core defect to the allowance.
    await expect(withSystem((db) => db.query("update maintenance_requests set counts_against_allowance = true where id = $1", [core.id]))).rejects.toThrow();
    const managed = rows.find((r) => r.kind === "managed_change")!;
    await updateMaintenanceRequest(staff, managed.id, { waiveAllowance: true, status: "completed", resolutionNote: "Done." });
    expect((await getMaintenanceOverview(ctx())).allowance!.used).toBe(3);
    await createMaintenanceRequest(ctx(), { kind: "managed_change", title: "Using the waived slot", description: "This uses the slot that was just freed up." });
  });

  it("keeps maintenance, projects and support separate and lands requests in the support inbox", async () => {
    const t = await withSystem((db) => db.query("select category from support_tickets where org_id = $1 and category = 'maintenance'", [org.id]));
    expect(t.rows.length).toBeGreaterThanOrEqual(4);
  });

  it("isolates tenants and keeps agency-only fields private", async () => {
    expect((await getMaintenanceOverview(ctxFor(otherOwner, other, "owner"))).requests).toEqual([]);
    expect((await withUser(otherOwner.id, (db) => db.query("select id from maintenance_requests"))).rows).toHaveLength(0);
    expect((await withUser(otherOwner.id, (db) => db.query("select id from maintenance_subscriptions"))).rows).toHaveLength(0);
    await expect(withUser(owner.id, (db) => db.query("select internal_notes from maintenance_subscriptions"))).rejects.toThrow(/permission denied/);
    await expect(withUser(owner.id, (db) => db.query("update maintenance_subscriptions set status = 'active'"))).rejects.toThrow(/permission denied/);
    await expect(withUser(owner.id, (db) => db.query("update maintenance_requests set counts_against_allowance = false"))).rejects.toThrow(/permission denied/);
  });

  it("cancellation is a request the agency confirms; a never-activated request is simply withdrawn", async () => {
    await expect(requestMaintenanceCancellation(ctx(admin, "admin"))).rejects.toThrow(/owner/);
    await requestMaintenanceCancellation(ctx(), "Moving in-house.");
    const sub = (await listAgencyMaintenance(superAdmin)).subscriptions.find((s) => s.orgId === org.id)!;
    expect(sub.status).toBe("cancel_requested");
    await resolveMaintenanceSubscription(superAdmin, sub.id, "confirm_cancellation");
    expect((await getMaintenanceOverview(ctx())).subscription!.status).toBe("cancelled");
    // They can enroll again later, and withdraw before activation.
    await requestMaintenanceEnrollment(ctx(), { acceptTerms: true });
    await requestMaintenanceCancellation(ctx());
    expect((await getMaintenanceOverview(ctx())).subscription!.status).toBe("cancelled");
  });

  it("computes the next renewal from the billing start", () => {
    expect(nextRenewal("2026-11-01", new Date("2026-11-15T00:00:00Z"))).toBe("2026-12-01");
    expect(nextRenewal("2026-11-01", new Date("2026-10-15T00:00:00Z"))).toBe("2026-12-01");
    expect(nextRenewal(null)).toBeNull();
  });
});
