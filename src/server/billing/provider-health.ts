import "server-only";
import { env } from "@/server/env";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { appUrl } from "@/server/email";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import type { SessionUser } from "@/server/auth/service";
import { checkPaymongoConnection, paymongoStatus, type FetchLike } from "@/server/billing/paymongo";
import { paypalAppCredentials, paypalStatus } from "@/server/billing/providers/paypal";
import { providerFor } from "@/server/customer-payments/providers";
import { checksAvailable, configFingerprint, latestCheck, recordCheck, type CheckOutcome } from "@/server/billing/provider-checks";
import { PROVIDER_LABEL, providerReadiness, type CheckoutProvider } from "@/server/purchase-intents/availability";
import {
  deriveReadiness, isPublicHttpsUrl, PROVIDER_GUIDE, PROVIDER_IDS, type EnvVarGuide, type Mode, type ProviderId, type Readiness,
} from "@/lib/payment-providers/readiness";

// One answer to "can this payment provider take a payment?", read from the server's own facts and used by every screen and by the buyer's checkout:
// Billing (Payment providers), Purchase intents (online checkout) and the public purchase page all ask here, so they cannot disagree. Nothing in the answer is a secret: a setting
// is "set" or "missing", never its value, and the answer is safe to hand to a browser. It claims only what the server verified: a configuration is "verified" only when a real,
// read-only, authorized call to the provider succeeded with exactly the configuration in use now (provider-checks.ts).

export const CHECK_OUTCOME_TEXT: Record<CheckOutcome, string> = {
  verified: "The provider accepted the credentials.",
  webhook_not_registered: "The provider accepted the credentials, but it lists no enabled webhook for this site's address (or one that lacks a required event), so a payment could not be confirmed.",
  credentials_rejected: "The provider did not accept these credentials. Check that they are the right key for the right mode, and still active.",
  unreachable: "The provider could not be reached, or was busy. Nothing was changed. Try again in a few minutes.",
  unexpected_response: "The provider answered in a way this site could not read. That is reported as a failure, never as a success.",
  not_configured: "Nothing to check yet: the credentials are not set.",
};

export interface ProviderCheckView {
  at: string;
  ok: boolean;
  outcome: CheckOutcome;
  text: string;
  /** The configuration changed after this check, so it no longer counts. */
  stale: boolean;
  mode: Mode;
  webhook: "registered" | "not_registered" | "unknown" | null;
  eventsMissing: string[];
  /** The provider's own sentence, when it gave a safe one (never a key, a body or an address). */
  message: string | null;
}

export interface EnvVarStatus extends EnvVarGuide {
  set: boolean;
  /** Only for settings that are not secret and have a few fixed values (a mode, a list of methods). Never a key. */
  shown: string | null;
}

export interface ProviderHealth {
  provider: ProviderId;
  label: string;
  readiness: Readiness;
  mode: Mode | null;
  envVars: EnvVarStatus[];
  /** What is missing, by name, in words. */
  missing: string[];
  webhook: {
    url: string;
    /** The address is https on a real domain, so the provider can reach it. */
    reachableByProvider: boolean;
    events: Array<{ name: string; required: boolean; why: string }>;
    where: string;
    testHow: string;
    /** The newest notice this site received from the provider (a real signal that the webhook reaches here), and how many were refused in the last 7 days. */
    lastNotice: { at: string; type: string; outcome: string } | null;
    refusedLast7Days: number;
  };
  check: ProviderCheckView | null;
  /** The exchange rate PayMongo needs (null for PayPal, which charges US dollars as they are). */
  exchangeRate: { set: boolean; usdPhpRate: number | null; source: string | null; updatedAt: string | null } | null;
  /** Whether a buyer could be sent to this provider's checkout right now if the switch were on: the one gate the checkout itself uses. */
  available: boolean;
  /** Why not, in words for the team. */
  blockedReason: string | null;
  docsUrl: string;
}

export type CheckoutState = "off" | "blocked" | "open_test" | "open_live";

export interface PaymentHealth {
  providers: ProviderHealth[];
  checkout: {
    /** The Super Admin's own switch. */
    switchOn: boolean;
    state: CheckoutState;
    /** One honest sentence: "On" never means "working". */
    headline: string;
    anyProviderAvailable: boolean;
  };
  liveReviewConfirmedAt: string | null;
  site: { url: string; publicHttps: boolean };
}

const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

function envVarStatus(provider: ProviderId): EnvVarStatus[] {
  const e = env();
  const pm = paymongoStatus();
  return PROVIDER_GUIDE[provider].envVars.map((g): EnvVarStatus => {
    const set = ((): boolean => {
      switch (g.name) {
        case "PAYMONGO_SECRET_KEY": return Boolean(e.PAYMONGO_SECRET_KEY);
        case "PAYMONGO_WEBHOOK_SECRET": return Boolean(e.PAYMONGO_WEBHOOK_SECRET);
        case "PAYMONGO_PAYMENT_METHODS": return pm.paymentMethods.length > 0;
        case "PAYPAL_CLIENT_ID": return Boolean(e.PAYPAL_CLIENT_ID);
        case "PAYPAL_CLIENT_SECRET": return Boolean(e.PAYPAL_CLIENT_SECRET);
        case "PAYPAL_WEBHOOK_ID": return Boolean(e.PAYPAL_WEBHOOK_ID);
        case "PAYPAL_ENVIRONMENT": return true; // it has a default (sandbox)
        case "PAYPAL_MAINTENANCE_PLAN_ID": return Boolean(e.PAYPAL_MAINTENANCE_PLAN_ID);
        default: return false;
      }
    })();
    const shown = g.name === "PAYMONGO_PAYMENT_METHODS" ? pm.paymentMethods.join(", ") || null : g.name === "PAYPAL_ENVIRONMENT" ? e.PAYPAL_ENVIRONMENT : null;
    return { ...g, set, shown };
  });
}

function configFacts(provider: ProviderId, rateOk: boolean): { anySet: boolean; missing: string[]; mode: Mode | null } {
  const e = env();
  if (provider === "paymongo") {
    const pm = paymongoStatus();
    const missing: string[] = [];
    if (!e.PAYMONGO_SECRET_KEY) missing.push("PAYMONGO_SECRET_KEY");
    if (!e.PAYMONGO_WEBHOOK_SECRET) missing.push("PAYMONGO_WEBHOOK_SECRET");
    if (!pm.paymentMethods.length) missing.push("PAYMONGO_PAYMENT_METHODS (it lists no methods)");
    if (!rateOk) missing.push("the USD to PHP exchange rate (Billing, Rates & payments)");
    return { anySet: Boolean(e.PAYMONGO_SECRET_KEY || e.PAYMONGO_WEBHOOK_SECRET), missing, mode: pm.livemode === null ? null : pm.livemode ? "live" : "test" };
  }
  const pp = paypalStatus();
  const missing: string[] = [];
  if (!e.PAYPAL_CLIENT_ID) missing.push("PAYPAL_CLIENT_ID");
  if (!e.PAYPAL_CLIENT_SECRET) missing.push("PAYPAL_CLIENT_SECRET");
  if (!e.PAYPAL_WEBHOOK_ID) missing.push("PAYPAL_WEBHOOK_ID");
  return { anySet: Boolean(e.PAYPAL_CLIENT_ID || e.PAYPAL_CLIENT_SECRET || e.PAYPAL_WEBHOOK_ID), missing, mode: pp.livemode === null ? (e.PAYPAL_CLIENT_ID || e.PAYPAL_CLIENT_SECRET ? (e.PAYPAL_ENVIRONMENT === "live" ? "live" : "test") : null) : pp.livemode ? "live" : "test" };
}

async function noticeSignal(db: Queryable, provider: ProviderId): Promise<{ last: ProviderHealth["webhook"]["lastNotice"]; refused: number }> {
  const last = (await db.query<{ event_type: string; outcome: string; received_at: Date }>(
    "select event_type, outcome, received_at from payment_webhook_events where provider = $1 order by received_at desc limit 1", [provider],
  )).rows[0];
  const refused = (await db.query<{ n: number }>(
    "select count(*)::int as n from payment_webhook_events where provider = $1 and outcome in ('rejected', 'error') and received_at > now() - interval '7 days'", [provider],
  )).rows[0]?.n ?? 0;
  return { last: last ? { at: new Date(last.received_at).toISOString(), type: last.event_type, outcome: last.outcome } : null, refused };
}

async function healthOf(db: Queryable, provider: ProviderId): Promise<ProviderHealth> {
  const guide = PROVIDER_GUIDE[provider];
  const gate = await providerReadiness(db, provider as CheckoutProvider);
  const rateOk = Boolean(gate.settings.usdPhpRate && gate.settings.usdPhpRate > 0);
  const facts = configFacts(provider, provider === "paypal" ? true : rateOk);
  const stored = await latestCheck(db, provider);
  const fingerprint = configFingerprint(provider);
  const verified = stored !== null && stored.ok && stored.fingerprint === fingerprint;
  const readiness = deriveReadiness({ anySet: facts.anySet, missing: facts.missing, mode: facts.mode, verifiedForCurrentConfig: verified, liveReviewed: Boolean(gate.settings.liveReviewedAt) });
  const notice = await noticeSignal(db, provider);
  const url = appUrl(guide.webhookPath);
  const storedFacts = stored?.facts ?? {};
  const check: ProviderCheckView | null = stored
    ? {
        at: stored.checkedAt.toISOString(), ok: stored.ok, outcome: stored.outcome, text: CHECK_OUTCOME_TEXT[stored.outcome], stale: stored.fingerprint !== fingerprint, mode: stored.livemode ? "live" : "test",
        webhook: storedFacts.webhook === "registered" || storedFacts.webhook === "not_registered" || storedFacts.webhook === "unknown" ? storedFacts.webhook : null,
        eventsMissing: Array.isArray(storedFacts.eventsMissing) ? storedFacts.eventsMissing.filter((x): x is string => typeof x === "string").slice(0, 10) : [],
        message: typeof storedFacts.message === "string" ? storedFacts.message : null,
      }
    : null;
  return {
    provider, label: PROVIDER_LABEL[provider as CheckoutProvider], readiness, mode: facts.mode,
    envVars: envVarStatus(provider), missing: facts.missing,
    webhook: { url, reachableByProvider: isPublicHttpsUrl(url), events: guide.events, where: guide.webhookWhere, testHow: guide.testHow, lastNotice: notice.last, refusedLast7Days: notice.refused },
    check,
    exchangeRate: provider === "paymongo" ? { set: rateOk, usdPhpRate: gate.settings.usdPhpRate, source: gate.settings.fxSource, updatedAt: iso(gate.settings.fxUpdatedAt) } : null,
    available: gate.available, blockedReason: gate.available ? null : gate.reason, docsUrl: guide.docsUrl,
  };
}

/** The whole picture, for the team's screens. Reads the database and the environment; calls no provider. */
export async function getPaymentHealth(db: Queryable): Promise<PaymentHealth> {
  const providers = [];
  for (const id of PROVIDER_IDS) providers.push(await healthOf(db, id));
  const settings = (await providerReadiness(db, "paymongo")).settings;
  const open = providers.filter((p) => p.available);
  const state: CheckoutState = !settings.enabled ? "off" : open.length === 0 ? "blocked" : open.some((p) => p.mode === "live") ? "open_live" : "open_test";
  const headline = state === "off"
    ? "Online checkout is off. Buyers are told iAcquire will verify their payment another way."
    : state === "blocked"
      ? "The switch is on, but no payment provider is ready, so buyers are NOT offered online payment. Finish a provider's setup below."
      : state === "open_live"
        ? "Online checkout is open for real money."
        : "Online checkout is open in test mode: no real money moves.";
  const url = appUrl("/");
  return { providers, checkout: { switchOn: settings.enabled, state, headline, anyProviderAvailable: open.length > 0 }, liveReviewConfirmedAt: iso(settings.liveReviewedAt), site: { url, publicHttps: isPublicHttpsUrl(url) } };
}

export async function getPaymentHealthFor(user: SessionUser): Promise<PaymentHealth> {
  if (user.platformRole === "none") throw new AppError("forbidden", "Agency access is required.");
  return withSystem((db) => getPaymentHealth(db));
}

export interface ProviderCheckResult {
  outcome: CheckOutcome;
  text: string;
  health: ProviderHealth;
}

const clip = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);

/**
 * "Check connection": a read-only, authorized call to the provider with iAcquire's own credentials, recorded with the configuration it was made with. It creates and charges nothing.
 * Only a Super Admin may run it, a few times an hour. Not configured means nothing is called. A provider that cannot be reached, refuses the credentials or answers oddly is reported
 * as exactly that: the check never reports a success it did not see.
 */
export async function checkPaymentProvider(user: SessionUser, provider: ProviderId, opts: { now?: Date; fetch?: FetchLike } = {}): Promise<ProviderCheckResult> {
  if (user.platformRole !== "agency_super_admin") throw new AppError("forbidden", "Only a Super Admin can check a payment connection.");
  if (!PROVIDER_IDS.includes(provider)) throw new AppError("invalid_input", "Choose PayMongo or PayPal.");
  // A check that cannot be recorded would be a success nobody can see (or a failure nobody can read): refuse it before calling the provider.
  if (!(await withSystem((db) => checksAvailable(db)))) throw new AppError("unavailable", "Connection checks cannot be recorded until the database update 0119 is applied.");
  const limit = await consumeRateLimit(RATE_LIMITS.paymentProviderCheckByUser, user.id);
  if (!limit.allowed) throw new AppError("rate_limited", `The connection was checked several times already. Try again in ${Math.ceil(limit.retryAfterSeconds / 60)} minutes.`, { retryAfterSeconds: limit.retryAfterSeconds });
  const now = opts.now ?? new Date();
  const guide = PROVIDER_GUIDE[provider];
  const webhookUrl = appUrl(guide.webhookPath);
  const required = guide.events.filter((x) => x.required).map((x) => x.name);

  const before = configFacts(provider, true);
  let outcome: CheckOutcome;
  let facts: Record<string, unknown> = {};
  const keysSet = provider === "paymongo" ? Boolean(env().PAYMONGO_SECRET_KEY) : paypalAppCredentials() !== null;
  if (!keysSet) {
    outcome = "not_configured";
  } else if (provider === "paymongo") {
    const found = await checkPaymongoConnection({ webhookUrl, requiredEvents: required }, { fetch: opts.fetch });
    outcome = found.outcome;
    facts = { webhook: found.webhook, eventsMissing: found.eventsMissing, proof: found.proof };
  } else {
    const credentials = paypalAppCredentials() as NonNullable<ReturnType<typeof paypalAppCredentials>>;
    const answer = await providerFor("paypal").verifyCredentials(credentials, { webhookUrl });
    if (answer.ok) {
      outcome = answer.webhookFound === false ? "webhook_not_registered" : "verified";
      facts = { webhook: answer.webhookFound === null ? "unknown" : answer.webhookFound ? "registered" : "not_registered", eventsMissing: [], proof: "oauth" };
    } else {
      outcome = answer.reason === "rejected" ? "credentials_rejected" : "unreachable";
      facts = { webhook: "unknown", eventsMissing: [], message: clip(answer.message, 200) };
    }
  }
  const livemode = before.mode === "live";
  await withSystem(async (db) => {
    await recordCheck(db, { provider, livemode, outcome, facts, checkedBy: user.id, at: now });
    await recordAudit({ actorUserId: user.id, actorKind: "agency", action: "payment_provider.checked", targetType: "payment_provider", targetId: provider, result: outcome === "verified" ? "success" : "failure", metadata: { provider, mode: livemode ? "live" : "test", outcome } }, db);
  });
  const health = await withSystem((db) => healthOf(db, provider));
  return { outcome, text: CHECK_OUTCOME_TEXT[outcome], health };
}
