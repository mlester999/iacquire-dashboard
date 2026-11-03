// What a payment provider's setup can honestly be, in the order the steps happen, and the plain instructions for each provider. Pure: no database, no environment, no secrets.
// The server fills it in with facts it checked itself (src/server/billing/provider-health.ts); the screens and the buyer's checkout all read the same answer.
//
// The ladder, first unmet step wins:
//   1. Not connected             nothing of this provider is set.
//   2. Configuration incomplete  something it needs is missing (a key, the webhook secret, the exchange rate, the payment methods).
//   3. Ready for testing         everything is set, but the connection has not been checked with exactly this configuration.
//   4. Test verified             a read-only, authorized call to the provider succeeded with exactly this configuration, in test mode.
//   5. Live approval required    the same, with LIVE credentials, but the payment and tax review has not been confirmed.
//   6. Ready for live payments   live credentials, verified, reviewed and approved.
// A change of keys, mode, payment methods or webhook secret changes the configuration's fingerprint, so 4 to 6 fall back to 3 until the connection is checked again.

export type ProviderId = "paymongo" | "paypal";
export const PROVIDER_IDS: readonly ProviderId[] = ["paymongo", "paypal"];

export type ReadinessState = "not_connected" | "incomplete" | "ready_for_testing" | "test_verified" | "live_approval_required" | "ready_for_live";
export type ReadinessTone = "neutral" | "primary" | "warning" | "success" | "danger";

export const READINESS_LABEL: Record<ReadinessState, string> = {
  not_connected: "Not connected",
  incomplete: "Configuration incomplete",
  ready_for_testing: "Ready for testing",
  test_verified: "Test verified",
  live_approval_required: "Live approval required",
  ready_for_live: "Ready for live payments",
};

export const READINESS_TONE: Record<ReadinessState, ReadinessTone> = {
  not_connected: "neutral",
  incomplete: "warning",
  ready_for_testing: "primary",
  test_verified: "success",
  live_approval_required: "warning",
  ready_for_live: "success",
};

export type Mode = "test" | "live";
export const MODE_LABEL: Record<Mode, string> = { test: "Test mode", live: "Live mode" };
export const MODE_NOTE: Record<Mode, string> = {
  test: "Test mode: no real money moves. Payments are rehearsals made with the provider's test cards or sandbox accounts.",
  live: "Live mode: real money. Nothing can be charged until the payment and tax review is confirmed.",
};

export interface ReadinessInput {
  /** Any credential of this provider is set (a key, a webhook secret). */
  anySet: boolean;
  /** What is still missing, in words that name the setting. Empty when everything required is set. */
  missing: string[];
  mode: Mode | null;
  /** A connection check passed with exactly the configuration in use now. */
  verifiedForCurrentConfig: boolean;
  /** The payment and tax review was confirmed by a Super Admin. */
  liveReviewed: boolean;
}

export interface Readiness {
  state: ReadinessState;
  label: string;
  tone: ReadinessTone;
  /** The one next thing to do, in words. */
  next: string;
}

export function deriveReadiness(i: ReadinessInput): Readiness {
  const make = (state: ReadinessState, next: string): Readiness => ({ state, label: READINESS_LABEL[state], tone: READINESS_TONE[state], next });
  if (!i.anySet) return make("not_connected", "Add the provider's credentials in Vercel (the checklist below names each one), then redeploy.");
  if (i.missing.length) return make("incomplete", `Still missing: ${i.missing.join("; ")}.`);
  if (!i.verifiedForCurrentConfig) {
    return make(
      "ready_for_testing",
      i.mode === "live"
        ? "These are LIVE credentials. Run \"Check connection\" (a read-only call, nothing is charged). Real money still cannot move until the live review is confirmed."
        : "Run \"Check connection\": a read-only call that proves the provider accepts these credentials. Nothing is charged.",
    );
  }
  if (i.mode !== "live") return make("test_verified", "Test payments can be taken. Rehearse a whole purchase with the provider's test cards before going live.");
  if (!i.liveReviewed) return make("live_approval_required", "Live credentials are connected and verified. Real money stays blocked until the payment and tax review is confirmed (Billing, Rates & payments).");
  return make("ready_for_live", "Live payments are open to buyers whenever online checkout for purchases is switched on.");
}

// ---------------------------------------------------------------------------
// What the Super Admin is told to set, and where
// ---------------------------------------------------------------------------

export interface EnvVarGuide {
  name: string;
  /** What it is, in a few words. */
  label: string;
  required: boolean;
  /** Never shown, never returned to a browser: the page can say only whether it is set. */
  secret: boolean;
  where: string;
  note: string;
}

export interface ProviderGuide {
  id: ProviderId;
  label: string;
  /** The provider's own page to read, not something this site calls. */
  docsUrl: string;
  envVars: EnvVarGuide[];
  /** The path on this site the provider must call (the full address is built from the site's address on the server). */
  webhookPath: string;
  /** Events to subscribe the webhook to; `required` ones are what confirm a payment. */
  events: Array<{ name: string; required: boolean; why: string; /** Only needed for the automatic monthly plan. */ monthly?: boolean }>;
  webhookWhere: string;
  testHow: string;
}

export const VERCEL_STEPS = [
  "Open the project in Vercel, then Settings, then Environment Variables.",
  "Add each variable below by name. Choose the Production environment (and Preview as well if you rehearse on preview deployments). Mark secrets as Sensitive.",
  "Redeploy: a new value reaches the site only on a new deployment. Then come back here and run \"Check connection\".",
  "Never paste a key into this page, a chat, an email or a ticket. This page cannot store one, by design: it only reads whether each variable is set.",
] as const;

export const PROVIDER_GUIDE: Record<ProviderId, ProviderGuide> = {
  paymongo: {
    id: "paymongo",
    label: "PayMongo",
    docsUrl: "https://docs.paymongo.com/docs/payment-channels-hosted-checkout-quick-start",
    envVars: [
      { name: "PAYMONGO_SECRET_KEY", label: "Secret key", required: true, secret: true, where: "PayMongo Dashboard, Developers, API Keys", note: "sk_test_… is test mode (no real money). sk_live_… is live mode. Start with the test key." },
      { name: "PAYMONGO_WEBHOOK_SECRET", label: "Webhook signing secret", required: true, secret: true, where: "PayMongo Dashboard, Developers, Webhooks: add the endpoint below, then copy that endpoint's secret key (it starts with whsk_)", note: "Without it a payment can never be confirmed, so checkout stays closed." },
      { name: "PAYMONGO_PAYMENT_METHODS", label: "Payment methods", required: false, secret: false, where: "The methods your PayMongo account has switched on", note: "Comma separated, for example card,gcash,paymaya. Defaults to card. A method the account has not enabled makes PayMongo refuse the checkout." },
    ],
    webhookPath: "/api/webhooks/paymongo",
    events: [
      { name: "checkout_session.payment.paid", required: true, why: "Confirms a payment. Only this signed notice can make a purchase paid." },
      { name: "payment.failed", required: false, why: "Records a failed attempt so the team can see it." },
      { name: "payment.refunded", required: false, why: "Reports a refund. It is only reported to a person; nothing is undone automatically." },
      { name: "payment.refund.updated", required: false, why: "Reports a change to a refund." },
    ],
    webhookWhere: "PayMongo Dashboard, Developers, Webhooks, Add endpoint. The address must be a public https address with a domain name.",
    testHow: "In test mode, make a test purchase with PayMongo's test card, or use PayMongo's \"Send a test event\". The purchase becomes paid only when the signed notice arrives; the last notice received is shown here.",
  },
  paypal: {
    id: "paypal",
    label: "PayPal",
    docsUrl: "https://developer.paypal.com/api/rest/webhooks/",
    envVars: [
      { name: "PAYPAL_CLIENT_ID", label: "REST app client ID", required: true, secret: false, where: "developer.paypal.com, Apps & Credentials (the Sandbox / Live switch decides the mode)", note: "Create a REST app. Use a sandbox app first." },
      { name: "PAYPAL_CLIENT_SECRET", label: "REST app secret", required: true, secret: true, where: "Same page, under the app's client ID", note: "Keep it in Vercel only." },
      { name: "PAYPAL_WEBHOOK_ID", label: "Webhook ID", required: true, secret: false, where: "Same app, Webhooks, Add webhook: the ID PayPal shows once the endpoint below is saved", note: "A delivery is trusted only after PayPal itself confirms its signature with this ID." },
      { name: "PAYPAL_ENVIRONMENT", label: "Mode", required: false, secret: false, where: "sandbox or live", note: "Defaults to sandbox. It must match the app: sandbox credentials only work in sandbox." },
      { name: "PAYPAL_MAINTENANCE_PLAN_ID", label: "Monthly plan ID", required: false, secret: false, where: "PayPal, Subscriptions, Plans", note: "Only needed for the automatic monthly maintenance plan, not for the setup payment." },
    ],
    webhookPath: "/api/webhooks/paypal",
    events: [
      { name: "PAYMENT.CAPTURE.COMPLETED", required: true, why: "Confirms a payment. Only this verified notice can make a purchase paid." },
      { name: "PAYMENT.CAPTURE.DENIED", required: false, why: "Records a failed attempt." },
      { name: "PAYMENT.CAPTURE.REFUNDED", required: false, why: "Reports a refund to a person." },
      { name: "PAYMENT.CAPTURE.REVERSED", required: false, why: "Reports money taken back, which puts the purchase on hold." },
      { name: "CUSTOMER.DISPUTE.CREATED", required: false, why: "Reports a dispute, which puts the purchase on hold." },
      // The automatic monthly maintenance plan. Subscribe to these too if PAYPAL_MAINTENANCE_PLAN_ID is set; without them the plan never hears about an approval, a charge or a failure.
      { name: "BILLING.SUBSCRIPTION.CREATED", required: false, monthly: true, why: "A monthly subscription was opened and is waiting for the customer's approval." },
      { name: "BILLING.SUBSCRIPTION.ACTIVATED", required: false, monthly: true, why: "The customer's approval took effect. It grants nothing by itself: only a completed charge extends the plan." },
      { name: "BILLING.SUBSCRIPTION.RE-ACTIVATED", required: false, monthly: true, why: "A paused subscription was switched back on." },
      { name: "BILLING.SUBSCRIPTION.UPDATED", required: false, monthly: true, why: "PayPal changed the subscription." },
      { name: "BILLING.SUBSCRIPTION.SUSPENDED", required: false, monthly: true, why: "PayPal paused the subscription, usually after failed payments." },
      { name: "BILLING.SUBSCRIPTION.CANCELLED", required: false, monthly: true, why: "The subscription was cancelled." },
      { name: "BILLING.SUBSCRIPTION.EXPIRED", required: false, monthly: true, why: "The subscription ended." },
      { name: "BILLING.SUBSCRIPTION.PAYMENT.FAILED", required: false, monthly: true, why: "A monthly charge failed: the plan's grace period starts when the paid-through day has passed." },
      { name: "PAYMENT.SALE.COMPLETED", required: false, monthly: true, why: "A monthly charge was collected. Only this verified notice extends the plan by a month." },
      { name: "PAYMENT.SALE.REFUNDED", required: false, monthly: true, why: "A monthly charge was refunded: reported to a person, and the plan is held." },
      { name: "PAYMENT.SALE.REVERSED", required: false, monthly: true, why: "A monthly charge was taken back: reported to a person, and the plan is held." },
    ],
    webhookWhere: "developer.paypal.com, your app, Webhooks, Add webhook. The address must be a public https address (PayPal delivers to port 443). Subscribe to the one-time events, and to the monthly plan's too if you use the monthly plan.",
    testHow: "In sandbox, buy with a sandbox buyer account: a real Sandbox purchase is the test. Do not use PayPal's webhook simulator to prove a payment: PayPal says its mock events cannot be verified the way this site verifies them (by asking PayPal), so they are refused, which is correct. The purchase becomes paid only when the verified notice arrives; the last notice received is shown here.",
  },
};

/** The exchange rate and the live review are settings in the billing area, not environment variables. */
export const BILLING_SETTING_NOTES = {
  rate: "PayMongo charges Philippine pesos, so the US dollar price is converted at a rate you set under Billing, Rates & payments (\"PHP per USD\" and where it came from). The rate and its date are stored with every checkout. PayPal charges US dollars as they are and needs no rate.",
  review: "Real-money checkout stays off until a Super Admin confirms that the payment provider and the legal and tax treatment have been reviewed (Billing, Rates & payments, \"Live-payments review confirmed\"). iAcquire does not do this for you, and nothing here switches it on.",
} as const;

/** True when an address could be reached by a payment provider: https, a real host (not this machine, not a placeholder). */
export function isPublicHttpsUrl(value: string): boolean {
  try {
    const u = new URL(value);
    if (u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".test") || host.endsWith(".invalid") || host.endsWith(".example")) return false;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) return false;
    return true;
  } catch {
    return false;
  }
}
