"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, CreditCard } from "lucide-react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/overlays";
import { StatusPill } from "@/components/ui/status";
import { setPurchaseCheckoutEnabledAction } from "@/app/actions/purchase-intents";
import { MODE_LABEL } from "@/lib/payment-providers/readiness";
import type { CheckoutSwitchView } from "@/server/purchase-intents/service";

// Whether buyers may be sent to a payment provider from their purchase link. Off until a Super Admin turns it on; and "on" is never allowed to read as "working": the badge says
// "On, but blocked" while no provider can take and confirm a payment, and the switch cannot be turned on until one can. Each provider shows the same setup state the Billing screen
// shows (one answer, from the server). Closing the switch never touches a checkout that is already open.

const STATE_BADGE: Record<CheckoutSwitchView["state"], { label: string; tone: "neutral" | "warning" | "success" }> = {
  off: { label: "Off", tone: "neutral" },
  blocked: { label: "On, but blocked", tone: "warning" },
  open_test: { label: "Open (test mode)", tone: "success" },
  open_live: { label: "Open (live)", tone: "warning" },
};

export function CheckoutSwitch({ initial, canManage }: { initial: CheckoutSwitchView; canManage: boolean }) {
  const [state, setState] = React.useState(initial);
  const [busy, setBusy] = React.useState(false);
  const anyReady = state.providers.some((p) => p.available);
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
  const badge = STATE_BADGE[state.state];
  return (
    <section aria-label="Online checkout" className="rounded-2xl border border-line bg-surface p-4 shadow-soft sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold text-ink"><CreditCard className="size-4 text-primary" aria-hidden /> Online checkout</h2>
          <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-muted">
            Lets a buyer who confirmed their purchase pay the setup fee on the payment provider&apos;s own page (PayMongo, PayPal). A payment counts only when the provider&apos;s verified confirmation arrives.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <StatusPill tone={badge.tone}>{badge.label}</StatusPill>
          <Switch checked={state.enabled} disabled={!canManage || busy || (!state.enabled && !anyReady)} onCheckedChange={(v) => void toggle(v)} aria-label="Allow buyers to pay online" />
        </div>
      </div>
      <p role="status" className={`mt-3 flex items-start gap-2 rounded-xl px-3 py-2 text-[13px] leading-relaxed ${state.state === "blocked" ? "border border-warning/40 bg-warning-soft text-warning-ink" : "bg-surface-2 text-ink-2"}`}>
        {state.state === "blocked" && <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />}
        <span>{state.headline}</span>
      </p>
      <ul className="mt-3 space-y-2" aria-label="Payment providers">
        {state.providers.map((p) => (
          <li key={p.id} className="flex flex-wrap items-start gap-x-2 gap-y-1 text-[13px] text-ink-2">
            <span className="font-medium text-ink">{p.label}</span>
            <StatusPill tone={p.readiness.tone} size="sm">{p.readiness.label}</StatusPill>
            {p.mode && <StatusPill tone={p.mode === "live" ? "warning" : "primary"} size="sm" dot={false}>{MODE_LABEL[p.mode]}</StatusPill>}
            {!p.available && <span className="basis-full text-muted">{p.reason ?? p.readiness.next}</span>}
          </li>
        ))}
      </ul>
      {!anyReady && (
        <p className="mt-3 text-[13px] leading-relaxed text-ink-2">
          No provider is ready yet. <Link href="/admin/billing?tab=providers" className="font-medium text-primary hover:underline">Set up and check the payment providers</Link>
          {state.enabled ? ": the switch is already on, so buyers are offered online payment as soon as one provider is ready." : ", then come back to switch checkout on."}
        </p>
      )}
      {!canManage && <p className="mt-2 text-[12px] text-muted">Only a Super Admin with the billing and client-creation permissions can change this.</p>}
    </section>
  );
}
