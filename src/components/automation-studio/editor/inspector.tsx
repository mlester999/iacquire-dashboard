"use client";

import * as React from "react";
import { MessageSquareText, MousePointerClick } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { StepPanel } from "@/components/crm/workflows/step-panel";
import { TriggerPanel } from "@/components/crm/workflows/trigger-panel";
import type { EditorOptions } from "@/components/crm/workflows/types";
import { TRIGGER_ID } from "@/components/automation-studio/canvas/flow-model";
import { onNodeDelete, onStepEdited, onTriggerEdited, type Gesture } from "@/components/automation-studio/canvas/gestures";
import type { StudioEditor } from "@/components/automation-studio/editor/use-studio-editor";

/**
 * The settings of the selected step or trigger. It is the same panel the CRM workflow editor uses, so the pickers, the checks and the wording are the
 * same; what changed is where its edits go: each becomes an operation on the shared workflow, like a drag or a chat message.
 */
export function Inspector({ editor, options, selectedKey, onAsk, className }: { editor: StudioEditor; options: EditorOptions; selectedKey: string | null; onAsk?: () => void; className?: string }) {
  const locked = editor.readOnly || editor.locked;
  const run = (g: Gesture, key?: string) => {
    const r = editor.gesture(g, key);
    if (!r.ok && r.message) toast.message(r.message);
  };

  if (!selectedKey) {
    return (
      <div className={className}>
        <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-muted">
          <MousePointerClick className="size-6 text-faint" aria-hidden />
          <p className="text-[14px] font-medium text-ink">Select a step to change its settings</p>
          <p className="max-w-[240px] text-[13px] leading-relaxed">Click a step on the canvas, or the box at the top to change what starts the workflow.</p>
        </div>
      </div>
    );
  }

  if (selectedKey === TRIGGER_ID) {
    return (
      <div className={className}>
        <div className="space-y-4 p-4">
          <TriggerPanel
            trigger={editor.definition.trigger}
            options={options}
            issues={editor.issues.filter((i) => !i.stepKey)}
            readOnly={locked}
            inboundUrl={null}
            onChange={(t) => run(onTriggerEdited(t), "edit:trigger")}
          />
          {onAsk && <AskButton onAsk={onAsk} what="the trigger" disabled={locked} />}
        </div>
      </div>
    );
  }

  const index = editor.definition.steps.findIndex((s) => s.key === selectedKey);
  const step = editor.definition.steps[index];
  if (!step) {
    return (
      <div className={className}>
        <p className="p-6 text-center text-[14px] text-muted">That step is no longer there.</p>
      </div>
    );
  }
  return (
    <div className={className}>
      <div className="space-y-4 p-4">
        <StepPanel
          key={step.key}
          step={step}
          number={index + 1}
          definition={editor.definition}
          options={options}
          issues={editor.issues.filter((i) => i.stepKey === step.key)}
          readOnly={locked}
          base="studio-step"
          onChange={(next) => run(onStepEdited(editor.definition, next), `edit:${step.key}`)}
          onRemove={() => {
            const g = onNodeDelete(editor.definition, step.key);
            run(g);
            if (g.ok) toast.message(g.label, { action: { label: "Undo", onClick: () => { const r = editor.undo(); if (!r.ok && r.message) toast.message(r.message); } } });
          }}
        />
        {onAsk && <AskButton onAsk={onAsk} what="this step" disabled={locked} />}
      </div>
    </div>
  );
}

function AskButton({ onAsk, what, disabled }: { onAsk: () => void; what: string; disabled: boolean }) {
  return (
    <Button variant="soft" size="sm" onClick={onAsk} disabled={disabled} className="w-full"><MessageSquareText className="size-4" aria-hidden />Ask the builder about {what}</Button>
  );
}
