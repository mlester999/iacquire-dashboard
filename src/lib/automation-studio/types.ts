// What the Automation Studio screens exchange with the server: plain, serializable objects with no secrets. Shared by the server services, the
// builder's stream and the client components, so none of them depends on a database row shape.
import type { WorkflowChange, WorkflowOperation } from "@/lib/crm/workflow/operations";
import type { ValidationIssue, WorkflowDefinition } from "@/lib/crm/workflow/spec";

export type MessageRole = "user" | "assistant";
/** user: pending (not answered yet) or answered. assistant: applied, answered, clarification, refused, error. */
export type MessageStatus = "pending" | "answered" | "applied" | "clarification" | "refused" | "error";
export type ChangeSource = "manual" | "ai" | "restore" | "template" | "undo" | "redo";

export interface StudioMessage {
  id: number;
  role: MessageRole;
  content: string;
  /** The step the person had selected when they wrote it. */
  nodeKey: string | null;
  status: MessageStatus;
  /** What an assistant message changed (validated operations that were applied), if anything. */
  operations: WorkflowOperation[] | null;
  changes: WorkflowChange[] | null;
  revisionBefore: number | null;
  revisionAfter: number | null;
  createdAt: string;
}

/** One entry of the working copy's trail: the draft after a change. */
export interface StudioChangeEntry {
  seq: number;
  source: ChangeSource;
  label: string;
  definition: WorkflowDefinition;
  revision: number;
  createdAt: string;
}

/** The newline-delimited JSON events the builder's endpoint streams, in order. Nothing is sent that did not happen. */
export type BuilderEvent =
  /** The person's message is stored (and a turn has begun). */
  | { type: "start"; messageId: number }
  /** What the builder is really doing right now. */
  | { type: "status"; phase: "reading" | "thinking" | "checking" | "saving"; text: string }
  /** A piece of the builder's reply, as it is written. */
  | { type: "delta"; text: string }
  /**
   * The change was validated and saved. `definition` and `revision` are the saved working copy; `operations` are exactly the validated
   * changes that produced it, in order (the canvas replays them to show the workflow growing, then settles on `definition`).
   */
  | { type: "applied"; revision: number; definition: WorkflowDefinition; operations: WorkflowOperation[]; changes: WorkflowChange[]; summary: string[]; issues: ValidationIssue[] }
  /** A proposed change was refused by validation after the allowed attempts; nothing changed. */
  | { type: "refused"; message: string }
  | { type: "done"; message: StudioMessage }
  | { type: "error"; code: string; message: string };

/** The builder cannot run: why, in words, and whether the person can do something about it. */
export interface BuilderAvailability {
  available: boolean;
  reason: string | null;
}

export interface StarterSuggestion {
  id: string;
  /** The words put in the box (editable before sending). */
  prompt: string;
  title: string;
  category: string;
}
