"use client";

import * as React from "react";
import { AlertTriangle, ArrowRightLeft, CheckCircle2, Clock, Eye, Loader2, RotateCcw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, Field, ProgressBar, Select } from "@/components/ui/primitives";
import { cn, formatTime } from "@/lib/utils";
import {
  advanceGhlMigrationAction, cancelGhlStepAction, checkGhlStepAgainAction, ghlStepDetailAction, previewGhlMigrationAction, rollbackGhlStepAction, startGhlDryRunAction,
  startGhlImportAction, startGhlStepAction,
} from "@/app/actions/crm-ghl-migration";
import { ConfirmDialog, useCrmAction } from "@/components/crm/ui";
import { GHL_ENTITY_LABELS, GHL_MIGRATION_ENTITIES, GHL_NOT_MIGRATED, GHL_PREREQUISITES, IMPORT_FLAG_LABELS, type GhlMigrationEntity } from "@/lib/crm/ghl-migration";
import type { GhlMigrationPlan, GhlMigrationState } from "@/server/crm/ghl-migration";
import type { ImportJobView, ImportProblem } from "@/server/crm/imports";
import type { CrmScope } from "@/server/crm/page";
import { RelativeTime } from "@/components/crm/relative-time";

// Settings → Imports → "Migrate from GoHighLevel": preview what the client's own GoHighLevel location holds, run the dry run of every step,
// import step by step (owner only, once iAcquire owns that part of the CRM), watch progress, compare source and destination, and undo.
// Every state and count comes from the server; this component only shows them and asks for decisions.

const RUNNING = ["fetching", "validating", "importing", "rolling_back"];
const STATUS: Record<string, { label: string; tone: "neutral" | "primary" | "success" | "warning" | "danger" }> = {
  fetching: { label: "Reading GoHighLevel", tone: "primary" },
  validating: { label: "Dry run", tone: "primary" },
  validated: { label: "Dry run done", tone: "primary" },
  importing: { label: "Importing", tone: "primary" },
  completed: { label: "Imported", tone: "success" },
  failed: { label: "Stopped", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  rolling_back: { label: "Undoing", tone: "warning" },
  rolled_back: { label: "Undone", tone: "neutral" },
};
const n = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v.toLocaleString("en-US"));

export function GhlMigrationPanel({ scope, initial }: { scope: CrmScope; initial: GhlMigrationState }) {
  const { run, busy } = useCrmAction();
  const [state, setState] = React.useState(initial);
  const [plan, setPlan] = React.useState<GhlMigrationPlan | null>(null);
  const [onExisting, setOnExisting] = React.useState<"update" | "review" | "skip">("update");
  const [undo, setUndo] = React.useState<ImportJobView | null>(null);
  const [detail, setDetail] = React.useState<{ job: ImportJobView; problems: ImportProblem[] } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  // Fresh server data (after a refresh) replaces what this panel holds; adjusting state while rendering, as React recommends.
  const [seen, setSeen] = React.useState(initial);
  if (seen !== initial) {
    setSeen(initial);
    setState(initial);
  }

  const jobs = GHL_MIGRATION_ENTITIES.map((e) => state.jobs[e]).filter((j): j is ImportJobView => !!j);

  // Polls running steps forward (and an earlier run being undone). A step waiting out a GoHighLevel rate limit is asked again only after the wait.
  React.useEffect(() => {
    const running = [
      ...GHL_MIGRATION_ENTITIES.map((e) => state.jobs[e]).filter((j): j is ImportJobView => !!j && RUNNING.includes(j.status)),
      ...GHL_MIGRATION_ENTITIES.map((e) => state.undo[e]).filter((j): j is ImportJobView => !!j && j.status === "rolling_back" && j.id !== state.jobs[j.entity as GhlMigrationEntity]?.id),
    ];
    if (!running.length || !state.can.dryRun) return;
    let live = true;
    const waits = running.map((j) => (j.fetch?.waitingUntil ? new Date(j.fetch.waitingUntil).getTime() - Date.now() : 0));
    const delay = Math.min(15_000, Math.max(800, Math.min(...waits.map((w) => (w > 0 ? w + 300 : 800)))));
    const t = setTimeout(async () => {
      const r = await advanceGhlMigrationAction(scope.orgId, running.map((j) => j.id));
      if (!live) return;
      if (r.ok) setState(r.data);
      else setError(r.error);
    }, delay);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [state, scope.orgId]);

  async function preview() {
    setError(null);
    const r = await run("preview", () => previewGhlMigrationAction(scope.orgId));
    if (r) setPlan(r as GhlMigrationPlan);
  }

  async function openDetail(job: ImportJobView) {
    const r = await ghlStepDetailAction(scope.orgId, job.id);
    if (r.ok) setDetail({ job: r.data, problems: r.data.problems });
    else setError(r.error);
  }

  const anyJob = jobs.length > 0;
  const remaining = state.remaining;
  const nativeOwnsAll = GHL_MIGRATION_ENTITIES.every((e) => state.owners[e] === "native");

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-[15px] font-semibold text-ink"><ArrowRightLeft className="size-4 text-muted" aria-hidden />Migrate from GoHighLevel</h3>
          <p className="mt-1 max-w-2xl text-[14px] text-muted">
            Brings your contacts (with their tags and custom field values), companies, pipelines with their stages, and opportunities from your own GoHighLevel location into iAcquire CRM.
            iAcquire only reads GoHighLevel: it sends GET requests to GoHighLevel&rsquo;s official API and never changes, deletes or messages anything there.
          </p>
        </div>
        {state.connected ? <Badge tone="success"><ShieldCheck className="size-3.5" aria-hidden />Read-only connection{state.locationName ? ` · ${state.locationName}` : ""}</Badge> : <Badge>Not connected</Badge>}
      </div>

      {!state.connected && <p className="mt-4 rounded-xl border border-dashed border-line px-3 py-3 text-[14px] text-ink-2">{state.reason}</p>}

      {state.connected && (
        <div className="mt-4 space-y-5">
          <ol className="grid gap-2 text-[13px] text-ink-2 sm:grid-cols-4">
            {["Preview what's there", "Dry run every step (nothing is imported)", "Import step by step (the owner)", "Compare, and undo if needed"].map((t, i) => (
              <li key={t} className="flex items-start gap-2 rounded-xl border border-line bg-surface-2/40 px-3 py-2"><span className="font-semibold tabular-nums text-ink">{i + 1}</span>{t}</li>
            ))}
          </ol>

          <div className="flex flex-wrap items-end gap-3">
            {state.can.preview && !state.switchActive && <Button variant="secondary" loading={busy("preview")} onClick={preview}><Eye className="size-4" />Preview GoHighLevel</Button>}
            {state.can.dryRun && !state.switchActive && (
              <>
                <Field label="When a record already exists here" htmlFor="ghl-existing" className="min-w-[240px]">
                  <Select id="ghl-existing" value={onExisting} onChange={(e) => setOnExisting(e.target.value as typeof onExisting)}>
                    <option value="update">Link it and fill in empty details only</option>
                    <option value="review">Hold it for me to review</option>
                    <option value="skip">Leave it alone (not linked)</option>
                  </Select>
                </Field>
                {remaining.length > 0 && (
                  <Button loading={busy("dryrun")} onClick={async () => { const r = await run("dryrun", () => startGhlDryRunAction(scope.orgId, onExisting), "Dry run started. Nothing is imported until you start each step."); if (r) setState(r as GhlMigrationState); }}>
                    {anyJob ? `Dry run the remaining ${remaining.length === 1 ? "step" : `${remaining.length} steps`}` : "Start the dry run"}
                  </Button>
                )}
              </>
            )}
          </div>
          {state.can.dryRun && !state.switchActive && anyJob && remaining.length > 0 && remaining.length < GHL_MIGRATION_ENTITIES.length && (
            <p className="text-[13px] text-muted">Remaining: {remaining.map((e) => GHL_ENTITY_LABELS[e].many.toLowerCase()).join(", ")}. Steps already imported keep their run (and its Undo); use Run this step again to read one again.</p>
          )}
          {!state.can.dryRun && <p className="text-[13px] text-muted">{state.can.preview ? "You can preview what your GoHighLevel location holds. " : ""}Owners and managers run the dry run, and only the owner imports.</p>}
          {state.switchActive && <p className="flex items-center gap-2 rounded-xl bg-warning-soft px-3 py-2 text-[14px] text-warning-ink"><Clock className="size-4" aria-hidden />A CRM provider switch is in progress. Manage migration steps in Settings → CRM Provider; this panel is read-only until the switch finishes.{state.switching ? " Automations that could act twice are paused." : ""}</p>}
          {!nativeOwnsAll && (
            <p className="rounded-xl bg-surface-2/60 px-3 py-2 text-[13px] text-ink-2">
              GoHighLevel still owns {GHL_MIGRATION_ENTITIES.filter((e) => state.owners[e] === "ghl").map((e) => GHL_ENTITY_LABELS[e].many.toLowerCase()).join(", ")} here. You can preview and dry run now; those steps import once that part of the CRM moves to iAcquire (Settings → CRM provider), so both systems never own the same records.
            </p>
          )}

          {plan && <PlanTable plan={plan} timezone={scope.timezone} />}

          {anyJob && (
            <section aria-label="Migration steps">
              <h4 className="mb-2 text-[14px] font-semibold text-ink">Steps, in order</h4>
              <ul className="divide-y divide-line rounded-2xl border border-line">
                {GHL_MIGRATION_ENTITIES.map((entity, i) => (
                  <StepRow
                    key={entity}
                    index={i + 1}
                    entity={entity}
                    job={state.jobs[entity]}
                    state={state}
                    timezone={scope.timezone}
                    busy={busy}
                    onImport={async (job) => {
                      const r = await run("import:" + job.id, () => startGhlImportAction(scope.orgId, job.id), (d) => (d.recheck ? "The steps before this one were imported after its dry run, so it's being checked again. Start the import when it's done." : "Import started."));
                      if (r) setState((s) => ({ ...s, jobs: { ...s.jobs, [entity]: { ...job, status: r.recheck ? "validating" : "importing", progress: null } } }));
                    }}
                    onAgain={async (job) => { if (await run("again:" + job.id, () => checkGhlStepAgainAction(scope.orgId, job.id), "Checking this step again.")) setState((s) => ({ ...s, jobs: { ...s.jobs, [entity]: { ...job, status: "validating", progress: null } } })); }}
                    onRestart={async () => { const r = await run("restart:" + entity, () => startGhlStepAction(scope.orgId, entity, onExisting), "Reading GoHighLevel for this step."); if (r) setState(r as GhlMigrationState); }}
                    onCancel={async (job) => { if (await run("cancel:" + job.id, () => cancelGhlStepAction(scope.orgId, job.id), job.status === "importing" ? "Import stopped. What was imported stays and can be undone." : "Step cancelled.")) setState((s) => ({ ...s, jobs: { ...s.jobs, [entity]: { ...job, status: "cancelled", progress: null } } })); }}
                    onUndo={(job) => setUndo(job)}
                    onDetail={openDetail}
                  />
                ))}
              </ul>
            </section>
          )}

          {state.comparison && <ComparisonTable comparison={state.comparison} />}

          <details className="rounded-xl border border-line">
            <summary className="cursor-pointer px-3 py-2 text-[14px] font-medium text-ink">What doesn&rsquo;t come across</summary>
            <ul className="space-y-1.5 border-t border-line px-3 py-2 text-[13px]">
              {GHL_NOT_MIGRATED.map((x) => <li key={x.what}><span className="font-medium text-ink">{x.what}.</span> <span className="text-muted">{x.why}</span></li>)}
            </ul>
          </details>
        </div>
      )}

      {error && <p role="alert" className="mt-3 flex items-center gap-2 text-[14px] text-danger-ink"><AlertTriangle className="size-4 shrink-0" />{error}</p>}

      <ConfirmDialog
        open={!!undo}
        onOpenChange={(o) => !o && setUndo(null)}
        title={undo ? `Undo the ${GHL_ENTITY_LABELS[undo.entity as GhlMigrationEntity]?.many.toLowerCase() ?? "migration"} step?` : "Undo this step?"}
        confirmLabel="Undo step"
        danger
        loading={busy("undo")}
        description="Records this step created are archived or removed, and links it made to records that were already here are removed. Anything someone changed after the import is kept and listed for review. Opt-outs from GoHighLevel's do-not-disturb stay. GoHighLevel itself is not touched."
        onConfirm={async () => {
          if (!undo) return;
          if (await run("undo", () => rollbackGhlStepAction(scope.orgId, undo.id), "Undoing the step.")) {
            const e = undo.entity as GhlMigrationEntity;
            const rolling: ImportJobView = { ...undo, status: "rolling_back", progress: null };
            setState((s) => (s.jobs[e]?.id === undo.id ? { ...s, jobs: { ...s.jobs, [e]: rolling }, undo: { ...s.undo, [e]: rolling } } : { ...s, undo: { ...s.undo, [e]: rolling } }));
            setUndo(null);
          }
        }}
      />
      <ConfirmDialog
        open={!!detail}
        onOpenChange={(o) => !o && setDetail(null)}
        title={detail ? `${GHL_ENTITY_LABELS[detail.job.entity as GhlMigrationEntity]?.many ?? "Step"}: rows to look at` : "Rows to look at"}
        confirmLabel="Close"
        onConfirm={() => setDetail(null)}
      >
        {detail && (detail.problems.length ? (
          <ul className="max-h-80 divide-y divide-line overflow-y-auto rounded-xl border border-line text-[13px]">
            {detail.problems.map((p) => (
              <li key={p.row} className="px-3 py-2">
                <span className="font-medium text-ink">{Object.values(p.data).filter((v) => v !== p.data.ghl_id).slice(0, 2).join(" · ") || `Row ${p.row}`}</span>
                <span className="ml-2 text-muted">{p.status === "needs_review" ? "Held for review" : p.status === "failed" || p.status === "invalid" ? "Not imported" : p.status === "duplicate" ? "Repeated" : ""}</span>
                {p.errors.length > 0 && <span className="block text-danger-ink">{p.errors.join(" ")}</span>}
                {p.flags.length > 0 && <span className="block text-muted">{p.flags.map((f) => IMPORT_FLAG_LABELS[f] ?? f).join(" · ")}</span>}
              </li>
            ))}
          </ul>
        ) : <p className="text-[14px] text-muted">Nothing to look at in this step.</p>)}
      </ConfirmDialog>
    </Card>
  );
}

/** Live progress of a running dry run, import or undo, from the server's row counts (null until the first poll brings them). */
function liveProgress(job: ImportJobView | null): number | null {
  return job?.progress && job.progress.total > 0 ? Math.min(100, Math.round((job.progress.done / job.progress.total) * 100)) : null;
}

/** Why a reading step is waiting, in honest words: GoHighLevel asked, iAcquire is pacing itself, or GoHighLevel had a passing error. */
function waitLine(job: ImportJobView, timezone: string): string | null {
  const f = job.fetch;
  if (!f?.waitingUntil) return null;
  const t = formatTime(f.waitingUntil, timezone);
  switch (f.waitReason) {
    case "retry_after": return `GoHighLevel asked us to wait until ${t}`;
    case "burst": return `pausing until ${t} to stay under GoHighLevel's per-10-second limit`;
    case "daily": return `saving the rest of today's GoHighLevel allowance; resuming at ${t}`;
    case "error": return `GoHighLevel had a passing error${f.lastError ? ` (${f.lastError.replace(/\.$/, "")})` : ""}; trying again at ${t}${f.transientErrors > 1 ? ` (${f.transientErrors} in a row)` : ""}`;
    default: return `waiting until ${t}`;
  }
}

/** What a screen reader hears for a step: its status and, once a phase ends, its result. Never the counters that change on every poll. */
function announcement(entity: GhlMigrationEntity, job: ImportJobView | null): string {
  if (!job) return "";
  const s = job.summary ?? {};
  const label = STATUS[job.status]?.label ?? job.status;
  const result = job.status === "validated" ? `: ${n(s.create)} to create, ${n(s.update)} to link, ${n(s.review)} held for review`
    : job.status === "completed" ? `: ${n(s.created)} created, ${n(s.updated)} linked, ${n(s.failed)} failed`
      : job.status === "rolled_back" ? `: ${n(s.rolledBack)} removed or unlinked`
        : job.status === "failed" ? `: ${job.error ?? "stopped"}` : "";
  return `${GHL_ENTITY_LABELS[entity].many}: ${label}${result}`;
}

function Progress({ job }: { job: ImportJobView }) {
  const live = liveProgress(job);
  if (live === null) return <p className="text-[12px] text-muted">Starting…</p>;
  return (
    <div className="space-y-1">
      <ProgressBar value={live} label="Progress" />
      <p className="text-[12px] tabular-nums text-muted">{n(job.progress?.done)} of {n(job.progress?.total)}</p>
    </div>
  );
}

function StepRow({ index, entity, job, state, timezone, busy, onImport, onAgain, onRestart, onCancel, onUndo, onDetail }: {
  index: number; entity: GhlMigrationEntity; job: ImportJobView | null; state: GhlMigrationState; timezone: string; busy: (k: string) => boolean;
  onImport: (j: ImportJobView) => void; onAgain: (j: ImportJobView) => void; onRestart: () => void; onCancel: (j: ImportJobView) => void; onUndo: (j: ImportJobView) => void; onDetail: (j: ImportJobView) => void;
}) {
  const s = job?.summary ?? {};
  const st = job ? STATUS[job.status] ?? { label: job.status, tone: "neutral" as const } : null;
  const prereqs = GHL_PREREQUISITES[entity].filter((p) => state.jobs[p]?.status !== "completed");
  const owner = state.owners[entity];
  const problems = (s.invalid ?? 0) + (s.duplicateInFile ?? 0);
  // The run Undo acts on: this run, or an earlier one when this one has nothing to undo (runs of a step are undone newest first).
  const undoJob = state.undo[entity];
  const earlier = undoJob && job && undoJob.id !== job.id ? undoJob : null;
  const wait = job ? waitLine(job, timezone) : null;
  return (
    <li className="space-y-2 px-4 py-3 text-[14px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex size-6 items-center justify-center rounded-full bg-surface-2 text-[12px] font-semibold tabular-nums text-ink">{index}</span>
        <span className="min-w-0 flex-1 font-medium text-ink">{GHL_ENTITY_LABELS[entity].many}</span>
        {owner === "ghl" && <Badge tone="warning">GoHighLevel owns this</Badge>}
        {st ? <Badge tone={st.tone}>{RUNNING.includes(job!.status) && <Loader2 className="size-3 animate-spin" aria-hidden />}{st.label}</Badge> : <Badge>Not started</Badge>}
      </div>
      <p role="status" className="sr-only">{announcement(entity, job)}</p>
      {job && (
        <div className="space-y-2 pl-8">
          {job.status === "fetching" && (
            <p className="text-[13px] text-muted">
              {n(job.totalRows)} read so far{job.fetch?.sourceTotal ? ` of ${n(job.fetch.sourceTotal)}` : ""} · {n(job.fetch?.requests)} requests
              {wait ? ` · ${wait}` : ""}
              {job.fetch?.rateLimited ? ` · GoHighLevel answered 429 ${job.fetch.rateLimited}×, resuming from where it stopped` : ""}
            </p>
          )}
          {(job.status === "validating" || job.status === "importing" || job.status === "rolling_back") && <Progress job={job} />}
          {job.status === "validated" && (
            <p className="text-[13px] text-ink-2">
              Dry run: <b>{n(s.create)}</b> to create, <b>{n(s.update)}</b> to link to records already here, {n(s.skip)} already migrated or left alone, {n(s.review)} held for review
              {problems ? <>, <span className="text-danger-ink">{n(problems)} with problems</span></> : null}. Read {n(job.totalRows)} from GoHighLevel{job.fetch?.truncated ? " (stopped early: see the comparison)" : ""}.
            </p>
          )}
          {job.status === "completed" && (
            <p className="flex items-center gap-1.5 text-[13px] text-ink-2"><CheckCircle2 className="size-3.5 text-success-ink" aria-hidden />{n(s.created)} created, {n(s.updated)} linked, {n(s.skipped)} skipped, {n(s.needsReview)} need review, {n(s.failed)} failed{job.completedAt ? <> · <RelativeTime iso={job.completedAt} timezone={timezone} /></> : ""}</p>
          )}
          {job.status === "rolled_back" && <p className="flex items-center gap-1.5 text-[13px] text-ink-2"><RotateCcw className="size-3.5" aria-hidden />Undone: {n(s.rolledBack)} removed or unlinked{s.keptChanged ? `, ${n(s.keptChanged)} kept because they changed or are still in use` : ""}.</p>}
          {job.status === "failed" && <p className="flex items-center gap-1.5 text-[13px] text-danger-ink"><AlertTriangle className="size-3.5" aria-hidden />{job.error ?? "This step stopped."}</p>}
          {job.status === "cancelled" && job.error && <p className="text-[13px] text-warning-ink">{job.error}</p>}
          {earlier && (
            earlier.status === "rolling_back"
              ? <div className="space-y-1"><p className="text-[13px] text-ink-2">Undoing the earlier run from <RelativeTime iso={earlier.createdAt} timezone={timezone} />.</p><Progress job={earlier} /></div>
              : <p className="text-[13px] text-muted">The run from <RelativeTime iso={earlier.createdAt} timezone={timezone} /> imported records that are still here; Undo removes them.</p>
          )}
          {s.flags && Object.keys(s.flags).length > 0 && (
            <p className="text-[12px] text-muted">{Object.entries(s.flags).map(([f, c]) => `${IMPORT_FLAG_LABELS[f] ?? f}: ${n(c)}`).join(" · ")}</p>
          )}
          <div className="flex flex-wrap gap-2">
            {!state.switchActive && job.status === "validated" && state.can.import && (
              <Button size="sm" loading={busy("import:" + job.id)} disabled={owner === "ghl" || prereqs.length > 0} title={owner === "ghl" ? "GoHighLevel still owns this part of the CRM" : prereqs.length ? `Import ${prereqs.map((p) => GHL_ENTITY_LABELS[p].many.toLowerCase()).join(", ")} first` : undefined} onClick={() => onImport(job)}>
                Import {GHL_ENTITY_LABELS[entity].many.toLowerCase()}
              </Button>
            )}
            {!state.switchActive && job.status === "validated" && state.can.import && prereqs.length > 0 && <span className="self-center text-[12px] text-muted">Import {prereqs.map((p) => GHL_ENTITY_LABELS[p].many.toLowerCase()).join(" and ")} first.</span>}
            {!state.switchActive && job.status === "validated" && state.can.dryRun && <Button size="sm" variant="ghost" loading={busy("again:" + job.id)} onClick={() => onAgain(job)}>Check again</Button>}
            {!state.switchActive && ["fetching", "validating", "validated"].includes(job.status) && state.can.dryRun && <Button size="sm" variant="ghost" loading={busy("cancel:" + job.id)} onClick={() => onCancel(job)}>Cancel</Button>}
            {!state.switchActive && job.status === "importing" && state.can.import && <Button size="sm" variant="ghost" loading={busy("cancel:" + job.id)} onClick={() => onCancel(job)}>Stop import</Button>}
            {!state.switchActive && ["completed", "failed", "cancelled", "rolled_back"].includes(job.status) && state.can.dryRun && <Button size="sm" variant="ghost" loading={busy("restart:" + entity)} onClick={onRestart}>Run this step again</Button>}
            {!state.switchActive && undoJob && undoJob.status !== "rolling_back" && state.can.import && <Button size="sm" variant="secondary" onClick={() => onUndo(undoJob)}><RotateCcw className="size-3.5" />{earlier ? "Undo the earlier run" : "Undo"}</Button>}
            {!RUNNING.includes(job.status) && job.status !== "fetching" && <Button size="sm" variant="ghost" onClick={() => onDetail(job)}>Rows to look at</Button>}
          </div>
        </div>
      )}
    </li>
  );
}

function PlanTable({ plan, timezone }: { plan: GhlMigrationPlan; timezone: string }) {
  return (
    <section aria-label="What GoHighLevel holds" className="space-y-2">
      <h4 className="text-[14px] font-semibold text-ink">In GoHighLevel now <span className="font-normal text-muted">· checked <RelativeTime iso={plan.checkedAt} timezone={timezone} /> with {plan.requests} read-only requests</span></h4>
      {plan.reason && <p className="text-[14px] text-warning-ink">{plan.reason}</p>}
      <div className="overflow-x-auto rounded-xl border border-line" tabIndex={0}>
        <table className="w-full min-w-[640px] text-[14px]">
          <thead className="bg-surface-2/60 text-[12px] text-muted">
            <tr><th scope="col" className="px-3 py-2 text-left font-medium">Step</th><th scope="col" className="px-3 py-2 text-right font-medium">In GoHighLevel</th><th scope="col" className="px-3 py-2 text-right font-medium">Already linked here</th><th scope="col" className="px-3 py-2 text-left font-medium">Notes</th></tr>
          </thead>
          <tbody className="divide-y divide-line">
            {plan.entities.map((e) => (
              <tr key={e.entity}>
                <td className="px-3 py-2 font-medium text-ink">{e.label}</td>
                <td className="px-3 py-2 text-right tabular-nums">{e.status === "ok" ? `${e.countKind === "at_least" ? "at least " : ""}${n(e.count)}` : "—"}</td>
                <td className="px-3 py-2 text-right tabular-nums">{n(e.alreadyLinked)}</td>
                <td className={cn("px-3 py-2 text-[13px]", e.status === "ok" ? "text-muted" : "text-warning-ink")}>
                  {e.status === "forbidden" ? `Not readable with this token (needs ${e.scope}).` : e.detail ?? (e.status === "ok" ? "" : "Not available.")}
                  {e.unsupported?.length ? ` ${e.unsupported.map((u) => `${u.name} (${u.type})`).join(", ")}.` : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[13px] text-muted">
        Owners: {plan.owners.status === "ok" ? `${n(plan.owners.matched)} of ${n(plan.owners.ghlUsers)} GoHighLevel users match a member here by email; records owned by the others come across unassigned.` : "GoHighLevel users couldn't be read (users.readonly), so records come across unassigned."}{" "}
        Calendars: {plan.appointments.calendars !== null ? `${n(plan.appointments.calendars)} in GoHighLevel. ` : ""}{plan.appointments.note}
      </p>
    </section>
  );
}

function ComparisonTable({ comparison }: { comparison: NonNullable<GhlMigrationState["comparison"]> }) {
  return (
    <section aria-label="Source and destination side by side" className="space-y-2">
      <h4 className="text-[14px] font-semibold text-ink">Side by side</h4>
      <div className="overflow-x-auto rounded-xl border border-line" tabIndex={0}>
        <table className="w-full min-w-[760px] text-[14px]">
          <thead className="bg-surface-2/60 text-[12px] text-muted">
            <tr>
              {["Step", "In GoHighLevel", "Read", "Here now", "Mapped", "Skipped", "Failed", "Needs review"].map((h, i) => <th key={h} scope="col" className={cn("px-3 py-2 font-medium", i ? "text-right" : "text-left")}>{h}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {comparison.rows.map((r) => (
              <tr key={r.entity}>
                <td className="px-3 py-2 font-medium text-ink">{r.label}{r.truncated && <span className="ml-1 text-[12px] font-normal text-warning-ink">(stopped early)</span>}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {r.sourceCount === null ? <span className="text-muted">not reported</span> : r.sourceCountKind === "at_least" ? `at least ${n(r.sourceCount)}` : n(r.sourceCount)}
                  {r.sourceCountKind === "listed" && <span className="ml-1 text-[12px] text-muted">listed</span>}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{n(r.staged)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{n(r.destinationCount)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.status === "validated" ? <span className="text-muted">{n(r.planned.create + r.planned.update)} planned</span> : n(r.mapped)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{n(r.status === "validated" ? r.planned.skip : r.skipped)}</td>
                <td className={cn("px-3 py-2 text-right tabular-nums", (r.status === "validated" ? r.planned.invalid : r.failed) ? "text-danger-ink" : "")}>{n(r.status === "validated" ? r.planned.invalid : r.failed)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{n(r.status === "validated" ? r.planned.review : r.needsReview)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {comparison.rows.some((r) => r.sourceCountKind === "listed" || r.sourceCountKind === "at_least") && (
        <p className="text-[13px] text-muted">
          &ldquo;Listed&rdquo;: GoHighLevel reports no total for that step, so the number is how many it listed when the whole list was read. &ldquo;At least&rdquo;: reading stopped early, failed or was cancelled, so GoHighLevel may hold more.
        </p>
      )}
      {comparison.rows.some((r) => r.unsupported.length) && (
        <p className="text-[13px] text-muted">Not created (unsupported): {comparison.rows.flatMap((r) => r.unsupported).map((u) => `${u.name} (${u.type})`).join(", ")}.</p>
      )}
    </section>
  );
}
