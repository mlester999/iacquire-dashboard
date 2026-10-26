// The automatic-payment agreement behind a maintenance plan, as pure rules: what state it is in, which provider news may move it, and what a charge may do to the plan. No server or
// database code, so the screens, the webhook handler and the tests use the same rules.
//
// Who is "paid" is NEVER decided here or by an agreement's status. A plan is paid through a day only because a person recorded a payment, or a provider's verified record says a
// charge COMPLETED (src/server/maintenance/agreement.ts feeds that to the same transition a hand-recorded payment uses). An agreement that is "active" says the provider will try to
// collect; it grants nothing by itself. A plan with no agreement is paid by hand each period, and every screen says so.

export const AGREEMENT_STATUSES = ["approval_pending", "approved", "active", "suspended", "cancelled", "expired", "abandoned"] as const;
export type AgreementStatus = (typeof AGREEMENT_STATUSES)[number];

/** A cancelled, expired or abandoned agreement never comes back: a client who wants automatic payments again sets up a new one. */
export const TERMINAL_AGREEMENT_STATUSES: readonly AgreementStatus[] = ["cancelled", "expired", "abandoned"];
export const isTerminalAgreement = (s: AgreementStatus) => TERMINAL_AGREEMENT_STATUSES.includes(s);
export const OPEN_AGREEMENT_STATUSES: readonly AgreementStatus[] = ["approval_pending", "approved", "active", "suspended"];

/** An agreement the buyer never approved is given up on after this long (PayPal's own approval link would still work, but the plan should not wait for it for ever). */
export const AGREEMENT_APPROVAL_WINDOW_HOURS = 72;
/** The provider's retry schedule is its own; this is how many failed charges in a row the plan is configured to tolerate at the provider (documented in the setup steps). */
export const AGREEMENT_FAILURE_THRESHOLD = 3;

/** PayPal's subscription statuses (Subscriptions API v1) into ours. */
const FROM_PAYPAL: Record<string, AgreementStatus> = {
  APPROVAL_PENDING: "approval_pending",
  APPROVED: "approved",
  ACTIVE: "active",
  SUSPENDED: "suspended",
  CANCELLED: "cancelled",
  EXPIRED: "expired",
};
export const statusFromPaypal = (s: unknown): AgreementStatus | null => (typeof s === "string" ? FROM_PAYPAL[s] ?? null : null);

/** The order a healthy agreement moves in. A status earlier than the current one is old news. */
const RANK: Record<AgreementStatus, number> = { approval_pending: 0, approved: 1, active: 2, suspended: 3, cancelled: 9, expired: 9, abandoned: 9 };

export interface StatusMove {
  status: AgreementStatus;
  changed: boolean;
  /** Why nothing changed (for the event record), when nothing did. */
  ignored: "same" | "terminal" | "stale" | "older_stage" | null;
}

/**
 * Whether a provider status may move the agreement, given the status it has and when the news is dated. Duplicates and out-of-order deliveries are harmless:
 *   * a terminal agreement is never revived by a late "activated" or "approved";
 *   * news dated BEFORE the last news already applied is stale (the provider retries, and deliveries cross);
 *   * an earlier stage (approved after active) is old news; suspended and active may alternate (a suspension can be lifted), and any open status may end.
 */
export function moveAgreement(current: AgreementStatus, incoming: AgreementStatus, news: { at: Date | null; lastAt: Date | null }): StatusMove {
  if (incoming === current) return { status: current, changed: false, ignored: "same" };
  if (isTerminalAgreement(current)) return { status: current, changed: false, ignored: "terminal" };
  if (isTerminalAgreement(incoming)) return { status: incoming, changed: true, ignored: null };
  if (news.at && news.lastAt && news.at.getTime() < news.lastAt.getTime()) return { status: current, changed: false, ignored: "stale" };
  const swing = (current === "active" && incoming === "suspended") || (current === "suspended" && incoming === "active");
  if (!swing && RANK[incoming] < RANK[current]) return { status: current, changed: false, ignored: "older_stage" };
  return { status: incoming, changed: true, ignored: null };
}

export interface AgreementFacts {
  status: AgreementStatus;
  livemode: boolean;
  amountMinor: number;
  currency: string;
  /** A refund or dispute on an earlier charge is waiting for a person. */
  hold: "refunded" | "disputed" | null;
}

export interface ChargeFacts {
  providerPaymentId: string | null;
  amountMinor: number | null;
  currency: string | null;
  livemode: boolean;
  /** Already recorded for this agreement (the same provider payment id). */
  alreadyRecorded: boolean;
  /**
   * Another charge of this agreement was recorded a few days ago (RECENT_CHARGE_DAYS). A monthly agreement does not collect twice in that time, so a second one is more likely the same
   * charge under another id (a notice and a list that name it differently) than a second month: it is recorded but a person decides before the plan is extended.
   */
  recentCharge?: boolean;
}

export const RECENT_CHARGE_DAYS = 10;

export type ChargeVerdict =
  | { action: "apply" }
  /** The money is real but nothing moves by itself: a person decides (a hold from an earlier refund or dispute). */
  | { action: "record_held"; reason: string }
  | { action: "mismatch"; reason: string }
  | { action: "duplicate" }
  | { action: "reject"; reason: string };

/**
 * What a COMPLETED charge reported for an agreement may do. The charge must be the agreement's own amount in its own currency and mode; a charge already recorded is a duplicate;
 * a charge on an agreement that is held after a refund or dispute is recorded but not applied; a charge on a terminal agreement is still money (a final charge can complete after a
 * cancellation) and applies like any other, because it was verified.
 */
export function chargeVerdict(agreement: AgreementFacts, charge: ChargeFacts): ChargeVerdict {
  if (!charge.providerPaymentId) return { action: "reject", reason: "The charge names no payment, so there is nothing to record." };
  if (charge.alreadyRecorded) return { action: "duplicate" };
  if (charge.livemode !== agreement.livemode) return { action: "reject", reason: "The charge is from the other mode (test or live) than this agreement." };
  if (charge.amountMinor === null || charge.amountMinor <= 0 || charge.currency === null) return { action: "mismatch", reason: "The charge carries no usable amount." };
  if (charge.amountMinor !== agreement.amountMinor || charge.currency !== agreement.currency) return { action: "mismatch", reason: "The charge is not the amount or currency this agreement was set up for." };
  if (agreement.hold) return { action: "record_held", reason: agreement.hold === "disputed" ? "An earlier charge on this agreement is disputed." : "An earlier charge on this agreement was refunded." };
  if (charge.recentCharge) return { action: "record_held", reason: `Another charge on this agreement was recorded in the last ${RECENT_CHARGE_DAYS} days; check it is not the same charge twice.` };
  return { action: "apply" };
}

/** The sentence a screen shows about how the plan is paid. */
export function paymentModeLabel(agreement: { status: AgreementStatus; provider: string | null; nextBillingAt: string | null; failedPayments: number; hold: string | null } | null): { mode: "manual" | "automatic"; headline: string; detail: string } {
  if (!agreement || isTerminalAgreement(agreement.status)) {
    return {
      mode: "manual",
      headline: "Paid by hand each period",
      detail: agreement && agreement.status === "cancelled"
        ? "Automatic payments were stopped. iAcquire records each period's payment, or you pay it online when it is due."
        : "Automatic payments are not set up. iAcquire records each period's payment, or you pay it online when it is due.",
    };
  }
  const provider = agreement.provider === "paypal" ? "PayPal" : "the payment provider";
  switch (agreement.status) {
    case "approval_pending":
    case "approved":
      return { mode: "manual", headline: "Automatic payments are waiting for your approval", detail: `Approve the agreement on ${provider}'s page. Until ${provider} confirms the first charge, this plan is still paid by hand.` };
    case "suspended":
      return { mode: "automatic", headline: "Automatic payments are paused", detail: `${provider} has paused the agreement${agreement.failedPayments ? ` after ${agreement.failedPayments} failed charge${agreement.failedPayments === 1 ? "" : "s"}` : ""}. Update your payment method with ${provider}, or pay the period online.` };
    default: {
      // A charge that failed while the plan is still paid through a later day takes nothing from the plan, but the owner is told so on the page, not only in a notice they may not open.
      const failing = !agreement.hold && agreement.failedPayments > 0;
      return {
        mode: "automatic",
        headline: agreement.hold ? "Automatic payments are on hold" : failing ? "The last automatic payment did not go through" : "Automatic payments are on",
        detail: agreement.hold
          ? "A refund or dispute was reported on an earlier charge. New charges are recorded but a person at iAcquire reviews them before the plan is extended."
          : failing
            ? `${provider} could not collect ${agreement.failedPayments === 1 ? "the last charge" : `the last ${agreement.failedPayments} charges`} and tries again. Your plan is exactly as paid as it was; if it keeps failing ${provider} pauses the agreement. Update your payment method with ${provider}, or pay the period online.`
            : `${provider} charges the plan each month${agreement.nextBillingAt ? `; the next charge is due ${agreement.nextBillingAt.slice(0, 10)}` : ""}. A period counts as paid only when ${provider} confirms the charge.`,
      };
    }
  }
}
