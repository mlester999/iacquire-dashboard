"use client";

import * as React from "react";
import { CreditCard, Loader2, LockKeyhole, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
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
  return (
    <div className="space-y-3">
      {previous && (
        <p role="status" className="rounded-xl border border-warning/30 bg-warning-soft px-3 py-2 text-[14px] leading-relaxed text-warning-ink">
          The last payment attempt did not go through. Nothing was charged. You can try again.
        </p>
      )}
      {error && <p role="alert" className="rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-[14px] text-danger-ink">{error}</p>}
      <div className="flex flex-col gap-2.5 sm:flex-row sm:flex-wrap">
        {has("paymongo") && (
          <Button type="button" size="lg" variant="brand" onClick={() => void pay("paymongo")} disabled={busy !== null} loading={busy === "paymongo"} className="min-h-12 w-full sm:w-auto">
            {busy === "paymongo" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <CreditCard className="size-4" aria-hidden />}
            Pay {price} by card or e-wallet
          </Button>
        )}
        {has("paypal") && (
          <Button type="button" size="lg" variant={has("paymongo") ? "secondary" : "brand"} onClick={() => void pay("paypal")} disabled={busy !== null} loading={busy === "paypal"} className="min-h-12 w-full sm:w-auto">
            {busy === "paypal" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Wallet className="size-4" aria-hidden />}
            Pay {price} with PayPal
          </Button>
        )}
      </div>
      <p className="flex items-start gap-1.5 text-[14px] leading-relaxed text-muted">
        <LockKeyhole className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
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
