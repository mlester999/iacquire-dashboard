// The one way a workflow definition is changed: a small, closed set of validated operations, applied as a batch to a definition (pure, no I/O).
//
// Everything that edits a workflow goes through here so that there is exactly one canonical model and one set of rules:
//  - the visual editor turns each gesture (add a node, connect two nodes, drag a node, change a setting) into an operation;
//  - the AI Automation Builder can only ever *propose* operations (as JSON validated by `operationsSchema`), never raw definitions or code;
//  - the result lists exactly what changed (`changes`), which is what the canvas animates, the chat explains and the audit log records;
//  - dragging a node only changes its editor position, which is not part of the definition's content hash, so it can never change what runs.
//
// A batch is all-or-nothing: if any operation is refused, nothing is applied and the reason names the operation. In "draft" mode (the
// editor) a step may still be incomplete, as the editor's own "add a step, then choose its settings" flow needs. In "strict" mode (the AI)
// the batch must not introduce any validation error, so an incomplete or invalid step is refused and the builder has to ask for the
// missing choice instead of guessing. Neither mode can reach the owner's approval of a version, which stays bound to the published
// content on the server.
import { z } from "zod";
import { canInsert, canMove, freshKey, insertStep, moveStep, removeStep, type InsertPoint } from "@/lib/crm/workflow/graph";
import {
  STEP_KEY_RE, STEP_KINDS, STEP_KIND_LIST, WORKFLOW_LIMITS, canonicalJson, definitionHash, triggerConfigSchema, validateDefinition,
  type StepKind, type TriggerConfig, type ValidationContext, type ValidationIssue, type WorkflowDefinition, type WorkflowStep,
} from "@/lib/crm/workflow/spec";

// ---------------------------------------------------------------------------
// The operations
// ---------------------------------------------------------------------------

const key = z.string().regex(STEP_KEY_RE, "Step keys are lower-case letters, numbers, - and _ (up to 40).");
const via = z.enum(["next", "yes", "no"]);
const coordinate = z.number().finite().min(-100_000).max(100_000);
/** Where a new step goes: first, after a step (on its Yes or No path for an if / else), or `detached` (placed on the canvas, joined up later). */
const insertPoint = z.union([z.strictObject({ after: z.null() }), z.strictObject({ after: key, via }), z.strictObject({ detached: z.literal(true) })]);

export const operationSchema = z.discriminatedUnion("op", [
  /** Puts a new step at an insert point; whatever followed the point follows the new step. A detached step joins no path until it is connected. */
  z.strictObject({
    op: z.literal("add_step"),
    kind: z.enum(STEP_KIND_LIST),
    key: key.optional(),
    name: z.string().trim().max(80).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    requireApproval: z.boolean().optional(),
    at: insertPoint,
  }),
  /** Changes a step's name, settings (merged into the current ones unless `replaceConfig`) or "ask before this step runs". */
  z.strictObject({
    op: z.literal("update_step"),
    key,
    name: z.string().trim().max(80).nullable().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    replaceConfig: z.boolean().optional(),
    requireApproval: z.boolean().optional(),
  }),
  /** Removes a step; what led to it continues with what followed it. Removing an if / else also removes the steps on its two paths. */
  z.strictObject({ op: z.literal("remove_step"), key }),
  /** Swaps a plain step with its neighbour on the same path. */
  z.strictObject({ op: z.literal("move_step"), key, direction: z.enum(["up", "down"]) }),
  /** Sets where a step continues (`to` null: the path ends). Plain steps use "next"; an if / else uses "yes" and "no". */
  z.strictObject({ op: z.literal("connect"), from: key, via, to: key.nullable() }),
  /** Makes a step the one that runs first. */
  z.strictObject({ op: z.literal("set_entry"), key }),
  /** Moves a step on the canvas. Editor layout only: it never changes what runs, in what order, or the version's content hash. */
  z.strictObject({ op: z.literal("position_step"), key, x: coordinate, y: coordinate }),
  /** Replaces what starts the workflow. */
  z.strictObject({ op: z.literal("set_trigger"), trigger: z.unknown() }),
  /** Changes parts of the trigger: top-level keys are replaced, `filters` are merged, and a null removes a key. */
  z.strictObject({ op: z.literal("patch_trigger"), patch: z.record(z.string(), z.unknown()) }),
]);
export type WorkflowOperation = z.infer<typeof operationSchema>;

export const MAX_OPERATIONS_PER_BATCH = 50;
export const operationsSchema = z.array(operationSchema).min(1, "Nothing to change.").max(MAX_OPERATIONS_PER_BATCH, `At most ${MAX_OPERATIONS_PER_BATCH} changes at a time.`);

/** Validates untrusted operations (an AI's output, a request body). Never throws. */
export function parseOperations(input: unknown): { ok: true; operations: WorkflowOperation[] } | { ok: false; message: string; index: number } {
  const r = operationsSchema.safeParse(input);
  if (r.success) return { ok: true, operations: r.data };
  const first = r.error.issues[0];
  const index = typeof first.path[0] === "number" ? first.path[0] : 0;
  const where = first.path.length ? ` (change ${index + 1}${first.path.length > 1 ? `, ${first.path.slice(1).join(".")}` : ""})` : "";
  // The message is cut, never the place: a long list of allowed values must not push "(change 2)" out of the reply.
  const body = first.message.replace(/^Invalid input: /, "");
  return { ok: false, index, message: `${body.slice(0, Math.max(40, 300 - where.length))}${where}` };
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type OperationErrorCode = "invalid_operation" | "unknown_step" | "duplicate_key" | "bad_position" | "bad_link" | "limit" | "invalid_trigger" | "validation_failed";

export interface OperationError {
  /** Which operation of the batch (0-based), or -1 for a problem found after applying them all. */
  index: number;
  code: OperationErrorCode;
  message: string;
  /** Where exactly, and in the schema's words, for the AI builder to correct itself (people see only `message`). */
  detail?: string;
}

export type WorkflowChange =
  | { type: "trigger_changed" }
  | { type: "step_added"; key: string }
  | { type: "step_removed"; key: string }
  | { type: "step_modified"; key: string; fields: Array<"name" | "settings" | "approval"> }
  | { type: "link_changed"; from: string; via: "next" | "yes" | "no"; to: string | null; previous: string | null }
  | { type: "entry_changed"; key: string; previous: string | null }
  | { type: "step_moved"; key: string };

export interface ApplyOptions {
  /** "draft": steps may be incomplete (the editor). "strict": the batch may introduce no validation error (the AI Builder). */
  mode?: "draft" | "strict";
  /** The workspace's tags, templates, people… so strict mode can refuse a reference that doesn't exist. Without it only the structure is checked. */
  context?: ValidationContext | null;
}

export type ApplyResult =
  | {
      ok: true;
      definition: WorkflowDefinition;
      changes: WorkflowChange[];
      /** One plain sentence per change, for the chat and the activity log. */
      summary: string[];
      /** Every problem the definition has after the change (warnings included); errors still stop publishing. */
      issues: ValidationIssue[];
      /**
       * Whether the definition's content hash changed. False when only editor layout moved: what runs is exactly what ran before, so there is
       * nothing new to publish or to ask an owner to approve. True for anything else, a rename included (approvals are bound to the content).
       */
      contentChanged: boolean;
    }
  | { ok: false; error: OperationError; issues: ValidationIssue[] };

const fail = (index: number, code: OperationErrorCode, message: string, detail?: string): { ok: false; error: OperationError; issues: ValidationIssue[] } => ({ ok: false, error: { index, code, message, ...(detail ? { detail } : {}) }, issues: [] });
class Refused extends Error {
  constructor(readonly code: OperationErrorCode, message: string, readonly detail?: string) {
    super(message);
  }
}
const refuse = (code: OperationErrorCode, message: string, detail?: string): never => {
  throw new Refused(code, message, detail);
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const labelOf = (s: Pick<WorkflowStep, "kind" | "name">) => (s.name?.trim() ? `“${s.name.trim()}”` : `“${STEP_KINDS[s.kind]?.label ?? s.kind}”`);

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

function stepNamed(steps: readonly WorkflowStep[], k: string): WorkflowStep {
  return steps.find((s) => s.key === k) ?? refuse("unknown_step", `There is no step “${k}” in this workflow.`);
}

/** Whether a step may continue through this kind of link: plain steps through "next", an if / else through "yes" and "no", an End not at all. */
function assertLinkKind(step: WorkflowStep, v: "next" | "yes" | "no") {
  if (step.kind === "end") refuse("bad_link", `${labelOf(step)} ends the workflow, so nothing can follow it.`);
  if (step.kind === "branch" && v === "next") refuse("bad_link", `${labelOf(step)} continues down its Yes and No paths, not to a single next step.`);
  if (step.kind !== "branch" && v !== "next") refuse("bad_link", `Only an if / else step has Yes and No paths; ${labelOf(step)} continues to a single next step.`);
}

function checkInsertPoint(steps: readonly WorkflowStep[], at: InsertPoint, kind: StepKind) {
  if (at.after !== null) {
    assertLinkKind(stepNamed(steps, at.after), at.via);
  }
  if (!canInsert(steps, at, kind)) {
    refuse("bad_position", kind === "end" ? "An End step can only go where nothing follows." : "A step can't be put there.");
  }
}

function mergeTrigger(current: TriggerConfig, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else if (k === "filters" && isObject(v)) {
      const filters: Record<string, unknown> = { ...(current.filters ?? {}) };
      for (const [fk, fv] of Object.entries(v)) {
        if (fv === null) delete filters[fk];
        else filters[fk] = fv;
      }
      out[k] = Object.keys(filters).length ? filters : undefined;
    } else out[k] = v;
  }
  return out;
}

/**
 * A setting that picks one of several shapes (a wait's "mode") carries different keys in each. A config that names another mode than the one it is
 * merged into starts from nothing: merging would keep the other mode's keys (a wait until 9am would keep "amount" and "unit"), which the schema rejects.
 */
const switchesMode = (current: Record<string, unknown>, given: Record<string, unknown>) => typeof given.mode === "string" && typeof current.mode === "string" && given.mode !== current.mode;
const startingConfig = (defaults: Record<string, unknown>, given: Record<string, unknown>): Record<string, unknown> => (switchesMode(defaults, given) ? { ...given } : { ...defaults, ...given });

function applyOne(def: WorkflowDefinition, op: WorkflowOperation, mode: "draft" | "strict"): void {
  switch (op.op) {
    case "add_step": {
      if (def.steps.length >= WORKFLOW_LIMITS.maxSteps) refuse("limit", `A workflow can have at most ${WORKFLOW_LIMITS.maxSteps} steps. Split it into two workflows.`);
      const k = op.key ?? freshKey(def.steps, op.kind);
      if (def.steps.some((s) => s.key === k)) refuse("duplicate_key", `A step with the key “${k}” already exists.`);
      const spec = STEP_KINDS[op.kind];
      if (op.requireApproval && !spec.approvable) refuse("invalid_operation", `${spec.label} steps can't ask for approval first; only steps that act can.`);
      const step = {
        key: k, kind: op.kind, ...(op.name ? { name: op.name } : {}), config: startingConfig(spec.defaults() as Record<string, unknown>, op.config ?? {}),
        ...(op.requireApproval ? { requireApproval: true } : {}), next: null,
      } as unknown as WorkflowStep;
      if ("detached" in op.at) {
        // Nothing leads to it yet (the validator says so until it is connected); it runs first only when it is the workflow's only step.
        if (op.kind === "branch") step.branches = { yes: null, no: null };
        def.steps = [...def.steps, step];
        return;
      }
      checkInsertPoint(def.steps, op.at, op.kind);
      def.steps = insertStep(def.steps, op.at, step);
      return;
    }
    case "update_step": {
      const step = stepNamed(def.steps, op.key);
      if (op.requireApproval && !STEP_KINDS[step.kind].approvable) refuse("invalid_operation", `${labelOf(step)} can't ask for approval first; only steps that act can.`);
      if (op.name !== undefined) {
        if (op.name === null || op.name === "") delete step.name;
        else step.name = op.name;
      }
      if (op.config) step.config = (op.replaceConfig || switchesMode(step.config as Record<string, unknown>, op.config) ? { ...op.config } : { ...(step.config as Record<string, unknown>), ...op.config }) as never;
      if (op.requireApproval !== undefined) {
        if (op.requireApproval) step.requireApproval = true;
        else delete step.requireApproval;
      }
      return;
    }
    case "remove_step": {
      stepNamed(def.steps, op.key);
      def.steps = removeStep(def.steps, op.key);
      return;
    }
    case "move_step": {
      const step = stepNamed(def.steps, op.key);
      if (!canMove(def.steps, op.key, op.direction)) refuse("bad_position", `${labelOf(step)} can't move ${op.direction}: only plain steps on a single path swap places.`);
      def.steps = moveStep(def.steps, op.key, op.direction);
      return;
    }
    case "connect": {
      const from = stepNamed(def.steps, op.from);
      assertLinkKind(from, op.via);
      if (op.to !== null) stepNamed(def.steps, op.to);
      if (op.via === "next") from.next = op.to;
      else from.branches = { ...(from.branches ?? {}), [op.via]: op.to };
      return;
    }
    case "set_entry": {
      const step = stepNamed(def.steps, op.key);
      def.steps = [step, ...def.steps.filter((s) => s.key !== op.key)];
      return;
    }
    case "position_step": {
      const step = stepNamed(def.steps, op.key);
      step.ui = { ...(step.ui ?? {}), x: Math.round(op.x), y: Math.round(op.y) };
      return;
    }
    case "set_trigger":
    case "patch_trigger": {
      const raw = op.op === "set_trigger" ? op.trigger : mergeTrigger(def.trigger, op.patch);
      const parsed = triggerConfigSchema.safeParse(raw);
      if (!parsed.success) {
        // People see which setting it was; the AI builder also gets the schema's own words (the allowed values), so a correction can be right.
        const issues = parsed.error.issues;
        refuse(
          "invalid_trigger",
          `That isn't a valid trigger${issues[0]?.path.length ? ` (${issues[0].path.join(".")})` : ""}.`,
          issues.slice(0, 4).map((i) => `${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}`).join("; ").slice(0, 400),
        );
      }
      const next = parsed.data as TriggerConfig;
      // A webhook URL is minted by the server when the workflow is published, never chosen by whoever edits it: the AI can't pick or
      // change one, so it can't point a workflow at a URL it knows.
      if (mode === "strict" && next.inbound && next.inbound.nonce !== def.trigger.inbound?.nonce) refuse("invalid_trigger", "The webhook address is generated by the server. Set up the trigger without it and generate the address in the workflow's settings.");
      def.trigger = next;
      return;
    }
  }
}

function sentenceFor(op: WorkflowOperation, before: WorkflowDefinition, after: WorkflowDefinition): string {
  const byKey = (d: WorkflowDefinition, k: string) => d.steps.find((s) => s.key === k);
  switch (op.op) {
    case "add_step": {
      const added = after.steps.find((s) => !before.steps.some((b) => b.key === s.key));
      return `Added ${added ? labelOf(added) : `a ${STEP_KINDS[op.kind].label} step`}.`;
    }
    case "update_step": return `Changed ${labelOf(byKey(after, op.key) ?? { kind: "end" as StepKind, name: op.key })}.`;
    case "remove_step": return `Removed ${labelOf(byKey(before, op.key) ?? { kind: "end" as StepKind, name: op.key })}.`;
    case "move_step": return `Moved ${labelOf(byKey(after, op.key) ?? { kind: "end" as StepKind, name: op.key })} ${op.direction}.`;
    case "connect": return op.to ? `Connected ${labelOf(byKey(after, op.from)!)} to ${labelOf(byKey(after, op.to)!)}.` : `Ended the path after ${labelOf(byKey(after, op.from)!)}.`;
    case "set_entry": return `${labelOf(byKey(after, op.key)!)} now runs first.`;
    case "position_step": return `Moved ${labelOf(byKey(after, op.key)!)} on the canvas.`;
    case "set_trigger":
    case "patch_trigger": return "Changed what starts the workflow.";
  }
}

/**
 * Applies a batch of operations to a definition. The input is never modified. Returns the new definition, what changed, a sentence for each
 * operation, and the definition's problems; or the first operation that was refused (and then nothing is applied).
 */
export function applyOperations(input: WorkflowDefinition, operations: readonly WorkflowOperation[], options: ApplyOptions = {}): ApplyResult {
  const mode = options.mode ?? "draft";
  const parsed = parseOperations(operations);
  if (!parsed.ok) return fail(parsed.index, "invalid_operation", parsed.message);
  const before = clone(input);
  const def = clone(input);
  const summary: string[] = [];
  for (let i = 0; i < parsed.operations.length; i++) {
    const op = parsed.operations[i];
    const snapshot = clone(def);
    try {
      applyOne(def, op, mode);
    } catch (err) {
      if (err instanceof Refused) return fail(i, err.code, err.message, err.detail);
      throw err;
    }
    summary.push(sentenceFor(op, snapshot, def));
  }
  const issues = validateDefinition(def, options.context ?? null);
  if (mode === "strict") {
    // What the batch itself broke: problems that were already there are the workflow's, not this change's.
    const had = new Set(validateDefinition(before, options.context ?? null).filter((i) => i.level === "error").map(issueKey));
    // An inbound-webhook trigger has no address until the server generates one in the workflow's settings: the AI can't (and mustn't) write it, so the
    // missing address is expected and not counted against its batch (publishing is still blocked until the address exists).
    const introduced = issues.filter((i) => i.level === "error" && !had.has(issueKey(i)) && !(i.code === "invalid_trigger" && i.path === "trigger.inbound"));
    if (introduced.length) {
      const detail = introduced.slice(0, 4).map((i) => `${i.stepKey ? `step ${i.stepKey}` : "workflow"}${i.path ? ` ${i.path}` : ""}: ${i.detail ?? i.message}`).join("; ");
      return { ok: false, error: { index: -1, code: "validation_failed", message: introduced[0].message, detail }, issues: introduced };
    }
  }
  const changes = diffDefinitions(before, def);
  return { ok: true, definition: def, changes, summary, issues, contentChanged: definitionHash(before) !== definitionHash(def) };
}

const issueKey = (i: ValidationIssue) => `${i.code}|${i.stepKey ?? ""}|${i.path ?? ""}|${i.message}`;

// ---------------------------------------------------------------------------
// What changed
// ---------------------------------------------------------------------------

const sideLinks = (s: WorkflowStep): Array<["next" | "yes" | "no", string | null]> =>
  s.kind === "branch" ? [["yes", s.branches?.yes ?? null], ["no", s.branches?.no ?? null]] : s.kind === "end" ? [] : [["next", s.next ?? null]];

/** The difference between two definitions, in the terms the canvas animates and the chat explains. Order: trigger, removals, additions, edits, links, entry, moves. */
export function diffDefinitions(before: WorkflowDefinition, after: WorkflowDefinition): WorkflowChange[] {
  const out: WorkflowChange[] = [];
  if (canonicalJson(before.trigger) !== canonicalJson(after.trigger)) out.push({ type: "trigger_changed" });
  const b = new Map(before.steps.map((s) => [s.key, s]));
  const a = new Map(after.steps.map((s) => [s.key, s]));
  for (const k of b.keys()) if (!a.has(k)) out.push({ type: "step_removed", key: k });
  for (const k of a.keys()) if (!b.has(k)) out.push({ type: "step_added", key: k });
  for (const [k, s] of a) {
    const old = b.get(k);
    if (!old) continue;
    const fields: Array<"name" | "settings" | "approval"> = [];
    if ((old.name ?? null) !== (s.name ?? null)) fields.push("name");
    if (canonicalJson(old.config) !== canonicalJson(s.config)) fields.push("settings");
    if ((old.requireApproval === true) !== (s.requireApproval === true)) fields.push("approval");
    if (fields.length) out.push({ type: "step_modified", key: k, fields });
  }
  for (const [k, s] of a) {
    const old = b.get(k);
    const previous = old ? new Map(sideLinks(old)) : new Map<string, string | null>();
    for (const [v, to] of sideLinks(s)) {
      const was = previous.get(v) ?? null;
      // A new step's own links are part of it being added (only a link to or from an existing step is a change worth drawing).
      if (old ? was !== to : to !== null) out.push({ type: "link_changed", from: k, via: v, to, previous: was });
    }
  }
  const entryBefore = before.steps[0]?.key ?? null;
  const entryAfter = after.steps[0]?.key ?? null;
  if (entryAfter !== entryBefore && entryAfter && b.has(entryAfter)) out.push({ type: "entry_changed", key: entryAfter, previous: entryBefore });
  for (const [k, s] of a) {
    const old = b.get(k);
    if (old && ((old.ui?.x ?? null) !== (s.ui?.x ?? null) || (old.ui?.y ?? null) !== (s.ui?.y ?? null))) out.push({ type: "step_moved", key: k });
  }
  return out;
}
