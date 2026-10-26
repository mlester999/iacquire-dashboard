"use client";

import * as React from "react";
import { Repeat } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/primitives";
import { Switch } from "@/components/ui/overlays";
import { setRecurringBillingAction } from "@/app/(admin)/admin/maintenance/actions";

export type RecurringBillingState = { enabled: boolean; available: boolean; reason: string | null; livemode: boolean | null };

// Whether a client may set up the optional automatic monthly payment (a PayPal subscription) for the maintenance plan. Off until a Super Admin turns it on; even then nothing is offered
// unless PayPal is connected, the billing plan is set and (for a live app) the payment review is confirmed, and the reason is said here in words. Closing it never touches an agreement that
// is already open: it keeps collecting until it is stopped.
export function RecurringBillingSwitch({ initial, canManage }: { initial: RecurringBillingState; canManage: boolean }) {
  const [state, setState] = React.useState(initial);
  const [busy, setBusy] = React.useState(false);
  const toggle = async (next: boolean) => {
    setBusy(true);
    const result = await setRecurringBillingAction(next);
    setBusy(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setState(result.data);
    toast.success(next ? "Automatic payments are switched on." : "Automatic payments are switched off. Agreements already open keep collecting until they are stopped.");
  };
  return (
    <section aria-label="Automatic payments" className="rounded-2xl border border-line bg-surface p-4 shadow-soft sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold text-ink"><Repeat className="size-4 text-primary" aria-hidden /> Automatic monthly payments</h2>
          <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-muted">
            Lets a client with a maintenance plan approve a PayPal subscription for the plan&apos;s monthly price. PayPal then tries to collect each month. A month counts as paid only when PayPal confirms the charge; a failed charge starts the plan&apos;s grace period; a refund or a dispute holds the agreement for you to review. Plans without one are still paid by hand or online.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Badge tone={state.available ? "success" : state.enabled ? "warning" : "neutral"}>{state.available ? (state.livemode ? "Open (live)" : "Open (test mode)") : state.enabled ? "On, but not ready" : "Off"}</Badge>
          <Switch checked={state.enabled} disabled={!canManage || busy} onCheckedChange={(v) => void toggle(v)} aria-label="Allow clients to pay the maintenance plan automatically" />
        </div>
      </div>
      {state.reason && <p className="mt-3 rounded-xl bg-surface-2 px-3 py-2 text-[13px] leading-relaxed text-ink-2">{state.reason}</p>}
      {!canManage && <p className="mt-2 text-[12px] text-muted">Only a Super Admin can change this.</p>}
    </section>
  );
}
