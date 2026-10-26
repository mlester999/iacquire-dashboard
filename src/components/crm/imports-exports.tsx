"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, Download, FileSpreadsheet, Loader2, RotateCcw, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, Field, Input, ProgressBar, Select } from "@/components/ui/primitives";
import { Segmented } from "@/components/ui/overlays";
import { cn } from "@/lib/utils";
import { advanceImportAction, cancelImportAction, createImportAction, getImportAction, rollbackImportAction, startImportAction, startValidationAction } from "@/app/actions/crm";
import { ConfirmDialog, PageTitle, useCrmAction } from "@/components/crm/ui";
import type { CsvImportEntity, ImportJobView, ImportOptions } from "@/server/crm/imports";
import type { ExportJobView } from "@/server/crm/exports";
import type { CrmScope } from "@/server/crm/page";
import type { GhlMigrationState } from "@/server/crm/ghl-migration";
import { GhlMigrationPanel } from "@/components/crm/ghl-migration-panel";
import { GHL_ENTITY_LABELS, isGhlMigrationEntity } from "@/lib/crm/ghl-migration";
import { RelativeTime } from "@/components/crm/relative-time";

type Job = ImportJobView & { problems?: Array<{ row: number; status: string; errors: string[]; data: Record<string, string> }> };
type Targets = Record<CsvImportEntity, Array<{ value: string; label: string }>>;

/** How a job is named in the history: a CSV file's records, or a GoHighLevel migration step. */
function jobKind(j: ImportJobView): string {
  if (j.source === "ghl_api") return `GoHighLevel migration · ${isGhlMigrationEntity(j.entity) ? GHL_ENTITY_LABELS[j.entity].many : j.entity}`;
  return j.entity === "company" ? "Companies" : "Contacts";
}

const RUNNING = ["validating", "importing", "rolling_back"];
const STATUS_LABEL: Record<string, string> = {
  uploaded: "Waiting for mapping", fetching: "Reading GoHighLevel", validating: "Checking", validated: "Checked, ready to import", importing: "Importing", completed: "Imported", failed: "Stopped",
  cancelled: "Cancelled", rolling_back: "Undoing", rolled_back: "Undone",
};
const STATUS_TONE: Record<string, "neutral" | "primary" | "success" | "warning" | "danger"> = {
  uploaded: "neutral", fetching: "primary", validating: "primary", validated: "primary", importing: "primary", completed: "success", failed: "danger", cancelled: "neutral", rolling_back: "warning", rolled_back: "neutral",
};
const MAX_BYTES = 5 * 1024 * 1024;

export function ImportsExports({ scope, jobs, exports, targets, ghlMigration }: { scope: CrmScope; jobs: ImportJobView[]; exports: ExportJobView[] | null; targets: Targets; ghlMigration?: GhlMigrationState }) {
  const router = useRouter();
  const { run, busy } = useCrmAction();
  const [entity, setEntity] = React.useState<CsvImportEntity>("contact");
  const [job, setJob] = React.useState<Job | null>(null);
  const [preview, setPreview] = React.useState<string[][]>([]);
  const [mapping, setMapping] = React.useState<Record<string, string>>({});
  const [duplicates, setDuplicates] = React.useState<NonNullable<ImportOptions["duplicates"]>>("skip");
  const [tagAll, setTagAll] = React.useState("");
  const [uploading, setUploading] = React.useState(false);
  const [uploadError, setUploadError] = React.useState<string | null>(null);
  const [rollbackOpen, setRollbackOpen] = React.useState(false);
  const [dragOver, setDragOver] = React.useState(false);
  const canImport = !!scope.can["contacts.import"] && !scope.readOnly;
  // Everyone with crm.view reaches this page (for the GoHighLevel migration preview). When none of the sections below would show (the
  // same conditions they use: the migration panel, the CSV import, the import history, the exports), the page says so instead of
  // promising imports and exports this person can't run.
  const showsGhl = !!ghlMigration && (ghlMigration.connected || ghlMigration.can.dryRun);
  const showsHistory = !!scope.can["contacts.import"];
  const nothingVisible = !showsGhl && !canImport && !showsHistory && !exports;

  // Polls a running job forward. Each call processes a chunk on the server, so progress keeps moving even before the scheduler runs.
  const status = job?.status;
  const jobId = job?.id;
  React.useEffect(() => {
    if (!jobId || !status || !RUNNING.includes(status)) return;
    let live = true;
    const tick = async () => {
      const r = await advanceImportAction(scope.orgId, jobId);
      if (!live) return;
      if (r.ok) {
        setJob(r.data);
        if (!RUNNING.includes(r.data.status)) router.refresh();
      } else {
        setUploadError(r.error);
      }
    };
    const t = setTimeout(tick, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [jobId, status, job, scope.orgId, router]);

  async function upload(file: File) {
    setUploadError(null);
    if (file.size > MAX_BYTES) return setUploadError("This file is larger than 5 MB. Split it into smaller files.");
    if (!/\.(csv|txt)$/i.test(file.name) && file.type && !/csv|text\/plain/.test(file.type)) return setUploadError("Choose a CSV file. In Excel or Google Sheets, use File → Download → CSV.");
    setUploading(true);
    try {
      const text = await file.text();
      const r = await createImportAction(scope.orgId, entity, file.name, text);
      if (!r.ok) return setUploadError(r.error);
      setJob(r.data.job);
      setPreview(r.data.preview);
      setMapping(r.data.suggested);
    } finally {
      setUploading(false);
    }
  }

  async function open(id: string) {
    const r = await getImportAction(scope.orgId, id);
    if (!r.ok) return setUploadError(r.error);
    setJob(r.data);
    setEntity(r.data.entity === "company" ? "company" : "contact");
    setMapping(r.data.mapping && Object.keys(r.data.mapping).length ? r.data.mapping : Object.fromEntries(r.data.headers.map((h) => [h, "ignore"])));
    setPreview([]);
    setDuplicates(r.data.options.duplicates ?? "skip");
    setTagAll((r.data.options.tagAll ?? []).join(", "));
  }

  const reset = () => {
    setJob(null);
    setPreview([]);
    setMapping({});
    setUploadError(null);
  };

  const step = !job ? "upload" : job.status === "uploaded" ? "map" : job.status === "validated" ? "review" : RUNNING.includes(job.status) ? "running" : "done";
  const s = job?.summary ?? {};
  // Live progress from the server's row counts (the summary is only written when a phase ends); 0 until the first poll brings them.
  const progress = job?.progress && job.progress.total > 0 ? Math.min(100, Math.round((job.progress.done / job.progress.total) * 100)) : 0;
  const mappedTargets = Object.values(mapping).filter((t) => t !== "ignore");
  const duplicateTarget = mappedTargets.find((t, i) => mappedTargets.indexOf(t) !== i);

  return (
    <div className="space-y-6">
      <PageTitle title="Imports & Exports" description={nothingVisible ? "Spreadsheet imports, exports and the GoHighLevel migration preview for this workspace." : "Bring contacts and companies in from a spreadsheet or another CRM, and take your data out whenever you want. Every import is checked first, can be undone, and is recorded."} />

      {nothingVisible && (
        <Card>
          <EmptyState compact icon={<FileSpreadsheet className="size-5" />} title="Imports and exports are run by your workspace's owners and admins"
            description="Ask an owner or admin to import a spreadsheet or export your contacts. If your business is moving from GoHighLevel, the migration preview appears here once iAcquire support connects that account." />
        </Card>
      )}

      {ghlMigration && (ghlMigration.connected || ghlMigration.can.dryRun) && <GhlMigrationPanel scope={scope} initial={ghlMigration} />}

      {canImport && (
        <Card className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-[15px] font-semibold text-ink">{step === "upload" ? "Import a CSV file" : job?.fileName ?? "Import"}</h3>
            {job && <Badge tone={STATUS_TONE[job.status] ?? "neutral"}>{STATUS_LABEL[job.status] ?? job.status}</Badge>}
          </div>

          {step === "upload" && (
            <div className="mt-4 space-y-4">
              <Segmented id="imp-entity" ariaLabel="What you're importing" value={entity} onChange={setEntity} options={[{ value: "contact", label: "Contacts" }, { value: "company", label: "Companies" }]} />
              <label
                htmlFor="imp-file"
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) void upload(f); }}
                className={cn("flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors", dragOver ? "border-primary bg-primary-soft/40" : "border-line hover:bg-surface-2")}
              >
                {uploading ? <Loader2 className="size-6 animate-spin text-primary" aria-hidden /> : <Upload className="size-6 text-muted" aria-hidden />}
                <span className="text-[14px] font-medium text-ink">{uploading ? "Reading your file…" : "Choose a CSV file or drop it here"}</span>
                <span className="text-[13px] text-muted">Up to 5 MB and 20,000 rows. The first row must be column names.</span>
                <input id="imp-file" type="file" accept=".csv,text/csv" className="sr-only" disabled={uploading} onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ""; }} />
              </label>
              <p className="text-[13px] text-muted">Nothing is imported until you check the file and confirm. Coming from GoHighLevel? Use Migrate from GoHighLevel above once your location is connected, or export your contacts there as CSV; the GoHighLevel ID column keeps re-imports from creating duplicates.</p>
            </div>
          )}

          {step === "map" && job && (
            <div className="mt-4 space-y-4">
              <p className="text-[14px] text-muted">{job.totalRows.toLocaleString("en-US")} rows. Match each column to a field. Columns set to “Don’t import” are left out.</p>
              <div className="overflow-x-auto rounded-xl border border-line" tabIndex={0}>
                <table className="w-full min-w-[640px] text-[14px]">
                  <thead className="bg-surface-2/60 text-[12px] text-muted">
                    <tr><th scope="col" className="px-3 py-2 text-left font-medium">Column in your file</th><th scope="col" className="px-3 py-2 text-left font-medium">Example</th><th scope="col" className="px-3 py-2 text-left font-medium">Import into</th></tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {job.headers.map((h, i) => (
                      <tr key={h}>
                        <td className="px-3 py-2 font-medium text-ink">{h}</td>
                        <td className="max-w-[220px] truncate px-3 py-2 text-muted">{preview.map((r) => r[i]).filter(Boolean).slice(0, 2).join(" · ") || "—"}</td>
                        <td className="px-3 py-2">
                          <label htmlFor={`map-${i}`} className="sr-only">Import {h} into</label>
                          <Select id={`map-${i}`} value={mapping[h] ?? "ignore"} onChange={(e) => setMapping((m) => ({ ...m, [h]: e.target.value }))} className={cn("min-h-9 py-1", (mapping[h] ?? "ignore") === "ignore" && "text-muted")}>
                            <option value="ignore">Don’t import</option>
                            {targets[job.entity === "company" ? "company" : "contact"].map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                          </Select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {duplicateTarget && <p role="alert" className="text-[14px] text-danger-ink">Two columns go into the same field. Each field can take one column.</p>}
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="When a row matches an existing record" htmlFor="imp-dup" hint="Matched by email or phone (contacts) or domain (companies).">
                  <Select id="imp-dup" value={duplicates} onChange={(e) => setDuplicates(e.target.value as typeof duplicates)}>
                    <option value="skip">Leave the existing record alone</option>
                    <option value="update">Fill in its empty details only</option>
                    <option value="review">Hold the row for me to review</option>
                  </Select>
                </Field>
                <Field label="Tag everyone imported" htmlFor="imp-tags" optional hint="Comma-separated, for example: Imported 2026, Trade show"><Input id="imp-tags" value={tagAll} onChange={(e) => setTagAll(e.target.value)} /></Field>
              </div>
              <div className="flex flex-wrap justify-between gap-2">
                <Button variant="ghost" onClick={() => run("cancel", () => cancelImportAction(scope.orgId, job.id), "Import cancelled.").then((ok) => ok && reset())}>Cancel</Button>
                <Button loading={busy("validate")} disabled={!mappedTargets.length || Boolean(duplicateTarget)} onClick={async () => {
                  const ok = await run("validate", () => startValidationAction(scope.orgId, job.id, mapping, { duplicates, tagAll: tagAll.split(",").map((t) => t.trim()).filter(Boolean) }));
                  if (ok) setJob({ ...job, status: "validating", summary: {}, progress: null });
                }}>Check the file</Button>
              </div>
            </div>
          )}

          {step === "running" && job && (
            <div className="mt-4 space-y-3" aria-live="polite">
              <p className="text-[14px] text-ink-2">
                {job.status === "validating" ? "Checking every row. Nothing is changed yet." : job.status === "importing" ? "Importing. You can leave this page; it carries on in the background." : "Undoing the import."}
              </p>
              <ProgressBar value={progress} label="Progress" />
              {job.progress && job.progress.total > 0 && <p className="text-[12px] tabular-nums text-muted">{job.progress.done.toLocaleString("en-US")} of {job.progress.total.toLocaleString("en-US")}</p>}
              {job.status === "importing" && <Button variant="ghost" size="sm" onClick={() => run("cancel", () => cancelImportAction(scope.orgId, job.id), "Import stopped. Rows already imported stay; you can undo them.").then(() => open(job.id))}>Stop</Button>}
            </div>
          )}

          {step === "review" && job && (
            <div className="mt-4 space-y-4">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Count label="New records" value={s.create ?? 0} tone="success" />
                <Count label={duplicates === "update" ? "Existing to fill in" : "Already exist"} value={(s.update ?? 0) + (s.skip ?? 0)} />
                <Count label="Held for review" value={s.review ?? 0} />
                <Count label="Rows with problems" value={(s.invalid ?? 0) + (s.duplicateInFile ?? 0)} tone={(s.invalid ?? 0) + (s.duplicateInFile ?? 0) ? "danger" : undefined} />
              </div>
              {(job.problems?.length ?? 0) > 0 && <Problems problems={job.problems!} />}
              <div className="flex flex-wrap justify-between gap-2">
                <div className="flex gap-2">
                  <Button variant="ghost" onClick={() => setJob({ ...job, status: "uploaded" })}>Change the mapping</Button>
                  <Button variant="ghost" onClick={() => run("cancel", () => cancelImportAction(scope.orgId, job.id), "Import cancelled.").then((ok) => ok && reset())}>Cancel</Button>
                </div>
                <Button loading={busy("import")} disabled={!((s.create ?? 0) + (s.update ?? 0) + (s.review ?? 0))} onClick={async () => { if (await run("import", () => startImportAction(scope.orgId, job.id))) setJob({ ...job, status: "importing", summary: { ...s }, progress: null }); }}>
                  Import {((s.create ?? 0) + (s.update ?? 0)).toLocaleString("en-US")} {job.entity === "company" ? "companies" : "contacts"}
                </Button>
              </div>
            </div>
          )}

          {step === "done" && job && (
            <div className="mt-4 space-y-4">
              {job.status === "completed" && (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Count label="Created" value={s.created ?? 0} tone="success" />
                  <Count label="Updated" value={s.updated ?? 0} />
                  <Count label="Skipped" value={(s.skipped ?? 0) + (s.needsReview ?? 0)} />
                  <Count label="Failed" value={s.failed ?? 0} tone={s.failed ? "danger" : undefined} />
                </div>
              )}
              {job.status === "rolled_back" && <p className="flex items-center gap-2 text-[14px] text-ink-2"><RotateCcw className="size-4" />Undone: {s.rolledBack ?? 0} records removed or restored{s.keptChanged ? `, ${s.keptChanged} kept because someone changed them after the import` : ""}.</p>}
              {job.status === "failed" && <p className="flex items-center gap-2 text-[14px] text-danger-ink"><AlertTriangle className="size-4" />{job.error ?? "The import stopped."}</p>}
              {job.status === "cancelled" && <p className="text-[14px] text-muted">This import was cancelled.</p>}
              {(job.problems?.length ?? 0) > 0 && <Problems problems={job.problems!} />}
              <div className="flex flex-wrap justify-between gap-2">
                <div className="flex gap-2">
                  {(job.status === "completed" || job.status === "cancelled") && scope.can["contacts.delete"] && <Button variant="secondary" onClick={() => setRollbackOpen(true)}><RotateCcw className="size-4" />Undo this import</Button>}
                  {job.status === "completed" && <Link href={`${scope.base}/${job.entity === "company" ? "companies" : "contacts"}?sort=created_at&dir=desc`} className="inline-flex min-h-11 items-center rounded-xl px-3 text-[14px] font-medium text-primary hover:underline sm:min-h-9">See what was imported</Link>}
                </div>
                <Button onClick={reset}>Import another file</Button>
              </div>
            </div>
          )}

          {uploadError && <p role="alert" className="mt-3 flex items-center gap-2 text-[14px] text-danger-ink"><AlertTriangle className="size-4 shrink-0" />{uploadError}</p>}
        </Card>
      )}

      {/* Import history is for people who import; anyone in the workspace may still preview the GoHighLevel migration above. */}
      {scope.can["contacts.import"] && <section>
        <h3 className="mb-2 text-[14px] font-semibold text-ink">Past imports</h3>
        {jobs.length ? (
          <ul className="divide-y divide-line rounded-2xl border border-line bg-surface">
            {jobs.map((j) => (
              <li key={j.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-[14px]">
                <FileSpreadsheet className="size-4 shrink-0 text-muted" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-ink">{j.fileName ?? "Import"}</span>
                  <span className="block text-[12px] text-muted">{jobKind(j)} · {j.totalRows.toLocaleString("en-US")} rows · <RelativeTime iso={j.createdAt} timezone={scope.timezone} />{j.status === "completed" ? ` · ${j.summary.created ?? 0} created, ${j.summary.updated ?? 0} ${j.source === "ghl_api" ? "linked" : "updated"}` : ""}</span>
                </span>
                <Badge tone={STATUS_TONE[j.status] ?? "neutral"}>{STATUS_LABEL[j.status] ?? j.status}</Badge>
                {canImport && j.id !== job?.id && j.source !== "ghl_api" && <Button size="sm" variant="ghost" onClick={() => open(j.id)}>Open</Button>}
              </li>
            ))}
          </ul>
        ) : <p className="rounded-xl border border-dashed border-line px-3 py-4 text-center text-[14px] text-muted">No imports yet.</p>}
      </section>}

      {exports && (
        <section>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-[14px] font-semibold text-ink">Exports</h3>
            <a href={`/api/crm/export${scope.orgId ? `?org=${scope.orgId}` : ""}`} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-line bg-surface px-3 text-[14px] font-medium text-ink shadow-soft hover:bg-surface-2 sm:min-h-9"><Download className="size-4" />Export all contacts</a>
          </div>
          <p className="mb-2 text-[13px] text-muted">To export part of your contacts, open Contacts, filter or pick a Smart List, and use Export there. Exports include custom fields and tags.</p>
          {exports.length ? (
            <ul className="divide-y divide-line rounded-2xl border border-line bg-surface">
              {exports.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-[14px]">
                  <span>{e.rowCount.toLocaleString("en-US")} {e.entity === "contact" ? "contacts" : e.entity} · by {e.requestedBy ?? (e.requestedByKind === "api" ? "API" : "someone")}</span>
                  <span className="flex items-center gap-2 text-[12px] text-muted"><RelativeTime iso={e.createdAt} timezone={scope.timezone} />{e.status !== "completed" && <Badge tone={e.status === "failed" ? "danger" : "primary"}>{e.status === "failed" ? "Failed" : "Running"}</Badge>}</span>
                </li>
              ))}
            </ul>
          ) : <Card><EmptyState compact icon={<Download className="size-5" />} title="No exports yet" description="Each export is listed here with who ran it." /></Card>}
        </section>
      )}

      <ConfirmDialog open={rollbackOpen} onOpenChange={setRollbackOpen} title="Undo this import?" confirmLabel="Undo import" danger loading={busy("rollback")}
        description="Records it created are removed and details it filled in are put back. Anything someone changed after the import is kept as it is."
        onConfirm={async () => { if (job && (await run("rollback", () => rollbackImportAction(scope.orgId, job.id)))) { setRollbackOpen(false); setJob({ ...job, status: "rolling_back", progress: null }); } }} />
    </div>
  );
}

function Count({ label, value, tone }: { label: string; value: number; tone?: "success" | "danger" }) {
  return (
    <div className="rounded-xl border border-line bg-surface-2/50 px-3 py-2.5">
      <p className="text-[12px] text-muted">{label}</p>
      <p className={cn("mt-0.5 text-[18px] font-semibold tabular-nums", tone === "success" ? "text-success-ink" : tone === "danger" ? "text-danger-ink" : "text-ink")}>{value.toLocaleString("en-US")}</p>
    </div>
  );
}

function Problems({ problems }: { problems: NonNullable<Job["problems"]> }) {
  return (
    <details className="rounded-xl border border-line">
      <summary className="cursor-pointer px-3 py-2 text-[14px] font-medium text-ink">{problems.length >= 200 ? "First 200 rows" : `${problems.length} ${problems.length === 1 ? "row" : "rows"}`} to look at</summary>
      <ul className="max-h-72 divide-y divide-line overflow-y-auto border-t border-line text-[13px]">
        {problems.map((p) => (
          <li key={p.row} className="px-3 py-2">
            <span className="font-medium text-ink">Row {p.row}</span>
            <span className="ml-2 text-muted">{p.status === "needs_review" ? "Held for review" : p.status === "duplicate" ? "Repeated in the file" : p.status === "failed" ? "Failed" : "Problem"}</span>
            {p.errors.length > 0 && <span className="block text-danger-ink">{p.errors.join(" ")}</span>}
            <span className="block truncate text-faint">{Object.values(p.data).slice(0, 4).join(" · ")}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
