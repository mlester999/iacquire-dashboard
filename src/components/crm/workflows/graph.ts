// The workflow editor's canvas, as pure functions over the step graph (src/lib/crm/workflow/spec.ts): the first step in the list runs
// first, a plain step continues to `next`, an if / else step continues down its Yes or No path (it has no `next`), and End stops. Two
// paths may lead into the same step, where they join again.
//
// `layoutCanvas` turns that graph into a top-to-bottom list for drawing (a branch's two paths side by side, a step where both paths meet
// drawn once below them); the edit functions insert, remove and move steps and always return a list whose first step is the entry.
// Nothing here renders, so the tests check the shapes directly.

/** The part of a step the canvas needs. `WorkflowStep` from the spec satisfies it. */
export interface GraphStep {
  key: string;
  kind: string;
  next?: string | null;
  branches?: { yes?: string | null; no?: string | null } | null;
}

export type BranchSide = "yes" | "no";

/** Where a new step goes: at the very start, after a plain step, or at the top of one side of an if / else. */
export type InsertPoint = { after: null } | { after: string; via: "next" } | { after: string; via: BranchSide };

export type CanvasItem =
  | { type: "insert"; at: InsertPoint; id: string }
  | { type: "step"; key: string }
  | { type: "branch"; key: string; yes: CanvasItem[]; no: CanvasItem[]; join: string | null }
  /** A path that stops here: an End step, or nothing after it. */
  | { type: "end"; explicit: boolean; id: string }
  /** This path carries on at the step drawn below both paths. */
  | { type: "join"; id: string }
  /** A pointer to a step drawn elsewhere (a loop back through a wait). */
  | { type: "jump"; to: string; id: string }
  /** A pointer to a step that doesn't exist. */
  | { type: "missing"; to: string; id: string };

export function insertPointId(at: InsertPoint): string {
  return at.after === null ? "start" : `${at.after}:${at.via}`;
}

function successors(s: GraphStep): string[] {
  if (s.kind === "end") return [];
  if (s.kind === "branch") return [s.branches?.yes, s.branches?.no].filter((k): k is string => Boolean(k));
  return s.next ? [s.next] : [];
}

/**
 * Where an if / else's two paths meet again: the first step on the Yes path's spine that the No path also reaches. Spines follow `next`
 * and skip over nested if / else steps through their own join. Null when the paths never meet.
 */
export function branchJoin<S extends GraphStep>(steps: readonly S[], branchKey: string): string | null {
  const byKey = new Map(steps.map((s) => [s.key, s]));
  const spine = (start: string | null | undefined, guard: Set<string>): string[] => {
    const out: string[] = [];
    let cur = start ?? null;
    while (cur && !out.includes(cur) && !guard.has(cur)) {
      const s = byKey.get(cur);
      if (!s) break;
      out.push(cur);
      if (s.kind === "end") break;
      if (s.kind === "branch") {
        guard.add(cur);
        cur = joinOf(s.key, guard);
        guard.delete(s.key);
      } else cur = s.next ?? null;
    }
    return out;
  };
  const joinOf = (key: string, guard: Set<string>): string | null => {
    const b = byKey.get(key);
    if (!b || b.kind !== "branch") return null;
    const yes = spine(b.branches?.yes, guard);
    const no = new Set(spine(b.branches?.no, guard));
    return yes.find((k) => no.has(k)) ?? null;
  };
  return joinOf(branchKey, new Set());
}

/**
 * Lays the graph out as a vertical list. Each path of an if / else runs until it reaches the step where both paths join, a step already
 * drawn (a loop), or its end. Steps nothing reaches are returned separately so the editor can show them and offer to remove them.
 */
export function layoutCanvas<S extends GraphStep>(steps: readonly S[]): { items: CanvasItem[]; unreachable: string[] } {
  const byKey = new Map(steps.map((s) => [s.key, s]));
  const placed = new Set<string>();
  let seq = 0;
  const uid = (p: string) => `${p}${++seq}`;

  const walk = (start: string | null | undefined, at: InsertPoint | null, stops: ReadonlySet<string>): CanvasItem[] => {
    const items: CanvasItem[] = at ? [{ type: "insert", at, id: insertPointId(at) }] : [];
    let cur = start ?? null;
    while (cur) {
      if (stops.has(cur)) {
        items.push({ type: "join", id: uid("join") });
        return items;
      }
      const step = byKey.get(cur);
      if (!step) {
        items.push({ type: "missing", to: cur, id: uid("missing") });
        return items;
      }
      if (placed.has(cur)) {
        items.push({ type: "jump", to: cur, id: uid("jump") });
        return items;
      }
      placed.add(cur);
      if (step.kind === "branch") {
        const join = branchJoin(steps, step.key);
        const inner = new Set(stops);
        if (join) inner.add(join);
        const yes = walk(step.branches?.yes, { after: step.key, via: "yes" }, inner);
        const no = walk(step.branches?.no, { after: step.key, via: "no" }, inner);
        items.push({ type: "branch", key: step.key, yes, no, join });
        if (!join) return items;
        // Both paths carry on at the join, drawn once below them. Nothing can be inserted between the paths and the join itself (each
        // path has its own "+" before it), so the walk continues without an insert point here.
        cur = join;
        continue;
      }
      items.push({ type: "step", key: step.key });
      if (step.kind === "end") {
        items.push({ type: "end", explicit: true, id: uid("end") });
        return items;
      }
      const after: InsertPoint = { after: step.key, via: "next" };
      items.push({ type: "insert", at: after, id: insertPointId(after) });
      cur = step.next ?? null;
    }
    items.push({ type: "end", explicit: false, id: uid("end") });
    return items;
  };

  const items = walk(steps[0]?.key, { after: null }, new Set());
  const unreachable = steps.filter((s) => !placed.has(s.key)).map((s) => s.key);
  return { items, unreachable };
}

/** Every step key in drawing order: an if / else, then its Yes path, its No path, and what follows. Used for step numbers. */
export function orderedKeys(items: readonly CanvasItem[]): string[] {
  const out: string[] = [];
  for (const it of items) {
    if (it.type === "step") out.push(it.key);
    else if (it.type === "branch") out.push(it.key, ...orderedKeys(it.yes), ...orderedKeys(it.no));
  }
  return out;
}

/** The steps an if / else owns: everything on its two paths before they join. Removing the if / else removes these too. */
export function branchMembers<S extends GraphStep>(steps: readonly S[], branchKey: string): string[] {
  const byKey = new Map(steps.map((s) => [s.key, s]));
  const join = branchJoin(steps, branchKey);
  const b = byKey.get(branchKey);
  if (!b || b.kind !== "branch") return [];
  const out = new Set<string>();
  const stack = [b.branches?.yes, b.branches?.no].filter((k): k is string => Boolean(k));
  while (stack.length) {
    const k = stack.pop()!;
    if (k === join || k === branchKey || out.has(k)) continue;
    const s = byKey.get(k);
    if (!s) continue;
    out.add(k);
    stack.push(...successors(s));
  }
  return [...out];
}

/** How many steps lead into each step (the entry counts as one). */
export function predecessorCounts<S extends GraphStep>(steps: readonly S[]): Map<string, number> {
  const counts = new Map<string, number>();
  if (steps[0]) counts.set(steps[0].key, 1);
  for (const s of steps) for (const n of successors(s)) counts.set(n, (counts.get(n) ?? 0) + 1);
  return counts;
}

// ---------------------------------------------------------------------------
// Edits. Each returns a new list (inputs are never mutated) whose first step is the entry.
// ---------------------------------------------------------------------------

const clone = <S extends GraphStep>(s: S): S => ({ ...s, ...(s.branches ? { branches: { ...s.branches } } : {}) });

/** Puts `entry` first, keeping the others in their order. */
function withEntry<S extends GraphStep>(steps: S[], entry: string | null): S[] {
  if (!entry) return steps;
  const i = steps.findIndex((s) => s.key === entry);
  if (i <= 0) return steps;
  return [steps[i], ...steps.slice(0, i), ...steps.slice(i + 1)];
}

/** Repoints everything that led to `from` (the entry, a `next`, a Yes / No path) to `to`, optionally only within some steps. */
function repoint<S extends GraphStep>(steps: S[], from: string, to: string | null, only?: ReadonlySet<string>): { steps: S[]; entryChanged: boolean } {
  const out = steps.map((s) => {
    if (only && !only.has(s.key)) return s;
    let changed = false;
    const c = clone(s);
    if (c.next === from) {
      c.next = to;
      changed = true;
    }
    if (c.branches) {
      for (const side of ["yes", "no"] as const) {
        if (c.branches[side] === from) {
          c.branches[side] = to;
          changed = true;
        }
      }
    }
    return changed ? c : s;
  });
  return { steps: out, entryChanged: !only && steps[0]?.key === from };
}

/** A key that isn't used yet, from the step's kind: send_message, send_message_2, … (lower case, as the spec requires). */
export function freshKey(steps: readonly GraphStep[], kind: string): string {
  const used = new Set(steps.map((s) => s.key));
  const base = kind.toLowerCase().replace(/[^a-z0-9_-]/g, "_").replace(/^[^a-z0-9]+/, "").slice(0, 30) || "step";
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}_${n}`)) return `${base}_${n}`;
}

/** What currently follows an insert point (the step a new step would be put in front of). */
export function targetOf<S extends GraphStep>(steps: readonly S[], at: InsertPoint): string | null {
  if (at.after === null) return steps[0]?.key ?? null;
  const s = steps.find((x) => x.key === at.after);
  if (!s) return null;
  return at.via === "next" ? s.next ?? null : s.branches?.[at.via] ?? null;
}

/** Whether a step of this kind can go at this point. An End stops its path, so it only goes where nothing follows. */
export function canInsert<S extends GraphStep>(steps: readonly S[], at: InsertPoint, kind: string): boolean {
  if (at.after !== null && !steps.some((s) => s.key === at.after)) return false;
  if (kind === "end") return !targetOf(steps, at);
  return true;
}

/**
 * Inserts a step. Whatever followed the insert point follows the new step; for a new if / else, it moves onto the Yes path (an if / else
 * has no single next step), and the No path starts empty.
 */
export function insertStep<S extends GraphStep>(steps: readonly S[], at: InsertPoint, step: S): S[] {
  if (!canInsert(steps, at, step.kind)) return [...steps];
  const target = targetOf(steps, at);
  const fresh = clone(step);
  if (step.kind === "branch") {
    fresh.next = null;
    fresh.branches = { yes: target, no: null };
  } else if (step.kind === "end") {
    fresh.next = null;
  } else {
    fresh.next = target;
  }
  const linked = steps.map((s) => {
    if (at.after === null || s.key !== at.after) return s;
    const c = clone(s);
    if (at.via === "next") c.next = fresh.key;
    else c.branches = { ...(c.branches ?? {}), [at.via]: fresh.key };
    return c;
  });
  const out = [...linked, fresh];
  return at.after === null ? withEntry(out, fresh.key) : out;
}

/**
 * Removes a step; whatever led to it continues with what followed it. Removing an if / else also removes the steps on its two paths and
 * continues at the step where they joined, if they did.
 */
export function removeStep<S extends GraphStep>(steps: readonly S[], key: string): S[] {
  const step = steps.find((s) => s.key === key);
  if (!step) return [...steps];
  const members = step.kind === "branch" ? branchMembers(steps, key) : [];
  const after = step.kind === "branch" ? branchJoin(steps, key) : step.kind === "end" ? null : step.next ?? null;
  const doomed = new Set([key, ...members]);
  let kept = steps.filter((s) => !doomed.has(s.key));
  const wasEntry = steps[0]?.key === key;
  kept = repoint(kept, key, after).steps;
  for (const d of members) kept = repoint(kept, d, null).steps;
  return wasEntry ? withEntry(kept, after) : kept;
}

/** Whether a plain step can swap with its neighbour on the same path (If / else and End steps, and steps where paths join, stay put). */
export function canMove<S extends GraphStep>(steps: readonly S[], key: string, dir: "up" | "down"): boolean {
  const byKey = new Map(steps.map((s) => [s.key, s]));
  const preds = predecessorCounts(steps);
  const plain = (s: GraphStep | undefined): s is GraphStep => !!s && s.kind !== "branch" && s.kind !== "end";
  const s = byKey.get(key);
  if (!plain(s)) return false;
  if (dir === "down") {
    const n = s.next ? byKey.get(s.next) : undefined;
    return plain(n) && n.key !== key && (preds.get(n.key) ?? 0) === 1;
  }
  if ((preds.get(key) ?? 0) !== 1 || steps[0]?.key === key) return false;
  const p = steps.find((x) => x.next === key);
  return plain(p) && p.key !== key;
}

/** Swaps a plain step with its neighbour on the same path. */
export function moveStep<S extends GraphStep>(steps: readonly S[], key: string, dir: "up" | "down"): S[] {
  if (!canMove(steps, key, dir)) return [...steps];
  const s = steps.find((x) => x.key === key)!;
  // a → b → rest becomes b → a → rest.
  const [a, b] = dir === "down" ? [s, steps.find((x) => x.key === s.next)!] : [steps.find((x) => x.next === key)!, s];
  const rest = b.next ?? null;
  const wasEntry = steps[0]?.key === a.key;
  const others = new Set(steps.filter((x) => x.key !== a.key && x.key !== b.key).map((x) => x.key));
  let out = repoint([...steps], a.key, b.key, others).steps;
  out = out.map((x) => (x.key === b.key ? { ...clone(x), next: a.key } : x.key === a.key ? { ...clone(x), next: rest } : x));
  return wasEntry ? withEntry(out, b.key) : out;
}
