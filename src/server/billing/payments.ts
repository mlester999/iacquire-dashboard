import "server-only";
import crypto from "node:crypto";
import { withSystem, type Queryable } from "@/server/db";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyAgency, notifyOrgRoles } from "@/server/notifications";
import { usdToChargeMinor, formatUsd, MICROS_PER_USD } from "@/lib/billing";
import { formatMinor, isCurrency } from "@/lib/money";
import { grantCredits, recordPaymentInitiated, reverseCredits } from "@/server/billing/ledger";
import { createCheckoutSession, paymongoStatus, type FetchLike } from "@/server/billing/paymongo";
import { markSetupFeePaid } from "@/server/billing/clearance";
import { afterSetupCleared } from "@/server/billing/after-clearing";
import { paymongoAdapter } from "@/server/billing/providers/paymongo";
import { applyVerifiedPayment } from "@/server/maintenance/payment";
import { nextPaidThrough, STALE_CHECKOUT_HOURS } from "@/lib/billing-renewal";
import { todayIn } from "@/lib/invoices/state";
import type { NormalizedPaymentEvent, PaymentProviderAdapter } from "@/server/billing/providers/types";

export type PaymentKind = "setup_fee" | "credit_topup" | "maintenance" | "custom_project" | "domain" | "other";

const CHARGE_CURRENCY = "PHP";

export interface PaymentRow {
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
  maintenance_subscription_id: string | null;
  covers_months: number | null;
  maintenance_agreement_id?: string | null;
}

function newReference() {
  // Crockford-style base32 without ambiguous characters; unguessable and safe to show on receipts.
  const alphabet = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
  const bytes = crypto.randomBytes(12);
  return `IAQ-${Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("")}`;
}

/** A reference for a payment recorded by hand: the same shape as a checkout's, so receipts and the finance list read alike. */
export const newPaymentReference = newReference;

export interface CheckoutInput {
  orgId: string;
  kind: PaymentKind;
  usdMicros: number;
  description: string;
  requestedBy: string | null;
  /** A maintenance payment names the plan and how many months it pays for. The amount is checked against the plan's own price, never taken on trust. */
  maintenance?: { subscriptionId: string; months: number };
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
      // The row is locked so two checkouts started together are counted one after the other (the database also allows only one open setup checkout per workspace).
      const { rows } = await db.query<{ setup_fee_cents: number; setup_payment_status: string }>("select setup_fee_cents, setup_payment_status from billing_accounts where org_id = $1 for update", [input.orgId]);
      if (!rows[0]) throw new AppError("not_found", "Billing account not found.");
      if (rows[0].setup_payment_status === "paid") throw new AppError("conflict", "The setup fee is already paid.");
      if (rows[0].setup_payment_status === "waived") throw new AppError("conflict", "The setup fee was waived, so there is nothing to pay.");
      if (rows[0].setup_fee_cents * 10_000 !== input.usdMicros) throw new AppError("invalid_input", "The setup fee amount does not match the agreed price.");
      const open = await db.query("select 1 from payments where org_id = $1 and kind = 'setup_fee' and status = 'pending'", [input.orgId]);
      if (open.rows[0]) throw new AppError("conflict", "A setup fee checkout is already open for this workspace. Finish it, or ask iAcquire to cancel it, before starting another.");
    }
    let plan: { id: string } | null = null;
    if (input.kind === "maintenance") {
      const m = input.maintenance;
      if (!m || !Number.isInteger(m.months) || m.months < 1 || m.months > 12) throw new AppError("invalid_input", "Choose how many months to pay for (1 to 12).");
      // The plan is locked so its status and price cannot change between the checks and the checkout row.
      const row = (await db.query<{ id: string; status: string; monthly_price_cents: number; currency: string }>(
        "select id, status, monthly_price_cents, currency from maintenance_subscriptions where id = $1 and org_id = $2 for update", [m.subscriptionId, input.orgId],
      )).rows[0];
      if (!row) throw new AppError("not_found", "That maintenance plan was not found.");
      if (!["requested", "active", "past_due", "expired", "cancel_requested"].includes(row.status)) throw new AppError("conflict", "This plan cannot take a payment in its current state.");
      if (row.currency !== "USD") throw new AppError("conflict", "This plan is not priced in US dollars.");
      if (row.monthly_price_cents * 10_000 * m.months !== input.usdMicros) throw new AppError("invalid_input", "The amount does not match the plan's price for those months.");
      if (row.status === "requested") {
        // A requested plan starts when a payment is verified. It can only start once the core system is activated and the setup fee cleared, so a payment is not taken that could not be applied.
        const st = (await db.query<{ state: string | null; cleared: boolean }>(
          "select (select i.state from client_setup_instances i where i.org_id = $1) as state, app.setup_payment_cleared($1) as cleared", [input.orgId],
        )).rows[0];
        if (st?.state !== "activated" || st.cleared !== true) throw new AppError("conflict", "The plan can start once the core system is activated and the setup fee is confirmed. Nothing was charged.");
      }
      const open = (await db.query<{ id: string; covers_months: number | null; checkout_url: string | null; reference_number: string; livemode: boolean }>(
        "select id, covers_months, checkout_url, reference_number, livemode from payments where maintenance_subscription_id = $1 and kind = 'maintenance' and status = 'pending'", [row.id],
      )).rows[0];
      if (open) {
        // Backing out of the provider's page leaves its checkout open until the renewal sweep closes it. Pressing "pay" again for the same months opens that same checkout, so the owner is
        // never stuck and never charged twice; a different number of months cannot reuse it (the provider's session has its amount), and is told how to continue.
        if (open.covers_months === input.maintenance?.months && open.checkout_url && open.livemode === livemode) {
          return { kind: "resume" as const, paymentId: open.id, checkoutUrl: open.checkout_url, referenceNumber: open.reference_number };
        }
        const n = open.covers_months;
        throw new AppError("conflict", n
          ? `A payment for ${n} ${n === 1 ? "month" : "months"} is already open. Choose ${n} ${n === 1 ? "month" : "months"} to continue it, or wait for it to close by itself (within ${STALE_CHECKOUT_HOURS / 24} days).`
          : "A payment for this plan is already open. Finish it, or wait for it to close, before starting another.");
      }
      plan = { id: row.id };
    }
    const rate = Number(s.usd_php_rate);
    const minor = usdToChargeMinor(input.usdMicros, rate);
    const reference = newReference();
    const { rows } = await db.query<{ id: string }>(
      `insert into payments (org_id, kind, description, usd_amount_micros, charged_currency, charged_amount_minor, fx_rate, fx_source, fx_at, livemode,
         reference_number, credits_micros, requested_by, maintenance_subscription_id, covers_months)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) returning id`,
      [input.orgId, input.kind, input.description.slice(0, 200), input.usdMicros, CHARGE_CURRENCY, minor, rate, s.fx_source, s.fx_updated_at, livemode, reference, input.kind === "credit_topup" ? input.usdMicros : null, input.requestedBy,
        plan?.id ?? null, plan ? (input.maintenance as { months: number }).months : null],
    );
    await recordPaymentInitiated(db, { orgId: input.orgId, paymentId: rows[0].id, memo: `${input.kind} checkout started`, createdBy: input.requestedBy });
    return { kind: "new" as const, id: rows[0].id, reference, minor };
  });
  if (payment.kind === "resume") return { paymentId: payment.paymentId, checkoutUrl: payment.checkoutUrl, referenceNumber: payment.referenceNumber };

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
        successUrl: `${appUrl}${input.kind === "maintenance" ? "/maintenance" : "/settings/billing"}?payment=${payment.reference}&return=success`,
        cancelUrl: `${appUrl}${input.kind === "maintenance" ? "/maintenance" : "/settings/billing"}?payment=${payment.reference}&return=cancelled`,
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

type ApplyResult = { outcome: "processed" | "ignored" | "rejected"; detail?: string; paymentId?: string; purchaseCheckoutId?: string; followUp?: { intentId: string } };

/**
 * Handles one provider webhook delivery through that provider's adapter, which only verifies the delivery and translates its payload (src/server/billing/providers).
 * The signature is checked against the raw body first; the event id ledger makes the provider's retries and any replay harmless; the organization is always taken from
 * OUR stored payment record, never from the event; and credits or the setup status change only when the paid amount, currency and mode match what we asked for.
 */
export async function handleProviderWebhook(adapter: PaymentProviderAdapter, input: { rawBody: string; headers: Record<string, string | null | undefined>; now?: number }): Promise<WebhookOutcome> {
  const notReady = adapter.notReady();
  if (notReady) return { httpStatus: 503, outcome: "blocked", detail: notReady };
  const sig = await adapter.verify({ rawBody: input.rawBody, headers: input.headers, now: input.now });
  if (!sig.ok) return { httpStatus: 401, outcome: "rejected", detail: `Signature ${sig.reason}.` };
  const event = adapter.parse(input.rawBody);
  if (!event) return { httpStatus: 400, outcome: "rejected", detail: "Unrecognized payload." };
  // The signature's mode and the payload's mode must agree, or the event is not trusted.
  if (event.livemode !== sig.livemode) return { httpStatus: 400, outcome: "rejected", detail: "Event mode does not match its signature." };
  return recordAndApply(adapter, event);
}

/**
 * Records one provider FACT in the receipt ledger and applies it. The caller has established the fact: a delivery whose signature verified (handleProviderWebhook), or the provider's
 * authenticated answer to a call this server made itself (a PayPal capture, a read-back). Nothing a browser sent ever reaches here. The ledger makes a fact applied twice harmless,
 * whichever door it came through.
 */
export async function recordAndApply(adapter: Pick<PaymentProviderAdapter, "expectedLivemode">, event: NormalizedPaymentEvent): Promise<WebhookOutcome> {
  // A purchase intent's paid notice may ask for its workspace to be created. That runs after the notice is committed, in its own transactions, so a failure there can never undo
  // the record that the money arrived (it is retried by a person or the recovery sweep).
  let followUp: { intentId: string } | undefined;
  const outcome = await withSystem(async (db) => {
    const receipt = await db.query<{ id: string; outcome: string }>(
      `insert into payment_webhook_events (provider, provider_event_id, event_type, livemode) values ($1, $2, $3, $4)
       on conflict (provider, provider_event_id) do update set provider_event_id = excluded.provider_event_id returning id, outcome`,
      [event.provider, event.id, event.type, event.livemode],
    );
    const receiptId = receipt.rows[0].id;
    // Lock the receipt so concurrent deliveries of the same event cannot both process it.
    const { rows: locked } = await db.query<{ outcome: string }>("select outcome from payment_webhook_events where id = $1 for update", [receiptId]);
    if (["processed", "ignored", "rejected"].includes(locked[0].outcome)) return { httpStatus: 200, outcome: "duplicate" as const };

    const expectedLive = adapter.expectedLivemode();
    let result: ApplyResult;
    if (expectedLive !== null && event.livemode !== expectedLive) result = { outcome: "ignored", detail: "Event mode differs from this environment." };
    else if (event.kind === "other") result = { outcome: "ignored", detail: "Event type is not used." };
    else if (event.kind === "payment_paid") result = await applyPaid(db, event);
    else if (event.kind === "payment_refunded" || event.kind === "payment_disputed") result = await applyReported(db, event);
    else if (event.kind === "agreement_status" || event.kind === "agreement_charge" || event.kind === "agreement_payment_failed") {
      // The automatic monthly payment (PayPal Subscriptions): its own rules, in src/server/maintenance/agreement.ts, applied inside this same receipt transaction.
      const agreement = await import("@/server/maintenance/agreement");
      result = event.kind === "agreement_status" ? await agreement.applyAgreementStatus(db, event) : event.kind === "agreement_charge" ? await agreement.applyAgreementCharge(db, event) : await agreement.applyAgreementPaymentFailed(db, event);
    } else result = await applyFailed(db, event);

    await db.query("update payment_webhook_events set outcome = $2, detail = $3, payment_id = $4, purchase_checkout_id = $5, processed_at = now() where id = $1", [receiptId, result.outcome, result.detail?.slice(0, 300) ?? null, result.paymentId ?? null, result.purchaseCheckoutId ?? null]);
    followUp = result.followUp;
    return { httpStatus: 200, outcome: result.outcome === "processed" ? ("processed" as const) : result.outcome === "rejected" ? ("rejected" as const) : ("ignored" as const), detail: result.detail };
  });
  if (followUp) {
    try {
      const { provisionPaidIntent } = await import("@/server/purchase-intents/checkout");
      await provisionPaidIntent(followUp.intentId);
    } catch (error) {
      // The payment is recorded and the purchase is waiting; provisionPaidIntent already writes its own failures. Anything that escapes it is logged, never returned to the provider.
      console.error("purchase provisioning follow-up failed", error instanceof Error ? error.message : "unknown");
    }
  }
  return outcome;
}

/** The PayMongo endpoint's entry point (src/app/api/webhooks/paymongo/route.ts). */
export function handlePaymongoWebhook(input: { rawBody: string; signatureHeader: string | null; now?: number }): Promise<WebhookOutcome> {
  return handleProviderWebhook(paymongoAdapter, { rawBody: input.rawBody, headers: { "paymongo-signature": input.signatureHeader }, now: input.now });
}

async function applyPaid(db: Queryable, event: NormalizedPaymentEvent): Promise<ApplyResult> {
  if (!event.checkoutId) return { outcome: "ignored", detail: "No matching checkout session." };
  const { rows } = await db.query<PaymentRow>("select * from payments where provider = $1 and provider_checkout_id = $2 for update", [event.provider, event.checkoutId]);
  const payment = rows[0];
  if (!payment) {
    // Not a workspace payment: it may be the checkout of a purchase intent, which exists before any workspace does.
    const { applyCheckoutPaid } = await import("@/server/purchase-intents/checkout");
    const purchase = await applyCheckoutPaid(db, event);
    if (purchase) return { outcome: purchase.outcome, detail: purchase.detail, purchaseCheckoutId: purchase.checkoutId, followUp: purchase.followUp };
    return { outcome: "ignored", detail: "No matching checkout session." };
  }
  // Both the id we stored at creation and the reference we sent must agree, so a crafted event cannot borrow someone else's session.
  if (event.reference !== payment.reference_number) return { outcome: "rejected", detail: "Reference does not match the checkout.", paymentId: payment.id };
  if (payment.livemode !== event.livemode) return { outcome: "rejected", detail: "Payment mode mismatch.", paymentId: payment.id };
  if (payment.status === "paid" || payment.status === "refunded" || payment.status === "partially_refunded") return { outcome: "ignored", detail: "Already recorded as paid.", paymentId: payment.id };

  if (event.paidPayments.length !== 1) return { outcome: "ignored", detail: "No single paid payment in the event.", paymentId: payment.id };
  const paid = event.paidPayments[0];
  if (paid.amountMinor !== Number(payment.charged_amount_minor) || paid.currency !== payment.charged_currency) {
    await db.query("update payments set status = 'mismatch', failure_reason = $2 where id = $1", [payment.id, "Paid amount or currency did not match the checkout."]);
    await notifyAgency(db, payment.org_id, { kind: "billing_reconciliation", severity: "critical", title: "A payment did not match its checkout", body: `Reference ${payment.reference_number}: no credit was granted. Review it in PayMongo.`, link: `/admin/clients/${payment.org_id}`, dedupeKey: `mismatch:${payment.id}` });
    return { outcome: "rejected", detail: "Amount or currency mismatch.", paymentId: payment.id };
  }
  await db.query("update payments set status = 'paid', paid_at = now(), provider_payment_id = $2, fee_minor = $3, failure_reason = null where id = $1", [payment.id, paid.id, paid.feeMinor]);

  let clearedSetup = false;
  if (payment.kind === "credit_topup" && payment.credits_micros) {
    await grantCredits(db, { orgId: payment.org_id, amountMicros: Number(payment.credits_micros), paymentId: payment.id, memo: `Top-up ${payment.reference_number}` });
  } else if (payment.kind === "maintenance" && payment.maintenance_subscription_id && payment.covers_months) {
    clearedSetup = false;
    await applyMaintenancePeriod(db, payment);
  } else if (payment.kind === "setup_fee") {
    // The status becomes "paid" only against this verified payment (the database refuses it otherwise), and clearing opens the AI employees' provisioning requests.
    const marked = await markSetupFeePaid(db, { orgId: payment.org_id, paymentId: payment.id, updatedBy: null });
    if (marked.first) {
      await afterSetupCleared(db, payment.org_id, { actorUserId: null, how: "payment", eventKey: payment.id });
      clearedSetup = true;
    } else {
      // The money arrived, so the payment is recorded; but the fee was already paid or waived, so a person decides whether to refund it.
      await notifyAgency(db, payment.org_id, {
        kind: "billing_reconciliation",
        severity: "warning",
        title: "A setup fee was paid for a client whose fee was already cleared",
        body: `Reference ${payment.reference_number}. The setup fee was already ${marked.previous}. Review whether this payment should be refunded.`,
        link: `/admin/clients/${payment.org_id}?tab=billing`,
        dedupeKey: `setup-duplicate:${payment.id}`,
      });
    }
  }
  await recordAudit({ orgId: payment.org_id, actorKind: "system", action: "billing.payment_confirmed", targetType: "payment", targetId: payment.id, result: "success", metadata: { kind: payment.kind, reference: payment.reference_number, provider: event.provider, ...(payment.kind === "setup_fee" ? { clearedSetup } : {}) } }, db);
  if (!clearedSetup) {
    await notifyOrgRoles(db, payment.org_id, ["owner", "admin"], {
      kind: "billing_payment_received",
      severity: "success",
      title: payment.kind === "credit_topup" ? `${formatUsd(Number(payment.credits_micros))} in service credits added` : "Payment received",
      body: `Reference ${payment.reference_number}.`,
      link: "/settings/billing",
      dedupeKey: `payment:${payment.id}`,
    });
  }
  return { outcome: "processed", paymentId: payment.id };
}

/**
 * Returns whether the plan took the payment. A provider-verified maintenance payment: moves the plan's paid-through day forward by the months the checkout covered, through the SAME transition a payment recorded by hand
 * uses (activate a requested plan, renew an active one, bring a past-due or expired one back). The checkout named the plan and the months when it was opened and the amount was
 * checked against it, so the notice chooses nothing. If the plan cannot take the payment (it was cancelled, or its core system is not activated yet) the money stays recorded
 * on the payment and a person is told: a payment is never silently dropped and a plan is never changed against its own rules.
 */
export async function applyMaintenancePeriod(db: Queryable, payment: PaymentRow): Promise<boolean> {
  const plan = (await db.query<{ id: string; org_id: string; status: string; paid_through_on: string | null }>(
    "select id, org_id, status, to_char(paid_through_on, 'YYYY-MM-DD') as paid_through_on from maintenance_subscriptions where id = $1 and org_id = $2 for update", [payment.maintenance_subscription_id, payment.org_id],
  )).rows[0];
  const tz = (await db.query<{ timezone: string }>("select timezone from organizations where kind = 'agency' limit 1")).rows[0]?.timezone ?? "UTC";
  const today = todayIn(new Date(), tz);
  const unresolved = async (why: string) => {
    await notifyAgency(db, payment.org_id, {
      kind: "billing_reconciliation", severity: "warning", title: "A maintenance payment could not be applied to the plan",
      body: `Reference ${payment.reference_number}. The money is recorded, but ${why} Record the period by hand or refund the payment.`,
      link: `/admin/clients/${payment.org_id}?tab=billing`, dedupeKey: `maintenance-unapplied:${payment.id}`,
    });
  };
  if (!plan) {
    await unresolved("the plan it was meant for no longer exists.");
    return false;
  }
  try {
    const through = nextPaidThrough({ status: plan.status, paidThroughOn: plan.paid_through_on, today, months: payment.covers_months as number });
    if (!through) {
      await unresolved("the new paid-through day could not be worked out.");
      return false;
    }
    await applyVerifiedPayment(db, {
      subscription: plan,
      mode: plan.status === "requested" ? "activate" : "renew",
      actor: { kind: "system", userId: null },
      paidThroughOn: through,
      paymentId: payment.id,
      billingStartOn: today,
    });
    return true;
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    await unresolved(`the plan refused it (${error.message.replace(/\.$/, "")}).`);
    return false;
  }
}

async function applyFailed(db: Queryable, event: NormalizedPaymentEvent): Promise<ApplyResult> {
  const reference = /\[(IAQ-[A-Z0-9]{8,})\]/.exec(event.description ?? "")?.[1];
  if (!reference) return { outcome: "ignored", detail: "Failed payment could not be linked to a checkout; no credit was granted." };
  const { rows } = await db.query<PaymentRow>("select * from payments where reference_number = $1 for update", [reference]);
  const payment = rows[0];
  if (!payment) {
    const { applyCheckoutFailed } = await import("@/server/purchase-intents/checkout");
    const purchase = await applyCheckoutFailed(db, event);
    if (purchase) return { outcome: purchase.outcome, detail: purchase.detail, purchaseCheckoutId: purchase.checkoutId };
    return { outcome: "ignored", detail: "No pending checkout for this reference." };
  }
  if (payment.status !== "pending" || payment.livemode !== event.livemode) return { outcome: "ignored", detail: "No pending checkout for this reference." };
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

const REPORTED_KIND_LABEL: Record<string, string> = { setup_fee: "setup fee", credit_topup: "service credits", maintenance: "maintenance plan", custom_project: "custom project", domain: "domain", other: "payment" };

const PROVIDER_NAME: Record<string, string> = { paymongo: "PayMongo", paypal: "PayPal" };

/** What a provider's refund notice says happened, from its own status word (never assumed when the payload carried none). */
function refundSentence(refund: NonNullable<NormalizedPaymentEvent["refund"]>, provider: string): string {
  const name = PROVIDER_NAME[provider] ?? "The payment provider";
  const amount = refund.amountMinor !== null && refund.currency !== null && isCurrency(refund.currency) && Number.isSafeInteger(refund.amountMinor) && refund.amountMinor > 0
    ? ` of ${formatMinor(refund.amountMinor, refund.currency, "code")}`
    : "";
  switch (refund.status) {
    case "succeeded": return `${name} reports a refund${amount}.`;
    case "pending": return `${name} reports a refund${amount} that is still being processed.`;
    case "failed": return `${name} reports a refund${amount} that could not be completed.`;
    default: return `${name} sent a refund notice${amount}.`;
  }
}

/**
 * A refund or a dispute that PayMongo reports. It is REPORTED, not applied: the signed notice is recorded on the event ledger against our payment (found by the provider payment id
 * the earlier paid notice gave us), the agency is told, and nothing else changes. The payment keeps its status and amounts, the setup fee keeps its status, and no plan, workflow,
 * employee or workspace is touched, so a notice can never take anything away. Why not apply it: the notice's shape has never been checked against a PayMongo account, and a refund
 * a Super Admin already recorded by hand would be counted twice. A person records the refund (recordRefundAction) or deals with the dispute at PayMongo, and the screens say so.
 */
async function applyReported(db: Queryable, event: NormalizedPaymentEvent): Promise<ApplyResult> {
  const dispute = event.kind === "payment_disputed";
  const what = dispute ? "dispute" : "refund";
  const providerName = PROVIDER_NAME[event.provider] ?? "The payment provider";
  const providerPaymentId = event.providerPaymentId ?? null;
  const payment = providerPaymentId
    ? (await db.query<PaymentRow>("select * from payments where provider = $1 and provider_payment_id = $2 for update", [event.provider, providerPaymentId])).rows[0]
    : undefined;
  if (!payment) {
    // A purchase intent's checkout has no workspace payment until the workspace is made: the notice is held on the purchase.
    const { applyCheckoutReported } = await import("@/server/purchase-intents/checkout");
    const purchase = await applyCheckoutReported(db, event);
    if (purchase) return { outcome: purchase.outcome, detail: purchase.detail, purchaseCheckoutId: purchase.checkoutId };
    await notifyAgency(db, null, {
      kind: "billing_reconciliation",
      severity: "warning",
      title: `${providerName} reported a ${what} that could not be matched`,
      body: `Event ${event.type}. It names no payment we have a record of, so nothing was changed. Check it in ${providerName}.`,
      link: "/admin/billing?tab=rates",
      dedupeKey: `provider-notice-unmatched:${event.provider}:${event.id}`,
    });
    return { outcome: "ignored", detail: `A ${what} was reported for a payment we have no record of.` };
  }
  if (payment.livemode !== event.livemode) return { outcome: "rejected", detail: "Payment mode mismatch.", paymentId: payment.id };

  const kindLabel = REPORTED_KIND_LABEL[payment.kind] ?? "payment";
  const sentence = dispute ? `${providerName} reports a dispute on this payment.` : refundSentence(event.refund ?? { id: null, amountMinor: null, currency: null, status: null }, event.provider);
  const advice = dispute
    ? `Nothing was changed: the payment still counts as received until you record what happened. Respond to the dispute in ${providerName}. Access and AI employees are not affected.`
    : "Nothing was changed. If this refund is not recorded yet, record it on the payment; if you already recorded it, nothing more is needed. Access and AI employees are not affected.";
  await notifyAgency(db, payment.org_id, {
    kind: "billing_reconciliation",
    severity: dispute ? "critical" : "warning",
    title: dispute ? `A payment is disputed at ${providerName}` : `${providerName} reports a refund`,
    body: `${payment.reference_number} (${kindLabel}). ${sentence} ${advice}`,
    link: `/admin/clients/${payment.org_id}?tab=billing`,
    dedupeKey: `provider-${what}:${event.provider}:${event.id}`,
  });
  await recordAudit({
    orgId: payment.org_id, actorKind: "system", action: dispute ? "billing.provider_dispute_reported" : "billing.provider_refund_reported", targetType: "payment", targetId: payment.id, result: "success",
    metadata: { reference: payment.reference_number, event: event.type, ...(!dispute && event.refund ? { status: event.refund.status, amountMinor: event.refund.amountMinor, currency: event.refund.currency } : {}) },
  }, db);
  // A charge of an automatic monthly payment: its agreement is held, so a further charge is recorded but not added to the plan until a person has looked. The notice still changes
  // nothing that was already paid, and a refund that did not go through is not a refund.
  if (payment.maintenance_agreement_id && !(event.refund && event.refund.status === "failed")) {
    const { holdAgreementAfterNotice } = await import("@/server/maintenance/agreement");
    await holdAgreementAfterNotice(db, payment.maintenance_agreement_id, dispute ? "disputed" : "refunded", { paymentId: payment.id, reference: payment.reference_number });
  }
  return { outcome: "processed", detail: `${sentence} Recorded for a person to act on; nothing was changed.`, paymentId: payment.id };
}

/**
 * Records a refund that an agency admin processed with the provider (or outside one: a payment recorded by hand is refunded the same way). Credits come back only to
 * the extent they are still unused; the rest is reported as a shortfall so the ledger never shows a negative balance. A FULL refund of the payment that cleared the
 * setup fee sets the setup status to "refunded": nothing new is provisioned until a payment or a waiver clears it again, and nothing already running is paused.
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
    // Only the payment that cleared the fee (or a fee marked paid by hand before payments were recorded) can take the status back: refunding a duplicate leaves it.
    if (p.kind === "setup_fee" && next >= total) {
      await db.query("update billing_accounts set setup_payment_status = 'refunded', updated_at = now() where org_id = $1 and setup_payment_status = 'paid' and (verified_payment_id = $2 or verified_payment_id is null)", [p.org_id, p.id]);
    }
    await recordAudit({ orgId: p.org_id, actorUserId: input.actorUserId, actorKind: "agency", action: "billing.refund_recorded", targetType: "payment", targetId: p.id, result: "success", metadata: { amountMicros: input.amountMicros, removedMicros: removed.removedMicros, shortfallMicros: removed.shortfallMicros, reason: input.reason } }, db);
    return removed;
  });
}
