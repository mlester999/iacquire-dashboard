"use client";

import * as React from "react";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { Badge, Field, Input, Textarea } from "@/components/ui/primitives";
import { Sheet } from "@/components/ui/overlays";
import { ConfirmDialog } from "@/components/crm/ui";
import { WorkflowCanvas, type CanvasIssue } from "@/components/crm/workflows/canvas";
import { AddStepMenu } from "@/components/crm/workflows/add-step-menu";
import { groupIssues, newStep, validationContextOf } from "@/components/crm/workflows/editor-logic";
import { branchMembers, canInsert, canMove, insertStep, layoutCanvas, moveStep, orderedKeys, removeStep, type InsertPoint } from "@/components/crm/workflows/graph";
import { StepPanel } from "@/components/crm/workflows/step-panel";
import { TriggerPanel } from "@/components/crm/workflows/trigger-panel";
import { EFFECT_TONE, branchSideLabels, effectLabel, kindLabel, namesFrom, stepSummary, triggerSummary } from "@/components/crm/workflows/summaries";
import { useMediaQuery } from "@/components/crm/workflows/use-media";
import { deriveEffects, validateDefinition, type StepKind, type ValidationIssue, type WorkflowDefinition } from "@/lib/crm/workflow/spec";
import type { WorkflowAsset } from "@/lib/crm/blueprints/types";
import { keysIn, updateAsset } from "@/components/crm-blueprints/editor/model";
import { blueprintKindChoices, workflowFromEditor, workflowOptionsFor, workflowToEditor } from "@/components/crm-blueprints/editor/bridge";
import { AssetWorkspace, DetailCard, DetailHeader, FieldGrid, FolderSelect, IssueNotes, NumberInput, SectionNote, issuesOf, orNull, useAdder, useEditor } from "@/components/crm-blueprints/editor/parts";
import { KeyInput, ToggleRow } from "@/components/crm-blueprints/editor/inputs";

const KEY_RE = /^[a-z0-9](?:[a-z0-9_-]{0,46}[a-z0-9])?$/;
const toCanvas = (list: ValidationIssue[] | undefined): CanvasIssue[] => (list ?? []).map((i) => ({ severity: i.level, message: i.message }));

export function WorkflowsSection() {
  const { content, remove, issues } = useEditor();
  const add = useAdder("workflows");
  const items = content.assets.workflows.map((w) => ({ id: w.id, name: w.name, detail: `${w.definition.steps.length} ${w.definition.steps.length === 1 ? "step" : "steps"}${w.placeholder ? " · to rebuild" : ""}` }));
  return (
    <>
      <AssetWorkspace
        section="workflows"
        title="Workflow drafts"
        intro="Automations a client starts with, built with the CRM's own workflow builder. Their choices are this Blueprint's tags, pipelines, fields, templates, forms, calendars and roles."
        items={items}
        addLabel="Add workflow"
        onAdd={add.open}
        emptyText="Add the follow-ups and reminders this kind of business runs."
      >
        {(id) => {
          const w = content.assets.workflows.find((x) => x.id === id)!;
          return (
            <DetailCard>
              <DetailHeader id={w.id} title={w.name} kind="Workflow draft" onRemove={() => remove(w.id, w.name)} />
              <SectionNote tone="warning">
                Workflows always arrive as drafts. Nothing runs and nothing is sent until the client connects its providers, maps the roles, and its owner
                approves the exact version.
              </SectionNote>
              <IssueNotes issues={issuesOf(issues, w.id).filter((i) => i.code !== "native_workflow")} />
              <WorkflowSettings workflow={w} />
              <WorkflowBuilder key={w.id} workflow={w} />
            </DetailCard>
          );
        }}
      </AssetWorkspace>
      {add.dialog}
    </>
  );
}

function WorkflowSettings({ workflow: w }: { workflow: WorkflowAsset }) {
  const { content, edit, readOnly } = useEditor();
  const set = (patch: Partial<WorkflowAsset>) => edit((c) => updateAsset(c, "workflows", w.id, (x) => ({ ...x, ...patch })));
  const taken = keysIn(content, "workflows").filter((k) => k !== w.key);
  return (
    <div className="space-y-4">
      <FieldGrid>
        <Field label="Name" htmlFor="wf-name"><Input id="wf-name" value={w.name} maxLength={80} disabled={readOnly} onChange={(e) => set({ name: e.target.value })} /></Field>
        <Field label="Key" htmlFor="wf-key" hint="How a client's CRM recognises this workflow when the Blueprint is applied again.">
          <KeyInput id="wf-key" value={w.key} pattern={KEY_RE} taken={taken} disabled={readOnly} invalidText="Lower-case letters, numbers, - and _ (48 at most)." onCommit={(key) => set({ key })} />
        </Field>
        <FolderSelect id="wf-folder" kind="workflow" value={w.folder} onChange={(folder) => set({ folder })} />
        <Field label="At most" htmlFor="wf-limit" hint="Runs per hour; more wait for the next hour.">
          <NumberInput id="wf-limit" value={w.hourlyRunLimit} min={1} max={10000} suffix="runs an hour" disabled={readOnly} onChange={(v) => v !== null && set({ hourlyRunLimit: v })} />
        </Field>
      </FieldGrid>
      <Field label="Description" htmlFor="wf-desc" optional><Textarea id="wf-desc" rows={2} maxLength={500} value={w.description ?? ""} disabled={readOnly} onChange={(e) => set({ description: orNull(e.target.value) })} /></Field>
      {w.placeholder && (
        <ToggleRow
          id="wf-placeholder"
          label="Only the name is known"
          hint="This workflow came over without its steps (GoHighLevel's API shares names and status only). Rebuild it below, then switch this off: until then each client is asked to rebuild it."
          checked={w.placeholder}
          disabled={readOnly}
          onChange={(placeholder) => set({ placeholder })}
        />
      )}
    </div>
  );
}

/**
 * The CRM's own workflow builder (canvas, trigger and step panels) on this workflow's definition, with this Blueprint's references as its
 * choices. Each change is turned back into the package definition at once (no inbound nonce, no template binding).
 */
function WorkflowBuilder({ workflow }: { workflow: WorkflowAsset }) {
  const { content, edit, readOnly, linkBase } = useEditor();
  const wide = useMediaQuery("(min-width: 1280px)");
  const options = React.useMemo(() => workflowOptionsFor(content), [content]);
  const bridged = React.useMemo(() => workflowToEditor(workflow, content), [workflow, content]);
  const def = bridged.value;
  const [selected, setSelected] = React.useState<string | null>(null);
  const [removing, setRemoving] = React.useState<{ key: string; count: number } | null>(null);

  const ctx = React.useMemo(() => validationContextOf(options), [options]);
  const names = React.useMemo(() => namesFrom(options), [options]);
  const issues = React.useMemo(() => groupIssues(validateDefinition(def, ctx)), [def, ctx]);
  const layout = React.useMemo(() => layoutCanvas(def.steps), [def.steps]);
  const numbers = React.useMemo(() => Object.fromEntries(orderedKeys(layout.items).map((k, i) => [k, i + 1])), [layout]);
  const byKey = React.useMemo(() => new Map(def.steps.map((s) => [s.key, s])), [def.steps]);
  const summaries = React.useMemo(() => Object.fromEntries(def.steps.map((s) => [s.key, s.name?.trim() ? `${s.name} · ${stepSummary(s, names)}` : stepSummary(s, names)])), [def.steps, names]);
  const branchLabels = React.useMemo(() => Object.fromEntries(def.steps.filter((s) => s.kind === "branch").map((s) => [s.key, branchSideLabels(s, names)])), [def.steps, names]);
  const choices = React.useMemo(() => blueprintKindChoices(options), [options]);
  const effects = React.useMemo(() => deriveEffects(def), [def]);
  const trig = triggerSummary(def.trigger, names);

  const setDef = (next: WorkflowDefinition) => edit((c) => updateAsset(c, "workflows", workflow.id, (x) => ({ ...x, definition: workflowFromEditor(next, x, c) })));
  const insertAt = (at: InsertPoint, kind: string) => {
    const k = kind as StepKind;
    if (!canInsert(def.steps, at, k)) return void toast.error("An End step only goes where nothing follows.");
    const step = newStep(def.steps, k, options);
    setDef({ ...def, steps: insertStep(def.steps, at, step) });
    setSelected(step.key);
  };
  const doRemove = (key: string) => {
    const next = removeStep(def.steps, key);
    setDef({ ...def, steps: next });
    if (selected === key || (selected && selected !== "trigger" && !next.some((s) => s.key === selected))) setSelected(null);
    setRemoving(null);
  };
  const askRemove = (key: string) => {
    const s = byKey.get(key);
    if (!s) return;
    const members = s.kind === "branch" ? branchMembers(def.steps, key).length : 0;
    if (members) setRemoving({ key, count: members });
    else doRemove(key);
  };

  const selectedStep = selected && selected !== "trigger" ? byKey.get(selected) ?? null : null;
  const panel = selected === "trigger" ? (
    <TriggerPanel trigger={def.trigger} options={options} issues={issues.trigger} readOnly={readOnly} inboundUrl={null} onChange={(trigger) => setDef({ ...def, trigger })} />
  ) : selectedStep ? (
    <StepPanel
      key={selectedStep.key}
      step={selectedStep}
      number={numbers[selectedStep.key] ?? 0}
      definition={def}
      options={options}
      issues={issues.byStep[selectedStep.key] ?? []}
      readOnly={readOnly}
      base={linkBase}
      onChange={(s) => setDef({ ...def, steps: def.steps.map((x) => (x.key === s.key ? s : x)) })}
      onRemove={() => askRemove(selectedStep.key)}
    />
  ) : (
    <div className="space-y-2">
      <h4 className="text-[14px] font-semibold text-ink">{readOnly ? "Workflow steps" : "Build the workflow"}</h4>
      <p className="text-[13px] leading-relaxed text-muted">{readOnly ? "Select the trigger or a step to see its settings." : "Select the trigger or a step to change it. Use + between steps to add one, and a step's menu to move or remove it."}</p>
    </div>
  );

  return (
    <div className="space-y-3 border-t border-line pt-4">
      <SectionNote>
        People, AI employees, n8n automations and webhook endpoints are roles in a Blueprint. This builder doesn&apos;t check their connections: each
        client&apos;s setup checklist lists what it must connect, map and approve before this workflow can run there.
      </SectionNote>
      {bridged.unresolved.length > 0 && (
        <SectionNote tone="warning">
          {bridged.unresolved.length} {bridged.unresolved.length === 1 ? "reference points" : "references point"} at something that isn&apos;t in this Blueprint
          ({bridged.unresolved.map((u) => u.value).slice(0, 3).join(", ")}). The builder shows {bridged.unresolved.length === 1 ? "it as missing" : "them as missing"} and keeps {bridged.unresolved.length === 1 ? "it" : "them"} as written; point {bridged.unresolved.length === 1 ? "it" : "them"} at something in this Blueprint before publishing.
        </SectionNote>
      )}
      <div className="flex flex-wrap items-center gap-2 text-[13px]" role="status" aria-live="polite">
        {issues.errors ? (
          <span className="inline-flex items-center gap-1.5 font-medium text-danger-ink"><AlertTriangle className="size-4" aria-hidden />{issues.errors} {issues.errors === 1 ? "problem" : "problems"} to fix</span>
        ) : (
          <span className="inline-flex items-center gap-1.5 font-medium text-success-ink"><CheckCircle2 className="size-4" aria-hidden />Complete</span>
        )}
        {issues.warnings > 0 && <span className="text-warning-ink">· {issues.warnings} {issues.warnings === 1 ? "warning" : "warnings"}</span>}
        {effects.map((e) => <Badge key={e} tone={EFFECT_TONE[e] ?? "neutral"} className="h-5 px-2 text-[12px]">{effectLabel(e)}</Badge>)}
      </div>
      {issues.general.length > 0 && <IssueNotes issues={issues.general.map((i) => ({ severity: i.level, code: i.code, path: i.path ?? "", message: i.message, assetId: workflow.id }))} />}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0">
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
            onMove={(k, d) => setDef({ ...def, steps: moveStep(def.steps, k, d) })}
            onRemove={askRemove}
          />
          {layout.unreachable.length > 0 && (
            <p className="mt-3 rounded-xl bg-surface-2 px-3 py-2 text-[13px] text-muted">
              {layout.unreachable.length} {layout.unreachable.length === 1 ? "step is" : "steps are"} not reachable from the trigger: {layout.unreachable.map((k) => `${kindLabel(byKey.get(k)?.kind ?? "")}`).join(", ")}.
            </p>
          )}
        </div>
        {wide && <aside aria-label="Step settings" className="sticky top-24 max-h-[calc(100dvh-7rem)] self-start overflow-y-auto rounded-2xl border border-line bg-surface p-4 shadow-soft scrollbar-thin">{panel}</aside>}
      </div>
      {!wide && (
        <Sheet open={!!selected} onOpenChange={(o) => !o && setSelected(null)} side="bottom" title={selected === "trigger" ? "Trigger" : selectedStep ? `Step ${numbers[selectedStep.key] ?? ""}: ${kindLabel(selectedStep.kind)}` : "Step"}>
          <div className="p-4">{panel}</div>
        </Sheet>
      )}
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Remove this if / else and both paths?"
        description={removing ? `The ${removing.count} ${removing.count === 1 ? "step" : "steps"} on its Yes and No paths are removed too. Nothing is saved until you save the draft.` : undefined}
        confirmLabel="Remove"
        danger
        onConfirm={() => removing && doRemove(removing.key)}
      />
    </div>
  );
}
