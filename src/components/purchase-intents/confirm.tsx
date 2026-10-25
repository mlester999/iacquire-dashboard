"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { startPurchaseAction } from "@/app/actions/purchase-intents";
import { PayOnline } from "@/components/purchase-intents/pay-online";
import type { CheckoutStatus } from "@/lib/purchase-intents/rules";

// The buyer's only action: confirm the details they were invited with. No account, card or password is collected here.
export function ConfirmPurchase({ token, canConfirm, problem, setupFeeCents, checkout }: { token: string; canConfirm: boolean; problem: string | null; setupFeeCents: number; checkout: { offered: boolean; status: CheckoutStatus | null; reference: string | null } }) {
  const router = useRouter();
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState(false);

  const confirm = async () => {
    setSaving(true);
    setError(null);
    const result = await startPurchaseAction(token);
    setSaving(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setDone(true);
    router.refresh();
  };

  if (problem) return <p className="rounded-xl border border-line bg-surface-2 px-4 py-3 text-[13px] leading-relaxed text-muted">{problem}</p>;
  // Confirmed (now or earlier) and online payment is open: the next step is paying. After a checkout that did not complete, the buyer may try again.
  const previous = checkout.status === "failed" || checkout.status === "cancelled" || checkout.status === "expired" ? checkout.status : null;
  if ((done || !canConfirm) && checkout.offered) {
    return (
      <div className="space-y-3">
        <div className="rounded-xl border border-success/30 bg-success-soft px-4 py-3 text-[13px] leading-relaxed text-success-ink">
          <p className="flex items-center gap-2 font-medium"><CheckCircle2 className="size-4" aria-hidden /> Your purchase is confirmed.</p>
          <p className="mt-1">The next step is the payment.</p>
        </div>
        <PayOnline token={token} setupFeeCents={setupFeeCents} previous={previous} />
        {checkout.reference && checkout.status === "pending" && <p className="text-[12px] text-muted">A checkout is already open for this purchase ({checkout.reference}). Pressing the button opens it again; you are not charged twice.</p>}
      </div>
    );
  }
  if (done || !canConfirm) {
    return (
      <div className="rounded-xl border border-success/30 bg-success-soft px-4 py-3 text-[13px] leading-relaxed text-success-ink">
        <p className="flex items-center gap-2 font-medium"><CheckCircle2 className="size-4" aria-hidden /> Your purchase is confirmed.</p>
        <p className="mt-1">iAcquire will verify the payment and send your workspace invitation. You can close this page.</p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {error && <p role="alert" className="rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-[12.5px] text-danger-ink">{error}</p>}
      <Button type="button" size="lg" variant="brand" onClick={() => void confirm()} loading={saving} disabled={saving}>
        {saving ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null} Confirm and continue
      </Button>
      <p className="text-[12px] leading-relaxed text-muted">No card is charged on this page. Confirming records your choice and the frozen price. Then you pay on the payment provider&apos;s own page, or iAcquire sends you another secure way to pay.</p>
    </div>
  );
}
