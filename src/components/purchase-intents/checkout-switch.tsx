"use client";

import * as React from "react";
import { CreditCard } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/primitives";
import { Switch } from "@/components/ui/overlays";
import { setPurchaseCheckoutEnabledAction } from "@/app/actions/purchase-intents";

// Whether buyers may be sent to PayMongo from their purchase link. Off until a Super Admin turns it on; even then nothing is offered unless the provider is connected, an exchange rate is
// set and (for live keys) the payment review is confirmed, and the reason is said here in words. Closing it never touches a checkout that is already open.
export function CheckoutSwitch({ initial, canManage }: { initial: { enabled: boolean; available: boolean; reason: string | null; livemode: boolean | null }; canManage: boolean }) {
  const [state, setState] = React.useState(initial);
  const [busy, setBusy] = React.useState(false);
  const toggle = async (next: boolean) => {
    setBusy(true);
    const result = await setPurchaseCheckoutEnabledAction(next);
    setBusy(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setState(result.data);
    toast.success(next ? "Online checkout is switched on." : "Online checkout is switched off.");
  };
  return (
    <section aria-label="Online checkout" className="rounded-2xl border border-line bg-surface p-4 shadow-soft sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold text-ink"><CreditCard className="size-4 text-primary" aria-hidden /> Online checkout</h2>
          <p className="mt-1 max-w-xl text-[12.5px] leading-relaxed text-muted">
            Lets a buyer who confirmed their purchase pay the setup fee on PayMongo&apos;s page. A payment counts only when PayMongo&apos;s signed confirmation arrives.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Badge tone={state.available ? "success" : state.enabled ? "warning" : "neutral"}>{state.available ? (state.livemode ? "Open (live)" : "Open (test mode)") : state.enabled ? "On, but not ready" : "Off"}</Badge>
          <Switch checked={state.enabled} disabled={!canManage || busy} onCheckedChange={(v) => void toggle(v)} aria-label="Allow buyers to pay online" />
        </div>
      </div>
      {state.reason && <p className="mt-3 rounded-xl bg-surface-2 px-3 py-2 text-[12.5px] leading-relaxed text-ink-2">{state.reason}</p>}
      {!canManage && <p className="mt-2 text-[11.5px] text-muted">Only a Super Admin with the billing and client-creation permissions can change this.</p>}
    </section>
  );
}
