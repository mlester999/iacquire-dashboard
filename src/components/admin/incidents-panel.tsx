"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, Building2, CheckCircle2, ChevronDown, Clock3, Eye, Layers, Lightbulb, Lock, Repeat, ShieldCheck, ShieldQuestion } from "lucide-react";
import { acknowledgeIncidentAction, addIncidentNoteAction, incidentTimelineAction, resolveIncidentAction } from "@/app/(admin)/admin/incident-actions";
import { Button } from "@/components/ui/button";
import { Card, EmptyState, Skeleton, Textarea } from "@/components/ui/primitives";
import { InfoChip, RelativeTime, StatusPill, type StatusTone } from "@/components/ui/status";
import { Dialog } from "@/components/ui/overlays";
import { cn, formatDateTime, relativeTime, sentenceCase } from "@/lib/utils";
import type { IncidentEventRow, IncidentRow } from "@/server/ops/incidents";

const SEVERITY: Record<IncidentRow["severity"], { label: string; tone: StatusTone; icon: string; accent: string }> = {
  critical: { label: "Critical", tone: "danger", icon: "bg-danger-soft text-danger-ink", accent: "bg-danger" },
  warning: { label: "Warning", tone: "warning", icon: "bg-warning-soft text-warning-ink", accent: "bg-warning" },
  info: { label: "Notice", tone: "primary", icon: "bg-primary-soft text-primary-ink", accent: "bg-primary" },
};
const EVENT_TONE: Record<string, string> = { recovered: "bg-success", recurred: "bg-danger", escalated: "bg-danger", acknowledged: "bg-primary", notified: "bg-violet", resolved_manually: "bg-warning" };

/** Recovery evidence is recorded as "... ran at 2026-10-10 23:57 UTC ..."; show it in the viewer's time zone instead of as a raw stamp. */
function readableEvidence(text: string | null, timeZone: string) {
  if (!text) return "";
  return text.replace(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::\d{2})?\s*(?:UTC|Z)/g, (_m, d: string, t: string) => formatDateTime(`${d}T${t}:00Z`, timeZone));
}
const EVENT_LABEL: Record<string, string> = {
  detected: "Detected", recurred: "Still failing", escalated: "Escalated", acknowledged: "Acknowledged", note: "Note", action: "Action", notified: "People notified", recovered: "Recovered (verified)", resolved_manually: "Closed by hand",
};

function Timeline({ id, timeZone }: { id: string; timeZone: string }) {
  const [events, setEvents] = React.useState<IncidentEventRow[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    let live = true;
    void incidentTimelineAction(id).then((res) => {
      if (!live) return;
      if (res.ok) setEvents(res.data);
      else setError(res.error);
    });
    return () => { live = false; };
  }, [id]);
  if (error) return <StatusPill tone="danger" icon={<AlertTriangle className="size-3" aria-hidden />}>{error}</StatusPill>;
  if (!events) return <div role="status" className="space-y-2" aria-busy="true" aria-label="Loading timeline"><Skeleton className="h-4 w-48" /><Skeleton className="h-4 w-64" /><Skeleton className="h-4 w-40" /></div>;
  return (
    <ol className="ml-1 space-y-3 border-l border-line-strong pl-5">
      {events.map((e) => (
        <li key={e.id} className="relative text-[13px] leading-relaxed">
          <span className={cn("absolute -left-[26px] top-1.5 size-2.5 rounded-full ring-4 ring-surface-2", EVENT_TONE[e.kind] ?? "bg-faint")} aria-hidden />
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-semibold text-ink">{EVENT_LABEL[e.kind] ?? sentenceCase(e.kind)}</span>
            <time dateTime={new Date(e.at).toISOString()} className="text-muted">{formatDateTime(e.at, timeZone)}</time>
            {e.actor && <InfoChip>{e.actor}</InfoChip>}
          </div>
          {e.detail && <p className="mt-0.5 break-words text-muted">{e.detail}</p>}
        </li>
      ))}
    </ol>
  );
}

function IncidentCard({ incident: i, timeZone, canManage }: { incident: IncidentRow; timeZone: string; canManage: boolean }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [resolving, setResolving] = React.useState(false);
  const sev = SEVERITY[i.severity];
  const resolved = i.status === "resolved";

  const act = async (fn: () => Promise<{ ok: boolean; error?: string }>, done: string) => {
    setBusy(true);
    const res = await fn();
    setBusy(false);
    if (!res.ok) return void toast.error(res.error ?? "That didn't work.");
    toast.success(done);
    setNote("");
    setResolving(false);
    router.refresh();
  };

  return (
    <li className="relative">
      {!resolved && <span aria-hidden className={cn("absolute inset-y-0 left-0 w-0.5", sev.accent)} />}
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-3 p-4 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:p-5">
        <span className={cn("mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl", resolved ? "bg-success-soft text-success-ink" : sev.icon)}>
          {resolved ? <CheckCircle2 className="size-4" aria-hidden /> : <AlertTriangle className="size-4" aria-hidden />}
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusPill tone={resolved ? "success" : sev.tone}>{resolved ? "Resolved" : sev.label}</StatusPill>
            {!resolved && i.status === "acknowledged" && <StatusPill tone="primary" icon={<CheckCircle2 className="size-3" aria-hidden />}>Acknowledged</StatusPill>}
            {i.clientVisible && !resolved && <StatusPill tone="violet" icon={<Eye className="size-3" aria-hidden />}>Shown to client</StatusPill>}
            <InfoChip icon={<Layers />}>{i.sourceLabel}</InfoChip>
            {i.orgName && <InfoChip icon={<Building2 />}>{i.orgName}</InfoChip>}
          </div>
          <p className="mt-2.5 break-words text-[14.5px] font-semibold leading-snug">{i.title}</p>
          {i.detail && <p className="mt-1 break-words text-[14px] leading-relaxed text-muted">{i.detail}</p>}
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <InfoChip icon={<Clock3 />}>Detected {relativeTime(i.detectedAt)}</InfoChip>
            {i.occurrences > 1 && !resolved && <InfoChip icon={<Repeat />}>Seen in {i.occurrences} checks</InfoChip>}
            {!resolved && <InfoChip><RelativeTime value={i.lastSeenAt} prefix="Last seen " /></InfoChip>}
          </div>
          {resolved && (
            <div className={cn("mt-3 flex items-start gap-2.5 rounded-xl border p-3 text-[13px] leading-relaxed", i.resolution === "verified_recovery" ? "border-success/20 bg-success-soft/60" : "border-warning/25 bg-warning-soft/60")}>
              {i.resolution === "verified_recovery" ? <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success-ink" aria-hidden /> : <ShieldQuestion className="mt-0.5 size-4 shrink-0 text-warning-ink" aria-hidden />}
              <p>
                <span className="font-semibold text-ink">{i.resolution === "verified_recovery" ? "Recovery verified by a health check. " : "Closed by hand. Nothing verified that it recovered. "}</span>
                <span className="text-ink-2">{readableEvidence(i.recoveryEvidence, timeZone)}</span>
              </p>
            </div>
          )}
          {!resolved && i.safeActions.length > 0 && (
            <div className="mt-3 rounded-xl border border-line bg-surface-2 p-3.5">
              <p className="flex items-center gap-1.5 text-[12px] font-semibold text-ink-2"><Lock className="size-3.5 text-muted" aria-hidden />Held back while this lasts</p>
              <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-[13px] leading-relaxed text-muted marker:text-faint">{i.safeActions.map((a) => <li key={a}>{a}</li>)}</ul>
            </div>
          )}
          {!resolved && i.recoveryGuidance && (
            <div className="mt-3 flex items-start gap-2.5 rounded-xl border border-primary/15 bg-primary-soft/50 p-3.5 text-[13px] leading-relaxed">
              <Lightbulb className="mt-0.5 size-4 shrink-0 text-primary-ink" aria-hidden />
              <p><span className="font-semibold text-primary-ink">What to do: </span><span className="text-ink-2">{i.recoveryGuidance}</span></p>
            </div>
          )}
        </div>
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="col-start-2 inline-flex h-11 items-center gap-1 justify-self-start rounded-lg border border-line bg-surface px-3 sm:col-start-3 sm:row-start-1 sm:justify-self-end sm:px-2.5 text-[13px] font-medium text-ink-2 shadow-soft transition hover:border-line-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:h-8">
          Timeline <ChevronDown className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
        </button>
      </div>
      {open && (
        <div className="space-y-4 border-t border-line bg-surface-2/50 px-4 py-4 sm:px-5">
          <Timeline id={i.id} timeZone={timeZone} />
          {canManage && !resolved && (
            <div className="space-y-3">
              <label htmlFor={`note-${i.id}`} className="block text-[13px] font-medium text-ink-2">Add a note for the team</label>
              <Textarea id={`note-${i.id}`} rows={2} maxLength={600} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What you found or what you tried" />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" disabled={!note.trim()} loading={busy} onClick={() => act(() => addIncidentNoteAction(i.id, note), "Note added.")}>Add note</Button>
                {i.status === "open" && <Button size="sm" variant="secondary" loading={busy} onClick={() => act(() => acknowledgeIncidentAction(i.id), "Acknowledged.")}>Acknowledge</Button>}
                <Button size="sm" variant="outline" onClick={() => setResolving(true)}>Close by hand…</Button>
              </div>
            </div>
          )}
        </div>
      )}
      <Dialog
        open={resolving}
        onOpenChange={setResolving}
        size="sm"
        title="Close this incident by hand?"
        description="Use this when you have fixed it and confirmed it yourself. It is recorded as closed by hand, not as a verified recovery. If the problem is still there, the next check opens it again."
        footer={
          <>
            <Button variant="ghost" onClick={() => setResolving(false)}>Cancel</Button>
            <Button variant="brand" loading={busy} disabled={note.trim().length < 3} onClick={() => act(() => resolveIncidentAction(i.id, note), "Closed.")}>Close incident</Button>
          </>
        }
      >
        <label htmlFor={`resolve-${i.id}`} className="mb-1.5 block text-[14px] font-medium text-ink-2">What was done?</label>
        <Textarea id={`resolve-${i.id}`} rows={3} maxLength={400} value={note} onChange={(e) => setNote(e.target.value)} />
      </Dialog>
    </li>
  );
}

export function IncidentsPanel({ incidents, timeZone, canManage }: { incidents: IncidentRow[]; timeZone: string; canManage: boolean }) {
  if (!incidents.length) {
    return (
      <Card>
        <EmptyState compact icon={<ShieldCheck className="size-5" />} title="No incidents in the last seven days" description="Checks run every time the scheduler does. An empty list means no check found a problem; it isn't a guarantee of uninterrupted service." />
      </Card>
    );
  }
  return (
    <Card className="overflow-hidden">
      <ul className="divide-y divide-line">
        {incidents.map((i) => <IncidentCard key={i.id} incident={i} timeZone={timeZone} canManage={canManage} />)}
      </ul>
    </Card>
  );
}
