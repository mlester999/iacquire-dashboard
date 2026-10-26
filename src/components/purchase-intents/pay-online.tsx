"use client";

import * as React from "react";
import { CreditCard, Loader2, LockKeyhole } from "lucide-react";
import { Button } from "@/components/ui/button";
import { startPurchaseCheckoutAction } from "@/app/actions/purchase-intents";
import { formatUsdCents } from "@/lib/purchase-intents/rules";

// The buyer's Pay button. It sends only the link's token; the amount, the currency and who is paying are the purchase's own, fixed when it was created. Pressing it opens the payment
// provider's page (or the checkout that is already open): nothing is charged here, and this page never says a payment was received. Only the provider's confirmation does that.
export function PayOnline({ token, setupFeeCents, previous }: { token: string; setupFeeCents: number; previous: "failed" | "cancelled" | "expired" | null }) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const pay = async () => {
    setBusy(true);
    setError(null);
    const result = await startPurchaseCheckoutAction(token);
    if (!result.ok) {
      setBusy(false);
      setError(result.error);
      return;
    }
    // Leave for the provider's page. The button stays busy so a second press cannot open a second tab while the first is loading.
    window.location.assign(result.data.checkoutUrl);
  };

  return (
    <div className="space-y-3">
      {previous && (
        <p role="status" className="rounded-xl border border-warning/30 bg-warning-soft px-3 py-2 text-[13px] leading-relaxed text-warning-ink">
          The last payment attempt did not go through. Nothing was charged. You can try again.
        </p>
      )}
      {error && <p role="alert" className="rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger-ink">{error}</p>}
      <Button type="button" size="lg" variant="brand" onClick={() => void pay()} disabled={busy} loading={busy} className="min-h-12 w-full sm:w-auto">
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <CreditCard className="size-4" aria-hidden />}
        Pay {formatUsdCents(setupFeeCents)} securely online
      </Button>
      <p className="flex items-start gap-1.5 text-[13px] leading-relaxed text-muted">
        <LockKeyhole className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
        <span>
          You pay on PayMongo&apos;s own page; iAcquire never sees your card details. PayMongo charges in Philippine pesos, so the dollar price is converted at iAcquire&apos;s published rate and you see
          the exact peso amount on PayMongo&apos;s page before you pay. Your workspace is created only after PayMongo confirms the payment.
        </span>
      </p>
    </div>
  );
}
