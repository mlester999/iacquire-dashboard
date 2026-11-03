import Link from "next/link";
import { notFound } from "next/navigation";
import { env } from "@/server/env";
import { PaymentProvidersPanel } from "@/components/admin/payment-providers-panel";
import { CheckoutSwitch } from "@/components/purchase-intents/checkout-switch";
import { InvitationCreated, type InvitationResult } from "@/components/purchase-intents/create-form";
import { PurchaseIntentsWorkspace } from "@/components/purchase-intents/workspace";
import { PreviewTheme } from "@/components/projects/preview-theme";
import { deriveReadiness, PROVIDER_GUIDE, type Mode, type ProviderId } from "@/lib/payment-providers/readiness";
import { toDeliveryView, type DeliveryRecord } from "@/lib/purchase-intents/delivery";
import { PURCHASE_STATUS_TEXT, PURCHASE_STATUS_TONE } from "@/lib/purchase-intents/rules";
import type { CheckoutProvider } from "@/server/purchase-intents/availability";
import type { CheckoutSwitchView, PurchaseIntentView } from "@/server/purchase-intents/service";
import type { CheckoutState, PaymentHealth, ProviderHealth } from "@/server/billing/provider-health";

export const dynamic = "force-dynamic";

// Development-only sample data for the Super Admin's payment screens (Billing, Payment providers; Purchase intents, the checkout switch, the invitation answer and the list), so each
// state can be seen and measured in a browser without a login, a database or a payment provider. Nothing here reads a database or calls anything; the buttons that would act reach a
// server action that refuses without a session. Hidden outside development.
//
//   section=providers&state=none|incomplete|testing|verified|stale|failed|live_approval|live_ready
//   section=switch&state=off|blocked|open_test|open_live
//   section=invitation&state=sent|manual|failed|replay|pending
//   section=list&state=filled|empty
const PROVIDER_STATES = ["none", "incomplete", "testing", "verified", "stale", "failed", "live_approval", "live_ready"] as const;
type ProviderState = (typeof PROVIDER_STATES)[number];
const SWITCH_STATES = ["off", "blocked", "open_test", "open_live"] as const;
const INVITATION_STATES = ["sent", "manual", "failed", "replay", "pending"] as const;

const now = Date.now();
const ago = (h: number) => new Date(now - h * 3_600_000).toISOString();
const ahead = (days: number) => new Date(now + days * 86_400_000).toISOString();

function provider(id: ProviderId, st: ProviderState): ProviderHealth {
  const guide = PROVIDER_GUIDE[id];
  const anySet = st !== "none";
  const live = st === "live_approval" || st === "live_ready";
  const complete = !["none", "incomplete"].includes(st);
  const mode: Mode | null = anySet ? (live ? "live" : "test") : null;
  const missing = st === "incomplete" ? (id === "paymongo" ? ["PAYMONGO_WEBHOOK_SECRET", "the USD to PHP exchange rate (Billing, Rates & payments)"] : ["PAYPAL_CLIENT_SECRET", "PAYPAL_WEBHOOK_ID"]) : [];
  const verified = st === "verified" || st === "live_approval" || st === "live_ready";
  const readiness = deriveReadiness({ anySet, missing, mode, verifiedForCurrentConfig: verified, liveReviewed: st === "live_ready" });
  const available = complete && (mode === "test" || st === "live_ready");
  const envVars = guide.envVars.map((g, i) => {
    // With nothing set, the two settings that have a built-in default show it as "Default", exactly as the live page does.
    const hasDefault = g.name === "PAYMONGO_PAYMENT_METHODS" || g.name === "PAYPAL_ENVIRONMENT";
    const usingDefault = hasDefault && !anySet;
    return {
      ...g,
      set: hasDefault ? true : complete ? true : st === "incomplete" ? i === 0 : false,
      usingDefault,
      shown: g.name === "PAYPAL_ENVIRONMENT" ? (live ? "live" : "sandbox") : g.name === "PAYMONGO_PAYMENT_METHODS" ? (usingDefault ? "card" : "card, gcash") : null,
    };
  });
  const failed = st === "failed";
  return {
    provider: id,
    label: id === "paymongo" ? "PayMongo" : "PayPal",
    readiness,
    mode,
    envVars,
    missing,
    webhook: {
      url: `https://www.iacquire.online${guide.webhookPath}`,
      reachableByProvider: true,
      events: guide.events,
      where: guide.webhookWhere,
      testHow: guide.testHow,
      lastNotice: verified ? { at: ago(5), type: id === "paymongo" ? "checkout_session.payment.paid" : "PAYMENT.CAPTURE.COMPLETED", outcome: "processed" } : null,
      refusedLast7Days: failed ? 2 : 0,
    },
    check:
      st === "none" || st === "incomplete" || st === "testing"
        ? null
        : failed
          ? { at: ago(1), ok: false, outcome: "credentials_rejected", text: "The provider did not accept these credentials. Check that they are the right key for the right mode, and still active.", stale: false, mode: "test", webhook: "unknown", eventsMissing: [], message: id === "paypal" ? "PayPal did not accept this client ID and secret." : null }
          : { at: ago(st === "stale" ? 30 : 2), ok: true, outcome: "verified", text: "The provider accepted the credentials.", stale: st === "stale", mode: live ? "live" : "test", webhook: "registered", eventsMissing: [], message: null },
    exchangeRate: id === "paymongo" ? { set: st !== "none" && st !== "incomplete", usdPhpRate: st !== "none" && st !== "incomplete" ? 58 : null, source: "BSP reference rate, 2 Nov", updatedAt: ago(20) } : null,
    available,
    blockedReason: available ? null : readiness.state === "live_approval_required" ? "Live payments are switched off until iAcquire confirms the payment and tax review." : readiness.next,
    docsUrl: guide.docsUrl,
  };
}

function health(st: ProviderState, state: CheckoutState = "off"): PaymentHealth {
  const providers = [provider("paymongo", st), provider("paypal", st === "none" ? "none" : st === "live_ready" ? "live_ready" : "incomplete")];
  return { providers, checkout: { switchOn: state !== "off", state, headline: headlineOf(state), anyProviderAvailable: providers.some((p) => p.available) }, liveReviewConfirmedAt: st === "live_ready" ? ago(48) : null, site: { url: "https://www.iacquire.online/", publicHttps: true } };
}

function headlineOf(state: CheckoutState): string {
  return state === "off"
    ? "Online checkout is off. Buyers are told iAcquire will verify their payment another way."
    : state === "blocked"
      ? "The switch is on, but no payment provider is ready, so buyers are NOT offered online payment. Finish a provider's setup below."
      : state === "open_live"
        ? "Online checkout is open for real money."
        : "Online checkout is open in test mode: no real money moves.";
}

function switchView(state: CheckoutState): CheckoutSwitchView {
  const h = health(state === "open_live" ? "live_ready" : state === "open_test" ? "verified" : state === "blocked" ? "none" : "testing", state);
  return {
    enabled: state !== "off",
    available: state === "open_test" || state === "open_live",
    reason: state === "off" ? "Online checkout for purchases is switched off in the billing settings." : state === "blocked" ? h.providers[0].blockedReason : null,
    livemode: state === "open_live" ? true : state === "open_test" ? false : null,
    state,
    headline: headlineOf(state),
    providers: h.providers.map((p) => ({ id: p.provider as CheckoutProvider, label: p.label, available: p.available, reason: p.blockedReason, livemode: p.mode === null ? null : p.mode === "live", mode: p.mode, readiness: p.readiness })),
  };
}

const intent = (over: Partial<PurchaseIntentView> = {}): PurchaseIntentView => ({
  id: "6f1f0d9e-0000-4000-8000-0000000000a1", reference: "PUR-SAMPLE2345", buyerName: "Bailey Buyer", buyerEmail: "bailey@harborview.example", company: "Harborview Realty Group", industry: "Real estate", website: "", timezone: "America/Chicago",
  maintenanceSelected: true, setupFeeCents: 149900, maintenanceMonthlyCents: 29900, currency: "USD", productVersion: "launch-2026-10", status: "invited", storedStatus: "invited",
  statusText: PURCHASE_STATUS_TEXT.invited, statusTone: PURCHASE_STATUS_TONE.invited, expiresAt: ahead(14), startedAt: null, paymentAt: null, provisionedAt: null, cancelledAt: null, expiredAt: null, paymentMethod: null,
  paymentReference: null, paymentPaidOn: null, paymentNote: null, paymentAmountCents: null, clientOrgId: null, autoProvision: false, paymentSource: "manual", paymentHold: null, holdText: null, provisionAttempts: 0,
  lastProvisionError: null, createdAt: ago(0.1), delivery: null,
  can: { start: true, verify: false, provision: false, cancel: true, rotate: true, release: false },
  ...over,
});

const delivery = (over: Partial<DeliveryRecord> = {}) =>
  toDeliveryView({ id: "d1", kind: "invitation", status: "sent", reason: null, recipient: "bailey@harborview.example", provider: "resend", error: null, linkExpiresAt: ahead(14), createdAt: ago(0.1), completedAt: ago(0.1), ...over }, new Date());

function invitation(state: (typeof INVITATION_STATES)[number]): InvitationResult {
  const token = "SAMPLEtokenSAMPLEtokenSAMPLEtokenSAMPLEtoken1"; // sample text only: not a credential
  switch (state) {
    case "manual":
      return { replayed: false, path: `/purchase/${token}`, intent: intent(), delivery: delivery({ status: "manual", reason: "email_off", provider: "capture" }) };
    case "failed":
      return { replayed: false, path: `/purchase/${token}`, intent: intent(), delivery: delivery({ status: "failed", reason: "provider_refused", error: "Provider responded 403: The iacquire.online domain is not verified." }) };
    case "pending":
      return { replayed: false, path: `/purchase/${token}`, intent: intent(), delivery: delivery({ status: "pending", completedAt: null }) };
    case "replay":
      return { replayed: true, path: null, intent: intent(), delivery: delivery() };
    default:
      return { replayed: false, path: `/purchase/${token}`, intent: intent(), delivery: delivery() };
  }
}

const listSample = (): PurchaseIntentView[] => [
  intent({ id: "6f1f0d9e-0000-4000-8000-0000000000a1", delivery: delivery() }),
  intent({ id: "6f1f0d9e-0000-4000-8000-0000000000a2", reference: "PUR-SAMPLE9876", company: "Northwind Dental Partners of the Greater Metropolitan Area", buyerName: "Dana Doe", buyerEmail: "dana.doe.with.a.very.long.address@northwind-dental-partners.example", maintenanceSelected: false, status: "started", storedStatus: "started", statusText: "Buyer confirmed", statusTone: "primary", delivery: delivery({ status: "manual", reason: "chosen", provider: "none", kind: "rotation" }) }),
  intent({ id: "6f1f0d9e-0000-4000-8000-0000000000a3", reference: "PUR-SAMPLE5555", company: "Lakeside Roofing", buyerName: "Lee Lake", buyerEmail: "lee@lakeside.example", delivery: delivery({ status: "failed", reason: "provider_unreachable", error: "The operation was aborted." }), status: "expired", storedStatus: "expired", statusText: "Link expired", statusTone: "neutral" }),
];

const email = { ready: true, sender: "iAcquire <no-reply@iacquire.online>", problems: [] as string[], warnings: [] as string[] };
const noEmail = { ready: false, sender: "iAcquire <no-reply@iacquire.local>", problems: ["EMAIL_PROVIDER is \"capture\", so messages are stored and never sent. Set EMAIL_PROVIDER=resend.", "RESEND_API_KEY is not set. Create a sending key in the Resend dashboard and add it."], warnings: [] as string[] };

type Q = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

export default async function AdminPaymentsPreview({ searchParams }: { searchParams: Promise<Q> }) {
  if (env().NODE_ENV === "production") notFound();
  const q = await searchParams;
  const section = one(q.section) ?? "providers";
  const state = one(q.state);
  const link = (s: string, st: string) => `/dev/admin-payments-preview?section=${s}&state=${st}`;
  return (
    <main className="mx-auto max-w-5xl space-y-5 px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[20px] font-semibold text-ink">Admin payments preview ({section})</h1>
        <PreviewTheme />
      </div>
      <nav aria-label="Samples" className="flex flex-wrap gap-2 text-[13px]">
        {PROVIDER_STATES.map((s) => <Link key={s} href={link("providers", s)} className="rounded-lg border border-line px-2.5 py-1 text-ink-2 hover:bg-surface-2">providers: {s}</Link>)}
        {SWITCH_STATES.map((s) => <Link key={s} href={link("switch", s)} className="rounded-lg border border-line px-2.5 py-1 text-ink-2 hover:bg-surface-2">switch: {s}</Link>)}
        {INVITATION_STATES.map((s) => <Link key={s} href={link("invitation", s)} className="rounded-lg border border-line px-2.5 py-1 text-ink-2 hover:bg-surface-2">invitation: {s}</Link>)}
        <Link href={link("list", "filled")} className="rounded-lg border border-line px-2.5 py-1 text-ink-2 hover:bg-surface-2">list: filled</Link>
        <Link href={link("list", "empty")} className="rounded-lg border border-line px-2.5 py-1 text-ink-2 hover:bg-surface-2">list: empty</Link>
        <Link href={link("list", "noemail")} className="rounded-lg border border-line px-2.5 py-1 text-ink-2 hover:bg-surface-2">form: email not set up</Link>
      </nav>
      {section === "providers" && <PaymentProvidersPanel health={health((PROVIDER_STATES as readonly string[]).includes(state ?? "") ? (state as ProviderState) : "none")} canManage />}
      {section === "switch" && <CheckoutSwitch initial={switchView((SWITCH_STATES as readonly string[]).includes(state ?? "") ? (state as CheckoutState) : "off")} canManage />}
      {section === "invitation" && <InvitationCreated result={invitation((INVITATION_STATES as readonly string[]).includes(state ?? "") ? (state as (typeof INVITATION_STATES)[number]) : "sent")} emailReady timeZone="America/Chicago" onReset={undefined} />}
      {section === "list" && <PurchaseIntentsWorkspace intents={state === "empty" || state === "noemail" ? [] : listSample()} timeZone="America/Chicago" email={state === "noemail" ? noEmail : email} />}
    </main>
  );
}
