import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyAgency } from "@/server/notifications";
import { usdToChargeMinor } from "@/lib/billing";
import { todayIn } from "@/lib/invoices/state";
import { consumeRateLimit, consumeRateLimitInTx, RATE_LIMITS } from "@/server/security/rate-limit";
import { createCheckoutSession, type FetchLike } from "@/server/billing/paymongo";
import { newPaymentReference } from "@/server/billing/payments";
import type { NormalizedPaymentEvent } from "@/server/billing/providers/types";
import type { SessionUser } from "@/server/auth/service";
import {
  canStartCheckout, CHECKOUT_CREATING_GRACE_MINUTES, CHECKOUT_STALE_HOURS, checkoutReturnText, type CheckoutStatus, type PurchaseStatus,
} from "@/lib/purchase-intents/rules";
import { checkoutAvailability } from "@/server/purchase-intents/availability";
import { addEvent, byToken, provisionPurchaseIntent, SELECT, type IntentRow } from "@/server/purchase-intents/service";

// Online checkout for a purchase intent. The buyer holds a bearer link; after confirming the offer they may open ONE hosted PayMongo checkout for the frozen setup fee. The
// rules that make this safe, in the order they matter:
//
//   1. The amount is never the buyer's, the browser's or a request's. The checkout row copies the intent's frozen US$ fee (the database refuses another figure), converts it at
//      the agency's published rate, and stores the rate with it. The reference we send is random and ours.
//   2. A payment counts ONLY because the provider's signed notice said so. The adapter verifies the signature against the raw body; the checkout is then found by OUR stored
//      provider checkout id; the reference, mode, currency and amount must all equal what we stored; the event ledger makes retries and replays harmless. The page the buyer
//      returns to reads the stored status and never decides anything.
//   3. Nothing is created from an unverified event. A workspace is made only after the payment is verified, by the same services a hand-recorded payment uses, once.
//   4. A refund, a dispute or a mismatch before the workspace exists puts the purchase on hold and tells the team; nothing is created or taken away automatically.
//
// Provisioning after a verified payment happens only when the Super Admin who invited the buyer allowed it (auto_provision), under THEIR permissions, re-read at that moment.

const LIVE_REVIEW_TEXT = "Live payments are switched off until iAcquire confirms the payment and tax review.";
const AGENCY_LINK = (intentId: string) => `/admin/purchase-intents/${intentId}`;

export interface CheckoutRow {
  id: string;
  intent_id: string;
  agency_org_id: string;
  provider: "paymongo" | "paypal";
  reference_number: string;
  status: CheckoutStatus;
  usd_amount_cents: number;
  charged_currency: string;
  charged_amount_minor: string;
  fx_rate: string | null;
  fx_source: string | null;
  fx_at: Date | null;
  livemode: boolean;
  provider_checkout_id: string | null;
  provider_payment_id: string | null;
  checkout_url: string | null;
  fee_minor: string | null;
  failure_reason: string | null;
  paid_at: Date | null;
  expires_at: Date;
  created_at: Date;
}

export interface StartedCheckout {
  checkoutUrl: string;
  reference: string;
  /** An open checkout was returned instead of a new one (a second press, a lost tab). */
  resumed: boolean;
}

/**
 * The buyer presses Pay. Opens one hosted checkout, or returns the open one. Nothing is charged here: the buyer pays on the provider's page. A failure to reach the provider
 * leaves the checkout row "failed" with a plain reason and charges nobody; the buyer may press again.
 */
export async function startPurchaseCheckout(token: unknown, ctx: { ip: string | null }, deps: { fetch?: FetchLike; now?: Date } = {}): Promise<StartedCheckout> {
  const now = deps.now ?? new Date();
  const perIp = await consumeRateLimit(RATE_LIMITS.purchaseCheckoutByIp, ctx.ip ?? "unknown");
  if (!perIp.allowed) throw new AppError("rate_limited", "Too many attempts. Wait a little and try again.");

  const prepared = await withSystem(async (db) => {
    const row = await byToken(db, token, now);
    if (!row) throw new AppError("not_found", "That purchase link is not valid.");
    const locked = (await db.query<IntentRow>(`${SELECT} where id = $1 for update`, [row.id])).rows[0];
    const perIntent = await consumeRateLimitInTx(db, RATE_LIMITS.purchaseCheckoutByIntent, locked.id);
    if (!perIntent.allowed) throw new AppError("rate_limited", "Too many attempts for this purchase. Wait a little and try again.");

    // An open checkout is returned as it is, so a second press or a lost tab never opens a second payment. One stuck before it had a provider session is given up on first.
    await db.query(
      "update purchase_intent_checkouts set status = 'failed', failure_reason = 'The checkout was never opened' where intent_id = $1 and status = 'creating' and created_at < $2",
      [locked.id, new Date(now.getTime() - CHECKOUT_CREATING_GRACE_MINUTES * 60_000).toISOString()],
    );
    const open = (await db.query<CheckoutRow>("select * from purchase_intent_checkouts where intent_id = $1 and status in ('creating', 'pending') order by created_at desc limit 1", [locked.id])).rows[0];
    if (open?.status === "pending" && open.checkout_url) return { kind: "resume" as const, url: open.checkout_url, reference: open.reference_number };
    if (open) throw new AppError("conflict", "A checkout is being opened for this purchase. Wait a moment and try again.");

    const stats = (await db.query<{ n: number; paid: boolean }>("select count(*)::int as n, coalesce(bool_or(status in ('paid', 'refunded', 'disputed')), false) as paid from purchase_intent_checkouts where intent_id = $1", [locked.id])).rows[0];
    const allowed = canStartCheckout({ status: locked.status as PurchaseStatus, expiresAt: new Date(locked.expires_at).toISOString(), hold: locked.payment_hold, hasPaidCheckout: stats.paid, checkoutsSoFar: stats.n }, now);
    if (!allowed.ok) throw new AppError("conflict", allowed.reason ?? "This purchase cannot be paid now.");

    const availability = await checkoutAvailability(db);
    if (!availability.available) throw new AppError("integration_unavailable", availability.reason === LIVE_REVIEW_TEXT ? "Online payment is not open yet. iAcquire will contact you." : "Online payment is not open yet. iAcquire will send you another way to pay.");
    const rate = availability.settings.usdPhpRate as number;
    const minor = usdToChargeMinor(locked.setup_fee_cents * 10_000, rate);
    const reference = newPaymentReference();
    const inserted = (await db.query<{ id: string }>(
      `insert into purchase_intent_checkouts (intent_id, agency_org_id, provider, reference_number, usd_amount_cents, charged_currency, charged_amount_minor, fx_rate, fx_source, fx_at, livemode, expires_at)
       values ($1, $2, 'paymongo', $3, $4, 'PHP', $5, $6, $7, $8, $9, $10) returning id`,
      [locked.id, locked.agency_org_id, reference, locked.setup_fee_cents, minor, rate, availability.settings.fxSource, availability.settings.fxUpdatedAt, availability.livemode === true,
        new Date(now.getTime() + CHECKOUT_STALE_HOURS * 3_600_000).toISOString()],
    )).rows[0];
    await addEvent(db, locked.id, locked.agency_org_id, "checkout_started", { reference, chargedCurrency: "PHP", chargedAmountMinor: minor, usdCents: locked.setup_fee_cents }, null, "buyer");
    return { kind: "new" as const, checkoutId: inserted.id, reference, minor, intent: locked };
  });
  if (prepared.kind === "resume") return { checkoutUrl: prepared.url, reference: prepared.reference, resumed: true };

  const appUrl = env().APP_URL.replace(/\/$/, "");
  try {
    const session = await createCheckoutSession(
      {
        amountMinor: prepared.minor,
        currency: "PHP",
        name: "iAcquireOS setup",
        // Our reference travels in the description too, so a failed-payment notice (which names no checkout) can be linked back to this record.
        description: `iAcquireOS setup for ${prepared.intent.company} [${prepared.reference}]`,
        referenceNumber: prepared.reference,
        // The buyer comes back by the checkout's own reference, never by the bearer token: the token is not given to the provider.
        successUrl: `${appUrl}/purchase/return/${prepared.reference}`,
        cancelUrl: `${appUrl}/purchase/return/${prepared.reference}`,
      },
      { fetch: deps.fetch },
    );
    await withSystem((db) => db.query(
      "update purchase_intent_checkouts set status = 'pending', provider_checkout_id = $2, checkout_url = $3 where id = $1 and status = 'creating'",
      [prepared.checkoutId, session.id, session.checkoutUrl],
    ));
    return { checkoutUrl: session.checkoutUrl, reference: prepared.reference, resumed: false };
  } catch (err) {
    await withSystem(async (db) => {
      await db.query("update purchase_intent_checkouts set status = 'failed', failure_reason = 'The payment provider could not open the checkout.' where id = $1 and status = 'creating'", [prepared.checkoutId]);
      await addEvent(db, prepared.intent.id, prepared.intent.agency_org_id, "checkout_failed", { reference: prepared.reference }, null, "system");
    });
    throw err instanceof AppError ? err : new AppError("integration_unavailable", "The payment provider could not be reached. Nothing was charged. Please try again.");
  }
}

export interface CheckoutReturn {
  checkoutStatus: CheckoutStatus | null;
  purchaseStatus: PurchaseStatus | null;
  title: string;
  body: string;
  tone: "neutral" | "success" | "warning" | "danger";
}

/** What the page the buyer comes back to says. Found by the checkout's reference alone; it reads stored status and decides nothing, and an unknown reference looks like a waiting one. */
export async function getCheckoutReturn(reference: unknown): Promise<CheckoutReturn> {
  const ref = typeof reference === "string" && /^IAQ-[A-Z0-9]{8,40}$/.test(reference) ? reference : null;
  const row = ref
    ? (await withSystem((db) => db.query<{ status: CheckoutStatus; purchase_status: PurchaseStatus }>(
        "select c.status, i.status as purchase_status from purchase_intent_checkouts c join purchase_intents i on i.id = c.intent_id where c.reference_number = $1", [ref],
      ))).rows[0]
    : undefined;
  const text = checkoutReturnText(row?.status ?? null, row?.purchase_status ?? null);
  return { checkoutStatus: row?.status ?? null, purchaseStatus: row?.purchase_status ?? null, ...text };
}

// ---------------------------------------------------------------------------
// The provider's signed notices (called by the shared webhook handler, inside its transaction)
// ---------------------------------------------------------------------------

export interface CheckoutApplyResult {
  outcome: "processed" | "ignored" | "rejected";
  detail?: string;
  checkoutId: string;
  /** Provisioning to run once the transaction has committed. */
  followUp?: { intentId: string };
}

async function lockCheckout(db: Queryable, provider: string, checkoutId: string): Promise<CheckoutRow | undefined> {
  return (await db.query<CheckoutRow>("select * from purchase_intent_checkouts where provider = $1 and provider_checkout_id = $2 for update", [provider, checkoutId])).rows[0];
}

const holdIntent = async (db: Queryable, intent: IntentRow, hold: "refunded" | "disputed" | "mismatch") => {
  await db.query("update purchase_intents set payment_hold = $2 where id = $1 and status in ('started', 'payment_verified', 'expired', 'cancelled')", [intent.id, hold]);
};

/**
 * A "paid" notice for a checkout of ours. Returns null when the notice names no checkout of ours (the caller then treats it as it always did). Every comparison is against what
 * WE stored when the checkout was opened; the notice's own fields are only compared, never trusted to name an amount, a buyer or a workspace.
 */
export async function applyCheckoutPaid(db: Queryable, event: NormalizedPaymentEvent, now: Date = new Date()): Promise<CheckoutApplyResult | null> {
  if (!event.checkoutId) return null;
  const checkout = await lockCheckout(db, event.provider, event.checkoutId);
  if (!checkout) return null;
  const intent = (await db.query<IntentRow>(`${SELECT} where id = $1 for update`, [checkout.intent_id])).rows[0];
  const link = AGENCY_LINK(intent.id);
  // Both the id we stored at creation and the reference we sent must agree, so a crafted notice cannot borrow another buyer's checkout.
  if (event.reference !== checkout.reference_number) return { outcome: "rejected", detail: "Reference does not match the checkout.", checkoutId: checkout.id };
  if (checkout.livemode !== event.livemode) return { outcome: "rejected", detail: "Payment mode mismatch.", checkoutId: checkout.id };
  if (["paid", "refunded", "disputed"].includes(checkout.status)) return { outcome: "ignored", detail: "Already recorded as paid.", checkoutId: checkout.id };
  if (event.paidPayments.length !== 1) return { outcome: "ignored", detail: "No single paid payment in the event.", checkoutId: checkout.id };
  const paid = event.paidPayments[0];
  if (paid.amountMinor !== Number(checkout.charged_amount_minor) || paid.currency !== checkout.charged_currency) {
    await db.query("update purchase_intent_checkouts set status = 'mismatch', failure_reason = 'Paid amount or currency did not match the checkout.' where id = $1", [checkout.id]);
    await holdIntent(db, intent, "mismatch");
    await addEvent(db, intent.id, intent.agency_org_id, "payment_mismatch", { reference: checkout.reference_number }, null, "system");
    await notifyAgency(db, null, { kind: "billing_reconciliation", severity: "critical", title: "A purchase payment did not match its checkout", body: `Purchase ${intent.reference}, checkout ${checkout.reference_number}: nothing was created. Review it in PayMongo.`, link, dedupeKey: `purchase-mismatch:${checkout.id}` }, { permission: "agency.prospects.manage" });
    return { outcome: "rejected", detail: "Amount or currency mismatch.", checkoutId: checkout.id };
  }

  const tz = (await db.query<{ timezone: string }>("select timezone from organizations where id = $1", [intent.agency_org_id])).rows[0]?.timezone ?? "UTC";
  await db.query("update purchase_intent_checkouts set status = 'paid', paid_at = $2, provider_payment_id = $3, fee_minor = $4, failure_reason = null where id = $1", [checkout.id, now.toISOString(), paid.id, paid.feeMinor]);

  // The same money must not count twice. A hand-recorded payment, a workspace that already exists, or a cancelled purchase means this payment is a duplicate or arrived too late:
  // it is recorded on the checkout and a person decides about the refund.
  const status = intent.status as PurchaseStatus;
  if (status === "payment_verified" || status === "provisioned" || status === "cancelled") {
    await addEvent(db, intent.id, intent.agency_org_id, "payment_received", { reference: checkout.reference_number, duplicate: true, purchaseStatus: status }, null, "system");
    await notifyAgency(db, null, {
      kind: "billing_reconciliation", severity: "critical",
      title: status === "cancelled" ? "A cancelled purchase was paid" : "A purchase was paid twice",
      body: `Purchase ${intent.reference}, checkout ${checkout.reference_number}. The purchase was already ${status === "cancelled" ? "cancelled" : "paid"}, so nothing new was created. Refund this payment in PayMongo and record the refund.`,
      link, dedupeKey: `purchase-duplicate:${checkout.id}`,
    }, { permission: "agency.prospects.manage" });
    await recordAudit({ orgId: intent.agency_org_id, actorKind: "system", action: "purchase_intent.duplicate_payment", targetType: "purchase_intent", targetId: intent.id, result: "success", metadata: { reference: intent.reference, checkout: checkout.reference_number, purchaseStatus: status } }, db);
    return { outcome: "processed", detail: "Duplicate payment recorded for a person to refund.", checkoutId: checkout.id };
  }

  await db.query(
    `update purchase_intents set status = 'payment_verified', payment_at = $2, payment_method = 'paymongo', payment_reference = $3, payment_paid_on = $4::date,
       payment_note = $5, payment_amount_cents = setup_fee_cents, payment_source = 'provider', payment_checkout_id = $6, started_at = coalesce(started_at, $2), expired_at = null where id = $1`,
    [intent.id, now.toISOString(), paid.id, todayIn(now, tz), `Confirmed by the payment provider's signed notice for checkout ${checkout.reference_number}.`, checkout.id],
  );
  await addEvent(db, intent.id, intent.agency_org_id, "payment_received", { reference: checkout.reference_number, amountCents: intent.setup_fee_cents, provider: event.provider }, null, "system");
  await recordAudit({ orgId: intent.agency_org_id, actorKind: "system", action: "purchase_intent.payment_received", targetType: "purchase_intent", targetId: intent.id, result: "success", metadata: { reference: intent.reference, checkout: checkout.reference_number, amountCents: intent.setup_fee_cents, provider: event.provider, autoProvision: intent.auto_provision } }, db);
  await notifyAgency(db, null, {
    kind: "billing_payment_received", severity: "success", title: "A purchase was paid online",
    body: `${intent.company} (${intent.reference}) paid the setup fee. ${intent.auto_provision ? "Their workspace is being created." : "Create their workspace from the purchase page."}`,
    link, dedupeKey: `purchase-paid:${checkout.id}`,
  }, { permission: "agency.prospects.manage" });
  return { outcome: "processed", checkoutId: checkout.id, followUp: intent.auto_provision ? { intentId: intent.id } : undefined };
}

/** A refund or dispute notice for a payment that belongs to a checkout of ours (and has no workspace payment yet). Reported and held; nothing is created or removed. */
export async function applyCheckoutReported(db: Queryable, event: NormalizedPaymentEvent): Promise<CheckoutApplyResult | null> {
  if (!event.providerPaymentId) return null;
  const checkout = (await db.query<CheckoutRow>("select * from purchase_intent_checkouts where provider = $1 and provider_payment_id = $2 for update", [event.provider, event.providerPaymentId])).rows[0];
  if (!checkout) return null;
  if (checkout.livemode !== event.livemode) return { outcome: "rejected", detail: "Payment mode mismatch.", checkoutId: checkout.id };
  const dispute = event.kind === "payment_disputed";
  const intent = (await db.query<IntentRow>(`${SELECT} where id = $1 for update`, [checkout.intent_id])).rows[0];
  if (checkout.status === "paid") await db.query("update purchase_intent_checkouts set status = $2 where id = $1", [checkout.id, dispute ? "disputed" : "refunded"]);
  // After the workspace exists its own payment row carries the notice (the webhook handler finds that first); before, the purchase is held so nothing is created from money that may come back.
  if (intent.status === "started" || intent.status === "payment_verified") await holdIntent(db, intent, dispute ? "disputed" : "refunded");
  await addEvent(db, intent.id, intent.agency_org_id, "payment_held", { reference: checkout.reference_number, what: dispute ? "dispute" : "refund", event: event.type }, null, "system");
  await notifyAgency(db, null, {
    kind: "billing_reconciliation", severity: dispute ? "critical" : "warning",
    title: dispute ? "A purchase payment is disputed" : "PayMongo reports a refund on a purchase",
    body: `Purchase ${intent.reference} (${intent.company}). ${intent.status === "provisioned" ? "The workspace already exists and was not changed." : "Creating the workspace is on hold until a person decides."} Check it in PayMongo.`,
    link: AGENCY_LINK(intent.id), dedupeKey: `purchase-${dispute ? "dispute" : "refund"}:${event.provider}:${event.id}`,
  }, { permission: "agency.prospects.manage" });
  await recordAudit({ orgId: intent.agency_org_id, actorKind: "system", action: dispute ? "purchase_intent.dispute_reported" : "purchase_intent.refund_reported", targetType: "purchase_intent", targetId: intent.id, result: "success", metadata: { reference: intent.reference, checkout: checkout.reference_number, event: event.type } }, db);
  return { outcome: "processed", detail: "Recorded for a person to act on; nothing was created or removed.", checkoutId: checkout.id };
}

/** A failed attempt names no checkout, only our reference in its description. The checkout stays open to a later success; the team is not woken for a declined card. */
export async function applyCheckoutFailed(db: Queryable, event: NormalizedPaymentEvent): Promise<CheckoutApplyResult | null> {
  const reference = /\[(IAQ-[A-Z0-9]{8,})\]/.exec(event.description ?? "")?.[1];
  if (!reference) return null;
  const checkout = (await db.query<CheckoutRow>("select * from purchase_intent_checkouts where reference_number = $1 for update", [reference])).rows[0];
  if (!checkout) return null;
  if (checkout.status !== "pending" || checkout.livemode !== event.livemode) return { outcome: "ignored", detail: "No pending checkout for this reference.", checkoutId: checkout.id };
  return { outcome: "processed", detail: "Failed attempt noted; the checkout remains open.", checkoutId: checkout.id };
}

// ---------------------------------------------------------------------------
// Provisioning by the system, under the authority of the person who allowed it
// ---------------------------------------------------------------------------

async function authorizerOf(db: Queryable, userId: string): Promise<SessionUser | null> {
  const u = (await db.query<{ id: string; email: string; full_name: string | null; platform_role: SessionUser["platformRole"]; timezone: string | null; preferences: Record<string, unknown> | null; verified: boolean }>(
    "select id, email, full_name, platform_role, timezone, preferences, email_verified_at is not null as verified from users where id = $1 and status = 'active'", [userId],
  )).rows[0];
  if (!u || u.platform_role === "none") return null;
  return { sessionId: "purchase-intent-automation", id: u.id, email: u.email, fullName: u.full_name ?? "", platformRole: u.platform_role, timezone: u.timezone ?? "UTC", preferences: u.preferences ?? {}, emailVerified: u.verified };
}

export type AutoProvisionOutcome = "provisioned" | "waiting_for_a_person" | "not_automatic" | "already_done" | "failed";

/**
 * Creates the workspace for a purchase whose payment the provider confirmed, when the Super Admin who invited the buyer allowed it. It runs with THAT person's permissions,
 * read again now: if they no longer hold them, nothing is made and the team is told, because a person's decision does not outlive their access. It never throws for a
 * business reason: a failure is written on the purchase (attempts, a short plain reason) and in the timeline, and a Super Admin or the recovery sweep tries again; the
 * underlying provisioning is idempotent, so a retry finishes the same workspace instead of making another.
 */
export async function provisionPaidIntent(intentId: string, deps: { now?: Date } = {}): Promise<AutoProvisionOutcome> {
  const now = deps.now ?? new Date();
  const prep = await withSystem(async (db) => {
    const row = (await db.query<IntentRow>(`${SELECT} where id = $1 for update`, [intentId])).rows[0];
    if (!row) return { kind: "skip" as const, outcome: "not_automatic" as const };
    if (row.status === "provisioned") return { kind: "skip" as const, outcome: "already_done" as const };
    if (!row.auto_provision || row.payment_source !== "provider") return { kind: "skip" as const, outcome: "not_automatic" as const };
    if (row.status !== "payment_verified" || row.payment_hold) return { kind: "skip" as const, outcome: "waiting_for_a_person" as const };
    const authorizer = await authorizerOf(db, row.created_by);
    await db.query("update purchase_intents set provision_attempts = provision_attempts + 1, last_provision_at = $2 where id = $1", [row.id, now.toISOString()]);
    if (row.provision_attempts > 0) await addEvent(db, row.id, row.agency_org_id, "provision_retried", { attempt: row.provision_attempts + 1 }, null, "system");
    return { kind: "run" as const, row, authorizer };
  });
  if (prep.kind === "skip") return prep.outcome;
  const fail = async (reason: string, outcome: AutoProvisionOutcome) => {
    await withSystem(async (db) => {
      await db.query("update purchase_intents set last_provision_error = $2 where id = $1", [prep.row.id, reason.slice(0, 300)]);
      await addEvent(db, prep.row.id, prep.row.agency_org_id, "provision_failed", { reason: reason.slice(0, 300) }, null, "system");
      await notifyAgency(db, null, {
        kind: "billing_reconciliation", severity: "warning", title: "A paid purchase has no workspace yet",
        body: `${prep.row.company} (${prep.row.reference}) paid, but creating the workspace did not finish: ${reason.slice(0, 200)} Open the purchase to try again.`,
        link: AGENCY_LINK(prep.row.id), dedupeKey: `purchase-provision-failed:${prep.row.id}:${prep.row.provision_attempts + 1}`,
      }, { permission: "agency.prospects.manage" });
    });
    return outcome;
  };
  if (!prep.authorizer) return fail("The Super Admin who allowed automatic creation is no longer an active agency account.", "waiting_for_a_person");
  try {
    await provisionPurchaseIntent(prep.authorizer, prep.row.id, { now, automatic: true });
    return "provisioned";
  } catch (err) {
    const message = err instanceof AppError ? err.message : "An unexpected error stopped it.";
    return fail(message, err instanceof AppError && err.code === "forbidden" ? "waiting_for_a_person" : "failed");
  }
}

// ---------------------------------------------------------------------------
// Sweeps (dormant until the scheduler runs)
// ---------------------------------------------------------------------------

export interface CheckoutSweepResult {
  closedUnpaid: number;
  givenUp: number;
  recovered: number;
}

/** Closes checkouts nobody finished and gives up on rows that never got a provider session; retries paid purchases whose workspace did not finish. A late payment on a closed checkout is still recorded. */
export async function runPurchaseCheckoutSweep(opts: { now?: Date; maxRecoveries?: number } = {}): Promise<CheckoutSweepResult> {
  const now = opts.now ?? new Date();
  const swept = await withSystem(async (db) => {
    const given = await db.query<{ id: string; intent_id: string; agency_org_id: string }>(
      "update purchase_intent_checkouts set status = 'failed', failure_reason = 'The checkout was never opened' where status = 'creating' and created_at < $1 returning id, intent_id, agency_org_id",
      [new Date(now.getTime() - CHECKOUT_CREATING_GRACE_MINUTES * 60_000).toISOString()],
    );
    const closed = await db.query<{ id: string; intent_id: string; agency_org_id: string }>(
      "update purchase_intent_checkouts set status = 'expired', failure_reason = 'Nobody finished paying' where status = 'pending' and expires_at <= $1 returning id, intent_id, agency_org_id",
      [now.toISOString()],
    );
    for (const row of closed.rows) await addEvent(db, row.intent_id, row.agency_org_id, "checkout_expired", {}, null, "system");
    return { given: given.rowCount ?? 0, closed: closed.rowCount ?? 0 };
  });
  const pending = await withSystem((db) => db.query<{ id: string }>(
    `select id from purchase_intents where status = 'payment_verified' and auto_provision and payment_source = 'provider' and payment_hold is null and provision_attempts < 6
       and (last_provision_at is null or last_provision_at < $1) order by payment_at limit $2`,
    [new Date(now.getTime() - 5 * 60_000).toISOString(), opts.maxRecoveries ?? 10],
  ));
  let recovered = 0;
  for (const row of pending.rows) if ((await provisionPaidIntent(row.id, { now })) === "provisioned") recovered++;
  return { closedUnpaid: swept.closed, givenUp: swept.given, recovered };
}

// ---------------------------------------------------------------------------
// What the Super Admin reads
// ---------------------------------------------------------------------------

export interface CheckoutView {
  id: string;
  provider: string;
  reference: string;
  status: CheckoutStatus;
  usdAmountCents: number;
  chargedCurrency: string;
  chargedAmountMinor: number;
  livemode: boolean;
  providerPaymentId: string | null;
  failureReason: string | null;
  paidAt: string | null;
  createdAt: string;
}

export async function listIntentCheckouts(db: Queryable, intentId: string): Promise<CheckoutView[]> {
  const { rows } = await db.query<CheckoutRow>("select * from purchase_intent_checkouts where intent_id = $1 order by created_at desc, id desc limit 20", [intentId]);
  return rows.map((r) => ({
    id: r.id, provider: r.provider, reference: r.reference_number, status: r.status, usdAmountCents: r.usd_amount_cents, chargedCurrency: r.charged_currency, chargedAmountMinor: Number(r.charged_amount_minor),
    livemode: r.livemode, providerPaymentId: r.provider_payment_id, failureReason: r.failure_reason, paidAt: r.paid_at ? new Date(r.paid_at).toISOString() : null, createdAt: new Date(r.created_at).toISOString(),
  }));
}

