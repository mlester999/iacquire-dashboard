"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, CheckCircle2, Info, Loader2, TriangleAlert } from "lucide-react";
import { startPurchaseAction } from "@/app/actions/purchase-intents";
import { PayOnline } from "@/components/purchase-intents/pay-online";
import type { CheckoutStatus } from "@/lib/purchase-intents/rules";

type NoteTone = "neutral" | "good" | "warn";
const NOTE_CLASS: Record<NoteTone, string> = { neutral: "room-note", good: "room-note room-note-good", warn: "room-note room-note-warn" };

// The buyer's only action: confirm the details they were invited with. No account, card or password is collected here.
export function ConfirmPurchase({ token, canConfirm, problem, setupFeeCents, checkout, tone = "neutral" }: { token: string; canConfirm: boolean; problem: string | null; setupFeeCents: number; checkout: { offered: boolean; status: CheckoutStatus | null; reference: string | null; providers: Array<{ id: "paymongo" | "paypal"; label: string }> }; tone?: NoteTone }) {
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

  if (problem) {
    const Icon = tone === "good" ? CheckCircle2 : tone === "warn" ? TriangleAlert : Info;
    return <p className={NOTE_CLASS[tone]}><Icon className="size-4" aria-hidden /><span>{problem}</span></p>;
  }
  // Confirmed (now or earlier) and online payment is open: the next step is paying. After a checkout that did not complete, the buyer may try again.
  const previous = checkout.status === "failed" || checkout.status === "cancelled" || checkout.status === "expired" ? checkout.status : null;
  if ((done || !canConfirm) && checkout.offered) {
    return (
      <div className="space-y-4">
        <div className="room-note room-note-good" role="status">
          <CheckCircle2 className="size-4" aria-hidden />
          <div>
            <p className="font-semibold">Your purchase is confirmed.</p>
            <p>The next step is the payment.</p>
          </div>
        </div>
        <PayOnline token={token} setupFeeCents={setupFeeCents} previous={previous} providers={checkout.providers} />
        {checkout.reference && checkout.status === "pending" && <p className="room-small">A checkout is already open for this purchase ({checkout.reference}). Pressing the button opens it again; you are not charged twice.</p>}
      </div>
    );
  }
  if (done || !canConfirm) {
    return (
      <div className="room-note room-note-good" role="status">
        <CheckCircle2 className="size-4" aria-hidden />
        <div>
          <p className="font-semibold">Your purchase is confirmed.</p>
          <p>iAcquire will verify the payment and send your workspace invitation. You can close this page.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-3.5">
      {error && <p role="alert" className="room-note room-note-bad"><TriangleAlert className="size-4" aria-hidden /><span>{error}</span></p>}
      <button type="button" className="room-cta" onClick={() => void confirm()} disabled={saving} aria-busy={saving || undefined}>
        {saving ? <Loader2 className="size-5 animate-spin" aria-hidden /> : null}
        <span>Confirm and continue</span>
        {saving ? null : <ArrowRight className="room-cta-arrow size-5" aria-hidden />}
      </button>
      <p className="room-small">No card is charged on this page. Confirming records your choice and the frozen price. Then you pay on the payment provider&apos;s own page, or iAcquire sends you another secure way to pay.</p>
    </div>
  );
}
