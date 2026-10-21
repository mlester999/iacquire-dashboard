"use client";

import * as React from "react";
import { applyOperations, diffDefinitions, type WorkflowChange, type WorkflowOperation } from "@/lib/crm/workflow/operations";
import { emptyHistory, record, redo as redoHistory, undo as undoHistory, canRedo as histCanRedo, canUndo as histCanUndo, type ChangeSource as HistSource, type History } from "@/lib/crm/workflow/history";
import { validateDefinition, type ValidationIssue, type WorkflowDefinition } from "@/lib/crm/workflow/spec";
import { readinessIssues, validationContextOf } from "@/components/crm/workflows/editor-logic";
import type { EditorOptions } from "@/components/crm/workflows/types";
import { saveStudioDraftAction } from "@/app/actions/automation-studio";
import { TRIGGER_ID, edgeId, type ChangeMark } from "@/components/automation-studio/canvas/flow-model";
import type { Gesture } from "@/components/automation-studio/canvas/gestures";
import type { StudioChangeEntry } from "@/lib/automation-studio/types";

/**
 * The one editing state both modes share: the working copy, its saved revision, validation, and the history. The chat and the canvas are two ways of
 * asking this hook to change the same definition; nothing else holds a copy. Every change is an operation (src/lib/crm/workflow/operations.ts), is
 * applied here at once so the canvas answers instantly, and is saved to the server in the background with the revision check, which stays the authority.
 */

export type SaveState = "saved" | "dirty" | "saving" | "error" | "conflict";

export interface StudioEditorInit {
  workflowId: string;
  definition: WorkflowDefinition;
  revision: number;
  history: StudioChangeEntry[];
  options: EditorOptions;
  /** Archived, or the plan has lapsed: viewing only. */
  readOnly: boolean;
}

const SAVE_DELAY_MS = 450;
const MARK_MS = 1800;

const prefersReducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The undo history a reload can rebuild: each saved snapshot after the first is a change from the one before. */
export function historyFromSaved(saved: StudioChangeEntry[], current: WorkflowDefinition): History {
  let h = emptyHistory();
  const last = saved[saved.length - 1];
  if (!last || JSON.stringify(last.definition) !== JSON.stringify(current)) return h;
  for (let i = 1; i < saved.length; i++) {
    h = record(h, { label: saved[i].label, source: (saved[i].source === "undo" || saved[i].source === "redo" ? "manual" : saved[i].source) as HistSource, before: saved[i - 1].definition, after: saved[i].definition, at: saved[i].createdAt });
  }
  return h;
}

export interface Dispatch {
  ok: boolean;
  message?: string;
}

export function useStudioEditor(init: StudioEditorInit) {
  const { workflowId, options } = init;
  const [def, setDef] = React.useState(init.definition);
  const defRef = React.useRef(init.definition);
  const revisionRef = React.useRef(init.revision);
  const savedRef = React.useRef(init.definition);
  const [revision, setRevision] = React.useState(init.revision);
  const [saveState, setSaveState] = React.useState<SaveState>("saved");
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [history, setHistory] = React.useState<History>(() => historyFromSaved(init.history, init.definition));
  const historyRef = React.useRef(history);
  const [locked, setLocked] = React.useState(false);
  const [marks, setMarks] = React.useState<ReadonlyMap<string, ChangeMark>>(new Map());
  const [addedEdges, setAddedEdges] = React.useState<ReadonlySet<string>>(new Set());
  const [animating, setAnimating] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = React.useRef<Promise<boolean> | null>(null);
  const label = React.useRef("Changed the workflow");
  const source = React.useRef<"manual" | "undo" | "redo" | "restore">("manual");
  const markTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = React.useRef(true);
  // Set again on every mount: in development React mounts, unmounts and mounts once more, and a flag only ever cleared would stop every replay and save.
  React.useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; if (timer.current) clearTimeout(timer.current); if (markTimer.current) clearTimeout(markTimer.current); };
  }, []);

  const context = React.useMemo(() => validationContextOf(options), [options]);
  const issues = React.useMemo<ValidationIssue[]>(() => [...validateDefinition(def, context), ...readinessIssues(def, options)], [def, context, options]);

  const commitLocal = React.useCallback((next: WorkflowDefinition) => {
    defRef.current = next;
    setDef(next);
  }, []);
  const setHistoryBoth = React.useCallback((h: History) => {
    historyRef.current = h;
    setHistory(h);
  }, []);

  // ---- saving -------------------------------------------------------------
  const save = React.useCallback(async (): Promise<boolean> => {
    if (inFlight.current) return inFlight.current;
    const run = (async () => {
      let ok = true;
      for (let guard = 0; guard < 6; guard++) {
        if (JSON.stringify(defRef.current) === JSON.stringify(savedRef.current)) break;
        const snapshot = defRef.current;
        setSaveState("saving");
        const res = await saveStudioDraftAction(workflowId, { definition: snapshot, expectedRevision: revisionRef.current, source: source.current, label: label.current });
        if (!alive.current) return false;
        if (!res.ok) {
          setSaveState(res.code === "conflict" ? "conflict" : "error");
          setSaveError(res.error);
          ok = false;
          break;
        }
        revisionRef.current = res.data.revision;
        setRevision(res.data.revision);
        savedRef.current = snapshot;
        setSaveError(null);
        source.current = "manual";
      }
      if (ok) setSaveState(JSON.stringify(defRef.current) === JSON.stringify(savedRef.current) ? "saved" : "dirty");
      return ok;
    })();
    inFlight.current = run;
    try {
      return await run;
    } finally {
      inFlight.current = null;
    }
  }, [workflowId]);

  const scheduleSave = React.useCallback((delay = SAVE_DELAY_MS) => {
    setSaveState((s) => (s === "conflict" ? s : "dirty"));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), delay);
  }, [save]);

  /** Resolves true once everything done so far is saved (before a message is sent to the builder, so it reads the latest workflow). */
  const flush = React.useCallback(async (): Promise<boolean> => {
    if (timer.current) clearTimeout(timer.current);
    if (inFlight.current) await inFlight.current;
    return JSON.stringify(defRef.current) === JSON.stringify(savedRef.current) ? true : save();
  }, [save]);

  // ---- changes ------------------------------------------------------------
  const markChanges = React.useCallback((changes: WorkflowChange[]) => {
    if (prefersReducedMotion()) return;
    const m = new Map<string, ChangeMark>();
    const e = new Set<string>();
    for (const c of changes) {
      if (c.type === "step_added") m.set(c.key, "added");
      else if (c.type === "step_modified") m.set(c.key, m.get(c.key) === "added" ? "added" : "modified");
      else if (c.type === "trigger_changed") m.set(TRIGGER_ID, "modified");
      else if (c.type === "link_changed" && c.to) e.add(edgeId(c.from, c.via, c.to));
      else if (c.type === "entry_changed") e.add(edgeId(TRIGGER_ID, "next", c.key));
    }
    setMarks((prev) => new Map([...prev, ...m]));
    setAddedEdges((prev) => new Set([...prev, ...e]));
    if (markTimer.current) clearTimeout(markTimer.current);
    markTimer.current = setTimeout(() => { setMarks(new Map()); setAddedEdges(new Set()); }, MARK_MS);
  }, []);

  /** A change by the person. Applied at once; saved in the background. Refused (with a reason) when it isn't valid. */
  const apply = React.useCallback((operations: WorkflowOperation[], meta: { label: string; coalesceKey?: string }): Dispatch => {
    if (init.readOnly || locked) return { ok: false, message: locked ? "The builder is working on this. You can edit again when it's done." : "This workflow can't be changed right now." };
    const before = defRef.current;
    const result = applyOperations(before, operations, { mode: "draft" });
    if (!result.ok) return { ok: false, message: result.error.message };
    if (!result.changes.length) return { ok: true };
    commitLocal(result.definition);
    setHistoryBoth(record(historyRef.current, { label: meta.label, source: "manual", before, after: result.definition, at: new Date().toISOString(), coalesceKey: meta.coalesceKey }));
    label.current = meta.label;
    source.current = "manual";
    markChanges(result.changes.filter((c) => c.type !== "step_moved"));
    scheduleSave(meta.coalesceKey ? 900 : SAVE_DELAY_MS);
    return { ok: true };
  }, [init.readOnly, locked, commitLocal, setHistoryBoth, markChanges, scheduleSave]);

  const gesture = React.useCallback((g: Gesture, coalesceKey?: string): Dispatch => (g.ok ? apply(g.operations, { label: g.label, coalesceKey }) : { ok: false, message: g.message }), [apply]);

  const step = React.useCallback((dir: "undo" | "redo"): Dispatch => {
    if (init.readOnly || locked) return { ok: false, message: "This workflow can't be changed right now." };
    const r = dir === "undo" ? undoHistory(historyRef.current, defRef.current) : redoHistory(historyRef.current, defRef.current);
    if (!r.ok) return { ok: false, message: r.reason === "nothing" ? `Nothing to ${dir}.` : "The workflow changed some other way, so that can't be undone safely." };
    commitLocal(r.definition);
    setHistoryBoth(r.history);
    label.current = `${dir === "undo" ? "Undid" : "Redid"}: ${r.entry.label}`;
    source.current = dir;
    markChanges(diffDefinitions(r.entry.before, r.entry.after).filter((c) => c.type !== "step_moved"));
    scheduleSave(150);
    return { ok: true, message: label.current };
  }, [init.readOnly, locked, commitLocal, setHistoryBoth, markChanges, scheduleSave]);

  /**
   * The builder's change, after the server saved it. The validated operations are replayed one at a time onto the canvas so the person watches the
   * workflow take shape, then the canvas settles on exactly what the server saved. The replay only shows what happened; the saved copy is the truth.
   */
  const replay = React.useCallback(async (operations: WorkflowOperation[], final: WorkflowDefinition, savedRevision: number, summary: string) => {
    const before = defRef.current;
    if (timer.current) clearTimeout(timer.current);
    setAnimating(true);
    const reduced = prefersReducedMotion();
    const gap = reduced ? 0 : Math.max(140, Math.min(420, Math.floor(3600 / Math.max(1, operations.length))));
    let cur = before;
    for (const op of operations) {
      const r = applyOperations(cur, [op], { mode: "draft" });
      if (!r.ok) break;
      cur = r.definition;
      commitLocal(cur);
      markChanges(r.changes);
      if (gap) await sleep(gap);
      if (!alive.current) return;
    }
    commitLocal(final);
    revisionRef.current = savedRevision;
    setRevision(savedRevision);
    savedRef.current = final;
    setSaveState("saved");
    setSaveError(null);
    setHistoryBoth(record(historyRef.current, { label: summary, source: "ai", before, after: final, at: new Date().toISOString() }));
    if (!reduced) await sleep(280);
    setAnimating(false);
  }, [commitLocal, markChanges, setHistoryBoth]);

  /** Replace everything with what the server holds (after a conflict, or a restored version). Unsaved local changes are dropped. */
  const adopt = React.useCallback((next: WorkflowDefinition, nextRevision: number) => {
    if (timer.current) clearTimeout(timer.current);
    commitLocal(next);
    revisionRef.current = nextRevision;
    setRevision(nextRevision);
    savedRef.current = next;
    setHistoryBoth(emptyHistory());
    setSaveState("saved");
    setSaveError(null);
  }, [commitLocal, setHistoryBoth]);

  return {
    definition: def, revision, issues, saveState, saveError, history, locked, setLocked, animating, marks, addedEdges,
    canUndo: !init.readOnly && !locked && histCanUndo(history, def), canRedo: !init.readOnly && !locked && histCanRedo(history, def),
    apply, gesture, undo: () => step("undo"), redo: () => step("redo"), flush, replay, adopt, readOnly: init.readOnly,
  };
}

export type StudioEditor = ReturnType<typeof useStudioEditor>;
