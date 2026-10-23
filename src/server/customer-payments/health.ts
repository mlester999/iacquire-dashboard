import "server-only";
import type { Queryable } from "@/server/db";
import type { Observation } from "@/server/ops/incidents";

// What the health check (src/server/ops/collectors.ts, prefix "customer-payments:") reads about customers' payments. Recorded evidence only: it never calls a provider.
// These are the businesses' own money, so the owner and managers see them as well as the iAcquire team, in plain words, and the observations carry counts and ids only,
// never a customer's name, an amount or a key. Nothing here is about iAcquire's own billing (that is the "payments:" check).

/** A delivery that arrived and was never applied. */
export const STUCK_MINUTES = 10;
/** A payment that needed a person this long ago and still does. */
export const REVIEW_HOURS = 24;

const minutesAgo = (now: Date, m: number) => new Date(now.getTime() - m * 60_000).toISOString();

export async function customerPaymentObservations(db: Queryable, now: Date): Promise<Observation[]> {
  const out: Observation[] = [];

  const errors = await db.query<{ org_id: string; n: number }>(
    "select org_id, count(*)::int as n from customer_payment_events where outcome = 'error' and received_at > $1 group by org_id",
    [minutesAgo(now, 24 * 60)],
  );
  for (const r of errors.rows) {
    out.push({
      key: `customer-payments:webhook-errors:${r.org_id}`, source: "payments", orgId: r.org_id, subject: "customer payment notifications", severity: "critical", clientVisible: true,
      title: `${r.n} payment notification${r.n === 1 ? "" : "s"} from your payment provider could not be applied in the last 24 hours`,
      detail: "A customer's payment may not be on its invoice yet. It is tried again automatically; if it keeps failing, record the payment by hand from your provider's dashboard.",
      evidence: { failed: r.n }, guidance: "Open the invoice, compare it with your payment provider's dashboard, and record the payment by hand if it does not appear.",
    });
  }

  const stuck = await db.query<{ org_id: string; n: number }>(
    "select org_id, count(*)::int as n from customer_payment_events where outcome = 'received' and received_at < $1 group by org_id",
    [minutesAgo(now, STUCK_MINUTES)],
  );
  for (const r of stuck.rows) {
    out.push({
      key: `customer-payments:webhook-stuck:${r.org_id}`, source: "payments", orgId: r.org_id, subject: "customer payment notifications", severity: "critical", clientVisible: true,
      title: `${r.n} payment notification${r.n === 1 ? " was" : "s were"} received from your payment provider and not applied`,
      detail: "They arrived and were not completed. The scheduled check applies them when it runs.", evidence: { stuck: r.n },
      guidance: "If invoices stay unpaid when your customers say they paid, record the payments by hand and tell the iAcquire team.",
    });
  }

  const review = await db.query<{ org_id: string; n: number }>(
    "select org_id, count(*)::int as n from customer_payments where status = 'needs_review' and updated_at < $1 group by org_id",
    [minutesAgo(now, REVIEW_HOURS * 60)],
  );
  for (const r of review.rows) {
    out.push({
      key: `customer-payments:needs-review:${r.org_id}`, source: "payments", orgId: r.org_id, subject: "customer payments waiting for review", severity: "warning", clientVisible: true,
      title: `${r.n} customer payment${r.n === 1 ? " is" : "s are"} waiting for someone to look at ${r.n === 1 ? "it" : "them"}`,
      detail: "These were reported by your payment provider but did not match what was asked for. They are not counted as paid.", evidence: { waiting: r.n },
      guidance: "Open each invoice marked as needing a look, compare it with your payment provider's dashboard, and decide.",
    });
  }

  const attention = await db.query<{ id: string; org_id: string; provider: string }>("select id, org_id, provider from customer_payment_connections where status = 'needs_attention'");
  for (const c of attention.rows) {
    out.push({
      key: `customer-payments:connection:${c.id}`, source: "payments", orgId: c.org_id, subject: "payment account", severity: "warning", clientVisible: true,
      title: "Your payment account needs attention", detail: "The payment provider no longer accepts the saved key, so new online payments are paused.",
      safeActions: ["New online payments are not started while the account needs attention."], guidance: "Open Settings, then Payments, and paste the secret key again.",
    });
  }
  return out;
}
