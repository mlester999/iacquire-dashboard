import "server-only";
import crypto from "node:crypto";
import { CURRENCY_CODES } from "@/lib/money";
import { emptyEvent, readFacts, storableFacts, type NormalizedEvent } from "@/lib/invoices/payment-events";
import type { ProviderCredentials } from "@/server/customer-payments/credentials";
import { ProviderCallError, type CanonicalCheckout, type CheckoutInput, type CheckoutResult, type ParsedWebhook, type PaymentProviderAdapter, type SignatureCheck } from "@/server/customer-payments/providers/types";

// A stand-in payment provider that lives inside this process. It moves no money and reaches nothing. It exists so the whole path (a checkout, a signed webhook, a
// payment, a refund, a dispute, a lost webhook, a failing provider) can be tested and clicked through without a PayMongo account, and it does not exist in
// production (src/server/customer-payments/providers/index.ts refuses it there).
//
// It signs what it delivers the way a provider does: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.<raw body>">` under the connection's own webhook secret, in the
// header `x-simulated-signature`. A test that wants a bad delivery changes the body, the secret or the time and sends it through the real webhook handler.

export const SIGNATURE_HEADER = "x-simulated-signature";
const TOLERANCE_SECONDS = 300;

export interface SimPayment {
  id: string;
  amountMinor: number;
  status: "paid" | "pending" | "failed";
}

export interface SimCheckout {
  id: string;
  reference: string;
  amountMinor: number;
  currency: string;
  description: string;
  status: "open" | "expired";
  payments: SimPayment[];
}

type Step = "verify" | "create" | "fetch";

interface World {
  seq: number;
  /** Tells this run of the platform from an earlier one, so a checkout made before a restart never shares an id with one made after it. */
  tag: string;
  checkouts: Map<string, SimCheckout>;
  failures: Array<{ step: Step; error: ProviderCallError }>;
  calls: Array<{ step: Step | "parse"; at: number }>;
}

const fresh = (): World => ({ seq: 0, tag: crypto.randomBytes(3).toString("hex"), checkouts: new Map(), failures: [], calls: [] });
// One platform per server process, kept on globalThis: a development server compiles each route's modules separately, and the checkout a customer's page started must be
// the one the testing checkout page and the webhook route read back. It is reset in place so every copy of this module keeps pointing at the same object.
const holder = globalThis as unknown as { __iaqSimulatedPaymentWorld?: World };
const world: World = (holder.__iaqSimulatedPaymentWorld ??= fresh());

function enter(step: Step) {
  world.calls.push({ step, at: Date.now() });
  const i = world.failures.findIndex((f) => f.step === step);
  if (i >= 0) throw world.failures.splice(i, 1)[0].error;
}

export const signSimulatedBody = (secret: string, rawBody: string, t: number = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex")}`;

/** The body of a simulated delivery: the facts themselves, as JSON. */
export function simulatedBody(event: Partial<NormalizedEvent> & Pick<NormalizedEvent, "kind">): string {
  const id = event.eventId ?? `sim_evt_${crypto.randomBytes(8).toString("hex")}`;
  const given = Object.fromEntries(Object.entries(event).filter(([, v]) => v !== undefined));
  return JSON.stringify(storableFacts({ ...emptyEvent(event.kind, { eventId: id, type: event.type ?? event.kind, livemode: event.livemode ?? false }), ...given, eventId: id }));
}

export const simulatedPlatform = {
  reset() {
    world.seq = 0;
    world.checkouts.clear();
    world.failures.length = 0;
    world.calls.length = 0;
  },
  checkout(id: string): SimCheckout | undefined {
    return world.checkouts.get(id);
  },
  checkouts(): SimCheckout[] {
    return [...world.checkouts.values()];
  },
  /** Makes the platform know a checkout it may have lost (a development server restarted since it was made). Does nothing when it already knows it. */
  ensure(co: { id: string; reference: string; amountMinor: number; currency: string }) {
    if (!world.checkouts.has(co.id)) world.checkouts.set(co.id, { id: co.id, reference: co.reference, amountMinor: co.amountMinor, currency: co.currency, description: "Invoice", status: "open", payments: [] });
  },
  /** The platform's own clock runs out on a checkout nobody paid. */
  expire(checkoutId: string) {
    const co = world.checkouts.get(checkoutId);
    if (co) co.status = "expired";
  },
  /** The next time the platform is asked to do this step, it refuses with this error (once). */
  failNext(step: Step, error: ProviderCallError) {
    world.failures.push({ step, error });
  },
  calls(step?: Step): number {
    return world.calls.filter((c) => !step || c.step === step).length;
  },
  /** What the platform would deliver when a customer pays a checkout: the body and its signature. Records the payment on the platform's side. */
  pay(checkoutId: string, secret: string, over: { amountMinor?: number; paymentId?: string; eventId?: string; livemode?: boolean; t?: number } = {}): { rawBody: string; signature: string; paymentId: string } {
    const co = world.checkouts.get(checkoutId);
    if (!co) throw new Error(`No simulated checkout ${checkoutId}`);
    // The tag is random per process, like the checkout's: a development server that restarts starts its counter again, and a bare counter would reuse the ids of payments
    // already recorded ("This payment was already recorded; nothing changed") so a test payment after a restart would count for nothing.
    const paymentId = over.paymentId ?? `sim_pay_${world.tag}${++world.seq}`;
    const amountMinor = over.amountMinor ?? co.amountMinor;
    co.payments.push({ id: paymentId, amountMinor, status: "paid" });
    const rawBody = simulatedBody({
      kind: "payment.succeeded", eventId: over.eventId, type: "simulated.payment.succeeded", livemode: over.livemode ?? false, checkoutId: co.id, reference: co.reference, paymentId, amountMinor, currency: co.currency,
      feeMinor: 0, method: "simulated", occurredAt: new Date().toISOString(),
    });
    return { rawBody, signature: signSimulatedBody(secret, rawBody, over.t), paymentId };
  },
};

function canonicalOf(co: SimCheckout): CanonicalCheckout {
  return {
    checkoutId: co.id, reference: co.reference, status: co.payments.some((p) => p.status === "paid") ? "paid" : co.status,
    payments: co.payments.map((p) => ({ id: p.id, status: p.status, amountMinor: p.amountMinor, currency: co.currency, feeMinor: 0, livemode: false })),
  };
}

export const simulatedProvider: PaymentProviderAdapter = {
  id: "simulated",
  contractVerified: false,
  supportedCurrencies: CURRENCY_CODES,

  modeOf: (c: ProviderCredentials) => (c.apiKey.startsWith("sim_") ? "test" : null),

  async verifyCredentials(c) {
    enter("verify");
    if (!c.apiKey.startsWith("sim_")) return { ok: false, reason: "rejected", message: "The simulated provider does not accept that key." };
    return { ok: true, accountLabel: "Simulated provider", webhookFound: null };
  },

  async createCheckout(_c: ProviderCredentials, input: CheckoutInput): Promise<CheckoutResult> {
    enter("create");
    const id = `simco_${world.tag}${++world.seq}`;
    world.checkouts.set(id, { id, reference: input.reference, amountMinor: input.amountMinor, currency: input.currency, description: input.description, status: "open", payments: [] });
    // A real https address that can never resolve: the checkout page for a simulated provider is the product's own testing page, never an outside site.
    return { checkoutId: id, checkoutUrl: `https://simulated-checkout.invalid/pay/${id}` };
  },

  async fetchCheckout(_c, checkoutId) {
    enter("fetch");
    const co = world.checkouts.get(checkoutId);
    return co ? canonicalOf(co) : null;
  },

  verifyWebhook({ rawBody, headers, secret, now }): SignatureCheck {
    const header = headers.get(SIGNATURE_HEADER);
    const m = header ? /^t=(\d{9,12}),v1=([0-9a-f]{64})$/.exec(header) : null;
    if (!m) return { ok: false, reason: header ? "malformed" : "missing" };
    const expected = crypto.createHmac("sha256", secret).update(`${m[1]}.${rawBody}`).digest();
    const given = Buffer.from(m[2], "hex");
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return { ok: false, reason: "mismatch" };
    if (Math.abs(Math.floor(now / 1000) - Number(m[1])) > TOLERANCE_SECONDS) return { ok: false, reason: "stale" };
    return { ok: true, livemode: null };
  },

  parseEvent(rawBody): ParsedWebhook | null {
    try {
      const event = readFacts(JSON.parse(rawBody));
      return event ? { event } : null;
    } catch {
      return null;
    }
  },
};
