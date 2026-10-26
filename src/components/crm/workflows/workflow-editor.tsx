"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, Archive, ArrowLeft, CheckCircle2, Copy, FlaskConical, MoreHorizontal, Pause, Play, PlayCircle, Rocket, Save, ShieldAlert, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/primitives";
import { Dialog, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Sheet, Tabs } from "@/components/ui/overlays";
import { ConfirmDialog, ReadOnlyNotice, RecordPicker, useCrmAction } from "@/components/crm/ui";
import { searchContactsAction } from "@/app/actions/crm";
import { cloneWorkflowAction, publishWorkflowAction, saveWorkflowDraftAction, setWorkflowStatusAction, startManualRunAction } from "@/app/actions/crm-workflows";
import { cn, formatDateTime } from "@/lib/utils";
import { RelativeTime } from "@/components/crm/relative-time";
import { deriveEffects, TRIGGERS, validateDefinition, type StepKind, type ValidationIssue, type WorkflowDefinition } from "@/lib/crm/workflow/spec";
import type { CrmScope } from "@/server/crm/page";
import { WorkflowCanvas, type CanvasIssue } from "@/components/crm/workflows/canvas";
import { AddStepMenu } from "@/components/crm/workflows/add-step-menu";
import { activationBlocker, focusTargetAfterRemove, groupIssues, kindChoices, newStep, readinessIssues, validationContextOf } from "@/components/crm/workflows/editor-logic";
import { branchMembers, canInsert, canMove, insertStep, layoutCanvas, moveStep, orderedKeys, removeStep, type InsertPoint } from "@/components/crm/workflows/graph";
import { StepPanel } from "@/components/crm/workflows/step-panel";
import { TriggerPanel } from "@/components/crm/workflows/trigger-panel";
import { ApprovalDialog } from "@/components/crm/workflows/approval-dialog";
import { TestRunDialog } from "@/components/crm/workflows/test-run";
import { VersionsList, approvalBadge } from "@/components/crm/workflows/versions";
import { WorkflowSettingsForm } from "@/components/crm/workflows/settings-form";
import { RunsList } from "@/components/crm/workflows/runs-list";
import { WorkflowStatusBadge } from "@/components/crm/workflows/parts";
import { branchSideLabels, effectLabel, EFFECT_TONE, kindLabel, namesFrom, stepSummary, triggerSummary, type RunFilter } from "@/components/crm/workflows/summaries";
import { useMediaQuery } from "@/components/crm/workflows/use-media";
import type { EditorOptions, EditorWorkflow, RunGate, RunListItem, VersionItem } from "@/components/crm/workflows/types";

export type EditorTab = "builder" | "runs" | "versions" | "settings";

export interface WorkflowEditorProps {
  scope: CrmScope;
  workflow: EditorWorkflow;
  versions: VersionItem[];
  options: EditorOptions;
  runs: { items: RunListItem[]; total: number; filter: RunFilter; nextBefore: string | null; paged: boolean };
  gate: RunGate;
  canManage: boolean;
  initialTab: EditorTab;
}

const toCanvas = (list: ValidationIssue[] | undefined): CanvasIssue[] => (list ?? []).map((i) => ({ severity: i.level, message: i.message }));

export function WorkflowEditor({ scope, workflow, versions, options, runs, gate, canManage, initialTab }: WorkflowEditorProps) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { run, busy } = useCrmAction();
  const wide = useMediaQuery("(min-width: 1024px)");
  // An archived workflow is kept as it was: restore it to change it.
  const readOnly = !canManage || workflow.status === "archived";

  const [tab, setTab] = React.useState<EditorTab>(initialTab);
  const [def, setDef] = React.useState<WorkflowDefinition>(workflow.draft);
  const [revision, setRevision] = React.useState(workflow.draftRevision);
  /** The server revision the editor's copy last came from (or was saved as). */
  const [synced, setSynced] = React.useState(workflow.draftRevision);
  const [dirty, setDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [conflict, setConflict] = React.useState(false);
  const [removing, setRemoving] = React.useState<{ key: string; count: number } | null>(null);
  const [approvalFor, setApprovalFor] = React.useState<VersionItem | null>(null);
  const [viewing, setViewing] = React.useState<VersionItem | null>(null);
  const [testing, setTesting] = React.useState(false);
  const [confirmPublish, setConfirmPublish] = React.useState(false);
  const [archiving, setArchiving] = React.useState(false);
  const [starting, setStarting] = React.useState(false);
  /** After a step is removed, the card that gets keyboard focus (the removed card, its menu or the panel button no longer exists). */
  const [refocus, setRefocus] = React.useState<{ key: string } | null>(null);
  const canvasRef = React.useRef<HTMLDivElement>(null);

  // A newer saved draft from the server (a teammate, another tab, or "load the latest") replaces the editor's copy when nothing is unsaved
  // here. Adjusted while rendering, as React recommends for state that follows a prop; our own save already moved `synced` forward.
  if (workflow.draftRevision > synced && !dirty) {
    setSynced(workflow.draftRevision);
    setDef(workflow.draft);
    setRevision(workflow.draftRevision);
  }

  // Focus moves once the removed card and the menu, dialog or panel that had focus are gone, so it doesn't fall back to the page.
  React.useEffect(() => {
    if (!refocus) return;
    const t = window.setTimeout(() => {
      const root = canvasRef.current;
      const cards = Array.from(root?.querySelectorAll<HTMLElement>("[data-step-card]") ?? []);
      (cards.find((el) => el.dataset.stepCard === refocus.key) ?? cards.find((el) => el.dataset.stepCard === "trigger"))?.focus();
    }, 0);
    return () => window.clearTimeout(t);
  }, [refocus]);

  // Leaving with unsaved changes asks first.
  React.useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const ctx = React.useMemo(() => validationContextOf(options), [options]);
  const names = React.useMemo(() => namesFrom(options), [options]);
  // The validator's problems, plus warnings for steps set up right that can't act yet (an AI employee that isn't connected, n8n calls off).
  const issues = React.useMemo(() => groupIssues([...validateDefinition(def, ctx), ...readinessIssues(def, options)]), [def, ctx, options]);
  const layout = React.useMemo(() => layoutCanvas(def.steps), [def.steps]);
  const numbers = React.useMemo(() => Object.fromEntries(orderedKeys(layout.items).map((k, i) => [k, i + 1])), [layout]);
  const byKey = React.useMemo(() => new Map(def.steps.map((s) => [s.key, s])), [def.steps]);
  const summaries = React.useMemo(() => Object.fromEntries(def.steps.map((s) => [s.key, s.name?.trim() ? `${s.name} · ${stepSummary(s, names)}` : stepSummary(s, names)])), [def.steps, names]);
  const branchLabels = React.useMemo(() => Object.fromEntries(def.steps.filter((s) => s.kind === "branch").map((s) => [s.key, branchSideLabels(s, names)])), [def.steps, names]);
  const trig = triggerSummary(def.trigger, names);
  const choices = React.useMemo(() => kindChoices(options), [options]);
  const effects = React.useMemo(() => deriveEffects(def), [def]);
  const published = versions.find((v) => v.current) ?? null;
  const blocker = activationBlocker({ status: workflow.status, publishedVersion: published, gate });
  const approvalsHref = scope.agency ? null : "/approvals";
  const canRequestApproval = canManage && workflow.status !== "archived";

  const edit = (next: WorkflowDefinition) => {
    setDef(next);
    setDirty(true);
  };
  const setTabUrl = (t: string) => {
    setTab(t as EditorTab);
    const sp = new URLSearchParams(params.toString());
    if (t === "builder") sp.delete("tab");
    else sp.set("tab", t);
    for (const k of ["status", "before"]) if (t !== "runs") sp.delete(k);
    router.replace(`${pathname}${sp.toString() ? `?${sp}` : ""}`, { scroll: false });
  };

  /** Saves the working copy; resolves to the new revision, or null when it wasn't saved (a conflict opens the reload dialog). */
  const save = async (): Promise<number | null> => {
    setSaving(true);
    try {
      const res = await saveWorkflowDraftAction(scope.orgId, workflow.id, { definition: def, expectedRevision: revision });
      if (!res.ok) {
        if (res.code === "conflict") setConflict(true);
        else toast.error(res.error);
        return null;
      }
      setRevision(res.data.revision);
      setSynced(res.data.revision);
      setDirty(false);
      toast.success("Draft saved.");
      router.refresh();
      return res.data.revision;
    } catch {
      toast.error("That didn't go through. Check your connection and try again.");
      return null;
    } finally {
      setSaving(false);
    }
  };

  const publish = async () => {
    const rev = dirty ? await save() : revision;
    if (rev === null) return;
    const out = await run("publish", () => publishWorkflowAction(scope.orgId, workflow.id, { expectedRevision: rev }), (d) =>
      !d.created ? `Nothing changed since version ${d.version}, so no new version was made.`
      : d.pausedForApproval ? `Version ${d.version} published. The workflow is paused until the owner approves it.`
      : d.needsApproval ? `Version ${d.version} published. The owner approves it before it runs.`
      : d.status === "active" ? `Version ${d.version} published. New runs use it from now on.`
      : `Version ${d.version} published.`);
    setConfirmPublish(false);
    if (out?.needsApproval) setTabUrl("versions");
  };

  const insertAt = (at: InsertPoint, kind: string) => {
    const k = kind as StepKind;
    if (!canInsert(def.steps, at, k)) {
      toast.error("An End step only goes where nothing follows.");
      return;
    }
    const step = newStep(def.steps, k, options);
    const followed = k === "branch" && !!(at.after === null ? def.steps[0] : at.via === "next" ? byKey.get(at.after)?.next : null);
    edit({ ...def, steps: insertStep(def.steps, at, step) });
    setSelected(step.key);
    if (followed) toast("The steps that followed now run on the Yes path. Add steps to the No path as needed.");
  };
  const askRemove = (key: string) => {
    const s = byKey.get(key);
    if (!s) return;
    const members = s.kind === "branch" ? branchMembers(def.steps, key).length : 0;
    if (members) setRemoving({ key, count: members });
    else doRemove(key);
  };
  const doRemove = (key: string) => {
    const focusTo = focusTargetAfterRemove(def.steps, key);
    const next = removeStep(def.steps, key);
    edit({ ...def, steps: next });
    if (selected === key || (selected && selected !== "trigger" && !next.some((s) => s.key === selected))) setSelected(null);
    setRemoving(null);
    setRefocus({ key: focusTo });
  };

  const selectedStep = selected && selected !== "trigger" ? byKey.get(selected) ?? null : null;
  const panel = selected === "trigger" ? (
    <TriggerPanel trigger={def.trigger} options={options} issues={issues.trigger} readOnly={readOnly} inboundUrl={workflow.inboundUrl} inboundHidden={workflow.inboundHidden} onChange={(trigger) => edit({ ...def, trigger })} />
  ) : selectedStep ? (
    <StepPanel
      key={selectedStep.key}
      step={selectedStep}
      number={numbers[selectedStep.key] ?? 0}
      definition={def}
      options={options}
      issues={issues.byStep[selectedStep.key] ?? []}
      readOnly={readOnly}
      base={scope.base}
      onChange={(s) => edit({ ...def, steps: def.steps.map((x) => (x.key === s.key ? s : x)) })}
      onRemove={() => askRemove(selectedStep.key)}
    />
  ) : (
    <Overview issues={issues} numbers={numbers} onSelect={setSelected} readOnly={readOnly} />
  );

  const statusButton = (() => {
    if (!canManage) return null;
    if (workflow.status === "active") return <Button variant="secondary" loading={busy("status")} onClick={() => void run("status", () => setWorkflowStatusAction(scope.orgId, workflow.id, "paused"), "Paused. Nothing new starts; runs already waiting hold until you resume.")}><Pause className="size-4" aria-hidden />Pause</Button>;
    if (workflow.status === "archived") return <Button variant="secondary" loading={busy("status")} onClick={() => void run("status", () => setWorkflowStatusAction(scope.orgId, workflow.id, "draft"), "Restored. It stays off until you turn it on.")}>Restore</Button>;
    const label = workflow.status === "paused" ? "Resume" : "Turn on";
    return (
      <Button variant="brand" disabled={!!blocker || dirty} aria-describedby={blocker || dirty ? "wf-activation-why" : undefined} loading={busy("status")} onClick={() => void run("status", () => setWorkflowStatusAction(scope.orgId, workflow.id, "active"), workflow.status === "paused" ? "Resumed." : "Turned on. It starts for new matching events from now on.")}>
        <Play className="size-4" aria-hidden />{label}
      </Button>
    );
  })();

  return (
    <div className="space-y-4">
      {/* Header */}
      <div>
        <Link
          href={`${scope.base}/workflows`}
          onClick={(e) => {
            if (dirty && !window.confirm("You have unsaved changes to this workflow. Leave without saving them?")) e.preventDefault();
          }}
          className="inline-flex min-h-11 items-center gap-1.5 text-[14px] font-medium text-muted hover:text-ink sm:min-h-0"
        >
          <ArrowLeft className="size-4" aria-hidden />All workflows
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="flex flex-wrap items-center gap-2 text-[20px] font-semibold tracking-[-0.03em] text-ink">
              <span className="min-w-0 break-words">{workflow.name}</span>
              <WorkflowStatusBadge status={workflow.status} />
            </h2>
            <p className="mt-1 text-[13px] text-muted">
              {workflow.publishedVersion ? `Version ${workflow.publishedVersion} is published` : "Not published yet"}
              {dirty ? " · unsaved changes" : workflow.unpublishedChanges && workflow.publishedVersion ? " · draft has unpublished changes" : ""}
              {" · saved "}<RelativeTime iso={workflow.updatedAt} timezone={scope.timezone} />{workflow.updatedByName ? ` by ${workflow.updatedByName}` : ""}
            </p>
          </div>
          {canManage && (
            <div className="flex flex-wrap items-center gap-2">
              {!readOnly && (
                <>
                  <Button variant="secondary" onClick={() => setTesting(true)}><FlaskConical className="size-4" aria-hidden />Test</Button>
                  <Button variant="secondary" loading={saving} disabled={!dirty} onClick={() => void save()}><Save className="size-4" aria-hidden />Save draft</Button>
                  <Button
                    loading={busy("publish")}
                    disabled={issues.errors > 0 || (!dirty && !workflow.unpublishedChanges && !!workflow.publishedVersion)}
                    aria-describedby={issues.errors > 0 ? "wf-validation" : undefined}
                    onClick={() => setConfirmPublish(true)}
                  >
                    <Rocket className="size-4" aria-hidden />Publish
                  </Button>
                </>
              )}
              {statusButton}
              <Menu>
                <MenuTrigger asChild><Button variant="ghost" size="icon" aria-label="More workflow actions"><MoreHorizontal className="size-4" /></Button></MenuTrigger>
                <MenuContent>
                  {workflow.status === "active" && published && (
                    <MenuItem onSelect={() => setStarting(true)}><PlayCircle className="size-4" aria-hidden />Start a run now…</MenuItem>
                  )}
                  <MenuItem onSelect={async () => {
                    const copy = await run("clone", () => cloneWorkflowAction(scope.orgId, workflow.id), "Copy created as a draft.");
                    if (copy) router.push(`${scope.base}/workflows/${copy.id}`);
                  }}><Copy className="size-4" aria-hidden />Clone</MenuItem>
                  {workflow.status !== "archived" && (
                    <>
                      <MenuSeparator />
                      <MenuItem destructive onSelect={() => setArchiving(true)}><Archive className="size-4" aria-hidden />Archive</MenuItem>
                    </>
                  )}
                </MenuContent>
              </Menu>
            </div>
          )}
        </div>
        {canManage && (blocker || dirty) && workflow.status !== "active" && workflow.status !== "archived" && (
          <p id="wf-activation-why" className="mt-2 text-[13px] text-muted">{dirty ? "Save and publish your changes before turning it on." : `Can't turn on yet: ${blocker}`}</p>
        )}
      </div>

      {!canManage && <ReadOnlyNotice>{scope.readOnly ? undefined : "You can see this workflow and its runs. Changing it needs “Build and change automations”."}</ReadOnlyNotice>}
      {gate.ownerProblem && <p className="flex gap-2 rounded-2xl border border-warning/30 bg-warning-soft px-4 py-3 text-[14px] text-warning-ink" role="status"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />{gate.ownerProblem}</p>}
      {gate.pausedReason && (
        <p className="flex gap-2 rounded-2xl border border-warning/30 bg-warning-soft px-4 py-3 text-[14px] text-warning-ink" role="status">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{gate.pausedReason} No step of any run acts while it lasts; runs hold and continue when it&apos;s lifted.</span>
        </p>
      )}

      {published && published.effects.length > 0 && published.approval !== "approved" && (
        <Card className="flex flex-wrap items-start gap-3 border-warning/30 p-4">
          <ShieldAlert className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-semibold text-ink">Version {published.version} needs the owner&apos;s approval before it runs</p>
            <p className="mt-0.5 text-[14px] text-muted">It {published.effects.map((e) => effectLabel(e).toLowerCase()).join(", ")}. The owner sees exactly what it sends and to whom, and approves this version only.</p>
          </div>
          <div className="flex items-center gap-2">
            {approvalBadge(published.approval)}
            <Button variant="secondary" onClick={() => setApprovalFor(published)}>{published.approval === "pending" ? "See what's being approved" : "Review and request approval"}</Button>
          </div>
        </Card>
      )}
      {published && published.effects.length > 0 && published.approval === "approved" && (
        <p className="flex items-center gap-2 text-[13px] text-success-ink"><ShieldCheck className="size-4" aria-hidden />Version {published.version} approved{published.approvedByName ? ` by ${published.approvedByName}` : ""}{published.approvedAt ? ` on ${formatDateTime(published.approvedAt, scope.timezone)}` : ""}.</p>
      )}

      <Tabs
        id="wf-editor-tabs"
        value={tab}
        onValueChange={setTabUrl}
        items={[
          { value: "builder", label: "Builder" },
          { value: "runs", label: "Runs", count: runs.total },
          { value: "versions", label: "Versions", count: versions.length },
          { value: "settings", label: "Settings" },
        ]}
      >
        {tab === "builder" && (
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_400px]">
            <div ref={canvasRef} className="min-w-0 space-y-3">
              <ValidationBar errors={issues.errors} warnings={issues.warnings} effects={effects} unreachable={layout.unreachable.length} />
              <WorkflowCanvas
                items={layout.items}
                kinds={Object.fromEntries(def.steps.map((s) => [s.key, s.kind]))}
                summaries={summaries}
                branchLabels={branchLabels}
                issues={Object.fromEntries(Object.entries(issues.byStep).map(([k, v]) => [k, toCanvas(v)]))}
                numbers={numbers}
                asks={Object.fromEntries(def.steps.filter((s) => s.requireApproval).map((s) => [s.key, true]))}
                trigger={{ title: trig.title, summary: trig.detail, issues: toCanvas(issues.trigger) }}
                selected={selected}
                onSelect={setSelected}
                readOnly={readOnly}
                renderAdd={(at, label) => <AddStepMenu label={label} choices={choices.filter((c) => c.kind !== "end" || canInsert(def.steps, at, "end"))} onPick={(kind) => insertAt(at, kind)} />}
                canMove={(k, d) => canMove(def.steps, k, d)}
                onMove={(k, d) => edit({ ...def, steps: moveStep(def.steps, k, d) })}
                onRemove={askRemove}
              />
              {layout.unreachable.length > 0 && (
                <Card className="p-4">
                  <p className="text-[14px] font-semibold text-ink">Steps that never run</p>
                  <p className="mt-0.5 text-[13px] text-muted">Nothing leads to these steps. Remove them, or rebuild the path that should reach them.</p>
                  <ul className="mt-2 space-y-1.5">
                    {layout.unreachable.map((k) => (
                      <li key={k} className="flex items-center justify-between gap-2 rounded-xl bg-surface-2 px-3 py-2 text-[14px]">
                        <span className="min-w-0 truncate">{kindLabel(byKey.get(k)?.kind ?? "")}: {summaries[k]}</span>
                        {!readOnly && <Button variant="ghost" size="sm" onClick={() => { edit({ ...def, steps: def.steps.filter((s) => s.key !== k) }); setRefocus({ key: "trigger" }); }}>Remove</Button>}
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
            </div>
            {wide && (
              <aside aria-label="Step settings" className="sticky top-24 max-h-[calc(100dvh-7rem)] self-start overflow-y-auto rounded-2xl border border-line bg-surface p-4 shadow-soft scrollbar-thin">
                {panel}
              </aside>
            )}
          </div>
        )}
        {tab === "runs" && <RunsList base={scope.base} runs={runs.items} filter={runs.filter} nextBefore={runs.nextBefore} paged={runs.paged} timezone={scope.timezone} />}
        {tab === "versions" && (
          <div className="space-y-3">
            <VersionsList versions={versions} timezone={scope.timezone} approvalsHref={approvalsHref} onView={setViewing} />
            {published && published.effects.length > 0 && published.approval !== "approved" && canManage && (
              <Button variant="secondary" onClick={() => setApprovalFor(published)}><ShieldCheck className="size-4" aria-hidden />Review version {published.version} for approval</Button>
            )}
          </div>
        )}
        {tab === "settings" && (
          <WorkflowSettingsForm
            scope={scope}
            workflowId={workflow.id}
            value={{ name: workflow.name, description: workflow.description, folderId: workflow.folderId, hourlyRunLimit: workflow.hourlyRunLimit }}
            folders={options.folders}
            readOnly={readOnly}
          />
        )}
      </Tabs>

      {/* Phones and tablets: the selected step's settings open in a sheet. */}
      {!wide && tab === "builder" && (
        <Sheet open={!!selected} onOpenChange={(o) => !o && setSelected(null)} side="bottom" title={selected === "trigger" ? "Trigger" : selectedStep ? `Step ${numbers[selectedStep.key] ?? ""}: ${kindLabel(selectedStep.kind)}` : "Step"}>
          <div className="p-4">{panel}</div>
        </Sheet>
      )}

      <ConfirmDialog
        open={confirmPublish}
        onOpenChange={setConfirmPublish}
        title={`Publish version ${(workflow.publishedVersion ?? 0) + 1}?`}
        description={
          effects.length
            ? workflow.status === "active"
              ? "This freezes the draft as a new version. Because it messages customers or calls outside systems, the workflow pauses until the owner approves this exact version; runs already under way finish on their version."
              : "This freezes the draft as a new version. Because it messages customers or calls outside systems, it won't run until the owner approves this exact version."
            : workflow.status === "active"
              ? "This freezes the draft as a new version. New runs use it right away; runs already under way finish on the version they started with."
              : "This freezes the draft as a new version. It doesn't turn the workflow on."
        }
        confirmLabel={dirty ? "Save and publish" : "Publish"}
        loading={busy("publish") || saving}
        onConfirm={() => void publish()}
      >
        {issues.warnings > 0 && <p className="rounded-xl bg-warning-soft px-3 py-2 text-[13px] text-warning-ink">{issues.warnings} {issues.warnings === 1 ? "warning" : "warnings"} to look at, but nothing stops publishing.</p>}
      </ConfirmDialog>
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Remove this if / else and both paths?"
        description={removing ? `The ${removing.count} ${removing.count === 1 ? "step" : "steps"} on its Yes and No paths are removed too. Nothing is saved until you save the draft.` : undefined}
        confirmLabel="Remove"
        danger
        onConfirm={() => removing && doRemove(removing.key)}
      />
      <ConfirmDialog
        open={conflict}
        onOpenChange={setConflict}
        title="Someone saved this workflow after you opened it"
        description="Load their version to see it (your unsaved changes here are lost), or keep editing and copy your changes over by hand."
        confirmLabel="Load the latest version"
        onConfirm={() => {
          setConflict(false);
          setDirty(false);
          setSynced(-1);
          router.refresh();
        }}
      />
      <ConfirmDialog
        open={archiving}
        onOpenChange={setArchiving}
        title={`Archive “${workflow.name}”?`}
        description="It stops starting new runs and runs still in progress are cancelled. It's hidden from the list; you can restore it later as a draft."
        confirmLabel="Archive"
        danger
        loading={busy("archive")}
        onConfirm={async () => {
          if (await run("archive", () => setWorkflowStatusAction(scope.orgId, workflow.id, "archived"), "Workflow archived.")) setArchiving(false);
        }}
      />
      {approvalFor && <ApprovalDialog scope={scope} workflowId={workflow.id} workflowStatus={workflow.status} version={approvalFor} options={options} canRequest={canRequestApproval} approvalsHref={approvalsHref} onClose={() => setApprovalFor(null)} />}
      {testing && (
        <TestRunDialog
          scope={scope}
          workflowId={workflow.id}
          needsContact={TRIGGERS[def.trigger.type]?.carries.contact === "always"}
          carriesContact={TRIGGERS[def.trigger.type]?.carries.contact !== "never"}
          dirty={dirty}
          hasPublished={!!workflow.publishedVersion}
          onSaveFirst={async () => (await save()) !== null}
          onClose={() => setTesting(false)}
        />
      )}
      {starting && published && <StartRunDialog scope={scope} workflowId={workflow.id} trigger={(published.definition as WorkflowDefinition).trigger} onClose={() => setStarting(false)} />}
      {viewing && <VersionViewer version={viewing} options={options} timezone={scope.timezone} onClose={() => setViewing(null)} />}
    </div>
  );
}

function ValidationBar({ errors, warnings, effects, unreachable }: { errors: number; warnings: number; effects: string[]; unreachable: number }) {
  return (
    <div id="wf-validation" className="flex flex-wrap items-center gap-2 text-[13px]" role="status" aria-live="polite">
      {errors ? (
        <span className="inline-flex items-center gap-1.5 font-medium text-danger-ink"><AlertTriangle className="size-4" aria-hidden />{errors} {errors === 1 ? "problem" : "problems"} to fix before publishing</span>
      ) : (
        <span className="inline-flex items-center gap-1.5 font-medium text-success-ink"><CheckCircle2 className="size-4" aria-hidden />Ready to publish</span>
      )}
      {warnings > 0 && <span className="text-warning-ink">· {warnings} {warnings === 1 ? "warning" : "warnings"}</span>}
      {unreachable > 0 && <span className="text-muted">· {unreachable} disconnected</span>}
      {effects.map((e) => <Badge key={e} tone={EFFECT_TONE[e] ?? "neutral"} className="h-5 px-2 text-[12px]">{effectLabel(e)}</Badge>)}
    </div>
  );
}

/** What shows in the side panel when nothing is selected: how to use the builder and every problem, each a link to its step. */
function Overview({ issues, numbers, onSelect, readOnly }: { issues: ReturnType<typeof groupIssues>; numbers: Record<string, number>; onSelect: (k: string) => void; readOnly: boolean }) {
  const all = [
    ...issues.general.map((i) => ({ i, target: null as string | null })),
    ...issues.trigger.map((i) => ({ i, target: "trigger" })),
    ...Object.entries(issues.byStep).flatMap(([k, list]) => list.map((i) => ({ i, target: k }))),
  ];
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-[15px] font-semibold text-ink">{readOnly ? "Workflow steps" : "Build your workflow"}</h3>
        <p className="mt-1 text-[13px] leading-relaxed text-muted">
          {readOnly ? "Select the trigger or a step to see its settings." : "Select the trigger or a step to change it. Use + between steps to add one; use a step's menu to move or remove it. Save the draft as you go, publish when it's ready, then turn it on."}
        </p>
      </div>
      {all.length > 0 && (
        <div>
          <p className="mb-1.5 text-[12px] font-semibold uppercase tracking-wider text-faint">To look at</p>
          <ul className="space-y-1.5">
            {all.map(({ i, target }, n) => (
              <li key={n}>
                {target ? (
                  <button type="button" onClick={() => onSelect(target)} className={cn("w-full rounded-xl px-3 py-2 text-left text-[13px] hover:brightness-95", i.level === "error" ? "bg-danger-soft text-danger-ink" : "bg-warning-soft text-warning-ink")}>
                    <span className="font-semibold">{target === "trigger" ? "Trigger" : `Step ${numbers[target] ?? "?"}`}:</span> {i.message}
                  </button>
                ) : (
                  <p className={cn("rounded-xl px-3 py-2 text-[13px]", i.level === "error" ? "bg-danger-soft text-danger-ink" : "bg-warning-soft text-warning-ink")}>{i.message}</p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="rounded-xl bg-surface-2 px-3 py-2.5 text-[13px] leading-relaxed text-muted">
        Every step runs on iAcquire&apos;s scheduler and is checked again when it runs: a paused workspace or AI employee, missing consent, quiet hours and sending limits all still apply. Steps that send messages only send after the owner approves the published version.
      </p>
    </div>
  );
}

/** A published version, read-only, drawn the same way as the builder. */
function VersionViewer({ version, options, timezone, onClose }: { version: VersionItem; options: EditorOptions; timezone: string; onClose: () => void }) {
  const def = version.definition as WorkflowDefinition;
  const names = namesFrom(options);
  const layout = layoutCanvas(def.steps ?? []);
  const numbers = Object.fromEntries(orderedKeys(layout.items).map((k, i) => [k, i + 1]));
  const [selected, setSelected] = React.useState<string | null>(null);
  const trig = triggerSummary(def.trigger, names);
  const sel = selected && selected !== "trigger" ? def.steps.find((s) => s.key === selected) : null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} size="xl" title={`Version ${version.version}`} description={`Published ${formatDateTime(version.publishedAt, timezone)}${version.publishedByName ? ` by ${version.publishedByName}` : ""}. Published versions can't change.`}>
      <div className="space-y-3">
        <div className="flex flex-wrap gap-1.5">{approvalBadge(version.approval)}{version.effects.map((e) => <Badge key={e} tone={EFFECT_TONE[e] ?? "neutral"}>{effectLabel(e)}</Badge>)}</div>
        <WorkflowCanvas
          items={layout.items}
          kinds={Object.fromEntries(def.steps.map((s) => [s.key, s.kind]))}
          summaries={Object.fromEntries(def.steps.map((s) => [s.key, stepSummary(s, names)]))}
          branchLabels={Object.fromEntries(def.steps.filter((s) => s.kind === "branch").map((s) => [s.key, branchSideLabels(s, names)]))}
          issues={{}}
          numbers={numbers}
          trigger={{ title: trig.title, summary: trig.detail, issues: [] }}
          selected={selected}
          onSelect={(k) => setSelected(selected === k ? null : k)}
          readOnly
        />
        {sel && <p className="rounded-xl bg-surface-2 px-3 py-2 text-[14px] text-ink-2">Step {numbers[sel.key]}: {kindLabel(sel.kind)}. {stepSummary(sel, names)}</p>}
        <p className="text-[12px] text-muted">Only the current version starts new runs. Runs that started on an older version finish on it.</p>
      </div>
    </Dialog>
  );
}

type ContactHit = { id: string; name: string; email: string | null; phone: string | null };

/**
 * Starts the published version now, for one contact (or with none, when the trigger has no contact). The run goes through every check a
 * triggered run does, step by step: pauses, consent, quiet hours and the owner's approval of the version.
 */
function StartRunDialog({ scope, workflowId, trigger, onClose }: { scope: CrmScope; workflowId: string; trigger: WorkflowDefinition["trigger"]; onClose: () => void }) {
  const router = useRouter();
  const { run, busy } = useCrmAction();
  const [contact, setContact] = React.useState<ContactHit | null>(null);
  const carries = TRIGGERS[trigger.type]?.carries.contact ?? "never";
  const canSearch = !!scope.can["contacts.view"];
  const search = React.useCallback(async (q: string) => {
    const res = await searchContactsAction(scope.orgId, q);
    return res.ok ? (res.data as ContactHit[]) : [];
  }, [scope.orgId]);
  const needsContact = carries !== "never";
  const start = async () => {
    const out = await run("start", () => startManualRunAction(scope.orgId, workflowId, { contactId: contact?.id ?? null }), "Run started. The scheduler runs its first step within a few minutes.");
    if (out) router.push(`${scope.base}/workflows/${workflowId}/runs/${out.runId}`);
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Start a run now"
      description="Runs the published version once, right away, as if it had been triggered. Every step is still checked when it runs: pauses, consent, quiet hours and sending limits apply."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy("start")} disabled={needsContact && !contact} onClick={start}><PlayCircle className="size-4" aria-hidden />Start run</Button></>}
    >
      {needsContact ? (
        canSearch ? (
          <div className="space-y-1.5">
            <p className="text-[14px] font-medium text-ink-2">For contact</p>
            <RecordPicker<ContactHit>
              id="wf-start-contact"
              label="Contact"
              placeholder="Search by name, email or phone"
              search={search}
              render={(c) => <span className="block"><span className="font-medium text-ink">{c.name}</span>{(c.email || c.phone) && <span className="ml-2 text-muted">{c.email ?? c.phone}</span>}</span>}
              onPick={setContact}
              value={contact ? <span className="font-medium">{contact.name}</span> : undefined}
              onClear={() => setContact(null)}
            />
            {trigger.reentry && trigger.reentry !== "always" && <p className="text-[13px] text-muted">{trigger.reentry === "once" ? "A contact who has been through this workflow before won't start again." : "A contact who is in this workflow right now won't start again."}</p>}
          </div>
        ) : (
          <p className="text-[14px] text-muted">Choosing a contact needs permission to see contacts.</p>
        )
      ) : (
        <p className="text-[14px] text-muted">This workflow&apos;s trigger has no contact, so the run starts without one.</p>
      )}
    </Dialog>
  );
}
