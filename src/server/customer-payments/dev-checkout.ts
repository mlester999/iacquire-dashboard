import "server-only";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { REFERENCE_RE } from "@/lib/invoices/connection-rules";
import type { CurrencyCode } from "@/lib/money";
import { credentialVault } from "@/server/customer-payments/credentials";
import { simulatedAllowed } from "@/server/customer-payments/switches";
import { SIGNATURE_HEADER, signSimulatedBody, simulatedBody, simulatedPlatform } from "@/server/customer-payments/providers/simulated";

// The testing checkout: what a customer sees instead of a payment provider's page when the business's connection is the simulated provider. It exists so the whole path can
// be clicked through without any provider account. It does what a provider does, no more: it takes the amount the checkout asked for, and tells this product by posting a
// SIGNED event to the real webhook route, which authenticates it with the connection's own secret like any other delivery. It never writes a payment itself.
//
// Development and tests only. It does not exist in production (simulatedAllowed), and the simulated provider cannot be connected there either.

export interface SimulatedAttempt {
  attemptId: string;
  reference: string;
  checkoutId: string;
  amountMinor: number;
  currency: CurrencyCode;
  status: string;
  invoiceNumber: string | null;
  publicKey: string;
  webhookSecret: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The checkout of a simulated connection, by the attempt's id; null for anything else (another provider's attempt is not this page's to act on). */
export async function loadSimulatedAttempt(attemptId: string): Promise<SimulatedAttempt | null> {
  if (!simulatedAllowed() || !UUID.test(attemptId)) return null;
  const { rows } = await withSystem((db) =>
    db.query<{ id: string; reference: string; provider_checkout_id: string | null; amount_minor: string; currency: CurrencyCode; status: string; number: string | null; public_key: string; credentials: string | null }>(
      `select a.id, a.reference, a.provider_checkout_id, a.amount_minor::text as amount_minor, a.currency, a.status, i.number, c.public_key, c.credentials
       from customer_payment_attempts a join customer_payment_connections c on c.id = a.connection_id and c.org_id = a.org_id join customer_invoices i on i.id = a.invoice_id and i.org_id = a.org_id
       where a.id = $1 and c.provider = 'simulated' and c.status <> 'revoked'`, [attemptId],
    ),
  );
  const r = rows[0];
  const secret = r ? credentialVault.open(r.credentials)?.webhookSecret : null;
  if (!r || !r.provider_checkout_id || !secret || !REFERENCE_RE.test(r.reference)) return null;
  return { attemptId: r.id, reference: r.reference, checkoutId: r.provider_checkout_id, amountMinor: Number(r.amount_minor), currency: r.currency, status: r.status, invoiceNumber: r.number, publicKey: r.public_key, webhookSecret: secret };
}

export type SimulatedChoice = "pay" | "decline" | "cancel";

/** What the testing page hands to the webhook route: the same shape of call the route receives from a real provider. */
export type Deliver = (url: string, init: { headers: Record<string, string>; body: string }) => Promise<{ status: number }>;

/** The real route, called in process (the route's own code runs: its body limit, its headers, its signature check). */
export const deliverToRoute: Deliver = async (url, init) => {
  const { POST } = await import("@/app/api/webhooks/customer-payments/[provider]/[key]/route");
  const u = new URL(url);
  const [, , , , provider, key] = u.pathname.split("/");
  const res = await POST(new Request(url, { method: "POST", headers: init.headers, body: init.body }), { params: Promise.resolve({ provider, key }) });
  return { status: res.status };
};

/**
 * The customer's choice on the testing page. "pay" posts a signed payment event, "decline" a signed failure; "cancel" posts nothing (a customer who closes a provider's page
 * tells the provider nothing either). Returns the reference to send the customer back with.
 */
export async function completeSimulatedCheckout(attemptId: string, choice: SimulatedChoice, opts: { origin: string; deliver?: Deliver; now?: Date }): Promise<{ reference: string; cancelled: boolean; delivered: number | null }> {
  if (!simulatedAllowed()) throw new AppError("forbidden", "The testing checkout is not available in production.");
  const a = await loadSimulatedAttempt(attemptId);
  if (!a) throw new AppError("not_found", "That testing checkout was not found.");
  if (choice === "cancel") return { reference: a.reference, cancelled: true, delivered: null };
  if (a.status !== "created" && a.status !== "redirected") throw new AppError("conflict", "This checkout is no longer open, so it cannot be paid.");
  // A development server that restarted forgot its simulated platform; the checkout is made known again so the authenticated read-back finds it.
  simulatedPlatform.ensure({ id: a.checkoutId, reference: a.reference, amountMinor: a.amountMinor, currency: a.currency });
  const url = `${opts.origin.replace(/\/+$/, "")}/api/webhooks/customer-payments/simulated/${a.publicKey}`;
  let body: string;
  let signature: string;
  if (choice === "pay") {
    const paid = simulatedPlatform.pay(a.checkoutId, a.webhookSecret);
    body = paid.rawBody;
    signature = paid.signature;
  } else {
    body = simulatedBody({ kind: "payment.failed", type: "simulated.payment.failed", livemode: false, checkoutId: a.checkoutId, reference: a.reference, amountMinor: a.amountMinor, currency: a.currency, reason: "Declined in the testing checkout", occurredAt: (opts.now ?? new Date()).toISOString() });
    signature = signSimulatedBody(a.webhookSecret, body);
  }
  const res = await (opts.deliver ?? deliverToRoute)(url, { headers: { "content-type": "application/json", [SIGNATURE_HEADER]: signature }, body });
  return { reference: a.reference, cancelled: false, delivered: res.status };
}
