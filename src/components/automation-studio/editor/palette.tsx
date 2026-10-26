"use client";

import * as React from "react";
import { Search } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import { kindChoices, newStep } from "@/components/crm/workflows/editor-logic";
import { StepIcon, stepTone } from "@/components/crm/workflows/parts";
import type { EditorOptions } from "@/components/crm/workflows/types";
import { STEP_KINDS, type StepKind } from "@/lib/crm/workflow/spec";
import { TRIGGER_ID } from "@/components/automation-studio/canvas/flow-model";
import { onInsertAfter, onPaletteDrop } from "@/components/automation-studio/canvas/gestures";
import { PALETTE_MIME } from "@/components/automation-studio/canvas/workflow-canvas";
import type { StudioEditor } from "@/components/automation-studio/editor/use-studio-editor";

/**
 * Every kind of step, grouped and searchable. Drag one onto the canvas, or click it to add it after the selected step (or first, in an empty
 * workflow). A step that can't do anything yet in this workspace says why, and can still be added: the workflow can be built before its pieces exist.
 */
export function Palette({ editor, options, selectedKey, onAdded, className }: { editor: StudioEditor; options: EditorOptions; selectedKey: string | null; onAdded?: (key: string) => void; className?: string }) {
  const [q, setQ] = React.useState("");
  const locked = editor.readOnly || editor.locked;
  const groups = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = new Map<string, ReturnType<typeof kindChoices>>();
    for (const k of kindChoices(options)) {
      if (needle && !`${k.label} ${k.description} ${k.group}`.toLowerCase().includes(needle)) continue;
      out.set(k.group, [...(out.get(k.group) ?? []), k]);
    }
    return [...out];
  }, [options, q]);

  const add = (kind: string) => {
    if (locked || !(kind in STEP_KINDS)) return;
    const def = editor.definition;
    const k = kind as StepKind;
    const config = newStep(def.steps, k, options).config as Record<string, unknown>;
    const sel = selectedKey && selectedKey !== TRIGGER_ID ? def.steps.find((s) => s.key === selectedKey) : null;
    let g;
    if (!def.steps.length) g = onInsertAfter(def, k, null, "next", config);
    else if (sel && sel.kind !== "end") {
      const via = sel.kind === "branch" ? (sel.branches?.yes ? (sel.branches?.no ? "yes" : "no") : "yes") : "next";
      g = onInsertAfter(def, k, sel.key, via, config);
    } else {
      g = onPaletteDrop(def, k, { x: 0, y: 0 }, config);
      // No position was given: leave the new step where the tidy layout puts it.
      if (g.ok) g = { ...g, operations: g.operations.filter((o) => o.op !== "position_step") };
    }
    const r = editor.gesture(g);
    if (!r.ok && r.message) toast.message(r.message);
    else if (g.ok) {
      const added = g.operations.find((o) => o.op === "add_step");
      if (added && added.op === "add_step" && added.key) {
        onAdded?.(added.key);
        if ("detached" in added.at) toast.message(`Placed the “${STEP_KINDS[k].label}” step. Draw a line to it from the step that should lead there.`);
      }
    }
  };

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="shrink-0 p-3">
        <label htmlFor="studio-palette-search" className="sr-only">Search steps</label>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" aria-hidden />
          <Input id="studio-palette-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search steps" className="pl-8" />
        </div>
        <p className="mt-2 text-[12px] leading-snug text-muted">Drag a step onto the canvas, or click it to add it after the selected step.</p>
      </div>
      <div className="scrollbar-thin min-h-0 flex-1 space-y-4 overflow-y-auto px-3 pb-4">
        {groups.length === 0 && <p className="px-1 text-[13px] text-muted">No step matches “{q}”.</p>}
        {groups.map(([group, items]) => (
          <section key={group} aria-label={group}>
            <h3 className="px-1 pb-1.5 text-[12px] font-semibold uppercase tracking-wider text-faint">{group}</h3>
            <ul className="space-y-1.5">
              {items.map((k) => (
                <li key={k.kind}>
                  <button
                    type="button"
                    draggable={!locked}
                    disabled={locked}
                    onDragStart={(e) => { e.dataTransfer.setData(PALETTE_MIME, k.kind); e.dataTransfer.effectAllowed = "copy"; }}
                    onClick={() => add(k.kind)}
                    title={k.description}
                    className="flex w-full items-start gap-2.5 rounded-xl border border-line bg-surface p-2 text-left transition-colors hover:border-primary hover:bg-primary-soft/40 disabled:opacity-50"
                  >
                    <span className={cn("inline-flex size-7 shrink-0 items-center justify-center rounded-lg", stepTone(k.kind))}><StepIcon kind={k.kind} /></span>
                    <span className="min-w-0">
                      <span className="block text-[14px] font-medium text-ink">{k.label}</span>
                      {k.note && <span className="block text-[12px] leading-snug text-warning-ink">{k.note}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
