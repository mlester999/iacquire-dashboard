// Undo and redo for a workflow draft, as a pure stack of (before, after) snapshots. Every change to the draft, whoever made it (the editor, the
// AI Builder, a restored version), is recorded as one entry, so one undo takes back exactly one change and the AI's changes are undone the same way
// as a person's.
//
// Undo and redo only apply when the draft still is exactly what the entry produced. If anything changed it some other way in the meantime (another
// person saved, a version was restored), the entry is stale and is refused, because applying it would silently throw that newer work away.
import { canonicalJson, type WorkflowDefinition } from "@/lib/crm/workflow/spec";

export type ChangeSource = "manual" | "ai" | "restore" | "template";

export interface HistoryEntry {
  /** What the change was, in words ("Added “Send message”"). */
  label: string;
  source: ChangeSource;
  before: WorkflowDefinition;
  after: WorkflowDefinition;
  at: string;
  /** Entries recorded one after another with the same key are merged into one (dragging a node, typing in a field). */
  coalesceKey?: string;
}

export interface History {
  past: HistoryEntry[];
  future: HistoryEntry[];
}

export const HISTORY_LIMIT = 100;
export const emptyHistory = (): History => ({ past: [], future: [] });

/** Exactly equal definitions, editor layout included (undoing a drag must put the node back where it was). */
export const sameDraft = (a: WorkflowDefinition, b: WorkflowDefinition) => canonicalJson(a) === canonicalJson(b);

/** Records a change. A new change ends the redo trail. Changes that don't alter the draft at all are not recorded. */
export function record(history: History, entry: HistoryEntry, limit = HISTORY_LIMIT): History {
  if (sameDraft(entry.before, entry.after)) return history;
  const last = history.past[history.past.length - 1];
  if (entry.coalesceKey && last?.coalesceKey === entry.coalesceKey && sameDraft(last.after, entry.before)) {
    const merged: HistoryEntry = { ...last, after: entry.after, at: entry.at, label: entry.label };
    // Merged back to where it started: nothing left to undo.
    const past = sameDraft(merged.before, merged.after) ? history.past.slice(0, -1) : [...history.past.slice(0, -1), merged];
    return { past, future: [] };
  }
  return { past: [...history.past, entry].slice(-limit), future: [] };
}

export type StepResult = { ok: true; history: History; definition: WorkflowDefinition; entry: HistoryEntry } | { ok: false; reason: "nothing" | "diverged" };

/** Takes back the latest change, if the draft is still what it produced. */
export function undo(history: History, current: WorkflowDefinition): StepResult {
  const entry = history.past[history.past.length - 1];
  if (!entry) return { ok: false, reason: "nothing" };
  if (!sameDraft(entry.after, current)) return { ok: false, reason: "diverged" };
  return { ok: true, definition: entry.before, entry, history: { past: history.past.slice(0, -1), future: [entry, ...history.future] } };
}

/** Puts back the change most recently undone, if the draft is still what the undo left. */
export function redo(history: History, current: WorkflowDefinition): StepResult {
  const entry = history.future[0];
  if (!entry) return { ok: false, reason: "nothing" };
  if (!sameDraft(entry.before, current)) return { ok: false, reason: "diverged" };
  return { ok: true, definition: entry.after, entry, history: { past: [...history.past, entry], future: history.future.slice(1) } };
}

export const canUndo = (history: History, current: WorkflowDefinition) => history.past.length > 0 && sameDraft(history.past[history.past.length - 1].after, current);
export const canRedo = (history: History, current: WorkflowDefinition) => history.future.length > 0 && sameDraft(history.future[0].before, current);
