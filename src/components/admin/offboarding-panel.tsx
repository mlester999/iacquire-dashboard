"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Circle, Clock, DoorClosed, ShieldAlert, Trash2 } from "lucide-react";
import { cancelOffboardingAgencyAction, closeBillingAction, dismissReviewAction, executeDeletionAction, planDeletionAction, shutdownAction, startOffboardingAction } from "@/app/(admin)/admin/commercial-actions";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/overlays";
import { formatDate, formatDateTime, relativeTime } from "@/lib/utils";
import { signedUsd } from "@/lib/finance";
import type { DeletionPlan, OffboardingView } from "@/server/offboarding/service";
import type { ReviewRow } from "@/server/inactivity/service";

function Check({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-[13px] leading-relaxed">
      {ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success-ink" aria-hidden /> : <Circle className="mt-0.5 size-4 shrink-0 text-faint" aria-hidden />}
      <span className={ok ? "" : "text-muted"}>{children}</span>
    </li>
  );
}

export function OffboardingPanel({ orgId, orgName, view, review, purgeEnabled, canManage }: { orgId: string; orgName: string; view: OffboardingView | null; review: ReviewRow | null; purgeEnabled: boolean; canManage: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState("");
  const [websitePlan, setWebsitePlan] = React.useState<"keep_until_deletion" | "unpublish_now">("keep_until_deletion");
  const [retentionDays, setRetentionDays] = React.useState(90);
  const [billingNote, setBillingNote] = React.useState("");
  const [plan, setPlan] = React.useState<DeletionPlan | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const [confirmName, setConfirmName] = React.useState("");
  const [waive, setWaive] = React.useState("");
  const [shutting, setShutting] = React.useState(false);
  const [reviewNote, setReviewNote] = React.useState("");
  const [now] = React.useState(() => Date.now());

  const act = async (key: string, fn: () => Promise<{ ok: boolean; error?: string }>, done: string, after?: () => void) => {
    setBusy(key);
    const res = await fn();
    setBusy(null);
    if (!res.ok) return void toast.error(res.error ?? "That didn't work.");
    toast.success(done);
    after?.();
    router.refresh();
  };

  const active = view && ["requested", "shutdown", "retention"].includes(view.status);
  const retentionOver = Boolean(view?.deleteAfter && new Date(view.deleteAfter).getTime() <= now);
  const ready = view?.status === "retention" && retentionOver && Boolean(view.billingClosedAt) && purgeEnabled;

  return (
    <div className="space-y-6">
      {review && review.status === "open" && (
        <Card>
          <CardHeader>
            <div className="flex items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-warning-soft text-warning-ink"><Clock className="size-4" aria-hidden /></span>
              <div>
                <CardTitle>Account has gone quiet</CardTitle>
                <CardDescription>No sign of activity for {review.inactiveDays} days. {review.noticesSent} notice{review.noticesSent === 1 ? "" : "s"} sent to the owner. Nothing has been deleted or switched off, and nothing will be without a decision.</CardDescription>
              </div>
            </div>
          </CardHeader>
          {canManage && (
            <CardContent className="space-y-3">
              <Field label="Keep the account as it is" htmlFor="review-note" hint="Records why and restarts the 180-day clock.">
                <Input id="review-note" value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} placeholder="e.g. Spoke to the owner; they're staying" />
              </Field>
              <Button variant="secondary" loading={busy === "review"} disabled={reviewNote.trim().length < 3} onClick={() => act("review", () => dismissReviewAction(review.id, reviewNote), "Recorded")}>Keep the account</Button>
            </CardContent>
          )}
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-ink-2"><DoorClosed className="size-4" aria-hidden /></span>
            <div>
              <CardTitle className="flex flex-wrap items-center gap-2">
                Offboarding
                {view ? <Badge tone={view.status === "requested" ? "warning" : view.status === "retention" ? "primary" : view.status === "deleted" ? "danger" : "success"}>{view.status === "retention" ? "Closed, in retention" : view.status[0].toUpperCase() + view.status.slice(1)}</Badge> : <Badge tone="neutral">Not leaving</Badge>}
              </CardTitle>
              <CardDescription>Leaving is a process, not a switch: the client takes their data and domains, automation stops safely, billing is settled, and deletion only follows the agreed retention period. Every step is recorded.</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          {!active && canManage && (
            <div className="space-y-3">
              <Field label="Reason" htmlFor="off-start-reason" optional hint="Starting this switches nothing off. It opens the process and tells the owner.">
                <Textarea id="off-start-reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
              </Field>
              <Button variant="secondary" loading={busy === "start"} onClick={() => act("start", () => startOffboardingAction(orgId, reason), "Offboarding started")}>Start offboarding</Button>
            </div>
          )}

          {view && view.status === "requested" && (
            <div className="space-y-4">
              <p className="text-[13.5px] leading-relaxed">Requested {relativeTime(view.requestedAt)} by {view.requestedByKind === "client" ? "the owner" : "the agency"}{view.reason ? `: "${view.reason}"` : ""}. Nothing has been switched off. Confirm the plan with the client, make sure they can take their data, then shut down.</p>
              {canManage && (
                <div className="flex flex-wrap gap-2">
                  <Button variant="danger" onClick={() => setShutting(true)}>Shut down the workspace…</Button>
                  <Button variant="ghost" loading={busy === "cancel"} onClick={() => act("cancel", () => cancelOffboardingAgencyAction(orgId, "Cancelled by the agency."), "Cancelled")}>Cancel the request</Button>
                </div>
              )}
            </div>
          )}

          {view && view.status === "retention" && (
            <div className="space-y-5">
              <ul className="space-y-2" aria-label="Shutdown steps">
                {view.steps.map((s) => (
                  <li key={s.key} className="flex items-start gap-2 text-[13px] leading-relaxed">
                    {s.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success-ink" aria-hidden /> : <ShieldAlert className="mt-0.5 size-4 shrink-0 text-danger-ink" aria-hidden />}
                    <span><span className="font-medium">{s.key[0].toUpperCase() + s.key.slice(1)}.</span> <span className={s.ok ? "text-muted" : "text-danger-ink"}>{s.text}</span></span>
                  </li>
                ))}
              </ul>
              <dl className="grid gap-3 sm:grid-cols-3">
                {[["Shut down", view.shutdownAt ? formatDateTime(view.shutdownAt, "UTC") : "—"], ["Kept until", view.deleteAfter ? formatDate(view.deleteAfter, "UTC") : "—"], ["Prepaid credit left", view.creditBalanceMicros === null ? "—" : signedUsd(view.creditBalanceMicros)]].map(([k, v]) => (
                  <div key={k} className="rounded-xl border border-line px-3.5 py-3"><dt className="text-[12px] text-muted">{k}</dt><dd className="mt-1 text-[15px] font-semibold">{v}</dd></div>
                ))}
              </dl>

              <div className="space-y-3 rounded-2xl border border-line p-4">
                <p className="text-[13.5px] font-semibold">Before anything can be deleted</p>
                <ul className="space-y-1.5">
                  <Check ok={retentionOver}>The retention period has ended{view.deleteAfter ? ` (${formatDate(view.deleteAfter, "UTC")})` : ""}.</Check>
                  <Check ok={Boolean(view.billingClosedAt)}>Billing is closed{view.billingClosedAt ? ` (${relativeTime(view.billingClosedAt)})` : ""}.</Check>
                  <Check ok={Boolean(view.exportDownloadedAt)}>The client downloaded their data{view.exportDownloadedAt ? ` (${relativeTime(view.exportDownloadedAt)})` : ", or you record why not"}.</Check>
                  <Check ok={purgeEnabled}>Permanent deletion is enabled for this environment{purgeEnabled ? "" : " (it is off by default; it is switched on deliberately, after a backup has been restored once)"}.</Check>
                </ul>
                {canManage && !view.billingClosedAt && (
                  <div className="space-y-2 border-t border-line pt-3">
                    <Field label="Close billing" htmlFor="bill-note" hint="Say how the remaining credit and any charges were settled (for example refunded through PayMongo, or waived).">
                      <Input id="bill-note" value={billingNote} onChange={(e) => setBillingNote(e.target.value)} />
                    </Field>
                    <Button size="sm" variant="secondary" loading={busy === "bill"} disabled={billingNote.trim().length < 3} onClick={() => act("bill", () => closeBillingAction(orgId, view.id, billingNote), "Billing closed")}>Record billing as closed</Button>
                  </div>
                )}
              </div>

              {canManage && (
                <div className="space-y-3">
                  <div className="flex flex-wrap gap-2">
                    <Button variant="secondary" loading={busy === "plan"} onClick={async () => { setBusy("plan"); const res = await planDeletionAction(orgId, view.id); setBusy(null); if (!res.ok) return void toast.error(res.error); setPlan(res.data); }}>Show the deletion plan</Button>
                    <Button variant="danger" disabled={!ready} onClick={() => setDeleting(true)}><Trash2 className="size-4" aria-hidden /> Delete the data permanently…</Button>
                    <Button variant="ghost" loading={busy === "cancel"} onClick={() => act("cancel", () => cancelOffboardingAgencyAction(orgId, "Restored at the client's request."), "Cancelled. The owner re-enables automation and re-invites staff.")}>Bring the workspace back</Button>
                  </div>
                  {plan && (
                    <div className="rounded-2xl border border-line p-4">
                      <p className="text-[13.5px] font-semibold">Would remove {plan.totalPurgeRows.toLocaleString("en-US")} rows across {plan.purge.length} tables and {plan.files} stored files</p>
                      <p className="mt-1 text-[12.5px] text-muted">Kept as financial and audit records: {plan.retain.map((r) => `${r.table.replace(/_/g, " ")} (${r.rows})`).join(", ") || "none"}.</p>
                      <ul className="mt-3 grid gap-x-6 gap-y-1 text-[12.5px] sm:grid-cols-2">{plan.purge.map((p) => <li key={p.table} className="flex justify-between gap-3"><span className="truncate text-muted">{p.table.replace(/_/g, " ")}</span><span className="tabular-nums">{p.rows.toLocaleString("en-US")}</span></li>)}</ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {view && view.timeline.length > 0 && (
            <details className="rounded-xl border border-line px-4 py-3 text-[13px]">
              <summary className="cursor-pointer font-medium">History ({view.timeline.length})</summary>
              <ol className="mt-3 space-y-2 border-l border-line pl-4">{view.timeline.map((t, i) => <li key={i}><span className="text-muted">{formatDateTime(t.at, "UTC")}</span> · {t.detail ?? t.kind}</li>)}</ol>
            </details>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={shutting}
        onOpenChange={setShutting}
        size="md"
        title={`Shut down ${orgName}?`}
        description="This stops all automation and messaging for the client and removes their staff's access. The owner keeps access to download their data. Every step is recorded."
        footer={<><Button variant="ghost" onClick={() => setShutting(false)}>Not yet</Button><Button variant="danger" loading={busy === "shutdown"} onClick={() => act("shutdown", () => shutdownAction(orgId, view!.id, websitePlan, retentionDays), "Workspace shut down", () => setShutting(false))}>Shut down</Button></>}
      >
        <div className="space-y-4">
          <Field label="Their website" htmlFor="off-site" hint="Their own domains stay theirs either way.">
            <Select id="off-site" value={websitePlan} onChange={(e) => setWebsitePlan(e.target.value as typeof websitePlan)}>
              <option value="keep_until_deletion">Keep it live until the data is deleted</option>
              <option value="unpublish_now">Take it down now</option>
            </Select>
          </Field>
          <Field label="Keep their data for" htmlFor="off-days" hint="A starting point to confirm with your own legal advice. Never shorter than 30 days.">
            <Select id="off-days" value={retentionDays} onChange={(e) => setRetentionDays(Number(e.target.value))}>{[30, 60, 90, 180, 365].map((d) => <option key={d} value={d}>{d} days</option>)}</Select>
          </Field>
        </div>
      </Dialog>

      <Dialog
        open={deleting}
        onOpenChange={setDeleting}
        size="md"
        title="Delete this client's data permanently?"
        description="This cannot be undone. Payments, the credit ledger, usage, fees and the audit trail are kept. Everything else, including customers, conversations, files and the website, is deleted."
        footer={<><Button variant="ghost" onClick={() => setDeleting(false)}>Cancel</Button><Button variant="danger" loading={busy === "delete"} disabled={confirmName.trim() !== orgName.trim() || (!view?.exportDownloadedAt && waive.trim().length < 10)} onClick={() => act("delete", () => executeDeletionAction(orgId, view!.id, confirmName, waive || undefined), "Deleted", () => { setDeleting(false); setPlan(null); })}>Delete permanently</Button></>}
      >
        <div className="space-y-4">
          <p className="flex items-start gap-2 rounded-xl bg-danger-soft px-3.5 py-3 text-[13px] leading-relaxed text-danger-ink"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />Take a backup first, and make sure it can be restored.</p>
          {!view?.exportDownloadedAt && (
            <Field label="The client hasn't downloaded their data. Why is that all right?" htmlFor="del-waive"><Textarea id="del-waive" rows={2} maxLength={200} value={waive} onChange={(e) => setWaive(e.target.value)} /></Field>
          )}
          <Field label={`Type "${orgName}" to confirm`} htmlFor="del-name"><Input id="del-name" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} autoComplete="off" /></Field>
        </div>
      </Dialog>
    </div>
  );
}
