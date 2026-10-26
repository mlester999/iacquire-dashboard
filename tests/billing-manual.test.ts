// iAcquire's own money, recorded by a Super Admin: a payment received outside a provider, a waiver of the setup fee, a refund. Embedded Postgres; no provider is called.
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { recordManualPayment, recordRefundAction, waiveSetupFee } from "@/server/billing/manual";
import { getFinancialReport } from "@/server/billing/finance";
import { getAgencyBillingOverview } from "@/server/billing/service";
import { updateBilling } from "@/server/admin/tenants";
import { requestProvisioning } from "@/server/workforce/provisioning";
import { resolvePeriod } from "@/lib/finance";
import { addMember, agencyUser, createUser, uid } from "./support/fixtures";
import { clearSetupPayment, markActivated, onboardedClient, provisioningJobs, setupStatus } from "./support/billing";

const today = () => new Date().toISOString().slice(0, 10);
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const ref = () => `BANK-${uid()}`;
const setupPayment = (over: Record<string, string> = {}) => ({ kind: "setup_fee", amount: "1499.00", method: "bank_transfer", externalReference: ref(), paidOn: today(), note: "Seen on the bank statement for today", ...over });

let superAdmin: ReturnType<typeof agencyUser>;
let manager: ReturnType<typeof agencyUser>;
let staff: ReturnType<typeof agencyUser>;

const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;
const payments = (orgId: string) => rows<{ id: string; provider: string; kind: string; status: string; usd_amount_micros: string; charged_currency: string; external_reference: string | null; verified_by: string | null; refunded_micros: string; paid_at: Date }>(
  "select id, provider, kind, status, usd_amount_micros::text, charged_currency, external_reference, verified_by, refunded_micros::text, paid_at from payments where org_id = $1 order by created_at", [orgId]);
const notice = (userId: string, kind: string) => rows<{ title: string }>("select title from notifications where user_id = $1 and kind = $2", [userId, kind]);

beforeAll(async () => {
  superAdmin = agencyUser(await createUser({ platformRole: "agency_super_admin" }), "agency_super_admin");
  manager = agencyUser(await createUser({ platformRole: "agency_manager" }), "agency_manager");
  staff = agencyUser(await createUser({ platformRole: "agency_staff" }), "agency_staff");
});

async function assigned(orgId: string) {
  for (const u of [staff, manager]) await withSystem((db) => db.query("insert into staff_assignments (org_id, user_id) values ($1, $2) on conflict do nothing", [orgId, u.id]));
}

describe("only a Super Admin records money", () => {
  it("refuses staff, managers and client users, and writes nothing", async () => {
    const { org, owner } = await onboardedClient();
    await assigned(org.id);
    const before = (await payments(org.id)).length;
    for (const who of [staff, manager, agencyUser(owner, "agency_staff")]) {
      await expect(recordManualPayment(who, org.id, setupPayment())).rejects.toThrow(/Only a Super Admin/);
      await expect(waiveSetupFee(who, org.id, { reason: "Agreed with the founder in writing" })).rejects.toThrow(/Only a Super Admin/);
    }
    expect((await payments(org.id)).length).toBe(before);
    expect((await setupStatus(org.id)).setup_payment_status).toBe("not_invoiced");
    expect(await provisioningJobs(org.id)).toBe(0);
    // A refund is refused the same way, for a payment that exists.
    await recordManualPayment(superAdmin, org.id, setupPayment());
    const [p] = await payments(org.id);
    await expect(recordRefundAction(manager, p.id, { amount: "10.00", reason: "A manager must not do this" })).rejects.toThrow(/Only a Super Admin/);
    expect((await payments(org.id))[0].refunded_micros).toBe("0");
  });

  it("refuses an agency workspace and an unknown client", async () => {
    const unknown = "11111111-1111-4111-8111-111111111111";
    await expect(recordManualPayment(superAdmin, unknown, setupPayment())).rejects.toThrow(/not found|Only a Super Admin/i);
    await expect(waiveSetupFee(superAdmin, unknown, { reason: "Agreed with the founder in writing" })).rejects.toThrow(/not found|Only a Super Admin/i);
    // The agency's own workspace has no setup fee to pay.
    const agency = (await rows<{ id: string }>("select id from organizations where kind = 'agency' limit 1"))[0];
    if (agency) await expect(recordManualPayment(superAdmin, agency.id, setupPayment())).rejects.toThrow(/not found/i);
  });
});

describe("a setup fee recorded by hand", () => {
  it("writes the payment, clears the fee against it, opens one provisioning request per enabled employee and tells the owner", async () => {
    const { org, owner } = await onboardedClient();
    await withSystem((db) => db.query("update agent_instances set enabled = false where org_id = $1 and role_key = 'lead_hunter'", [org.id]));
    expect(await provisioningJobs(org.id)).toBe(0);
    const reference = ref();
    const out = await recordManualPayment(superAdmin, org.id, setupPayment({ externalReference: reference, method: "paypal" }));
    expect(out).toMatchObject({ duplicate: false, clearedSetup: true, provisioningRequested: 5 });
    expect(out.referenceNumber).toMatch(/^IAQ-[A-Z0-9]{12}$/);
    const [p] = await payments(org.id);
    expect(p).toMatchObject({ provider: "manual", kind: "setup_fee", status: "paid", usd_amount_micros: "1499000000", charged_currency: "USD", external_reference: reference, verified_by: superAdmin.id });
    expect(await setupStatus(org.id)).toMatchObject({ setup_payment_status: "paid", verified_payment_id: p.id, waiver_reason: null });
    expect(await provisioningJobs(org.id)).toBe(5);
    expect((await notice(owner.id, "billing_setup_cleared"))).toHaveLength(1);
    // The audit trail says who recorded what, but keeps the bank reference on the payment row only.
    const audit = await rows<{ actor_user_id: string; metadata: Record<string, unknown> }>("select actor_user_id, metadata from audit_logs where org_id = $1 and action = 'billing.manual_payment_recorded'", [org.id]);
    expect(audit).toHaveLength(1);
    expect(audit[0].actor_user_id).toBe(superAdmin.id);
    expect(audit[0].metadata).toMatchObject({ kind: "setup_fee", amountCents: 149900, method: "paypal", clearedSetup: true });
    expect(JSON.stringify(audit[0].metadata)).not.toContain(reference);
    // Dated by the day it arrived, never in the future.
    expect(new Date(p.paid_at).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("does not provision when onboarding is unfinished: the payment clears the fee and the request waits for the rest", async () => {
    const { org } = await onboardedClient();
    await withSystem((db) => db.query("update organizations set onboarding_completed_at = null where id = $1", [org.id]));
    const out = await recordManualPayment(superAdmin, org.id, setupPayment());
    expect(out).toMatchObject({ clearedSetup: true, provisioningRequested: 0 });
    expect(await provisioningJobs(org.id)).toBe(0);
    await withSystem((db) => db.query("update organizations set onboarding_completed_at = now() where id = $1", [org.id]));
    expect(await withSystem((db) => requestProvisioning(db, org.id, null))).toBe(6);
  });

  it("refuses an amount that is not the agreed fee, a second setup payment, and a fee that was waived", async () => {
    const { org } = await onboardedClient();
    await expect(recordManualPayment(superAdmin, org.id, setupPayment({ amount: "1000.00" }))).rejects.toThrow(/must equal the agreed fee/);
    expect(await payments(org.id)).toHaveLength(0);
    await recordManualPayment(superAdmin, org.id, setupPayment());
    await expect(recordManualPayment(superAdmin, org.id, setupPayment())).rejects.toThrow(/already paid/);
    const waived = await onboardedClient();
    await waiveSetupFee(superAdmin, waived.org.id, { reason: "Founding client, agreed in writing" });
    await expect(recordManualPayment(superAdmin, waived.org.id, setupPayment())).rejects.toThrow(/waived/);
    expect(await payments(waived.org.id)).toHaveLength(0);
  });

  it("the same reference is the same payment: recording it again changes nothing, whatever its case", async () => {
    const { org } = await onboardedClient();
    const reference = ref();
    const first = await recordManualPayment(superAdmin, org.id, setupPayment({ externalReference: reference }));
    const again = await recordManualPayment(superAdmin, org.id, setupPayment({ externalReference: reference.toLowerCase() }));
    expect(again).toMatchObject({ duplicate: true, paymentId: first.paymentId, referenceNumber: first.referenceNumber, clearedSetup: false, provisioningRequested: 0 });
    expect(await payments(org.id)).toHaveLength(1);
    expect(await provisioningJobs(org.id)).toBe(6);
    expect(await rows("select 1 from audit_logs where org_id = $1 and action = 'billing.manual_payment_recorded'", [org.id])).toHaveLength(1);
  });

  it("refuses the same reference for a different workspace, kind or amount", async () => {
    const a = await onboardedClient();
    const b = await onboardedClient();
    const reference = ref();
    await recordManualPayment(superAdmin, a.org.id, setupPayment({ externalReference: reference }));
    await expect(recordManualPayment(superAdmin, b.org.id, setupPayment({ externalReference: reference }))).rejects.toThrow(/already recorded for a different payment/);
    await expect(recordManualPayment(superAdmin, a.org.id, setupPayment({ kind: "domain", amount: "12.00", externalReference: reference }))).rejects.toThrow(/different payment/);
    expect(await payments(b.org.id)).toHaveLength(0);
    expect((await setupStatus(b.org.id)).setup_payment_status).toBe("not_invoiced");
  });

  it("two recordings at the same moment make one payment and one set of requests", async () => {
    const { org } = await onboardedClient();
    const reference = ref();
    const results = await Promise.allSettled([
      recordManualPayment(superAdmin, org.id, setupPayment({ externalReference: reference })),
      recordManualPayment(superAdmin, org.id, setupPayment({ externalReference: reference })),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect((await payments(org.id))).toHaveLength(1);
    expect(await provisioningJobs(org.id)).toBe(6);
    expect(results.filter((r) => r.status === "fulfilled" && r.value.duplicate)).toHaveLength(1);
  });

  it("the finance report and the overview count the money the moment it is recorded", async () => {
    const { org } = await onboardedClient();
    const period = resolvePeriod("this_month");
    const before = await getFinancialReport(superAdmin, period);
    const overviewBefore = await getAgencyBillingOverview(superAdmin);
    await recordManualPayment(superAdmin, org.id, setupPayment());
    const after = await getFinancialReport(superAdmin, period);
    const overviewAfter = await getAgencyBillingOverview(superAdmin);
    expect(after.received.setupMicros - before.received.setupMicros).toBe(1_499_000_000);
    expect(overviewAfter.totals.setupPaidCount - overviewBefore.totals.setupPaidCount).toBe(1);
    expect(overviewAfter.totals.setupRevenueMicros - overviewBefore.totals.setupRevenueMicros).toBe(1_499_000_000);
  });

  it("another kind of payment is recorded as money received and changes no status", async () => {
    const { org, owner } = await onboardedClient();
    const out = await recordManualPayment(superAdmin, org.id, setupPayment({ kind: "domain", amount: "18.50", externalReference: ref() }));
    expect(out).toMatchObject({ clearedSetup: false, provisioningRequested: 0, duplicate: false });
    expect((await payments(org.id))[0]).toMatchObject({ kind: "domain", status: "paid", usd_amount_micros: "18500000" });
    expect((await setupStatus(org.id)).setup_payment_status).toBe("not_invoiced");
    expect(await notice(owner.id, "billing_payment_received")).toHaveLength(1);
    expect(await provisioningJobs(org.id)).toBe(0);
  });
});

describe("a maintenance payment recorded by hand goes through the plan's own transition", () => {
  async function planOrg(status: "requested" | "past_due" | "expired", opts: { cleared?: boolean; activated?: boolean } = {}) {
    const { org, owner } = await onboardedClient();
    if (opts.cleared !== false) await clearSetupPayment(org.id);
    if (opts.activated !== false) await markActivated(org.id);
    const lapsed = status !== "requested";
    await withSystem((db) => db.query(
      `insert into maintenance_subscriptions (org_id, status, monthly_price_cents, monthly_request_allowance, terms_version, accepted_by, activated_by, activated_at, billing_start_on, past_due_since, grace_ends_at, expired_at)
       values ($1, $2, 29900, 4, 'test-terms', $3, $4, $5, $6, $7, $8, $9)`,
      [org.id, status, owner.id, lapsed ? superAdmin.id : null, lapsed ? new Date().toISOString() : null, lapsed ? inDays(-60) : null,
        status === "past_due" ? new Date(Date.now() - 86_400_000).toISOString() : null, status === "past_due" ? new Date(Date.now() + 5 * 86_400_000).toISOString() : null, status === "expired" ? new Date().toISOString() : null],
    ));
    return { org, owner };
  }
  const plan = (orgId: string) => rows<{ status: string; paid_through_on: string | null; last_payment_id: string | null; last_payment_verified_by: string | null }>(
    "select status, to_char(paid_through_on, 'YYYY-MM-DD') as paid_through_on, last_payment_id, last_payment_verified_by from maintenance_subscriptions where org_id = $1", [orgId]);

  it("activates a requested plan, ties the period to the payment, and tells the owner", async () => {
    const { org, owner } = await planOrg("requested");
    const through = inDays(30);
    const out = await recordManualPayment(superAdmin, org.id, setupPayment({ kind: "maintenance", amount: "299.00", paidThroughOn: through, externalReference: ref() }));
    expect((await plan(org.id))[0]).toMatchObject({ status: "active", paid_through_on: through, last_payment_id: out.paymentId, last_payment_verified_by: superAdmin.id });
    expect((await notice(owner.id, "maintenance_update"))[0].title).toMatch(/Managed maintenance is active/);
    const audit = await rows<{ metadata: { paymentId?: string; paymentVerified?: boolean } }>("select metadata from audit_logs where org_id = $1 and action = 'maintenance.activated'", [org.id]);
    expect(audit[0].metadata).toMatchObject({ paymentVerified: true, paymentId: out.paymentId });
    expect((await payments(org.id))[0]).toMatchObject({ kind: "maintenance", provider: "manual" });
  });

  it("brings a past-due plan back to active with the new payment", async () => {
    const { org } = await planOrg("past_due");
    const out = await recordManualPayment(superAdmin, org.id, setupPayment({ kind: "maintenance", amount: "299.00", paidThroughOn: inDays(30), externalReference: ref() }));
    expect((await plan(org.id))[0]).toMatchObject({ status: "active", last_payment_id: out.paymentId });
  });

  it("refuses with no plan, and leaves no payment row behind", async () => {
    const { org } = await onboardedClient();
    await clearSetupPayment(org.id);
    await expect(recordManualPayment(superAdmin, org.id, setupPayment({ kind: "maintenance", amount: "299.00", paidThroughOn: inDays(30) }))).rejects.toThrow(/no maintenance plan/);
    expect(await payments(org.id)).toHaveLength(0);
  });

  it("refuses to start a plan while the setup fee is unconfirmed or the core system is not activated, and rolls the payment back with the refusal", async () => {
    const unpaid = await planOrg("requested", { cleared: false });
    await expect(recordManualPayment(superAdmin, unpaid.org.id, setupPayment({ kind: "maintenance", amount: "299.00", paidThroughOn: inDays(30) }))).rejects.toThrow(/setup payment isn't confirmed/);
    expect(await payments(unpaid.org.id)).toHaveLength(0);
    expect((await plan(unpaid.org.id))[0]).toMatchObject({ status: "requested", last_payment_id: null });
    const notActivated = await planOrg("requested", { activated: false });
    await expect(recordManualPayment(superAdmin, notActivated.org.id, setupPayment({ kind: "maintenance", amount: "299.00", paidThroughOn: inDays(30) }))).rejects.toThrow(/isn't activated/);
    expect(await payments(notActivated.org.id)).toHaveLength(0);
  });

  it("needs the period the payment covers", async () => {
    const { org } = await planOrg("requested");
    await expect(recordManualPayment(superAdmin, org.id, setupPayment({ kind: "maintenance", amount: "299.00" }))).rejects.toThrow(/period the payment covers/);
    expect(await payments(org.id)).toHaveLength(0);
  });
});

describe("the database holds the line the service draws", () => {
  const sql = (text: string, params: unknown[] = []) => withSystem((db) => db.query(text, params));

  it("a payment by hand without its evidence, and a payment whose evidence is edited, are refused", async () => {
    const { org } = await onboardedClient();
    const base = [org.id, "IAQ-DB" + uid().toUpperCase(), superAdmin.id];
    await expect(sql(`insert into payments (org_id, kind, description, usd_amount_micros, charged_currency, charged_amount_minor, livemode, provider, reference_number, status, paid_at, verified_by)
      values ($1, 'domain', 'No evidence', 1000000, 'USD', 100, true, 'manual', $2, 'paid', now(), $3)`, base)).rejects.toThrow(/payments_manual_evidence_check|violates check/);
    const out = await recordManualPayment(superAdmin, org.id, setupPayment({ kind: "domain", amount: "10.00" }));
    await expect(sql("update payments set external_reference = 'CHANGED-REF' where id = $1", [out.paymentId])).rejects.toThrow(/cannot be edited/);
    await expect(sql("update payments set usd_amount_micros = 1 where id = $1", [out.paymentId])).rejects.toThrow(/cannot be edited/);
    await expect(sql("update payments set provider = 'paymongo' where id = $1", [out.paymentId])).rejects.toThrow(/never changes|violates check/);
    // A refund is the one thing that may change afterwards.
    await sql("update payments set refunded_micros = 1000000, status = 'refunded' where id = $1", [out.paymentId]);
  });

  it("a provider payment carries no manual evidence", async () => {
    const { org } = await onboardedClient();
    await expect(sql(`insert into payments (org_id, kind, description, usd_amount_micros, charged_currency, charged_amount_minor, livemode, provider, reference_number, external_reference)
      values ($1, 'domain', 'Not manual', 1000000, 'PHP', 5800, false, 'paymongo', $2, 'SNEAKY-REF')`, [org.id, "IAQ-DB" + uid().toUpperCase()])).rejects.toThrow(/violates check/);
  });

  it("a status cannot be typed in: paid needs a verified setup payment of this workspace, waived needs a reason", async () => {
    const { org } = await onboardedClient();
    const other = await onboardedClient();
    await expect(sql("update billing_accounts set setup_payment_status = 'paid' where org_id = $1", [org.id])).rejects.toThrow(/only against a verified setup payment/);
    await expect(sql("update billing_accounts set setup_payment_status = 'waived' where org_id = $1", [org.id])).rejects.toThrow(/billing_accounts_waiver_check|violates check/);
    await expect(sql("update billing_accounts set setup_payment_status = 'waived', waiver_reason = 'abc' where org_id = $1", [org.id])).rejects.toThrow(/violates check/);
    // A domain payment, or another workspace's setup payment, is not a verified setup payment of this one.
    const domain = await recordManualPayment(superAdmin, org.id, setupPayment({ kind: "domain", amount: "10.00" }));
    await expect(sql("update billing_accounts set setup_payment_status = 'paid', verified_payment_id = $2 where org_id = $1", [org.id, domain.paymentId])).rejects.toThrow(/only against a verified setup payment/);
    const theirs = await recordManualPayment(superAdmin, other.org.id, setupPayment());
    await expect(sql("update billing_accounts set setup_payment_status = 'paid', verified_payment_id = $2 where org_id = $1", [org.id, theirs.paymentId])).rejects.toThrow(/billing_accounts_verified_payment_fk|foreign key|only against/);
    expect((await setupStatus(org.id)).setup_payment_status).toBe("not_invoiced");
  });

  it("one setup checkout can be open at a time", async () => {
    const { org } = await onboardedClient();
    const insert = (reference: string) => sql(`insert into payments (org_id, kind, description, usd_amount_micros, charged_currency, charged_amount_minor, livemode, provider, reference_number)
      values ($1, 'setup_fee', 'Setup', 1499000000, 'PHP', 8694200, false, 'paymongo', $2)`, [org.id, reference]);
    await insert("IAQ-OPEN" + uid().toUpperCase());
    await expect(insert("IAQ-OPEN" + uid().toUpperCase())).rejects.toThrow(/payments_one_open_setup_idx|duplicate key/);
  });
});

describe("waiving the setup fee", () => {
  it("records who, when and why, clears the gate, opens the requests and keeps the reason from the client", async () => {
    const { org, owner } = await onboardedClient();
    await expect(waiveSetupFee(superAdmin, org.id, { reason: "short" })).rejects.toThrow(/at least 10/);
    await expect(waiveSetupFee(superAdmin, org.id, { reason: "" })).rejects.toThrow(/Say why/);
    expect((await setupStatus(org.id)).setup_payment_status).toBe("not_invoiced");
    const out = await waiveSetupFee(superAdmin, org.id, { reason: "Founding client, agreed by the founder in writing" });
    expect(out).toEqual({ changed: true, provisioningRequested: 6 });
    expect(await setupStatus(org.id)).toMatchObject({ setup_payment_status: "waived", waiver_reason: "Founding client, agreed by the founder in writing", waived_by: superAdmin.id, verified_payment_id: null });
    expect(await provisioningJobs(org.id)).toBe(6);
    expect(await notice(owner.id, "billing_setup_cleared")).toMatchObject([{ title: "Your setup fee has been waived" }]);
    const audit = await rows<{ metadata: { reason: string; previous: string } }>("select metadata from audit_logs where org_id = $1 and action = 'billing.setup_waived'", [org.id]);
    expect(audit[0].metadata).toMatchObject({ reason: "Founding client, agreed by the founder in writing", previous: "not_invoiced" });
    // The client sees that the fee is cleared, never why or by whom.
    expect(await withUser(owner.id, async (db) => (await db.query<{ setup_payment_status: string }>("select setup_payment_status from billing_accounts")).rows)).toEqual([{ setup_payment_status: "waived" }]);
    await expect(withUser(owner.id, (db) => db.query("select waiver_reason from billing_accounts"))).rejects.toThrow(/permission denied/);
    await expect(withUser(owner.id, (db) => db.query("select waived_by from billing_accounts"))).rejects.toThrow(/permission denied/);
  });

  it("is idempotent, refuses a fee that is already paid, and cancels an open setup checkout so nobody pays after the waiver", async () => {
    const { org } = await onboardedClient();
    await withSystem((db) => db.query(`insert into payments (org_id, kind, description, usd_amount_micros, charged_currency, charged_amount_minor, livemode, provider, reference_number)
      values ($1, 'setup_fee', 'Setup', 1499000000, 'PHP', 8694200, false, 'paymongo', $2)`, [org.id, "IAQ-WAIVE" + uid().toUpperCase()]));
    await waiveSetupFee(superAdmin, org.id, { reason: "Founding client, agreed by the founder in writing" });
    expect(await waiveSetupFee(superAdmin, org.id, { reason: "A second click on the same button" })).toEqual({ changed: false, provisioningRequested: 0 });
    expect((await setupStatus(org.id)).waiver_reason).toBe("Founding client, agreed by the founder in writing");
    expect((await payments(org.id))[0]).toMatchObject({ kind: "setup_fee", status: "cancelled" });
    expect(await provisioningJobs(org.id)).toBe(6);
    const paid = await onboardedClient();
    await recordManualPayment(superAdmin, paid.org.id, setupPayment());
    await expect(waiveSetupFee(superAdmin, paid.org.id, { reason: "Waive a fee that was paid" })).rejects.toThrow(/already paid/);
    expect((await setupStatus(paid.org.id)).setup_payment_status).toBe("paid");
  });
});

describe("the billing form can no longer type a status in", () => {
  it("refuses paid, waived and refunded, allows invoiced, and keeps activation tied to the payment", async () => {
    const { org } = await onboardedClient();
    const form = (over: Record<string, string> = {}) => ({ setupPaymentStatus: "not_invoiced" as const, activationStatus: "pending" as const, invoiceUrl: "", receiptUrl: "", serviceTerms: "", ...over }) as Parameters<typeof updateBilling>[2];
    for (const status of ["paid", "waived", "refunded"]) await expect(updateBilling(superAdmin, org.id, form({ setupPaymentStatus: status }))).rejects.toThrow(/Record the payment, waive the setup fee/);
    expect((await setupStatus(org.id)).setup_payment_status).toBe("not_invoiced");
    await updateBilling(superAdmin, org.id, form({ setupPaymentStatus: "invoiced", invoiceUrl: "https://example.com/invoice/1", serviceTerms: "Net 7" }));
    expect((await setupStatus(org.id)).setup_payment_status).toBe("invoiced");
    await expect(updateBilling(superAdmin, org.id, form({ setupPaymentStatus: "invoiced", activationStatus: "active" }))).rejects.toThrow(/not confirmed/);
    await expect(updateBilling(manager, org.id, form())).rejects.toThrow(/Only super admins/);
    await recordManualPayment(superAdmin, org.id, setupPayment());
    // The status now reads paid; saving the other fields must not change it, and an active label is allowed.
    await updateBilling(superAdmin, org.id, form({ setupPaymentStatus: "paid", activationStatus: "active", receiptUrl: "https://example.com/receipt/1" }));
    expect(await setupStatus(org.id)).toMatchObject({ setup_payment_status: "paid" });
    await expect(updateBilling(superAdmin, org.id, form({ setupPaymentStatus: "waived" }))).rejects.toThrow(/Record the payment, waive/);
  });
});

describe("refunds", () => {
  it("a partial refund keeps the fee confirmed; a full refund of the clearing payment stops new provisioning and pauses nothing that runs", async () => {
    const { org, owner } = await onboardedClient();
    await recordManualPayment(superAdmin, org.id, setupPayment());
    await markActivated(org.id);
    const [p] = await payments(org.id);
    const partial = await recordRefundAction(superAdmin, p.id, { amount: "100.00", reason: "Goodwill credit for the delay" });
    expect(partial).toMatchObject({ setupRefunded: false, removedMicros: 0 });
    expect((await setupStatus(org.id)).setup_payment_status).toBe("paid");
    expect((await payments(org.id))[0]).toMatchObject({ status: "partially_refunded", refunded_micros: "100000000" });
    await expect(recordRefundAction(superAdmin, p.id, { amount: "1400.00", reason: "More than what remains" })).rejects.toThrow(/more than the remaining/);
    const full = await recordRefundAction(superAdmin, p.id, { amount: "1399.00", reason: "Client cancelled before the work began" });
    expect(full.setupRefunded).toBe(true);
    expect(await setupStatus(org.id)).toMatchObject({ setup_payment_status: "refunded" });
    expect((await payments(org.id))[0]).toMatchObject({ status: "refunded", refunded_micros: "1499000000" });
    expect((await notice(owner.id, "billing_refund_recorded")).length).toBe(2);
    // Nothing that was running is paused: the six requests stay, the setup stays activated.
    expect(await provisioningJobs(org.id)).toBe(6);
    expect((await rows<{ state: string }>("select state from client_setup_instances where org_id = $1", [org.id]))[0].state).toBe("activated");
    // But nothing new starts: an employee enabled afterwards waits for a payment or a waiver.
    await withSystem((db) => db.query("delete from agent_provisioning_jobs where org_id = $1 and agent_instance_id = (select id from agent_instances where org_id = $1 and role_key = 'lead_hunter')", [org.id]));
    expect(await withSystem((db) => requestProvisioning(db, org.id, null))).toBe(0);
    // A fresh payment (a new bank reference) clears it again and starts what was waiting.
    const again = await recordManualPayment(superAdmin, org.id, setupPayment());
    expect(again.clearedSetup).toBe(true);
    expect(await setupStatus(org.id)).toMatchObject({ setup_payment_status: "paid", verified_payment_id: again.paymentId });
    expect(await provisioningJobs(org.id)).toBe(6);
  });

  it("refunding a duplicate setup payment leaves the status alone", async () => {
    const { org } = await onboardedClient();
    const first = await recordManualPayment(superAdmin, org.id, setupPayment());
    // A second setup payment can only exist from a provider that confirmed it after the fee was cleared; here it is written the way the webhook records it.
    await withSystem((db) => db.query(`insert into payments (org_id, kind, status, description, usd_amount_micros, charged_currency, charged_amount_minor, livemode, provider, reference_number, paid_at)
      values ($1, 'setup_fee', 'paid', 'Setup', 1499000000, 'PHP', 8694200, false, 'paymongo', $2, now())`, [org.id, "IAQ-DUP" + uid().toUpperCase()]));
    const dup = (await payments(org.id)).find((p) => p.provider === "paymongo")!;
    await recordRefundAction(superAdmin, dup.id, { amount: "1499.00", reason: "Paid twice by mistake, refunded in full" });
    expect(await setupStatus(org.id)).toMatchObject({ setup_payment_status: "paid", verified_payment_id: first.paymentId });
  });

  it("refuses a payment that was never made and a refund without a reason", async () => {
    const { org } = await onboardedClient();
    const out = await recordManualPayment(superAdmin, org.id, setupPayment({ kind: "domain", amount: "10.00" }));
    await expect(recordRefundAction(superAdmin, out.paymentId, { amount: "5.00", reason: "no" })).rejects.toThrow(/why the refund/);
    await expect(recordRefundAction(superAdmin, out.paymentId, { amount: "0", reason: "A refund of nothing at all" })).rejects.toThrow(/above zero/);
    await expect(recordRefundAction(superAdmin, "22222222-2222-4222-8222-222222222222", { amount: "5.00", reason: "No such payment exists" })).rejects.toThrow(/not found/i);
  });
});

describe("a departing client's export holds what the client may see of its payments", () => {
  it("keeps the bank reference, the checking note and who checked out of billing/payments.json, and the waiver reason out of every file", async () => {
    const { buildExport, EXPORT_TABLES } = await import("@/server/offboarding/export");
    const { readZip } = await import("@/server/offboarding/zip");
    const { org } = await onboardedClient();
    const reference = `SECRET-BANK-${uid()}`;
    await recordManualPayment(superAdmin, org.id, setupPayment({ externalReference: reference, note: "INTERNAL-CHECK-NOTE seen on the statement" }));
    const waived = await onboardedClient();
    await waiveSetupFee(superAdmin, waived.org.id, { reason: "INTERNAL-WAIVER-REASON founding client" });
    const ours = readZip((await buildExport(org.id)).bytes);
    const payments = ours.find((f) => f.name === "billing/payments.json")?.data.toString("utf8") ?? "";
    expect(payments).toContain("bank_transfer");
    for (const secret of [reference, "INTERNAL-CHECK-NOTE", superAdmin.id, "external_reference", "verification_note", "verified_by"]) expect(payments, secret).not.toContain(secret);
    const theirs = readZip((await buildExport(waived.org.id)).bytes).filter((f) => /\.(json|md)$/.test(f.name)).map((f) => f.data.toString("utf8")).join("\n");
    expect(theirs).not.toContain("INTERNAL-WAIVER-REASON");
    expect(theirs).not.toContain("waiver_reason");
    // Of the columns migration 0099 added, the file holds exactly those the client may read in the portal.
    const spec = EXPORT_TABLES.find((s) => s.file === "billing/payments.json")!;
    await withSystem(async (db) => {
      for (const column of ["provider", "method", "paid_on"]) {
        expect((spec.omit ?? []).includes(column), `${column} is exported`).toBe(false);
        expect((await db.query<{ ok: boolean }>("select has_column_privilege('iaq_app_user', 'public.payments', $1, 'select') as ok", [column])).rows[0].ok, `${column} is readable`).toBe(true);
      }
      for (const column of ["external_reference", "verified_by", "verified_at", "verification_note"]) {
        expect(spec.omit, `${column} is left out of the export`).toContain(column);
        expect((await db.query<{ ok: boolean }>("select has_column_privilege('iaq_app_user', 'public.payments', $1, 'select') as ok", [column])).rows[0].ok, `${column} is not readable`).toBe(false);
      }
    });
  });
});

describe("one workspace's money is invisible to another", () => {
  it("answers the clearance question only for a workspace the caller belongs to", async () => {
    const a = await onboardedClient();
    const b = await onboardedClient();
    await recordManualPayment(superAdmin, a.org.id, setupPayment());
    await waiveSetupFee(superAdmin, b.org.id, { reason: "Founding client, agreed by the founder in writing" });
    const ask = (user: string, org: string) => withUser(user, async (db) => (await db.query<{ c: boolean }>("select app.setup_payment_cleared($1) as c", [org])).rows[0].c);
    expect(await ask(a.owner.id, a.org.id)).toBe(true);
    expect(await ask(a.owner.id, b.org.id)).toBe(false);
    expect(await ask(b.owner.id, b.org.id)).toBe(true);
    expect(await ask(b.owner.id, a.org.id)).toBe(false);
    expect(await ask(a.owner.id, "33333333-3333-4333-8333-333333333333")).toBe(false);
    // Trusted server code, with no signed-in user, may ask about any workspace.
    expect((await withSystem((db) => db.query<{ c: boolean }>("select app.setup_payment_cleared($1) as c", [b.org.id]))).rows[0].c).toBe(true);
    expect((await setupStatus(a.org.id)).setup_payment_status).toBe("paid");
    expect((await setupStatus(b.org.id)).setup_payment_status).toBe("waived");
  });

  it("shows a client how a payment arrived, never the reference, the note or who checked it", async () => {
    const a = await onboardedClient();
    const b = await onboardedClient();
    await recordManualPayment(superAdmin, a.org.id, setupPayment());
    await recordManualPayment(superAdmin, b.org.id, setupPayment());
    const own = await withUser(a.owner.id, async (db) => (await db.query<{ provider: string; method: string; paid_on: string }>("select provider, method, paid_on::text from payments")).rows);
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ provider: "manual", method: "bank_transfer" });
    for (const column of ["external_reference", "verification_note", "verified_by", "verified_at"]) await expect(withUser(a.owner.id, (db) => db.query(`select ${column} from payments`)), column).rejects.toThrow(/permission denied/);
    // Writing is closed to the application role altogether.
    await expect(withUser(a.owner.id, (db) => db.query("update billing_accounts set setup_payment_status = 'paid'"))).rejects.toThrow(/permission denied/);
    await expect(withUser(a.owner.id, (db) => db.query("update payments set status = 'refunded'"))).rejects.toThrow(/permission denied/);
    await expect(withUser(a.owner.id, (db) => db.query("insert into payments (org_id, kind, description, usd_amount_micros, charged_currency, charged_amount_minor, livemode, reference_number) values ($1, 'other', 'x', 1, 'USD', 1, true, 'IAQ-FORGED01')", [a.org.id]))).rejects.toThrow(/permission denied/);
  });

  it("a member who may not see billing sees no payment rows", async () => {
    const a = await onboardedClient();
    await recordManualPayment(superAdmin, a.org.id, setupPayment());
    const member = await createUser();
    await addMember(a.org.id, member.id, "member");
    expect(await withUser(member.id, async (db) => (await db.query("select 1 from payments")).rows)).toHaveLength(0);
  });
});
