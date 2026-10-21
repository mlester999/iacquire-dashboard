// What each canvas gesture means, as operations (src/lib/crm/workflow/operations.ts). The canvas never edits the definition itself: it asks for
// one of these, the operations layer validates and applies it, and the result is what is drawn. A gesture that can't mean anything valid returns
// a plain sentence for the person instead of an operation.
import type { WorkflowOperation } from "@/lib/crm/workflow/operations";
import { freshKey } from "@/lib/crm/workflow/graph";
import { STEP_KINDS, type StepKind, type TriggerConfig, type WorkflowDefinition, type WorkflowStep } from "@/lib/crm/workflow/spec";
import { TRIGGER_ID, type Pos } from "@/components/automation-studio/canvas/flow-model";

export type Gesture = { ok: true; operations: WorkflowOperation[]; label: string } | { ok: false; message: string };

const stepOf = (def: WorkflowDefinition, key: string) => def.steps.find((s) => s.key === key);
const nameOf = (s: Pick<WorkflowStep, "kind" | "name">) => s.name?.trim() || STEP_KINDS[s.kind]?.label || s.kind;

/** Drawing a line from a handle to a node. From the trigger it chooses the first step; from a step it sets where that path continues. */
export function onConnect(def: WorkflowDefinition, c: { source: string; sourceHandle: string | null; target: string }): Gesture {
  const target = stepOf(def, c.target);
  if (!target) return { ok: false, message: "A line can only end on a step." };
  if (c.source === c.target) return { ok: false, message: "A step can't lead back to itself." };
  if (c.source === TRIGGER_ID) return { ok: true, operations: [{ op: "set_entry", key: c.target }], label: `${nameOf(target)} now runs first` };
  const from = stepOf(def, c.source);
  if (!from) return { ok: false, message: "That step is no longer there." };
  if (from.kind === "end") return { ok: false, message: "Nothing can follow an End step." };
  const via = from.kind === "branch" ? (c.sourceHandle === "no" ? "no" : "yes") : "next";
  const label = `Connected ${nameOf(from)} to ${nameOf(target)}`;
  return { ok: true, operations: [{ op: "connect", from: c.source, via, to: c.target }], label };
}

/** Removing a line. The line from the trigger can't be removed (a workflow always starts somewhere): connect the trigger to another step instead. */
export function onEdgeDelete(def: WorkflowDefinition, e: { source: string; target: string; sourceHandle: string | null }): Gesture {
  if (e.source === TRIGGER_ID) return { ok: false, message: "The trigger always starts the first step. To change which step is first, draw a line from the trigger to another step." };
  const from = stepOf(def, e.source);
  if (!from) return { ok: false, message: "That step is no longer there." };
  const via = from.kind === "branch" ? (e.sourceHandle === "no" ? "no" : "yes") : "next";
  return { ok: true, operations: [{ op: "connect", from: e.source, via, to: null }], label: `Disconnected ${nameOf(from)}` };
}

export function onNodeDelete(def: WorkflowDefinition, key: string): Gesture {
  const s = stepOf(def, key);
  if (!s) return { ok: false, message: "That step is no longer there." };
  return { ok: true, operations: [{ op: "remove_step", key }], label: `Removed ${nameOf(s)}` };
}

/** The end of a drag. Position only: it can't change what runs. */
export function onNodeDragStop(def: WorkflowDefinition, key: string, p: Pos): Gesture {
  const s = stepOf(def, key);
  if (!s) return { ok: false, message: "That step is no longer there." };
  return { ok: true, operations: [{ op: "position_step", key, x: p.x, y: p.y }], label: `Moved ${nameOf(s)}` };
}

/** Dropping a step from the palette onto the canvas: placed there, joined up later by drawing lines to it. */
export function onPaletteDrop(def: WorkflowDefinition, kind: StepKind, at: Pos, config: Record<string, unknown> = {}): Gesture {
  if (!(kind in STEP_KINDS)) return { ok: false, message: "That kind of step doesn't exist." };
  const key = freshKey(def.steps, kind);
  return {
    ok: true,
    label: `Added ${STEP_KINDS[kind].label}`,
    operations: [
      { op: "add_step", kind, key, config, at: { detached: true } },
      { op: "position_step", key, x: at.x, y: at.y },
    ],
  };
}

/** The "+" on a line or below a step: a new step in that place, the rest of the path carrying on after it. */
export function onInsertAfter(def: WorkflowDefinition, kind: StepKind, after: string | null, via: "next" | "yes" | "no" = "next", config: Record<string, unknown> = {}): Gesture {
  if (!(kind in STEP_KINDS)) return { ok: false, message: "That kind of step doesn't exist." };
  const key = freshKey(def.steps, kind);
  const at = after === null || after === TRIGGER_ID ? { after: null } : { after, via };
  return { ok: true, label: `Added ${STEP_KINDS[kind].label}`, operations: [{ op: "add_step", kind, key, config, at } as WorkflowOperation] };
}

/** A copy beside the original, with the same settings, joined to nothing until the person connects it. */
export function onDuplicate(def: WorkflowDefinition, key: string, from: Pos): Gesture {
  const s = stepOf(def, key);
  if (!s) return { ok: false, message: "That step is no longer there." };
  const copyKey = freshKey(def.steps, s.kind);
  return {
    ok: true,
    label: `Copied ${nameOf(s)}`,
    operations: [
      { op: "add_step", kind: s.kind, key: copyKey, name: `${nameOf(s)} (copy)`.slice(0, 80), config: JSON.parse(JSON.stringify(s.config)) as Record<string, unknown>, ...(s.requireApproval ? { requireApproval: true } : {}), at: { detached: true } },
      { op: "position_step", key: copyKey, x: from.x + 48, y: from.y + 64 },
    ],
  };
}

/** Auto-arrange: every step is given the tidy layout's position (saved, so it stays put). */
export function onTidy(def: WorkflowDefinition, tidy: ReadonlyMap<string, Pos>): Gesture {
  const operations: WorkflowOperation[] = def.steps.flatMap((s) => {
    const p = tidy.get(s.key);
    return p ? [{ op: "position_step", key: s.key, x: p.x, y: p.y } as WorkflowOperation] : [];
  });
  if (!operations.length) return { ok: false, message: "There's nothing to arrange yet." };
  return { ok: true, operations: operations.slice(0, 50), label: "Arranged the steps" };
}

/** The settings panel changed a step (its name, its settings, whether it asks first). The whole step as the panel now has it replaces the old one. */
export function onStepEdited(def: WorkflowDefinition, next: WorkflowStep): Gesture {
  const prev = stepOf(def, next.key);
  if (!prev) return { ok: false, message: "That step is no longer there." };
  return {
    ok: true,
    label: `Changed ${nameOf(next)}`,
    operations: [{ op: "update_step", key: next.key, name: next.name?.trim() ? next.name : null, config: next.config as Record<string, unknown>, replaceConfig: true, requireApproval: next.requireApproval === true }],
  };
}

/** The trigger panel changed what starts the workflow. */
export function onTriggerEdited(next: TriggerConfig): Gesture {
  return { ok: true, label: "Changed what starts the workflow", operations: [{ op: "set_trigger", trigger: next }] };
}
