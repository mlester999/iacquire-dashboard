import "server-only";
import { withSystem } from "@/server/db";
import { env } from "@/server/env";
import { recordAudit } from "@/server/audit";
import { notifyAgency, notifyOrgRoles } from "@/server/notifications";
import { applyPaymentFailed } from "@/server/maintenance/lapse";
import { sanitizeErrorText } from "@/lib/ops";
import { todayIn } from "@/lib/invoices/state";
import {
  AUTO_PAST_DUE_MIN_DAYS_OVER, OVERDUE_NOTICE_WINDOW_DAYS, RENEWAL_SWEEP_BATCH, RENEWAL_SWEEP_BUDGET_MS, addDays, renewalStep, renewalWhen, staleCheckoutCutoff,
} from "@/lib/billing-renewal";

// The scheduled pass over the maintenance plan's renewals (job maintenanceRenewalSweep, every six hours). It runs only when the scheduler does, and in a staged start only when
// SCHEDULER_JOBS_ONLY names it. What it does is bounded and happens once per plan and paid period:
//   * seven days and one day before the day a plan is paid through, the team and the client's owners are reminded;
//   * once the paid-through day has passed with no payment recorded, the team is told;
//   * ONLY if a Super Admin switched "mark past due automatically" on (it is off), a plan whose paid period ended two or more days ago is marked past due, as the system, with the
//     same disclosed grace period a person's record starts. This job never expires, pauses, refunds or revokes anything itself. A plan it marks past due follows the usual path: a
//     recorded payment brings it back, and if none is recorded by the end of the grace period the plan sweep (studioEntitlementSweep) expires it and pauses its Automation Studio
//     workflows, as for a plan a person marked past due. The owner is told that date;
//   * a checkout nobody completed for 48 hours is closed, so an abandoned one cannot block a second setup checkout for ever. A payment that arrives for it later is still recorded.
// It sends nothing to a customer outside the portal, calls no payment provider, and never says a payment was detected: a missing record is a missing record. Every step is idempotent
// (notice keys per plan and period, a plan row locked and read again before it changes) and works in pages inside a time budget; what it did not reach waits for the next run.

export interface RenewalSweepResult {
  /**
   * Plans in their reminder window whose reminder is in place. A reminder is sent once per plan, level and paid period (the notice key drops a repeat), so this counts plans looked
   * after in this run, not new messages: a plan in its window is looked at again on each run until its window passes.
   */
  noticed: number;
  /** Plans past their paid-through day whose team notice is in place (same counting). */
  overdue: number;
  /** Plans marked past due by the sweep itself (only while the automatic switch is on). */
  pastDue: number;
  /** Pending checkouts closed because nobody completed them. */
  checkoutsExpired: number;
  /** Plans whose pass failed (logged without detail; the next run tries again). */
  failed: number;
}

const ZERO = (): RenewalSweepResult => ({ noticed: 0, overdue: 0, pastDue: 0, checkoutsExpired: 0, failed: 0 });
const ADMIN_LINK = "/admin/maintenance";
const CLIENT_LINK = "/maintenance";

interface PlanRow {
  id: string;
  org_id: string;
  status: string;
  paid_through_on: string | null;
  org_name: string;
  org_status: string;
}

async function settings(): Promise<{ today: (now: Date) => string; autoPastDue: boolean }> {
  const row = await withSystem(async (db) => ({
    tz: (await db.query<{ timezone: string }>("select timezone from organizations where kind = 'agency' limit 1")).rows[0]?.timezone ?? "UTC",
    auto: (await db.query<{ auto_past_due: boolean }>("select auto_past_due from agency_billing_settings limit 1")).rows[0]?.auto_past_due === true,
  }));
  return { today: (now) => todayIn(now, row.tz), autoPastDue: row.auto };
}

type Outcome = "noticed" | "overdue" | "pastDue" | "none";

/** One plan, in one transaction: locked, read again, and judged by its current paid-through day (a payment recorded a moment ago wins). */
async function handlePlan(id: string, today: string, now: Date, autoPastDue: boolean): Promise<Outcome[]> {
  return withSystem(async (db) => {
    const s = (await db.query<PlanRow>(
      `select s.id, s.org_id, s.status, s.paid_through_on::text as paid_through_on, o.name as org_name, o.status as org_status
         from maintenance_subscriptions s join organizations o on o.id = s.org_id where s.id = $1 for update of s`,
      [id],
    )).rows[0];
    if (!s || s.org_status === "suspended" || s.org_status === "archived") return ["none"];
    const step = renewalStep({ status: s.status, paidThroughOn: s.paid_through_on, today, autoPastDue });
    const through = s.paid_through_on as string;
    if (step.kind === "none") return ["none"];

    if (step.kind === "notice") {
      const key = `renewal-due:${s.id}:${through}:${step.level}`;
      const when = renewalWhen(step.daysLeft);
      await notifyAgency(db, s.org_id, {
        kind: "billing_renewal_due",
        severity: step.level === 1 ? "warning" : "info",
        title: `${s.org_name}'s maintenance plan is paid through ${through}`,
        body: `That is ${when}. Check whether the next payment has arrived and record it so the plan carries on. The portal does not detect payments by itself.`,
        link: ADMIN_LINK,
        dedupeKey: key,
      });
      await notifyOrgRoles(db, s.org_id, ["owner"], {
        kind: "billing_renewal_due",
        severity: step.level === 1 ? "warning" : "info",
        title: `Your maintenance plan is paid through ${through}`,
        body: `That is ${when}. Payment for the next period is arranged with iAcquire, who record it once it has arrived. Automation Studio keeps working while the plan is active.`,
        link: CLIENT_LINK,
        dedupeKey: key,
      });
      return ["noticed"];
    }

    const out: Outcome[] = ["overdue"];
    const decideBy = addDays(through, AUTO_PAST_DUE_MIN_DAYS_OVER);
    await notifyAgency(db, s.org_id, {
      kind: "billing_renewal_due",
      severity: "warning",
      title: `${s.org_name}'s maintenance plan is past its paid-through day`,
      body: `It was paid through ${through} (${step.daysOver} day${step.daysOver === 1 ? "" : "s"} ago) and no payment has been recorded since. Record the payment, or record a failed payment to start the grace period. ${
        autoPastDue ? `The automatic past-due setting is on: if nothing is recorded, the plan is marked past due on ${decideBy}.` : "Nothing changes by itself: the plan stays active until someone records otherwise."
      }`,
      link: ADMIN_LINK,
      dedupeKey: `renewal-overdue:${s.id}:${through}`,
    });
    if (step.markPastDue) {
      const { graceEndsAt } = await applyPaymentFailed(db, {
        subscription: s, actor: { kind: "system", userId: null }, graceDays: env().STUDIO_PAYMENT_GRACE_DAYS, now, cause: "not_recorded", paidThroughOn: through,
      });
      await notifyAgency(db, s.org_id, {
        kind: "billing_renewal_due",
        severity: "warning",
        title: `${s.org_name}'s maintenance plan was marked past due automatically`,
        body: `No payment was recorded after ${through}. Automation Studio keeps working until ${graceEndsAt.toISOString().slice(0, 10)}. Recording a payment before then brings the plan back to active; nothing was paused or deleted.`,
        link: ADMIN_LINK,
        dedupeKey: `renewal-auto:${s.id}:${through}`,
      });
      out.push("pastDue");
    }
    return out;
  });
}

/** Closes pending checkouts nobody completed. Takes rows no other worker holds, oldest first. */
async function expireStaleCheckouts(now: Date, batch: number, deadline: number): Promise<number> {
  let total = 0;
  while (Date.now() < deadline) {
    const n = await withSystem(async (db) => {
      const rows = (await db.query<{ id: string; org_id: string; kind: string }>(
        `update payments set status = 'expired', failure_reason = 'The checkout was not completed in time'
          where id in (select id from payments where status = 'pending' and created_at < $1 order by created_at, id limit $2 for update skip locked)
          returning id, org_id, kind`,
        [staleCheckoutCutoff(now).toISOString(), batch],
      )).rows;
      for (const p of rows) {
        await recordAudit({ orgId: p.org_id, actorKind: "system", action: "billing.checkout_expired", targetType: "payment", targetId: p.id, result: "success", metadata: { kind: p.kind } }, db);
      }
      return rows.length;
    });
    total += n;
    if (n < batch) break;
  }
  return total;
}

export async function runMaintenanceRenewalSweep(opts: { now?: Date; budgetMs?: number; batch?: number } = {}): Promise<RenewalSweepResult> {
  const now = opts.now ?? new Date();
  const deadline = Date.now() + (opts.budgetMs ?? RENEWAL_SWEEP_BUDGET_MS);
  const batch = Math.min(Math.max(Math.floor(opts.batch ?? RENEWAL_SWEEP_BATCH), 1), 500);
  const out = ZERO();
  const { today: todayOf, autoPastDue } = await settings();
  const today = todayOf(now);

  // Plans paid through from about two months ago to a week ahead, oldest day first, a page at a time. A page that was fully handled leaves nothing to find again: a plan that was
  // noticed keeps its key, one that was marked past due is no longer active, and a recorded payment moved its paid-through day out of the window.
  let afterDay = "0001-01-01";
  let afterId = "00000000-0000-0000-0000-000000000000";
  while (Date.now() < deadline) {
    const page = (await withSystem((db) =>
      db.query<{ id: string; paid_through_on: string }>(
        `select s.id, s.paid_through_on::text as paid_through_on from maintenance_subscriptions s
          where s.status = 'active' and s.paid_through_on is not null
            and s.paid_through_on <= ($1::date + 7) and s.paid_through_on >= ($1::date - $2::int)
            and (s.paid_through_on, s.id) > ($3::date, $4::uuid)
          order by s.paid_through_on, s.id limit $5`,
        [today, OVERDUE_NOTICE_WINDOW_DAYS, afterDay, afterId, batch],
      ),
    )).rows;
    if (!page.length) break;
    for (const p of page) {
      if (Date.now() >= deadline) break;
      try {
        for (const o of await handlePlan(p.id, today, now, autoPastDue)) {
          if (o === "noticed") out.noticed += 1;
          else if (o === "overdue") out.overdue += 1;
          else if (o === "pastDue") out.pastDue += 1;
        }
      } catch (e) {
        out.failed += 1;
        console.error("[iacquire] a maintenance renewal could not be processed", { error: sanitizeErrorText(e, 120) });
      }
      afterDay = p.paid_through_on;
      afterId = p.id;
    }
    if (page.length < batch) break;
  }

  out.checkoutsExpired = await expireStaleCheckouts(now, batch, deadline);
  return out;
}
