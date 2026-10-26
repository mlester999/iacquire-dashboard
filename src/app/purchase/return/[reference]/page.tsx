import type { Metadata } from "next";
import { headers } from "next/headers";
import { AlertTriangle, CheckCircle2, Clock3, XCircle } from "lucide-react";
import { Logo } from "@/components/brand";
import { Card, CardContent } from "@/components/ui/primitives";
import { ReturnRefresh } from "@/components/purchase-intents/return-refresh";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { getCheckoutReturn } from "@/server/purchase-intents/checkout";

export const metadata: Metadata = { title: "Your iAcquireOS payment", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

// Where the payment provider sends the buyer back to. The address carries the checkout's own reference (never the bearer token of the purchase), and the page only reads what the
// provider's signed confirmation has already recorded: coming back here proves nothing about a payment, so it never says "paid" on its own.

const ICON = { success: CheckCircle2, warning: AlertTriangle, danger: XCircle, neutral: Clock3 } as const;
const TONE = { success: "text-success", warning: "text-warning", danger: "text-danger", neutral: "text-primary" } as const;

export default async function PurchaseReturnPage({ params, searchParams }: { params: Promise<{ reference: string }>; searchParams: Promise<{ result?: string | string[] }> }) {
  const { reference } = await params;
  const { result } = await searchParams;
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
  const limited = await consumeRateLimit(RATE_LIMITS.purchaseReturnByIp, ip);
  // The provider's cancel link adds ?result=cancelled. It only changes the wording of a payment that has not been confirmed; it never marks anything paid or cancelled.
  const left = result === "cancelled";
  const state = limited.allowed ? await getCheckoutReturn(reference, { leftThePaymentPage: left }) : null;
  const Icon = state ? ICON[state.tone] : Clock3;
  return (
    <main className="min-h-screen bg-bg px-4 py-8 sm:px-6 sm:py-14">
      <div className="mx-auto max-w-xl">
        <div className="mb-6"><Logo /></div>
        <Card>
          <CardContent className="space-y-3 py-10 text-center">
            <Icon className={`mx-auto size-10 ${state ? TONE[state.tone] : TONE.neutral}`} aria-hidden />
            <h1 className="text-[22px] font-semibold tracking-[-0.03em] text-ink">{state ? state.title : "Too many attempts"}</h1>
            <p role="status" className="mx-auto max-w-md text-[14px] leading-relaxed text-muted">{state ? state.body : "Wait a moment and refresh this page."}</p>
            {state?.checkoutStatus && <p className="text-[12px] text-muted">Payment reference {reference}</p>}
          </CardContent>
        </Card>
        <ReturnRefresh active={Boolean(state && state.tone === "neutral" && !(left && state.checkoutStatus !== null && state.checkoutStatus !== "paid"))} />
      </div>
    </main>
  );
}
