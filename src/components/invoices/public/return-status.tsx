"use client";

import * as React from "react";
import { CircleAlert, CircleCheck, Hourglass, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BACK_STORAGE_KEY, CAPTURE_ENDPOINT, POLL_DELAYS_MS, REFERENCE_HEADER, safeBackPath, STATUS_ENDPOINT } from "@/lib/invoices/public-http";
import type { ReturnDescription } from "@/lib/invoices/public-status";

// Where a customer lands after the provider's page. It says "we are confirming your payment" until the database says the payment is received, and it asks the server again
// (never the address, which only says how the customer left the provider's page) for a few minutes. For a provider where approving does not take the money by itself
// (PayPal), it first asks the server to take the payment the customer approved; the answer to that is a fact to check, not a payment.

const TONE = {
  ok: { icon: CircleCheck, box: "border-success-ink/25 bg-success-soft text-success-ink" },
  wait: { icon: Hourglass, box: "border-warning-ink/30 bg-warning-soft text-warning-ink" },
  problem: { icon: CircleAlert, box: "border-danger/25 bg-danger-soft text-danger-ink" },
} as const;

type View = Pick<ReturnDescription, "state" | "headline" | "detail" | "polling" | "tone">;

const noSubscription = () => () => undefined;
const noBackPath = () => null;
function readBackPath(): string | null {
  try {
    return safeBackPath(window.sessionStorage.getItem(BACK_STORAGE_KEY));
  } catch {
    // Storage can be blocked; there is then no way back to offer.
    return null;
  }
}

export function ReturnStatus({ reference, initial, approvedCheckoutId }: { reference: string; initial: View; approvedCheckoutId: string | null }) {
  const [view, setView] = React.useState<View>(initial);
  const [exhausted, setExhausted] = React.useState(false);
  const [round, setRound] = React.useState(0);
  // The page the customer left to pay lives in this tab's own storage: nothing on the server knows it, and the server's markup has no way back to offer.
  const back = React.useSyncExternalStore(noSubscription, readBackPath, noBackPath);
  const captured = React.useRef(false);

  React.useEffect(() => {
    if (!view.polling && round === 0) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function ask(): Promise<View | null> {
      try {
        const res = await fetch(STATUS_ENDPOINT, { headers: { [REFERENCE_HEADER]: reference }, cache: "no-store", referrerPolicy: "no-referrer" });
        if (!res.ok) return null;
        return (await res.json()) as View;
      } catch {
        return null;
      }
    }

    async function step(i: number) {
      if (cancelled) return;
      if (i >= POLL_DELAYS_MS.length) {
        setExhausted(true);
        return;
      }
      timer = setTimeout(async () => {
        const next = await ask();
        if (cancelled) return;
        if (next) {
          setView(next);
          if (!next.polling) return;
        }
        void step(i + 1);
      }, POLL_DELAYS_MS[i]);
    }

    async function start() {
      if (approvedCheckoutId && !captured.current) {
        captured.current = true;
        try {
          await fetch(CAPTURE_ENDPOINT, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reference, checkoutId: approvedCheckoutId }), cache: "no-store", referrerPolicy: "no-referrer" });
        } catch {
          // The provider's own notification or the scheduled check records the payment if it was taken.
        }
        const next = await ask();
        if (cancelled) return;
        if (next) {
          setView(next);
          if (!next.polling) return;
        }
      }
      void step(0);
    }
    void start();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [reference, approvedCheckoutId, round]); // eslint-disable-line react-hooks/exhaustive-deps -- the polling restarts only for a new round, not for each answer it receives

  const tone = TONE[view.tone];
  const Icon = tone.icon;
  return (
    <div className="space-y-4">
      <div role="status" aria-live="polite" className={`flex items-start gap-3 rounded-2xl border px-5 py-4 ${tone.box}`}>
        <Icon className="mt-0.5 size-5 shrink-0" aria-hidden />
        <div>
          <h1 className="text-[18px] font-semibold tracking-[-0.02em]">{view.headline}</h1>
          <p className="mt-1 text-[14px] leading-relaxed">{view.detail}</p>
          {view.polling && !exhausted && <p className="mt-2 flex items-center gap-1.5 text-[12.5px]"><Loader2 className="size-3.5 animate-spin" aria-hidden />Checking again in a moment. You can leave this page open.</p>}
        </div>
      </div>
      {view.polling && exhausted && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <p className="text-[13.5px] text-ink-2">Still waiting for your payment provider to confirm it.</p>
          <Button variant="secondary" onClick={() => { setExhausted(false); setRound((r) => r + 1); }}>Check again</Button>
        </div>
      )}
      {back && (
        <p className="text-[13.5px]"><a href={back} className="inline-flex min-h-11 items-center font-medium text-primary-ink underline">Back to your invoice</a></p>
      )}
    </div>
  );
}
