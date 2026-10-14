import "server-only";
import crypto from "node:crypto";
import { withSystem, type Queryable } from "@/server/db";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyAgency, notifyOrgRoles } from "@/server/notifications";
import { usdToChargeMinor, formatUsd, MICROS_PER_USD } from "@/lib/billing";
import { grantCredits, recordPaymentInitiated, reverseCredits } from "@/server/billing/ledger";
import { createCheckoutSession, paymongoStatus, parseEvent, verifyWebhookSignature, type FetchLike, type PaymongoEvent } from "@/server/billing/paymongo";

export type PaymentKind = "setup_fee" | "credit_topup" | "maintenance" | "custom_project" | "domain" | "other";

const CHARGE_CURRENCY = "PHP";

interface PaymentRow {
  id: string;
  org_id: string;
  kind: PaymentKind;
  status: string;
  usd_amount_micros: string;
  charged_currency: string;
  charged_amount_minor: string;
  livemode: boolean;
  reference_number: string;
  provider_checkout_id: string | null;
  provider_payment_id: string | null;
  credits_micros: string | null;
  refunded_micros: string;
}

function newReference() {
  // Crockford-style base32 without ambiguous characters; unguessable and safe to show on receipts.
  const alphabet = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
  const bytes = crypto.randomBytes(12);
  return `IAQ-${Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("")}`;
}

export interface CheckoutInput {
  orgId: string;
  kind: PaymentKind;
  usdMicros: number;
  description: string;
  requestedBy: string | null;
}

/**
 * Starts a PayMongo hosted checkout. Nothing is charged here: the client pays on PayMongo's page, and credits or
 * setup status change only when a signed webhook confirms the payment against this stored record.
 */
export async function createPaymentCheckout(input: CheckoutInput, deps: { fetch?: FetchLike } = {}): Promise<{ paymentId: string; checkoutUrl: string; referenceNumber: string }> {
  if (!Number.isInteger(input.usdMicros) || input.usdMicros <= 0) throw new AppError("invalid_input", "Enter a valid amount.");
  if (input.usdMicros % 10_000 !== 0) throw new AppError("invalid_input", "Amounts can have at most two decimal places.");
  const status = paymongoStatus();
  if (!status.configured) throw new AppError("integration_unavailable", "Payments are not connected yet. iAcquire is finishing the PayMongo setup.");
  const livemode = status.livemode === true;

  const payment = await withSystem(async (db) => {
    const { rows: settingsRows } = await db.query<{ usd_php_rate: string | null; fx_source: string | null; fx_updated_at: Date | null; live_payments_review_at: Date | null; topup_min_usd: number; topup_max_usd: number }>(
      "select usd_php_rate, fx_source, fx_updated_at, live_payments_review_at, topup_min_usd, topup_max_usd from agency_billing_settings",
    );
    const s = settingsRows[0];
    if (!s?.usd_php_rate) throw new AppError("integration_unavailable", "Checkout needs an exchange rate. iAcquire has not set one yet.");
    if (livemode && !s.live_payments_review_at) throw new AppError("integration_unavailable", "Live payments are switched off until iAcquire confirms the payment and tax review.");
    if (input.kind === "credit_topup") {
      const usd = input.usdMicros / MICROS_PER_USD;
      if (!Number.isInteger(usd) || usd < s.topup_min_usd || usd > s.topup_max_usd) throw new AppError("invalid_input", `Choose a whole-dollar amount from $${s.topup_min_usd} to $${s.topup_max_usd}.`);
    }
    if (input.kind === "setup_fee") {
      const { rows } = await db.query<{ setup_fee_cents: number; setup_payment_status: string }>("select setup_fee_cents, setup_payment_status from billing_accounts where org_id = $1", [input.orgId]);
      if (!rows[0]) throw new AppError("not_found", "Billing account not found.");
      if (rows[0].setup_payment_status === "paid") throw new AppError("conflict", "The setup fee is already paid.");
      if (rows[0].setup_fee_cents * 10_000 !== input.usdMicros) throw new AppError("invalid_input", "The setup fee amount does not match the agreed price.");
    }
    const rate = Number(s.usd_php_rate);
    const minor = usdToChargeMinor(input.usdMicros, rate);
    const reference = newReference();
    const { rows } = await db.query<{ id: string }>(
      `insert into payments (org_id, kind, description, usd_amount_micros, charged_currency, charged_amount_minor, fx_rate, fx_source, fx_at, livemode,
         reference_number, credits_micros, requested_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
      [input.orgId, input.kind, input.description.slice(0, 200), input.usdMicros, CHARGE_CURRENCY, minor, rate, s.fx_source, s.fx_updated_at, livemode, reference, input.kind === "credit_topup" ? input.usdMicros : null, input.requestedBy],
    );
    await recordPaymentInitiated(db, { orgId: input.orgId, paymentId: rows[0].id, memo: `${input.kind} checkout started`, createdBy: input.requestedBy });
    return { id: rows[0].id, reference, minor };
  });

  const appUrl = env().APP_URL.replace(/\/$/, "");
  try {
    const session = await createCheckoutSession(
      {
        amountMinor: payment.minor,
        currency: CHARGE_CURRENCY,
        name: input.description,
        // Our reference travels in the description so a failed-payment event can be linked back to this record.
        description: `${input.description} [${payment.reference}]`,
        referenceNumber: payment.reference,
        successUrl: `${appUrl}/settings/billing?payment=${payment.reference}&return=success`,
        cancelUrl: `${appUrl}/settings/billing?payment=${payment.reference}&return=cancelled`,
      },
      deps,
    );
    await withSystem((db) =>
      db.query("update payments set provider_checkout_id = $2, checkout_url = $3 where id = $1 and status = 'pending'", [payment.id, session.id, session.checkoutUrl]),
    );
    return { paymentId: payment.id, checkoutUrl: session.checkoutUrl, referenceNumber: payment.reference };
  } catch (err) {
    await withSystem((db) => db.query("update payments set status = 'failed', failure_reason = $2 where id = $1 and status = 'pending'", [payment.id, "Checkout could not be created."]));
    throw err;
  }
}

export interface WebhookOutcome {
  httpStatus: number;
  outcome: "processed" | "duplicate" | "ignored" | "rejected" | "blocked";
  detail?: string;
}

const HANDLED = new Set(["checkout_session.payment.paid", "payment.failed"]);

/**
 * Handles one PayMongo webhook delivery. The signature is checked against the raw body first; the event id ledger
 * makes PayMongo's retries and any replay harmless; the organization is always taken from OUR stored payment record,
 * never from the event; and credits are granted only when the paid amount and currency match what we asked for.
 */
export async function handlePaymongoWebhook(input: { rawBody: string; signatureHeader: string | null; now?: number }): Promise<WebhookOutcome> {
  const secret = env().PAYMONGO_WEBHOOK_SECRET;
  if (!secret) return { httpStatus: 503, outcome: "blocked", detail: "Webhook secret is not configured." };
  const sig = verifyWebhookSignature({ header: input.signatureHeader, rawBody: input.rawBody, secret, now: input.now });
  if (!sig.ok) return { httpStatus: 401, outcome: "rejected", detail: `Signature ${sig.reason}.` };
  const event = parseEvent(input.rawBody);
  if (!event) return { httpStatus: 400, outcome: "rejected", detail: "Unrecognized payload." };
  // The signature's mode and the payload's mode must agree, or the event is not trusted.
  if (event.livemode !== sig.livemode) return { httpStatus: 400, outcome: "rejected", detail: "Event mode does not match its signature." };

  return withSystem(async (db) => {
    const receipt = await db.query<{ id: string; outcome: string }>(
      `insert into payment_webhook_events (provider_event_id, event_type, livemode) values ($1, $2, $3)
       on conflict (provider, provider_event_id) do update set provider_event_id = excluded.provider_event_id returning id, outcome`,
      [event.id, event.type, event.livemode],
    );
    const receiptId = receipt.rows[0].id;
    // Lock the receipt so concurrent deliveries of the same event cannot both process it.
    const { rows: locked } = await db.query<{ outcome: string }>("select outcome from payment_webhook_events where id = $1 for update", [receiptId]);
    if (["processed", "ignored", "rejected"].includes(locked[0].outcome)) return { httpStatus: 200, outcome: "duplicate" as const };

    const expectedLive = paymongoStatus().livemode;
    let result: { outcome: "processed" | "ignored" | "rejected"; detail?: string; paymentId?: string };
    if (expectedLive !== null && event.livemode !== expectedLive) result = { outcome: "ignored", detail: "Event mode differs from this environment." };
    else if (!HANDLED.has(event.type)) result = { outcome: "ignored", detail: "Event type is not used." };
    else if (event.type === "checkout_session.payment.paid") result = await applyPaid(db, event);
    else result = await applyFailed(db, event);

    await db.query("update payment_webhook_events set outcome = $2, detail = $3, payment_id = $4, processed_at = now() where id = $1", [receiptId, result.outcome, result.detail?.slice(0, 300) ?? null, result.paymentId ?? null]);
    return { httpStatus: 200, outcome: result.outcome === "processed" ? ("processed" as const) : result.outcome === "rejected" ? ("rejected" as const) : ("ignored" as const), detail: result.detail };
  });
}

const asNumber = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const asString = (v: unknown): string | null => (typeof v === "string" ? v : null);

async function applyPaid(db: Queryable, event: PaymongoEvent): Promise<{ outcome: "processed" | "ignored" | "rejected"; detail?: string; paymentId?: string }> {
  const attrs = event.resource.attributes;
  const { rows } = await db.query<PaymentRow>("select * from payments where provider = 'paymongo' and provider_checkout_id = $1 for update", [event.resource.id]);
  const payment = rows[0];
  if (!payment) return { outcome: "ignored", detail: "No matching checkout session." };
  // Both the id we stored at creation and the reference we sent must agree, so a crafted event cannot borrow someone else's session.
  if (asString(attrs.reference_number) !== payment.reference_number) return { outcome: "rejected", detail: "Reference does not match the checkout.", paymentId: payment.id };
  if (payment.livemode !== event.livemode) return { outcome: "rejected", detail: "Payment mode mismatch.", paymentId: payment.id };
  if (payment.status === "paid" || payment.status === "refunded" || payment.status === "partially_refunded") return { outcome: "ignored", detail: "Already recorded as paid.", paymentId: payment.id };

  const paid = (Array.isArray(attrs.payments) ? attrs.payments : []).filter(
    (p): p is { id: string; attributes: Record<string, unknown> } => typeof p === "object" && p !== null && typeof (p as { id?: unknown }).id === "string" && typeof (p as { attributes?: unknown }).attributes === "object" && (p as { attributes: { status?: unknown } }).attributes?.status === "paid",
  );
  if (paid.length !== 1) return { outcome: "ignored", detail: "No single paid payment in the event.", paymentId: payment.id };
  const attributes = paid[0].attributes;
  const amount = asNumber(attributes.amount);
  const currency = asString(attributes.currency);
  if (amount !== Number(payment.charged_amount_minor) || currency !== payment.charged_currency) {
    await db.query("update payments set status = 'mismatch', failure_reason = $2 where id = $1", [payment.id, "Paid amount or currency did not match the checkout."]);
    await notifyAgency(db, payment.org_id, { kind: "billing_reconciliation", severity: "critical", title: "A payment did not match its checkout", body: `Reference ${payment.reference_number}: no credit was granted. Review it in PayMongo.`, link: `/admin/clients/${payment.org_id}`, dedupeKey: `mismatch:${payment.id}` });
    return { outcome: "rejected", detail: "Amount or currency mismatch.", paymentId: payment.id };
  }
  const fee = asNumber(attributes.fee);
  await db.query("update payments set status = 'paid', paid_at = now(), provider_payment_id = $2, fee_minor = $3, failure_reason = null where id = $1", [payment.id, paid[0].id, fee]);

  if (payment.kind === "credit_topup" && payment.credits_micros) {
    await grantCredits(db, { orgId: payment.org_id, amountMicros: Number(payment.credits_micros), paymentId: payment.id, memo: `Top-up ${payment.reference_number}` });
  } else if (payment.kind === "setup_fee") {
    await db.query("update billing_accounts set setup_payment_status = 'paid', paid_at = now() where org_id = $1", [payment.org_id]);
  }
  await recordAudit({ orgId: payment.org_id, actorKind: "system", action: "billing.payment_confirmed", targetType: "payment", targetId: payment.id, result: "success", metadata: { kind: payment.kind, reference: payment.reference_number } }, db);
  await notifyOrgRoles(db, payment.org_id, ["owner", "admin"], {
    kind: "billing_payment_received",
    severity: "success",
    title: payment.kind === "credit_topup" ? `${formatUsd(Number(payment.credits_micros))} in service credits added` : "Payment received",
    body: `Reference ${payment.reference_number}.`,
    link: "/settings/billing",
    dedupeKey: `payment:${payment.id}`,
  });
  return { outcome: "processed", paymentId: payment.id };
}

async function applyFailed(db: Queryable, event: PaymongoEvent): Promise<{ outcome: "processed" | "ignored"; detail?: string; paymentId?: string }> {
  const description = asString(event.resource.attributes.description) ?? "";
  const reference = /\[(IAQ-[A-Z0-9]{8,})\]/.exec(description)?.[1];
  if (!reference) return { outcome: "ignored", detail: "Failed payment could not be linked to a checkout; no credit was granted." };
  const { rows } = await db.query<PaymentRow>("select * from payments where reference_number = $1 for update", [reference]);
  const payment = rows[0];
  if (!payment || payment.status !== "pending" || payment.livemode !== event.livemode) return { outcome: "ignored", detail: "No pending checkout for this reference." };
  // A customer can retry on the same checkout, so a failed attempt is recorded and the checkout stays open to a later success.
  await notifyOrgRoles(db, payment.org_id, ["owner", "admin"], {
    kind: "billing_payment_failed",
    severity: "warning",
    title: "A payment attempt failed",
    body: `Reference ${payment.reference_number}. No credits were added. You can try again from Billing.`,
    link: "/settings/billing",
    dedupeKey: `payment_failed:${payment.id}`,
  });
  return { outcome: "processed", detail: "Failed attempt noted; checkout remains open.", paymentId: payment.id };
}

/**
 * Records a refund that an agency admin processed in PayMongo. Credits come back only to the extent they are still unused;
 * the rest is reported as a shortfall so the ledger never shows a negative balance.
 */
export async function recordRefund(input: { paymentId: string; amountMicros: number; actorUserId: string; reason: string }) {
  if (!Number.isInteger(input.amountMicros) || input.amountMicros <= 0) throw new AppError("invalid_input", "Enter the refund amount.");
  if (input.reason.trim().length < 5) throw new AppError("invalid_input", "Record why this refund was made.");
  return withSystem(async (db) => {
    const { rows } = await db.query<PaymentRow>("select * from payments where id = $1 for update", [input.paymentId]);
    const p = rows[0];
    if (!p) throw new AppError("not_found", "Payment not found.");
    if (!["paid", "partially_refunded"].includes(p.status)) throw new AppError("conflict", "Only a paid payment can be refunded.");
    const total = Number(p.usd_amount_micros);
    const already = Number(p.refunded_micros);
    if (already + input.amountMicros > total) throw new AppError("invalid_input", "That is more than the remaining payment.");
    let removed = { removedMicros: 0, shortfallMicros: 0 };
    if (p.kind === "credit_topup") {
      removed = await reverseCredits(db, { orgId: p.org_id, paymentId: p.id, amountMicros: input.amountMicros, kind: "refund", idempotencyKey: `refund:${p.id}:${already + input.amountMicros}`, createdBy: input.actorUserId, memo: input.reason });
    }
    const next = already + input.amountMicros;
    await db.query("update payments set refunded_micros = $2, status = $3 where id = $1", [p.id, next, next >= total ? "refunded" : "partially_refunded"]);
    if (p.kind === "setup_fee" && next >= total) await db.query("update billing_accounts set setup_payment_status = 'refunded' where org_id = $1", [p.org_id]);
    await recordAudit({ orgId: p.org_id, actorUserId: input.actorUserId, actorKind: "agency", action: "billing.refund_recorded", targetType: "payment", targetId: p.id, result: "success", metadata: { amountMicros: input.amountMicros, removedMicros: removed.removedMicros, shortfallMicros: removed.shortfallMicros, reason: input.reason } }, db);
    return removed;
  });
}
