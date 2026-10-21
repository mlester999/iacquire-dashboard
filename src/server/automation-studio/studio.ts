import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { assertCan, auditActor, type CrmActor } from "@/server/crm/actor";
import { createWorkflow, getWorkflow, listWorkflows, saveDraftInTx, storableDraft, type WorkflowDetail, type WorkflowSummary } from "@/server/crm/workflows/definitions";
import type { WorkflowChange, WorkflowOperation } from "@/lib/crm/workflow/operations";
import { canonicalJson, definitionHash, emptyDefinition, parseDefinition, type ValidationIssue, type WorkflowDefinition } from "@/lib/crm/workflow/spec";
import type { ChangeSource, MessageStatus, StudioChangeEntry, StudioMessage } from "@/lib/automation-studio/types";

/**
 * Automation Studio's own records around a workflow: the conversation with the AI Automation Builder and the trail of changes to the working
 * copy. The workflow itself is the CRM workflow (one canonical model, src/server/crm/workflows); everything that changes it goes through the same
 * services as the CRM screens, so the plan, the permissions, the revision check and validation apply identically.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MESSAGES_SHOWN = 200;
/** How many working-copy snapshots are kept per workflow (undo history after a reload, and the trail). */
export const CHANGES_KEPT = 100;
export const HISTORY_SHOWN = 51;
const MAX_MESSAGE_CHARS = 4000;

interface MessageRow {
  id: string;
  role: "user" | "assistant";
  content: string;
  node_key: string | null;
  status: MessageStatus;
  operations: WorkflowOperation[] | null;
  changes: WorkflowChange[] | null;
  revision_before: number | null;
  revision_after: number | null;
  created_at: Date;
}

const toMessage = (r: MessageRow): StudioMessage => ({
  id: Number(r.id), role: r.role, content: r.content, nodeKey: r.node_key, status: r.status, operations: r.operations, changes: r.changes,
  revisionBefore: r.revision_before, revisionAfter: r.revision_after, createdAt: new Date(r.created_at).toISOString(),
});
const MESSAGE_COLUMNS = "id, role, content, node_key, status, operations, changes, revision_before, revision_after, created_at";

export interface NewMessage {
  orgId: string;
  workflowId: string;
  role: "user" | "assistant";
  content: string;
  nodeKey?: string | null;
  status: MessageStatus;
  operations?: WorkflowOperation[] | null;
  changes?: WorkflowChange[] | null;
  revisionBefore?: number | null;
  revisionAfter?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  userId?: string | null;
}

export async function insertMessage(db: Queryable, m: NewMessage): Promise<StudioMessage> {
  const content = m.content.trim().slice(0, 12_000);
  if (!content) throw new AppError("invalid_input", "Write a message first.");
  const { rows } = await db.query<MessageRow>(
    `insert into automation_studio_messages (org_id, workflow_id, role, content, node_key, status, operations, changes, revision_before, revision_after, input_tokens, output_tokens, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning ${MESSAGE_COLUMNS}`,
    [
      m.orgId, m.workflowId, m.role, content, m.nodeKey?.slice(0, 60) ?? null, m.status, m.operations ? JSON.stringify(m.operations) : null, m.changes ? JSON.stringify(m.changes) : null,
      m.revisionBefore ?? null, m.revisionAfter ?? null, m.inputTokens ?? null, m.outputTokens ?? null, m.userId ?? null,
    ],
  );
  return toMessage(rows[0]);
}

export async function listMessages(db: Queryable, orgId: string, workflowId: string, limit = MESSAGES_SHOWN): Promise<StudioMessage[]> {
  const { rows } = await db.query<MessageRow>(
    `select ${MESSAGE_COLUMNS} from (select ${MESSAGE_COLUMNS} from automation_studio_messages where org_id = $1 and workflow_id = $2 order by id desc limit $3) m order by id`,
    [orgId, workflowId, limit],
  );
  return rows.map(toMessage);
}

/** Records the working copy after a change and keeps only the newest CHANGES_KEPT. Returns its sequence number. */
export async function recordChange(db: Queryable, c: { orgId: string; workflowId: string; source: ChangeSource; label: string; definition: WorkflowDefinition; revision: number; messageId?: number | null; userId?: string | null }): Promise<number> {
  const parsed = parseDefinition(c.definition);
  const hash = parsed.definition && parsed.ok ? definitionHash(parsed.definition) : null;
  const { rows } = await db.query<{ seq: number }>(
    `insert into automation_studio_changes (org_id, workflow_id, seq, source, label, definition, content_hash, revision, message_id, created_by)
     values ($1, $2, (select coalesce(max(seq), 0) + 1 from automation_studio_changes where workflow_id = $2 and org_id = $1), $3, $4, $5, $6, $7, $8, $9) returning seq`,
    [c.orgId, c.workflowId, c.source, c.label.slice(0, 300) || "Changed the workflow", JSON.stringify(c.definition), hash, c.revision, c.messageId ?? null, c.userId ?? null],
  );
  await db.query("delete from automation_studio_changes where org_id = $1 and workflow_id = $2 and seq <= $3", [c.orgId, c.workflowId, rows[0].seq - CHANGES_KEPT]);
  return rows[0].seq;
}

/** The last few changes to a working copy, by label only: what the builder is told about edits made since it last spoke. */
export async function recentChangeLabels(db: Queryable, orgId: string, workflowId: string, limit = 8): Promise<Array<{ seq: number; source: string; label: string }>> {
  const { rows } = await db.query<{ seq: number; source: string; label: string }>(
    `select seq, source, label from (select seq, source, label from automation_studio_changes where org_id = $1 and workflow_id = $2 order by seq desc limit $3) c order by seq`,
    [orgId, workflowId, limit],
  );
  return rows.map((r) => ({ seq: Number(r.seq), source: r.source, label: r.label }));
}

async function listChanges(db: Queryable, orgId: string, workflowId: string, limit = HISTORY_SHOWN): Promise<StudioChangeEntry[]> {
  const { rows } = await db.query<{ seq: number; source: ChangeSource; label: string; definition: WorkflowDefinition; revision: number; created_at: Date }>(
    `select seq, source, label, definition, revision, created_at from (select * from automation_studio_changes where org_id = $1 and workflow_id = $2 order by seq desc limit $3) c order by seq`,
    [orgId, workflowId, limit],
  );
  return rows.map((r) => ({ seq: r.seq, source: r.source, label: r.label, definition: r.definition, revision: r.revision, createdAt: new Date(r.created_at).toISOString() }));
}

// ---------------------------------------------------------------------------
// Listing, starting, opening
// ---------------------------------------------------------------------------

/** The workspace's automations built in Automation Studio, most recently changed first. */
export async function listStudioWorkflows(actor: CrmActor): Promise<WorkflowSummary[]> {
  assertCan(actor, "workflows.view");
  return (await listWorkflows(actor)).filter((w) => w.origin === "studio").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** A working title from what the person asked for: the first few words, never longer than the workflow-name limit. */
export function titleFromPrompt(prompt: string): string {
  const words = prompt.replace(/\s+/g, " ").trim().replace(/^(please\s+)?(can you\s+|could you\s+)?/i, "").split(" ").slice(0, 7).join(" ");
  const title = words.replace(/[.!?,;:]+$/, "").trim();
  if (!title) return "New automation";
  return (title.charAt(0).toUpperCase() + title.slice(1)).slice(0, 60);
}

/**
 * Starts an automation in Automation Studio: a new working copy (empty, or from a definition the caller built, such as a template) and, when the
 * person already said what they want, that message stored as the first one in the conversation, waiting to be answered. The words are never put
 * in a URL: the workspace opens by id and answers the stored message.
 */
export async function startStudioWorkflow(actor: CrmActor, input: { prompt?: string; name?: string; definition?: WorkflowDefinition; label?: string }): Promise<{ id: string; pendingMessageId: number | null }> {
  assertCan(actor, "workflows.manage", "Building automations needs the automations permission.");
  const prompt = input.prompt?.trim() ?? "";
  if (prompt.length > MAX_MESSAGE_CHARS) throw new AppError("invalid_input", `Keep your request under ${MAX_MESSAGE_CHARS} characters.`);
  const definition = input.definition ? storableDraft(input.definition) : emptyDefinition();
  const name = (input.name?.trim() || (prompt ? titleFromPrompt(prompt) : "New automation")).slice(0, 80);
  const created = await createWorkflow(actor, { name, definition, origin: "studio" });
  const pendingMessageId = await withSystem(async (db) => {
    await recordChange(db, { orgId: actor.orgId, workflowId: created.id, source: input.definition ? "template" : "manual", label: input.label ?? (input.definition ? "Started from a template" : "Started"), definition, revision: 1, userId: actor.userId });
    if (!prompt) return null;
    const m = await insertMessage(db, { orgId: actor.orgId, workflowId: created.id, role: "user", content: prompt, status: "pending", userId: actor.userId });
    return m.id;
  });
  return { id: created.id, pendingMessageId };
}

export interface StudioState {
  workflow: WorkflowDetail;
  messages: StudioMessage[];
  /** The working copy's recent trail, oldest first (the editor's undo history is rebuilt from it). */
  history: StudioChangeEntry[];
}

export async function getStudioState(actor: CrmActor, id: string): Promise<StudioState> {
  assertCan(actor, "workflows.view");
  if (!UUID.test(id)) throw new AppError("not_found", "Workflow not found.");
  const workflow = await getWorkflow(actor, id);
  const [messages, history] = await withSystem(async (db) => [await listMessages(db, actor.orgId, id), await listChanges(db, actor.orgId, id)] as const);
  return { workflow, messages, history };
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

export interface StudioSaveResult {
  revision: number;
  issues: ValidationIssue[];
  draftHash: string | null;
  seq: number | null;
}

/**
 * Saves the working copy from the editor and records the change, in one transaction. The same checks as the CRM editor's save: permission, the
 * plan for what needs it, the revision (a save over someone else's newer one is refused), and the shape. A save that changes nothing is not
 * recorded.
 */
export async function saveStudioDraft(actor: CrmActor, id: string, input: { definition: unknown; expectedRevision: number; source: ChangeSource; label: string }): Promise<StudioSaveResult> {
  assertCan(actor, "workflows.manage", "Changing automations needs the automations permission.");
  if (!UUID.test(id)) throw new AppError("not_found", "Workflow not found.");
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) throw new AppError("invalid_input", "Reload the workflow and try again.");
  const draft = storableDraft(input.definition);
  return withSystem(async (db) => {
    const before = (await db.query<{ draft: unknown }>("select draft from crm_workflows where id = $1 and org_id = $2", [id, actor.orgId])).rows[0];
    if (!before) throw new AppError("not_found", "Workflow not found.");
    const saved = await saveDraftInTx(db, actor, id, draft, input.expectedRevision);
    const hashBefore = (() => {
      const p = parseDefinition(before.draft);
      return p.definition && p.ok ? definitionHash(p.definition) : null;
    })();
    // Editor layout alone (a node moved) is still a change worth being able to undo, so the trail compares the whole draft.
    const same = canonicalJson(before.draft) === canonicalJson(draft);
    const seq = same ? null : await recordChange(db, { orgId: actor.orgId, workflowId: id, source: input.source, label: input.label, definition: draft, revision: saved.revision, userId: actor.userId });
    if (input.source === "manual" && hashBefore !== saved.draftHash) {
      await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "automation_studio.draft_saved", targetType: "crm_workflow", targetId: id, result: "success", metadata: { revision: saved.revision, source: input.source } }, db);
    }
    return { ...saved, seq };
  });
}
