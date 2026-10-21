// The canvas as pure functions over the workflow definition: where each node sits, and the nodes and edges React Flow draws. Nothing here renders
// or holds state, and nothing is stored apart from the editor-layout position a person gives a node (step.ui), which never changes what runs.
//
// The definition is the only truth. A node's position comes from its own `ui` when it has one; otherwise from a tidy layout of the graph, placed
// relative to the nodes that are already where the person put them. So a step the builder adds appears next to the steps it connects to, and the
// rest of the canvas does not jump.
import type { Edge, MarkerType, Node } from "@xyflow/react";
import { stepSuccessors, STEP_KINDS, type ValidationIssue, type WorkflowDefinition, type WorkflowStep } from "@/lib/crm/workflow/spec";
import { branchSideLabels, kindLabel, stepSummary, triggerSummary, type Names } from "@/components/crm/workflows/summaries";

export const TRIGGER_ID = "@trigger";
export const NODE_WIDTH = 264;
export const X_STEP = 320;
export const Y_STEP = 168;

export interface Pos {
  x: number;
  y: number;
}

export type ChangeMark = "added" | "modified" | "moved" | "removed";

export interface StepNodeData extends Record<string, unknown> {
  step: WorkflowStep;
  kind: string;
  title: string;
  summary: string;
  number: number;
  errors: number;
  warnings: number;
  firstProblem: string | null;
  /** The first step: the one the trigger starts. */
  entry: boolean;
  /** Each time a run reaches it, a person approves it first. */
  asksApproval: boolean;
  /** Reaches outside the CRM (a message, an outside system, an AI employee). */
  outside: boolean;
  branchLabels: { yes: string; no: string } | null;
  mark: ChangeMark | null;
  readOnly: boolean;
}

export interface TriggerNodeData extends Record<string, unknown> {
  title: string;
  detail: string;
  type: string;
  errors: number;
  firstProblem: string | null;
  mark: ChangeMark | null;
  readOnly: boolean;
}

export type StudioNode = Node<StepNodeData, "step"> | Node<TriggerNodeData, "trigger">;

export interface StudioEdgeData extends Record<string, unknown> {
  via: "next" | "yes" | "no";
  label: string | null;
  mark: "added" | null;
}
export type StudioEdge = Edge<StudioEdgeData, "studio">;

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * A tidy top-to-bottom layout of the whole graph: the trigger at the top, each step one row below the deepest step that leads to it, siblings
 * side by side (a Yes path to the left of its No path), a parent centred over its children. Steps nothing reaches sit in a row underneath.
 */
export function autoLayout(def: WorkflowDefinition): Map<string, Pos> {
  const out = new Map<string, Pos>([[TRIGGER_ID, { x: 0, y: 0 }]]);
  const steps = def.steps ?? [];
  const byKey = new Map(steps.map((s) => [s.key, s]));
  const entry = steps[0]?.key;
  if (!entry) return out;

  // Depth-first from the entry: a visiting order (Yes before No) and a topological order that ignores edges that close a loop.
  const order = new Map<string, number>();
  const post: string[] = [];
  const state = new Map<string, 1 | 2>();
  const backEdges = new Set<string>();
  const visit = (k: string) => {
    state.set(k, 1);
    order.set(k, order.size);
    for (const n of stepSuccessors(byKey.get(k)!)) {
      if (!byKey.has(n)) continue;
      const st = state.get(n);
      if (st === 1) backEdges.add(`${k}>${n}`);
      else if (!st) visit(n);
    }
    state.set(k, 2);
    post.push(k);
  };
  visit(entry);

  const depth = new Map<string, number>([[entry, 1]]);
  const parents = new Map<string, string[]>();
  for (const k of [...post].reverse()) {
    const d = depth.get(k) ?? 1;
    for (const n of stepSuccessors(byKey.get(k)!)) {
      if (!byKey.has(n) || backEdges.has(`${k}>${n}`)) continue;
      depth.set(n, Math.max(depth.get(n) ?? 1, d + 1));
      parents.set(n, [...(parents.get(n) ?? []), k]);
    }
  }

  const layers = new Map<number, string[]>();
  for (const [k, d] of depth) layers.set(d, [...(layers.get(d) ?? []), k]);
  const x = new Map<string, number>([[TRIGGER_ID, 0]]);
  const maxDepth = Math.max(...depth.values());
  for (let d = 1; d <= maxDepth; d++) {
    const keys = (layers.get(d) ?? []).sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    // Where each would like to be: under the average of its parents (the entry under the trigger), a Yes child left of its parent, a No child right.
    const want = new Map<string, number>();
    for (const k of keys) {
      const ps = parents.get(k) ?? [];
      if (d === 1 || !ps.length) {
        want.set(k, 0);
        continue;
      }
      const xs = ps.map((p) => {
        const px = x.get(p) ?? 0;
        const parent = byKey.get(p)!;
        if (parent.kind === "branch") {
          const side = parent.branches?.yes === k && parent.branches?.no === k ? 0 : parent.branches?.yes === k ? -0.5 : 0.5;
          return px + side * X_STEP;
        }
        return px;
      });
      want.set(k, xs.reduce((a, b) => a + b, 0) / xs.length);
    }
    const sorted = [...keys].sort((a, b) => want.get(a)! - want.get(b)! || (order.get(a) ?? 0) - (order.get(b) ?? 0));
    const placed: number[] = [];
    sorted.forEach((k, i) => placed.push(i === 0 ? want.get(k)! : Math.max(want.get(k)!, placed[i - 1] + X_STEP)));
    // Keep the row centred on where its members wanted to be, so spreading a crowded row doesn't drift the whole tree sideways.
    const shift = sorted.reduce((a, k) => a + want.get(k)!, 0) / sorted.length - placed.reduce((a, b) => a + b, 0) / placed.length;
    sorted.forEach((k, i) => {
      x.set(k, placed[i] + shift);
      out.set(k, { x: placed[i] + shift, y: d * Y_STEP });
    });
  }

  // Unreachable steps: their own row at the bottom, left to right.
  const stray = steps.filter((s) => !depth.has(s.key));
  stray.forEach((s, i) => out.set(s.key, { x: (i - (stray.length - 1) / 2) * X_STEP, y: (maxDepth + 2) * Y_STEP }));
  return out;
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/**
 * Where every node is drawn. A step the person (or an earlier layout) positioned keeps its `ui` position; any other is placed where the tidy layout
 * puts it relative to its nearest positioned predecessor, so adding a step never moves the ones already arranged.
 */
export function positions(def: WorkflowDefinition, opts: { ignoreSaved?: boolean } = {}): Map<string, Pos> {
  const auto = autoLayout(def);
  const out = new Map<string, Pos>([[TRIGGER_ID, auto.get(TRIGGER_ID)!]]);
  const steps = def.steps ?? [];
  const byKey = new Map(steps.map((s) => [s.key, s]));
  const incoming = new Map<string, string[]>();
  const entry = steps[0]?.key;
  if (entry) incoming.set(entry, [TRIGGER_ID]);
  for (const s of steps) for (const n of stepSuccessors(s)) if (byKey.has(n)) incoming.set(n, [...(incoming.get(n) ?? []), s.key]);

  const own = (s: WorkflowStep): Pos | null => (!opts.ignoreSaved && finite(s.ui?.x) && finite(s.ui?.y) ? { x: s.ui!.x!, y: s.ui!.y! } : null);
  const resolved = new Map<string, Pos>();
  for (const s of steps) {
    const p = own(s);
    if (p) resolved.set(s.key, p);
  }
  // Nodes without a saved position, shallowest first, hang off a predecessor that already has a position (its own, or one given a moment ago);
  // one with no such predecessor takes the tidy layout's place.
  const pending = steps.filter((s) => !resolved.has(s.key)).sort((a, b) => (auto.get(a.key)?.y ?? 0) - (auto.get(b.key)?.y ?? 0));
  for (const s of pending) {
    const a = auto.get(s.key)!;
    const anchor = (incoming.get(s.key) ?? []).find((p) => p !== TRIGGER_ID && resolved.has(p));
    if (anchor) {
      const at = resolved.get(anchor)!;
      const aa = auto.get(anchor)!;
      resolved.set(s.key, { x: at.x + (a.x - aa.x), y: at.y + (a.y - aa.y) });
    } else resolved.set(s.key, a);
  }
  for (const s of steps) out.set(s.key, resolved.get(s.key) ?? auto.get(s.key)!);
  return out;
}

// ---------------------------------------------------------------------------
// Nodes and edges
// ---------------------------------------------------------------------------

export interface FlowInput {
  def: WorkflowDefinition;
  names: Names;
  issues: ValidationIssue[];
  /** Recent change marks by node key (the trigger is TRIGGER_ID), shown while the builder's change is being drawn. */
  marks?: ReadonlyMap<string, ChangeMark>;
  /** Edges that were just added, by id. */
  addedEdges?: ReadonlySet<string>;
  readOnly?: boolean;
}

const OUTSIDE = new Set(["send_message", "request_review", "n8n", "webhook", "ai_task", "http_request", "slack_message"]);
export const edgeId = (from: string, via: string, to: string) => `${from}:${via}:${to}`;

export function toFlow({ def, names, issues, marks, addedEdges, readOnly = false }: FlowInput): { nodes: StudioNode[]; edges: StudioEdge[] } {
  const pos = positions(def);
  const steps = def.steps ?? [];
  const keys = new Set(steps.map((s) => s.key));
  const problemsOf = (key: string | null) => issues.filter((i) => (key === null ? !i.stepKey : i.stepKey === key));
  const trig = triggerSummary(def.trigger, names);
  const triggerProblems = issues.filter((i) => !i.stepKey);
  const nodes: StudioNode[] = [
    {
      id: TRIGGER_ID, type: "trigger", position: pos.get(TRIGGER_ID)!, draggable: false, deletable: false, selectable: true, ariaLabel: `Trigger. ${trig.title}. ${trig.detail}`,
      data: {
        title: trig.title, detail: trig.detail, type: def.trigger?.type ?? "", errors: triggerProblems.filter((i) => i.level === "error").length,
        firstProblem: triggerProblems.find((i) => i.level === "error")?.message ?? null, mark: marks?.get(TRIGGER_ID) ?? null, readOnly,
      },
    },
    ...steps.map((step, i): StudioNode => {
      const p = problemsOf(step.key);
      const errors = p.filter((x) => x.level === "error");
      return {
        id: step.key, type: "step", position: pos.get(step.key)!, deletable: !readOnly, draggable: !readOnly, ariaLabel: `Step ${i + 1}: ${step.name?.trim() || kindLabel(step.kind)}. ${stepSummary(step, names)}`,
        data: {
          step, kind: step.kind, title: step.name?.trim() || kindLabel(step.kind), summary: stepSummary(step, names), number: i + 1, errors: errors.length, warnings: p.length - errors.length,
          firstProblem: (errors[0] ?? p[0])?.message ?? null, entry: i === 0, asksApproval: step.requireApproval === true, outside: OUTSIDE.has(step.kind),
          branchLabels: step.kind === "branch" ? branchSideLabels(step, names) : null, mark: marks?.get(step.key) ?? null, readOnly,
        },
      };
    }),
  ];

  const edges: StudioEdge[] = [];
  const marker = { type: "arrowclosed" as MarkerType, width: 16, height: 16 };
  const push = (from: string, via: "next" | "yes" | "no", to: string, label: string | null) => {
    const id = edgeId(from, via, to);
    edges.push({ id, source: from, target: to, sourceHandle: via, targetHandle: "in", type: "studio", markerEnd: marker, deletable: !readOnly, data: { via, label, mark: addedEdges?.has(id) ? "added" : null } });
  };
  if (steps[0]) push(TRIGGER_ID, "next", steps[0].key, null);
  for (const s of steps) {
    if (s.kind === "end") continue;
    if (s.kind === "branch") {
      const labels = branchSideLabels(s, names);
      if (s.branches?.yes && keys.has(s.branches.yes)) push(s.key, "yes", s.branches.yes, labels.yes);
      if (s.branches?.no && keys.has(s.branches.no)) push(s.key, "no", s.branches.no, labels.no);
    } else if (s.next && keys.has(s.next)) push(s.key, "next", s.next, null);
  }
  return { nodes, edges };
}

/** Whether a step kind can be connected onward at all, and by which handles (End has none). */
export function sourceHandles(kind: string): Array<"next" | "yes" | "no"> {
  if (!(kind in STEP_KINDS)) return [];
  return kind === "end" ? [] : kind === "branch" ? ["yes", "no"] : ["next"];
}
