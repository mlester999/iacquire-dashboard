"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Archive, CheckCircle2, Clock, DoorOpen, Download, Globe2, Hourglass, MessagesSquare, ShieldCheck, TriangleAlert, Trash2 } from "lucide-react";
import { cancelOffboardingOwnerAction, requestOffboardingAction } from "@/app/actions/offboarding";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/overlays";
import { InfoChip, StatusPill, type StatusTone } from "@/components/ui/status";
import { IconTile, Notice, Panel } from "@/components/settings/panel";
import { formatDate, formatDateTime, relativeTime, sentenceCase } from "@/lib/utils";
import type { OffboardingView } from "@/server/offboarding/service";

const STATUS: Record<string, { tone: StatusTone; label: string }> = {
  requested: { tone: "warning", label: "Requested" },
  retention: { tone: "neutral", label: "Closed, data kept for now" },
  deleted: { tone: "danger", label: "Deleted" },
  cancelled: { tone: "neutral", label: "Last request cancelled" },
};

const WHAT_HAPPENS = [
  { icon: <MessagesSquare />, text: "Asking to close starts a conversation with iAcquire, not an immediate shutdown." },
  { icon: <DoorOpen />, text: "When the workspace is closed down, AI employees and messaging stop, your team's access is removed, and your data is kept for a period before it is deleted. You're reminded before that happens." },
  { icon: <Archive />, text: "Payments, your credit history and the activity record are kept, as financial and audit records. Everything else is deleted." },
];

export function DataPanel({ orgName, view, canRequest, canExport }: { orgName: string; view: OffboardingView | null; canRequest: boolean; canExport: boolean }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [confirmName, setConfirmName] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const active = view && ["requested", "shutdown", "retention"].includes(view.status);
  const status = view ? (STATUS[view.status] ?? { tone: "success" as StatusTone, label: sentenceCase(view.status) }) : null;

  const request = async () => {
    setBusy(true);
    const res = await requestOffboardingAction({ confirmName, reason });
    setBusy(false);
    if (!res.ok) return void toast.error(res.error);
    toast.success("We've received your request. Nothing has been switched off.");
    setOpen(false);
    router.refresh();
  };
  const cancel = async () => {
    setBusy(true);
    const res = await cancelOffboardingOwnerAction("");
    setBusy(false);
    if (!res.ok) return void toast.error(res.error);
    toast.success("Cancelled. Nothing changed.");
    router.refresh();
  };

  return (
    <div className="space-y-6">
      {canExport && (
        <Panel
          icon={<Download />}
          title="Download your data"
          description="Everything you own, as readable files: your contacts and every conversation, leads and appointments, website content and images, your AI team's setup and approvals, and your billing history. You can do this any time, whether or not you're leaving."
          bodyClassName="space-y-4"
        >
          <a href="/api/data-export" download className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl brand-gradient px-5 text-sm font-medium text-white shadow-glow transition hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:h-10 sm:w-auto">
            <Download className="size-4" aria-hidden /> Download everything (ZIP)
          </a>
          <Notice tone="neutral" icon={<ShieldCheck />}>
            It&apos;s prepared when you ask and isn&apos;t stored. It leaves out passwords and connection secrets, and anything belonging to other clients. Each download is recorded in your activity history.
          </Notice>
        </Panel>
      )}

      <Panel
        icon={<Globe2 />}
        tone="success"
        title="Your domains stay yours"
        description="A domain registered in your name, or one you connected from your own registrar, belongs to you and is never held back. The export includes a guide to moving each one. The free address iAcquire hosts for you stops working when your website is taken down."
      />

      {canRequest || view ? (
        <Panel
          icon={<DoorOpen />}
          tone={view?.status === "deleted" ? "danger" : view?.status === "requested" ? "warning" : "neutral"}
          title="Close your workspace"
          description={active ? "Here is where it stands." : "If you decide to leave, nothing is switched off when you ask. You keep everything while you take your data, and you can change your mind."}
          aside={status ? <StatusPill tone={status.tone}>{status.label}</StatusPill> : undefined}
          bodyClassName="space-y-5"
        >
          {!active && canRequest && (
            <>
              <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface-2/40">
                {WHAT_HAPPENS.map((w) => (
                  <li key={w.text} className="flex items-start gap-3.5 px-4 py-3.5">
                    <IconTile icon={w.icon} tone="neutral" size="sm" />
                    <p className="min-w-0 flex-1 self-center text-[14px] leading-relaxed text-ink-2">{w.text}</p>
                  </li>
                ))}
              </ul>
              <Button variant="secondary" className="w-full sm:w-auto" onClick={() => setOpen(true)}>Ask to close my workspace…</Button>
            </>
          )}

          {view && view.status === "requested" && (
            <div className="space-y-3">
              <Notice tone="warning" icon={<Hourglass />} title={`Requested ${relativeTime(view.requestedAt)}`}>
                iAcquire will contact you to confirm the plan, including what happens to your website and domains. <strong className="font-semibold text-ink">Nothing has been switched off.</strong>
              </Notice>
              {canRequest && <Button variant="secondary" loading={busy} className="w-full sm:w-auto" onClick={cancel}>I&apos;ve changed my mind. Cancel this request</Button>}
            </div>
          )}

          {view && view.status === "retention" && (
            <div className="space-y-4">
              <Notice tone="warning" icon={<TriangleAlert />} title={`Your workspace was closed down${view.shutdownAt ? ` ${relativeTime(view.shutdownAt)}` : ""}`}>
                You can still sign in to download your data. It will be deleted after <strong className="font-semibold text-ink">{view.deleteAfter ? formatDate(view.deleteAfter, "UTC") : "the retention period"}</strong> unless you ask to come back.
              </Notice>
              {view.steps.length > 0 && (
                <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line" aria-label="What was done">
                  {view.steps.map((s) => (
                    <li key={s.key} className="flex items-start gap-3 px-4 py-3 text-[14px] leading-relaxed text-ink-2">
                      <CheckCircle2 className={`mt-0.5 size-4 shrink-0 ${s.ok ? "text-success-ink" : "text-warning-ink"}`} aria-hidden />
                      <span className="min-w-0 flex-1">{s.text}</span>
                      <StatusPill tone={s.ok ? "success" : "warning"} size="sm">{s.ok ? "Done" : "Needs attention"}</StatusPill>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex flex-wrap items-center gap-2">
                {view.exportDownloadedAt ? (
                  <StatusPill tone="success" icon={<ShieldCheck className="size-3" aria-hidden />}>Data downloaded {relativeTime(view.exportDownloadedAt)}</StatusPill>
                ) : (
                  <StatusPill tone="warning" icon={<Download className="size-3" aria-hidden />}>Data not downloaded yet</StatusPill>
                )}
              </div>
              <p className="text-[13px] text-muted">Want to come back? Contact iAcquire support and we&apos;ll restore your workspace.</p>
            </div>
          )}

          {view && view.status === "deleted" && (
            <Notice tone="danger" icon={<Trash2 />} title="Your data was deleted">
              {view.timeline.find((t) => t.kind === "deleted") ? `${formatDateTime(view.timeline.find((t) => t.kind === "deleted")!.at, "UTC")}. ` : ""}Payment and activity records are kept as required.
            </Notice>
          )}

          {view && view.timeline.length > 0 && (
            <details className="group rounded-2xl border border-line bg-surface-2/40 px-4 py-3 text-[14px]">
              <summary className="flex min-h-9 cursor-pointer list-none items-center justify-between gap-2 font-medium text-ink [&::-webkit-details-marker]:hidden">
                <span className="flex items-center gap-2"><Clock className="size-4 text-muted" aria-hidden /> History <InfoChip>{view.timeline.length}</InfoChip></span>
                <span aria-hidden className="text-muted transition-transform group-open:rotate-180">⌄</span>
              </summary>
              <ol className="mt-3 space-y-3 border-l border-line-strong pl-4">
                {view.timeline.map((t, i) => (
                  <li key={i} className="relative">
                    <span aria-hidden className="absolute -left-[21px] top-1.5 size-2 rounded-full bg-primary ring-4 ring-surface" />
                    <InfoChip>{formatDateTime(t.at, "UTC")}</InfoChip>
                    <p className="mt-1 text-ink-2">{t.detail ?? sentenceCase(t.kind)}</p>
                  </li>
                ))}
              </ol>
            </details>
          )}
        </Panel>
      ) : null}

      <Dialog
        open={open}
        onOpenChange={setOpen}
        size="md"
        title={`Ask to close ${orgName}?`}
        description="Nothing is switched off by asking. iAcquire will confirm the plan with you first."
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>Not now</Button>
            <Button variant="danger" loading={busy} disabled={confirmName.trim().toLowerCase() !== orgName.trim().toLowerCase()} onClick={request}>Ask to close</Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Why are you leaving?" htmlFor="off-reason" optional hint="Helps us improve. Not required.">
            <Textarea id="off-reason" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <Field label={`Type "${orgName}" to confirm`} htmlFor="off-name">
            <Input id="off-name" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} autoComplete="off" />
          </Field>
        </div>
      </Dialog>
    </div>
  );
}
