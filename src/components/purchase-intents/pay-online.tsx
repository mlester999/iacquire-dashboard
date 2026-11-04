"use client";

import * as React from "react";
import { ArrowRight, CreditCard, Loader2, LockKeyhole, TriangleAlert, Wallet } from "lucide-react";
import { startPurchaseCheckoutAction } from "@/app/actions/purchase-intents";
import { formatUsdCents } from "@/lib/purchase-intents/rules";

type Provider = "paymongo" | "paypal";

// The buyer's Pay buttons, one for each payment provider that is ready. They send only the link's token and the provider's name; the amount, the currency and who is paying are the
// purchase's own, fixed when it was created. Pressing one opens that provider's page (or the checkout that is already open): nothing is charged here, and this page never says a payment
// was received. Only the provider's own confirmation does that.
export function PayOnline({ token, setupFeeCents, previous, providers }: { token: string; setupFeeCents: number; previous: "failed" | "cancelled" | "expired" | null; providers: Array<{ id: Provider; label: string }> }) {
  const [busy, setBusy] = React.useState<Provider | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const price = formatUsdCents(setupFeeCents);

  const pay = async (provider: Provider) => {
    setBusy(provider);
    setError(null);
    const result = await startPurchaseCheckoutAction(token, provider);
    if (!result.ok) {
      setBusy(null);
      setError(result.error);
      return;
    }
    // Leave for the provider's page. The buttons stay busy so a second press cannot open a second tab while the first is loading.
    window.location.assign(result.data.checkoutUrl);
  };

  const has = (id: Provider) => providers.some((p) => p.id === id);
  // The first provider on offer is the highlighted one; with two, the other is a plain tile.
  const primary: Provider | null = has("paymongo") ? "paymongo" : has("paypal") ? "paypal" : null;
  return (
    <div className="space-y-3.5">
      {previous && (
        <p role="status" className="room-note room-note-warn">
          <TriangleAlert className="size-4" aria-hidden />
          <span>The last payment attempt did not go through. Nothing was charged. You can try again.</span>
        </p>
      )}
      {error && <p role="alert" className="room-note room-note-bad"><TriangleAlert className="size-4" aria-hidden /><span>{error}</span></p>}
      <div className="room-pays">
        {has("paymongo") && (
          <button type="button" className="room-pay" data-primary={primary === "paymongo"} onClick={() => void pay("paymongo")} disabled={busy !== null} aria-busy={busy === "paymongo" || undefined}>
            <span className="room-pay-icon" aria-hidden>{busy === "paymongo" ? <Loader2 className="size-5 animate-spin" /> : <CreditCard className="size-5" />}</span>
            <span className="min-w-0">
              <span className="room-pay-title">Pay {price} by card or e-wallet</span>{" "}
              <span className="room-pay-sub">PayMongo, charged in pesos at iAcquire&apos;s published rate</span>
            </span>
            <ArrowRight className="room-pay-go size-5" aria-hidden />
          </button>
        )}
        {has("paypal") && (
          <button type="button" className="room-pay" data-primary={primary === "paypal"} onClick={() => void pay("paypal")} disabled={busy !== null} aria-busy={busy === "paypal" || undefined}>
            <span className="room-pay-icon" aria-hidden>{busy === "paypal" ? <Loader2 className="size-5 animate-spin" /> : <Wallet className="size-5" />}</span>
            <span className="min-w-0">
              <span className="room-pay-title">Pay {price} with PayPal</span>{" "}
              <span className="room-pay-sub">PayPal, in US dollars with your PayPal account or a card</span>
            </span>
            <ArrowRight className="room-pay-go size-5" aria-hidden />
          </button>
        )}
      </div>
      <p className="room-small flex items-start gap-2">
        <LockKeyhole className="mt-1 size-3.5 shrink-0" style={{ color: "var(--rm-blue)" }} aria-hidden />
        <span>
          {has("paymongo") && (
            <>
              Card and e-wallet payments are made on PayMongo&apos;s own page; iAcquire never sees your card details. PayMongo charges in Philippine pesos, so the dollar price is converted at
              iAcquire&apos;s published rate and you see the exact peso amount on PayMongo&apos;s page before you pay.{" "}
            </>
          )}
          {has("paypal") && <>PayPal payments are made in US dollars on PayPal&apos;s own page, with your PayPal account or a card; iAcquire never sees your payment details. </>}
          Your workspace is created only after the provider confirms the payment.
        </span>
      </p>
    </div>
  );
}
