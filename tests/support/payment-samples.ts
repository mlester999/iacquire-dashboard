// Sample objects for the Super Admin payment screens' component tests: a purchase invitation as the server describes it, a delivery of it, and a payment provider's health. Plain data, no
// database and no provider; the shapes are the server's own types, so a change to them is a type error here.
import { deriveReadiness, PROVIDER_GUIDE, type Mode, type ProviderId } from "@/lib/payment-providers/readiness";
import { toDeliveryView, type DeliveryRecord, type DeliveryView } from "@/lib/purchase-intents/delivery";
import { PURCHASE_STATUS_TEXT, PURCHASE_STATUS_TONE } from "@/lib/purchase-intents/rules";
import type { CheckoutSwitchView, PurchaseIntentView } from "@/server/purchase-intents/service";
import type { CheckoutState, PaymentHealth, ProviderHealth } from "@/server/billing/provider-health";

const T0 = new Date("2026-11-02T12:00:00Z");
const ago = (h: number) => new Date(T0.getTime() - h * 3_600_000).toISOString();
const ahead = (d: number) => new Date(T0.getTime() + d * 86_400_000).toISOString();

export const sampleDelivery = (over: Partial<DeliveryRecord> = {}): DeliveryView =>
  toDeliveryView({ id: "d-1", kind: "invitation", status: "sent", reason: null, recipient: "bailey@harborview.example", provider: "resend", error: null, linkExpiresAt: ahead(14), createdAt: ago(0.05), completedAt: ago(0.05), ...over }, T0);

export const sampleIntent = (over: Partial<PurchaseIntentView> = {}): PurchaseIntentView => ({
  id: "6f1f0d9e-0000-4000-8000-0000000000a1", reference: "PUR-SAMPLE2345", buyerName: "Bailey Buyer", buyerEmail: "bailey@harborview.example", company: "Harborview Realty Group", industry: "Real estate", website: "", timezone: "America/Chicago",
  maintenanceSelected: true, setupFeeCents: 149900, maintenanceMonthlyCents: 29900, currency: "USD", productVersion: "launch-2026-10", status: "invited", storedStatus: "invited",
  statusText: PURCHASE_STATUS_TEXT.invited, statusTone: PURCHASE_STATUS_TONE.invited, expiresAt: ahead(14), startedAt: null, paymentAt: null, provisionedAt: null, cancelledAt: null, expiredAt: null, paymentMethod: null,
  paymentReference: null, paymentPaidOn: null, paymentNote: null, paymentAmountCents: null, clientOrgId: null, autoProvision: false, paymentSource: "manual", paymentHold: null, holdText: null, provisionAttempts: 0,
  lastProvisionError: null, createdAt: ago(0.05), delivery: null, can: { start: true, verify: false, provision: false, cancel: true, rotate: true, release: false },
  ...over,
});

export type SampleProviderState = "none" | "incomplete" | "testing" | "verified" | "stale" | "failed" | "live_approval" | "live_ready";

export function sampleProvider(id: ProviderId, st: SampleProviderState, over: Partial<ProviderHealth> = {}): ProviderHealth {
  const guide = PROVIDER_GUIDE[id];
  const anySet = st !== "none";
  const live = st === "live_approval" || st === "live_ready";
  const complete = st !== "none" && st !== "incomplete";
  const mode: Mode | null = anySet ? (live ? "live" : "test") : null;
  const missing = st === "incomplete" ? (id === "paymongo" ? ["PAYMONGO_WEBHOOK_SECRET", "the USD to PHP exchange rate (Billing, Rates & payments)"] : ["PAYPAL_CLIENT_SECRET", "PAYPAL_WEBHOOK_ID"]) : [];
  const verified = st === "verified" || st === "live_approval" || st === "live_ready";
  const readiness = deriveReadiness({ anySet, missing, mode, verifiedForCurrentConfig: verified, liveReviewed: st === "live_ready" });
  const available = complete && (mode === "test" || st === "live_ready");
  return {
    provider: id,
    label: id === "paymongo" ? "PayMongo" : "PayPal",
    readiness,
    mode,
    envVars: guide.envVars.map((g, i) => ({ ...g, set: g.name === "PAYPAL_ENVIRONMENT" ? true : complete ? true : st === "incomplete" ? i === 0 : false, usingDefault: false, shown: g.name === "PAYPAL_ENVIRONMENT" ? (live ? "live" : "sandbox") : g.name === "PAYMONGO_PAYMENT_METHODS" ? "card, gcash" : null, problem: null })),
    missing,
    webhook: {
      url: `https://www.iacquire.online${guide.webhookPath}`, reachableByProvider: true, events: guide.events, where: guide.webhookWhere, testHow: guide.testHow,
      lastNotice: verified ? { at: ago(5), type: "checkout_session.payment.paid", outcome: "processed" } : null, refusedLast7Days: st === "failed" ? 2 : 0,
    },
    check: ["none", "incomplete", "testing"].includes(st)
      ? null
      : st === "failed"
        ? { at: ago(1), ok: false, outcome: "credentials_rejected", text: "The provider did not accept these credentials. Check that they are the right key for the right mode, and still active.", stale: false, mode: "test", webhook: "unknown", eventsMissing: [], message: null }
        : { at: ago(st === "stale" ? 30 : 2), ok: true, outcome: "verified", text: "The provider accepted the credentials.", stale: st === "stale", mode: live ? "live" : "test", webhook: "registered", eventsMissing: [], message: null },
    exchangeRate: id === "paymongo" ? { set: complete, usdPhpRate: complete ? 58 : null, source: "BSP reference rate", updatedAt: ago(20) } : null,
    available,
    blockedReason: available ? null : readiness.state === "live_approval_required" ? "Live payments are switched off until iAcquire confirms the payment and tax review." : readiness.next,
    docsUrl: guide.docsUrl,
    ...over,
  };
}

export function sampleHealth(paymongo: SampleProviderState, paypal: SampleProviderState = "none", state: CheckoutState = "off"): PaymentHealth {
  const providers = [sampleProvider("paymongo", paymongo), sampleProvider("paypal", paypal)];
  return { providers, checkout: { switchOn: state !== "off", state, headline: `sample headline for ${state}`, anyProviderAvailable: providers.some((p) => p.available) }, liveReviewConfirmedAt: null, site: { url: "https://www.iacquire.online/", publicHttps: true } };
}

export function sampleSwitch(state: CheckoutState, health: PaymentHealth = sampleHealth(state === "open_test" ? "verified" : state === "open_live" ? "live_ready" : "none", "none", state)): CheckoutSwitchView {
  return {
    enabled: state !== "off",
    available: state === "open_test" || state === "open_live",
    reason: state === "off" ? "Online checkout for purchases is switched off in the billing settings." : state === "blocked" ? health.providers[0].blockedReason : null,
    livemode: state === "open_live" ? true : state === "open_test" ? false : null,
    state,
    headline: health.checkout.headline,
    providers: health.providers.map((p) => ({ id: p.provider, label: p.label, available: p.available, reason: p.blockedReason, livemode: p.mode === null ? null : p.mode === "live", mode: p.mode, readiness: p.readiness })),
  };
}
