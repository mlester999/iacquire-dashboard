// The maintenance renewal sweep (Phase 7, M2): reminders before a plan's paid-through day, a notice when it passes with no payment recorded, the automatic past-due step that is
// OFF unless a Super Admin switches it on, the closing of checkouts nobody completed, its time budget, and that it is registered, dormant and documented. Embedded Postgres; no
// provider is called and the PayMongo bodies are written by hand.
const CRON = "billing-renewal-scheduler-secret-0123456789abcdef";
process.env.CRON_SECRET = CRON;
process.env.SCHEDULER_ENABLED = "true";
process.env.PAYMONGO_SECRET_KEY = "sk_test_notarealkey123";
process.env.PAYMONGO_WEBHOOK_SECRET = "whsec_test_only_not_a_real_secret";
process.env.PAYMONGO_PAYMENT_METHODS = "card,gcash";

import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { POST as tick } from "@/app/api/internal/tick/route";
import { JOBS } from "@/server/ops/tick";
import { JOB_LABELS } from "@/lib/ops";
import { createPaymentCheckout, handlePaymongoWebhook } from "@/server/billing/payments";
import { setAutoPastDue, setExchangeRate, getAgencyBillingOverview } from "@/server/billing/service";
import { runMaintenanceRenewalSweep } from "@/server/maintenance/renewal";
import { recordVerifiedPayment } from "@/server/automation-studio/lifecycle";
import { studioEntitlement } from "@/server/automation-studio/entitlement";
import { usdToChargeMinor, usdToMicros } from "@/lib/billing";
import {
  AUTO_PAST_DUE_MIN_DAYS_OVER, OVERDUE_NOTICE_WINDOW_DAYS, RENEWAL_NOTICE_DAYS, RENEWAL_SWEEP_BATCH, RENEWAL_SWEEP_BUDGET_MS, STALE_CHECKOUT_HOURS, addDays, daysUntil, paidPeriodEnded,
  renewalNoticeLevel, renewalStep, staleCheckoutCutoff,
} from "@/lib/billing-renewal";
import { agencyUser, createUser } from "./support/fixtures";
import { crmOrg } from "./support/crm";
import { mockCheckoutFetch, onboardedClient, paymongoPaidEvent, setupStatus, signPaymongo } from "./support/billing";
import { DAY, auditOf, coreWorkflowFor, noticesOf, planRow, planStatus, setAgencyTimezone, studioWorkflowFor, workflowRow } from "./support/billing-plan";

const NOW = new Date("2026-11-10T12:00:00Z");
const TODAY = "2026-11-10";
const plus = (n: number) => addDays(TODAY, n) as string;
const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;

let superAdmin: ReturnType<typeof agencyUser>;

beforeAll(async () => {
  resetEnvCache();
  superAdmin = agencyUser(await createUser({ platformRole: "agency_super_admin" }), "agency_super_admin");
  await setExchangeRate(superAdmin, { usdPhpRate: 58, source: "test fixture" });
  await setAgencyTimezone("UTC");
});

// The sweep looks at every workspace and the test database is shared by the file, so each test starts with no open plan and no pending checkout left by an earlier one.
beforeEach(async () => {
  await withSystem(async (db) => {
    await db.query("update maintenance_subscriptions set status = 'cancelled', cancelled_at = now() where status in ('requested', 'active', 'past_due', 'cancel_requested')");
    await db.query("update payments set status = 'cancelled' where status = 'pending'");
    await db.query("update agency_billing_settings set auto_past_due = false, auto_past_due_by = null, auto_past_due_at = null");
    await db.query("delete from worker_job_runs where job_name = 'maintenanceRenewalSweep'");
  });
  await setAgencyTimezone("UTC");
});
afterEach(() => {
  delete process.env.SCHEDULER_JOBS_ONLY;
  resetEnvCache();
});

const sweep = (over: Parameters<typeof runMaintenanceRenewalSweep>[0] = {}) => runMaintenanceRenewalSweep({ now: NOW, ...over });
const keys = (list: Array<{ dedupe_key: string | null }>) => [...new Set(list.map((n) => n.dedupe_key))].sort();

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The rules, with no database
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

describe("the renewal rules", () => {
  it("counts calendar days exactly, across months, a leap day and a year end", () => {
    expect(daysUntil("2026-11-17", "2026-11-10")).toBe(7);
    expect(daysUntil("2026-11-10", "2026-11-10")).toBe(0);
    expect(daysUntil("2026-11-09", "2026-11-10")).toBe(-1);
    expect(daysUntil("2027-01-02", "2026-12-30")).toBe(3);
    expect(daysUntil("2028-03-01", "2028-02-27")).toBe(3); // 2028 has a 29th of February
    expect(daysUntil("2027-03-01", "2027-02-27")).toBe(2);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-11-10", -10)).toBe("2026-10-31");
    for (let n = -400; n <= 400; n += 37) expect(daysUntil(addDays(TODAY, n), TODAY)).toBe(n);
  });

  it("returns nothing for what is not a date, and does not slow down on 20,000 characters", () => {
    for (const bad of ["", "2026-13-40x", "tomorrow", "2026-1-1", `${"9".repeat(20_000)}`, `${"2026-11-10".repeat(2000)}`, null, undefined]) {
      expect(daysUntil(bad as never, TODAY), String(bad).slice(0, 20)).toBeNull();
      expect(addDays(bad as never, 1), String(bad).slice(0, 20)).toBeNull();
    }
    expect(daysUntil(TODAY, "x".repeat(20_000))).toBeNull();
    expect(addDays(TODAY, 1.5)).toBeNull();
  });

  it("reminds at 7 days and at 1 day only: 2 to 7 days out reads 7, the last day and the day itself read 1, and nothing else reminds", () => {
    expect(RENEWAL_NOTICE_DAYS).toEqual([7, 1]);
    for (let left = -60; left <= 60; left++) {
      const level = renewalNoticeLevel(left);
      if (left < 0 || left > 7) expect(level, String(left)).toBeNull();
      else if (left <= 1) expect(level, String(left)).toBe(1);
      else expect(level, String(left)).toBe(7);
    }
    expect(renewalNoticeLevel(null)).toBeNull();
  });

  it("acts only on an active plan with a paid-through day; marks past due only with the switch on and two or more days over; stays quiet far past the window", () => {
    const statuses = ["requested", "active", "past_due", "cancel_requested", "expired", "cancelled", "declined", "nonsense"];
    for (const status of statuses) {
      for (let offset = -90; offset <= 30; offset++) {
        for (const autoPastDue of [false, true]) {
          const step = renewalStep({ status, paidThroughOn: plus(offset), today: TODAY, autoPastDue });
          const where = `${status} ${offset} ${autoPastDue}`;
          if (status !== "active") { expect(step.kind, where).toBe("none"); continue; }
          if (offset > 7) expect(step.kind, where).toBe("none");
          else if (offset >= 0) expect(step, where).toMatchObject({ kind: "notice", daysLeft: offset });
          else if (-offset > OVERDUE_NOTICE_WINDOW_DAYS) expect(step.kind, where).toBe("none");
          else {
            expect(step, where).toMatchObject({ kind: "overdue", daysOver: -offset });
            expect((step as { markPastDue: boolean }).markPastDue, where).toBe(autoPastDue && -offset >= AUTO_PAST_DUE_MIN_DAYS_OVER);
          }
        }
      }
    }
    // Nothing without a date, and never a past-due mark while the switch is off, whatever the age.
    expect(renewalStep({ status: "active", paidThroughOn: null, today: TODAY, autoPastDue: true }).kind).toBe("none");
    expect(renewalStep({ status: "active", paidThroughOn: plus(-20), today: TODAY, autoPastDue: false })).toMatchObject({ kind: "overdue", markPastDue: false });
  });

  it("calls a period ended only for an active plan, or one about to be cancelled, paid through a day before today", () => {
    expect(paidPeriodEnded("active", plus(-1), TODAY)).toBe(true);
    expect(paidPeriodEnded("cancel_requested", plus(-5), TODAY)).toBe(true);
    expect(paidPeriodEnded("active", TODAY, TODAY)).toBe(false);
    expect(paidPeriodEnded("active", plus(3), TODAY)).toBe(false);
    expect(paidPeriodEnded("active", null, TODAY)).toBe(false);
    for (const status of ["requested", "past_due", "expired", "cancelled", "declined", null]) expect(paidPeriodEnded(status, plus(-9), TODAY), String(status)).toBe(false);
  });

  it("closes a checkout only after 48 hours", () => {
    expect(STALE_CHECKOUT_HOURS).toBe(48);
    expect(staleCheckoutCutoff(NOW).toISOString()).toBe("2026-11-08T12:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

describe("the reminders before a plan's paid period ends", () => {
  it("tells the team and the owner at 7 days and again at 1 day, once each, naming the day and never saying a payment was seen", async () => {
    const o = await crmOrg();
    const sub = await planRow(o, { status: "active", paidThroughOn: plus(8) });
    expect(await sweep()).toMatchObject({ noticed: 0, overdue: 0, pastDue: 0, failed: 0 });
    expect(await noticesOf(o.org.id, "billing_renewal_due")).toEqual([]);

    await withSystem((db) => db.query("update maintenance_subscriptions set paid_through_on = $2 where id = $1", [sub, plus(7)]));
    expect(await sweep()).toMatchObject({ noticed: 1 });
    const week = await noticesOf(o.org.id, "billing_renewal_due");
    expect(keys(week)).toEqual([`renewal-due:${sub}:${plus(7)}:7`]);
    const toTeam = week.filter((n) => n.audience === "agency");
    const toOwner = week.filter((n) => n.audience === "client");
    expect(toTeam.length).toBeGreaterThan(0);
    expect(toOwner).toHaveLength(1);
    expect(toTeam[0].title).toContain(plus(7));
    expect(toTeam[0].body).toMatch(/in 7 days/);
    expect(toTeam[0].body).toMatch(/does not detect payments by itself/);
    expect(toOwner[0].title).toBe(`Your maintenance plan is paid through ${plus(7)}`);
    expect(toOwner[0].body).toMatch(/arranged with iAcquire/);
    expect(week.map((n) => n.severity)).toEqual(Array(week.length).fill("info"));
    for (const n of week) expect(`${n.title} ${n.body}`).not.toMatch(/detected|received your payment|payment failed|didn't go through/i);

    // Running it again, and a day later (still the seven-day level), adds nothing.
    await sweep();
    await runMaintenanceRenewalSweep({ now: new Date(NOW.getTime() + DAY) });
    expect((await noticesOf(o.org.id, "billing_renewal_due")).length).toBe(week.length);

    // At one day it reminds again, with its own key and a warning.
    await withSystem((db) => db.query("update maintenance_subscriptions set paid_through_on = $2 where id = $1", [sub, plus(1)]));
    await sweep();
    const last = (await noticesOf(o.org.id, "billing_renewal_due")).filter((n) => n.dedupe_key === `renewal-due:${sub}:${plus(1)}:1`);
    expect(last.length).toBeGreaterThan(0);
    expect(last.every((n) => n.severity === "warning")).toBe(true);
    expect(last.find((n) => n.audience === "client")?.body).toMatch(/tomorrow/);
  });

  it("sends the one-day reminder alone when the first run is that late, and a renewed period gets fresh reminders", async () => {
    const o = await crmOrg();
    const sub = await planRow(o, { status: "active", paidThroughOn: plus(1) });
    await sweep();
    expect(keys(await noticesOf(o.org.id, "billing_renewal_due"))).toEqual([`renewal-due:${sub}:${plus(1)}:1`]);
    const first = (await noticesOf(o.org.id, "billing_renewal_due")).length;
    // A payment is recorded for the next month: the paid-through day moves, nothing is said yet, and its own reminders follow in time.
    await withSystem((db) => db.query("update maintenance_subscriptions set paid_through_on = $2 where id = $1", [sub, plus(31)]));
    await sweep();
    expect((await noticesOf(o.org.id, "billing_renewal_due")).length).toBe(first);
    const later = new Date(NOW.getTime() + 25 * DAY);
    await runMaintenanceRenewalSweep({ now: later });
    expect(keys(await noticesOf(o.org.id, "billing_renewal_due"))).toEqual([`renewal-due:${sub}:${plus(1)}:1`, `renewal-due:${sub}:${plus(31)}:7`].sort());
  });

  it("leaves alone a plan that is not active, a workspace that is suspended or archived, and a plan with no paid-through day", async () => {
    const mixed = await Promise.all(["requested", "past_due", "cancel_requested", "expired", "cancelled", "declined"].map(async (status) => {
      const o = await crmOrg();
      await planRow(o, { status: status as never, paidThroughOn: plus(3), ...(status === "past_due" ? { graceEndsAt: new Date(NOW.getTime() + 3 * DAY) } : {}) });
      return o;
    }));
    const suspended = await crmOrg();
    await planRow(suspended, { status: "active", paidThroughOn: plus(3) });
    await withSystem((db) => db.query("update organizations set status = 'suspended' where id = $1", [suspended.org.id]));
    const archived = await crmOrg();
    await planRow(archived, { status: "active", paidThroughOn: plus(-5) });
    await withSystem((db) => db.query("update organizations set status = 'archived' where id = $1", [archived.org.id]));
    const noDate = await crmOrg();
    await planRow(noDate, { status: "active", paidThroughOn: null });
    expect(await sweep()).toMatchObject({ noticed: 0, overdue: 0, pastDue: 0 });
    for (const o of [...mixed, suspended, archived, noDate]) expect(await noticesOf(o.org.id, "billing_renewal_due"), o.org.id).toEqual([]);
  });

  it("judges the day in the agency's time zone, not UTC", async () => {
    const o = await crmOrg();
    const sub = await planRow(o, { status: "active", paidThroughOn: "2026-11-10" });
    const lateUtc = new Date("2026-11-10T20:00:00Z"); // 2026-11-10 in UTC, already 2026-11-11 in Auckland
    await setAgencyTimezone("UTC");
    await runMaintenanceRenewalSweep({ now: lateUtc });
    expect(keys(await noticesOf(o.org.id, "billing_renewal_due"))).toEqual([`renewal-due:${sub}:2026-11-10:1`]);
    await setAgencyTimezone("Pacific/Auckland");
    await runMaintenanceRenewalSweep({ now: lateUtc });
    expect(keys(await noticesOf(o.org.id, "billing_renewal_due"))).toEqual([`renewal-due:${sub}:2026-11-10:1`, `renewal-overdue:${sub}:2026-11-10`].sort());
    await setAgencyTimezone("UTC");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The paid-through day passes
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

describe("a plan whose paid-through day has passed with no payment recorded", () => {
  it("tells the team once and changes nothing else while the automatic switch is off (the default)", async () => {
    const o = await crmOrg();
    const sub = await planRow(o, { status: "active", paidThroughOn: plus(-4) });
    const studio = await studioWorkflowFor(o);
    const core = await coreWorkflowFor(o);
    const before = await withSystem((db) => studioEntitlement(db, o.org.id, NOW));
    expect(before).toMatchObject({ entitled: true, state: "active" });

    expect(await sweep()).toMatchObject({ overdue: 1, pastDue: 0 });
    await sweep();
    await runMaintenanceRenewalSweep({ now: new Date(NOW.getTime() + 3 * DAY) });

    const team = await noticesOf(o.org.id, "billing_renewal_due", "agency");
    expect(keys(team)).toEqual([`renewal-overdue:${sub}:${plus(-4)}`]);
    expect(team[0].severity).toBe("warning");
    expect(team[0].body).toMatch(/no payment has been recorded since/);
    expect(team[0].body).toMatch(/Nothing changes by itself/);
    // The client was not alarmed, the plan and its entitlement are exactly as they were, and nothing was paused.
    expect(await noticesOf(o.org.id, "billing_renewal_due", "client")).toEqual([]);
    expect(await noticesOf(o.org.id, "maintenance_update", "client")).toEqual([]);
    expect(await planStatus(sub)).toMatchObject({ status: "active", past_due_since: null, grace_ends_at: null });
    expect(await withSystem((db) => studioEntitlement(db, o.org.id, NOW))).toEqual(before);
    expect(await workflowRow(studio)).toMatchObject({ status: "active", entitlement_paused_at: null });
    expect(await workflowRow(core)).toMatchObject({ status: "active" });
    expect(await auditOf(o.org.id, "maintenance.payment_failed")).toEqual([]);
  });

  it("marks it past due as the system once the period ended two days ago, only with the switch on, with the disclosed grace period and honest words", async () => {
    const o = await crmOrg();
    const sub = await planRow(o, { status: "active", paidThroughOn: plus(-1) });
    const studio = await studioWorkflowFor(o);
    await setAutoPastDue(superAdmin, true);

    // One day over: the team is told, and the plan is not marked yet.
    expect(await sweep()).toMatchObject({ overdue: 1, pastDue: 0 });
    expect(await planStatus(sub)).toMatchObject({ status: "active" });
    const told = await noticesOf(o.org.id, "billing_renewal_due", "agency");
    expect(told[0].body).toMatch(new RegExp(`marked past due on ${plus(1)}`));

    // Two days over: it is.
    await withSystem((db) => db.query("update maintenance_subscriptions set paid_through_on = $2 where id = $1", [sub, plus(-2)]));
    expect(await sweep()).toMatchObject({ overdue: 1, pastDue: 1 });
    const row = await planStatus(sub);
    expect(row.status).toBe("past_due");
    expect(new Date(row.past_due_since as Date).toISOString()).toBe(NOW.toISOString());
    expect(new Date(row.grace_ends_at as Date).toISOString()).toBe(new Date(NOW.getTime() + 7 * DAY).toISOString());
    expect(row.last_payment_verified_by).toBeNull();

    // Automation Studio keeps working through the grace period; nothing is paused or deleted.
    expect(await withSystem((db) => studioEntitlement(db, o.org.id, NOW))).toMatchObject({ entitled: true, state: "past_due" });
    expect(await workflowRow(studio)).toMatchObject({ status: "active", entitlement_paused_at: null });

    // The owner is told the truth: nothing was recorded, which is not the same as a payment that failed.
    const owner = (await noticesOf(o.org.id, "maintenance_update", "client")).filter((n) => /recorded a payment/.test(n.title));
    expect(owner).toHaveLength(1);
    expect(owner[0].title).toBe("iAcquire hasn't recorded a payment for your maintenance plan");
    expect(owner[0].body).toContain(`paid through ${plus(-2)}`);
    expect(owner[0].body).toContain(addDays(TODAY, 7));
    expect(owner[0].body).toMatch(/If you have already paid, contact iAcquire/);
    expect(owner[0].body).toMatch(/nothing is deleted/);
    expect((await noticesOf(o.org.id, "maintenance_update", "client")).some((n) => /didn't go through/.test(n.title))).toBe(false);
    const auto = await noticesOf(o.org.id, "billing_renewal_due", "agency");
    expect(keys(auto)).toContain(`renewal-auto:${sub}:${plus(-2)}`);

    const audit = await auditOf(o.org.id, "maintenance.payment_failed");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_kind: "system", actor_user_id: null });
    expect(audit[0].metadata).toMatchObject({ cause: "no_payment_recorded", paidThroughOn: plus(-2), graceDays: 7 });

    // Running it again changes and says nothing more.
    const countBefore = (await noticesOf(o.org.id, "maintenance_update")).length + (await noticesOf(o.org.id, "billing_renewal_due")).length;
    expect(await sweep()).toMatchObject({ overdue: 0, pastDue: 0 });
    expect((await noticesOf(o.org.id, "maintenance_update")).length + (await noticesOf(o.org.id, "billing_renewal_due")).length).toBe(countBefore);
    expect((await auditOf(o.org.id, "maintenance.payment_failed")).length).toBe(1);

    // And a recorded payment brings it back, as for any past-due plan.
    await recordVerifiedPayment(superAdmin, sub, { paidThroughOn: plus(25) }, NOW);
    expect(await planStatus(sub)).toMatchObject({ status: "active", past_due_since: null, grace_ends_at: null });
  });

  it("reads the switch from the database on every run, and never marks a plan the switch was off for", async () => {
    const a = await crmOrg();
    const b = await crmOrg();
    const subA = await planRow(a, { status: "active", paidThroughOn: plus(-5) });
    await sweep();
    expect((await planStatus(subA)).status).toBe("active");
    await setAutoPastDue(superAdmin, true);
    const subB = await planRow(b, { status: "active", paidThroughOn: plus(-5) });
    await sweep();
    expect((await planStatus(subA)).status).toBe("past_due");
    expect((await planStatus(subB)).status).toBe("past_due");
    await setAutoPastDue(superAdmin, false);
    const c = await crmOrg();
    const subC = await planRow(c, { status: "active", paidThroughOn: plus(-5) });
    await sweep();
    expect((await planStatus(subC)).status).toBe("active");
  });

  it("does not mark a plan whose payment was recorded in the same moment: a recorded payment wins, whichever gets the row first", async () => {
    const o = await crmOrg();
    const sub = await planRow(o, { status: "active", paidThroughOn: plus(-3) });
    await setAutoPastDue(superAdmin, true);
    const [, paid] = await Promise.all([sweep(), recordVerifiedPayment(superAdmin, sub, { paidThroughOn: plus(27) }, NOW)]);
    expect(paid).toMatchObject({ reactivated: expect.any(Boolean) });
    const row = await planStatus(sub);
    // Either the payment came first (never marked) or the mark came first and the payment brought the plan back: both end active, paid through the new day.
    expect(row).toMatchObject({ status: "active", past_due_since: null, grace_ends_at: null, paid_through_on: plus(27) });
    expect((await auditOf(o.org.id, "maintenance.payment_failed")).length).toBeLessThanOrEqual(1);
  });

  it("leaves a plan alone that is long past the window the team was told about", async () => {
    const o = await crmOrg();
    await planRow(o, { status: "active", paidThroughOn: plus(-(OVERDUE_NOTICE_WINDOW_DAYS + 5)) });
    await setAutoPastDue(superAdmin, true);
    expect(await sweep()).toMatchObject({ overdue: 0, pastDue: 0 });
    expect(await noticesOf(o.org.id, "billing_renewal_due")).toEqual([]);
  });
});

describe("the automatic past-due switch", () => {
  it("is off in a fresh database, can only be changed by a Super Admin, and every change is audited", async () => {
    const manager = agencyUser(await createUser({ platformRole: "agency_manager" }), "agency_manager");
    const staff = agencyUser(await createUser({ platformRole: "agency_staff" }), "agency_staff");
    // Its own Super Admin, so the audit trail read back below is this test's alone.
    const superAdmin = agencyUser(await createUser({ platformRole: "agency_super_admin" }), "agency_super_admin");
    const read = async () => (await rows<{ auto_past_due: boolean; auto_past_due_by: string | null; auto_past_due_at: Date | null }>("select auto_past_due, auto_past_due_by, auto_past_due_at from agency_billing_settings"))[0];
    expect(await read()).toMatchObject({ auto_past_due: false, auto_past_due_by: null, auto_past_due_at: null });
    for (const who of [manager, staff]) await expect(setAutoPastDue(who, true)).rejects.toThrow(/Only a super admin/);
    expect((await read()).auto_past_due).toBe(false);
    await setAutoPastDue(superAdmin, true);
    expect(await read()).toMatchObject({ auto_past_due: true, auto_past_due_by: superAdmin.id });
    expect((await getAgencyBillingOverview(superAdmin)).planRenewals).toMatchObject({ autoPastDue: true, graceDays: 7, minDaysOver: AUTO_PAST_DUE_MIN_DAYS_OVER });
    await setAutoPastDue(superAdmin, false);
    expect((await getAgencyBillingOverview(superAdmin)).planRenewals).toMatchObject({ autoPastDue: false });
    const audit = await rows<{ action: string; actor_user_id: string }>("select action, actor_user_id from audit_logs where action like 'billing.auto_past_due_%' and actor_user_id = $1 order by created_at, id", [superAdmin.id]);
    expect(audit.map((a) => a.action)).toEqual(["billing.auto_past_due_enabled", "billing.auto_past_due_disabled"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Checkouts nobody completed
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

describe("checkouts nobody completed", () => {
  const exact = usdToChargeMinor(usdToMicros(1499), 58);
  const deliver = (body: string) => handlePaymongoWebhook({ rawBody: body, signatureHeader: signPaymongo(body) });
  async function checkout(id: string, agedHours: number) {
    const c = await onboardedClient();
    const { impl } = mockCheckoutFetch(id);
    const made = await createPaymentCheckout({ orgId: c.org.id, kind: "setup_fee", usdMicros: usdToMicros(1499), description: "iAcquire setup", requestedBy: superAdmin.id }, { fetch: impl });
    await withSystem((db) => db.query("update payments set created_at = $2 where id = $1", [made.paymentId, new Date(NOW.getTime() - agedHours * 3_600_000).toISOString()]));
    return { ...c, made };
  }
  const status = async (paymentId: string) => (await rows<{ status: string; failure_reason: string | null }>("select status, failure_reason from payments where id = $1", [paymentId]))[0];

  it("closes only those older than 48 hours, records it, and lets a second setup checkout start", async () => {
    const stale = await checkout("cs_stale_1", STALE_CHECKOUT_HOURS + 1);
    const fresh = await checkout("cs_fresh_1", STALE_CHECKOUT_HOURS - 1);
    expect(await sweep()).toMatchObject({ checkoutsExpired: 1 });
    expect(await status(stale.made.paymentId)).toEqual({ status: "expired", failure_reason: "The checkout was not completed in time" });
    expect((await status(fresh.made.paymentId)).status).toBe("pending");
    const audit = await auditOf(stale.org.id, "billing.checkout_expired");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_kind: "system" });
    // Closing it frees the one open setup checkout, so the client is no longer stuck; the fresh one still blocks.
    const { impl } = mockCheckoutFetch("cs_stale_2");
    const second = await createPaymentCheckout({ orgId: stale.org.id, kind: "setup_fee", usdMicros: usdToMicros(1499), description: "iAcquire setup", requestedBy: superAdmin.id }, { fetch: impl });
    expect(second.referenceNumber).toMatch(/^IAQ-/);
    await expect(createPaymentCheckout({ orgId: fresh.org.id, kind: "setup_fee", usdMicros: usdToMicros(1499), description: "iAcquire setup", requestedBy: superAdmin.id }, { fetch: impl })).rejects.toThrow(/already open/);
    // A second run closes nothing more (the new checkout is dated at the sweep's own clock, which these tests move ahead of the real one).
    await withSystem((db) => db.query("update payments set created_at = $2 where id = $1", [second.paymentId, NOW.toISOString()]));
    expect(await sweep()).toMatchObject({ checkoutsExpired: 0 });
  });

  it("still records money that arrives for a checkout it closed, and clears the setup fee exactly once", async () => {
    const c = await checkout("cs_stale_late", STALE_CHECKOUT_HOURS + 6);
    await sweep();
    expect((await status(c.made.paymentId)).status).toBe("expired");
    const out = await deliver(paymongoPaidEvent({ checkoutId: "cs_stale_late", reference: c.made.referenceNumber, amount: exact }));
    expect(out.outcome).toBe("processed");
    expect((await status(c.made.paymentId)).status).toBe("paid");
    expect(await setupStatus(c.org.id)).toMatchObject({ setup_payment_status: "paid", verified_payment_id: c.made.paymentId });
    expect(await deliver(paymongoPaidEvent({ checkoutId: "cs_stale_late", reference: c.made.referenceNumber, amount: exact, eventId: "evt_stale_late_2" }))).toMatchObject({ outcome: "ignored" });
    expect((await rows("select 1 from notifications where user_id = $1 and kind = 'billing_setup_cleared'", [c.owner.id])).length).toBe(1);
  });

  it("never touches a payment that was paid or that already ended some other way, however old", async () => {
    const c = await onboardedClient();
    await withSystem((db) => db.query(
      `insert into payments (org_id, kind, status, description, usd_amount_micros, charged_currency, charged_amount_minor, livemode, provider, reference_number, paid_at, created_at)
       values ($1, 'other', 'paid', 'Old paid payment', 5000000, 'PHP', 29000, false, 'paymongo', 'IAQ-OLDPAID0001', now() - interval '10 days', now() - interval '10 days'),
              ($1, 'other', 'failed', 'Old failed payment', 5000000, 'PHP', 29000, false, 'paymongo', 'IAQ-OLDFAIL0001', null, now() - interval '10 days')`, [c.org.id]));
    await sweep();
    expect((await rows<{ reference_number: string; status: string }>("select reference_number, status from payments where org_id = $1 order by reference_number", [c.org.id]))).toEqual([
      { reference_number: "IAQ-OLDFAIL0001", status: "failed" }, { reference_number: "IAQ-OLDPAID0001", status: "paid" },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Pages, budget and fairness
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

describe("how much it does in one run", () => {
  it("works through more plans than one page holds, each exactly once, oldest paid-through day first", async () => {
    const made = [] as Array<{ orgId: string; sub: string; through: string }>;
    for (let i = 0; i < 7; i++) {
      const o = await crmOrg();
      const through = plus(-(i + 1));
      made.push({ orgId: o.org.id, sub: await planRow(o, { status: "active", paidThroughOn: through }), through });
    }
    const result = await sweep({ batch: 3 });
    expect(result).toMatchObject({ overdue: 7, pastDue: 0, failed: 0 });
    for (const m of made) expect(keys(await noticesOf(m.orgId, "billing_renewal_due", "agency")), m.through).toEqual([`renewal-overdue:${m.sub}:${m.through}`]);
  });

  it("does each plan once when two runs start together: one marking, one audit line, one notice per person and key", async () => {
    const o = await crmOrg();
    const sub = await planRow(o, { status: "active", paidThroughOn: plus(-4) });
    const old = (await rows<{ id: string }>("insert into payments (org_id, kind, description, usd_amount_micros, charged_currency, charged_amount_minor, livemode, provider, reference_number, status, created_at) values ($1, 'other', 'Old', 10000000, 'PHP', 58000, false, 'paymongo', $2, 'pending', $3) returning id", [o.org.id, `IAQ-CONC${Date.now()}`, new Date(NOW.getTime() - 60 * 3_600_000).toISOString()]))[0];
    await setAutoPastDue(superAdmin, true);
    const [a, b] = await Promise.all([sweep(), sweep()]);
    expect(a.pastDue + b.pastDue).toBe(1);
    expect(a.checkoutsExpired + b.checkoutsExpired).toBe(1);
    expect(a.failed + b.failed).toBe(0);
    expect(await planStatus(sub)).toMatchObject({ status: "past_due" });
    expect(await auditOf(o.org.id, "maintenance.payment_failed")).toHaveLength(1);
    expect(await auditOf(o.org.id, "billing.checkout_expired")).toHaveLength(1);
    expect((await rows<{ status: string }>("select status from payments where id = $1", [old.id]))[0].status).toBe("expired");
    const perPerson = (await noticesOf(o.org.id, "billing_renewal_due")).map((n) => `${n.user_id}:${n.dedupe_key}`);
    expect(new Set(perPerson).size).toBe(perPerson.length);
  });

  it("does nothing when its time is already spent, and the next run picks up where there was nothing yet", async () => {
    const o = await crmOrg();
    await planRow(o, { status: "active", paidThroughOn: plus(-1) });
    expect(await sweep({ budgetMs: -1 })).toMatchObject({ noticed: 0, overdue: 0, pastDue: 0, checkoutsExpired: 0 });
    expect(await noticesOf(o.org.id, "billing_renewal_due")).toEqual([]);
    expect(await sweep()).toMatchObject({ overdue: 1 });
    expect(RENEWAL_SWEEP_BUDGET_MS).toBe(30_000);
    expect(RENEWAL_SWEEP_BATCH).toBe(100);
  });

  it("keeps one plan's failure from stopping the others, and leaves nothing half done for the plan that failed", async () => {
    const bad = await crmOrg();
    const badSub = await planRow(bad, { status: "active", paidThroughOn: plus(-3) });
    const good = await crmOrg();
    const goodSub = await planRow(good, { status: "active", paidThroughOn: plus(-2) });
    await setAutoPastDue(superAdmin, true);
    // The database refuses to move the bad workspace's plan into past due, so that plan's pass fails part-way: the earlier writes of the same pass go with it.
    await withSystem(async (db) => {
      await db.query(`create function test_block_past_due() returns trigger language plpgsql as $$ begin
        if new.status = 'past_due' and new.org_id = '${bad.org.id}' then raise exception 'blocked for the test'; end if; return new; end $$`);
      await db.query("create trigger test_block_past_due before update on maintenance_subscriptions for each row execute function test_block_past_due()");
    });
    try {
      const result = await sweep();
      expect(result).toMatchObject({ failed: 1, pastDue: 1 });
      expect((await planStatus(goodSub)).status).toBe("past_due");
      expect((await planStatus(badSub)).status).toBe("active");
      expect(await noticesOf(bad.org.id, "billing_renewal_due")).toEqual([]);
    } finally {
      await withSystem(async (db) => {
        await db.query("drop trigger test_block_past_due on maintenance_subscriptions");
        await db.query("drop function test_block_past_due()");
      });
    }
    // The next run does what the failed one could not.
    expect(await sweep()).toMatchObject({ failed: 0, pastDue: 1 });
    expect((await planStatus(badSub)).status).toBe("past_due");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

describe("the job", () => {
  const releaseLease = () => withSystem((db) => db.query("update worker_job_runs set last_finished_at = now() - interval '5 minutes' where job_name = 'scheduler_tick' and last_finished_at is not null"));
  async function runTick() {
    await releaseLease();
    const res = await tick(new Request("http://localhost/api/internal/tick", { method: "POST", headers: { authorization: `Bearer ${CRON}` } }));
    return { status: res.status, ran: ((await res.json()) as { ran: Record<string, number | string> }).ran };
  }
  const setOnly = (value: string | undefined) => {
    if (value === undefined) delete process.env.SCHEDULER_JOBS_ONLY;
    else process.env.SCHEDULER_JOBS_ONLY = value;
    resetEnvCache();
  };

  it("is registered once, every six hours, after the Automation Studio sweep, with a plain label and a time budget", () => {
    const names = JOBS.map((j) => j.name);
    expect(names.filter((n) => n === "maintenanceRenewalSweep")).toHaveLength(1);
    const job = JOBS.find((j) => j.name === "maintenanceRenewalSweep");
    expect(job?.everyMinutes).toBe(360);
    expect(job?.run.toString()).toContain("budgetMs");
    expect(names.indexOf("maintenanceRenewalSweep")).toBe(names.indexOf("studioEntitlementSweep") + 1);
    expect(JOB_LABELS.maintenanceRenewalSweep.length).toBeGreaterThan(30);
  });

  it("is named in both operator documents, with its switch and what it never does", () => {
    const scheduler = readFileSync("docs/production-scheduler.md", "utf8");
    const impact = readFileSync("docs/unified-inbox/scheduler-impact.md", "utf8");
    for (const doc of [scheduler, impact]) {
      expect(doc).toContain("`maintenanceRenewalSweep`");
      expect(doc).toMatch(/mark past due automatically/);
      expect(doc).toMatch(/off/i);
    }
    expect(scheduler).toMatch(/never pauses, expires, refunds or revokes anything/);
    expect(impact).toMatch(/Added since \(2026-10-24\): maintenance plan renewals/);
  });

  it("runs on the tick only when it is named in a staged start, leaving a heartbeat then and none otherwise", async () => {
    const o = await crmOrg();
    const sub = await planRow(o, { status: "active", paidThroughOn: dayAfterNow(-1) });
    setOnly("aiWorkRecovery");
    const other = await runTick();
    expect(other.status).toBe(200);
    expect(Object.keys(other.ran)).toEqual(["aiWorkRecovery"]);
    expect(await rows("select 1 from worker_job_runs where job_name = 'maintenanceRenewalSweep'")).toHaveLength(0);
    expect(await noticesOf(o.org.id, "billing_renewal_due")).toEqual([]);

    setOnly("maintenanceRenewalSweep");
    const named = await runTick();
    expect(named.status).toBe(200);
    expect(Object.keys(named.ran)).toEqual(["maintenanceRenewalSweep"]);
    expect(typeof named.ran.maintenanceRenewalSweep).toBe("number");
    expect(await rows("select 1 from worker_job_runs where job_name = 'maintenanceRenewalSweep'")).toHaveLength(1);
    expect(keys(await noticesOf(o.org.id, "billing_renewal_due", "agency")).length).toBe(1);
    expect(await planStatus(sub)).toMatchObject({ status: "active" });
  });
});

/** A day relative to the real clock (the tick passes no simulated time). */
function dayAfterNow(n: number): string {
  return new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
}
