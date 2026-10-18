"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Archive, ArchiveRestore, CircleAlert, Copy, Download, Eye, Layers, MoreHorizontal, Pencil, Rocket, Send, TriangleAlert } from "lucide-react";
import { archiveBlueprintAction, createBlueprintAction, unarchiveBlueprintAction } from "@/app/actions/crm-blueprints";
import { Button, ButtonLink } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Tabs } from "@/components/ui/overlays";
import { Badge, Card } from "@/components/ui/primitives";
import { PageHero, SectionLabel } from "@/components/ui/workspace";
import { ConfirmDialog } from "@/components/crm/ui";
import { useUrlState } from "@/components/website/gallery/use-url-state";
import { formatDateTime } from "@/lib/utils";
import { reportForContent } from "@/lib/crm/blueprints/report";
import { BLUEPRINT_FORMAT, BLUEPRINT_SOURCE_LABELS, SECTION_LABELS } from "@/lib/crm/blueprints/types";
import type { ApplicationSummary, BlueprintDetail, UpdateCandidate } from "@/lib/crm/blueprints/views";
import { buildAssetIndex } from "@/components/crm-blueprints/asset-index";
import { AssetsInspector } from "@/components/crm-blueprints/assets-inspector";
import { VersionsPanel, issueLines } from "@/components/crm-blueprints/versions-panel";
import { ApplicationsTable, UpdateCandidates } from "@/components/crm-blueprints/applications";
import {
  CompatItems, CompatTotals, CompatibilityBadge, CopyValue, DownloadLink, InfoList, RequirementList, SourceBadge, StatusBadge, When, bpHref, compatibilityHint, industryLabel,
  sourceKindLabel, useBlueprintAction, type BlueprintUiPermissions,
} from "@/components/crm-blueprints/shared";
import { dropParams } from "@/components/crm-blueprints/url-params";

const TABS = ["overview", "assets", "versions", "applications", "details"] as const;
type Tab = (typeof TABS)[number];
const URL_DEFAULTS = { tab: "overview" };
const URL_ALLOWED = { tab: TABS };

export interface BlueprintDetailViewProps {
  blueprint: BlueprintDetail;
  applications: ApplicationSummary[];
  updateCandidates: UpdateCandidate[];
  permissions: BlueprintUiPermissions;
  /** ?publish=1 (from a library card): opens the publish dialog on the Versions tab. */
  openPublish?: boolean;
  /** The signed-in person's time zone, so the server and the browser render the same times. */
  timeZone?: string;
  preview?: boolean;
}

/** One Blueprint: what it contains, what each client must still set up, its versions, where it is applied, and its technical details. */
export function BlueprintDetailView({ blueprint: b, applications, updateCandidates, permissions, openPublish, timeZone, preview }: BlueprintDetailViewProps) {
  const router = useRouter();
  const { run, busy } = useBlueprintAction(preview);
  const [url, setUrl] = useUrlState(URL_DEFAULTS, URL_ALLOWED);
  const tab = (TABS as readonly string[]).includes(url.tab) ? (url.tab as Tab) : "overview";
  const [archiving, setArchiving] = React.useState(false);
  const archived = b.status === "archived";
  const can = {
    design: permissions.design && b.canDesign,
    publish: permissions.publish && b.canPublish,
    apply: permissions.apply && b.canApply,
    export: permissions.export,
  };
  // Staff who design can run the dry run (the apply page shows it read-only) but not apply.
  const previewOnly = can.design && !can.apply && b.status === "published" && !!b.currentVersion;
  // The publish dialog's state lives here, not in the Versions tab: the tab unmounts when another one is shown, and a dialog that was
  // closed must stay closed when the tab comes back. ?publish=1 opens it once; closing it takes the parameter out of the address.
  const [publishing, setPublishing] = React.useState(Boolean(openPublish && can.publish && !archived));
  const onPublishingChange = (open: boolean) => {
    setPublishing(open);
    if (!open) dropParams("publish");
  };
  const shown = b.published ?? b.draft;
  const latest = b.versions.reduce<number | null>((n, v) => (n === null || v.version > n ? v.version : n), null) ?? b.currentVersion;
  const latestDigest = b.versions.find((v) => v.version === latest)?.digest ?? null;
  const live = applications.filter((a) => a.status === "applied" || a.status === "partially_applied");

  const duplicate = async () => {
    const res = await run("duplicate", () => createBlueprintAction({
      name: `${b.name.slice(0, 73)} (copy)`, description: b.description || undefined, industry: b.industry, folderId: b.folderId, from: { kind: "duplicate", blueprintId: b.id, version: "draft" },
    }), "Duplicated as a new draft.");
    if (res && typeof res === "object" && "id" in res) router.push(bpHref.detail(res.id));
  };

  return (
    <div className="module-stack">
      <PageHero tone="neutral" icon={<Layers className="size-5" />} eyebrow={`${industryLabel(b.industry)} · ${BLUEPRINT_SOURCE_LABELS[b.source]}`} title={b.name}
        description={b.description || "No description yet."}
        action={<>
          {can.design && !archived && <ButtonLink href={bpHref.edit(b.id)} variant="secondary"><Pencil className="size-4" /> Edit draft</ButtonLink>}
          {can.publish && !archived && <Button variant="secondary" onClick={() => { setUrl({ tab: "versions" }); setPublishing(true); }}><Rocket className="size-4" /> Publish</Button>}
          {can.apply && b.status === "published" && <ButtonLink href={bpHref.apply(b.id)} variant="brand"><Send className="size-4" /> Apply to client</ButtonLink>}
          {previewOnly && <ButtonLink href={bpHref.apply(b.id)} variant="secondary"><Eye className="size-4" /> Preview applying</ButtonLink>}
          {can.export && b.currentVersion && <DownloadLink href={bpHref.exportFile(b.id, b.currentVersion)} label={`Export version ${b.currentVersion}`} variant="secondary" className="h-11 sm:h-10"><Download className="size-4" aria-hidden /> Export</DownloadLink>}
          {can.design && (
            <Menu>
              <MenuTrigger asChild><Button variant="ghost" size="icon" aria-label={`More actions for ${b.name}`}><MoreHorizontal className="size-4" /></Button></MenuTrigger>
              <MenuContent align="end">
                {!archived && <MenuItem onSelect={() => void duplicate()} disabled={busy("duplicate")}><Copy className="size-3.5" /> Duplicate</MenuItem>}
                <MenuSeparator />
                {!archived ? <MenuItem destructive onSelect={() => setArchiving(true)}><Archive className="size-3.5" /> Archive</MenuItem>
                  : <MenuItem onSelect={() => void run("restore", () => unarchiveBlueprintAction(b.id), "Restored to the library.")}><ArchiveRestore className="size-3.5" /> Restore</MenuItem>}
              </MenuContent>
            </Menu>
          )}
        </>}
        aside={
          <div className="space-y-2.5 rounded-2xl border border-line bg-surface/80 p-4 text-[12.5px] shadow-soft">
            <div className="flex flex-wrap items-center gap-2"><StatusBadge status={b.status} /><Badge tone="outline">{b.currentVersion ? `Version ${b.currentVersion}` : "Never published"}</Badge></div>
            <CompatibilityBadge value={b.compatibility} notes={b.compatibilityNotes} />
            <p className="text-muted">{live.length ? `Live in ${live.length} client ${live.length === 1 ? "workspace" : "workspaces"}` : "Not applied to any client yet"}</p>
            {b.hasUnpublishedChanges && b.currentVersion && <p className="font-medium text-warning-ink">The working draft has unpublished changes.</p>}
            <p className="text-muted"><When iso={b.updatedAt} prefix="Updated" timeZone={timeZone} /></p>
          </div>
        } />

      {archived && <p className="rounded-xl border border-line bg-surface-2 px-4 py-3 text-[13px] text-ink-2">Archived. It can&apos;t be applied to another client. Clients that already applied it keep their own copies.</p>}

      <Tabs id="bp-detail" value={tab} onValueChange={(v) => setUrl({ tab: v })} items={[
        { value: "overview", label: "Overview" },
        { value: "assets", label: "Assets", count: b.totalAssets },
        { value: "versions", label: "Versions", count: b.versions.length },
        { value: "applications", label: "Applications", count: applications.length },
        { value: "details", label: "Details" },
      ]}>
        {tab === "overview" && <Overview b={b} shown={shown} timeZone={timeZone} />}
        {tab === "assets" && <AssetsInspector draft={b.draft} published={b.published} publishedVersion={b.currentVersion} />}
        {tab === "versions" && <VersionsPanel blueprint={b} can={can} publishing={publishing && can.publish && !archived} onPublishingChange={onPublishingChange} timeZone={timeZone} preview={preview} />}
        {tab === "applications" && (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="max-w-2xl text-[13px] leading-relaxed text-muted">Each client got an independent copy. Changes a client makes stay theirs; a newer version reaches a client only when you review it for them.</p>
              {can.apply && b.status === "published" && <ButtonLink href={bpHref.apply(b.id)} variant="soft" size="sm"><Send className="size-3.5" /> Apply to another client</ButtonLink>}
              {previewOnly && <ButtonLink href={bpHref.apply(b.id)} variant="soft" size="sm"><Eye className="size-3.5" /> Preview applying</ButtonLink>}
            </div>
            <ApplicationsTable applications={applications} canApply={can.apply} canPreview={can.design && !archived} show={{ client: true, blueprint: false }} caption={`Applications of ${b.name}`} />
            {b.currentVersion && <UpdateCandidates blueprintId={b.id} candidates={updateCandidates} canApply={can.apply} canPreview={can.design && !archived} />}
          </div>
        )}
        {tab === "details" && <Details b={b} latestDigest={latestDigest} timeZone={timeZone} />}
      </Tabs>

      <ConfirmDialog open={archiving} onOpenChange={setArchiving} title={`Archive “${b.name}”?`} danger confirmLabel="Archive" loading={busy("archive")}
        description="It leaves the library's active collections and can't be applied to another client. Clients that already applied it keep their own copies, and nothing in their CRM changes. You can restore it later."
        onConfirm={() => void run("archive", () => archiveBlueprintAction(b.id), "Archived.").then((r) => r && setArchiving(false))} />
    </div>
  );
}

function Overview({ b, shown, timeZone }: { b: BlueprintDetail; shown: BlueprintDetail["draft"]; timeZone?: string }) {
  const names = React.useMemo(() => {
    const m = buildAssetIndex(b.draft).names;
    if (b.published) for (const [k, v] of buildAssetIndex(b.published).names) m.set(k, v);
    return m;
  }, [b.draft, b.published]);
  const readiness = React.useMemo(() => (b.importReport ? null : reportForContent(shown)), [b.importReport, shown]);
  const which = b.published ? `version ${b.currentVersion}` : "the working draft (never published)";
  return (
    <div className="space-y-8">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-8">
          <section aria-label="What's inside">
            <SectionLabel title="What's inside" description={`From ${which}. Stages and appointment types travel with their pipeline or calendar.`} />
            {b.modules.length ? (
              <ul className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                {b.modules.map((m) => (
                  <li key={m.section} className="rounded-xl border border-line bg-surface px-3.5 py-3 shadow-soft">
                    <p className="text-[11.5px] font-medium text-muted">{SECTION_LABELS[m.section]}</p>
                    <p className="mt-1 text-[22px] font-semibold tabular-nums tracking-[-0.03em] text-ink">{m.count}</p>
                  </li>
                ))}
              </ul>
            ) : <p className="rounded-xl border border-dashed border-line-strong px-4 py-6 text-center text-[13px] text-muted">No CRM assets yet. Add them in the editor.</p>}
          </section>
          <section aria-label="Setup each client completes">
            <SectionLabel title="Setup each client completes" count={b.requirementDetails.length}
              description="After applying, these appear on the client's setup checklist. Nothing is shown as connected or approved until there is evidence in that workspace." />
            <RequirementList details={b.requirementDetails} assetNames={names} />
          </section>
        </div>
        <aside className="space-y-4" aria-label="Provenance and draft health">
          <Card className="p-4">
            <h3 className="text-[13.5px] font-semibold text-ink">Where it came from</h3>
            <div className="mt-2"><SourceBadge source={b.source} /></div>
            <ul className="mt-3 space-y-1.5 text-[12.5px] text-ink-2">
              {b.sourceLabel && <li>{b.sourceLabel}</li>}
              {b.provenance.sourceOrgName && <li>Captured from <span className="font-medium text-ink">{b.provenance.sourceOrgName}</span> (configuration only)</li>}
              {b.provenance.starterKey && <li>iAcquire starter <code className="font-mono text-[11.5px]">{b.provenance.starterKey}</code></li>}
              {b.provenance.importId && <li><Link href={bpHref.importDetail(b.provenance.importId)} className="font-medium text-primary-ink hover:underline">Open the import report</Link></li>}
              <li className="text-muted">Created {formatDateTime(b.createdAt, timeZone)}</li>
            </ul>
          </Card>
          <Card className="p-4">
            <h3 className="text-[13.5px] font-semibold text-ink">Working draft</h3>
            {b.draftErrors.length === 0 && b.draftWarnings.length === 0 ? (
              <p className="mt-2 text-[12.5px] text-muted">Valid, with no warnings.</p>
            ) : (
              <div className="mt-2 space-y-2 text-[12.5px]">
                {b.draftErrors.length > 0 && <div className="flex gap-2 text-danger-ink"><CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden /><div><p className="font-medium">{b.draftErrors.length} {b.draftErrors.length === 1 ? "problem" : "problems"} to fix before publishing</p><ul className="mt-0.5 text-[12px]">{issueLines(b.draftErrors).map((l) => <li key={l}>{l}</li>)}</ul></div></div>}
                {b.draftWarnings.length > 0 && <div className="flex gap-2 text-warning-ink"><TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden /><div><p className="font-medium">{b.draftWarnings.length} {b.draftWarnings.length === 1 ? "warning" : "warnings"}</p><ul className="mt-0.5 list-disc pl-4 text-[12px]">{b.draftWarnings.slice(0, 3).map((w, i) => <li key={`${w.path}-${i}`}>{w.message}</li>)}</ul></div></div>}
              </div>
            )}
          </Card>
          <Card className="p-4">
            <h3 className="text-[13.5px] font-semibold text-ink">Compatibility</h3>
            <div className="mt-2"><CompatibilityBadge value={b.compatibility} notes={b.compatibilityNotes} /></div>
            <p className="mt-2 text-[12.5px] leading-relaxed text-muted">{compatibilityHint(b.compatibility)}</p>
            {b.compatibilityNotes.length > 0 && <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[12.5px] text-ink-2">{b.compatibilityNotes.map((n) => <li key={n}>{n}</li>)}</ul>}
          </Card>
        </aside>
      </div>

      {b.importReport ? (
        <section aria-label="Import report" className="space-y-4">
          <SectionLabel title="Compatibility report" description={`How each item of the ${b.source === "ghl_import" ? "GoHighLevel" : "package"} import converted. Items that only came over by name are never counted as converted.`} />
          <CompatTotals summary={b.importReport.summary} unavailable={b.importReport.unavailable.length} />
          {(b.importReport.limitations.length > 0 || b.importReport.unavailable.length > 0) && (
            <div className="grid gap-3 lg:grid-cols-2">
              {b.importReport.limitations.length > 0 && <NoteList title="Limitations of the source" items={b.importReport.limitations} />}
              {b.importReport.unavailable.length > 0 && <NoteList title="Couldn't be read" items={b.importReport.unavailable.map((u) => `${sourceKindLabel(u.sourceKind)}: ${u.reason}`)} />}
            </div>
          )}
          <CompatItems report={b.importReport} id="bp-detail-report" />
        </section>
      ) : readiness && readiness.items.length > 0 ? (
        <section aria-label="Readiness by asset" className="space-y-4">
          <SectionLabel title="Readiness by asset" description={`What each asset in ${which} needs once it is applied: ready as is, a mapping per client, a provider connection, or a rebuild.`} />
          <CompatItems report={readiness} id="bp-detail-readiness" />
        </section>
      ) : null}
    </div>
  );
}

function NoteList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="rounded-xl border border-line bg-surface-2 px-4 py-3">
      <p className="text-[13px] font-semibold text-ink">{title}</p>
      <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[12.5px] leading-relaxed text-ink-2">{items.map((x) => <li key={x}>{x}</li>)}</ul>
    </div>
  );
}

function Details({ b, latestDigest, timeZone }: { b: BlueprintDetail; latestDigest: string | null; timeZone?: string }) {
  return (
    <InfoList items={[
      { label: "Library key", value: <CopyValue value={b.key} label="library key" /> },
      { label: "Blueprint ID", value: <CopyValue value={b.id} label="Blueprint ID" /> },
      { label: "Status", value: <StatusBadge status={b.status} /> },
      { label: "Latest version", value: b.currentVersion ? `Version ${b.currentVersion}` : "Never published" },
      { label: "Latest digest (sha256)", value: latestDigest ? <CopyValue value={latestDigest} label="digest" /> : "—" },
      { label: "Package format", value: <><code className="font-mono text-[12px]">{BLUEPRINT_FORMAT}</code> · schema version {b.draft.schemaVersion}</> },
      { label: "Draft revision", value: `${b.draftRevision} · saved ${formatDateTime(b.draftUpdatedAt, timeZone)}${b.draftUpdatedBy ? ` by ${b.draftUpdatedBy}` : ""}` },
      { label: "Source", value: <>{BLUEPRINT_SOURCE_LABELS[b.source]}{b.sourceLabel ? ` · ${b.sourceLabel}` : ""}</> },
      ...(b.provenance.sourceOrgName ? [{ label: "Captured from", value: b.provenance.sourceOrgName }] : []),
      ...(b.provenance.starterKey ? [{ label: "Starter key", value: <code className="font-mono text-[12px]">{b.provenance.starterKey}</code> }] : []),
      ...(b.provenance.importId ? [{ label: "Import record", value: <Link href={bpHref.importDetail(b.provenance.importId)} className="text-primary-ink hover:underline">{b.provenance.importId}</Link> }] : []),
      { label: "Industry", value: industryLabel(b.industry) },
      { label: "Folder", value: b.folderName ?? "Unfiled" },
      { label: "Featured", value: b.featured ? "Yes" : "No" },
      { label: "Created", value: formatDateTime(b.createdAt, timeZone) },
      { label: "Updated", value: formatDateTime(b.updatedAt, timeZone) },
    ]} />
  );
}
