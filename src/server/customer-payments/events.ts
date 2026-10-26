import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { notifyOrgRoles } from "@/server/notifications";
import { toDecimalString, type CurrencyCode } from "@/lib/money";
import {
  decideAfterPayment, decideNotSucceeded, decideSucceeded, looksLikeOurReference, readFacts, storableFacts, type Canonical, type EventDecision, type NormalizedEvent, type ReviewReason,
} from "@/lib/invoices/payment-events";
import { applyDisputeInTx, applyPaymentInTx, applyRefundInTx, settlePaymentInTx, type PaymentRowStatus } from "@/server/invoices/apply";
import type { PaymentProviderId } from "@/lib/invoices/connection-rules";
import { addInvoiceEvent, toMinor } from "@/server/invoices/core";
import { announcePaymentFailed } from "@/server/invoices/crm-effects";
import { runCloseRule, runRefundReview } from "@/server/invoices/close-rules";
import { credentialVault } from "@/server/customer-payments/credentials";
import { attemptByReference, attemptFacts, moneyWords, type AttemptRow } from "@/server/customer-payments/attempts";
import { paymentSwitches } from "@/server/customer-payments/switches";
import { providerFor, type ProviderResolver } from "@/server/customer-payments/providers";
import { ProviderCallError } from "@/server/customer-payments/providers/types";

// What happens to a payment provider's delivery once it is known to be genuine. The webhook handler (webhooks.ts) authenticates a delivery and writes its receipt
// first; this file applies the receipt, and is the reason the receipt is a row of its own: it carries the normalized facts, so a delivery that failed to apply can be
// applied again later from the receipt alone (the raw body, which can carry a payer's name and email, is never kept).
//
// The order is the point. Transaction 1 (webhooks.ts) commits the receipt. Transaction 2 (here) locks the receipt row, applies it, and records its outcome in the same
// commit, so a receipt is either still open or finished and accounted for. If transaction 2 fails, nothing it did is kept and transaction 3 (webhooks.ts) records
// the failure on the receipt, which stays open for the next delivery or the reconcile job. This is the fix for the agency webhook's gap, where the receipt and the
// processing shared one transaction, so a failure erased the receipt and its alarms could never fire.

export type ReceiptOutcome = "received" | "processed" | "ignored" | "rejected" | "error" | "deferred";
const FINISHED: readonly ReceiptOutcome[] = ["processed", "ignored", "rejected"];
export const isFinished = (o: string) => (FINISHED as readonly string[]).includes(o);

/** A receipt that has been waiting this long for its payment (a refund that came first) is let go: it was most likely the business's own other sale. */
export const DEFERRED_GIVE_UP_HOURS = 72;

export interface StoredReceipt {
  receiptId: string;
  /** This delivery wrote the row (false: the provider sent the same event before). */
  created: boolean;
  outcome: ReceiptOutcome;
}

/**
 * Transaction 1. Writes the receipt before anything is processed. The same event id on the same connection is the same receipt, however many times and however
 * concurrently it arrives. `terminal` is for a delivery that can be settled from its envelope alone (the wrong mode, an unreadable body).
 */
export async function storeReceipt(
  conn: { id: string; orgId: string },
  facts: NormalizedEvent,
  payloadSha256: string,
  terminal?: { outcome: "rejected" | "ignored"; note: string },
): Promise<StoredReceipt> {
  const detail = { facts: storableFacts(facts), ...(terminal ? { note: terminal.note.slice(0, 300) } : {}) };
  return withSystem(async (db) => {
    await db.query("update customer_payment_connections set last_event_at = now() where id = $1 and org_id = $2", [conn.id, conn.orgId]);
    const ins = await db.query<{ id: string; outcome: ReceiptOutcome }>(
      `insert into customer_payment_events (org_id, connection_id, provider_event_id, event_type, livemode, outcome, detail, payload_sha256, processed_at)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, case when $6 = 'received' then null else now() end)
       on conflict (connection_id, provider_event_id) do nothing returning id, outcome`,
      [conn.orgId, conn.id, facts.eventId.slice(0, 200), facts.type.slice(0, 120), facts.livemode, terminal?.outcome ?? "received", JSON.stringify(detail), payloadSha256],
    );
    if (ins.rows[0]) return { receiptId: ins.rows[0].id, created: true, outcome: ins.rows[0].outcome };
    const had = await db.query<{ id: string; outcome: ReceiptOutcome }>("select id, outcome from customer_payment_events where connection_id = $1 and provider_event_id = $2", [conn.id, facts.eventId.slice(0, 200)]);
    return { receiptId: had.rows[0].id, created: false, outcome: had.rows[0].outcome };
  });
}

/** What the caller does after the transaction has committed: the deal rules open their own transactions and are safe to run again. */
export interface Effects {
  orgId: string;
  /** An invoice whose payment was just counted: the owner's close rule may act on its deal. */
  closeRuleFor: string | null;
  /** A refund that was just recorded: a deal this invoice closed asks a person to look again. */
  refundReview: { invoiceId: string; refundId: string } | null;
}

/** Runs what a processed receipt asks for once its transaction has committed. A failure here never undoes the payment: the deal rules are idempotent and the reconcile job runs them again. */
export async function runEffects(effects: Effects | null): Promise<void> {
  if (!effects) return;
  try {
    if (effects.closeRuleFor) await runCloseRule(effects.orgId, effects.closeRuleFor);
    if (effects.refundReview) await runRefundReview(effects.orgId, effects.refundReview.invoiceId, effects.refundReview.refundId);
  } catch {
    console.error("[iacquire] a deal rule after a customer payment could not run");
  }
}

export interface ProcessResult {
  outcome: ReceiptOutcome | "duplicate";
  note: string | null;
  effects: Effects | null;
}

export interface ProcessDeps {
  providerFor?: ProviderResolver;
  now?: Date;
}

interface ReceiptRead {
  id: string;
  org_id: string;
  connection_id: string;
  outcome: ReceiptOutcome;
  detail: { facts?: unknown; note?: string };
  attempts: number;
  provider: PaymentProviderId;
  mode: "test" | "live";
  credentials: string | null;
}

const RECEIPT_SQL = `select e.id, e.org_id, e.connection_id, e.outcome, e.detail, e.attempts, c.provider, c.mode, c.credentials
  from customer_payment_events e join customer_payment_connections c on c.id = e.connection_id and c.org_id = e.org_id`;

/** Whether the authenticated read-back may be made: the simulated provider reaches nothing (and does not exist in production); a real one needs the environment's calls switch. */
export function readBackAllowed(provider: PaymentProviderId): boolean {
  const sw = paymentSwitches();
  return provider === "simulated" ? sw.simulatedAllowed : sw.writesEnabled;
}

/**
 * Transaction 2 (and, before it, the authenticated read-back, which is made outside any transaction so a slow provider never holds a lock). Throws when something
 * unexpected goes wrong; the caller records that (transaction 3). An outcome that is a decision, even a refusal, is returned, not thrown.
 */
export async function processReceipt(receiptId: string, deps: ProcessDeps = {}): Promise<ProcessResult> {
  const now = deps.now ?? new Date();
  const resolve = deps.providerFor ?? providerFor;
  const first = (await withSystem((db) => db.query<ReceiptRead>(`${RECEIPT_SQL} where e.id = $1`, [receiptId]))).rows[0];
  if (!first) throw new AppError("not_found", "That receipt was not found.");
  if (isFinished(first.outcome)) return { outcome: "duplicate", note: null, effects: null };
  const facts = readFacts(first.detail.facts);

  let canonical: Canonical | "missing" | null = null;
  if (facts && facts.kind === "payment.succeeded" && facts.checkoutId && readBackAllowed(first.provider)) {
    const adapter = resolve(first.provider);
    const creds = credentialVault.open(first.credentials);
    if (adapter.fetchCheckout && creds) {
      try {
        const co = await adapter.fetchCheckout(creds, facts.checkoutId);
        const p = co?.payments.find((x) => x.id === facts.paymentId);
        canonical = !co || !p ? "missing" : { status: p.status, amountMinor: p.amountMinor, currency: p.currency, reference: co.reference, checkoutId: co.checkoutId };
      } catch (e) {
        // The key was refused at the provider: the signed delivery still stands (the connection will say it needs attention). Any other failure is retried.
        if (!(e instanceof ProviderCallError && e.kind === "rejected")) throw e;
      }
    }
  }

  return withSystem(async (db): Promise<ProcessResult> => {
    const r = (await db.query<ReceiptRead>(`${RECEIPT_SQL} where e.id = $1 for update of e`, [receiptId])).rows[0];
    if (!r || isFinished(r.outcome)) return { outcome: "duplicate", note: null, effects: null };
    const parsed = readFacts(r.detail.facts);
    const done = parsed
      ? await applyFacts(db, { orgId: r.org_id, connectionId: r.connection_id, provider: r.provider, live: r.mode === "live", facts: parsed, canonical, now })
      : { outcome: "rejected" as const, note: "The stored event could not be read.", effects: null };
    const note = done.note.slice(0, 300);
    // A deferred receipt gives up after a few days; the others are final.
    const give = done.outcome === "deferred" && now.getTime() - (await receivedAt(db, receiptId)) > DEFERRED_GIVE_UP_HOURS * 3_600_000;
    const outcome: ReceiptOutcome = give ? "ignored" : done.outcome;
    await db.query(
      `update customer_payment_events set outcome = $2, detail = (detail - 'error') || $3::jsonb, attempts = attempts + 1, processed_at = case when $2 in ('processed', 'ignored', 'rejected') then now() else processed_at end where id = $1`,
      [receiptId, outcome, JSON.stringify({ note: give ? "No payment of ours matched this for three days; it was most likely not one of this product's." : note })],
    );
    return { outcome, note, effects: done.effects };
  });
}

async function receivedAt(db: Queryable, receiptId: string): Promise<number> {
  const { rows } = await db.query<{ received_at: Date }>("select received_at from customer_payment_events where id = $1", [receiptId]);
  return new Date(rows[0].received_at).getTime();
}

/** Transaction 3. Records that processing failed, with a sentence that carries no key, URL or body. The receipt stays open. */
export async function markReceiptError(receiptId: string, message: string): Promise<{ attempts: number }> {
  return withSystem(async (db) => {
    const { rows } = await db.query<{ attempts: number }>(
      `update customer_payment_events set outcome = 'error', detail = detail || $2::jsonb, attempts = attempts + 1 where id = $1 and outcome not in ('processed', 'ignored', 'rejected') returning attempts`,
      [receiptId, JSON.stringify({ error: message.slice(0, 300) })],
    );
    return { attempts: rows[0]?.attempts ?? 0 };
  });
}

// ---------------------------------------------------------------------------
// Applying the facts
// ---------------------------------------------------------------------------

interface ApplyContext {
  orgId: string;
  connectionId: string;
  provider: PaymentProviderId;
  live: boolean;
  facts: NormalizedEvent;
  canonical: Canonical | "missing" | null;
  now: Date;
}

interface Applied {
  outcome: Exclude<ReceiptOutcome, "received" | "error">;
  note: string;
  effects: Effects | null;
}

const effectsFor = (orgId: string, over: Partial<Omit<Effects, "orgId">> = {}): Effects => ({ orgId, closeRuleFor: null, refundReview: null, ...over });
const finish = (outcome: Applied["outcome"], note: string, effects: Effects | null = null): Applied => ({ outcome, note, effects });

/** An expected refusal (a refund for more than is left, say) is caught and undone; anything else is a real fault and propagates. */
async function guarded<T>(db: Queryable, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: AppError }> {
  await db.query("savepoint apply_event");
  try {
    const value = await fn();
    await db.query("release savepoint apply_event");
    return { ok: true, value };
  } catch (e) {
    await db.query("rollback to savepoint apply_event");
    await db.query("release savepoint apply_event");
    if (e instanceof AppError) return { ok: false, error: e };
    throw e;
  }
}

function decisionOutcome(d: Exclude<EventDecision, { action: "apply" } | { action: "review" }>): Applied {
  return d.action === "ignore" ? finish("ignored", d.reason) : d.action === "reject" ? finish("rejected", d.reason) : finish("deferred", d.reason);
}

async function paymentOf(db: Queryable, orgId: string, connectionId: string, providerPaymentId: string) {
  const { rows } = await db.query<{ id: string; invoice_id: string; status: PaymentRowStatus; currency: CurrencyCode; amount_minor: string }>(
    "select id, invoice_id, status, currency, amount_minor::text as amount_minor from customer_payments where org_id = $1 and connection_id = $2 and provider_payment_id = $3", [orgId, connectionId, providerPaymentId],
  );
  return rows[0] ?? null;
}

/**
 * The attempt a connection issued under a reference, found after the invoice it belongs to is locked. The invoice is always locked before its attempts (starting a
 * checkout does the same), so a payment arriving while a customer starts another checkout cannot deadlock with it.
 */
async function lockedAttempt(db: Queryable, orgId: string, connectionId: string, reference: string | null): Promise<AttemptRow | null> {
  if (!looksLikeOurReference(reference)) return null;
  const found = await attemptByReference(db, connectionId, reference);
  if (!found) return null;
  await db.query("select 1 from customer_invoices where id = $1 and org_id = $2 for update", [found.invoice_id, orgId]);
  return attemptByReference(db, connectionId, reference);
}

async function closeAttempt(db: Queryable, attemptId: string, to: "succeeded" | "needs_review") {
  await db.query(`update customer_payment_attempts set status = $2 where id = $1 and status in ('created', 'redirected'${to === "succeeded" ? ", 'needs_review'" : ""})`, [attemptId, to]);
}

const REVIEW_WORDS: Record<ReviewReason, string> = {
  checkout_mismatch: "its checkout does not match the one this product started for that reference",
  provider_disagrees: "the provider's own record does not agree with the delivery",
  provider_missing_payment: "the provider's own record does not show the payment",
  currency_mismatch: "it is in a different currency from the invoice",
  amount_mismatch: "its amount is not what the checkout asked for",
  no_payment_id: "it names no payment",
};

function instant(iso: string | null, now: Date): Date {
  const t = iso ? new Date(iso) : null;
  // The provider's clock is not trusted to put a payment in the future.
  return t && !Number.isNaN(t.getTime()) && t.getTime() <= now.getTime() + 86_400_000 ? t : now;
}

async function applySucceeded(db: Queryable, c: ApplyContext): Promise<Applied> {
  const e = c.facts;
  const attempt = await lockedAttempt(db, c.orgId, c.connectionId, e.reference);
  const decision = decideSucceeded({ event: e, connectionLive: c.live, attempt: attempt ? attemptFacts(attempt, c.now) : null, canonical: c.canonical });
  if (decision.action !== "apply" && decision.action !== "review") return decisionOutcome(decision);
  if (!attempt || !e.paymentId) return finish("rejected", "The payment could not be tied to a checkout.");

  const existing = await paymentOf(db, c.orgId, c.connectionId, e.paymentId);
  const actor = { id: null, kind: "provider" as const };
  if (existing?.status === "failed" && decision.action === "apply") {
    // A failed payment stays failed (the database will not move it), so a provider that now says the same payment is paid cannot be believed silently: a person looks.
    await askForLook(db, c, attempt.invoice_id, e.paymentId, "the provider first reported this payment as failed and now reports it as paid", { reason: "failed_then_paid", provider: c.provider });
    return finish("processed", "Kept for review: the provider first reported this payment as failed and now reports it as paid.");
  }
  if (existing && !(existing.status === "pending" && decision.action === "apply" && toMinor(existing.amount_minor) === e.amountMinor)) return finish("processed", "This payment was already recorded; nothing changed.");

  if (decision.action === "apply") {
    if (existing) {
      // A payment the provider first reported as pending is now confirmed.
      const settled = await settlePaymentInTx(db, { orgId: c.orgId, paymentId: existing.id, to: "succeeded", actor });
      if (settled.status === "succeeded") await closeAttempt(db, attempt.id, "succeeded");
      return finish("processed", settled.status === "succeeded" ? "A pending payment was confirmed." : "The payment is kept for review.", effectsFor(c.orgId, { closeRuleFor: settled.status === "succeeded" ? attempt.invoice_id : null }));
    }
    const applied = await applyPaymentInTx(db, {
      orgId: c.orgId, invoiceId: attempt.invoice_id, amountMinor: e.amountMinor as number, currency: attempt.currency, provider: c.provider, verification: "provider_confirmed", connectionId: c.connectionId,
      attemptId: attempt.id, providerPaymentId: e.paymentId, livemode: e.livemode, method: e.method, receivedAt: instant(e.occurredAt, c.now), feeMinor: e.feeMinor, actor,
    });
    if (applied.counted) await closeAttempt(db, attempt.id, "succeeded");
    else if (applied.status === "needs_review") await closeAttempt(db, attempt.id, "needs_review");
    return finish("processed", applied.counted ? "The payment was recorded." : "The payment is kept for review.", effectsFor(c.orgId, { closeRuleFor: applied.counted && !applied.duplicate ? attempt.invoice_id : null }));
  }

  // Review: the money is real as far as the delivery is concerned, but something about it does not agree. It is kept where a person can see it, and counts for nothing.
  const why = REVIEW_WORDS[decision.reason];
  await closeAttempt(db, attempt.id, "needs_review");
  if (decision.record && e.amountMinor !== null) {
    await applyPaymentInTx(db, {
      orgId: c.orgId, invoiceId: attempt.invoice_id, amountMinor: e.amountMinor, currency: attempt.currency, provider: c.provider, verification: "provider_confirmed", connectionId: c.connectionId,
      attemptId: attempt.id, providerPaymentId: e.paymentId, livemode: e.livemode, method: e.method, receivedAt: instant(e.occurredAt, c.now), feeMinor: e.feeMinor, status: "needs_review", actor,
    });
    return finish("processed", `Kept for review: ${why}.`);
  }
  // It cannot be held in a payment row (its currency is not the invoice's): the invoice's history and the owner's notice carry it.
  await askForLook(db, c, attempt.invoice_id, e.paymentId, why, { reason: decision.reason, provider: c.provider, currency: e.currency, expectedCurrency: attempt.currency });
  return finish("rejected", `Not recorded: ${why}.`);
}

/** Tells the owner and managers that a payment the provider reported is not in the books and why, once per payment. */
async function askForLook(db: Queryable, c: ApplyContext, invoiceId: string, paymentId: string, why: string, detail: Record<string, unknown>): Promise<void> {
  const inv = (await db.query<{ number: string | null }>("select number from customer_invoices where id = $1 and org_id = $2", [invoiceId, c.orgId])).rows[0];
  await addInvoiceEvent(db, c.orgId, invoiceId, "payment_needs_review", { id: null, kind: "provider" }, detail);
  await notifyOrgRoles(db, c.orgId, ["owner", "admin"], {
    kind: "payment_review_needed", severity: "warning", title: `A payment for ${inv?.number ?? "an invoice"} needs a look`,
    body: `The provider reported a payment, but ${why}. It was not counted. Check it in your payment provider's dashboard.`, link: `/invoices/${invoiceId}`, dedupeKey: `payment-review:${c.connectionId}:${paymentId}`,
  });
}

async function applyNotSucceeded(db: Queryable, c: ApplyContext): Promise<Applied> {
  const e = c.facts;
  const attempt = await lockedAttempt(db, c.orgId, c.connectionId, e.reference);
  const decision = decideNotSucceeded({ event: e, connectionLive: c.live, attempt: attempt ? attemptFacts(attempt, c.now) : null });
  if (decision.action !== "apply") return decisionOutcome(decision as Exclude<EventDecision, { action: "apply" } | { action: "review" }>);
  if (!attempt) return finish("ignored", "Not one of this product's checkouts.");
  const actor = { id: null, kind: "provider" as const };
  const amount = e.amountMinor !== null && e.amountMinor > 0 && e.currency === attempt.currency ? e.amountMinor : toMinor(attempt.amount_minor);
  if (e.paymentId) {
    const existing = await paymentOf(db, c.orgId, c.connectionId, e.paymentId);
    if (existing) return finish("processed", "This payment was already recorded; nothing changed.");
    await applyPaymentInTx(db, {
      orgId: c.orgId, invoiceId: attempt.invoice_id, amountMinor: amount, currency: attempt.currency, provider: c.provider, verification: "provider_confirmed", connectionId: c.connectionId,
      attemptId: attempt.id, providerPaymentId: e.paymentId, livemode: e.livemode, method: e.method, receivedAt: instant(e.occurredAt, c.now), status: e.kind === "payment.pending" ? "pending" : "failed", actor,
    });
    // A failed try leaves the checkout open: the payer can try another card on the same page.
    return finish("processed", e.kind === "payment.pending" ? "The payment is pending; nothing is counted until the provider confirms it." : "The failed attempt was recorded; the checkout stays open.");
  }
  if (e.kind === "payment.failed") {
    const inv = (await db.query<{ number: string | null }>("select number from customer_invoices where id = $1 and org_id = $2", [attempt.invoice_id, c.orgId])).rows[0];
    await addInvoiceEvent(db, c.orgId, attempt.invoice_id, "payment_failed", actor, { provider: c.provider, attemptId: attempt.id });
    await notifyOrgRoles(db, c.orgId, ["owner", "admin"], {
      kind: "invoice_payment_failed", severity: "warning", title: `A payment for ${inv?.number ?? "an invoice"} failed`, body: "A payment attempt did not go through. The invoice is still owed.",
      link: `/invoices/${attempt.invoice_id}`, dedupeKey: `payment-failed:${attempt.id}:${e.eventId}`,
    });
    await announcePaymentFailed(db, c.orgId, attempt.invoice_id, actor, { attemptId: attempt.id, providerEventId: e.eventId, livemode: e.livemode });
  }
  return finish("processed", "Noted.");
}

async function applyAfterPayment(db: Queryable, c: ApplyContext): Promise<Applied> {
  const e = c.facts;
  const pay = e.paymentId ? await paymentOf(db, c.orgId, c.connectionId, e.paymentId) : null;
  const decision = decideAfterPayment({ event: e, connectionLive: c.live, payment: pay ? { status: pay.status, currency: pay.currency, amountMinor: toMinor(pay.amount_minor) } : null });
  if (decision.action !== "apply") return decisionOutcome(decision as Exclude<EventDecision, { action: "apply" } | { action: "review" }>);
  if (!pay) return finish("deferred", "The payment this refers to has not been recorded here (yet).");
  const actor = { id: null, kind: "provider" as const };

  if (e.kind === "dispute.opened" || e.kind === "dispute.closed") {
    const open = e.kind === "dispute.opened";
    const r = await guarded(db, () => applyDisputeInTx(db, { orgId: c.orgId, paymentId: pay.id, open, outcome: open ? null : e.disputeOutcome, lostMinor: open ? null : e.amountMinor, actor }));
    if (!r.ok) return finish("rejected", r.error.message);
    const d = r.value;
    if (open) return finish("processed", d.changed ? "The dispute was recorded." : "Nothing changed.");
    // The provider's word is not enough to put money back: a close with no clear outcome leaves the payment disputed for the owner to settle.
    if (d.outcome === "unknown") return finish("processed", "The dispute was closed, but the provider did not say who won. The payment stays disputed until the owner records the result.");
    if (!d.changed) return finish("processed", "Nothing changed.");
    return finish("processed", d.outcome === "won" ? "The dispute was closed in the seller's favour; the payment counts again." : d.chargebackMinor > 0 ? `The dispute was lost; ${toDecimalString(d.chargebackMinor, pay.currency)} ${pay.currency} was recorded as a chargeback.` : "The dispute was lost; refunds already recorded cover it.",
      effectsFor(c.orgId, { refundReview: d.chargebackRefundId ? { invoiceId: pay.invoice_id, refundId: d.chargebackRefundId } : null }));
  }

  // A refund of money this product recorded. The reduction of what was kept is the business's to see; the deal is never reopened.
  if (!e.refundId || e.amountMinor === null || e.amountMinor <= 0) return finish("rejected", "The refund names no amount or id, so it cannot be recorded.");
  const r = await guarded(db, () => applyRefundInTx(db, {
    orgId: c.orgId, paymentId: pay.id, amountMinor: e.amountMinor as number, source: "provider_event", providerRefundId: e.refundId, reason: e.reason?.trim() || "Refunded at the payment provider", actor,
  }));
  if (!r.ok) {
    // More than is left to refund, or the payment is already fully refunded: the money moved at the provider, and the books must not silently disagree.
    const inv = (await db.query<{ number: string | null }>("select number from customer_invoices where id = $1 and org_id = $2", [pay.invoice_id, c.orgId])).rows[0];
    await notifyOrgRoles(db, c.orgId, ["owner", "admin"], {
      kind: "payment_review_needed", severity: "warning", title: `A refund for ${inv?.number ?? "an invoice"} could not be recorded`,
      body: `The provider reported a refund of ${moneyWords(e.amountMinor, pay.currency)}. ${r.error.message} Check it in your payment provider's dashboard.`, link: `/invoices/${pay.invoice_id}`, dedupeKey: `refund-review:${c.connectionId}:${e.refundId}`,
    });
    return finish("rejected", r.error.message);
  }
  if (r.value.matched) return finish("processed", "This refund matches one the owner recorded by hand, so it is counted once.");
  return finish("processed", r.value.duplicate ? "This refund was already recorded; nothing changed." : `A refund of ${toDecimalString(e.amountMinor, pay.currency)} ${pay.currency} was recorded.`, effectsFor(c.orgId, { refundReview: r.value.duplicate ? null : { invoiceId: pay.invoice_id, refundId: r.value.refundId } }));
}

async function applyFacts(db: Queryable, c: ApplyContext): Promise<Applied> {
  switch (c.facts.kind) {
    case "ignored":
      return finish("ignored", c.facts.reason ?? "Not an event this product uses.");
    case "payment.succeeded":
      return applySucceeded(db, c);
    case "payment.failed":
    case "payment.pending":
      return applyNotSucceeded(db, c);
    case "refund.succeeded":
    case "dispute.opened":
    case "dispute.closed":
      return applyAfterPayment(db, c);
    case "refund.failed":
    case "refund.pending":
      // Only a refund that succeeded changes anything here; a refund still in progress is recorded when the provider reports that it finished.
      return finish("ignored", "A refund that has not succeeded is not recorded.");
  }
}
