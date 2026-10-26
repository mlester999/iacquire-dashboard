import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { formatMinor, toDecimalString, type CurrencyCode } from "@/lib/money";
import { checkoutBlock, type CheckoutAudience, type CheckoutBlock, type ConnectionMode, type ConnectionStatus, type PaymentProviderId } from "@/lib/invoices/connection-rules";
import type { AttemptFacts } from "@/lib/invoices/payment-events";
import { addInvoiceEvent, toMinor } from "@/server/invoices/core";
import { INVOICES_NOT_ENABLED_MESSAGE, invoicesEnabledIn } from "@/server/invoices/feature";
import { workspaceTakesNoCustomers } from "@/server/invoices/workspace-gate";
import { credentialVault } from "@/server/customer-payments/credentials";
import { flagRefusedKey } from "@/server/customer-payments/key-refused";
import { newReference } from "@/server/customer-payments/ids";
import { returnUrlsFor } from "@/server/customer-payments/links";
import { paymentSwitches } from "@/server/customer-payments/switches";
import { providerFor, type ProviderResolver } from "@/server/customer-payments/providers";
import { ProviderCallError } from "@/server/customer-payments/providers/types";

// Starting a customer's payment: one checkout attempt per invoice at a time, for the invoice's balance as the SERVER worked it out (an amount a browser sent is never
// read), through a connection that is allowed to take it. Starting is deliberately three steps so a slow provider never holds a database lock: reserve the attempt (and
// its reference) in one transaction, ask the provider outside any transaction, then store the provider's answer. A crash in between leaves an attempt with no checkout
// that the reconcile job closes; it never leaves a checkout this product does not know about.

/** How long an attempt is open, from its creation. A proposal; the provider's own checkout page may outlive it, and a payment made late is still recorded. */
export const ATTEMPT_TTL_HOURS = 24;
/** A checkout request that has had no answer for this long is no longer "being set up". */
export const SETTING_UP_SECONDS = 600;
/** A second request while the first is still being answered is told to wait rather than starting another. */
const WAIT_SECONDS = 60;

export interface AttemptRow {
  id: string;
  org_id: string;
  invoice_id: string;
  connection_id: string;
  currency: CurrencyCode;
  amount_minor: string;
  reference: string;
  provider_checkout_id: string | null;
  status: "created" | "redirected" | "succeeded" | "failed" | "expired" | "cancelled" | "needs_review";
  expires_at: Date | null;
  created_at: Date;
  /** Whether the invoice this checkout is for is a test invoice (read with the attempt by its reference). */
  invoice_is_test?: boolean;
}

export const ATTEMPT_COLUMNS = "id, org_id, invoice_id, connection_id, currency, amount_minor::text as amount_minor, reference, provider_checkout_id, status, expires_at, created_at";

/** The attempt this connection issued under a reference. The lookup names the connection, so a reference from another workspace is simply not found. */
export async function attemptByReference(db: Queryable, connectionId: string, reference: string, lock = false): Promise<AttemptRow | null> {
  const { rows } = await db.query<AttemptRow>(
    `select ${ATTEMPT_COLUMNS}, (select i.is_test from customer_invoices i where i.id = customer_payment_attempts.invoice_id and i.org_id = customer_payment_attempts.org_id) as invoice_is_test
     from customer_payment_attempts where connection_id = $1 and reference = $2${lock ? " for update" : ""}`, [connectionId, reference],
  );
  return rows[0] ?? null;
}

export function attemptFacts(a: AttemptRow, now: Date): AttemptFacts {
  const age = (now.getTime() - new Date(a.created_at).getTime()) / 1000;
  return {
    reference: a.reference, checkoutId: a.provider_checkout_id, settingUp: a.provider_checkout_id === null && a.status === "created" && age < SETTING_UP_SECONDS, amountMinor: toMinor(a.amount_minor), currency: a.currency,
    invoiceIsTest: a.invoice_is_test === true,
  };
}

interface ConnRow {
  id: string;
  provider: PaymentProviderId;
  mode: ConnectionMode;
  status: ConnectionStatus;
  credentials: string | null;
  supported_currencies: string[];
  authorized_at: Date | null;
  live_confirmed_at: Date | null;
}

const PROVIDER_ORDER: PaymentProviderId[] = ["paymongo", "paypal", "simulated"];

export interface StartCheckoutInput {
  orgId: string;
  invoiceId: string;
  audience: CheckoutAudience;
  /** The signed-in member starting it (a test payment, the owner opening the link); null for a customer. */
  actorUserId?: string | null;
  /** Only a connection in this mode may take it. A test payment from the screen passes "test", so a connected live account is never asked to take a test. */
  onlyMode?: ConnectionMode;
}

export interface StartCheckoutResult {
  attemptId: string;
  /** The provider's own page. The caller sends the payer there; it is never stored in a message, a log or an event. */
  checkoutUrl: string;
  /** The same checkout an earlier request made, found again. */
  reused: boolean;
  provider: PaymentProviderId;
  amountMinor: number;
  currency: CurrencyCode;
}

/** A customer is told only what they can act on; the team is told the reason. */
function unavailable(audience: CheckoutAudience, block: CheckoutBlock | null, fallback?: string): AppError {
  if (audience === "public") return new AppError("unavailable", "Online payment is not available for this invoice right now. Please contact the business to arrange payment.");
  return new AppError("conflict", block?.message ?? fallback ?? "A payment cannot be started for this invoice.");
}

type Plan =
  /** Nothing can be started. Returned, not thrown, so what was learned on the way (a connection whose keys cannot be read) is committed. */
  | { kind: "refused"; error: AppError }
  | { kind: "reuse"; attemptId: string; checkoutUrl: string; provider: PaymentProviderId; amountMinor: number; currency: CurrencyCode }
  | { kind: "create"; attemptId: string; reference: string; connectionId: string; provider: PaymentProviderId; credentials: string; amountMinor: number; currency: CurrencyCode; number: string };

/**
 * Starts (or finds again) the checkout for an invoice's balance. Refused unless the invoice is issued, owes something, is not written off or disputed, and a connection
 * that may take the payment is ready. Press-twice, two tabs and a retry all find the one open checkout.
 */
export async function startCheckout(input: StartCheckoutInput, deps: { providerFor?: ProviderResolver; now?: Date } = {}): Promise<StartCheckoutResult> {
  const now = deps.now ?? new Date();
  const resolve = deps.providerFor ?? providerFor;
  const sw = paymentSwitches();
  const actor = input.actorUserId ? { id: input.actorUserId, kind: "user" as const } : { id: null, kind: "customer" as const };

  const plan = await withSystem(async (db): Promise<Plan> => {
    const inv = (await db.query<{ status: string; payment_status: string; currency: CurrencyCode; balance_minor: string; written_off_at: Date | null; number: string | null; is_test: boolean }>(
      "select status, payment_status, currency, balance_minor::text as balance_minor, written_off_at, number, is_test from customer_invoices where id = $1 and org_id = $2 for update", [input.invoiceId, input.orgId],
    )).rows[0];
    if (!inv) throw new AppError("not_found", "That invoice was not found.");
    // Switching invoicing off for a workspace stops new payments from being started (a payment already on its way is still recorded when it arrives).
    if (!(await invoicesEnabledIn(db, input.orgId))) return { kind: "refused", error: input.audience === "public" ? unavailable("public", null) : new AppError("not_enabled", INVOICES_NOT_ENABLED_MESSAGE) };
    // A workspace that takes no customers (suspended, archived, paused by iAcquire) starts no checkout for one: this is the one door every customer payment goes through.
    if (input.audience === "public" && (await workspaceTakesNoCustomers(db, input.orgId))) return { kind: "refused", error: unavailable("public", null) };
    if (inv.status !== "issued") throw unavailable(input.audience, null, inv.status === "void" ? "This invoice is void, so it cannot be paid." : "This invoice has not been issued yet.");
    if (inv.written_off_at) throw unavailable(input.audience, null, "This invoice was written off, so it can no longer be paid online.");
    if (inv.payment_status === "disputed") throw unavailable(input.audience, null, "A payment on this invoice is disputed. Resolve that before taking another.");
    const balance = toMinor(inv.balance_minor);
    if (balance <= 0) throw new AppError("conflict", input.audience === "public" ? "This invoice has already been paid." : "This invoice has nothing left to pay.");

    // Test money and real money never meet: a test invoice is paid only through an account in test mode and a real invoice only through a live one, so a test payment never
    // lands on an invoice a customer owes and a live account is never asked to take a test.
    const wantMode: ConnectionMode = inv.is_test ? "test" : "live";
    if (input.onlyMode && input.onlyMode !== wantMode) throw unavailable(input.audience, null, inv.is_test ? "This is a test invoice, so it is paid through an account in test mode only." : "This is a real invoice, so it cannot be paid as a test. Only a test invoice can.");
    const everyConn = (await db.query<ConnRow>(
      "select id, provider, mode, status, credentials, supported_currencies, authorized_at, live_confirmed_at from customer_payment_connections where org_id = $1 and status <> 'revoked'", [input.orgId],
    )).rows;
    const conns = everyConn.filter((c) => c.mode === wantMode).sort((a, b) => PROVIDER_ORDER.indexOf(a.provider) - PROVIDER_ORDER.indexOf(b.provider));
    let firstBlock: CheckoutBlock | null = null;
    let usable: ConnRow | null = null;
    for (const c of conns) {
      const block = checkoutBlock({ provider: c.provider, mode: c.mode, status: c.status, supportedCurrencies: c.supported_currencies, authorizedAt: c.authorized_at, liveConfirmedAt: c.live_confirmed_at }, inv.currency, sw, input.audience);
      if (block) {
        firstBlock ??= block;
        continue;
      }
      if (!credentialVault.open(c.credentials)) {
        // The keys can no longer be opened (the encryption key changed): say so on the connection and do not pretend it works.
        await db.query("update customer_payment_connections set status = 'needs_attention', last_error = 'The saved keys can no longer be read. Paste the secret key again.' where id = $1 and status = 'connected'", [c.id]);
        firstBlock ??= { code: "needs_attention", message: "The payment account's keys can no longer be read." };
        continue;
      }
      usable = c;
      break;
    }
    if (!usable) {
      const none: CheckoutBlock = {
        code: "not_connected",
        message: inv.is_test ? "No payment account in test mode is connected."
          : everyConn.length ? "This is a real invoice, and the payment account connected is in test mode, which takes only test invoices." : "No payment account is connected.",
      };
      return { kind: "refused", error: unavailable(input.audience, firstBlock ?? none) };
    }

    const open = (await db.query<AttemptRow & { checkout_url: string | null }>(`select ${ATTEMPT_COLUMNS}, checkout_url from customer_payment_attempts where invoice_id = $1 and org_id = $2 and status in ('created', 'redirected') for update`, [input.invoiceId, input.orgId])).rows[0];
    if (open) {
      const expired = open.expires_at !== null && new Date(open.expires_at) <= now;
      const sameAmount = toMinor(open.amount_minor) === balance;
      if (!expired && sameAmount && open.connection_id === usable.id && open.checkout_url) {
        if (open.status === "created") await db.query("update customer_payment_attempts set status = 'redirected' where id = $1", [open.id]);
        return { kind: "reuse", attemptId: open.id, checkoutUrl: open.checkout_url, provider: usable.provider, amountMinor: balance, currency: inv.currency };
      }
      if (!expired && sameAmount && open.connection_id === usable.id && !open.checkout_url && (now.getTime() - new Date(open.created_at).getTime()) / 1000 < WAIT_SECONDS) {
        throw new AppError("conflict", "A payment is being set up for this invoice. Try again in a moment.", { retryAfterSeconds: 5 });
      }
      // A test must never close a checkout a customer may be using through another account.
      if (input.onlyMode && !expired && open.connection_id !== usable.id) throw new AppError("conflict", "A customer may be paying this invoice online right now through your live account. Wait for that to finish before running a test on it.");
      // Stale, or no longer for what is owed, or for a connection that is gone: it is closed here. The provider's page may still be payable; a payment made there is
      // recorded when the provider reports it (the attempt stays closed).
      await db.query("update customer_payment_attempts set status = $2 where id = $1", [open.id, expired ? "expired" : "cancelled"]);
    }

    const reference = newReference();
    const expiresAt = new Date(now.getTime() + ATTEMPT_TTL_HOURS * 3_600_000);
    const ins = await db.query<{ id: string }>(
      "insert into customer_payment_attempts (org_id, invoice_id, connection_id, currency, amount_minor, reference, status, expires_at) values ($1, $2, $3, $4, $5, $6, 'created', $7) returning id",
      [input.orgId, input.invoiceId, usable.id, inv.currency, balance, reference, expiresAt],
    );
    return { kind: "create", attemptId: ins.rows[0].id, reference, connectionId: usable.id, provider: usable.provider, credentials: usable.credentials as string, amountMinor: balance, currency: inv.currency, number: inv.number ?? "" };
  });

  if (plan.kind === "refused") throw plan.error;
  if (plan.kind === "reuse") return { attemptId: plan.attemptId, checkoutUrl: plan.checkoutUrl, reused: true, provider: plan.provider, amountMinor: plan.amountMinor, currency: plan.currency };

  const creds = credentialVault.open(plan.credentials);
  if (!creds) throw new AppError("internal", "The payment account's keys could not be read.");
  const adapter = resolve(plan.provider);
  const urls = returnUrlsFor(plan.reference);
  let created: Awaited<ReturnType<typeof adapter.createCheckout>>;
  try {
    created = await adapter.createCheckout(creds, {
      reference: plan.reference, amountMinor: plan.amountMinor, currency: plan.currency, description: plan.number ? `Invoice ${plan.number}` : "Invoice", successUrl: urls.successUrl, cancelUrl: urls.cancelUrl,
    });
  } catch (e) {
    const outcomeUnknown = e instanceof ProviderCallError && e.kind === "unreachable";
    // Unreachable: the provider may have made the checkout and the answer was lost, so the attempt stays open (nobody starts a second one) until the reconcile job closes
    // it. Anything else is a definite "no": the attempt is closed now and the payer can try again.
    if (!outcomeUnknown) await withSystem((db) => db.query("update customer_payment_attempts set status = 'failed' where id = $1 and status = 'created'", [plan.attemptId]));
    // The provider answered that it does not accept the saved key (401 or 403, not just any refusal, such as a currency it cannot take): the connection says so now, instead of
    // offering Pay online to the next customer until the daily check notices.
    if (e instanceof ProviderCallError && e.kind === "rejected" && (e.httpStatus === 401 || e.httpStatus === 403)) {
      await withSystem((db) => flagRefusedKey(db, { id: plan.connectionId, orgId: input.orgId }, e.message, now)).catch(() => undefined);
    }
    if (e instanceof ProviderCallError) {
      throw new AppError(outcomeUnknown ? "upstream_error" : "integration_unavailable", input.audience === "public"
        ? "The payment page could not be opened just now. Nothing was charged. Please try again in a few minutes."
        : /Nothing was charged/.test(e.message) ? e.message : `${e.message} Nothing was charged.`);
    }
    throw e;
  }

  return withSystem(async (db) => {
    const done = await db.query("update customer_payment_attempts set provider_checkout_id = $2, checkout_url = $3, status = 'redirected' where id = $1 and status = 'created' returning id", [plan.attemptId, created.checkoutId, created.checkoutUrl]);
    if (!done.rows[0]) {
      // Closed while the provider was being asked (the connection was disconnected, the invoice voided). Still remember the checkout the provider made, so a payment
      // made there is recognised.
      await db.query("update customer_payment_attempts set provider_checkout_id = $2 where id = $1 and provider_checkout_id is null", [plan.attemptId, created.checkoutId]);
      throw new AppError("conflict", input.audience === "public" ? "This payment could not be started. Please try again." : "The checkout was closed while it was being started. Try again.");
    }
    await addInvoiceEvent(db, input.orgId, input.invoiceId, "checkout_started", actor, { attemptId: plan.attemptId, provider: plan.provider, amount: toDecimalString(plan.amountMinor, plan.currency), currency: plan.currency, audience: input.audience });
    return { attemptId: plan.attemptId, checkoutUrl: created.checkoutUrl, reused: false, provider: plan.provider, amountMinor: plan.amountMinor, currency: plan.currency };
  });
}

/** The money in words, for messages. */
export const moneyWords = (minor: number, currency: CurrencyCode) => formatMinor(minor, currency, "code");
