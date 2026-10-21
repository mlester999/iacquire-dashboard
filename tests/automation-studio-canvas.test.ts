// The canvas as pure functions: layout, the nodes and edges drawn from a definition, and what each gesture means as operations. The only rendering
// here is the if / else card's output labels; the point is that what is drawn follows the definition, that dragging can't change what runs, and that
// every gesture is a valid operation or a plain refusal.
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { applyOperations } from "@/lib/crm/workflow/operations";
import { validateDefinition, type WorkflowDefinition, type WorkflowStep } from "@/lib/crm/workflow/spec";
import { branchSideLabels, namesFrom } from "@/components/crm/workflows/summaries";
import { NODE_WIDTH, TRIGGER_ID, X_STEP, Y_STEP, autoLayout, edgeId, positions, sourceHandles, toFlow } from "@/components/automation-studio/canvas/flow-model";
import { onConnect, onDuplicate, onEdgeDelete, onInsertAfter, onNodeDelete, onNodeDragStop, onPaletteDrop, onTidy } from "@/components/automation-studio/canvas/gestures";
import { StepNode } from "@/components/automation-studio/canvas/nodes";

const step = (key: string, kind: WorkflowStep["kind"], config: Record<string, unknown>, next: string | null = null, extra: Partial<WorkflowStep> = {}): WorkflowStep => ({ key, kind, config, next, ...extra }) as WorkflowStep;
const task = (title = "Follow up") => ({ title, priority: "normal", assignee: "none" });
const wait = () => ({ mode: "duration", amount: 1, unit: "days" });
const isNew = { subject: "contact", filter: { op: "and", conditions: [{ field: "lead_status", op: "in", value: ["new"] }] } };
const names = namesFrom({});

const chain = (): WorkflowDefinition => ({ trigger: { type: "contact.created" }, steps: [step("a", "create_task", task(), "b"), step("b", "wait", wait(), "c"), step("c", "internal_note", { subject: "contact", body: "Hi" })] });
/** check → (yes: y, no: n) → both join at "after" */
const branched = (): WorkflowDefinition => ({
  trigger: { type: "contact.created" },
  steps: [
    step("check", "branch", isNew, null, { branches: { yes: "y", no: "n" } }),
    step("y", "create_task", task("yes"), "after"), step("n", "create_task", task("no"), "after"), step("after", "internal_note", { subject: "contact", body: "Done" }),
  ],
});

describe("autoLayout", () => {
  it("has only the trigger for an empty workflow", () => {
    expect([...autoLayout({ trigger: { type: "contact.created" }, steps: [] }).keys()]).toEqual([TRIGGER_ID]);
  });

  it("stacks a plain chain in one column, one row each, below the trigger", () => {
    const p = autoLayout(chain());
    expect([TRIGGER_ID, "a", "b", "c"].map((k) => p.get(k))).toEqual([{ x: 0, y: 0 }, { x: 0, y: Y_STEP }, { x: 0, y: 2 * Y_STEP }, { x: 0, y: 3 * Y_STEP }]);
  });

  it("puts a Yes path to the left of its No path and centres the join beneath them", () => {
    const p = autoLayout(branched());
    expect(p.get("y")!.x).toBeLessThan(p.get("n")!.x);
    expect(p.get("y")!.y).toBe(p.get("n")!.y);
    expect(p.get("after")!.y).toBe(p.get("y")!.y + Y_STEP);
    expect(p.get("after")!.x).toBeCloseTo((p.get("y")!.x + p.get("n")!.x) / 2, 5);
    expect(p.get("check")!.x).toBeCloseTo(p.get("after")!.x, 5);
  });

  it("never lays two nodes on top of each other", () => {
    const wide: WorkflowDefinition = {
      trigger: { type: "contact.created" },
      steps: [
        step("b1", "branch", isNew, null, { branches: { yes: "b2", no: "c" } }),
        step("b2", "branch", isNew, null, { branches: { yes: "d", no: "e" } }),
        step("c", "create_task", task("c")), step("d", "create_task", task("d")), step("e", "create_task", task("e")),
      ],
    };
    for (const def of [branched(), wide, chain()]) {
      const nodes = [...autoLayout(def)].map(([, p]) => p);
      for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
        if (nodes[i].y === nodes[j].y) expect(Math.abs(nodes[i].x - nodes[j].x)).toBeGreaterThanOrEqual(NODE_WIDTH);
      }
    }
  });

  it("lays a loop out once, ignoring the line that goes back", () => {
    const loop: WorkflowDefinition = { trigger: { type: "contact.created" }, steps: [step("a", "create_task", task(), "w"), step("w", "wait", wait(), "a")] };
    const p = autoLayout(loop);
    expect(p.get("a")!.y).toBe(Y_STEP);
    expect(p.get("w")!.y).toBe(2 * Y_STEP);
  });

  it("puts steps nothing reaches in their own row at the bottom", () => {
    const def = chain();
    def.steps.push(step("lost1", "wait", wait()), step("lost2", "wait", wait()));
    const p = autoLayout(def);
    expect(p.get("lost1")!.y).toBe(p.get("lost2")!.y);
    expect(p.get("lost1")!.y).toBeGreaterThan(p.get("c")!.y);
    expect(p.get("lost1")!.x).toBeLessThan(p.get("lost2")!.x);
  });

  it("gives the same layout for the same workflow", () => {
    expect([...autoLayout(branched())]).toEqual([...autoLayout(branched())]);
  });
});

describe("positions", () => {
  it("keeps a position a person gave, and does not move the others when a step is added", () => {
    const def = chain();
    def.steps[0].ui = { x: 500, y: 40 };
    def.steps[1].ui = { x: 520, y: 220 };
    const before = positions(def);
    expect(before.get("a")).toEqual({ x: 500, y: 40 });
    const added = applyOperations(def, [{ op: "add_step", kind: "wait", key: "new", config: wait(), at: { after: "c", via: "next" } }]);
    if (!added.ok) throw new Error("add failed");
    const after = positions(added.definition);
    for (const k of ["a", "b"]) expect(after.get(k)).toEqual(before.get(k));
    // The new step hangs off the step it follows, one row below, where the layout would put it relative to that step.
    const c = after.get("c")!;
    expect(after.get("new")!.y).toBe(c.y + Y_STEP);
    expect(after.get("new")!.x).toBe(c.x);
  });

  it("ignores saved positions when asked (the tidy layout)", () => {
    const def = chain();
    def.steps[0].ui = { x: 999, y: 999 };
    expect(positions(def, { ignoreSaved: true }).get("a")).toEqual({ x: 0, y: Y_STEP });
  });

  it("ignores a saved position that isn't a pair of numbers", () => {
    const def = chain();
    def.steps[0].ui = { x: 12 };
    expect(positions(def).get("a")).toEqual({ x: 0, y: Y_STEP });
  });
});

describe("toFlow", () => {
  it("draws a node for the trigger and each step and a line for each connection, with stable ids", () => {
    const def = branched();
    const { nodes, edges } = toFlow({ def, names, issues: validateDefinition(def, null) });
    expect(nodes.map((n) => n.id)).toEqual([TRIGGER_ID, "check", "y", "n", "after"]);
    expect(edges.map((e) => e.id)).toEqual([edgeId(TRIGGER_ID, "next", "check"), edgeId("check", "yes", "y"), edgeId("check", "no", "n"), edgeId("y", "next", "after"), edgeId("n", "next", "after")]);
    expect(edges.find((e) => e.id === edgeId("check", "yes", "y"))).toMatchObject({ source: "check", sourceHandle: "yes", target: "y", targetHandle: "in", data: { via: "yes" } });
    expect(edges.find((e) => e.id === edgeId("check", "no", "n"))?.data?.label).toBeTruthy();
    // Same definition, same ids: an update animates the same nodes instead of replacing them.
    expect(toFlow({ def: structuredClone(def), names, issues: [] }).nodes.map((n) => n.id)).toEqual(nodes.map((n) => n.id));
  });

  it("describes each step in words and numbers them in order, marking the first", () => {
    const { nodes } = toFlow({ def: chain(), names, issues: [] });
    const steps = nodes.filter((n) => n.type === "step");
    expect(steps.map((n) => (n.data as { number: number }).number)).toEqual([1, 2, 3]);
    expect(steps.map((n) => (n.data as { entry: boolean }).entry)).toEqual([true, false, false]);
    expect((steps[0].data as { summary: string }).summary.length).toBeGreaterThan(0);
  });

  it("shows each step's problems, and the trigger's", () => {
    const def: WorkflowDefinition = { trigger: { type: "contact.created" }, steps: [step("t", "add_tag", { tagIds: [] }, "w"), step("w", "wait", wait())] };
    const issues = validateDefinition(def, null);
    const { nodes } = toFlow({ def, names, issues });
    const tag = nodes.find((n) => n.id === "t")!.data as { errors: number; firstProblem: string | null };
    expect(tag.errors).toBeGreaterThan(0);
    expect(tag.firstProblem).toBeTruthy();
    expect((nodes.find((n) => n.id === "w")!.data as { errors: number }).errors).toBe(0);
  });

  it("flags the steps that reach outside the CRM or ask for approval", () => {
    const def: WorkflowDefinition = { trigger: { type: "contact.created" }, steps: [step("n", "internal_note", { subject: "contact", body: "x" }, "t", { requireApproval: true }), step("t", "ai_task", { roleKey: "crm_manager", instruction: "Check this lead." })] };
    const { nodes } = toFlow({ def, names, issues: [] });
    expect(nodes.find((n) => n.id === "n")!.data).toMatchObject({ asksApproval: true, outside: false });
    expect(nodes.find((n) => n.id === "t")!.data).toMatchObject({ asksApproval: false, outside: true });
  });

  it("carries change marks and new-line marks for the animation, and a read-only flag", () => {
    const def = chain();
    const { nodes, edges } = toFlow({ def, names, issues: [], marks: new Map([["b", "added"], [TRIGGER_ID, "modified"]]), addedEdges: new Set([edgeId("a", "next", "b")]), readOnly: true });
    expect((nodes.find((n) => n.id === "b")!.data as { mark: string | null }).mark).toBe("added");
    expect((nodes.find((n) => n.id === TRIGGER_ID)!.data as { mark: string | null }).mark).toBe("modified");
    expect(edges.find((e) => e.id === edgeId("a", "next", "b"))?.data?.mark).toBe("added");
    expect(nodes.every((n) => (n.data as { readOnly: boolean }).readOnly)).toBe(true);
  });

  it("leaves out a line to a step that no longer exists, and offers handles only where a line can start", () => {
    const def: WorkflowDefinition = { trigger: { type: "contact.created" }, steps: [step("a", "create_task", task(), "ghost")] };
    expect(toFlow({ def, names, issues: [] }).edges.map((e) => e.id)).toEqual([edgeId(TRIGGER_ID, "next", "a")]);
    expect(sourceHandles("wait")).toEqual(["next"]);
    expect(sourceHandles("branch")).toEqual(["yes", "no"]);
    expect(sourceHandles("end")).toEqual([]);
    expect(sourceHandles("nonsense")).toEqual([]);
  });
});

describe("gestures", () => {
  const apply = (def: WorkflowDefinition, g: ReturnType<typeof onConnect>) => {
    if (!g.ok) throw new Error(g.message);
    const r = applyOperations(def, g.operations);
    if (!r.ok) throw new Error(r.error.message);
    return r.definition;
  };

  it("connects steps, and the trigger to a step makes it the first", () => {
    const def = chain();
    expect(apply(def, onConnect(def, { source: "a", sourceHandle: "next", target: "c" })).steps[0].next).toBe("c");
    expect(apply(def, onConnect(def, { source: TRIGGER_ID, sourceHandle: "next", target: "b" })).steps[0].key).toBe("b");
    const br = branched();
    expect(apply(br, onConnect(br, { source: "check", sourceHandle: "no", target: "after" })).steps[0].branches).toEqual({ yes: "y", no: "after" });
    expect(apply(br, onConnect(br, { source: "check", sourceHandle: "yes", target: "after" })).steps[0].branches).toEqual({ yes: "after", no: "n" });
  });

  it("refuses a connection that means nothing, in words", () => {
    const def = chain();
    expect(onConnect(def, { source: "a", sourceHandle: "next", target: "a" })).toMatchObject({ ok: false, message: expect.stringMatching(/itself/) });
    expect(onConnect(def, { source: "a", sourceHandle: "next", target: "nope" })).toMatchObject({ ok: false });
    expect(onConnect(def, { source: "nope", sourceHandle: "next", target: "a" })).toMatchObject({ ok: false });
    const ended: WorkflowDefinition = { trigger: { type: "contact.created" }, steps: [step("a", "create_task", task(), "e"), step("e", "end", {}), step("z", "wait", wait())] };
    expect(onConnect(ended, { source: "e", sourceHandle: "next", target: "z" })).toMatchObject({ ok: false, message: expect.stringMatching(/End/) });
  });

  it("removes a line by ending that path, and won't remove the trigger's line", () => {
    const def = chain();
    expect(apply(def, onEdgeDelete(def, { source: "a", sourceHandle: "next", target: "b" })).steps[0].next).toBeNull();
    expect(onEdgeDelete(def, { source: TRIGGER_ID, sourceHandle: "next", target: "a" })).toMatchObject({ ok: false, message: expect.stringMatching(/trigger always starts/) });
    const br = branched();
    expect(apply(br, onEdgeDelete(br, { source: "check", sourceHandle: "no", target: "n" })).steps[0].branches).toEqual({ yes: "y", no: null });
  });

  it("deletes a step and reconnects the path", () => {
    const def = chain();
    const after = apply(def, onNodeDelete(def, "b"));
    expect(after.steps.map((s) => s.key)).toEqual(["a", "c"]);
    expect(after.steps[0].next).toBe("c");
    expect(onNodeDelete(def, "ghost")).toMatchObject({ ok: false });
  });

  it("turns a drag into a position only: nothing that runs changes", () => {
    const def = chain();
    const g = onNodeDragStop(def, "b", { x: 123.4, y: 55.6 });
    if (!g.ok) throw new Error("drag failed");
    const r = applyOperations(def, g.operations);
    if (!r.ok) throw new Error("apply failed");
    expect(r.contentChanged).toBe(false);
    expect(r.changes).toEqual([{ type: "step_moved", key: "b" }]);
    expect(onNodeDragStop(def, "ghost", { x: 0, y: 0 })).toMatchObject({ ok: false });
  });

  it("adds a dropped step where it landed, unconnected, ready to be wired up", () => {
    const def = chain();
    const g = onPaletteDrop(def, "wait", { x: 640, y: 300 });
    const after = apply(def, g);
    const added = after.steps.find((s) => s.key === "wait")!;
    expect(added).toMatchObject({ kind: "wait", ui: { x: 640, y: 300 }, next: null });
    expect(after.steps.some((s) => s.next === "wait")).toBe(false);
    expect(validateDefinition(after, null).some((i) => i.code === "unreachable" && i.stepKey === "wait")).toBe(true);
    expect(onPaletteDrop(def, "shell" as never, { x: 0, y: 0 })).toMatchObject({ ok: false });
  });

  it("inserts a step after another, or first, and on a path of an if / else", () => {
    const def = chain();
    expect(apply(def, onInsertAfter(def, "wait", "a")).steps.find((s) => s.key === "a")!.next).toBe("wait");
    expect(apply(def, onInsertAfter(def, "wait", null)).steps[0].key).toBe("wait");
    expect(apply(def, onInsertAfter(def, "wait", TRIGGER_ID)).steps[0].key).toBe("wait");
    const br = branched();
    expect(apply(br, onInsertAfter(br, "wait", "check", "no")).steps[0].branches?.no).toBe("wait");
  });

  it("copies a step with its settings beside the original, unconnected", () => {
    const def = chain();
    def.steps[0].requireApproval = true;
    const after = apply(def, onDuplicate(def, "a", { x: 10, y: 20 }));
    const copy = after.steps.find((s) => s.key === "create_task")!;
    expect(copy).toMatchObject({ kind: "create_task", name: "Create task (copy)", config: task(), requireApproval: true, ui: { x: 58, y: 84 } });
    expect(copy.config).not.toBe(def.steps[0].config);
    expect(after.steps.some((s) => s.next === "create_task")).toBe(false);
  });

  it("arranges every step, and only moves them", () => {
    const def = chain();
    def.steps[1].ui = { x: 900, y: 900 };
    const g = onTidy(def, positions(def, { ignoreSaved: true }));
    const after = apply(def, g);
    expect(after.steps.map((s) => s.ui)).toEqual([{ x: 0, y: Y_STEP }, { x: 0, y: 2 * Y_STEP }, { x: 0, y: 3 * Y_STEP }]);
    expect(g.ok && applyOperations(def, g.operations)).toMatchObject({ ok: true, contentChanged: false });
    expect(onTidy({ trigger: { type: "contact.created" }, steps: [] }, new Map())).toMatchObject({ ok: false });
    expect(X_STEP).toBeGreaterThan(NODE_WIDTH);
  });
});

describe("the if / else card", () => {
  /** The card as static HTML with the common entities decoded, so assertions read like the screen. */
  const card = (def: WorkflowDefinition, key: string) => {
    const node = toFlow({ def, names, issues: [] }).nodes.find((n) => n.id === key)!;
    const props = { id: node.id, type: "step", data: node.data, selected: false } as unknown as React.ComponentProps<typeof StepNode>;
    return renderToStaticMarkup(React.createElement(ReactFlowProvider, null, React.createElement(StepNode, props)))
      .replace(/<!-- -->/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  };
  /** One output label: its tooltip, its classes, the word shown, and what only a screen reader hears. */
  const side = (html: string, which: "yes" | "no") => {
    const m = new RegExp(`<span data-branch-side="${which}" title="([^"]*)" class="([^"]*)">(\\w+)<span class="sr-only[^"]*">([^<]*)</span></span>`).exec(html);
    return m && { title: m[1], cls: m[2], word: m[3], spoken: m[4] };
  };
  const replyCheck: WorkflowDefinition = {
    trigger: { type: "contact.created" },
    steps: [step("quiet", "branch", { subject: "contact", filter: { op: "and", conditions: [] }, reply: "not_replied" }, null, { name: "No reply yet?", branches: { yes: null, no: null } })],
  };

  it("labels its outputs a short Yes and No, keeping the whole condition for hover and screen readers", () => {
    const html = card(replyCheck, "quiet");
    const condition = "they haven't replied since this run started";
    expect(side(html, "yes")).toMatchObject({ title: `Yes: ${condition}`, word: "Yes", spoken: `: ${condition}` });
    expect(side(html, "no")).toMatchObject({ title: "No: Otherwise", word: "No", spoken: ": Otherwise" });
    // The condition is still read in full on the card itself (the summary), not squeezed into a label beside the handles.
    expect(html).toContain(`If ${condition}`);
  });

  it("keeps the labels inside the card and hoverable, where no line or handle can cross them", () => {
    const def = branched();
    const html = card(def, "check");
    const [yes, no] = [side(html, "yes"), side(html, "no")];
    expect([yes?.word, no?.word]).toEqual(["Yes", "No"]);
    expect(yes?.title).toBe(`Yes: ${branchSideLabels(def.steps[0], names).yes}`);
    // They used to hang below the card (absolute, -bottom-6) over the handles and the lines leaving them, and ignored the pointer.
    expect(html).not.toMatch(/-bottom-\d/);
    expect(`${yes?.cls} ${no?.cls}`).not.toContain("pointer-events-none");
  });
});
