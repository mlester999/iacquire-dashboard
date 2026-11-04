import type { Metadata } from "next";
import { headers } from "next/headers";
import { PaymentResultView } from "@/components/purchase-intents/payment-result";
import { ReturnRefresh } from "@/components/purchase-intents/return-refresh";
import { PaypalReturnCapture } from "@/components/purchase-intents/paypal-return-capture";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { getCheckoutReturn } from "@/server/purchase-intents/checkout";

export const metadata: Metadata = { title: "Your iAcquireOS payment", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

// Where the payment provider sends the buyer back to. The address carries the checkout's own reference (never the bearer token of the purchase), and the page only reads what the
// provider's signed confirmation has already recorded: coming back here proves nothing about a payment, so it never says "paid" on its own. How it looks is payment-result.tsx.

export default async function PurchaseReturnPage({ params, searchParams }: { params: Promise<{ reference: string }>; searchParams: Promise<{ result?: string | string[] }> }) {
  const { reference } = await params;
  const { result } = await searchParams;
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
  const limited = await consumeRateLimit(RATE_LIMITS.purchaseReturnByIp, ip);
  // The provider's cancel link adds ?result=cancelled. It only changes the wording of a payment that has not been confirmed; it never marks anything paid or cancelled.
  const left = result === "cancelled";
  const state = limited.allowed ? await getCheckoutReturn(reference, { leftThePaymentPage: left }) : null;
  const polling = Boolean(state && state.tone === "neutral" && !(left && state.checkoutStatus !== null && state.checkoutStatus !== "paid"));
  return (
    <>
      <PaymentResultView
        stage={state ? state.stage : "limited"}
        title={state ? state.title : "Too many attempts"}
        body={state ? state.body : "Wait a moment and refresh this page."}
        reference={state?.checkoutStatus ? reference : null}
        live={polling}
      />
      {state?.needsCapture ? <PaypalReturnCapture reference={reference} /> : null}
      <ReturnRefresh active={polling} />
    </>
  );
}
