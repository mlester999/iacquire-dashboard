// The setup payment gate (Phase 7, M1): no AI employee profile is started, no setup is activated and no maintenance plan begins until the setup fee is paid or waived with
// a reason. Core CRM, the inbox, the six employees, the website, booking and social text posts are never gated by payment or a lapse. Embedded Postgres; every provider
// is a stand-in and the PayMongo bodies are written by hand.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

process.env.PAYMONGO_SECRET_KEY = "sk_test_notarealkey123";
process.env.PAYMONGO_WEBHOOK_SECRET = "whsec_test_only_not_a_real_secret";
process.env.PAYMONGO_PAYMENT_METHODS = "card,gcash";

import { resetEnvCache } from "@/server/env";
import { withSystem, withUser } from "@/server/db";
import { usdToMicros, usdToChargeMinor } from "@/lib/billing";
import { PAYMENT_UNVERIFIED_MESSAGE, MAINTENANCE_PAYMENT_NOTE } from "@/lib/billing-clearance";
import { createPaymentCheckout, handlePaymongoWebhook } from "@/server/billing/payments";
import { recordManualPayment, recordRefundAction, waiveSetupFee } from "@/server/billing/manual";
import { isSetupPaymentClearedFor } from "@/server/billing/clearance";
import { setExchangeRate } from "@/server/billing/service";
import { requestProvisioning } from "@/server/workforce/provisioning";
import { activateMaintenance, listAgencyMaintenance, maintenanceEligibility } from "@/server/maintenance/service";
import { studioEntitlement } from "@/server/automation-studio/entitlement";
import { ensureInstanceStandalone } from "@/server/setup/core";
import { activateSetup, markReadyForReview, setServices } from "@/server/setup/agency";
import { runChecks } from "@/server/setup/automation";
import { getAgencySetupSnapshot } from "@/server/setup/snapshots";
import { createContact } from "@/server/crm/contacts";
import { createTag } from "@/server/crm/tags";
import { createCalendar } from "@/server/calendars/setup";
import { createPost } from "@/server/social/posts";
import { agencyUser, createOrg, createUser, uid } from "./support/fixtures";
import { crmOrg } from "./support/crm";
import { connect, socialOrg, textPost } from "./support/social";
import { clearSetupPayment, markActivated, mockCheckoutFetch, onboardedClient, paymongoPaidEvent, provisioningJobs, setupStatus, signPaymongo, submitRealOnboarding } from "./support/billing";

const posix = (p: string) => p.split(path.sep).join("/");
const today = () => new Date().toISOString().slice(0, 10);
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const bankPayment = (over: Record<string, string> = {}) => ({ kind: "setup_fee", amount: "1499.00", method: "bank_transfer", externalReference: `BANK-${uid()}`, paidOn: today(), note: "Seen on the bank statement for today", ...over });
const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;
const notices = (userId: string, kind: string) => rows("select 1 from notifications where user_id = $1 and kind = $2", [userId, kind]);
const jobsPerEmployee = (orgId: string) => rows<{ n: number }>("select count(*)::int as n from agent_provisioning_jobs where org_id = $1 and kind = 'provision' group by agent_instance_id", [orgId]);
const deliver = (body: string) => handlePaymongoWebhook({ rawBody: body, signatureHeader: signPaymongo(body) });

let superAdmin: ReturnType<typeof agencyUser>;

beforeAll(async () => {
  resetEnvCache();
  superAdmin = agencyUser(await createUser({ platformRole: "agency_super_admin" }), "agency_super_admin");
  await setExchangeRate(superAdmin, { usdPhpRate: 58, source: "test fixture" });
});

describe("AI employee provisioning waits for the setup payment", () => {
  it("an unpaid client finishes the real questionnaire and gets no provisioning request; the agency and the owner are told once", async () => {
    const c = await submitRealOnboarding({ name: "Unpaid Roofing Co" });
    // The questionnaire itself costs nothing and is not gated: the six employee configurations are built.
    expect(c.result.employees).toHaveLength(6);
    expect(await provisioningJobs(c.org.id)).toBe(0);
    const ownerNotices = await rows<{ title: string; severity: string }>("select title, severity from notifications where user_id = $1 and kind = 'billing_setup_payment_required'", [c.owner.id]);
    expect(ownerNotices).toEqual([{ title: "Your AI team starts after your setup payment is confirmed", severity: "info" }]);
    const agencyNotices = await rows("select 1 from notifications where user_id = $1 and org_id = $2 and kind = 'billing_setup_payment_required'", [superAdmin.id, c.org.id]);
    expect(agencyNotices).toHaveLength(1);
    // Asking again (the client presses the button, the questionnaire is saved again) repeats nothing.
    expect(await withSystem((db) => requestProvisioning(db, c.org.id, c.owner.id))).toBe(0);
    await (await import("@/server/onboarding/service")).submitOnboarding(c.ctx);
    expect(await notices(c.owner.id, "billing_setup_payment_required")).toHaveLength(1);
    expect(await provisioningJobs(c.org.id)).toBe(0);
  });

  it("a payment the Super Admin records, then a waiver, then a signed webhook each start exactly one request per employee", async () => {
    const byPayment = await submitRealOnboarding({ name: "Manual Payment Plumbing" });
    expect(await provisioningJobs(byPayment.org.id)).toBe(0);
    await recordManualPayment(superAdmin, byPayment.org.id, bankPayment());
    expect(await jobsPerEmployee(byPayment.org.id)).toEqual(Array(6).fill({ n: 1 }));

    const byWaiver = await submitRealOnboarding({ name: "Waived Plumbing" });
    expect(await provisioningJobs(byWaiver.org.id)).toBe(0);
    await waiveSetupFee(superAdmin, byWaiver.org.id, { reason: "Founding client, agreed by the founder in writing" });
    expect(await jobsPerEmployee(byWaiver.org.id)).toEqual(Array(6).fill({ n: 1 }));

    const byWebhook = await submitRealOnboarding({ name: "Webhook Plumbing" });
    expect(await provisioningJobs(byWebhook.org.id)).toBe(0);
    const { impl } = mockCheckoutFetch("cs_gate_1");
    const checkout = await createPaymentCheckout({ orgId: byWebhook.org.id, kind: "setup_fee", usdMicros: usdToMicros(1499), description: "iAcquire setup", requestedBy: superAdmin.id }, { fetch: impl });
    const body = paymongoPaidEvent({ checkoutId: "cs_gate_1", reference: checkout.referenceNumber, amount: usdToChargeMinor(usdToMicros(1499), 58) });
    expect(await deliver(body)).toMatchObject({ httpStatus: 200, outcome: "processed" });
    expect(await jobsPerEmployee(byWebhook.org.id)).toEqual(Array(6).fill({ n: 1 }));
    // The same delivery again, and a retry of the request, add nothing.
    expect(await deliver(body)).toMatchObject({ outcome: "duplicate" });
    expect(await withSystem((db) => requestProvisioning(db, byWebhook.org.id, null))).toBe(0);
    expect(await provisioningJobs(byWebhook.org.id)).toBe(6);
  });

  it("the client's own press of the button cannot start provisioning for an unpaid workspace", async () => {
    const c = await submitRealOnboarding({ name: "Button Press Co" });
    for (let i = 0; i < 3; i += 1) expect(await withSystem((db) => requestProvisioning(db, c.org.id, c.owner.id))).toBe(0);
    expect(await provisioningJobs(c.org.id)).toBe(0);
  });

  it("a fee that is not cleared stays blocked whatever its status says: invoiced and refunded are not payment", async () => {
    for (const status of ["not_invoiced", "invoiced", "refunded"]) {
      const { org, owner } = await onboardedClient();
      await withSystem((db) => db.query("update billing_accounts set setup_payment_status = $2 where org_id = $1", [org.id, status]));
      expect(await withSystem((db) => requestProvisioning(db, org.id, owner.id)), status).toBe(0);
    }
    const { org, owner } = await onboardedClient();
    await clearSetupPayment(org.id);
    expect(await withSystem((db) => requestProvisioning(db, org.id, owner.id))).toBe(6);
  });
});

describe("a signed PayMongo payment for the setup fee", () => {
  async function pendingCheckout(checkoutId: string) {
    const c = await onboardedClient();
    const { impl } = mockCheckoutFetch(checkoutId);
    const checkout = await createPaymentCheckout({ orgId: c.org.id, kind: "setup_fee", usdMicros: usdToMicros(1499), description: "iAcquire setup", requestedBy: superAdmin.id }, { fetch: impl });
    return { ...c, checkout };
  }
  const exact = usdToChargeMinor(usdToMicros(1499), 58);

  it("marks the fee paid against that payment, tells the owner once, and records who: the system", async () => {
    const c = await pendingCheckout("cs_gate_paid");
    expect((await setupStatus(c.org.id)).setup_payment_status).toBe("not_invoiced");
    const out = await deliver(paymongoPaidEvent({ checkoutId: "cs_gate_paid", reference: c.checkout.referenceNumber, amount: exact }));
    expect(out.outcome).toBe("processed");
    expect(await setupStatus(c.org.id)).toMatchObject({ setup_payment_status: "paid", verified_payment_id: c.checkout.paymentId, waiver_reason: null });
    expect(await notices(c.owner.id, "billing_setup_cleared")).toHaveLength(1);
    // The owner is told once, with the clearing notice, not twice with a second "payment received".
    expect(await notices(c.owner.id, "billing_payment_received")).toHaveLength(0);
    const audit = await rows<{ metadata: { clearedSetup: boolean; provider: string } }>("select metadata from audit_logs where org_id = $1 and action = 'billing.payment_confirmed'", [c.org.id]);
    expect(audit[0].metadata).toMatchObject({ clearedSetup: true, provider: "paymongo" });
  });

  it("does not clear on a wrong amount, a forged signature, or a reference that is not ours", async () => {
    const c = await pendingCheckout("cs_gate_wrong");
    const wrong = await deliver(paymongoPaidEvent({ checkoutId: "cs_gate_wrong", reference: c.checkout.referenceNumber, amount: exact - 1 }));
    expect(wrong).toMatchObject({ outcome: "rejected", detail: expect.stringMatching(/Amount or currency/) });
    expect((await rows<{ status: string }>("select status from payments where id = $1", [c.checkout.paymentId]))[0].status).toBe("mismatch");
    expect(await deliver(paymongoPaidEvent({ checkoutId: "cs_gate_wrong", reference: "IAQ-NOTOURREF1", amount: exact }))).toMatchObject({ outcome: "rejected" });
    const forged = paymongoPaidEvent({ checkoutId: "cs_gate_wrong", reference: c.checkout.referenceNumber, amount: exact });
    expect(await handlePaymongoWebhook({ rawBody: forged, signatureHeader: signPaymongo(forged, { secret: "whsec_someone_elses_secret" }) })).toMatchObject({ httpStatus: 401, outcome: "rejected" });
    expect(await handlePaymongoWebhook({ rawBody: forged, signatureHeader: null })).toMatchObject({ httpStatus: 401 });
    expect((await setupStatus(c.org.id)).setup_payment_status).toBe("not_invoiced");
    expect(await provisioningJobs(c.org.id)).toBe(0);
    expect(await notices(c.owner.id, "billing_setup_cleared")).toHaveLength(0);
  });

  it("money that arrives after the fee was waived is recorded, flagged for a refund, and changes neither the status nor the requests", async () => {
    const c = await pendingCheckout("cs_gate_late");
    await waiveSetupFee(superAdmin, c.org.id, { reason: "Founding client, agreed by the founder in writing" });
    expect((await rows<{ status: string }>("select status from payments where id = $1", [c.checkout.paymentId]))[0].status).toBe("cancelled");
    const out = await deliver(paymongoPaidEvent({ checkoutId: "cs_gate_late", reference: c.checkout.referenceNumber, amount: exact }));
    expect(out.outcome).toBe("processed");
    expect((await rows<{ status: string }>("select status from payments where id = $1", [c.checkout.paymentId]))[0].status).toBe("paid");
    expect(await setupStatus(c.org.id)).toMatchObject({ setup_payment_status: "waived", verified_payment_id: null });
    expect(await provisioningJobs(c.org.id)).toBe(6);
    const alerts = await rows<{ title: string }>("select title from notifications where org_id = $1 and kind = 'billing_reconciliation'", [c.org.id]);
    expect(alerts.some((a) => /already cleared/.test(a.title))).toBe(true);
  });

  it("refuses a second checkout while one is open, and any checkout once the fee is cleared", async () => {
    const c = await pendingCheckout("cs_gate_open");
    const { impl } = mockCheckoutFetch("cs_gate_open_2");
    const again = () => createPaymentCheckout({ orgId: c.org.id, kind: "setup_fee", usdMicros: usdToMicros(1499), description: "iAcquire setup", requestedBy: superAdmin.id }, { fetch: impl });
    await expect(again()).rejects.toThrow(/already open/);
    await deliver(paymongoPaidEvent({ checkoutId: "cs_gate_open", reference: c.checkout.referenceNumber, amount: exact }));
    await expect(again()).rejects.toThrow(/already paid/);
    const waived = await onboardedClient();
    await waiveSetupFee(superAdmin, waived.org.id, { reason: "Founding client, agreed by the founder in writing" });
    await expect(createPaymentCheckout({ orgId: waived.org.id, kind: "setup_fee", usdMicros: usdToMicros(1499), description: "iAcquire setup", requestedBy: superAdmin.id }, { fetch: impl })).rejects.toThrow(/waived/);
  });
});

describe("activation waits for the setup payment", () => {
  async function readyForReview() {
    const org = await createOrg();
    const admin = agencyUser(await createUser({ platformRole: "agency_super_admin" }), "agency_super_admin");
    await ensureInstanceStandalone(org.id);
    await withSystem(async (db) => {
      await db.query("update organizations set onboarding_completed_at = now() where id = $1", [org.id]);
      await db.query("insert into onboarding_responses (org_id, completed_at) values ($1, now())", [org.id]);
    });
    await setServices(admin, org.id, []);
    await runChecks(org.id, { actorUserId: admin.id, live: false, force: true });
    await markReadyForReview(admin, org.id);
    return { org, admin };
  }
  const decisions = (orgId: string) => rows<{ decision: string }>("select decision from activation_reviews where org_id = $1 order by created_at, id", [orgId]);

  it("is blocked by an unconfirmed payment, says so first, records the refusal, and passes once the fee is paid", async () => {
    const { org, admin } = await readyForReview();
    // Marking the setup ready for review was not blocked by the payment: it is not a setup task.
    const blocked = await getAgencySetupSnapshot(admin, org.id);
    expect(blocked.state).toBe("ready_for_review");
    expect(blocked.payment).toEqual({ status: "not_invoiced", cleared: false });
    expect(blocked.readiness.canActivate).toBe(false);
    expect(blocked.canActivate).toBe(false);
    expect(blocked.readiness.blockers[0]).toMatchObject({ code: "payment_unverified", message: PAYMENT_UNVERIFIED_MESSAGE });
    expect(blocked.readiness.taskBlockers).toEqual([]);
    await expect(activateSetup(admin, org.id, { note: "Trying to activate an unpaid client" })).rejects.toThrow(/setup payment has not been confirmed/);
    expect(await decisions(org.id)).toEqual([{ decision: "blocked" }]);
    expect((await getAgencySetupSnapshot(admin, org.id)).state).toBe("ready_for_review");
    expect((await rows<{ activation_status: string }>("select activation_status from billing_accounts where org_id = $1", [org.id]))[0].activation_status).toBe("pending");

    await recordManualPayment(admin, org.id, bankPayment());
    const cleared = await getAgencySetupSnapshot(admin, org.id);
    expect(cleared.payment).toEqual({ status: "paid", cleared: true });
    expect(cleared.readiness.blockers.some((b) => b.code === "payment_unverified")).toBe(false);
    expect(cleared.canActivate).toBe(true);
    await activateSetup(admin, org.id, { note: "Paid and verified; activating" });
    expect((await getAgencySetupSnapshot(admin, org.id)).state).toBe("activated");
    expect(await decisions(org.id)).toEqual([{ decision: "blocked" }, { decision: "approved" }]);
    expect((await rows<{ activation_status: string }>("select activation_status from billing_accounts where org_id = $1", [org.id]))[0].activation_status).toBe("active");
  });

  it("a waiver passes it too; a refund before activation blocks it again", async () => {
    const waived = await readyForReview();
    await waiveSetupFee(waived.admin, waived.org.id, { reason: "Founding client, agreed by the founder in writing" });
    await activateSetup(waived.admin, waived.org.id, { note: "Waived by the founder; activating" });
    expect((await getAgencySetupSnapshot(waived.admin, waived.org.id)).state).toBe("activated");

    const refunded = await readyForReview();
    await withSystem((db) => db.query("update billing_accounts set setup_payment_status = 'refunded' where org_id = $1", [refunded.org.id]));
    await expect(activateSetup(refunded.admin, refunded.org.id, { note: "Refunded before activation" })).rejects.toThrow(/setup payment has not been confirmed/);
  });
});

describe("the maintenance plan waits for the setup payment too", () => {
  it("is not offered to an activated client whose fee is unconfirmed, and cannot be started by the agency either", async () => {
    const { org, owner } = await onboardedClient();
    await markActivated(org.id);
    expect(await maintenanceEligibility(org.id)).toEqual({ eligible: false, note: MAINTENANCE_PAYMENT_NOTE });
    // A request that somehow exists (made before the gate, or by hand) cannot be activated.
    const sub = (await rows<{ id: string }>(
      "insert into maintenance_subscriptions (org_id, monthly_price_cents, monthly_request_allowance, terms_version, accepted_by) values ($1, 29900, 4, 'test-terms', $2) returning id", [org.id, owner.id]))[0];
    await expect(activateMaintenance(superAdmin, sub.id, { payment: { verified: true, paidThroughOn: inDays(30) } })).rejects.toThrow(/setup payment isn't confirmed/);
    expect((await rows<{ status: string }>("select status from maintenance_subscriptions where id = $1", [sub.id]))[0].status).toBe("requested");
    // The agency's list says which of the two conditions holds the plan back.
    const listed = async () => (await listAgencyMaintenance(superAdmin)).subscriptions.find((s) => s.orgId === org.id)!;
    expect(await listed()).toMatchObject({ eligible: false, blockedBy: "setup_payment" });
    await waiveSetupFee(superAdmin, org.id, { reason: "Founding client, agreed by the founder in writing" });
    expect(await listed()).toMatchObject({ eligible: true, blockedBy: null });
    expect(await maintenanceEligibility(org.id)).toEqual({ eligible: true, note: null });
    await activateMaintenance(superAdmin, sub.id, { payment: { verified: true, paidThroughOn: inDays(30) } });
    expect((await rows<{ status: string }>("select status from maintenance_subscriptions where id = $1", [sub.id]))[0].status).toBe("active");
  });

  it("a refund of the setup fee ends eligibility for a new plan but does not touch a plan that is already running", async () => {
    const { org, owner } = await onboardedClient();
    await markActivated(org.id);
    const paid = await recordManualPayment(superAdmin, org.id, bankPayment());
    await withSystem((db) => db.query(
      `insert into maintenance_subscriptions (org_id, status, monthly_price_cents, monthly_request_allowance, terms_version, accepted_by, activated_by, activated_at, billing_start_on, paid_through_on)
       values ($1, 'active', 29900, 4, 'test-terms', $2, $3, now(), current_date, $4)`, [org.id, owner.id, superAdmin.id, inDays(20)]));
    await recordRefundAction(superAdmin, paid.paymentId,{ amount: "1499.00", reason: "Client cancelled before the work began" });
    expect((await setupStatus(org.id)).setup_payment_status).toBe("refunded");
    expect((await maintenanceEligibility(org.id)).eligible).toBe(false);
    expect((await rows<{ status: string }>("select status from maintenance_subscriptions where org_id = $1", [org.id]))[0].status).toBe("active");
    expect((await withSystem((db) => studioEntitlement(db, org.id))).entitled).toBe(true);
  });
});

describe("existing clients are not locked out when the gate arrives", () => {
  // Founder decision 1 (open): the recommended default waives every client whose setup was ALREADY activated, with a recorded reason. The statement is lifted out of the
  // migration file itself so this test cannot drift from what would run.
  const migration = readFileSync("supabase/migrations/0099_payment_controls.sql", "utf8");
  const start = migration.indexOf("update billing_accounts b");
  const backfill = migration.slice(start, migration.indexOf(";", start) + 1);

  it("is one statement that waives activated clients and leaves everything else alone", async () => {
    expect(start).toBeGreaterThan(0);
    expect(backfill.match(/;/g)).toHaveLength(1);
    const make = async (status: string, activated: boolean) => {
      const c = await onboardedClient();
      if (activated) await markActivated(c.org.id);
      if (status === "paid") await recordManualPayment(superAdmin, c.org.id, bankPayment());
      else await withSystem((db) => db.query("update billing_accounts set setup_payment_status = $2 where org_id = $1", [c.org.id, status]));
      return c;
    };
    const activatedNotInvoiced = await make("not_invoiced", true);
    const activatedInvoiced = await make("invoiced", true);
    const activatedPaid = await make("paid", true);
    const activatedRefunded = await make("refunded", true);
    const inSetup = await make("not_invoiced", false);
    const inSetupInvoiced = await make("invoiced", false);
    await withSystem((db) => db.query(backfill));
    const state = async (orgId: string) => (await rows<{ setup_payment_status: string; waiver_reason: string | null; waived_by: string | null }>("select setup_payment_status, waiver_reason, waived_by from billing_accounts where org_id = $1", [orgId]))[0];
    expect(await state(activatedNotInvoiced.org.id)).toEqual({ setup_payment_status: "waived", waiver_reason: "Activated before the payment gate", waived_by: null });
    expect(await state(activatedInvoiced.org.id)).toMatchObject({ setup_payment_status: "waived", waiver_reason: "Activated before the payment gate" });
    expect(await state(activatedPaid.org.id)).toMatchObject({ setup_payment_status: "paid", waiver_reason: null });
    expect(await state(activatedRefunded.org.id)).toMatchObject({ setup_payment_status: "refunded", waiver_reason: null });
    expect(await state(inSetup.org.id)).toMatchObject({ setup_payment_status: "not_invoiced", waiver_reason: null });
    expect(await state(inSetupInvoiced.org.id)).toMatchObject({ setup_payment_status: "invoiced" });
    // Running it twice changes nothing more.
    await withSystem((db) => db.query(backfill));
    expect(await state(activatedNotInvoiced.org.id)).toMatchObject({ waiver_reason: "Activated before the payment gate" });
    // The activated client keeps what it has: it can be provisioned and offered the plan; the one still in setup cannot yet.
    expect(await withSystem((db) => requestProvisioning(db, activatedNotInvoiced.org.id, null))).toBe(6);
    expect((await maintenanceEligibility(activatedNotInvoiced.org.id)).eligible).toBe(true);
    expect(await withSystem((db) => requestProvisioning(db, inSetup.org.id, null))).toBe(0);
  });
});

describe("the payment status is visible only to the workspace it belongs to", () => {
  it("answers the screens' question for a member, and false for anyone else", async () => {
    const a = await onboardedClient();
    const b = await onboardedClient();
    await clearSetupPayment(a.org.id);
    expect(await isSetupPaymentClearedFor(a.owner.id, a.org.id)).toBe(true);
    expect(await isSetupPaymentClearedFor(b.owner.id, b.org.id)).toBe(false);
    expect(await isSetupPaymentClearedFor(b.owner.id, a.org.id)).toBe(false);
    const stranger = await createUser();
    expect(await isSetupPaymentClearedFor(stranger.id, a.org.id)).toBe(false);
    expect(await withUser(stranger.id, async (db) => (await db.query("select 1 from billing_accounts")).rows)).toHaveLength(0);
  });
});

describe("core modules are never gated by payment or a lapse", () => {
  const srcRoot = "src";
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(name) ? [full] : [];
  });

  it("only the places that spend iAcquire's money or start the second paid product ask the setup payment question", () => {
    const pattern = /setup_payment_cleared|isSetupPaymentCleared|assertSetupPaymentCleared|billing-clearance|billing\/clearance|setup_payment_status/;
    const found = walk(srcRoot).filter((f) => pattern.test(readFileSync(f, "utf8"))).map(posix).sort();
    // Each of these is billing itself, provisioning, activation, the maintenance plan, the employee cards' wording or the billing screens that show where the fee stands. The
    // entitlement helper reports the answer (setupCleared) next to the plan's, and no core module reads it (the next test).
    expect(found).toEqual([
      "src/app/(portal)/employees/[slug]/page.tsx",
      "src/app/(portal)/employees/page.tsx",
      "src/app/(portal)/settings/billing/page.tsx",
      "src/app/(portal)/setup/page.tsx",
      "src/app/actions/workforce.ts",
      "src/components/admin/client-detail.tsx",
      "src/components/admin/payments-workspace.tsx",
      "src/components/billing/billing-workspace.tsx",
      "src/components/purchase-intents/actions.tsx",
      "src/components/setup/onboarded-banner.tsx",
      "src/components/workforce/request-setup.tsx",
      "src/lib/onboarding/setup-payment-line.ts",
      "src/lib/setup.ts",
      "src/lib/workforce-readiness.ts",
      "src/server/admin/queries.ts",
      "src/server/admin/tenants.ts",
      "src/server/billing/clearance.ts",
      "src/server/billing/manual.ts",
      "src/server/billing/payments-view.ts",
      "src/server/billing/payments.ts",
      "src/server/billing/service.ts",
      "src/server/entitlements.ts",
      "src/server/maintenance/payment.ts",
      "src/server/maintenance/service.ts",
      "src/server/purchase-intents/service.ts",
      "src/server/setup/agency.ts",
      "src/server/setup/snapshots.ts",
      "src/server/workforce/provisioning.ts",
    ].sort());
  });

  it("no core module reads the payment status, the clearance or the plan's entitlement", () => {
    const core = ["src/server/crm", "src/server/messaging", "src/server/calendars", "src/server/webchat", "src/server/websites", "src/server/sites", "src/server/chat", "src/server/appointments", "src/server/leads", "src/server/missed-calls", "src/server/retention", "src/server/lead-scoring", "src/server/proposals", "src/server/invoices", "src/server/customer-payments", "src/server/reputation", "src/server/esign"];
    const premium = /studioEntitlement|assertStudioEntitled|entitlementFor|maintenance_subscriptions|setup_payment|billing_accounts/;
    const offenders = core.flatMap((dir) => walk(dir)).filter((f) => premium.test(readFileSync(f, "utf8"))).map(posix);
    // The Studio's own gates live in the workflow engine's premium paths (crm/workflows) and in applying a Blueprint that carries an Automation Studio workflow; nowhere else.
    expect(offenders.filter((f) => !f.startsWith("src/server/crm/workflows/") && f !== "src/server/crm/blueprints/native-io/write.ts")).toEqual([]);
  });

  it("with the setup fee refunded and the plan expired, a representative operation in each core module still works", async () => {
    // CRM and booking.
    const c = await crmOrg();
    await withSystem(async (db) => {
      await db.query("update billing_accounts set setup_payment_status = 'refunded' where org_id = $1", [c.org.id]);
      await db.query(
        `insert into maintenance_subscriptions (org_id, status, monthly_price_cents, monthly_request_allowance, terms_version, accepted_by, activated_by, activated_at, billing_start_on, expired_at, paid_through_on)
         values ($1, 'expired', 29900, 4, 'test-terms', $2, $2, now(), current_date - 90, now(), current_date - 60)`, [c.org.id, c.people.owner.id]);
    });
    expect((await withSystem((db) => studioEntitlement(db, c.org.id))).entitled).toBe(false);
    expect((await maintenanceEligibility(c.org.id)).eligible).toBe(false);
    const contact = await createContact(c.actor("owner"), { firstName: "Pat", lastName: "Lee" });
    expect(contact).toBeTruthy();
    await createTag(c.actor("owner"), { name: "Still works" });
    await createCalendar(c.actor("owner"), { name: "Front desk", members: [{ userId: c.people.owner.id }] });
    expect((await rows("select 1 from contacts where org_id = $1", [c.org.id])).length).toBeGreaterThan(0);

    // Social text posts.
    const s = await socialOrg();
    await withSystem(async (db) => {
      await db.query("update billing_accounts set setup_payment_status = 'refunded' where org_id = $1", [s.m.org.id]);
      await db.query(
        `insert into maintenance_subscriptions (org_id, status, monthly_price_cents, monthly_request_allowance, terms_version, accepted_by, activated_by, activated_at, billing_start_on, expired_at, paid_through_on)
         values ($1, 'expired', 29900, 4, 'test-terms', $2, $2, now(), current_date - 90, now(), current_date - 60)`, [s.m.org.id, s.m.people.owner.id]);
    });
    const account = await connect(s);
    const post = await createPost(s.sales, textPost(account.id));
    expect(post.status).toBe("draft");
  });
});

describe("every decision about activation is made with the payment in view", () => {
  it("each server caller of evaluateReadiness passes the payment, except the one that only reads task blockers", () => {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : /\.ts$/.test(name) ? [full] : [];
    });
    const callers = walk("src/server").filter((f) => /\bevaluateReadiness\(/.test(readFileSync(f, "utf8")));
    expect(callers.map((f) => f.split(path.sep).join("/")).sort()).toEqual(["src/server/setup/agency.ts", "src/server/setup/core.ts", "src/server/setup/snapshots.ts"]);
    for (const file of callers) {
      const source = readFileSync(file, "utf8");
      const calls = [...source.matchAll(/evaluateReadiness\(\{[^}]*\}/g)].map((m) => m[0]);
      expect(calls.length, file).toBeGreaterThan(0);
      // core.ts only asks which task problems send a final review back, which payment never does.
      for (const call of calls) if (!posix(file).endsWith("setup/core.ts")) expect(call, file).toMatch(/payment:/);
    }
  });
});

describe("what a Super Admin sees while the fee is unconfirmed", () => {
  it("is told by the unpaid workspace's notices, and the notices carry no payment detail", async () => {
    const c = await submitRealOnboarding({ name: "Notice Co" });
    const body = await rows<{ title: string; body: string; link: string }>("select title, body, link from notifications where org_id = $1 and kind = 'billing_setup_payment_required' and user_id = $2", [c.org.id, superAdmin.id]);
    expect(body[0].link).toBe(`/admin/clients/${c.org.id}?tab=billing`);
    expect(body[0].body).toMatch(/Record the payment, or waive the setup fee/);
    expect(`${body[0].title} ${body[0].body}`).not.toMatch(/\d{3,}|IAQ-/);
  });
});
