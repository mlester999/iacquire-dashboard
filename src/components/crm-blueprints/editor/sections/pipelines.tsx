"use client";

import * as React from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/primitives";
import type { PipelineAsset, StageAsset, StageKind } from "@/lib/crm/blueprints/types";
import { moveItem, newStage, updateAsset, withSection } from "@/components/crm-blueprints/editor/model";
import { AssetWorkspace, DetailCard, DetailHeader, FieldGrid, IssueNotes, NumberInput, SectionNote, issuesOf, orNull, ownIssues, useAdder, useEditor } from "@/components/crm-blueprints/editor/parts";
import { ColorPicker, ToggleRow } from "@/components/crm-blueprints/editor/inputs";

const KIND_LABELS: Record<StageKind, string> = { open: "Open", won: "Won", lost: "Lost" };

export function PipelinesSection() {
  const { content, edit, readOnly, remove, issues } = useEditor();
  const add = useAdder("pipelines");
  const items = content.assets.pipelines.map((p) => ({ id: p.id, name: p.name, detail: `${p.stages.length} ${p.stages.length === 1 ? "stage" : "stages"}${p.isDefault ? " · default" : ""}` }));
  return (
    <>
      <AssetWorkspace
        section="pipelines"
        title="Pipelines & stages"
        intro="Sales pipelines and their stages, in order. A pipeline with the same name in a client's CRM is matched; new stages can be added to it later, but its own stages are never removed or reordered."
        items={items}
        addLabel="Add pipeline"
        onAdd={add.open}
        emptyText="Add the pipeline deals move through, with the stages this kind of business uses."
        canReorder
        onMove={(i, d) => edit((c) => withSection(c, "pipelines", moveItem(c.assets.pipelines, i, d)))}
      >
        {(id) => {
          const p = content.assets.pipelines.find((x) => x.id === id)!;
          const set = (patch: Partial<PipelineAsset>) => edit((c) => updateAsset(c, "pipelines", id, (x) => ({ ...x, ...patch })));
          const setDefault = (on: boolean) => edit((c) => withSection(c, "pipelines", c.assets.pipelines.map((x) => ({ ...x, isDefault: x.id === id ? on : on ? false : x.isDefault }))));
          return (
            <DetailCard>
              <DetailHeader id={p.id} title={p.name} kind="Pipeline" onRemove={() => remove(p.id, p.name)} />
              <IssueNotes issues={ownIssues(issues, p.id)} />
              <Field label="Name" htmlFor="pl-name"><Input id="pl-name" value={p.name} maxLength={80} disabled={readOnly} onChange={(e) => set({ name: e.target.value })} /></Field>
              <Field label="Description" htmlFor="pl-desc" optional><Textarea id="pl-desc" rows={2} maxLength={300} value={p.description ?? ""} disabled={readOnly} onChange={(e) => set({ description: orNull(e.target.value) })} /></Field>
              <ToggleRow id="pl-default" label="Default pipeline" hint="Becomes the client's default only when it has none: a client's own default is never replaced." checked={p.isDefault} disabled={readOnly} onChange={setDefault} />
              <StagesEditor pipeline={p} />
            </DetailCard>
          );
        }}
      </AssetWorkspace>
      {add.dialog}
    </>
  );
}

function StagesEditor({ pipeline }: { pipeline: PipelineAsset }) {
  const { content, edit, readOnly, remove, issues } = useEditor();
  const setStages = (stages: StageAsset[]) => edit((c) => updateAsset(c, "pipelines", pipeline.id, (x) => ({ ...x, stages })));
  const setStage = (sid: string, patch: Partial<StageAsset>) => edit((c) => updateAsset(c, "pipelines", pipeline.id, (x) => ({ ...x, stages: x.stages.map((s) => (s.id === sid ? { ...s, ...patch } : s)) })));
  const addStage = () => {
    const names = new Set(pipeline.stages.map((s) => s.name.toLowerCase()));
    let n = pipeline.stages.length + 1;
    while (names.has(`stage ${n}`)) n++;
    const stage = newStage(content, pipeline.id, `Stage ${n}`);
    // A new open stage goes before the won and lost stages, where open stages belong.
    const firstClosed = pipeline.stages.findIndex((s) => s.kind !== "open");
    const at = firstClosed === -1 ? pipeline.stages.length : firstClosed;
    setStages([...pipeline.stages.slice(0, at), stage, ...pipeline.stages.slice(at)]);
  };
  return (
    <section aria-labelledby={`stages-${pipeline.id}`} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id={`stages-${pipeline.id}`} className="text-[14px] font-semibold text-ink">Stages</h4>
        {!readOnly && <Button variant="secondary" size="sm" onClick={addStage} disabled={pipeline.stages.length >= 30}><Plus className="size-3.5" aria-hidden />Add stage</Button>}
      </div>
      <SectionNote>A pipeline needs at least one open stage, and has at most one won and one lost stage. Deals move through the stages in this order.</SectionNote>
      <ol className="space-y-2">
        {pipeline.stages.map((s, i) => (
          <li key={s.id} className="space-y-3 rounded-2xl border border-line p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[12px] font-semibold uppercase tracking-[0.05em] text-muted">Stage {i + 1} <code className="ml-1 font-mono text-[11px] normal-case tracking-normal text-faint">{s.id}</code></span>
              {!readOnly && (
                <span className="flex items-center gap-1">
                  <Button variant="ghost" size="icon-sm" onClick={() => setStages(moveItem(pipeline.stages, i, -1))} disabled={i === 0} aria-label={`Move ${s.name} up`}><ArrowUp className="size-4" /></Button>
                  <Button variant="ghost" size="icon-sm" onClick={() => setStages(moveItem(pipeline.stages, i, 1))} disabled={i === pipeline.stages.length - 1} aria-label={`Move ${s.name} down`}><ArrowDown className="size-4" /></Button>
                  <Button variant="ghost" size="icon-sm" onClick={() => remove(s.id, s.name)} disabled={pipeline.stages.length <= 1} aria-label={`Remove stage ${s.name}`}><Trash2 className="size-4" /></Button>
                </span>
              )}
            </div>
            <FieldGrid className="sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)]">
              <Field label="Name" htmlFor={`st-name-${s.id}`}><Input id={`st-name-${s.id}`} value={s.name} maxLength={60} disabled={readOnly} onChange={(e) => setStage(s.id, { name: e.target.value })} /></Field>
              <Field label="Kind" htmlFor={`st-kind-${s.id}`}>
                <Select id={`st-kind-${s.id}`} value={s.kind} disabled={readOnly} onChange={(e) => setStage(s.id, { kind: e.target.value as StageKind })}>
                  {(Object.keys(KIND_LABELS) as StageKind[]).map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
                </Select>
              </Field>
              <Field label="Win probability" htmlFor={`st-prob-${s.id}`} optional>
                <NumberInput id={`st-prob-${s.id}`} value={s.probability} min={0} max={100} nullable suffix="%" disabled={readOnly} onChange={(probability) => setStage(s.id, { probability })} />
              </Field>
            </FieldGrid>
            <Field label="Colour" htmlFor={`st-color-${s.id}`} optional>
              <ColorPicker id={`st-color-${s.id}`} label={`${s.name} colour`} value={s.color} nullable disabled={readOnly} onChange={(color) => setStage(s.id, { color })} />
            </Field>
            <IssueNotes issues={issuesOf(issues, s.id)} />
          </li>
        ))}
      </ol>
    </section>
  );
}
