import "server-only";
import { withSystem } from "@/server/db";
import { notifyOrgRoles } from "@/server/notifications";
import { sanitizeErrorText } from "@/lib/ops";
import type { PaymentProviderId } from "@/lib/invoices/connection-rules";
import { runCloseRule } from "@/server/invoices/close-rules";
import { credentialVault } from "@/server/customer-payments/credentials";
import { SETTING_UP_SECONDS } from "@/server/customer-payments/attempts";
import { markReceiptError, processReceipt, readBackAllowed, runEffects } from "@/server/customer-payments/events";
import { recordCheckoutPayments } from "@/server/customer-payments/read-back";
import { providerFor, type ProviderResolver } from "@/server/customer-payments/providers";
import { webhookUrlFor } from "@/server/customer-payments/links";

// The scheduled job that makes a lost or failed webhook harmless (customerPaymentReconcile). It runs only when the scheduler does, and in a staged start only when
// SCHEDULER_JOBS_ONLY names it. Every step is bounded, idempotent and safe to run twice, and none of them contacts a real provider unless the environment's calls
// switch is on (CUSTOMER_PAYMENTS_WRITES_ENABLED); the simulated provider reaches nothing and is available outside production.
//
//   1. Deliveries that were received but never finished (the process died, the provider's key was briefly unreachable) or that failed, and refunds that came before their
//      payment, are applied again from their receipts. A receipt that has waited three days for a payment that never came is let go.
//   2. Checkouts nobody paid in time are expired; a checkout request that never got an answer is closed.
//   3. Checkouts still open after half an hour are read back from the provider, so a payment whose webhook was lost is still recorded (through the same receipt path).
//   4. Each connection is checked once a day: a key the provider no longer accepts stops new payments and tells the owner.
//   5. The deal rules for invoices paid in the last week that did not get to run (the process died between the payment and the rule) run now.

const RETRY_AFTER_MINUTES = 10;
const POLL_AFTER_MINUTES = 30;
const POLL_EVERY_MINUTES = 15;
const HEALTH_EVERY_HOURS = 24;
export const MAX_ATTEMPTS = 10;

export interface ReconcileDeps {
  now?: Date;
  providerFor?: ProviderResolver;
}

export interface ReconcileReport {
  retried: number;
  expired: number;
  closedUnanswered: number;
  polled: number;
  recordedFromPoll: number;
  connectionsChecked: number;
  dealRules: number;
}

const minutes = (now: Date, m: number) => new Date(now.getTime() - m * 60_000);

async function retryReceipts(now: Date, deps: ReconcileDeps): Promise<number> {
  const ids = (await withSystem((db) =>
    db.query<{ id: string }>(
      `select id from customer_payment_events
       where received_at < $1 and ((outcome in ('received', 'error') and attempts < $2) or outcome = 'deferred')
       order by attempts, received_at limit 25`,
      [minutes(now, RETRY_AFTER_MINUTES), MAX_ATTEMPTS],
    ),
  )).rows;
  let n = 0;
  for (const { id } of ids) {
    try {
      const r = await processReceipt(id, { now, providerFor: deps.providerFor });
      await runEffects(r.effects);
      if (r.outcome !== "deferred" && r.outcome !== "duplicate") n += 1;
    } catch (e) {
      await markReceiptError(id, sanitizeErrorText(e)).catch(() => undefined);
    }
  }
  return n;
}

async function closeAttempts(now: Date): Promise<{ expired: number; closedUnanswered: number }> {
  return withSystem(async (db) => {
    const expired = await db.query("update customer_payment_attempts set status = 'expired' where status in ('created', 'redirected') and expires_at is not null and expires_at <= $1", [now]);
    const stuck = await db.query("update customer_payment_attempts set status = 'failed' where status = 'created' and provider_checkout_id is null and created_at < $1", [new Date(now.getTime() - SETTING_UP_SECONDS * 1000)]);
    return { expired: expired.rowCount, closedUnanswered: stuck.rowCount };
  });
}

interface PollRow {
  id: string;
  org_id: string;
  connection_id: string;
  provider_checkout_id: string;
  reference: string;
  provider: PaymentProviderId;
  mode: "test" | "live";
  credentials: string;
}

async function pollOpenAttempts(now: Date, deps: ReconcileDeps): Promise<{ polled: number; recorded: number }> {
  const resolve = deps.providerFor ?? providerFor;
  const rows = (await withSystem((db) =>
    db.query<PollRow>(
      `select a.id, a.org_id, a.connection_id, a.provider_checkout_id, a.reference, c.provider, c.mode, c.credentials
       from customer_payment_attempts a join customer_payment_connections c on c.id = a.connection_id and c.org_id = a.org_id
       where a.status in ('created', 'redirected') and a.provider_checkout_id is not null and a.created_at < $1 and a.updated_at < $2 and c.status <> 'revoked' and c.credentials is not null
       order by a.updated_at limit 20`,
      [minutes(now, POLL_AFTER_MINUTES), minutes(now, POLL_EVERY_MINUTES)],
    ),
  )).rows;
  let polled = 0;
  let recorded = 0;
  for (const a of rows) {
    // The environment's say first: no real provider is asked while its calls switch is off. The attempt is left alone, so it is looked at when the switch is on.
    if (!readBackAllowed(a.provider)) continue;
    let adapter;
    try {
      adapter = resolve(a.provider);
    } catch {
      continue;
    }
    const creds = credentialVault.open(a.credentials);
    if (!adapter.fetchCheckout || !creds) continue;
    try {
      const co = await adapter.fetchCheckout(creds, a.provider_checkout_id);
      polled += 1;
      // The provider's own record must name our reference, or it is not this checkout (recordCheckoutPayments checks that too).
      if (co && (co.reference === null || co.reference === a.reference)) {
        recorded += await recordCheckoutPayments({ connectionId: a.connection_id, orgId: a.org_id, mode: a.mode, reference: a.reference, providerCheckoutId: a.provider_checkout_id }, co, now, { providerFor: deps.providerFor });
        if (co.status === "expired" && !co.payments.some((p) => p.status === "paid")) {
          await withSystem((db) => db.query("update customer_payment_attempts set status = 'expired' where id = $1 and status in ('created', 'redirected')", [a.id]));
        }
      }
    } catch {
      // The provider could not be asked just now; the attempt is looked at again on a later run.
    }
    // Looked at: it is not asked about again for a while, so one slow provider cannot keep the same twenty at the front of the line.
    await withSystem((db) => db.query("update customer_payment_attempts set status = status where id = $1", [a.id])).catch(() => undefined);
  }
  return { polled, recorded };
}

interface HealthRow {
  id: string;
  org_id: string;
  provider: PaymentProviderId;
  public_key: string;
  status: "connected" | "needs_attention";
  credentials: string;
}

async function checkConnections(now: Date, deps: ReconcileDeps): Promise<number> {
  const resolve = deps.providerFor ?? providerFor;
  const rows = (await withSystem((db) =>
    db.query<HealthRow>(
      `select id, org_id, provider, public_key, status, credentials from customer_payment_connections
       where status in ('connected', 'needs_attention') and credentials is not null and (last_checked_at is null or last_checked_at < $1) order by last_checked_at nulls first limit 10`,
      [new Date(now.getTime() - HEALTH_EVERY_HOURS * 3_600_000)],
    ),
  )).rows;
  let checked = 0;
  for (const c of rows) {
    if (!readBackAllowed(c.provider)) continue;
    let adapter;
    try {
      adapter = resolve(c.provider);
    } catch {
      continue;
    }
    const creds = credentialVault.open(c.credentials);
    const check = creds
      ? await adapter.verifyCredentials(creds, { webhookUrl: webhookUrlFor(c.provider, c.public_key) })
      : ({ ok: false, reason: "rejected", message: "The saved keys can no longer be read. Paste the secret key again." } as const);
    checked += 1;
    await withSystem(async (db) => {
      if (check.ok) {
        await db.query(
          "update customer_payment_connections set last_checked_at = $2, last_error = null, status = case when $3::boolean then 'connected' else 'pending_verification' end where id = $1 and status in ('connected', 'needs_attention')",
          [c.id, now, Boolean(creds?.webhookSecret)],
        );
      } else if (check.reason === "rejected") {
        const changed = await db.query("update customer_payment_connections set last_checked_at = $2, last_error = $3, status = 'needs_attention' where id = $1 and status in ('connected', 'needs_attention') returning id", [c.id, now, check.message.slice(0, 400)]);
        if (changed.rows[0]) {
          await notifyOrgRoles(db, c.org_id, ["owner"], {
            kind: "payment_connection_attention", severity: "warning", title: "Your payment account needs attention",
            body: "The payment provider no longer accepts the saved key, so new online payments are paused until you reconnect it.", link: "/settings/payments", dedupeKey: `payment-connection:${c.id}:${now.toISOString().slice(0, 10)}`,
          });
        }
      } else {
        await db.query("update customer_payment_connections set last_checked_at = $2, last_error = $3 where id = $1", [c.id, now, check.message.slice(0, 400)]);
      }
    });
  }
  return checked;
}

async function sweepDealRules(now: Date): Promise<number> {
  const rows = (await withSystem((db) =>
    db.query<{ id: string; org_id: string }>(
      `select i.id, i.org_id from customer_invoices i join customer_invoice_settings s on s.org_id = i.org_id
       where i.status = 'issued' and i.payment_status in ('paid') and i.opportunity_id is not null and s.close_rule <> 'none' and i.updated_at > $1
         and not exists (select 1 from customer_invoice_events e where e.invoice_id = i.id and e.kind = 'close_rule_applied')
       order by i.updated_at desc limit 25`,
      [new Date(now.getTime() - 7 * 86_400_000)],
    ),
  )).rows;
  let acted = 0;
  for (const r of rows) {
    try {
      const out = await runCloseRule(r.org_id, r.id);
      if (out.taskId || out.decision.action === "won") acted += 1;
    } catch {
      // Tried again on the next run.
    }
  }
  return acted;
}

/** One pass of every step. Returns what it did, so the scheduler's heartbeat shows work, not just a run. */
export async function runCustomerPaymentReconcileDetailed(deps: ReconcileDeps = {}): Promise<ReconcileReport> {
  const now = deps.now ?? new Date();
  const errors: unknown[] = [];
  const step = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      errors.push(e);
      return fallback;
    }
  };
  // Order matters: what the provider already reported is applied first, then stale checkouts are closed, then the provider is asked about the rest.
  const retried = await step(() => retryReceipts(now, deps), 0);
  const closed = await step(() => closeAttempts(now), { expired: 0, closedUnanswered: 0 });
  const poll = await step(() => pollOpenAttempts(now, deps), { polled: 0, recorded: 0 });
  const connectionsChecked = await step(() => checkConnections(now, deps), 0);
  const dealRules = await step(() => sweepDealRules(now), 0);
  if (errors.length === 5) throw errors[0];
  if (errors.length) console.error("[iacquire] customer payment reconcile: some steps failed", { failed: errors.length });
  return { retried, expired: closed.expired, closedUnanswered: closed.closedUnanswered, polled: poll.polled, recordedFromPoll: poll.recorded, connectionsChecked, dealRules };
}

/** The scheduled job's body: the number of things it changed. */
export async function runCustomerPaymentReconcile(deps: ReconcileDeps = {}): Promise<number> {
  const r = await runCustomerPaymentReconcileDetailed(deps);
  return r.retried + r.expired + r.closedUnanswered + r.recordedFromPoll + r.connectionsChecked + r.dealRules;
}
