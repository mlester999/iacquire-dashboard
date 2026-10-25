"use client";

import * as React from "react";
import { Download, GitCompare, History, Pencil, Rocket, RotateCcw } from "lucide-react";
import { compareVersionsAction, publishBlueprintAction, restoreVersionToDraftAction } from "@/app/actions/crm-blueprints";
import { Button, ButtonLink } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { Badge, Card, Field, Select, Textarea } from "@/components/ui/primitives";
import { ConfirmDialog } from "@/components/crm/ui";
import { cn, formatDate } from "@/lib/utils";
import { ASSET_SECTIONS, SECTION_LABELS, type AssetSection } from "@/lib/crm/blueprints/types";
import type { BlueprintDiff } from "@/lib/crm/blueprints/diff";
import type { ValidationIssue } from "@/lib/crm/blueprints/validate";
import type { BlueprintDetail, VersionView } from "@/lib/crm/blueprints/views";
import { CopyValue, DownloadLink, When, bpHref, useBlueprintAction, useResetOnOpen } from "@/components/crm-blueprints/shared";

type Ref = number | "draft";
const refLabel = (r: Ref) => (r === "draft" ? "Working draft" : `Version ${r}`);
const encode = (r: Ref) => String(r);
const decode = (v: string): Ref => (v === "draft" ? "draft" : Number(v));
const total = (counts: Record<string, number>) => Object.values(counts ?? {}).reduce((n, c) => n + (Number(c) || 0), 0);

/** One line per section with problems ("Forms & surveys: 2 issues"), like the contract's summarizeIssues. */
export function issueLines(issues: readonly ValidationIssue[]): string[] {
  const by = new Map<string, number>();
  for (const i of issues) {
    const m = /^assets\.(\w+)/.exec(i.path);
    const label = m && m[1] in SECTION_LABELS ? SECTION_LABELS[m[1] as AssetSection] : "Details";
    by.set(label, (by.get(label) ?? 0) + 1);
  }
  return [...by.entries()].map(([label, n]) => `${label}: ${n} ${n === 1 ? "issue" : "issues"}`);
}

export interface VersionsPanelProps {
  blueprint: BlueprintDetail;
  can: { design: boolean; publish: boolean; export: boolean };
  /**
   * Whether the publish dialog is open. The page owns it (this tab unmounts while another tab is shown), so a dialog that was closed stays
   * closed when the tab is shown again, and the page's own Publish button opens it even when this tab is already showing.
   */
  publishing: boolean;
  onPublishingChange: (open: boolean) => void;
  /** The signed-in person's time zone, so the server and the browser render the same dates. */
  timeZone?: string;
  preview?: boolean;
}

/** The working draft, every published version, comparing any two (the draft included), restoring, and publishing with a change summary. */
export function VersionsPanel({ blueprint: b, can, publishing, onPublishingChange, timeZone, preview }: VersionsPanelProps) {
  const { run, busy } = useBlueprintAction(preview);
  const versions = React.useMemo(() => [...b.versions].sort((x, y) => y.version - x.version), [b.versions]);
  const latest = versions[0]?.version ?? null;
  const [from, setFrom] = React.useState<Ref | null>(latest);
  const [to, setTo] = React.useState<Ref>("draft");
  const [diff, setDiff] = React.useState<{ from: Ref; to: Ref; diff: BlueprintDiff } | null>(latest !== null && b.unpublishedDiff ? { from: latest, to: "draft", diff: b.unpublishedDiff } : null);
  const [restoring, setRestoring] = React.useState<VersionView | null>(null);
  const refs: Ref[] = ["draft", ...versions.map((v) => v.version)];

  const compare = async (a: Ref, z: Ref) => {
    setFrom(a);
    setTo(z);
    if (a === z) return;
    if (latest !== null && a === latest && z === "draft" && b.unpublishedDiff) return setDiff({ from: a, to: z, diff: b.unpublishedDiff });
    const res = await run("compare", () => compareVersionsAction(b.id, a, z), undefined, { refresh: false });
    if (res && typeof res === "object" && "changes" in res) setDiff({ from: a, to: z, diff: res });
  };

  return (
    <div className="space-y-5">
      <Card className="p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="text-[12px] font-semibold uppercase tracking-[.12em] text-muted">Working draft</p>
            <h2 className="mt-1 text-[16px] font-semibold text-ink">Revision {b.draftRevision}</h2>
            <p className="mt-1 text-[13px] text-muted"><When iso={b.draftUpdatedAt} prefix="Saved" timeZone={timeZone} />{b.draftUpdatedBy ? ` by ${b.draftUpdatedBy}` : ""}</p>
            <p className="mt-2 text-[14px] text-ink-2">
              {latest === null ? "Never published. Publishing freezes this draft as version 1."
                : b.hasUnpublishedChanges ? `Changed since version ${latest}.` : `The same as version ${latest}: nothing to publish.`}
            </p>
            {b.unpublishedDiff && !b.unpublishedDiff.empty && <ul className="mt-2 space-y-0.5 text-[13px] text-muted">{b.unpublishedDiff.summary.map((l) => <li key={l}>{l}</li>)}</ul>}
            {(b.draftErrors.length > 0 || b.draftWarnings.length > 0) && (
              <p className={cn("mt-2 text-[13px] font-medium", b.draftErrors.length ? "text-danger-ink" : "text-warning-ink")}>
                {b.draftErrors.length ? `${b.draftErrors.length} ${b.draftErrors.length === 1 ? "problem blocks" : "problems block"} publishing` : ""}
                {b.draftErrors.length && b.draftWarnings.length ? " · " : ""}
                {b.draftWarnings.length ? `${b.draftWarnings.length} ${b.draftWarnings.length === 1 ? "warning" : "warnings"}` : ""}
              </p>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {can.design && b.status !== "archived" && <ButtonLink href={bpHref.edit(b.id)} size="sm" variant="secondary"><Pencil className="size-3.5" /> Edit draft</ButtonLink>}
            {can.publish && b.status !== "archived" && <Button size="sm" variant="brand" onClick={() => onPublishingChange(true)}><Rocket className="size-3.5" /> Publish{latest !== null ? ` version ${latest + 1}` : ""}</Button>}
          </div>
        </div>
      </Card>

      <Card className="p-5">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold text-ink"><GitCompare className="size-4 text-primary" aria-hidden /> Compare versions</h2>
        <p className="mt-1 text-[13px] text-muted">Any two versions, or a version and the working draft. Changes are listed asset by asset.</p>
        {refs.length < 2 ? (
          <p className="mt-3 text-[14px] text-muted">There is only the working draft so far. Publish a version to compare against it.</p>
        ) : (
          <>
            <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
              <Field label="From" htmlFor="bp-cmp-from">
                <Select id="bp-cmp-from" value={from === null ? "" : encode(from)} onChange={(e) => setFrom(decode(e.target.value))}>
                  {refs.map((r) => <option key={encode(r)} value={encode(r)}>{refLabel(r)}</option>)}
                </Select>
              </Field>
              <Field label="To" htmlFor="bp-cmp-to">
                <Select id="bp-cmp-to" value={encode(to)} onChange={(e) => setTo(decode(e.target.value))}>
                  {refs.map((r) => <option key={encode(r)} value={encode(r)}>{refLabel(r)}</option>)}
                </Select>
              </Field>
              <Button variant="secondary" loading={busy("compare")} disabled={from === null || from === to} onClick={() => from !== null && void compare(from, to)}>Compare</Button>
            </div>
            {from !== null && from === to && <p className="mt-2 text-[13px] text-muted">Choose two different versions.</p>}
            {diff && (
              <div className="mt-5" aria-live="polite">
                <p className="mb-3 text-[13px] font-medium text-ink-2">{refLabel(diff.from)} → {refLabel(diff.to)}</p>
                <DiffView diff={diff.diff} />
              </div>
            )}
          </>
        )}
      </Card>

      <section aria-labelledby="bp-versions-heading">
        <h2 id="bp-versions-heading" className="mb-3 flex items-center gap-2 text-[15px] font-semibold text-ink"><History className="size-4 text-primary" aria-hidden /> Published versions</h2>
        {versions.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line-strong px-4 py-8 text-center text-[14px] text-muted">No version has been published yet. Clients can only be given a published version.</p>
        ) : (
          <ol className="space-y-3">
            {versions.map((v) => (
              <li key={v.id}>
                <Card className="p-4">
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-[14.5px] font-semibold text-ink">Version {v.version}</h3>
                        {v.version === latest && <Badge tone="success">Latest</Badge>}
                        <span className="text-[12px] text-muted">{formatDate(v.publishedAt, timeZone)}{v.publishedBy ? ` · ${v.publishedBy}` : ""}</span>
                      </div>
                      {v.changeSummary && <p className="mt-1.5 whitespace-pre-line text-[14px] leading-relaxed text-ink-2">{v.changeSummary}</p>}
                      {v.summaryLines.length > 0 && <ul className="mt-1.5 space-y-0.5 text-[13px] text-muted">{v.summaryLines.map((l) => <li key={l}>{l}</li>)}</ul>}
                      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted">
                        <span>{total(v.counts)} assets</span>
                        <span>Format v{v.schemaVersion}</span>
                        <span className="inline-flex min-w-0 items-center gap-1">Digest <CopyValue value={v.digest} display={`${v.digest.slice(0, 12)}…`} label={`version ${v.version} digest`} /></span>
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2">
                      <Button size="sm" variant="ghost" onClick={() => void compare(v.version, "draft")} aria-label={`Compare with draft: version ${v.version}`}><GitCompare className="size-3.5" /> Compare with draft</Button>
                      {can.export && <DownloadLink href={bpHref.exportFile(b.id, v.version)} label={`Export version ${v.version}`}><Download className="size-3.5" aria-hidden /> Export</DownloadLink>}
                      {can.design && b.status !== "archived" && <Button size="sm" variant="ghost" onClick={() => setRestoring(v)} aria-label={`Restore version ${v.version} to the working draft`}><RotateCcw className="size-3.5" /> Restore</Button>}
                    </div>
                  </div>
                </Card>
              </li>
            ))}
          </ol>
        )}
      </section>

      <PublishDialog open={publishing} onOpenChange={onPublishingChange} b={b} latest={latest} preview={preview} />
      <ConfirmDialog open={Boolean(restoring)} onOpenChange={(o) => !o && setRestoring(null)} title={restoring ? `Restore version ${restoring.version} to the draft?` : "Restore"}
        description={<>The working draft is replaced with version {restoring?.version}&apos;s content. Published versions don&apos;t change and no client is affected until you publish it again and apply it.{b.hasUnpublishedChanges ? " The draft's unpublished changes will be replaced." : ""}</>}
        confirmLabel="Restore to draft" loading={restoring ? busy(`restore-${restoring.version}`) : false}
        onConfirm={() => restoring && void run(`restore-${restoring.version}`, () => restoreVersionToDraftAction(b.id, restoring.version), `Version ${restoring.version} copied into the working draft.`).then((r) => r && setRestoring(null))} />
    </div>
  );
}

function PublishDialog({ open, onOpenChange, b, latest, preview }: { open: boolean; onOpenChange: (o: boolean) => void; b: BlueprintDetail; latest: number | null; preview?: boolean }) {
  const { run, busy } = useBlueprintAction(preview);
  const [summary, setSummary] = React.useState("");
  useResetOnOpen(open, () => setSummary(b.unpublishedDiff && !b.unpublishedDiff.empty ? b.unpublishedDiff.summary.join("\n") : latest === null ? "First version." : ""));
  const unchanged = latest !== null && !b.hasUnpublishedChanges;
  const blocked = b.draftErrors.length > 0;
  const next = (latest ?? 0) + 1;
  const publish = async () => {
    const res = await run("publish", () => publishBlueprintAction(b.id, { revision: b.draftRevision, changeSummary: summary.trim() || undefined }), (r) => `Published version ${r.version}. Clients get it only when you apply it for them.`);
    if (res) onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="lg" title={`Publish version ${next}`}
      description="Publishing freezes the working draft as a new version that can be applied to clients. Nothing is pushed to clients that already applied an earlier version; each one is reviewed separately."
      footer={<>
        <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button variant="brand" loading={busy("publish")} disabled={blocked || unchanged} onClick={() => void publish()}><Rocket className="size-4" /> Publish version {next}</Button>
      </>}>
      <div className="space-y-4">
        {blocked && (
          <div role="alert" className="rounded-xl border border-danger/25 bg-danger-soft px-4 py-3 text-[13px] text-danger-ink">
            <p className="font-semibold">Fix these before publishing</p>
            <ul className="mt-1 space-y-0.5">{issueLines(b.draftErrors).map((l) => <li key={l}>{l}</li>)}</ul>
            <ul className="mt-2 list-disc space-y-0.5 pl-5">{b.draftErrors.slice(0, 5).map((e, i) => <li key={`${e.path}-${i}`}>{e.message}</li>)}</ul>
          </div>
        )}
        {unchanged && <p className="rounded-xl border border-line bg-surface-2 px-4 py-3 text-[13px] text-ink-2">The working draft is the same as version {latest}, so there is nothing new to publish.</p>}
        {!blocked && b.draftWarnings.length > 0 && (
          <div className="rounded-xl border border-warning/30 bg-warning-soft px-4 py-3 text-[13px] text-warning-ink">
            <p className="font-semibold">{b.draftWarnings.length} {b.draftWarnings.length === 1 ? "warning" : "warnings"} (publishing is still allowed)</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">{b.draftWarnings.slice(0, 5).map((w, i) => <li key={`${w.path}-${i}`}>{w.message}</li>)}</ul>
          </div>
        )}
        <Field label="Change summary" htmlFor="bp-publish-summary" optional hint="Shown in the version history and when you review an update for a client.">
          <Textarea id="bp-publish-summary" rows={5} maxLength={2000} value={summary} onChange={(e) => setSummary(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

const KIND_TONE = { added: "success", changed: "primary", removed: "danger" } as const;
const KIND_LABEL = { added: "Added", changed: "Changed", removed: "Removed" } as const;

/** A comparison, section by section, with each asset's field-level changes. */
export function DiffView({ diff }: { diff: BlueprintDiff }) {
  if (diff.empty) return <p className="rounded-xl border border-line bg-surface-2 px-4 py-3 text-[14px] text-ink-2">No differences: these versions are identical.</p>;
  return (
    <div className="space-y-4">
      {diff.summary.length > 0 && <ul className="space-y-0.5 rounded-xl border border-line bg-surface-2 px-4 py-3 text-[13px] text-ink-2">{diff.summary.map((l) => <li key={l}>{l}</li>)}</ul>}
      {ASSET_SECTIONS.map((section) => {
        const changes = diff.changes.filter((c) => c.section === section);
        if (!changes.length) return null;
        return (
          <section key={section} aria-label={SECTION_LABELS[section]}>
            <h3 className="mb-1.5 text-[14px] font-semibold text-ink">{SECTION_LABELS[section]}</h3>
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
              {changes.map((c) => (
                <li key={`${c.kind}-${c.id}`} className="px-4 py-2.5">
                  <div className="flex flex-wrap items-center gap-2"><Badge tone={KIND_TONE[c.kind]}>{KIND_LABEL[c.kind]}</Badge><span className="text-[14px] font-medium text-ink">{c.name}</span><code className="font-mono text-[12px] text-muted">{c.id}</code></div>
                  {c.fields.length > 0 && <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[12px] text-muted">{c.fields.map((f) => <li key={f}>{f}</li>)}</ul>}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
