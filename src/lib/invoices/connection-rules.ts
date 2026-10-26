import { CURRENCY_CODES, type CurrencyCode } from "@/lib/money";

// The business's own payment account: what a connection may be, what the owner agrees to when connecting one, and when a checkout may be started through it.
// Pure: the server enforces these rules and the interface reads them.

export const PAYMENT_PROVIDERS = ["paymongo", "paypal", "simulated"] as const;
export type PaymentProviderId = (typeof PAYMENT_PROVIDERS)[number];
export const isPaymentProvider = (v: unknown): v is PaymentProviderId => typeof v === "string" && (PAYMENT_PROVIDERS as readonly string[]).includes(v);

export const PROVIDER_LABELS: Record<PaymentProviderId, string> = { paymongo: "PayMongo", paypal: "PayPal", simulated: "Simulated provider (testing only)" };

/**
 * What exists, honestly. "built" means the code is written and tested against a replaced network layer; nothing has run against the provider itself, and the contract
 * (endpoint paths, event names) must be checked with the provider's test keys before it is trusted.
 */
export const PROVIDER_STATE: Record<PaymentProviderId, { state: "built_unverified" | "not_built" | "testing_only"; note: string }> = {
  paymongo: { state: "built_unverified", note: "Built from PayMongo's documentation and tested against recorded fixtures. It has not run against a PayMongo account yet." },
  paypal: { state: "built_unverified", note: "Built from PayPal's documentation and tested against hand-written examples. It has not run against a PayPal app yet." },
  simulated: { state: "testing_only", note: "A stand-in provider that moves no money. It does not exist in production." },
};

/**
 * The currencies an invoice can be collected in through each provider. PayMongo settles Philippine pesos only. PayPal is offered all eight, but a PayPal account may not
 * be set up for each of them (unverified); a checkout it cannot take is refused by PayPal and reported to the customer as "not available".
 */
export const PROVIDER_CURRENCIES: Record<PaymentProviderId, readonly CurrencyCode[]> = { paymongo: ["PHP"], paypal: CURRENCY_CODES, simulated: CURRENCY_CODES };

export type ConnectionStatus = "pending_verification" | "connected" | "needs_attention" | "disabled" | "revoked";
export type ConnectionMode = "test" | "live";

export const CONNECTION_STATUS_LABELS: Record<ConnectionStatus, string> = {
  pending_verification: "Almost there",
  connected: "Connected",
  needs_attention: "Needs attention",
  disabled: "Paused",
  revoked: "Disconnected",
};

/** What each status means, never softer than the truth. */
export const CONNECTION_STATUS_EXPLAIN: Record<ConnectionStatus, string> = {
  pending_verification: "The key was accepted but the webhook signing secret has not been saved, so payments cannot be confirmed yet.",
  connected: "The key was accepted by the provider and the webhook signing secret is saved. This does not prove the provider can reach this product: run a test payment.",
  needs_attention: "The provider no longer accepts the saved key, or a check could not complete. New payments cannot be started until it is fixed.",
  disabled: "Paused by the owner. No new online payments start; payments already in progress are still recorded when the provider confirms them.",
  revoked: "Disconnected. The saved keys were deleted.",
};

/** The webhook address of a connection names it (not a secret: a request is trusted by its signature, checked against this connection's own secret). */
export const PUBLIC_KEY_RE = /^cpk_[a-z0-9]{20}$/;
/** What the provider echoes back to tie a payment to its checkout. Unguessable, ours alone. */
export const REFERENCE_RE = /^CP-[A-Za-z0-9]{20,40}$/;

// ---------------------------------------------------------------------------
// The owner's authorization
// ---------------------------------------------------------------------------

/**
 * The wording an owner accepts when connecting an account. PROPOSED, not approved: counsel must confirm it before a real client connects a real account. The version is
 * stored on the connection with who accepted it and when, so an older text stays readable after it is replaced here.
 */
export const AUTHORIZATION_TEXTS: Record<string, string> = {
  "draft-2026-10-23":
    "I am the owner of this business, or I am authorized by it to connect its payment account. I authorize iAcquire to use the account I am connecting only to start checkouts for invoices my business issues and to read back the payments made through them. I understand that my customers' payments go straight to my own payment provider account, that iAcquire does not hold or move my money, and that I remain responsible for my provider's terms, for refunds and disputes, and for any tax. I can disconnect the account at any time.",
};
export const CURRENT_AUTHORIZATION_VERSION = "draft-2026-10-23";
export const authorizationText = (version: string) => AUTHORIZATION_TEXTS[version] ?? null;

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/** PayMongo's own prefix says whether a secret key is for test or live mode. */
export function paymongoModeOf(secretKey: string): ConnectionMode | null {
  if (/^sk_test_[A-Za-z0-9]{8,}$/.test(secretKey)) return "test";
  if (/^sk_live_[A-Za-z0-9]{8,}$/.test(secretKey)) return "live";
  return null;
}

/** What the owner is told when the pasted key is not a secret key. A public key (pk_) is refused by name: it cannot do what is needed, and pasting it is a mistake worth saying. */
export function paymongoKeyProblem(secretKey: string): string | null {
  const k = secretKey.trim();
  if (!k) return "Paste your PayMongo secret key.";
  if (/^pk_(test|live)_/.test(k)) return "That is a PayMongo public key. Paste the secret key instead (it starts with sk_test_ or sk_live_).";
  if (!paymongoModeOf(k)) return "That does not look like a PayMongo secret key. It starts with sk_test_ (test mode) or sk_live_ (live mode).";
  return null;
}

const WEBHOOK_SECRET_RE = /^[A-Za-z0-9_.:=+/-]{8,200}$/;
export const webhookSecretProblem = (secret: string): string | null => (WEBHOOK_SECRET_RE.test(secret.trim()) ? null : "Paste the webhook signing secret exactly as PayMongo shows it.");

// PayPal. A PayPal app has a client ID and a secret, belongs to a sandbox or to the live account (the owner says which: nothing in the keys does), and the webhook the
// owner creates for this connection's address has an id that deliveries are checked against.
export const PAYPAL_ENVIRONMENTS = ["sandbox", "live"] as const;
export type PaypalEnvironment = (typeof PAYPAL_ENVIRONMENTS)[number];

export const paypalModeOf = (environment: string | null | undefined): ConnectionMode | null => (environment === "live" ? "live" : environment === "sandbox" ? "test" : null);

const PAYPAL_CLIENT_ID_RE = /^[A-Za-z0-9_-]{20,120}$/;
const PAYPAL_SECRET_RE = /^[A-Za-z0-9_-]{20,200}$/;
const PAYPAL_WEBHOOK_ID_RE = /^[A-Za-z0-9]{10,40}$/;

export function paypalCredentialsProblem(input: { clientId: string; clientSecret: string; environment: string | null | undefined }): string | null {
  const id = input.clientId.trim();
  const secret = input.clientSecret.trim();
  if (!id) return "Paste your PayPal client ID.";
  if (!secret) return "Paste your PayPal client secret.";
  if (!PAYPAL_CLIENT_ID_RE.test(id)) return "That does not look like a PayPal client ID. Copy it from your PayPal app's page in the developer dashboard.";
  if (!PAYPAL_SECRET_RE.test(secret)) return "That does not look like a PayPal client secret. Copy it from your PayPal app's page in the developer dashboard.";
  if (id === secret) return "The client ID and the secret are different values. Paste the secret in the second box.";
  if (paypalModeOf(input.environment) === null) return "Say whether this is a sandbox (testing) app or a live one.";
  return null;
}

export const paypalWebhookIdProblem = (id: string): string | null => (PAYPAL_WEBHOOK_ID_RE.test(id.trim()) ? null : "Paste the webhook ID exactly as PayPal shows it, next to the webhook you created for the address above.");

// ---------------------------------------------------------------------------
// When a checkout may be started
// ---------------------------------------------------------------------------

export interface ConnectionFacts {
  provider: PaymentProviderId;
  mode: ConnectionMode;
  status: ConnectionStatus;
  supportedCurrencies: readonly string[];
  authorizedAt: Date | string | null;
  liveConfirmedAt: Date | string | null;
}

export interface Switches {
  /** CUSTOMER_PAYMENTS_WRITES_ENABLED: any call to a real provider. */
  writesEnabled: boolean;
  /** CUSTOMER_PAYMENTS_LIVE_ENABLED: real money. */
  liveEnabled: boolean;
  /** False in production: the simulated provider does not exist there. */
  simulatedAllowed: boolean;
}

export type CheckoutAudience = "public" | "member";

export type CheckoutBlockCode =
  | "not_connected" | "paused" | "not_ready" | "needs_attention" | "not_authorized" | "currency" | "simulated_unavailable" | "provider_calls_off" | "live_off" | "live_not_confirmed" | "test_mode_public";

export interface CheckoutBlock {
  code: CheckoutBlockCode;
  /** For the team looking at the connection. A customer is shown a plainer line chosen by the page. */
  message: string;
}

/**
 * Why a checkout cannot be started through this connection for an invoice in this currency, or null when it can. A real provider's TEST mode moves no money, so a
 * customer is never sent there (only a signed-in member runs a test payment); the simulated provider, which exists only outside production, is open to both so the
 * whole path can be clicked through.
 */
export function checkoutBlock(c: ConnectionFacts | null, currency: string, sw: Switches, audience: CheckoutAudience): CheckoutBlock | null {
  if (!c || c.status === "revoked") return { code: "not_connected", message: "No payment account is connected." };
  if (c.status === "disabled") return { code: "paused", message: "Online payments are paused." };
  if (c.status === "pending_verification") return { code: "not_ready", message: "The payment account is not fully set up: the webhook signing secret has not been saved." };
  if (c.status === "needs_attention") return { code: "needs_attention", message: "The payment account needs attention before new payments can start." };
  if (!c.authorizedAt) return { code: "not_authorized", message: "The owner has not recorded their authorization for this account." };
  if (!c.supportedCurrencies.includes(currency)) return { code: "currency", message: `This payment account cannot collect ${currency}.` };
  if (c.provider === "simulated") return sw.simulatedAllowed ? null : { code: "simulated_unavailable", message: "The simulated provider is not available in production." };
  if (!sw.writesEnabled) return { code: "provider_calls_off", message: "Calls to payment providers are switched off in this environment." };
  if (c.mode === "live") {
    if (!sw.liveEnabled) return { code: "live_off", message: "Live payments are switched off for the whole service." };
    if (!c.liveConfirmedAt) return { code: "live_not_confirmed", message: "The owner has not confirmed going live yet." };
    return null;
  }
  if (audience === "public") return { code: "test_mode_public", message: "This account is in test mode, so customers are not sent to it." };
  return null;
}

export interface LiveConfirmFacts {
  connection: ConnectionFacts;
  /** A payment the provider confirmed in test mode exists for this workspace and provider. */
  hasConfirmedTestPayment: boolean;
}

/** Why the owner cannot confirm going live yet, or null. */
export function liveConfirmBlock(f: LiveConfirmFacts, sw: Switches): string | null {
  const c = f.connection;
  if (c.provider === "simulated") return "The simulated provider has no live mode.";
  if (c.mode !== "live") return "This connection uses test keys. Replace them with your live keys first.";
  if (c.status !== "connected") return c.status === "pending_verification" ? "Save the webhook signing secret first." : "The payment account must be connected before it can go live.";
  if (!c.authorizedAt) return "Record your authorization first.";
  if (!sw.writesEnabled) return "Calls to payment providers are switched off in this environment.";
  if (!sw.liveEnabled) return "Live payments are switched off for the whole service.";
  if (!f.hasConfirmedTestPayment) return "Complete a test payment in test mode first. Nothing goes live until one has been confirmed by the provider.";
  return null;
}
