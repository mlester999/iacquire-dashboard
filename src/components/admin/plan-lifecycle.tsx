"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, BadgeCheck, CalendarClock, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/overlays";
import { useRunner } from "@/components/projects/common";
import { expireSubscriptionAction, recordPaymentFailedAction, recordVerifiedPaymentAction } from "@/app/(admin)/admin/maintenance/actions";
import { MAX_GRACE_DAYS, PAYMENT_GRACE_DAYS } from "@/lib/automation-studio/plan";
import { formatDate } from "@/lib/utils";

export interface PlanLifecycleInfo {
  pastDueSince: string | null;
  graceEndsAt: string | null;
  expiredAt: string | null;
  paidThroughOn: string | null;
  lastPaymentVerifiedAt: string | null;
  lastPaymentVerifiedBy: string | null;
  studioWorkflows: number;
  studioPaused: number;
  /** Days since the paid-through day, while the plan is still running with no payment recorded since; null otherwise. Absent on sample pages that predate it. */
  periodEndedDaysAgo?: number | null;
}

type Dlg = "failed" | "verified" | "expire" | null;

const inDays = (iso: string, now = Date.now()) => Math.ceil((new Date(iso).getTime() - now) / 86_400_000);
const plusMonthIso = () => {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
};

/**
 * What an agency member can record about a client's Automation Studio plan: a failed payment (which starts a grace period the client is told about), a
 * payment they verified themselves (which reactivates it), or ending it now. Nothing here charges a card, detects a payment or switches anything on by
 * itself: every action is a person recording what they know, is audited, and is checked again on the server.
 */
export function PlanLifecycle({ subscriptionId, status, info }: { subscriptionId: string; status: string; info: PlanLifecycleInfo }) {
  const router = useRouter();
  const { run, isPending } = useRunner();
  const [dialog, setDialog] = React.useState<Dlg>(null);
  const [graceDays, setGraceDays] = React.useState(String(PAYMENT_GRACE_DAYS));
  const [through, setThrough] = React.useState(plusMonthIso());
  const [confirmed, setConfirmed] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const canFail = status === "active" || status === "cancel_requested";
  const canVerify = status === "active" || status === "past_due" || status === "expired" || status === "cancel_requested";
  const canExpire = status === "past_due" || status === "active" || status === "cancel_requested";
  const left = info.graceEndsAt ? inDays(info.graceEndsAt) : null;

  const act = async (key: string, fn: () => Promise<{ ok: boolean; error?: string }>, msg: string) => {
    setError(null);
    const ok = await run(key, fn as never, msg);
    if (ok !== null) {
      setDialog(null);
      setConfirmed(false);
      router.refresh();
    } else setError("That didn't go through. Check the details and try again.");
  };

  return (
    <div role="group" className="space-y-3 rounded-xl border border-line bg-surface-2/50 p-3" aria-label="Automation Studio plan">
      <p className="text-[12px] font-semibold uppercase tracking-[.08em] text-muted">Automation Studio plan</p>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-[12.5px] min-[460px]:grid-cols-2">
        <div className="flex gap-2"><dt className="text-muted">Paid through</dt><dd className="font-medium text-ink">{info.paidThroughOn ? formatDate(info.paidThroughOn, "UTC") : "Not recorded"}</dd></div>
        <div className="flex gap-2"><dt className="text-muted">Last verified</dt><dd className="font-medium text-ink">{info.lastPaymentVerifiedAt ? `${formatDate(info.lastPaymentVerifiedAt, "UTC")}${info.lastPaymentVerifiedBy ? ` by ${info.lastPaymentVerifiedBy}` : ""}` : "Never"}</dd></div>
        <div className="flex gap-2"><dt className="text-muted">Studio workflows</dt><dd className="font-medium text-ink">{info.studioWorkflows}{info.studioPaused ? `, ${info.studioPaused} paused for the plan` : ""}</dd></div>
      </dl>

      {(status === "active" || status === "cancel_requested") && info.periodEndedDaysAgo != null && info.periodEndedDaysAgo > 0 && (
        <p className="flex items-start gap-2 rounded-lg bg-warning-soft px-3 py-2 text-[12.5px] text-warning-ink" role="status">
          <CalendarClock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>The paid period ended {info.periodEndedDaysAgo} day{info.periodEndedDaysAgo === 1 ? "" : "s"} ago and no payment has been recorded since. The plan is still active. Record the payment, or record a failed payment to start the grace period.</span>
        </p>
      )}
      {status === "past_due" && info.graceEndsAt && (
        <p className="flex items-start gap-2 rounded-lg bg-warning-soft px-3 py-2 text-[12.5px] text-warning-ink" role="status">
          <CalendarClock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>Payment failed{info.pastDueSince ? ` on ${formatDate(info.pastDueSince, "UTC")}` : ""}. The client keeps Automation Studio until {formatDate(info.graceEndsAt, "UTC")} ({left !== null && left > 0 ? `${left} day${left === 1 ? "" : "s"} left` : "ends today"}); then its workflows pause.</span>
        </p>
      )}
      {status === "expired" && (
        <p className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-[12.5px] text-danger-ink" role="status">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>Expired{info.expiredAt ? ` on ${formatDate(info.expiredAt, "UTC")}` : ""}. Studio workflows are paused (nothing is deleted). Recording a verified payment brings the plan back; the client then turns each workflow on again after reviewing it.</span>
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {canFail && <Button size="sm" variant="outline" onClick={() => { setError(null); setDialog("failed"); }}><AlertTriangle className="size-3.5" aria-hidden />Record failed payment</Button>}
        {canVerify && <Button size="sm" variant={status === "past_due" || status === "expired" ? "brand" : "secondary"} onClick={() => { setError(null); setDialog("verified"); }}><BadgeCheck className="size-3.5" aria-hidden />Record verified payment</Button>}
        {canExpire && <Button size="sm" variant="outline" onClick={() => { setError(null); setDialog("expire"); }}>End plan now</Button>}
      </div>

      <Dialog
        open={dialog === "failed"}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Record a failed payment"
        description="The client’s owners are told today and keep Automation Studio during the grace period. After it, their Studio workflows are paused, not deleted."
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialog(null)}>Cancel</Button>
            <Button variant="primary" loading={isPending(`pf-${subscriptionId}`)} onClick={() => void act(`pf-${subscriptionId}`, () => recordPaymentFailedAction(subscriptionId, Number(graceDays)), "Failed payment recorded; the client has been told.")}>Record it</Button>
          </>
        }
      >
        <Field label="Grace period (days)" htmlFor="grace-days" hint={`From 1 to ${MAX_GRACE_DAYS}. The default is ${PAYMENT_GRACE_DAYS}. The client is told the exact date.`}>
          <Input id="grace-days" type="number" min={1} max={MAX_GRACE_DAYS} value={graceDays} onChange={(e) => setGraceDays(e.target.value)} />
        </Field>
        {error && <p className="mt-2 text-[12.5px] text-danger-ink" role="alert">{error}</p>}
      </Dialog>

      <Dialog
        open={dialog === "verified"}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Record a verified payment"
        description="iAcquire does not charge cards or detect payments. Record only a payment you have confirmed in your own billing records."
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialog(null)}>Cancel</Button>
            <Button variant="brand" disabled={!confirmed || !through} loading={isPending(`pv-${subscriptionId}`)} onClick={() => void act(`pv-${subscriptionId}`, () => recordVerifiedPaymentAction(subscriptionId, through, confirmed), "Verified payment recorded.")}>Record payment</Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="The payment covers through" htmlFor="paid-through">
            <Input id="paid-through" type="date" value={through} onChange={(e) => setThrough(e.target.value)} />
          </Field>
          <label className="flex items-start gap-2 text-[13px] text-ink-2">
            <input type="checkbox" className="mt-0.5 size-4 rounded border-line-strong" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            <span>I confirmed this payment in our billing records.</span>
          </label>
          {status === "past_due" || status === "expired" ? <p className="text-[12.5px] text-muted">The plan becomes active again. Workflows that were paused stay paused until the client reviews and turns each one on.</p> : null}
          {error && <p className="text-[12.5px] text-danger-ink" role="alert">{error}</p>}
        </div>
      </Dialog>

      <Dialog
        open={dialog === "expire"}
        onOpenChange={(o) => !o && setDialog(null)}
        title="End the plan now?"
        description="Automation Studio workflows for this client are paused straight away (nothing is deleted) and the client is told. Their CRM, AI employees and external automations are not affected."
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialog(null)}>Cancel</Button>
            <Button variant="danger" loading={isPending(`ex-${subscriptionId}`)} onClick={() => void act(`ex-${subscriptionId}`, () => expireSubscriptionAction(subscriptionId), "Plan ended; Studio workflows paused.")}>End plan</Button>
          </>
        }
      >
        {error && <p className="text-[12.5px] text-danger-ink" role="alert">{error}</p>}
      </Dialog>
    </div>
  );
}
