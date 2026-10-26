"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { OctagonAlert, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Textarea } from "@/components/ui/primitives";
import { StatusPill } from "@/components/ui/status";
import { IconTile } from "@/components/admin/setup/ui";
import { cn } from "@/lib/utils";
import { Dialog } from "@/components/ui/overlays";
import { setAgencyPauseAction } from "@/app/actions/automation";

/** Agency emergency pause for one client. Any assigned staff can pause; only a super admin can lift it. */
export function AgencyPauseCard({ orgId, clientName, paused, canLift }: { orgId: string; clientName: string; paused: boolean; canLift: boolean }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  async function submit(next: boolean) {
    setBusy(true);
    const result = await setAgencyPauseAction(orgId, next, reason);
    setBusy(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setOpen(false);
    setReason("");
    toast.success(next ? `Emergency pause enabled for ${clientName}.` : `Emergency pause lifted for ${clientName}.`);
    router.refresh();
  }

  return (
    <section
      aria-label="Emergency pause"
      className={cn(
        "relative flex flex-col gap-4 overflow-hidden rounded-2xl border p-4 shadow-soft sm:flex-row sm:items-center sm:justify-between sm:p-5",
        paused ? "border-danger/40 bg-danger-soft/60" : "border-line bg-surface",
      )}
    >
      <span aria-hidden className={cn("absolute inset-y-0 left-0 w-1", paused ? "bg-danger" : "bg-success/70")} />
      <div className="flex min-w-0 items-start gap-3.5 pl-1">
        <IconTile icon={paused ? <OctagonAlert /> : <ShieldCheck />} tone={paused ? "danger" : "success"} />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[14.5px] font-semibold tracking-tight text-ink">{paused ? "Emergency pause is active" : "Automation pause is off"}</h2>
            <StatusPill tone={paused ? "danger" : "success"} size="sm">{paused ? "Automation paused" : "Automation running"}</StatusPill>
          </div>
          <p className="mt-1.5 max-w-xl text-[14px] leading-relaxed text-muted">
            {paused
              ? "Customer messages, follow-ups and autonomous jobs for this client are blocked on the server. Client records remain available. Only a super admin can lift this pause."
              : "No emergency pause is recorded. Integration verification and activation approval still determine whether automation can run. An emergency pause blocks sends, including queued ones, and notifies the client's owner and managers."}
          </p>
        </div>
      </div>
      {paused ? (
        <Button variant="secondary" size="sm" className="shrink-0" disabled={!canLift} onClick={() => submit(false)} loading={busy} title={canLift ? undefined : "Only a super admin can lift an emergency pause"}>
          Lift emergency pause
        </Button>
      ) : (
        <Button variant="danger" size="sm" className="shrink-0" onClick={() => setOpen(true)}>
          <OctagonAlert className="size-4" /> Emergency pause
        </Button>
      )}
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={`Pause all automation for ${clientName}?`}
        description="The reason is recorded in the audit log. The client's owner and managers are notified immediately."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="danger" disabled={reason.trim().length < 5} loading={busy} onClick={() => submit(true)}>Pause automation</Button>
          </>
        }
      >
        <Field label="Why is automation being paused?" htmlFor="agency-pause-reason">
          <Textarea id="agency-pause-reason" rows={3} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} />
        </Field>
      </Dialog>
    </section>
  );
}
