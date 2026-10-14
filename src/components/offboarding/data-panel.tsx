"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2, DoorOpen, Download, Globe2, ShieldCheck, TriangleAlert } from "lucide-react";
import { cancelOffboardingOwnerAction, requestOffboardingAction } from "@/app/actions/offboarding";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input, Textarea } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/overlays";
import { formatDate, formatDateTime, relativeTime } from "@/lib/utils";
import type { OffboardingView } from "@/server/offboarding/service";

export function DataPanel({ orgName, view, canRequest, canExport }: { orgName: string; view: OffboardingView | null; canRequest: boolean; canExport: boolean }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [confirmName, setConfirmName] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const active = view && ["requested", "shutdown", "retention"].includes(view.status);

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
        <Card>
          <CardHeader>
            <div className="flex items-start gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary-ink"><Download className="size-5" aria-hidden /></span>
              <div>
                <CardTitle>Download your data</CardTitle>
                <CardDescription>Everything you own, as readable files: your contacts and every conversation, leads and appointments, website content and images, your AI team&apos;s setup and approvals, and your billing history. You can do this any time, whether or not you&apos;re leaving.</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <a href="/api/data-export" download className="inline-flex h-11 items-center justify-center gap-2 rounded-xl brand-gradient px-5 text-sm font-medium text-white shadow-glow transition hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:h-10">
              <Download className="size-4" aria-hidden /> Download everything (ZIP)
            </a>
            <p className="text-[12.5px] leading-relaxed text-muted">It&apos;s prepared when you ask and isn&apos;t stored. It leaves out passwords and connection secrets, and anything belonging to other clients. Each download is recorded in your activity history.</p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-success-soft text-success-ink"><Globe2 className="size-5" aria-hidden /></span>
            <div>
              <CardTitle>Your domains stay yours</CardTitle>
              <CardDescription>A domain registered in your name, or one you connected from your own registrar, belongs to you and is never held back. The export includes a guide to moving each one. The free address iAcquire hosts for you stops working when your website is taken down.</CardDescription>
            </div>
          </div>
        </CardHeader>
      </Card>

      {canRequest || view ? (
        <Card>
          <CardHeader>
            <div className="flex items-start gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-ink-2"><DoorOpen className="size-5" aria-hidden /></span>
              <div>
                <CardTitle className="flex flex-wrap items-center gap-2">
                  Close your workspace
                  {view && <Badge tone={view.status === "requested" ? "warning" : view.status === "retention" ? "neutral" : view.status === "deleted" ? "danger" : "success"}>{view.status === "requested" ? "Requested" : view.status === "retention" ? "Closed, data kept for now" : view.status === "deleted" ? "Deleted" : "Cancelled"}</Badge>}
                </CardTitle>
                <CardDescription>
                  {active ? "Here is where it stands." : "If you decide to leave, nothing is switched off when you ask. You keep everything while you take your data, and you can change your mind."}
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            {!active && canRequest && (
              <>
                <ul className="list-disc space-y-1.5 pl-5 text-[13px] leading-relaxed text-muted">
                  <li>Asking to close starts a conversation with iAcquire, not an immediate shutdown.</li>
                  <li>When the workspace is closed down, AI employees and messaging stop, your team&apos;s access is removed, and your data is kept for a period before it is deleted. You&apos;re reminded before that happens.</li>
                  <li>Payments, your credit history and the activity record are kept, as financial and audit records. Everything else is deleted.</li>
                </ul>
                <Button variant="secondary" onClick={() => setOpen(true)}>Ask to close my workspace…</Button>
              </>
            )}

            {view && view.status === "requested" && (
              <div className="space-y-3">
                <p className="text-[13.5px] leading-relaxed">Requested {relativeTime(view.requestedAt)}. iAcquire will contact you to confirm the plan, including what happens to your website and domains. <strong className="font-semibold">Nothing has been switched off.</strong></p>
                {canRequest && <Button variant="ghost" loading={busy} onClick={cancel}>I&apos;ve changed my mind. Cancel this request</Button>}
              </div>
            )}

            {view && view.status === "retention" && (
              <div className="space-y-4">
                <p className="flex items-start gap-2 text-[13.5px] leading-relaxed"><TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning-ink" aria-hidden />Your workspace was closed down {view.shutdownAt ? relativeTime(view.shutdownAt) : ""}. You can still sign in to download your data. It will be deleted after <strong className="font-semibold">{view.deleteAfter ? formatDate(view.deleteAfter, "UTC") : "the retention period"}</strong> unless you ask to come back.</p>
                {view.steps.length > 0 && (
                  <ul className="space-y-1.5" aria-label="What was done">
                    {view.steps.map((s) => (
                      <li key={s.key} className="flex items-start gap-2 text-[13px] leading-relaxed"><CheckCircle2 className={`mt-0.5 size-4 shrink-0 ${s.ok ? "text-success-ink" : "text-warning-ink"}`} aria-hidden />{s.text}</li>
                    ))}
                  </ul>
                )}
                <p className="flex items-center gap-2 text-[12.5px] text-muted"><ShieldCheck className="size-4 text-success-ink" aria-hidden />{view.exportDownloadedAt ? `You downloaded your data ${relativeTime(view.exportDownloadedAt)}.` : "You haven't downloaded your data yet."}</p>
                <p className="text-[12.5px] text-muted">Want to come back? Contact iAcquire support and we&apos;ll restore your workspace.</p>
              </div>
            )}

            {view && view.status === "deleted" && <p className="text-[13.5px] leading-relaxed">Your data was deleted {view.timeline.find((t) => t.kind === "deleted") ? formatDateTime(view.timeline.find((t) => t.kind === "deleted")!.at, "UTC") : ""}. Payment and activity records are kept as required.</p>}

            {view && view.timeline.length > 0 && (
              <details className="rounded-xl border border-line px-4 py-3 text-[13px]">
                <summary className="cursor-pointer font-medium">History</summary>
                <ol className="mt-3 space-y-2 border-l border-line pl-4">
                  {view.timeline.map((t, i) => (
                    <li key={i}><span className="text-muted">{formatDateTime(t.at, "UTC")}</span> · {t.detail ?? t.kind}</li>
                  ))}
                </ol>
              </details>
            )}
          </CardContent>
        </Card>
      ) : null}

      <Dialog
        open={open}
        onOpenChange={setOpen}
        size="md"
        title={`Ask to close ${orgName}?`}
        description="Nothing is switched off by asking. iAcquire will confirm the plan with you first."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>Not now</Button>
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
