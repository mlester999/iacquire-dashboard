import "server-only";
import crypto from "node:crypto";
import { withSystem } from "@/server/db";
import { consumeRateLimit, type RateLimitRule } from "@/server/security/rate-limit";
import { hashIp, sha256 } from "@/server/security/crypto";
import { sanitizeErrorText } from "@/lib/ops";
import { isPaymentProvider, PUBLIC_KEY_RE, type PaymentProviderId } from "@/lib/invoices/connection-rules";
import { emptyEvent, looksLikeOurReference, type NormalizedEvent } from "@/lib/invoices/payment-events";
import { credentialVault } from "@/server/customer-payments/credentials";
import { isFinished, markReceiptError, processReceipt, runEffects, storeReceipt, type ProcessDeps } from "@/server/customer-payments/events";
import { providerFor, type ProviderResolver } from "@/server/customer-payments/providers";
import { paymentSwitches } from "@/server/customer-payments/switches";
import type { HeaderReader } from "@/server/customer-payments/providers/types";

// The address a business's payment provider delivers its webhooks to: /api/webhooks/customer-payments/<provider>/<connection key>. There is no session. The
// delivery is trusted only by its signature, checked with THAT connection's own signing secret, and the workspace is whichever workspace owns that connection in our
// records; nothing in the body ever names the workspace, and an event that names another workspace's checkout finds nothing there.
//
// Order: look the connection up from the address, open its secret, verify the signature (all of these failing answers are one and the same bare 403, so a caller
// learns nothing about which keys exist, and nothing is stored for a request that was not authenticated), read the event, commit its receipt (transaction 1), apply it
// (transaction 2) and, if that fails, record the failure (transaction 3) and answer 500 so the provider sends it again. A provider whose deliveries can only be checked by
// calling it (PayPal) is answered 503 with Retry-After, before any lookup, while the environment's switch for real provider calls is off.

/** The largest delivery accepted. Real events are a few kilobytes. */
export const MAX_BODY_BYTES = 256_000;
/** After this many failed tries the delivery is acknowledged, so a poison event does not make the provider retry for ever; the receipt stays in "error" for the reconcile job and the alarm. */
export const MAX_REDELIVERIES = 5;

const BY_IP: RateLimitRule = { name: "customer-payments:webhook:ip", limit: 600, windowSeconds: 60 };
const BY_KEY: RateLimitRule = { name: "customer-payments:webhook:key", limit: 1200, windowSeconds: 60 };
/**
 * For a provider that checks a delivery by being asked (PayPal): each delivery that gets as far as the check spends two calls of the business's own credentials at the
 * provider, however false it is, and anyone who knows a connection's address can send one. A business's real deliveries are a few a minute, so this leaves them untouched
 * and stops the address being used to run the business's account into the provider's own limits.
 */
const REMOTE_CHECK_BY_KEY: RateLimitRule = { name: "customer-payments:webhook:remote-check:key", limit: 120, windowSeconds: 60 };

export interface WebhookInput {
  provider: string;
  key: string;
  rawBody: string;
  headers: HeaderReader;
  ip: string | null;
  now?: Date;
}

export interface WebhookResult {
  status: 200 | 403 | 413 | 429 | 500 | 503;
  body: Record<string, unknown>;
  outcome?: string;
  /** For a 503: when the provider should send the delivery again. */
  retryAfterSeconds?: number;
}

/** How long a provider is asked to wait when a delivery is turned away until real provider calls are switched on. PayPal retries for a few days, so a short wait costs nothing. */
export const SWITCHED_OFF_RETRY_SECONDS = 600;

const forbidden = (): WebhookResult => ({ status: 403, body: { error: "forbidden" }, outcome: "rejected" });
const ok = (outcome: string): WebhookResult => ({ status: 200, body: { received: true, outcome }, outcome });

interface ConnectionLookup {
  id: string;
  org_id: string;
  provider: PaymentProviderId;
  mode: "test" | "live";
  status: string;
  credentials: string | null;
}

/** Work comparable to a real check, so a key that does not exist does not answer faster than a wrong signature. */
function spendTheSameEffort(rawBody: string) {
  crypto.createHmac("sha256", "customer-payments-decoy").update(rawBody).digest();
}

/** Whether this provider's deliveries are checked by asking the provider. A provider the server cannot use at all (the simulated one in production) is not one. */
function verifiesRemotely(resolve: ProviderResolver, provider: PaymentProviderId): boolean {
  try {
    return resolve(provider).verifiesRemotely === true;
  } catch {
    return false;
  }
}

/** An event the business's other sales produce: this product only ever issues references of its own shape, so a payment without one is not ours and is not stored. */
const isForeignPayment = (e: NormalizedEvent) => (e.kind === "payment.succeeded" || e.kind === "payment.failed" || e.kind === "payment.pending") && !looksLikeOurReference(e.reference);

export async function handleCustomerPaymentWebhook(input: WebhookInput, deps: ProcessDeps = {}): Promise<WebhookResult> {
  const now = input.now ?? deps.now ?? new Date();
  const resolve = deps.providerFor ?? providerFor;
  if (input.rawBody.length > MAX_BODY_BYTES) return { status: 413, body: { received: false } };
  if (!isPaymentProvider(input.provider) || !PUBLIC_KEY_RE.test(input.key)) {
    spendTheSameEffort(input.rawBody);
    return forbidden();
  }
  if (input.ip) {
    const limit = await consumeRateLimit(BY_IP, hashIp(input.ip) ?? "unknown");
    if (!limit.allowed) return { status: 429, body: { error: "rate_limited" } };
  }
  // A provider that checks a delivery by being asked (PayPal) costs two real calls with the business's own credentials, and the environment's calls switch says no real
  // provider is called while it is off. So the delivery is turned away, before the connection is even looked up (every address gets the same answer), with a retry: nothing is
  // stored, and once the switch is on the provider's retry, or the scheduled check of open checkouts, records the payment.
  if (!paymentSwitches().writesEnabled && verifiesRemotely(resolve, input.provider)) {
    return { status: 503, body: { received: false, error: "unavailable" }, outcome: "unavailable", retryAfterSeconds: SWITCHED_OFF_RETRY_SECONDS };
  }

  const conn = (await withSystem((db) =>
    db.query<ConnectionLookup>("select id, org_id, provider, mode, status, credentials from customer_payment_connections where public_key = $1 and provider = $2", [input.key, input.provider]),
  )).rows[0];
  // A disconnected connection has no keys. A paused one (or one that needs attention) still verifies and records: money that arrived is recorded whatever the state.
  if (!conn || conn.status === "revoked" || !conn.credentials) {
    spendTheSameEffort(input.rawBody);
    return forbidden();
  }
  let adapter;
  try {
    adapter = resolve(conn.provider);
  } catch {
    return forbidden();
  }
  const creds = credentialVault.open(conn.credentials);
  if (!creds?.webhookSecret) return forbidden();
  if (adapter.verifiesRemotely && !(await consumeRateLimit(REMOTE_CHECK_BY_KEY, conn.id)).allowed) return { status: 429, body: { error: "rate_limited" } };
  const sig = await adapter.verifyWebhook({ rawBody: input.rawBody, headers: input.headers, secret: creds.webhookSecret, now: now.getTime(), credentials: creds });
  if (!sig.ok) return forbidden();

  // Authenticated from here on. A delivery is now answered on its merits.
  const keyLimit = await consumeRateLimit(BY_KEY, conn.id);
  if (!keyLimit.allowed) return { status: 429, body: { error: "rate_limited" } };

  const sha = sha256(input.rawBody);
  const target = { id: conn.id, orgId: conn.org_id };
  const connLive = conn.mode === "live";
  const parsed = adapter.parseEvent(input.rawBody, { connectionLive: connLive });
  if (!parsed) {
    const unreadable = emptyEvent("ignored", { eventId: `unreadable:${sha.slice(0, 40)}`, type: "unreadable", livemode: connLive });
    await storeReceipt(target, unreadable, sha, { outcome: "rejected", note: "The delivery was signed correctly but could not be read." });
    return ok("rejected");
  }
  const event = parsed.event;
  if (event.kind === "ignored" || isForeignPayment(event)) {
    // Not ours to keep a record of (a type this product does not use, or one of the business's other sales); the connection still shows it heard from the provider.
    await withSystem((db) => db.query("update customer_payment_connections set last_event_at = now() where id = $1 and org_id = $2", [conn.id, conn.org_id]));
    return ok("ignored");
  }
  if ((sig.livemode !== null && sig.livemode !== event.livemode) || event.livemode !== connLive) {
    await storeReceipt(target, event, sha, { outcome: "rejected", note: sig.livemode !== null && sig.livemode !== event.livemode ? "The event's mode does not match its signature." : "The event is from the other mode (test or live) than this connection." });
    return ok("rejected");
  }

  const stored = await storeReceipt(target, event, sha);
  if (!stored.created && isFinished(stored.outcome)) return ok("duplicate");
  try {
    const done = await processReceipt(stored.receiptId, { providerFor: resolve, now });
    await runEffects(done.effects);
    return ok(done.outcome);
  } catch (e) {
    const failed = await markReceiptError(stored.receiptId, sanitizeErrorText(e)).catch(() => ({ attempts: 0 }));
    console.error("[iacquire] customer payment webhook processing failed", { type: e instanceof Error ? e.name : "unknown", attempts: failed.attempts });
    // Acknowledged after a few tries so the provider stops; the receipt stays open for the reconcile job and the alarm.
    return failed.attempts >= MAX_REDELIVERIES ? ok("error") : { status: 500, body: { received: false } };
  }
}
