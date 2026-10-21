// The upgrade page's example, as data: one request, the builder's draft, one change, and what would come next. It is a fixed script played
// back on a drawing of the canvas. Nothing here is the person's data, nothing calls the builder, and nothing is saved or sent.
//
// The steps use the product's own words (kind labels and the summaries the real canvas prints); tests/automation-studio-upgrade-page.test.tsx
// builds the same automation with the real workflow spec and checks every label here against it, so the example can't drift into something the
// builder doesn't do. This file imports nothing from the product so the page's script stays small.

export type DemoNodeId = "trigger" | "text" | "task" | "wait" | "check" | "end";
/** What a node is, for its colour and the legend: what starts it, a step that does something, a pause, a decision, or the end of a path. */
export type DemoCategory = "trigger" | "action" | "delay" | "condition" | "end";

export interface DemoNode {
  id: DemoNodeId;
  /** The step kind in the workflow spec ("trigger" for the trigger). */
  kind: string;
  category: DemoCategory;
  /** The small line above the title, as the real canvas prints it. */
  meta: string;
  title: string;
  summary: string;
  /** Reaches outside the CRM (the real canvas marks these "Reaches out"). */
  reachesOut?: boolean;
}

export const DEMO_TEMPLATE_NAME = "Welcome text";

export const DEMO_NODES: Record<DemoNodeId, DemoNode> = {
  trigger: { id: "trigger", kind: "trigger", category: "trigger", meta: "When this happens", title: "Contact created", summary: "A new lead is added, from any source" },
  text: { id: "text", kind: "send_message", category: "action", meta: "First step · Send message", title: "Send a welcome text", summary: `Send SMS “${DEMO_TEMPLATE_NAME}” as Sales Assistant, in business hours`, reachesOut: true },
  task: { id: "task", kind: "create_task", category: "action", meta: "Create task", title: "Follow-up call", summary: "Task “Follow-up call” for the contact's owner, due in 1 day (high priority)" },
  wait: { id: "wait", kind: "wait", category: "delay", meta: "Wait", title: "Give them a day", summary: "Wait 1 day" },
  check: { id: "check", kind: "branch", category: "condition", meta: "If / else", title: "No reply yet?", summary: "If they haven't replied since this run started" },
  end: { id: "end", kind: "end", category: "end", meta: "End", title: "End", summary: "Stop the workflow here" },
};

export interface DemoEdge {
  id: string;
  from: DemoNodeId;
  to: DemoNodeId;
  /** Which output it leaves from: a branch has Yes and No. */
  via: "next" | "yes" | "no";
}

export const DEMO_EDGES: Record<string, DemoEdge> = {
  "trigger>text": { id: "trigger>text", from: "trigger", to: "text", via: "next" },
  "text>task": { id: "text>task", from: "text", to: "task", via: "next" },
  "text>wait": { id: "text>wait", from: "text", to: "wait", via: "next" },
  "wait>check": { id: "wait>check", from: "wait", to: "check", via: "next" },
  "check>task": { id: "check>task", from: "check", to: "task", via: "yes" },
  "check>end": { id: "check>end", from: "check", to: "end", via: "no" },
};

export const DEMO_MESSAGES = [
  { from: "you", text: "When a new lead comes in, send a welcome text and create a follow-up task." },
  { from: "ai", text: "Here’s a draft: each new contact gets your approved welcome text, then their owner gets a follow-up call task. It texts customers, so the owner approves it before it runs." },
  { from: "you", text: "Wait a day first, and only create the task if they haven’t replied." },
  { from: "ai", text: "Updated: it waits a day, then checks for a reply. No reply, and the owner gets the task; a reply ends it. Nothing else changed." },
] as const;

/** What would happen next in a workspace with the plan, in the product's own terms. Shown when the example ends. */
export const NEXT_STEPS = [
  { key: "test", title: "Test it on a real contact", text: "A dry run: nothing is sent or changed." },
  { key: "publish", title: "Publish it", text: "The owner approves this version before it runs." },
  { key: "refine", title: "Keep refining", text: "By chat or on the canvas. Every published version is kept." },
] as const;

/** The canvas is drawn in one of two arrangements, and each beat shows the first ("a", the draft) or the second ("b", after the change). */
export type DemoStage = "a" | "b";

export const CHAPTERS = ["Describe", "Build", "Refine", "Next steps"] as const;

export interface Beat {
  /** How long after the previous beat this one lands, in ms. */
  after: number;
  chapter: 0 | 1 | 2 | 3;
  /** Messages shown, counted from the start of DEMO_MESSAGES. */
  messages: number;
  /** The builder's status line while it works on the next reply (the real builder's wording). */
  status?: string;
  stage: DemoStage;
  nodes: DemoNodeId[];
  edges: string[];
  /** The nodes this beat is about: highlighted while it lasts. */
  focus?: DemoNodeId[];
  /** The "what happens next" card. */
  next?: boolean;
  /** What this beat shows, in a sentence: the caption under the example and what a screen reader hears when stepping through. */
  caption: string;
}

const DRAFT: DemoNodeId[] = ["trigger", "text", "task"];
const CHANGED: DemoNodeId[] = ["trigger", "text", "task", "wait", "check", "end"];
const FINAL_EDGES = ["trigger>text", "text>wait", "wait>check", "check>task", "check>end"];

export const BEATS: Beat[] = [
  { after: 0, chapter: 0, messages: 0, stage: "a", nodes: [], edges: [], caption: "An empty draft, waiting for a request." },
  { after: 600, chapter: 0, messages: 1, stage: "a", nodes: [], edges: [], caption: "You describe the automation in plain English." },
  { after: 1100, chapter: 1, messages: 1, status: "Reading your workflow…", stage: "a", nodes: [], edges: [], caption: "The builder reads your request and the draft." },
  { after: 1000, chapter: 1, messages: 1, status: "Working on it…", stage: "a", nodes: [], edges: [], caption: "It works out what starts the automation and each step." },
  { after: 1100, chapter: 1, messages: 2, stage: "a", nodes: [], edges: [], caption: "It explains the draft, then draws it on the canvas." },
  { after: 1100, chapter: 1, messages: 2, stage: "a", nodes: ["trigger"], edges: [], focus: ["trigger"], caption: "First, the trigger: a contact is created." },
  { after: 1000, chapter: 1, messages: 2, stage: "a", nodes: ["trigger", "text"], edges: ["trigger>text"], focus: ["text"], caption: "Then the welcome text, from an approved template." },
  { after: 1000, chapter: 1, messages: 2, stage: "a", nodes: DRAFT, edges: ["trigger>text", "text>task"], focus: ["task"], caption: "Then a follow-up task for the lead’s owner." },
  { after: 2300, chapter: 2, messages: 3, stage: "a", nodes: DRAFT, edges: ["trigger>text", "text>task"], caption: "You ask for a change, in the same conversation." },
  { after: 1000, chapter: 2, messages: 3, status: "Working on it…", stage: "a", nodes: DRAFT, edges: ["trigger>text", "text>task"], caption: "The builder changes the same draft rather than starting over." },
  { after: 1100, chapter: 2, messages: 4, stage: "b", nodes: DRAFT, edges: ["trigger>text"], focus: ["task"], caption: "It makes room: the task moves down." },
  { after: 1000, chapter: 2, messages: 4, stage: "b", nodes: ["trigger", "text", "task", "wait"], edges: ["trigger>text", "text>wait"], focus: ["wait"], caption: "It adds a one-day wait…" },
  { after: 1000, chapter: 2, messages: 4, stage: "b", nodes: ["trigger", "text", "task", "wait", "check"], edges: ["trigger>text", "text>wait", "wait>check"], focus: ["check"], caption: "…then a check for a reply." },
  { after: 1000, chapter: 2, messages: 4, stage: "b", nodes: CHANGED, edges: FINAL_EDGES, focus: ["task", "end"], caption: "No reply leads to the task. A reply ends the run." },
  { after: 2000, chapter: 3, messages: 4, stage: "b", nodes: CHANGED, edges: FINAL_EDGES, next: true, caption: "In your workspace, you’d test it, then publish it." },
];
export const LAST = BEATS.length - 1;

/** Where each chapter starts when it's chosen. "Describe" starts with the request already written. */
export const CHAPTER_START: readonly number[] = CHAPTERS.map((_, c) => (c === 0 ? 1 : BEATS.findIndex((b) => b.chapter === c)));

// ---------------------------------------------------------------------------
// Geometry: where each node sits, in canvas units. "wide" for a desktop-sized canvas, "narrow" for a phone. The main path runs straight down;
// the If / else's No path steps out to the right to an End.
// ---------------------------------------------------------------------------

export type DemoLayout = "wide" | "narrow";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const SIZE: Record<DemoLayout, { node: { w: number; h: number }; end: { w: number; h: number } }> = {
  wide: { node: { w: 264, h: 96 }, end: { w: 136, h: 40 } },
  narrow: { node: { w: 248, h: 78 }, end: { w: 112, h: 34 } },
};

/** Each node's centre x and top y, per layout and stage. A node a stage doesn't use is absent. */
const PLACES: Record<DemoLayout, Record<DemoStage, Partial<Record<DemoNodeId, [number, number]>>>> = {
  wide: {
    a: { trigger: [0, 0], text: [0, 132], task: [0, 264] },
    b: { trigger: [0, 0], text: [0, 132], wait: [0, 264], check: [0, 396], task: [0, 536], end: [236, 564] },
  },
  narrow: {
    a: { trigger: [0, 0], text: [0, 104], task: [0, 208] },
    b: { trigger: [0, 0], text: [0, 104], wait: [0, 208], check: [0, 312], end: [84, 426], task: [0, 484] },
  },
};

export function nodeBox(layout: DemoLayout, stage: DemoStage, id: DemoNodeId): Box | null {
  const at = PLACES[layout][stage][id];
  if (!at) return null;
  const size = id === "end" ? SIZE[layout].end : SIZE[layout].node;
  return { x: at[0] - size.w / 2, y: at[1], w: size.w, h: size.h };
}

/** Everything a stage will show, shown or not yet: the camera frames this, so nodes appearing one by one never move the view. */
export function stageFrame(layout: DemoLayout, stage: DemoStage): Box {
  const boxes = (Object.keys(PLACES[layout][stage]) as DemoNodeId[]).map((id) => nodeBox(layout, stage, id)!);
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
}

/** Where a line leaves its node: the bottom centre, or for an If / else's No the right of its bottom edge. */
function outlet(box: Box, via: DemoEdge["via"], layout: DemoLayout): [number, number] {
  const cx = box.x + box.w / 2;
  return [via === "no" ? (layout === "wide" ? box.x + box.w * 0.84 : cx + 84) : cx, box.y + box.h];
}

/** A line from one node down to another, with rounded corners where it steps sideways (the shape the real canvas draws). */
export function edgePath(layout: DemoLayout, stage: DemoStage, edge: DemoEdge): { d: string; label: [number, number] | null; end: [number, number] } | null {
  const a = nodeBox(layout, stage, edge.from);
  const b = nodeBox(layout, stage, edge.to);
  if (!a || !b) return null;
  const [sx, sy] = outlet(a, edge.via, layout);
  const tx = b.x + b.w / 2;
  const ty = b.y;
  const midY = (sy + ty) / 2;
  let d: string;
  if (Math.abs(tx - sx) < 1) d = `M${sx},${sy} L${tx},${ty}`;
  else {
    const dir = tx > sx ? 1 : -1;
    const r = Math.min(14, Math.abs(tx - sx) / 2, (ty - sy) / 2);
    d = `M${sx},${sy} L${sx},${midY - r} Q${sx},${midY} ${sx + dir * r},${midY} L${tx - dir * r},${midY} Q${tx},${midY} ${tx},${midY + r} L${tx},${ty}`;
  }
  const label: [number, number] | null = edge.via === "next" ? null : Math.abs(tx - sx) < 1 ? [sx, midY] : [(sx + tx) / 2, midY];
  return { d, label, end: [tx, ty] };
}

/** What changed from one beat to the next one: the nodes and lines that just appeared (drawn with a short entrance). */
export function freshBetween(prev: Beat | undefined, beat: Beat): { nodes: Set<string>; edges: Set<string> } {
  const nodes = new Set(beat.nodes.filter((n) => !prev?.nodes.includes(n)));
  const edges = new Set(beat.edges.filter((e) => !prev?.edges.includes(e)));
  return { nodes, edges };
}
