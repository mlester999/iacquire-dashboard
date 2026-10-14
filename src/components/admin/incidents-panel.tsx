"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, ChevronDown, ShieldCheck, ShieldQuestion } from "lucide-react";
import { acknowledgeIncidentAction, addIncidentNoteAction, incidentTimelineAction, resolveIncidentAction } from "@/app/(admin)/admin/incident-actions";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, Textarea } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/overlays";
import { formatDateTime, relativeTime } from "@/lib/utils";
import type { IncidentEventRow, IncidentRow } from "@/server/ops/incidents";

const SEVERITY = { critical: { label: "Critical", tone: "danger" }, warning: { label: "Warning", tone: "warning" }, info: { label: "Notice", tone: "neutral" } } as const;
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
  if (error) return <p className="text-[12.5px] text-danger-ink" role="alert">{error}</p>;
  if (!events) return <p className="text-[12.5px] text-muted">Loading timeline…</p>;
  return (
    <ol className="space-y-2 border-l border-line pl-4">
      {events.map((e) => (
        <li key={e.id} className="relative text-[12.5px] leading-relaxed">
          <span className="absolute -left-[21px] top-1.5 size-2 rounded-full bg-line-strong" aria-hidden />
          <span className="font-medium text-ink">{EVENT_LABEL[e.kind] ?? e.kind}</span>
          <span className="text-muted"> · {formatDateTime(e.at, timeZone)}{e.actor ? ` · ${e.actor}` : ""}</span>
          {e.detail && <span className="block text-muted">{e.detail}</span>}
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
    <li>
      <div className="flex flex-wrap items-start gap-3 p-4 sm:p-5">
        <span className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl ${resolved ? "bg-success-soft text-success-ink" : i.severity === "critical" ? "bg-danger-soft text-danger-ink" : "bg-warning-soft text-warning-ink"}`}>
          {resolved ? <CheckCircle2 className="size-4" aria-hidden /> : <AlertTriangle className="size-4" aria-hidden />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={resolved ? "success" : sev.tone}>{resolved ? "Resolved" : sev.label}</Badge>
            <Badge tone="outline">{i.sourceLabel}</Badge>
            {i.orgName && <Badge tone="neutral">{i.orgName}</Badge>}
            {!resolved && i.status === "acknowledged" && <Badge tone="primary">Acknowledged</Badge>}
            {i.clientVisible && !resolved && <Badge tone="violet">Shown to client</Badge>}
          </div>
          <p className="mt-2 break-words text-[14.5px] font-semibold leading-snug">{i.title}</p>
          {i.detail && <p className="mt-1 break-words text-[13px] leading-relaxed text-muted">{i.detail}</p>}
          <p className="mt-1.5 text-[12px] text-muted">
            Detected {relativeTime(i.detectedAt)}
            {i.occurrences > 1 && !resolved ? ` · seen in ${i.occurrences} checks` : ""}
            {!resolved ? ` · last seen ${relativeTime(i.lastSeenAt)}` : ""}
          </p>
          {resolved && (
            <p className="mt-2 flex items-start gap-1.5 text-[12.5px] leading-relaxed">
              {i.resolution === "verified_recovery" ? <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-success-ink" aria-hidden /> : <ShieldQuestion className="mt-0.5 size-3.5 shrink-0 text-warning-ink" aria-hidden />}
              <span>
                <span className="font-medium">{i.resolution === "verified_recovery" ? "Recovery verified by a health check. " : "Closed by hand. Nothing verified that it recovered. "}</span>
                <span className="text-muted">{i.recoveryEvidence}</span>
              </span>
            </p>
          )}
          {!resolved && i.safeActions.length > 0 && (
            <div className="mt-3 rounded-xl border border-line bg-surface-2 p-3">
              <p className="text-[12px] font-semibold text-ink-2">Held back while this lasts</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[12.5px] leading-relaxed text-muted">{i.safeActions.map((a) => <li key={a}>{a}</li>)}</ul>
            </div>
          )}
          {!resolved && i.recoveryGuidance && <p className="mt-3 text-[12.5px] leading-relaxed"><span className="font-medium">What to do: </span><span className="text-muted">{i.recoveryGuidance}</span></p>}
        </div>
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="inline-flex h-11 items-center gap-1 rounded-lg px-2 text-[12.5px] font-medium text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:h-8">
          Timeline <ChevronDown className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
        </button>
      </div>
      {open && (
        <div className="space-y-4 border-t border-line bg-surface-2/50 px-4 py-4 sm:px-5">
          <Timeline id={i.id} timeZone={timeZone} />
          {canManage && !resolved && (
            <div className="space-y-3">
              <label htmlFor={`note-${i.id}`} className="block text-[12.5px] font-medium text-ink-2">Add a note for the team</label>
              <Textarea id={`note-${i.id}`} rows={2} maxLength={600} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What you found or what you tried" />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" disabled={!note.trim()} loading={busy} onClick={() => act(() => addIncidentNoteAction(i.id, note), "Note added.")}>Add note</Button>
                {i.status === "open" && <Button size="sm" variant="secondary" loading={busy} onClick={() => act(() => acknowledgeIncidentAction(i.id), "Acknowledged.")}>Acknowledge</Button>}
                <Button size="sm" variant="ghost" onClick={() => setResolving(true)}>Close by hand…</Button>
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
        <label htmlFor={`resolve-${i.id}`} className="mb-1.5 block text-[13px] font-medium text-ink-2">What was done?</label>
        <Textarea id={`resolve-${i.id}`} rows={3} maxLength={400} value={note} onChange={(e) => setNote(e.target.value)} />
      </Dialog>
    </li>
  );
}

export function IncidentsPanel({ incidents, timeZone, canManage }: { incidents: IncidentRow[]; timeZone: string; canManage: boolean }) {
  if (!incidents.length) {
    return (
      <Card>
        <EmptyState compact icon={<ShieldCheck />} title="No incidents in the last seven days" description="Checks run every time the scheduler does. An empty list means no check found a problem; it isn't a guarantee of uninterrupted service." />
      </Card>
    );
  }
  return (
    <Card>
      <ul className="divide-y divide-line">
        {incidents.map((i) => <IncidentCard key={i.id} incident={i} timeZone={timeZone} canManage={canManage} />)}
      </ul>
    </Card>
  );
}
