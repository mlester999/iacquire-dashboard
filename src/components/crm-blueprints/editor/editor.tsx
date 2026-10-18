"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertCircle, AlertTriangle, ArrowLeft, CheckCircle2, ChevronDown, Rocket, Save } from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/primitives";
import { ConfirmDialog, ReadOnlyNotice } from "@/components/crm/ui";
import { RelativeTime } from "@/components/crm/relative-time";
import { cn } from "@/lib/utils";
import { validateContent, type ValidationIssue } from "@/lib/crm/blueprints/validate";
import { BLUEPRINT_SOURCE_LABELS, SECTION_LABELS, type AssetSection, type BlueprintContent, type BlueprintSource, type BlueprintStatus } from "@/lib/crm/blueprints/types";
import { saveBlueprintDraftAction } from "@/app/actions/crm-blueprint-editor";
import {
  EDITOR_SECTIONS, SAVE_BLOCKING_CODES, idsWithChildren, indexIssues, referencesTo, removeAsset, saveBlockers, saveSizeProblem, sectionForPath, type EditorSection,
} from "@/components/crm-blueprints/editor/model";
import { EditorContext, RemoveAssetDialog, type EditorApi, type RemoveRequest } from "@/components/crm-blueprints/editor/parts";
import { CustomFieldsSection, CustomValuesSection, DetailsSection, FoldersSection, SlotsSection, TagsSection } from "@/components/crm-blueprints/editor/sections/basics";
import { PipelinesSection } from "@/components/crm-blueprints/editor/sections/pipelines";
import { CalendarsSection } from "@/components/crm-blueprints/editor/sections/calendars";
import { AssignmentRulesSection, SmartListsSection } from "@/components/crm-blueprints/editor/sections/filters";
import { FormsSection } from "@/components/crm-blueprints/editor/sections/forms";
import { TemplatesSection } from "@/components/crm-blueprints/editor/sections/templates";
import { WorkflowsSection } from "@/components/crm-blueprints/editor/sections/workflows";
import { ReportsSection } from "@/components/crm-blueprints/editor/sections/reports";
import { blueprintHref, editHref, publishHref } from "@/components/crm-blueprints/apply/links";

/** What the editor page hands the editor: the Blueprint's working draft and what the library card shows about it. */
export interface EditorBlueprint {
  id: string;
  key: string;
  name: string;
  status: BlueprintStatus;
  source: BlueprintSource;
  sourceLabel: string | null;
  currentVersion: number | null;
  hasUnpublishedChanges: boolean;
  draft: BlueprintContent;
  draftRevision: number;
  draftUpdatedAt: string;
  draftUpdatedBy: string | null;
  canPublish: boolean;
}

const NAV_LABELS: Record<EditorSection, string> = { details: "Details", slots: "Roles", ...SECTION_LABELS };

function sectionCount(content: BlueprintContent, s: EditorSection): number | null {
  if (s === "details") return null;
  if (s === "slots") return content.slots.length;
  return content.assets[s as AssetSection].length;
}

/** Runs the contract validator in the browser. A draft the walkers can't read is reported as one problem instead of breaking the editor. */
function validate(content: BlueprintContent): { errors: ValidationIssue[]; warnings: ValidationIssue[] } {
  try {
    const r = validateContent(content);
    return { errors: r.errors, warnings: r.warnings };
  } catch {
    return { errors: [{ severity: "error", code: "unreadable", path: "", message: "Part of this draft can't be checked. Undo the last change or reload the page.", assetId: null }], warnings: [] };
  }
}

/**
 * The Blueprint editor: every section of the package (details, roles, and the twelve asset sections) with structured editors, the CRM's own
 * form and workflow builders on package-scoped choices, live validation with the contract's validator, removals that offer to clear the
 * references to what is removed, and saving with the draft revision so two people never overwrite each other unknowingly.
 */
export function BlueprintEditor({ blueprint, canEdit, initialSection }: { blueprint: EditorBlueprint; canEdit: boolean; initialSection: EditorSection }) {
  const router = useRouter();
  const readOnly = !canEdit || blueprint.status === "archived";
  const linkBase = editHref(blueprint.id);

  const [content, setContent] = React.useState<BlueprintContent>(blueprint.draft);
  const [dirty, setDirty] = React.useState(false);
  /** The draft revision this copy is based on (what a save sends). */
  const [revision, setRevision] = React.useState(blueprint.draftRevision);
  /** The newest server revision this editor has taken in. */
  const [synced, setSynced] = React.useState(blueprint.draftRevision);
  const [section, setSection] = React.useState<EditorSection>(initialSection);
  const [selected, setSelected] = React.useState<Partial<Record<EditorSection, string | null>>>({});
  const [saving, setSaving] = React.useState(false);
  const [conflict, setConflict] = React.useState(false);
  const [overwrite, setOverwrite] = React.useState(false);
  const [removing, setRemoving] = React.useState<RemoveRequest | null>(null);
  const [problemsOpen, setProblemsOpen] = React.useState(false);
  const edits = React.useRef(0);
  const mainRef = React.useRef<HTMLDivElement>(null);

  // A newer saved draft (a teammate's save, a restored version, "load their version") replaces this copy when nothing here is unsaved.
  if (blueprint.draftRevision > synced && !dirty) {
    setSynced(blueprint.draftRevision);
    setRevision(blueprint.draftRevision);
    setContent(blueprint.draft);
  }
  const serverAhead = blueprint.draftRevision > revision;

  const deferred = React.useDeferredValue(content);
  const checks = React.useMemo(() => validate(deferred), [deferred]);
  const issues = React.useMemo(() => indexIssues([...checks.errors, ...checks.warnings], deferred), [checks, deferred]);
  const blockers = saveBlockers(checks.errors);
  const checking = deferred !== content;

  const edit = React.useCallback<EditorApi["edit"]>((update) => {
    edits.current++;
    setContent((c) => update(c));
    setDirty(true);
  }, []);

  const open = React.useCallback((s: EditorSection, assetId?: string | null) => {
    setSection(s);
    if (assetId !== undefined) setSelected((m) => ({ ...m, [s]: assetId }));
    try {
      const url = new URL(window.location.href);
      if (s === "details") url.searchParams.delete("section");
      else url.searchParams.set("section", s);
      window.history.replaceState(window.history.state, "", url);
    } catch {
      // The address only remembers the section; nothing depends on it.
    }
    requestAnimationFrame(() => mainRef.current?.focus({ preventScroll: false }));
  }, []);

  const select = React.useCallback((s: EditorSection, id: string | null) => setSelected((m) => ({ ...m, [s]: id })), []);

  const remove = React.useCallback<EditorApi["remove"]>((id, label, after) => {
    setRemoving({ id, label, references: referencesTo(content, idsWithChildren(content, id)), after });
  }, [content]);

  const api = React.useMemo<EditorApi>(() => ({ content, edit, readOnly, issues, open, selected, select, remove, linkBase }), [content, edit, readOnly, issues, open, selected, select, remove, linkBase]);

  // Leaving with unsaved changes asks first: closing or reloading the tab, and links to other pages.
  React.useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    const click = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
      const url = new URL(a.href, window.location.href);
      // Links inside the editor (the reused builders' links to a section) stay in the editor: they are handled below, not left.
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname || url.pathname.startsWith(`${linkBase}/`)) return;
      if (!window.confirm("You have unsaved changes to this Blueprint. Leave without saving them?")) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", click, true);
    return () => {
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("click", click, true);
    };
  }, [dirty, linkBase]);

  // The CRM's own builders link to CRM screens under `linkBase` ("<base>/tags"): open the matching section instead of leaving.
  const onClickCapture = (e: React.MouseEvent) => {
    const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a) return;
    const url = new URL(a.href, window.location.href);
    if (url.origin !== window.location.origin || !url.pathname.startsWith(`${linkBase}/`)) return;
    e.preventDefault();
    e.stopPropagation();
    const target = sectionForPath(url.pathname.slice(linkBase.length));
    if (target) open(target, null);
  };

  const save = async (opts: { replace?: boolean } = {}) => {
    const tooBig = saveSizeProblem(content);
    if (tooBig) return void toast.error(tooBig);
    if (blockers.length) {
      setProblemsOpen(true);
      return void toast.error(`Fix ${blockers.length === 1 ? "the problem" : `the ${blockers.length} problems`} marked “can't be saved” first.`);
    }
    const base = opts.replace ? blueprint.draftRevision : revision;
    const sentAt = edits.current;
    setSaving(true);
    try {
      const res = await saveBlueprintDraftAction(blueprint.id, { content, revision: base });
      if (!res.ok) {
        if (res.code === "conflict" && /someone saved/i.test(res.error)) {
          setConflict(true);
          router.refresh();
        } else toast.error(res.error);
        return;
      }
      setRevision(res.data.revision);
      setSynced(res.data.revision);
      if (edits.current === sentAt) setDirty(false);
      toast.success(res.data.errors ? `Draft saved. ${res.data.errors} ${res.data.errors === 1 ? "problem" : "problems"} to fix before it can be published.` : "Draft saved.");
      router.refresh();
    } catch {
      toast.error("That didn't go through. Check your connection and try again.");
    } finally {
      setSaving(false);
      setOverwrite(false);
    }
  };

  const errorCount = checks.errors.length;
  const warningCount = checks.warnings.length;

  return (
    <EditorContext.Provider value={api}>
      <div className="space-y-4" onClickCapture={onClickCapture}>
        <div>
          <Link href={blueprintHref(blueprint.id)} className="inline-flex min-h-11 items-center gap-1.5 text-[13px] font-medium text-muted hover:text-ink sm:min-h-8">
            <ArrowLeft className="size-4" aria-hidden />Back to the Blueprint
          </Link>
          <div className="mt-1 flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11.5px] font-semibold uppercase tracking-[0.06em] text-muted">Blueprint editor</p>
              <h1 className="break-words text-[22px] font-semibold tracking-[-0.03em] text-ink">{content.blueprint.name || blueprint.name}</h1>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[12.5px] text-muted">
                <Badge tone={blueprint.status === "published" ? "success" : blueprint.status === "archived" ? "neutral" : "warning"}>{blueprint.status === "published" ? `Version ${blueprint.currentVersion} published` : blueprint.status === "archived" ? "Archived" : "Never published"}</Badge>
                <Badge tone="outline">{BLUEPRINT_SOURCE_LABELS[blueprint.source]}{blueprint.sourceLabel ? `: ${blueprint.sourceLabel}` : ""}</Badge>
                {!readOnly && <span role="status" aria-live="polite">{saving ? "Saving…" : dirty ? "Unsaved changes" : "All changes saved"}</span>}
                <span>· draft saved <RelativeTime iso={blueprint.draftUpdatedAt} />{blueprint.draftUpdatedBy ? ` by ${blueprint.draftUpdatedBy}` : ""}</span>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {!readOnly && (
                <Button onClick={() => (serverAhead && dirty ? setOverwrite(true) : void save())} loading={saving} disabled={!dirty}>
                  <Save className="size-4" aria-hidden />Save draft
                </Button>
              )}
              {blueprint.canPublish && (
                <ButtonLink href={publishHref(blueprint.id)} variant="secondary" aria-describedby="bp-publish-hint">
                  <Rocket className="size-4" aria-hidden />Review and publish
                </ButtonLink>
              )}
            </div>
          </div>
          {blueprint.canPublish && (
            <p id="bp-publish-hint" className="mt-1.5 text-[12.5px] text-muted">
              {dirty ? "Save the draft first: publishing freezes the saved draft as a new version on the Blueprint's page." : "Publishing freezes the saved draft as a new version on the Blueprint's page. Clients only ever receive published versions."}
            </p>
          )}
        </div>

        {!canEdit && <ReadOnlyNotice>You can look through this Blueprint. Changing it needs the agency&apos;s Blueprint design permission.</ReadOnlyNotice>}
        {canEdit && blueprint.status === "archived" && <ReadOnlyNotice>This Blueprint is archived. Restore it on its page to edit it again.</ReadOnlyNotice>}
        {serverAhead && dirty && (
          <p className="flex flex-wrap items-start gap-2 rounded-2xl border border-warning/30 bg-warning-soft px-4 py-3 text-[13px] text-warning-ink" role="status">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1">Someone else saved this Blueprint after you opened it. Saving now replaces their changes with yours.</span>
            <Button variant="secondary" size="sm" onClick={() => { setDirty(false); setSynced(-1); router.refresh(); }}>Load their version</Button>
          </p>
        )}

        <div className="grid gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
          <nav aria-label="Blueprint sections" className="lg:sticky lg:top-24 lg:self-start">
            <ul className="scrollbar-thin -mx-1 flex gap-1 overflow-x-auto px-1 pb-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0">
              {EDITOR_SECTIONS.map((s) => {
                const active = s === section;
                const count = sectionCount(content, s);
                const st = issues.bySection[s];
                return (
                  <li key={s} className="shrink-0">
                    <button
                      type="button"
                      onClick={() => open(s)}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-left text-[13px] font-medium transition-colors lg:min-h-9",
                        active ? "bg-surface text-ink shadow-soft ring-1 ring-line" : "text-muted hover:bg-surface-2 hover:text-ink",
                      )}
                    >
                      <span className="flex-1 whitespace-nowrap">{NAV_LABELS[s]}</span>
                      {count !== null && <span className="rounded-full bg-surface-3 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-ink-2">{count}</span>}
                      {st.errors > 0 ? <span role="img" className="size-2 rounded-full bg-danger" aria-label={`${st.errors} to fix`} /> : st.warnings > 0 ? <span role="img" className="size-2 rounded-full bg-warning" aria-label={`${st.warnings} to check`} /> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>

          <div className="min-w-0 space-y-4">
            <ProblemsBar
              errors={checks.errors}
              warnings={checks.warnings}
              blockers={blockers.length}
              checking={checking}
              open={problemsOpen}
              onToggle={() => setProblemsOpen((o) => !o)}
              located={issues.located}
              onGo={(s, id) => open(s, id)}
              counts={{ errors: errorCount, warnings: warningCount }}
            />
            <div ref={mainRef} tabIndex={-1} className="outline-none" aria-label={NAV_LABELS[section]} role="region">
              {section === "details" && <DetailsSection blueprintKey={blueprint.key} />}
              {section === "slots" && <SlotsSection />}
              {section === "folders" && <FoldersSection />}
              {section === "tags" && <TagsSection />}
              {section === "customFields" && <CustomFieldsSection />}
              {section === "customValues" && <CustomValuesSection />}
              {section === "pipelines" && <PipelinesSection />}
              {section === "calendars" && <CalendarsSection />}
              {section === "smartLists" && <SmartListsSection />}
              {section === "assignmentRules" && <AssignmentRulesSection />}
              {section === "forms" && <FormsSection />}
              {section === "messageTemplates" && <TemplatesSection />}
              {section === "workflows" && <WorkflowsSection />}
              {section === "reports" && <ReportsSection />}
            </div>
          </div>
        </div>
      </div>

      <RemoveAssetDialog
        request={removing}
        onClose={() => setRemoving(null)}
        onRemove={(stripRefs) => {
          if (!removing) return;
          const { id, after } = removing;
          edit((c) => removeAsset(c, id, { stripRefs }));
          setSelected((m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v === id ? null : v])));
          setRemoving(null);
          after?.();
          toast(stripRefs ? "Removed, with its references. Save the draft to keep the change." : "Removed. Save the draft to keep the change.");
        }}
      />
      <ConfirmDialog
        open={conflict}
        onOpenChange={setConflict}
        title="Someone saved this Blueprint after you opened it"
        description="Load their version to see it (your unsaved changes here are lost), or keep your changes: saving them then replaces their version."
        confirmLabel="Load their version"
        onConfirm={() => {
          setConflict(false);
          setDirty(false);
          setSynced(-1);
          router.refresh();
        }}
      />
      <ConfirmDialog
        open={overwrite}
        onOpenChange={setOverwrite}
        title="Replace the newer saved version?"
        description="Someone saved this Blueprint after you opened it. Saving yours replaces everything they changed. Their version can't be brought back afterwards unless it was published."
        confirmLabel="Save mine instead"
        danger
        loading={saving}
        onConfirm={() => void save({ replace: true })}
      />
    </EditorContext.Provider>
  );
}

function ProblemsBar({
  errors, warnings, blockers, checking, open, onToggle, located, onGo, counts,
}: {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  blockers: number;
  checking: boolean;
  open: boolean;
  onToggle: () => void;
  located: ReturnType<typeof indexIssues>["located"];
  onGo: (s: EditorSection, id: string | null) => void;
  counts: { errors: number; warnings: number };
}) {
  const none = !errors.length && !warnings.length;
  const sorted = [...located].sort((a, b) => (a.severity === b.severity ? EDITOR_SECTIONS.indexOf(a.section) - EDITOR_SECTIONS.indexOf(b.section) : a.severity === "error" ? -1 : 1));
  return (
    <Card className="p-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-[13px]" role="status" aria-live="polite">
          {none ? (
            <span className="inline-flex items-center gap-1.5 font-medium text-success-ink"><CheckCircle2 className="size-4" aria-hidden />No problems found{checking ? " (checking…)" : ""}</span>
          ) : (
            <>
              {counts.errors > 0 && <span className="inline-flex items-center gap-1.5 font-medium text-danger-ink"><AlertCircle className="size-4" aria-hidden />{counts.errors} to fix before publishing</span>}
              {counts.warnings > 0 && <span className="inline-flex items-center gap-1.5 text-warning-ink"><AlertTriangle className="size-4" aria-hidden />{counts.warnings} to check</span>}
              {blockers > 0 && <Badge tone="danger">{blockers} can&apos;t be saved</Badge>}
              {checking && <span className="text-muted">checking…</span>}
            </>
          )}
        </div>
        {!none && (
          <Button variant="ghost" size="sm" onClick={onToggle} aria-expanded={open} aria-controls="bp-problems">
            {open ? "Hide problems" : "Show problems"}<ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} aria-hidden />
          </Button>
        )}
      </div>
      {open && !none && (
        <ul id="bp-problems" className="mt-3 max-h-[min(420px,60dvh)] space-y-1.5 overflow-y-auto scrollbar-thin" aria-label="Problems">
          {sorted.slice(0, 200).map((i, n) => (
            <li key={`${i.code}-${i.path}-${n}`}>
              <button type="button" onClick={() => onGo(i.section, i.assetId)} className={cn("flex w-full items-start gap-2 rounded-xl px-3 py-2 text-left text-[12.5px] leading-relaxed hover:brightness-95", i.severity === "error" ? "bg-danger-soft text-danger-ink" : "bg-warning-soft text-warning-ink")}>
                {i.severity === "error" ? <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden /> : <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />}
                <span className="min-w-0">
                  <span className="font-semibold">{NAV_LABELS[i.section]}{i.severity === "error" && SAVE_BLOCKING_CODES.has(i.code) ? " · can't be saved" : ""}:</span>{" "}
                  {i.message}
                </span>
              </button>
            </li>
          ))}
          {sorted.length > 200 && <li className="px-3 text-[12px] text-muted">and {sorted.length - 200} more</li>}
        </ul>
      )}
    </Card>
  );
}
