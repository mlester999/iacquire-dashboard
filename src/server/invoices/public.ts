import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { consumeRateLimit, type RateLimitRule } from "@/server/security/rate-limit";
import { hashIp } from "@/server/security/crypto";
import { sanitizeErrorText } from "@/lib/ops";
import { formatQuantity, isCurrency, type CurrencyCode } from "@/lib/money";
import { hashInvoiceToken, looksLikeInvoiceToken } from "@/lib/invoices/token";
import { checkoutBlock, REFERENCE_RE, type ConnectionMode, type ConnectionStatus, type PaymentProviderId } from "@/lib/invoices/connection-rules";
import { describeReturn, invoiceBanner, type AttemptState, type InvoiceBanner, type PaymentRowState, type ReturnDescription } from "@/lib/invoices/public-status";
import { PAY_DISABLED_MESSAGE, PAY_UNAVAILABLE_MESSAGE, type PayFailure } from "@/lib/invoices/public-http";
import { isOverdue, type InvoicePaymentStatus } from "@/lib/invoices/state";
import { addInvoiceEvent, INVOICE_COLUMNS, loadLines, readSettings, toMinor, type InvoiceRow } from "@/server/invoices/core";
import { invoicesEnabledIn } from "@/server/invoices/feature";
import { tokenIsFor } from "@/server/invoices/links";
import { invoicesPublicDisabled, workspaceTakesNoCustomers } from "@/server/invoices/workspace-gate";
import { publicCreditsOf } from "@/server/invoices/credit-notes";
import { startCheckout } from "@/server/customer-payments/attempts";
import { readBackAllowed } from "@/server/customer-payments/events";
import { credentialVault } from "@/server/customer-payments/credentials";
import { recordCheckoutPayments } from "@/server/customer-payments/read-back";
import { paymentSwitches, simulatedAllowed } from "@/server/customer-payments/switches";
import { providerFor, type ProviderResolver } from "@/server/customer-payments/providers";
import { ProviderCallError } from "@/server/customer-payments/providers/types";

// What a customer may do with the link to an invoice, and with the reference of a checkout they started. There is no session. The link (or the reference) is the only
// thing the caller holds, and the workspace is read from the invoice's own row: nothing a caller sends names a workspace, an invoice id or an amount. Every entry point
// is rate limited by the caller's address BEFORE it looks anything up, and every answer to a caller who holds nothing valid is the same ("invalid").
//
// Nothing here marks anything paid. The page shows what the database holds; a payment reaches the database only through a receipt (src/server/customer-payments).

export interface PublicContext {
  ip: string | null;
  now?: Date;
}

const VIEW_BY_IP: RateLimitRule = { name: "invoices:public:view:ip", limit: 90, windowSeconds: 600 };
const PAY_BY_IP: RateLimitRule = { name: "invoices:public:pay:ip", limit: 20, windowSeconds: 600 };
const PAY_BY_INVOICE: RateLimitRule = { name: "invoices:public:pay:invoice", limit: 12, windowSeconds: 600 };
const STATUS_BY_IP: RateLimitRule = { name: "invoices:public:status:ip", limit: 300, windowSeconds: 600 };
const CAPTURE_BY_IP: RateLimitRule = { name: "invoices:public:capture:ip", limit: 20, windowSeconds: 600 };

async function allowed(rule: RateLimitRule, ip: string | null): Promise<boolean> {
  return (await consumeRateLimit(rule, hashIp(ip) ?? "unknown")).allowed;
}

// ---------------------------------------------------------------------------
// The invoice a link opens
// ---------------------------------------------------------------------------

export interface PublicLine {
  position: number;
  description: string;
  quantity: string;
  unitPriceMinor: number;
  discountMinor: number;
  taxRateBps: number | null;
  /** What the line comes to: with tax included in the price when the invoice is tax-inclusive, before tax otherwise. */
  amountMinor: number;
}

export interface PublicBusiness {
  name: string;
  brandColor: string | null;
  addressLines: string[];
  taxLabel: string | null;
  taxId: string | null;
  email: string | null;
  phone: string | null;
}

export interface PublicInvoice {
  business: PublicBusiness;
  number: string;
  issueOn: string;
  dueOn: string;
  currency: CurrencyCode;
  taxInclusive: boolean;
  billTo: { name: string | null; company: string | null; addressLines: string[] };
  lines: PublicLine[];
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  paidMinor: number;
  /** The issued credit notes, each taken off what is owed. A credit note is not a payment. */
  creditedMinor: number;
  credits: Array<{ number: string; amountMinor: number; issuedOn: string }>;
  balanceMinor: number;
  paymentStatus: InvoicePaymentStatus;
  overdue: boolean;
  paymentInstructions: string | null;
  notes: string | null;
  terms: string | null;
  footerNote: string | null;
  hasPendingPayment: boolean;
  /** An online payment can be started right now (the invoice owes something and a connected account may take it). */
  canPayOnline: boolean;
  /** A test invoice: nothing is owed on it and no money moves. */
  isTest: boolean;
  banner: InvoiceBanner;
}

/** "unavailable": the business takes no customers right now (suspended, archived, paused). "disabled": the whole customer-facing side is switched off (INVOICES_PUBLIC_DISABLED). */
export type PublicInvoiceResult = { state: "ok"; invoice: PublicInvoice } | { state: "invalid" } | { state: "rate_limited" } | { state: "unavailable" } | { state: "disabled" };

interface Found extends InvoiceRow {
  token_hash: string | null;
}

/** The issued invoice a link opens, or null. A link that was replaced, a voided invoice (its link is removed) and anything made up all read as null. */
async function findByToken(db: Queryable, token: string): Promise<InvoiceRow | null> {
  if (!looksLikeInvoiceToken(token)) return null;
  const { rows } = await db.query<Found>(`select ${INVOICE_COLUMNS}, i.public_token_hash as token_hash from customer_invoices i where i.public_token_hash = $1`, [hashInvoiceToken(token)]);
  const r = rows[0];
  if (!r || r.status !== "issued" || !tokenIsFor(token, r.id, r.public_token_version, r.token_hash)) return null;
  return r;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : []);
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

async function businessFor(db: Queryable, orgId: string, billFrom: Record<string, unknown>): Promise<PublicBusiness> {
  const org = (await db.query<{ name: string }>("select name from organizations where id = $1", [orgId])).rows[0];
  const profile = (await db.query<{ brand_color: string | null; contact_email: string | null; contact_phone: string | null }>("select brand_color, contact_email, contact_phone from company_profiles where org_id = $1", [orgId])).rows[0];
  return {
    name: text(billFrom.name) ?? org?.name ?? "Your supplier", brandColor: profile?.brand_color ?? null, addressLines: strings(billFrom.addressLines), taxLabel: text(billFrom.taxLabel), taxId: text(billFrom.taxId),
    email: text(billFrom.replyToEmail) ?? profile?.contact_email ?? null, phone: profile?.contact_phone ?? null,
  };
}

/**
 * Whether a connected account could take a customer's payment for this invoice now (the same rule a checkout is started under, without opening any key). A test invoice is
 * offered only an account in test mode and a real invoice only a live one.
 */
async function onlinePaymentPossible(db: Queryable, orgId: string, currency: CurrencyCode, isTest: boolean): Promise<boolean> {
  if (!(await invoicesEnabledIn(db, orgId))) return false;
  const sw = paymentSwitches();
  const { rows } = await db.query<{ provider: PaymentProviderId; mode: ConnectionMode; status: ConnectionStatus; supported_currencies: string[]; authorized_at: Date | null; live_confirmed_at: Date | null }>(
    "select provider, mode, status, supported_currencies, authorized_at, live_confirmed_at from customer_payment_connections where org_id = $1 and status <> 'revoked'", [orgId],
  );
  return rows.filter((c) => (c.mode === "test") === isTest).some((c) => checkoutBlock({ provider: c.provider, mode: c.mode, status: c.status, supportedCurrencies: c.supported_currencies, authorizedAt: c.authorized_at, liveConfirmedAt: c.live_confirmed_at }, currency, sw, "public") === null);
}

/**
 * The customer's view of an invoice. The first time anybody opens a valid link, the invoice records that it was opened (a security scanner can open a link too, so the
 * business is told "opened", not "read").
 */
export async function loadPublicInvoice(token: string, ctx: PublicContext): Promise<PublicInvoiceResult> {
  if (invoicesPublicDisabled()) return { state: "disabled" };
  if (!(await allowed(VIEW_BY_IP, ctx.ip))) return { state: "rate_limited" };
  const now = ctx.now ?? new Date();
  return withSystem(async (db): Promise<PublicInvoiceResult> => {
    const row = await findByToken(db, token);
    if (!row || !row.number || !row.issue_on || !row.due_on || !isCurrency(row.currency)) return { state: "invalid" };
    // A workspace that takes no customers shows nothing, and records no "opened" for a page nobody was shown.
    if (await workspaceTakesNoCustomers(db, row.org_id)) return { state: "unavailable" };
    const first = await db.query("update customer_invoices set first_viewed_at = $3 where id = $1 and org_id = $2 and first_viewed_at is null returning id", [row.id, row.org_id, now]);
    if (first.rows[0]) await addInvoiceEvent(db, row.org_id, row.id, "viewed", { id: null, kind: "customer" }, {});
    const [lines, settings, org, pending, canPayOnline] = await Promise.all([
      loadLines(db, row.org_id, row.id),
      readSettings(db, row.org_id),
      db.query<{ timezone: string }>("select timezone from organizations where id = $1", [row.org_id]),
      db.query("select 1 from customer_payments where invoice_id = $1 and org_id = $2 and status = 'pending' limit 1", [row.id, row.org_id]),
      onlinePaymentPossible(db, row.org_id, row.currency, row.is_test),
    ]);
    const tz = org.rows[0]?.timezone ?? "UTC";
    const credits = await publicCreditsOf(db, row.org_id, row.id, tz);
    const balanceMinor = toMinor(row.balance_minor);
    const owing = row.payment_status === "unpaid" || row.payment_status === "partially_paid";
    const overdue = isOverdue({ status: row.status, paymentStatus: row.payment_status, dueOn: row.due_on, writtenOff: row.written_off_at !== null, isTest: row.is_test }, now, tz);
    const stillPayable = balanceMinor > 0 && owing && row.written_off_at === null;
    const hasPendingPayment = pending.rows.length > 0;
    const billTo = row.bill_to ?? {};
    const erased = (billTo as Record<string, unknown>).erased === true;
    return {
      state: "ok",
      invoice: {
        business: await businessFor(db, row.org_id, row.bill_from ?? {}),
        number: row.number, issueOn: row.issue_on, dueOn: row.due_on, currency: row.currency, taxInclusive: row.tax_inclusive,
        // Only what the customer needs to recognise their own invoice: the name, the company and the address. Their email, phone and tax number stay with the business.
        billTo: erased ? { name: null, company: null, addressLines: [] } : { name: text(billTo.name), company: text(billTo.company), addressLines: strings(billTo.addressLines) },
        lines: lines.map((l) => ({
          position: l.position, description: l.description, quantity: formatQuantity(l.quantity_milli), unitPriceMinor: toMinor(l.unit_price_minor), discountMinor: toMinor(l.discount_minor), taxRateBps: l.tax_rate_bps,
          amountMinor: row.tax_inclusive ? toMinor(l.total_minor) : toMinor(l.ex_tax_minor),
        })),
        subtotalMinor: toMinor(row.subtotal_minor), taxMinor: toMinor(row.tax_minor), totalMinor: toMinor(row.total_minor), paidMinor: toMinor(row.paid_minor), creditedMinor: toMinor(row.credited_minor), credits, balanceMinor,
        paymentStatus: row.payment_status, overdue, paymentInstructions: row.payment_instructions, notes: row.notes, terms: row.terms, footerNote: settings.footerNote, hasPendingPayment,
        canPayOnline: canPayOnline && stillPayable && row.payment_status !== "disputed", isTest: row.is_test,
        banner: invoiceBanner({ paymentStatus: row.payment_status, balanceMinor, hasPendingPayment, canPayOnline: canPayOnline && stillPayable, overdue, isTest: row.is_test }),
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Paying
// ---------------------------------------------------------------------------

export type PayResult = { ok: true; url: string; reused: boolean } | { ok: false; reason: PayFailure; message: string; retryAfterSeconds?: number };

const INVALID_LINK = "This link is not valid. Open the link from the message you received.";
const TRY_AGAIN = "The payment page could not be opened just now. Nothing was charged. Please try again in a few minutes.";

/**
 * Where to send the customer. A real provider's checkout page is its own https address. The simulated provider (outside production only) has no page of its own, so the
 * customer goes to this product's testing checkout, which acts as the provider and posts a signed event to the real webhook route.
 */
export function checkoutTarget(provider: PaymentProviderId, attemptId: string, checkoutUrl: string): string | null {
  if (provider === "simulated") return simulatedAllowed() ? `/dev/simulated-checkout/${attemptId}` : null;
  try {
    return new URL(checkoutUrl).protocol === "https:" ? checkoutUrl : null;
  } catch {
    return null;
  }
}

/** Starts (or finds again) the one open checkout for the invoice behind a link, for the balance the SERVER works out. The caller can send nothing but the link. */
export async function startPublicPayment(token: string, ctx: PublicContext, deps: { providerFor?: ProviderResolver } = {}): Promise<PayResult> {
  if (invoicesPublicDisabled()) return { ok: false, reason: "disabled", message: PAY_DISABLED_MESSAGE };
  if (!(await allowed(PAY_BY_IP, ctx.ip))) return { ok: false, reason: "rate_limited", message: "Too many attempts in a short while. Wait a few minutes, then try again." };
  const row = await withSystem(async (db) => {
    const found = await findByToken(db, token);
    // A workspace that takes no customers starts no checkout (startCheckout asks again for itself, for every other way in).
    return found && (await workspaceTakesNoCustomers(db, found.org_id)) ? "stopped" : found;
  });
  if (row === "stopped") return { ok: false, reason: "unavailable", message: PAY_UNAVAILABLE_MESSAGE };
  if (!row) return { ok: false, reason: "invalid", message: INVALID_LINK };
  // A link that is hammered cannot be used to flood a provider with checkout requests.
  if (!(await consumeRateLimit(PAY_BY_INVOICE, row.id)).allowed) return { ok: false, reason: "rate_limited", message: "Too many attempts in a short while. Wait a few minutes, then try again." };
  try {
    const started = await startCheckout({ orgId: row.org_id, invoiceId: row.id, audience: "public" }, { providerFor: deps.providerFor, now: ctx.now });
    const url = checkoutTarget(started.provider, started.attemptId, started.checkoutUrl);
    if (!url) return { ok: false, reason: "unavailable", message: PAY_UNAVAILABLE_MESSAGE };
    return { ok: true, url, reused: started.reused };
  } catch (e) {
    if (e instanceof AppError) {
      if (e.code === "conflict" && /already been paid|nothing left/i.test(e.message)) return { ok: false, reason: "paid", message: e.message };
      if (e.code === "unavailable" || e.code === "not_enabled") return { ok: false, reason: "unavailable", message: PAY_UNAVAILABLE_MESSAGE };
      if (e.code === "not_found") return { ok: false, reason: "invalid", message: INVALID_LINK };
      // Everything else a customer is told is a sentence startCheckout wrote for a customer, or the plain retry line.
      return { ok: false, reason: "try_again", message: e.code === "conflict" || e.code === "upstream_error" || e.code === "integration_unavailable" ? e.message : TRY_AGAIN, retryAfterSeconds: e.retryAfterSeconds };
    }
    if (e instanceof ProviderCallError) return { ok: false, reason: "try_again", message: TRY_AGAIN };
    console.error("[iacquire] a customer's payment could not be started", { problem: sanitizeErrorText(e) });
    return { ok: false, reason: "try_again", message: TRY_AGAIN };
  }
}

// ---------------------------------------------------------------------------
// Coming back from the provider
// ---------------------------------------------------------------------------

interface AttemptRead {
  attempt_id: string;
  org_id: string;
  invoice_id: string;
  connection_id: string;
  status: AttemptState;
  amount_minor: string;
  currency: CurrencyCode;
  reference: string;
  provider_checkout_id: string | null;
  created_at: Date;
  provider: PaymentProviderId;
  mode: ConnectionMode;
  conn_status: ConnectionStatus;
  credentials: string | null;
  invoice_status: "draft" | "pending_approval" | "issued" | "void";
  number: string | null;
  bill_from: Record<string, unknown>;
  is_test: boolean;
}

async function findByReference(db: Queryable, reference: string): Promise<AttemptRead | null> {
  if (!REFERENCE_RE.test(reference)) return null;
  const { rows } = await db.query<AttemptRead>(
    `select a.id as attempt_id, a.org_id, a.invoice_id, a.connection_id, a.status, a.amount_minor::text as amount_minor, a.currency, a.reference, a.provider_checkout_id, a.created_at,
       c.provider, c.mode, c.status as conn_status, c.credentials, i.status as invoice_status, i.number, i.bill_from, i.is_test
     from customer_payment_attempts a
       join customer_invoices i on i.id = a.invoice_id and i.org_id = a.org_id
       join customer_payment_connections c on c.id = a.connection_id and c.org_id = a.org_id
     where a.reference = $1`, [reference],
  );
  return rows[0] ?? null;
}

/** The payment recorded against a checkout. A counted one wins over one kept for review, which wins over a pending one, which wins over a failed one. */
async function paymentOfAttempt(db: Queryable, orgId: string, attemptId: string): Promise<{ status: PaymentRowState } | null> {
  const { rows } = await db.query<{ status: PaymentRowState }>(
    `select status from customer_payments where attempt_id = $1 and org_id = $2
     order by case status when 'succeeded' then 0 when 'partially_refunded' then 0 when 'refunded' then 0 when 'disputed' then 0 when 'needs_review' then 1 when 'pending' then 2 else 3 end, created_at desc limit 1`,
    [attemptId, orgId],
  );
  return rows[0] ?? null;
}

export interface ReturnView {
  business: { name: string; brandColor: string | null };
  invoiceNumber: string | null;
  amountMinor: number;
  currency: CurrencyCode;
  reference: string;
  description: ReturnDescription;
  /** The checkout was for a test invoice. */
  isTest: boolean;
}

export type ReturnResult = { state: "ok"; view: ReturnView } | { state: "invalid" } | { state: "rate_limited" } | { state: "disabled" };

const minutesBetween = (from: Date, to: Date) => Math.max(0, (to.getTime() - new Date(from).getTime()) / 60_000);

async function returnViewOf(db: Queryable, a: AttemptRead, now: Date, saidCancelled: boolean): Promise<ReturnView> {
  const payment = await paymentOfAttempt(db, a.org_id, a.attempt_id);
  const profile = (await db.query<{ brand_color: string | null }>("select brand_color from company_profiles where org_id = $1", [a.org_id])).rows[0];
  const org = (await db.query<{ name: string }>("select name from organizations where id = $1", [a.org_id])).rows[0];
  const name = text(a.bill_from?.name) ?? org?.name ?? "The business";
  return {
    business: { name, brandColor: profile?.brand_color ?? null }, invoiceNumber: a.number, amountMinor: toMinor(a.amount_minor), currency: a.currency, reference: a.reference, isTest: a.is_test,
    description: describeReturn({ attemptStatus: a.status, payment, invoiceStatus: a.invoice_status, ageMinutes: minutesBetween(a.created_at, now), saidCancelled, isTest: a.is_test }),
  };
}

/** What the page a provider sends the customer back to shows. The reference is not the invoice's link: it reaches this one checkout's outcome and nothing else. */
export async function loadReturn(reference: string, ctx: PublicContext & { saidCancelled?: boolean }): Promise<ReturnResult> {
  if (invoicesPublicDisabled()) return { state: "disabled" };
  if (!(await allowed(STATUS_BY_IP, ctx.ip))) return { state: "rate_limited" };
  return withSystem(async (db): Promise<ReturnResult> => {
    const a = await findByReference(db, reference);
    if (!a) return { state: "invalid" };
    return { state: "ok", view: await returnViewOf(db, a, ctx.now ?? new Date(), ctx.saidCancelled === true) };
  });
}

/** Polled by the return page. The answer is the same description the page was rendered with, recomputed from the database. */
export async function paymentStatusByReference(reference: string, ctx: PublicContext): Promise<ReturnResult> {
  return loadReturn(reference, ctx);
}

export interface InvoiceStatusView {
  paymentStatus: InvoicePaymentStatus;
  balanceMinor: number;
  currency: CurrencyCode;
  hasPendingPayment: boolean;
  banner: InvoiceBanner;
}

/** The invoice's own payment status, by its link, for a page that stays open. "paid" appears only when the database says paid. */
export async function paymentStatusByToken(token: string, ctx: PublicContext): Promise<{ state: "ok"; status: InvoiceStatusView } | { state: "invalid" } | { state: "rate_limited" } | { state: "unavailable" } | { state: "disabled" }> {
  if (invoicesPublicDisabled()) return { state: "disabled" };
  if (!(await allowed(STATUS_BY_IP, ctx.ip))) return { state: "rate_limited" };
  return withSystem(async (db) => {
    const row = await findByToken(db, token);
    if (!row || !isCurrency(row.currency)) return { state: "invalid" as const };
    if (await workspaceTakesNoCustomers(db, row.org_id)) return { state: "unavailable" as const };
    const pending = (await db.query("select 1 from customer_payments where invoice_id = $1 and org_id = $2 and status = 'pending' limit 1", [row.id, row.org_id])).rows.length > 0;
    const balanceMinor = toMinor(row.balance_minor);
    return {
      state: "ok" as const,
      status: { paymentStatus: row.payment_status, balanceMinor, currency: row.currency, hasPendingPayment: pending, banner: invoiceBanner({ paymentStatus: row.payment_status, balanceMinor, hasPendingPayment: pending, canPayOnline: balanceMinor > 0, overdue: false, isTest: row.is_test }) },
    };
  });
}

// ---------------------------------------------------------------------------
// A provider where approval does not take the money (PayPal)
// ---------------------------------------------------------------------------

export type CaptureResult = { ok: true } | { ok: false; reason: "invalid" | "rate_limited" | "unavailable" | "try_again" };

/**
 * After the customer approves at the provider, asks the provider to take the payment they approved. It names the checkout the provider says was approved; that must be the
 * one this product stored for the reference. What the provider answers is read back like any other checkout and becomes a receipt: nothing is counted here.
 */
export async function completeApprovedCheckout(reference: string, providerCheckoutId: string, ctx: PublicContext, deps: { providerFor?: ProviderResolver } = {}): Promise<CaptureResult> {
  if (invoicesPublicDisabled()) return { ok: false, reason: "unavailable" };
  if (!(await allowed(CAPTURE_BY_IP, ctx.ip))) return { ok: false, reason: "rate_limited" };
  const now = ctx.now ?? new Date();
  const resolve = deps.providerFor ?? providerFor;
  const a = await withSystem((db) => findByReference(db, reference));
  if (!a || !a.provider_checkout_id || a.provider_checkout_id !== providerCheckoutId) return { ok: false, reason: "invalid" };
  // Only a checkout that is still open is completed: a cancelled, expired or finished one is left exactly as it is.
  if (a.status !== "created" && a.status !== "redirected") return { ok: true };
  if (a.conn_status === "revoked" || !a.credentials) return { ok: false, reason: "unavailable" };
  if (!readBackAllowed(a.provider)) return { ok: false, reason: "unavailable" };
  try {
    const adapter = resolve(a.provider);
    const creds = credentialVault.open(a.credentials);
    if (!adapter.completeCheckout || !creds) return { ok: true };
    const co = await adapter.completeCheckout(creds, providerCheckoutId, { reference: a.reference });
    if (co) await recordCheckoutPayments({ connectionId: a.connection_id, orgId: a.org_id, mode: a.mode, reference: a.reference, providerCheckoutId }, co, now, { providerFor: deps.providerFor });
    return { ok: true };
  } catch (e) {
    console.error("[iacquire] a customer's approved payment could not be completed yet", { problem: e instanceof ProviderCallError ? e.kind : sanitizeErrorText(e) });
    // Not lost: the provider's notification, or the scheduled check, records the payment if it was taken.
    return { ok: false, reason: "try_again" };
  }
}
