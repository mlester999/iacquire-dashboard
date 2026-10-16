"use client";

import * as React from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { Dialog, Sheet, Switch } from "@/components/ui/overlays";
import { cn } from "@/lib/utils";
import {
  addStageAction, archivePipelineAction, createPipelineAction, deleteStageAction, reorderStagesAction, updatePipelineAction, updateStageAction,
} from "@/app/actions/crm";
import { ConfirmDialog, useCrmAction } from "@/components/crm/ui";
import { TAG_COLORS } from "@/lib/crm/types";
import type { PipelineView, StageKind, StageView } from "@/server/crm/pipelines";
import type { CrmScope } from "@/server/crm/page";

const KIND_LABEL: Record<StageKind, string> = { open: "Open", won: "Won", lost: "Lost" };

export function PipelineSettingsSheet({ open, onOpenChange, scope, pipeline, pipelineCount }: { open: boolean; onOpenChange: (o: boolean) => void; scope: CrmScope; pipeline: PipelineView; pipelineCount: number }) {
  const { run, busy } = useCrmAction();
  const [name, setName] = React.useState(pipeline.name);
  const [description, setDescription] = React.useState(pipeline.description ?? "");
  const [newStage, setNewStage] = React.useState("");
  const [removing, setRemoving] = React.useState<StageView | null>(null);
  const [archiveOpen, setArchiveOpen] = React.useState(false);
  const stages = pipeline.stages;
  const dirty = name.trim() !== pipeline.name || (description.trim() || "") !== (pipeline.description ?? "");

  async function reorder(index: number, delta: -1 | 1) {
    const ids = stages.map((s) => s.id);
    const j = index + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j], ids[index]];
    await run("reorder", () => reorderStagesAction(scope.orgId, pipeline.id, ids));
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Pipeline settings" description="Stages are the steps a deal moves through. Won and Lost stages close a deal.">
      <div className="space-y-6">
        <section className="space-y-3">
          <Field label="Name" htmlFor="ps-name"><Input id="ps-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></Field>
          <Field label="Description" htmlFor="ps-desc" optional><Textarea id="ps-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} /></Field>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex items-center gap-2.5 text-[13px] text-ink-2">
              <Switch checked={pipeline.isDefault} disabled={pipeline.isDefault} onCheckedChange={(v) => v && run("default", () => updatePipelineAction(scope.orgId, pipeline.id, { isDefault: true }), "This is now the default pipeline.")} aria-label="Default pipeline" />
              Default pipeline for new deals
            </label>
            <Button size="sm" disabled={!dirty || !name.trim()} loading={busy("save")} onClick={() => run("save", () => updatePipelineAction(scope.orgId, pipeline.id, { name: name.trim(), description: description.trim() || null }), "Pipeline saved.")}>Save</Button>
          </div>
        </section>

        <section>
          <h3 className="text-[13px] font-semibold text-ink">Stages</h3>
          <p className="mt-0.5 text-[12.5px] text-muted">Probability is optional. The board only shows a weighted forecast for stages you give one; nothing is estimated for you.</p>
          <ol className="mt-3 space-y-2">
            {stages.map((s, i) => (
              <StageRow key={`${s.id}-${s.name}-${s.probability}-${s.kind}-${s.color}`} scope={scope} stage={s} first={i === 0} last={i === stages.length - 1} busy={busy("reorder")}
                onUp={() => reorder(i, -1)} onDown={() => reorder(i, 1)} onRemove={() => setRemoving(s)} />
            ))}
          </ol>
          <form className="mt-3 flex gap-2" onSubmit={async (e) => {
            e.preventDefault();
            if (await run("add", () => addStageAction(scope.orgId, pipeline.id, { name: newStage.trim() }), "Stage added.")) setNewStage("");
          }}>
            <label htmlFor="ps-new" className="sr-only">New stage name</label>
            <Input id="ps-new" placeholder="New stage name" value={newStage} onChange={(e) => setNewStage(e.target.value)} maxLength={60} />
            <Button type="submit" variant="secondary" disabled={!newStage.trim()} loading={busy("add")}><Plus className="size-4" />Add</Button>
          </form>
        </section>

        <section className="rounded-2xl border border-line p-4">
          <h3 className="text-[13px] font-semibold text-ink">Archive this pipeline</h3>
          <p className="mt-0.5 text-[12.5px] text-muted">Only possible once it has no open deals. Closed deals stay in your reports.</p>
          <Button className="mt-3" variant="secondary" size="sm" disabled={pipelineCount <= 1 || pipeline.openCount > 0} onClick={() => setArchiveOpen(true)}>Archive pipeline</Button>
          {pipelineCount <= 1 && <p className="mt-2 text-[12px] text-faint">{"Your only pipeline can't be archived."}</p>}
          {pipelineCount > 1 && pipeline.openCount > 0 && <p className="mt-2 text-[12px] text-faint">{pipeline.openCount} open deals need to move or close first.</p>}
        </section>
      </div>

      {removing && <RemoveStageDialog scope={scope} stage={removing} stages={stages} onClose={() => setRemoving(null)} />}
      <ConfirmDialog open={archiveOpen} onOpenChange={setArchiveOpen} title={`Archive ${pipeline.name}?`} confirmLabel="Archive" danger loading={busy("archive")}
        onConfirm={async () => { if (await run("archive", () => archivePipelineAction(scope.orgId, pipeline.id), "Pipeline archived.")) { setArchiveOpen(false); onOpenChange(false); } }} />
    </Sheet>
  );
}

function StageRow({ scope, stage, first, last, busy, onUp, onDown, onRemove }: { scope: CrmScope; stage: StageView; first: boolean; last: boolean; busy: boolean; onUp: () => void; onDown: () => void; onRemove: () => void }) {
  const { run, busy: saving } = useCrmAction();
  const [name, setName] = React.useState(stage.name);
  const [kind, setKind] = React.useState<StageKind>(stage.kind);
  const [prob, setProb] = React.useState(stage.probability === null ? "" : String(stage.probability));
  const [color, setColor] = React.useState(stage.color ?? "");
  const probNum = prob === "" ? null : Number(prob);
  const probInvalid = probNum !== null && (!Number.isInteger(probNum) || probNum < 0 || probNum > 100);
  const dirty = name.trim() !== stage.name || kind !== stage.kind || probNum !== stage.probability || (color || null) !== stage.color;
  const id = `st-${stage.id}`;
  return (
    <li className="rounded-xl border border-line bg-surface p-3">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_110px_96px]">
        <div>
          <label htmlFor={`${id}-name`} className="sr-only">Stage name</label>
          <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        </div>
        <div>
          <label htmlFor={`${id}-kind`} className="sr-only">Stage meaning</label>
          <Select id={`${id}-kind`} value={kind} onChange={(e) => setKind(e.target.value as StageKind)}>
            {(["open", "won", "lost"] as const).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </Select>
        </div>
        <div className="relative">
          <label htmlFor={`${id}-prob`} className="sr-only">Probability percent</label>
          <Input id={`${id}-prob`} type="number" min={0} max={100} step={1} inputMode="numeric" placeholder="—" value={prob} onChange={(e) => setProb(e.target.value)} disabled={kind !== "open"} aria-invalid={probInvalid || undefined} className="pr-7" />
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[12px] text-faint">%</span>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1" role="radiogroup" aria-label="Stage colour">
          <button type="button" role="radio" aria-checked={!color} onClick={() => setColor("")} className={cn("size-6 rounded-full border border-dashed border-line-strong", !color && "ring-2 ring-primary ring-offset-1")} aria-label="No colour" />
          {TAG_COLORS.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={color === c} onClick={() => setColor(c)} className={cn("size-6 rounded-full", color === c && "ring-2 ring-primary ring-offset-1")} style={{ background: c }} aria-label={`Colour ${c}`} />
          ))}
        </div>
        <div className="flex items-center gap-1">
          <span className="mr-1 text-[12px] text-muted">{stage.openCount} open</span>
          <Button variant="ghost" size="icon-sm" aria-label={`Move ${stage.name} up`} disabled={first || busy} onClick={onUp}><ArrowUp className="size-4" /></Button>
          <Button variant="ghost" size="icon-sm" aria-label={`Move ${stage.name} down`} disabled={last || busy} onClick={onDown}><ArrowDown className="size-4" /></Button>
          <Button variant="ghost" size="icon-sm" aria-label={`Remove ${stage.name}`} onClick={onRemove}><Trash2 className="size-4" /></Button>
          {dirty && (
            <Button size="sm" disabled={!name.trim() || probInvalid} loading={saving("stage")}
              onClick={() => run("stage", () => updateStageAction(scope.orgId, stage.id, { name: name.trim(), kind, probability: kind === "open" ? probNum : null, color: color || null }), "Stage saved.")}>Save</Button>
          )}
        </div>
      </div>
    </li>
  );
}

function RemoveStageDialog({ scope, stage, stages, onClose }: { scope: CrmScope; stage: StageView; stages: StageView[]; onClose: () => void }) {
  const { run, busy } = useCrmAction();
  const targets = stages.filter((s) => s.id !== stage.id && s.kind === "open");
  const [moveTo, setMoveTo] = React.useState(targets[0]?.id ?? "");
  return (
    <ConfirmDialog open onOpenChange={(o) => !o && onClose()} title={`Remove ${stage.name}?`} confirmLabel="Remove stage" danger loading={busy("remove")} confirmDisabled={stage.openCount > 0 && !moveTo}
      description={stage.openCount ? `${stage.openCount} open ${stage.openCount === 1 ? "deal is" : "deals are"} in this stage. They'll move to the stage you choose, and each move is recorded in the deal's history.` : "No open deals are in this stage. Closed deals keep their history."}
      onConfirm={async () => { if (await run("remove", () => deleteStageAction(scope.orgId, stage.id, stage.openCount ? moveTo : null), "Stage removed.")) onClose(); }}>
      {stage.openCount > 0 && (
        <Field label="Move its deals to" htmlFor="rm-to">
          <Select id="rm-to" value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
            {targets.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
      )}
    </ConfirmDialog>
  );
}

export function NewPipelineDialog({ open, onOpenChange, scope, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; scope: CrmScope; onCreated: (id: string) => void }) {
  const { run, busy } = useCrmAction();
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="New pipeline" description="It starts with iAcquire's standard stages, which you can rename, reorder or remove." size="sm"
      footer={<><Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button><Button form="np-form" type="submit" disabled={!name.trim()} loading={busy("create")}>Create pipeline</Button></>}>
      <form id="np-form" className="space-y-3" onSubmit={async (e) => {
        e.preventDefault();
        const r = await run("create", () => createPipelineAction(scope.orgId, { name: name.trim(), description: description.trim() || null }), "Pipeline created.");
        if (r) {
          onOpenChange(false);
          onCreated(r.id);
        }
      }}>
        <Field label="Name" htmlFor="np-name"><Input id="np-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Commercial projects" autoFocus /></Field>
        <Field label="Description" htmlFor="np-desc" optional><Textarea id="np-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} /></Field>
      </form>
    </Dialog>
  );
}
