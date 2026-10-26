"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Repeat } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/primitives";
import { StatusPill } from "@/components/ui/status";
import { useRunner } from "@/components/projects/common";
import { releaseAgreementHoldAction, stopAgreementAction } from "@/app/(admin)/admin/maintenance/actions";
import { isTerminalAgreement, paymentModeLabel } from "@/lib/maintenance-agreement";
import type { AgreementView } from "@/server/maintenance/agreement-read";
import { formatDate } from "@/lib/utils";

// How one client's maintenance plan is paid: by hand or online each period (no agreement), or automatically through PayPal. The words are the same ones the client reads. A hold
// (a refund or a dispute PayPal reported) stops further charges being added to the plan until a person releases it, saying why; nothing here records a payment or extends a plan.
export function AgreementBlock({ agreement: a }: { agreement: AgreementView | null }) {
  const router = useRouter();
  const { run, isPending } = useRunner();
  const [note, setNote] = React.useState("");
  const mode = paymentModeLabel(a ? { status: a.status, provider: a.provider, nextBillingAt: a.nextBillingAt, failedPayments: a.failedPayments, hold: a.hold } : null);
  const open = Boolean(a && !isTerminalAgreement(a.status));
  const done = async (key: string, fn: () => Promise<{ ok: boolean; error?: string }>, msg: string) => {
    const ok = await run(key, fn as never, msg);
    if (ok !== null) {
      setNote("");
      router.refresh();
    }
  };
  return (
    <div role="group" className="space-y-2 rounded-xl bg-surface-2/70 p-3 ring-1 ring-inset ring-line" aria-label="How this plan is paid">
      <div className="flex flex-wrap items-center gap-2">
        <Repeat className="size-3.5 text-muted" aria-hidden />
        <StatusPill size="sm" tone={mode.mode === "automatic" ? "primary" : "neutral"}>{mode.mode === "automatic" ? "Automatic · PayPal" : "By hand or online"}</StatusPill>
        <p className="text-[13px] font-medium text-ink">{mode.headline}</p>
      </div>
      <p className="text-[13px] leading-relaxed text-ink-2">{mode.detail}</p>
      {a && (
        <p className="text-[12px] text-muted">
          Agreement {a.reference}{a.livemode ? "" : " (test mode)"} · {a.failedPayments ? `${a.failedPayments} failed charge${a.failedPayments === 1 ? "" : "s"} · ` : ""}opened {formatDate(a.createdAt, "UTC")}
          {a.heldCharges ? ` · ${a.heldCharges} charge${a.heldCharges === 1 ? "" : "s"} recorded and not yet added to the plan` : ""}
        </p>
      )}
      {a && (a.hold || a.heldCharges > 0) && (
        <div className="flex flex-wrap items-end gap-2 border-t border-line pt-2">
          <label className="min-w-0 flex-1 text-[12px] text-muted">
            Why the hold can be released
            <Input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="For example: the dispute was won, or the refund was a goodwill gesture" className="mt-1 h-9" />
          </label>
          <Button size="sm" variant="brand" disabled={note.trim().length < 5} loading={isPending(`rel-${a.id}`)} onClick={() => void done(`rel-${a.id}`, () => releaseAgreementHoldAction(a.id, note), "Released. Held charges were added to the plan.")}>
            Release hold
          </Button>
        </div>
      )}
      {a && open && (
        <div className="flex justify-end">
          <Button size="sm" variant="outline" loading={isPending(`stop-${a.id}`)} onClick={() => void done(`stop-${a.id}`, () => stopAgreementAction(a.id), "Automatic payments stopped. The plan is unchanged.")}>
            Stop automatic payments
          </Button>
        </div>
      )}
    </div>
  );
}
