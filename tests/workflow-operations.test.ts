// The workflow operations: the one validated way to change a definition (the editor's gestures and, later, the AI Builder's proposals), what
// they report as changed, and the undo history built on them. Pure functions: no database, nothing leaves the machine.
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAX_OPERATIONS_PER_BATCH, applyOperations, diffDefinitions, operationSchema, parseOperations, type ApplyResult, type WorkflowOperation } from "@/lib/crm/workflow/operations";
import { HISTORY_LIMIT, canRedo, canUndo, emptyHistory, record, redo, sameDraft, undo, type HistoryEntry } from "@/lib/crm/workflow/history";
import { WORKFLOW_LIMITS, definitionHash, validateDefinition, validationContextFrom, type WorkflowDefinition, type WorkflowStep } from "@/lib/crm/workflow/spec";
import { layoutCanvas } from "@/components/crm/workflows/graph";

const step = (key: string, kind: WorkflowStep["kind"], config: Record<string, unknown>, next: string | null = null, extra: Partial<WorkflowStep> = {}): WorkflowStep => ({ key, kind, config, next, ...extra }) as WorkflowStep;
const task = (title = "Follow up") => ({ title, priority: "normal", assignee: "none" });
const wait = () => ({ mode: "duration", amount: 1, unit: "days" });
const note = (body = "Called") => ({ subject: "contact", body });
const isNew = { subject: "contact", filter: { op: "and", conditions: [{ field: "lead_status", op: "in", value: ["new"] }] } };

/** create task → wait → note */
const base = (): WorkflowDefinition => ({
  trigger: { type: "contact.created" },
  steps: [step("a", "create_task", task(), "b"), step("b", "wait", wait(), "c"), step("c", "internal_note", note())],
});

const ok = (r: ApplyResult) => {
  if (!r.ok) throw new Error(`expected success, got ${r.error.code}: ${r.error.message}`);
  return r;
};
const refused = (r: ApplyResult) => {
  if (r.ok) throw new Error("expected a refusal");
  return r.error;
};
const keys = (d: WorkflowDefinition) => d.steps.map((s) => s.key);
const by = (d: WorkflowDefinition, k: string) => d.steps.find((s) => s.key === k)!;
/** The keys a definition runs, following the graph from its first step (a Yes path before a No path). */
function walk(d: WorkflowDefinition): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (k: string | null | undefined) => {
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push(k);
    const s = by(d, k);
    if (s.kind === "branch") {
      visit(s.branches?.yes);
      visit(s.branches?.no);
    } else visit(s.next);
  };
  visit(d.steps[0]?.key);
  return out;
}

describe("the operation schema", () => {
  it("is a closed set: nothing here can touch an owner's approval or a version", () => {
    const ops = operationSchema.options.map((o) => o.shape.op.value).sort();
    expect(ops).toEqual(["add_step", "connect", "move_step", "patch_trigger", "position_step", "remove_step", "set_entry", "set_trigger", "update_step"]);
  });

  it("accepts well-formed operations", () => {
    const r = parseOperations([{ op: "add_step", kind: "wait", at: { after: "a", via: "next" } }, { op: "position_step", key: "a", x: 10, y: -20 }]);
    expect(r.ok).toBe(true);
  });

  it.each([
    ["an unknown operation", [{ op: "run_code", code: "process.exit()" }], /change 1/],
    ["extra fields", [{ op: "remove_step", key: "a", force: true }], /change 1/],
    ["an unknown step kind", [{ op: "add_step", kind: "shell_command", at: { after: null } }], /change 1/],
    ["a bad step key", [{ op: "remove_step", key: "A step!" }], /Step keys/],
    ["a position that isn't a finite number", [{ op: "position_step", key: "a", x: Number.POSITIVE_INFINITY, y: 0 }], /change 1/],
    ["a position far off the canvas", [{ op: "position_step", key: "a", x: 9_000_000, y: 0 }], /change 1/],
    ["settings that aren't an object", [{ op: "update_step", key: "a", config: "title=Hi" }], /change 1/],
    ["nothing at all", [], /Nothing to change/],
    ["not a list", { op: "remove_step", key: "a" }, /./],
  ])("refuses %s", (_name, input, message) => {
    const r = parseOperations(input);
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message).toMatch(message);
  });

  it("reports which change of the batch was wrong", () => {
    const r = parseOperations([{ op: "remove_step", key: "a" }, { op: "remove_step", key: "a", extra: 1 }, { op: "remove_step", key: "b" }]);
    expect(r).toMatchObject({ ok: false, index: 1 });
  });

  it(`takes at most ${MAX_OPERATIONS_PER_BATCH} changes at a time`, () => {
    const many = Array.from({ length: MAX_OPERATIONS_PER_BATCH + 1 }, () => ({ op: "remove_step", key: "a" }));
    expect(parseOperations(many)).toMatchObject({ ok: false });
    expect(parseOperations(many.slice(1))).toMatchObject({ ok: true });
  });
});

describe("add_step", () => {
  it("puts a step between two others and relinks them", () => {
    const r = ok(applyOperations(base(), [{ op: "add_step", kind: "internal_note", key: "mid", config: note("Hi"), at: { after: "a", via: "next" } }]));
    expect(walk(r.definition)).toEqual(["a", "mid", "b", "c"]);
    expect(r.changes).toEqual(expect.arrayContaining([
      { type: "step_added", key: "mid" },
      { type: "link_changed", from: "a", via: "next", to: "mid", previous: "b" },
      { type: "link_changed", from: "mid", via: "next", to: "b", previous: null },
    ]));
    expect(r.summary).toEqual(["Added “Add internal note”."]);
    expect(r.contentChanged).toBe(true);
  });

  it("puts a step first and runs it first", () => {
    const r = ok(applyOperations(base(), [{ op: "add_step", kind: "wait", key: "first", at: { after: null } }]));
    expect(r.definition.steps[0].key).toBe("first");
    expect(walk(r.definition)).toEqual(["first", "a", "b", "c"]);
  });

  it("gives a step a fresh key and the kind's default settings, and lets given settings win", () => {
    const r = ok(applyOperations(base(), [
      { op: "add_step", kind: "create_task", config: { title: "Second" }, at: { after: "c", via: "next" } },
      { op: "add_step", kind: "wait", config: { amount: 3 }, at: { after: "a", via: "next" } },
    ]));
    // Keys come from the kind and are never reused: create_task, wait (a and b are taken by the base workflow's own steps).
    expect(keys(r.definition)).toEqual(expect.arrayContaining(["create_task", "wait"]));
    expect(by(r.definition, "create_task").config).toMatchObject({ title: "Second", priority: "normal", assignee: "contact_owner" });
    expect(by(r.definition, "wait").config).toEqual({ mode: "duration", amount: 3, unit: "days" });
    const again = ok(applyOperations(r.definition, [{ op: "add_step", kind: "wait", at: { after: "wait", via: "next" } }]));
    expect(keys(again.definition)).toContain("wait_2");
  });

  it("moves what followed the insert point onto the Yes path of a new if / else", () => {
    const r = ok(applyOperations(base(), [{ op: "add_step", kind: "branch", key: "check", config: isNew, at: { after: "a", via: "next" } }]));
    expect(by(r.definition, "check")).toMatchObject({ next: null, branches: { yes: "b", no: null } });
    expect(by(r.definition, "a").next).toBe("check");
  });

  it("refuses a link that doesn't fit the step it hangs from", () => {
    const withBranch = ok(applyOperations(base(), [{ op: "add_step", kind: "branch", key: "check", config: isNew, at: { after: "a", via: "next" } }])).definition;
    expect(refused(applyOperations(base(), [{ op: "add_step", kind: "wait", at: { after: "c", via: "yes" } }]))).toMatchObject({ code: "bad_link", index: 0 });
    expect(refused(applyOperations(withBranch, [{ op: "add_step", kind: "wait", at: { after: "check", via: "next" } }]))).toMatchObject({ code: "bad_link" });
    const ended = ok(applyOperations(base(), [{ op: "add_step", kind: "end", key: "stop", at: { after: "c", via: "next" } }])).definition;
    expect(refused(applyOperations(ended, [{ op: "add_step", kind: "wait", at: { after: "stop", via: "next" } }]))).toMatchObject({ code: "bad_link" });
    expect(refused(applyOperations(base(), [{ op: "add_step", kind: "wait", at: { after: "nope", via: "next" } }]))).toMatchObject({ code: "unknown_step" });
  });

  it("only puts an End where nothing follows", () => {
    expect(refused(applyOperations(base(), [{ op: "add_step", kind: "end", at: { after: "a", via: "next" } }]))).toMatchObject({ code: "bad_position" });
    expect(ok(applyOperations(base(), [{ op: "add_step", kind: "end", at: { after: "c", via: "next" } }])).definition.steps.some((s) => s.kind === "end")).toBe(true);
  });

  it("refuses a duplicate key, too many steps, and approval on a step that doesn't act", () => {
    expect(refused(applyOperations(base(), [{ op: "add_step", kind: "wait", key: "a", at: { after: "c", via: "next" } }]))).toMatchObject({ code: "duplicate_key" });
    const full: WorkflowDefinition = { trigger: { type: "contact.created" }, steps: Array.from({ length: WORKFLOW_LIMITS.maxSteps }, (_, i) => step(`s${i}`, "wait", wait(), i + 1 < WORKFLOW_LIMITS.maxSteps ? `s${i + 1}` : null)) };
    expect(refused(applyOperations(full, [{ op: "add_step", kind: "wait", at: { after: null } }]))).toMatchObject({ code: "limit" });
    expect(refused(applyOperations(base(), [{ op: "add_step", kind: "wait", requireApproval: true, at: { after: "c", via: "next" } }]))).toMatchObject({ code: "invalid_operation" });
    const asked = ok(applyOperations(base(), [{ op: "add_step", kind: "create_task", config: task("X"), requireApproval: true, at: { after: "c", via: "next" } }]));
    expect(asked.definition.steps.find((s) => s.requireApproval)?.kind).toBe("create_task");
  });
});

describe("update_step", () => {
  it("merges settings, renames, and says what changed", () => {
    const r = ok(applyOperations(base(), [{ op: "update_step", key: "a", name: "Chase the lead", config: { title: "Call them", priority: "high" } }]));
    expect(by(r.definition, "a")).toMatchObject({ name: "Chase the lead", config: { title: "Call them", priority: "high", assignee: "none" } });
    expect(r.changes).toEqual([{ type: "step_modified", key: "a", fields: ["name", "settings"] }]);
    expect(r.summary).toEqual(["Changed “Chase the lead”."]);
  });

  it("can replace the settings, clear a name, and toggle 'ask before this step runs'", () => {
    const named = ok(applyOperations(base(), [{ op: "update_step", key: "a", name: "Named", requireApproval: true }])).definition;
    expect(by(named, "a")).toMatchObject({ name: "Named", requireApproval: true });
    const cleared = ok(applyOperations(named, [{ op: "update_step", key: "a", name: null, requireApproval: false, config: { title: "Only this", priority: "low", assignee: "none" }, replaceConfig: true }]));
    expect(by(cleared.definition, "a")).not.toHaveProperty("name");
    expect(by(cleared.definition, "a")).not.toHaveProperty("requireApproval");
    expect(by(cleared.definition, "a").config).toEqual({ title: "Only this", priority: "low", assignee: "none" });
    expect(cleared.changes).toEqual([{ type: "step_modified", key: "a", fields: ["name", "settings", "approval"] }]);
  });

  it("refuses an unknown step and approval on a step that doesn't act", () => {
    expect(refused(applyOperations(base(), [{ op: "update_step", key: "zzz", name: "x" }]))).toMatchObject({ code: "unknown_step" });
    expect(refused(applyOperations(base(), [{ op: "update_step", key: "b", requireApproval: true }]))).toMatchObject({ code: "invalid_operation" });
  });

  it("reports nothing when nothing actually changes", () => {
    const r = ok(applyOperations(base(), [{ op: "update_step", key: "a", config: { title: "Follow up" } }]));
    expect(r.changes).toEqual([]);
    expect(r.contentChanged).toBe(false);
  });
});

describe("remove_step, move_step, connect and set_entry", () => {
  it("removes a step and reconnects what led to it", () => {
    const r = ok(applyOperations(base(), [{ op: "remove_step", key: "b" }]));
    expect(walk(r.definition)).toEqual(["a", "c"]);
    expect(r.changes).toEqual(expect.arrayContaining([{ type: "step_removed", key: "b" }, { type: "link_changed", from: "a", via: "next", to: "c", previous: "b" }]));
  });

  it("removes the first step and promotes the next one", () => {
    const r = ok(applyOperations(base(), [{ op: "remove_step", key: "a" }]));
    expect(r.definition.steps[0].key).toBe("b");
    expect(r.changes).toContainEqual({ type: "step_removed", key: "a" });
  });

  it("removes an if / else together with the steps on its two paths, and carries on where they joined", () => {
    const def: WorkflowDefinition = {
      trigger: { type: "contact.created" },
      steps: [
        step("check", "branch", isNew, null, { branches: { yes: "y", no: "n" } }),
        step("y", "internal_note", note("yes"), "after"), step("n", "internal_note", note("no"), "after"), step("after", "create_task", task()),
      ],
    };
    const r = ok(applyOperations(def, [{ op: "remove_step", key: "check" }]));
    expect(keys(r.definition)).toEqual(["after"]);
    expect(r.changes.filter((c) => c.type === "step_removed").map((c) => (c as { key: string }).key).sort()).toEqual(["check", "n", "y"]);
  });

  it("refuses to remove a step that isn't there", () => {
    expect(refused(applyOperations(base(), [{ op: "remove_step", key: "nope" }]))).toMatchObject({ code: "unknown_step" });
  });

  it("swaps plain neighbours, and refuses what can't move", () => {
    const r = ok(applyOperations(base(), [{ op: "move_step", key: "b", direction: "down" }]));
    expect(walk(r.definition)).toEqual(["a", "c", "b"]);
    expect(refused(applyOperations(base(), [{ op: "move_step", key: "a", direction: "up" }]))).toMatchObject({ code: "bad_position" });
    expect(refused(applyOperations(base(), [{ op: "move_step", key: "c", direction: "down" }]))).toMatchObject({ code: "bad_position" });
  });

  it("connects a step to another, joins paths, and ends a path with null", () => {
    const joined = ok(applyOperations(base(), [{ op: "connect", from: "a", via: "next", to: "c" }]));
    expect(walk(joined.definition)).toEqual(["a", "c"]);
    expect(joined.changes).toContainEqual({ type: "link_changed", from: "a", via: "next", to: "c", previous: "b" });
    expect(joined.issues.some((i) => i.code === "unreachable" && i.stepKey === "b")).toBe(true);
    const ended = ok(applyOperations(base(), [{ op: "connect", from: "b", via: "next", to: null }]));
    expect(walk(ended.definition)).toEqual(["a", "b"]);
  });

  it("uses Yes and No only for an if / else, and next for everything else", () => {
    const withBranch = ok(applyOperations(base(), [{ op: "add_step", kind: "branch", key: "check", config: isNew, at: { after: "a", via: "next" } }])).definition;
    const wired = ok(applyOperations(withBranch, [{ op: "connect", from: "check", via: "no", to: "c" }]));
    expect(by(wired.definition, "check").branches).toEqual({ yes: "b", no: "c" });
    expect(refused(applyOperations(withBranch, [{ op: "connect", from: "check", via: "next", to: "c" }]))).toMatchObject({ code: "bad_link" });
    expect(refused(applyOperations(base(), [{ op: "connect", from: "a", via: "yes", to: "c" }]))).toMatchObject({ code: "bad_link" });
    expect(refused(applyOperations(base(), [{ op: "connect", from: "a", via: "next", to: "ghost" }]))).toMatchObject({ code: "unknown_step" });
  });

  it("makes another step the first one", () => {
    const r = ok(applyOperations(base(), [{ op: "set_entry", key: "b" }]));
    expect(r.definition.steps[0].key).toBe("b");
    expect(r.changes).toContainEqual({ type: "entry_changed", key: "b", previous: "a" });
    expect(refused(applyOperations(base(), [{ op: "set_entry", key: "ghost" }]))).toMatchObject({ code: "unknown_step" });
  });

  it("lets the editor draw a loop with no wait in it, shows it as a problem, and keeps the AI from doing so", () => {
    const loop: WorkflowOperation[] = [{ op: "connect", from: "c", via: "next", to: "a" }, { op: "connect", from: "b", via: "next", to: "c" }];
    // a → b(wait) → c → a: the cycle goes through a wait, so it is allowed. Taking the wait out of it makes it an instant loop.
    expect(ok(applyOperations(base(), loop.slice(0, 1))).issues.filter((i) => i.level === "error")).toEqual([]);
    const instant = ok(applyOperations(base(), [{ op: "connect", from: "a", via: "next", to: "c" }, { op: "connect", from: "c", via: "next", to: "a" }]));
    expect(instant.issues.some((i) => i.code === "cycle")).toBe(true);
    expect(refused(applyOperations(base(), [{ op: "connect", from: "a", via: "next", to: "c" }, { op: "connect", from: "c", via: "next", to: "a" }], { mode: "strict" }))).toMatchObject({ code: "validation_failed", index: -1 });
  });
});

describe("position_step", () => {
  it("moves a node on the canvas without changing what runs, in what order, or the content hash", () => {
    const before = base();
    const r = ok(applyOperations(before, [{ op: "position_step", key: "b", x: 123.6, y: -40.2 }, { op: "position_step", key: "c", x: 0, y: 500 }]));
    expect(by(r.definition, "b").ui).toEqual({ x: 124, y: -40 });
    expect(r.changes).toEqual([{ type: "step_moved", key: "b" }, { type: "step_moved", key: "c" }]);
    expect(r.contentChanged).toBe(false);
    expect(definitionHash(r.definition)).toBe(definitionHash(before));
    expect(walk(r.definition)).toEqual(walk(before));
    expect(layoutCanvas(r.definition.steps).items.filter((i) => i.type === "step").map((i) => (i as { key: string }).key)).toEqual(["a", "b", "c"]);
  });

  it("keeps a node's other editor state when it moves", () => {
    const d = base();
    d.steps[0].ui = { x: 1, y: 2, collapsed: true };
    expect(by(ok(applyOperations(d, [{ op: "position_step", key: "a", x: 9, y: 9 }])).definition, "a").ui).toEqual({ x: 9, y: 9, collapsed: true });
  });

  it("does change the content hash when the same batch also changes a connection", () => {
    const r = ok(applyOperations(base(), [{ op: "position_step", key: "b", x: 5, y: 5 }, { op: "connect", from: "a", via: "next", to: "c" }]));
    expect(r.contentChanged).toBe(true);
  });
});

describe("set_trigger and patch_trigger", () => {
  it("replaces the trigger, and refuses one that isn't valid", () => {
    const r = ok(applyOperations(base(), [{ op: "set_trigger", trigger: { type: "appointment.booked" } }]));
    expect(r.definition.trigger).toEqual({ type: "appointment.booked" });
    expect(r.changes).toEqual([{ type: "trigger_changed" }]);
    expect(refused(applyOperations(base(), [{ op: "set_trigger", trigger: { type: "payment.received" } }]))).toMatchObject({ code: "invalid_trigger" });
    expect(refused(applyOperations(base(), [{ op: "set_trigger", trigger: { type: "contact.created", surprise: true } }]))).toMatchObject({ code: "invalid_trigger" });
  });

  it("merges filters, and a null removes a key", () => {
    const tag = crypto.randomUUID();
    const withFilter = ok(applyOperations(base(), [{ op: "set_trigger", trigger: { type: "contact.tag_added", filters: { tagIds: [tag] }, reentry: "once" } }])).definition;
    const patched = ok(applyOperations(withFilter, [{ op: "patch_trigger", patch: { filters: { tagIds: null, ignoreOptOutKeywords: true }, reentry: null } }]));
    expect(patched.definition.trigger.reentry).toBeUndefined();
    // tagIds is removed; ignoreOptOutKeywords doesn't apply to this trigger, which the validator reports rather than hides.
    expect(patched.definition.trigger.filters?.tagIds).toBeUndefined();
    expect(patched.issues.some((i) => i.code === "invalid_trigger")).toBe(true);
  });

  it("keeps the AI from choosing a webhook address, while the editor's own flow is untouched", () => {
    const hook = { type: "inbound_webhook", inbound: { nonce: "a".repeat(24), match: "none", createContact: false } };
    expect(ok(applyOperations(base(), [{ op: "set_trigger", trigger: hook }])).definition.trigger.inbound?.nonce).toBe("a".repeat(24));
    expect(refused(applyOperations(base(), [{ op: "set_trigger", trigger: hook }], { mode: "strict" }))).toMatchObject({ code: "invalid_trigger" });
    // Keeping the address it already has is fine.
    const withHook = ok(applyOperations(base(), [{ op: "set_trigger", trigger: hook }])).definition;
    expect(ok(applyOperations(withHook, [{ op: "patch_trigger", patch: { reentry: "once" } }], { mode: "strict" })).definition.trigger.reentry).toBe("once");
  });
});

describe("a batch is all or nothing", () => {
  it("applies nothing when a later operation is refused, and never touches the input", () => {
    const input = base();
    const snapshot = JSON.stringify(input);
    const r = applyOperations(input, [
      { op: "update_step", key: "a", name: "Renamed" },
      { op: "add_step", kind: "wait", at: { after: "ghost", via: "next" } },
      { op: "remove_step", key: "c" },
    ]);
    expect(refused(r)).toMatchObject({ index: 1, code: "unknown_step" });
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("does not modify the input on success either", () => {
    const input = base();
    const snapshot = JSON.stringify(input);
    const r = ok(applyOperations(input, [{ op: "remove_step", key: "b" }, { op: "update_step", key: "a", name: "X" }]));
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(r.definition).not.toBe(input);
  });

  it("later operations see the effect of earlier ones", () => {
    const r = ok(applyOperations(base(), [
      { op: "add_step", kind: "create_task", key: "new", config: task("N"), at: { after: "c", via: "next" } },
      { op: "update_step", key: "new", name: "Brand new" },
      { op: "connect", from: "new", via: "next", to: null },
    ]));
    expect(walk(r.definition)).toEqual(["a", "b", "c", "new"]);
    expect(r.summary.length).toBe(3);
  });

  it("describes an add that is removed again in the same batch as no change", () => {
    const r = ok(applyOperations(base(), [{ op: "add_step", kind: "wait", key: "temp", at: { after: "c", via: "next" } }, { op: "remove_step", key: "temp" }]));
    expect(r.changes).toEqual([]);
    expect(r.contentChanged).toBe(false);
  });
});

describe("strict mode (the AI Builder)", () => {
  const tag = crypto.randomUUID();
  const ctx = validationContextFrom({ tags: [{ id: tag }], users: [], pipelines: [], fields: [], templates: [], n8nMappings: [], webhookSubscriptions: [], assignmentRules: [], agents: [], calendars: [], appointmentTypes: [] });

  it("refuses a step the batch leaves incomplete, where the editor would accept it", () => {
    const op: WorkflowOperation = { op: "add_step", kind: "add_tag", key: "tag", at: { after: "c", via: "next" } };
    const draft = ok(applyOperations(base(), [op]));
    expect(draft.issues.some((i) => i.stepKey === "tag" && i.level === "error")).toBe(true);
    const strict = applyOperations(base(), [op], { mode: "strict" });
    expect(refused(strict)).toMatchObject({ code: "validation_failed", index: -1 });
    expect(!strict.ok && strict.issues.every((i) => i.stepKey === "tag")).toBe(true);
  });

  it("accepts the same step once it is complete", () => {
    expect(ok(applyOperations(base(), [{ op: "add_step", kind: "add_tag", config: { tagIds: [tag] }, at: { after: "c", via: "next" } }], { mode: "strict", context: ctx })).issues.filter((i) => i.level === "error")).toEqual([]);
  });

  it("refuses a reference to something that doesn't exist in the workspace", () => {
    const r = applyOperations(base(), [{ op: "add_step", kind: "add_tag", config: { tagIds: [crypto.randomUUID()] }, at: { after: "c", via: "next" } }], { mode: "strict", context: ctx });
    expect(refused(r)).toMatchObject({ code: "validation_failed", message: expect.stringMatching(/tag that no longer exists/) });
  });

  it("does not blame the batch for problems the workflow already had", () => {
    const broken: WorkflowDefinition = { trigger: { type: "contact.created" }, steps: [step("a", "add_tag", { tagIds: [] }, "b"), step("b", "wait", wait())] };
    const r = ok(applyOperations(broken, [{ op: "update_step", key: "b", config: { amount: 2 } }], { mode: "strict" }));
    expect(r.issues.some((i) => i.stepKey === "a" && i.level === "error")).toBe(true);
    // Making things worse is still refused.
    expect(refused(applyOperations(broken, [{ op: "add_step", kind: "add_tag", at: { after: "b", via: "next" } }], { mode: "strict" }))).toMatchObject({ code: "validation_failed" });
  });

  it("lets a sequence of steps build a workflow that validates", () => {
    const empty: WorkflowDefinition = { trigger: { type: "contact.created" }, steps: [] };
    const r = ok(applyOperations(empty, [
      { op: "add_step", kind: "create_task", key: "t", config: task("Welcome call"), at: { after: null } },
      { op: "add_step", kind: "wait", key: "w", config: wait(), at: { after: "t", via: "next" } },
      { op: "add_step", kind: "internal_note", key: "n", config: note("Welcomed"), at: { after: "w", via: "next" } },
    ], { mode: "strict", context: ctx }));
    expect(validateDefinition(r.definition, ctx).filter((i) => i.level === "error")).toEqual([]);
    expect(walk(r.definition)).toEqual(["t", "w", "n"]);
  });
});

describe("diffDefinitions", () => {
  it("describes trigger, step, link, entry and layout changes", () => {
    const before = base();
    const after = JSON.parse(JSON.stringify(before)) as WorkflowDefinition;
    after.trigger = { type: "contact.updated" };
    after.steps = after.steps.filter((s) => s.key !== "b");
    after.steps[0].next = "c";
    after.steps[1].config = note("Changed") as never;
    after.steps[0].ui = { x: 4, y: 4 };
    expect(diffDefinitions(before, after)).toEqual([
      { type: "trigger_changed" },
      { type: "step_removed", key: "b" },
      { type: "step_modified", key: "c", fields: ["settings"] },
      { type: "link_changed", from: "a", via: "next", to: "c", previous: "b" },
      { type: "step_moved", key: "a" },
    ]);
    expect(diffDefinitions(before, before)).toEqual([]);
  });
});

describe("undo and redo", () => {
  const entry = (before: WorkflowDefinition, after: WorkflowDefinition, over: Partial<HistoryEntry> = {}): HistoryEntry => ({ label: "Change", source: "manual", before, after, at: "2026-10-21T00:00:00Z", ...over });
  const step1 = () => ok(applyOperations(base(), [{ op: "update_step", key: "a", name: "One" }])).definition;
  const step2 = (d: WorkflowDefinition) => ok(applyOperations(d, [{ op: "update_step", key: "a", name: "Two" }])).definition;

  it("takes back one change at a time and puts it back", () => {
    const d0 = base();
    const d1 = step1();
    const d2 = step2(d1);
    let h = record(record(emptyHistory(), entry(d0, d1, { label: "One" })), entry(d1, d2, { label: "Two" }));
    expect(canUndo(h, d2)).toBe(true);
    const u1 = undo(h, d2);
    expect(u1.ok && sameDraft(u1.definition, d1)).toBe(true);
    h = u1.ok ? u1.history : h;
    const u2 = undo(h, d1);
    expect(u2.ok && sameDraft(u2.definition, d0)).toBe(true);
    h = u2.ok ? u2.history : h;
    expect(undo(h, d0)).toEqual({ ok: false, reason: "nothing" });
    expect(canRedo(h, d0)).toBe(true);
    const r1 = redo(h, d0);
    expect(r1.ok && sameDraft(r1.definition, d1) && r1.entry.label === "One").toBe(true);
  });

  it("makes a new change end the redo trail", () => {
    const d0 = base();
    const d1 = step1();
    let h = record(emptyHistory(), entry(d0, d1));
    const u = undo(h, d1);
    h = u.ok ? u.history : h;
    expect(h.future.length).toBe(1);
    h = record(h, entry(d0, step2(d0)));
    expect(h.future).toEqual([]);
  });

  it("refuses to undo over work it didn't make", () => {
    const d0 = base();
    const d1 = step1();
    const h = record(emptyHistory(), entry(d0, d1));
    const someoneElse = step2(d1);
    expect(undo(h, someoneElse)).toEqual({ ok: false, reason: "diverged" });
    expect(canUndo(h, someoneElse)).toBe(false);
    const undone = undo(h, d1);
    expect(undone.ok && redo(undone.history, someoneElse)).toEqual({ ok: false, reason: "diverged" });
  });

  it("undoes a drag exactly, and merges the steps of one drag into one entry", () => {
    const d0 = base();
    let current = d0;
    let h = emptyHistory();
    for (const x of [10, 20, 30, 40]) {
      const next = ok(applyOperations(current, [{ op: "position_step", key: "b", x, y: 5 }])).definition;
      h = record(h, entry(current, next, { coalesceKey: "drag:b", label: "Moved a step" }));
      current = next;
    }
    expect(h.past.length).toBe(1);
    const u = undo(h, current);
    expect(u.ok && sameDraft(u.definition, d0)).toBe(true);
    expect(u.ok && by(u.definition, "b").ui).toBeUndefined();
  });

  it("drops a merged entry that ends where it started", () => {
    const d0 = base();
    const away = ok(applyOperations(d0, [{ op: "position_step", key: "b", x: 10, y: 10 }])).definition;
    let h = record(emptyHistory(), entry(d0, away, { coalesceKey: "drag:b" }));
    h = record(h, entry(away, d0, { coalesceKey: "drag:b" }));
    expect(h.past).toEqual([]);
  });

  it("does not record a change that changes nothing, and keeps a bounded history", () => {
    const d0 = base();
    expect(record(emptyHistory(), entry(d0, base()))).toEqual(emptyHistory());
    let h = emptyHistory();
    let current = d0;
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) {
      const next = ok(applyOperations(current, [{ op: "update_step", key: "a", name: `Name ${i}` }])).definition;
      h = record(h, entry(current, next));
      current = next;
    }
    expect(h.past.length).toBe(HISTORY_LIMIT);
  });

  it("treats the AI's changes like anyone else's", () => {
    const d0 = base();
    const proposed = ok(applyOperations(d0, [{ op: "add_step", kind: "wait", key: "extra", config: wait(), at: { after: "c", via: "next" } }], { mode: "strict" }));
    const h = record(emptyHistory(), entry(d0, proposed.definition, { source: "ai", label: proposed.summary.join(" ") }));
    const u = undo(h, proposed.definition);
    expect(u.ok && u.entry.source).toBe("ai");
    expect(u.ok && keys(u.definition)).toEqual(["a", "b", "c"]);
  });
});
