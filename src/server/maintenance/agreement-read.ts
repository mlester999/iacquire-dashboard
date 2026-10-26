import "server-only";
import type { Queryable } from "@/server/db";
import { providerReadiness } from "@/server/purchase-intents/availability";
import { maintenancePlanId } from "@/server/billing/providers/paypal-subscriptions";
import type { AgreementStatus } from "@/lib/maintenance-agreement";

// What the screens read about an automatic-payment agreement, and whether one can be opened right now. Reads only: nothing here calls PayPal or changes a record, so the plan's own
// service can use it without a cycle (src/server/maintenance/agreement-service.ts makes the calls).

export interface AgreementView {
  id: string;
  reference: string;
  status: AgreementStatus;
  provider: "paypal";
  livemode: boolean;
  amountMinor: number;
  currency: string;
  nextBillingAt: string | null;
  failedPayments: number;
  hold: "refunded" | "disputed" | null;
  holdSince: string | null;
  /** Only while the buyer still has to approve it, and only for the person who may. */
  approvalUrl: string | null;
  heldCharges: number;
  createdAt: string;
}

export interface AgreementRow {
  id: string;
  org_id: string;
  subscription_id: string;
  reference_number: string;
  provider_agreement_id: string | null;
  status: AgreementStatus;
  livemode: boolean;
  amount_minor: string;
  currency: string;
  approval_url: string | null;
  next_billing_at: Date | null;
  failed_payments: number;
  hold: "refunded" | "disputed" | null;
  hold_since: Date | null;
  created_at: Date;
  held: number;
}

export const AGREEMENT_SELECT = `select a.id, a.org_id, a.subscription_id, a.reference_number, a.provider_agreement_id, a.status, a.livemode, a.amount_minor, a.currency, a.approval_url, a.next_billing_at,
  a.failed_payments, a.hold, a.hold_since, a.created_at,
  (select count(*)::int from maintenance_agreement_charges c where c.agreement_id = a.id and c.outcome = 'held') as held
  from maintenance_agreements a`;

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

export function toAgreementView(r: AgreementRow, withApproval: boolean): AgreementView {
  return {
    id: r.id, reference: r.reference_number, status: r.status, provider: "paypal", livemode: r.livemode, amountMinor: Number(r.amount_minor), currency: r.currency,
    nextBillingAt: iso(r.next_billing_at), failedPayments: r.failed_payments, hold: r.hold, holdSince: iso(r.hold_since),
    approvalUrl: withApproval && r.status === "approval_pending" ? r.approval_url : null, heldCharges: r.held, createdAt: new Date(r.created_at).toISOString(),
  };
}

/** The plan's current agreement: the open one if there is one, otherwise the newest that ended. Null when it never had one. */
export async function agreementForPlan(db: Queryable, subscriptionId: string, opts: { withApproval?: boolean } = {}): Promise<AgreementView | null> {
  const r = (await db.query<AgreementRow>(`${AGREEMENT_SELECT} where a.subscription_id = $1 order by (a.status in ('approval_pending', 'approved', 'active', 'suspended')) desc, a.created_at desc limit 1`, [subscriptionId])).rows[0];
  return r ? toAgreementView(r, opts.withApproval === true) : null;
}

/** The newest agreement of each of several plans, for the team's list (never with an approval link). */
export async function agreementsForPlans(db: Queryable, subscriptionIds: string[]): Promise<Map<string, AgreementView>> {
  const out = new Map<string, AgreementView>();
  if (!subscriptionIds.length) return out;
  const rows = (await db.query<AgreementRow>(
    `${AGREEMENT_SELECT} where a.subscription_id = any($1::uuid[]) order by (a.status in ('approval_pending', 'approved', 'active', 'suspended')) desc, a.created_at desc`, [subscriptionIds],
  )).rows;
  for (const r of rows) if (!out.has(r.subscription_id)) out.set(r.subscription_id, toAgreementView(r, false));
  return out;
}

export interface RecurringAvailability {
  /** The Super Admin's own switch. */
  enabled: boolean;
  available: boolean;
  /** Why not, in words for the team. A client is only ever told "not available right now". */
  reason: string | null;
  livemode: boolean | null;
}

/** Whether an agreement can be opened right now: PayPal connected and able to confirm a payment, the billing plan set, and the Super Admin's switch on. */
export async function recurringAvailability(db: Queryable): Promise<RecurringAvailability> {
  const enabled = (await db.query<{ on: boolean }>("select recurring_billing_enabled as on from agency_billing_settings limit 1")).rows[0]?.on === true;
  const ready = await providerReadiness(db, "paypal");
  const no = (reason: string): RecurringAvailability => ({ enabled, available: false, reason, livemode: ready.livemode });
  if (!ready.available) return no(ready.reason ?? "PayPal is not ready.");
  if (!maintenancePlanId()) return no("The PayPal billing plan for maintenance (PAYPAL_MAINTENANCE_PLAN_ID) is not set.");
  if (!enabled) return no("Automatic payments are switched off in the billing settings.");
  return { enabled, available: true, reason: null, livemode: ready.livemode };
}
