"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowDownToLine, CircleAlert, FileJson, Link2, Save, ShieldAlert, ShieldCheck, Trash2, TriangleAlert, Upload } from "lucide-react";
import { discardImportAction, saveImportAction } from "@/app/actions/crm-blueprints";
import { Button, ButtonLink } from "@/components/ui/button";
import { Badge, Card, Field, Input, Select } from "@/components/ui/primitives";
import { PageHero, SectionLabel } from "@/components/ui/workspace";
import { ConfirmDialog } from "@/components/crm/ui";
import { cn, formatDateTime } from "@/lib/utils";
import { listAssets, withDependencies } from "@/lib/crm/blueprints/refs";
import { ASSET_SECTIONS, type BlueprintIndustry } from "@/lib/crm/blueprints/types";
import type { ValidationIssue } from "@/lib/crm/blueprints/validate";
import type { ImportDetail, ImportSummary, PackageImportPreview } from "@/lib/crm/blueprints/views";
import { CompatItems, CompatTotals, INDUSTRY_OPTIONS, When, bpHref, sectionLabel, sourceKindLabel, useBlueprintAction } from "@/components/crm-blueprints/shared";

export const IMPORT_KIND_LABEL: Record<ImportSummary["sourceKind"], string> = {
  ghl_client: "GoHighLevel · client location",
  ghl_agency_source: "GoHighLevel · template sub-account",
  package_file: "Package file",
};
const IMPORT_STATUS: Record<ImportSummary["status"], { label: string; tone: "warning" | "success" | "outline" | "danger" }> = {
  previewed: { label: "Awaiting review", tone: "warning" },
  saved: { label: "Saved as Blueprint", tone: "success" },
  discarded: { label: "Discarded", tone: "outline" },
  failed: { label: "Failed", tone: "danger" },
};
const KEY_RE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

export function ImportStatusBadge({ status }: { status: ImportSummary["status"] }) {
  const s = IMPORT_STATUS[status] ?? { label: status, tone: "outline" as const };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

function countsLine(c: ImportSummary["counts"]): string {
  return [`${c.discovered} found`, `${c.converted} converted`, c.partial && `${c.partial} partly`, c.unsupported && `${c.unsupported} unsupported`, c.failed && `${c.failed} failed`].filter(Boolean).join(" · ");
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export function ImportsHistory({ imports, canImport }: { imports: ImportSummary[]; canImport: boolean }) {
  const [status, setStatus] = React.useState<ImportSummary["status"] | "all">("all");
  const list = status === "all" ? imports : imports.filter((i) => i.status === status);
  const waiting = imports.filter((i) => i.status === "previewed").length;
  return (
    <div className="module-stack">
      <PageHero eyebrow="CRM Blueprints" icon={<ArrowDownToLine className="size-5" />} title="Import history" tone="neutral"
        description="Every GoHighLevel and package-file import, with its conversion report. An import becomes a Blueprint only when someone reviews it and saves it. GoHighLevel IDs stay in the import record and never enter a Blueprint."
        action={canImport ? <ButtonLink href={bpHref.import} variant="brand"><Upload className="size-4" /> New import</ButtonLink> : undefined} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className="w-60">
          <option value="all">All imports ({imports.length})</option>
          {(Object.keys(IMPORT_STATUS) as Array<ImportSummary["status"]>).map((s) => <option key={s} value={s}>{IMPORT_STATUS[s].label} ({imports.filter((i) => i.status === s).length})</option>)}
        </Select>
        <p role="status" className="text-[12px] text-muted">{list.length} {list.length === 1 ? "import" : "imports"}{waiting ? ` · ${waiting} awaiting review` : ""}</p>
      </div>
      {list.length === 0 ? (
        <Card className="border-dashed px-6 py-12 text-center">
          <p className="text-[15px] font-semibold text-ink">{imports.length ? "No import with this status" : "No imports yet"}</p>
          <p className="mx-auto mt-2 max-w-md text-[13px] text-muted">Import from GoHighLevel through its official read-only API, or upload an iAcquire package file.</p>
        </Card>
      ) : (
        <>
          <Card className="hidden overflow-hidden md:block">
            <div className="overflow-x-auto">
              <table className="workspace-table w-full min-w-[820px] text-left text-[13px]">
                <caption className="sr-only">Imports</caption>
                <thead><tr><th scope="col" className="px-4 py-2.5">Source</th><th scope="col" className="px-4 py-2.5">Status</th><th scope="col" className="px-4 py-2.5">Conversion</th><th scope="col" className="px-4 py-2.5">When</th><th scope="col" className="px-4 py-2.5"><span className="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  {list.map((i) => (
                    <tr key={i.id} className="border-t border-line align-top">
                      <td className="px-4 py-3"><p className="font-medium text-ink">{i.sourceLabel}</p><p className="text-[12px] text-muted">{IMPORT_KIND_LABEL[i.sourceKind]}</p></td>
                      <td className="px-4 py-3"><ImportStatusBadge status={i.status} /></td>
                      <td className="px-4 py-3 text-[12.5px] text-ink-2">{countsLine(i.counts)}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-[12.5px] text-muted"><When iso={i.createdAt} />{i.createdBy ? <p className="text-[12px]">{i.createdBy}</p> : null}</td>
                      <td className="px-4 py-3"><div className="flex justify-end gap-1.5">
                        {i.blueprintId && <ButtonLink href={bpHref.detail(i.blueprintId)} size="sm" variant="ghost">Blueprint</ButtonLink>}
                        <ButtonLink href={bpHref.importDetail(i.id)} size="sm" variant={i.status === "previewed" ? "soft" : "ghost"} aria-label={`${i.status === "previewed" ? "Review" : "Open"} the import from ${i.sourceLabel}`}>{i.status === "previewed" ? "Review" : "Report"}</ButtonLink>
                      </div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <ul className="space-y-3 md:hidden" aria-label="Imports">
            {list.map((i) => (
              <li key={i.id}>
                <Card className="p-4">
                  <div className="flex items-start justify-between gap-2"><p className="min-w-0 truncate text-[14px] font-semibold text-ink">{i.sourceLabel}</p><ImportStatusBadge status={i.status} /></div>
                  <p className="mt-0.5 text-[12px] text-muted">{IMPORT_KIND_LABEL[i.sourceKind]} · <When iso={i.createdAt} /></p>
                  <p className="mt-2 text-[12.5px] text-ink-2">{countsLine(i.counts)}</p>
                  <div className="mt-3 flex gap-2">
                    <ButtonLink href={bpHref.importDetail(i.id)} size="sm" variant="secondary">{i.status === "previewed" ? "Review" : "Report"}</ButtonLink>
                    {i.blueprintId && <ButtonLink href={bpHref.detail(i.blueprintId)} size="sm" variant="ghost">Blueprint</ButtonLink>}
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One import: the conversion preview
// ---------------------------------------------------------------------------

const isPackagePreview = (d: ImportDetail): d is PackageImportPreview => "integrity" in d && "manifest" in d;

/** `timeZone`: the signed-in person's zone, so the server and the browser render the same times. */
export function ImportDetailView({ detail: d, canDesign, timeZone, preview }: { detail: ImportDetail | PackageImportPreview; canDesign: boolean; timeZone?: string; preview?: boolean }) {
  const router = useRouter();
  const { run, busy } = useBlueprintAction(preview);
  const content = d.content;
  const top = React.useMemo(() => (content ? listAssets(content).filter((e) => !e.parentId) : []), [content]);
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set(top.map((e) => e.id)));
  const [name, setName] = React.useState(content?.blueprint.name ?? d.sourceLabel.slice(0, 80));
  const [key, setKey] = React.useState("");
  const [industry, setIndustry] = React.useState<BlueprintIndustry>(content?.blueprint.industry ?? "general_services");
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [discarding, setDiscarding] = React.useState(false);
  const effective = React.useMemo(() => (content ? withDependencies(content, selected) : new Set<string>()), [content, selected]);
  const implied = top.filter((e) => effective.has(e.id) && !selected.has(e.id));
  const kept = top.filter((e) => effective.has(e.id)).length;
  const editable = d.status === "previewed" && Boolean(content) && canDesign;
  const blocked = d.validation.errors.length > 0;
  const pkg = isPackagePreview(d) ? d : null;

  const toggle = (id: string, on: boolean) => setSelected((s) => {
    const n = new Set(s);
    if (on) n.add(id);
    else n.delete(id);
    return n;
  });
  const save = async () => {
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = "Give the Blueprint a name.";
    if (key && !KEY_RE.test(key)) next.key = "Use 3 to 64 lower-case letters, digits and dashes, with no dash at either end.";
    if (!kept) next.assets = "Choose at least one asset to keep.";
    setErrors(next);
    if (Object.keys(next).length) return;
    const everything = top.every((e) => effective.has(e.id));
    const res = await run("save", () => saveImportAction(d.id, { name: name.trim(), key: key || undefined, industry, assetIds: everything ? undefined : [...effective] }), "Saved as a draft Blueprint.");
    if (res && typeof res === "object" && "blueprintId" in res) router.push(bpHref.detail(res.blueprintId));
  };

  return (
    <div className="module-stack">
      <PageHero eyebrow={IMPORT_KIND_LABEL[d.sourceKind]} icon={d.sourceKind === "package_file" ? <FileJson className="size-5" /> : <ArrowDownToLine className="size-5" />} title={d.sourceLabel} tone="neutral"
        description={<><ImportStatusBadge status={d.status} /> <span className="ml-1">Read {formatDateTime(d.createdAt, timeZone)}{d.createdBy ? ` by ${d.createdBy}` : ""}. {d.sourceKind === "package_file" ? "Nothing in the file was trusted until it was checked." : "Read through the official API with GET requests only; nothing changed in GoHighLevel."}</span></>}
        action={d.blueprintId ? <ButtonLink href={bpHref.detail(d.blueprintId)} variant="brand">Open the Blueprint</ButtonLink> : undefined} />

      {d.error && <p role="alert" className="flex gap-2 rounded-xl border border-danger/25 bg-danger-soft px-4 py-3 text-[13px] text-danger-ink"><CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />{d.error}</p>}

      {pkg && (
        <ul className="flex flex-wrap gap-2" aria-label="Package checks">
          <CheckChip ok={pkg.integrity === "valid"} warn={pkg.integrity === "missing"} label={pkg.integrity === "valid" ? "Integrity digest matches" : pkg.integrity === "missing" ? "No integrity digest" : "Changed after export"} />
          <CheckChip ok={pkg.manifest === "valid"} warn={pkg.manifest !== "valid"} label={pkg.manifest === "valid" ? "Manifest matches the content" : pkg.manifest === "missing" ? "No manifest (recomputed)" : "Manifest recomputed from the content"} />
          {pkg.upgradedFrom !== null && <CheckChip ok warn label={`Upgraded from format v${pkg.upgradedFrom}`} />}
        </ul>
      )}

      <section aria-label="Conversion summary" className="space-y-4">
        <CompatTotals summary={d.report.summary} unavailable={d.report.unavailable.length} />
        {(d.report.limitations.length > 0 || d.report.unavailable.length > 0) && (
          <div className="grid gap-3 lg:grid-cols-2">
            {d.report.limitations.length > 0 && (
              <div className="rounded-xl border border-line bg-surface-2 px-4 py-3">
                <p className="text-[13px] font-semibold text-ink">Limitations of the source</p>
                <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[12.5px] leading-relaxed text-ink-2">{d.report.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
              </div>
            )}
            {d.report.unavailable.length > 0 && (
              <div className="rounded-xl border border-warning/30 bg-warning-soft px-4 py-3">
                <p className="text-[13px] font-semibold text-warning-ink">Couldn&apos;t be read</p>
                <ul className="mt-1.5 space-y-1 text-[12.5px] leading-relaxed text-warning-ink">{d.report.unavailable.map((u) => <li key={`${u.sourceKind}-${u.reason}`}><span className="font-medium">{sourceKindLabel(u.sourceKind)}:</span> {u.reason}</li>)}</ul>
              </div>
            )}
          </div>
        )}
      </section>

      {(d.validation.errors.length > 0 || d.validation.warnings.length > 0) && (
        <section aria-label="Validation" className="grid gap-3 lg:grid-cols-2">
          {d.validation.errors.length > 0 && <IssueBox tone="danger" title={`${d.validation.errors.length} ${d.validation.errors.length === 1 ? "problem" : "problems"} stop this from being saved`} issues={d.validation.errors} />}
          {d.validation.warnings.length > 0 && <IssueBox tone="warning" title={`${d.validation.warnings.length} ${d.validation.warnings.length === 1 ? "warning" : "warnings"} to review`} issues={d.validation.warnings} />}
        </section>
      )}

      <section aria-label="Items">
        <SectionLabel title="Every item" count={d.report.items.length} description="Each item with how it converted, what was dropped and why, and what a client must set up after applying." />
        <CompatItems report={d.report} id="bp-import-items" />
      </section>

      {editable && content && (
        <Card className="p-5">
          <h2 className="text-[16px] font-semibold text-ink">Save as a Blueprint</h2>
          <p className="mt-1 text-[12.5px] text-muted">It becomes a draft in your library. Nothing reaches a client until you publish a version and apply it.</p>
          <div className="mt-4 grid gap-4 md:grid-cols-3">
            <Field label="Name" htmlFor="bp-import-name" error={errors.name}><Input id="bp-import-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} aria-invalid={Boolean(errors.name)} /></Field>
            <Field label="Industry" htmlFor="bp-import-industry"><Select id="bp-import-industry" value={industry} onChange={(e) => setIndustry(e.target.value as BlueprintIndustry)}>{INDUSTRY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select></Field>
            <Field label="Library key" htmlFor="bp-import-key" optional error={errors.key} hint="Leave empty to make one from the name."><Input id="bp-import-key" value={key} maxLength={64} spellCheck={false} autoCapitalize="none" onChange={(e) => setKey(e.target.value.toLowerCase())} aria-invalid={Boolean(errors.key)} /></Field>
          </div>
          <fieldset className="mt-5">
            <legend className="text-[13px] font-medium text-ink-2">Assets to keep <span className="font-normal text-muted">· {kept} of {top.length}</span></legend>
            {errors.assets && <p role="alert" className="mt-1 text-[12.5px] text-danger-ink">{errors.assets}</p>}
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set(top.map((e) => e.id)))}>Select all</Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
            </div>
            <div className="mt-2 grid gap-3 lg:grid-cols-2">
              {ASSET_SECTIONS.map((section) => {
                const items = top.filter((e) => e.section === section);
                if (!items.length) return null;
                return (
                  <div key={section} className="overflow-hidden rounded-xl border border-line">
                    <p className="border-b border-line bg-surface-2 px-4 py-2 text-[12.5px] font-semibold text-ink">{sectionLabel(section)}</p>
                    <ul className="divide-y divide-line">
                      {items.map((e) => {
                        const auto = effective.has(e.id) && !selected.has(e.id);
                        return (
                          <li key={e.id}>
                            <label className="flex min-h-11 cursor-pointer items-start gap-3 px-4 py-2">
                              <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]" checked={effective.has(e.id)} disabled={auto} onChange={(ev) => toggle(e.id, ev.target.checked)} />
                              <span className="min-w-0">
                                <span className="block break-words text-[13px] text-ink">{e.name}</span>
                                {auto && <span className="inline-flex items-center gap-1 text-[12px] text-primary-ink"><Link2 className="size-3" aria-hidden />Kept because a chosen item needs it</span>}
                              </span>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
            </div>
            {implied.length > 0 && <p className="mt-2 text-[12px] text-muted">{implied.length} {implied.length === 1 ? "asset is" : "assets are"} kept automatically so nothing chosen is left with a broken reference.</p>}
          </fieldset>
          {blocked && <p role="alert" className="mt-4 rounded-xl border border-danger/25 bg-danger-soft px-4 py-3 text-[12.5px] text-danger-ink">Fix the problems listed above at the source and import again; this import can&apos;t be saved as it is.</p>}
          <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <Button variant="brand" loading={busy("save")} disabled={blocked || !kept} onClick={() => void save()}><Save className="size-4" /> Save as Blueprint</Button>
            <Button variant="ghost" onClick={() => setDiscarding(true)}><Trash2 className="size-4" /> Discard</Button>
          </div>
        </Card>
      )}
      {d.status === "previewed" && !canDesign && <p className="rounded-xl border border-line bg-surface-2 px-4 py-3 text-[13px] text-ink-2">Your agency role can view this import but can&apos;t save it as a Blueprint.</p>}
      {d.status === "previewed" && !content && canDesign && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface-2 px-4 py-3">
          <p className="text-[13px] text-ink-2">Nothing could be converted, so there is nothing to save.</p>
          <Button size="sm" variant="ghost" onClick={() => setDiscarding(true)}><Trash2 className="size-3.5" /> Discard</Button>
        </div>
      )}
      {d.status === "discarded" && <p className="rounded-xl border border-line bg-surface-2 px-4 py-3 text-[13px] text-ink-2">Discarded. The report is kept as history.</p>}
      {d.status === "saved" && d.blueprintId && <p className="rounded-xl border border-success/25 bg-success-soft px-4 py-3 text-[13px] text-success-ink">Saved as a Blueprint. <Link href={bpHref.detail(d.blueprintId)} className="font-semibold underline">Open it</Link>.</p>}

      <ConfirmDialog open={discarding} onOpenChange={setDiscarding} title="Discard this import?" danger confirmLabel="Discard" loading={busy("discard")}
        description="Nothing is saved to the library. The conversion report stays in the import history. Nothing changes at the source."
        onConfirm={() => void run("discard", () => discardImportAction(d.id), "Import discarded.").then((r) => r && setDiscarding(false))} />
    </div>
  );
}

function CheckChip({ ok, warn, label }: { ok?: boolean; warn?: boolean; label: string }) {
  const Icon = ok && !warn ? ShieldCheck : warn ? TriangleAlert : ShieldAlert;
  return (
    <li className={cn("inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12px] font-medium",
      ok && !warn ? "border-success/25 bg-success-soft text-success-ink" : warn ? "border-warning/30 bg-warning-soft text-warning-ink" : "border-danger/25 bg-danger-soft text-danger-ink")}>
      <Icon className="size-3.5" aria-hidden />{label}
    </li>
  );
}

function IssueBox({ tone, title, issues }: { tone: "danger" | "warning"; title: string; issues: ValidationIssue[] }) {
  const [all, setAll] = React.useState(false);
  const shown = all ? issues : issues.slice(0, 8);
  return (
    <div className={cn("rounded-xl border px-4 py-3", tone === "danger" ? "border-danger/25 bg-danger-soft text-danger-ink" : "border-warning/30 bg-warning-soft text-warning-ink")}>
      <p className="text-[13px] font-semibold">{title}</p>
      <ul className="mt-1.5 space-y-1 text-[12.5px] leading-relaxed">
        {shown.map((i, n) => <li key={`${i.path}-${i.code}-${n}`}>{i.message}{i.path ? <code className="ml-1 font-mono text-[12px] opacity-80">{i.path}</code> : null}</li>)}
      </ul>
      {issues.length > shown.length && <button type="button" onClick={() => setAll(true)} className="mt-2 min-h-11 text-[12.5px] font-semibold underline sm:min-h-0">Show all {issues.length}</button>}
    </div>
  );
}
