import "server-only";
import crypto from "node:crypto";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyOrgRoles } from "@/server/notifications";
import { createApproval } from "@/server/approvals/service";
import { checkOrgAutomation } from "@/server/automation/gate";
import { assertCan, auditActor, type CrmActor } from "@/server/crm/actor";
import { assertNativeOwner, isSwitching } from "@/server/crm/workspace";
import { loadBuilderOptions, loadValidationContext, validateForPublish, type WorkflowBuilderOptions } from "@/server/crm/workflows/context";
import { inboundUrlFor } from "@/server/crm/workflows/inbound";
import { assertMayRunDefinition } from "@/server/crm/workflows/permissions";
import { LIVE_RUN_STATUSES, VERSION_COLUMNS, iso, type VersionRow, type WorkflowRow } from "@/server/crm/workflows/engine";
import {
  EFFECT_LABELS, TRIGGERS, WORKFLOW_LIMITS, definitionHash, deriveEffects, emptyDefinition, isTriggerType, needsOwnerApproval, parseDefinition,
  validateDefinition, validationContextFrom,
  type SendMessageConfig, type TriggerType, type ValidationIssue, type WorkflowDefinition, type WorkflowEffect, type WorkflowStep,
} from "@/lib/crm/workflow/spec";
import { WORKFLOW_TEMPLATES, workflowTemplate, type MessageChoice, type StageChoice, type TemplateInputSpec, type TemplateInputs } from "@/lib/crm/workflow/templates";

/**
 * Workflow definitions: the list, the editor's working copy (saved with a revision check), publishing (validate against the workspace,
 * freeze an immutable version, derive what it can do outside the CRM), the owner approval bound to a version's content hash, switching
 * workflows on and off, cloning, and built-in templates.
 *
 * Reads use the trusted path after the permission check (every query names the workspace): a workflow's state includes the status of
 * its approval, which row-level security would hide from someone who can see automations but not the Approval Center.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_DRAFT_BYTES = 120_000;

export type WorkflowStatus = WorkflowRow["status"];
/** Whether a version can run as far as an owner's approval goes. */
export type ApprovalState = "not_needed" | "needed" | "pending" | "approved" | "rejected" | "expired";

export interface WorkflowSummary {
  id: string;
  key: string;
  name: string;
  description: string | null;
  status: WorkflowStatus;
  folderId: string | null;
  folderName: string | null;
  /** The draft's trigger (what the editor shows). */
  triggerType: TriggerType | null;
  /** The published version's trigger (what actually runs). */
  publishedTriggerType: TriggerType | null;
  stepCount: number;
  publishedVersion: number | null;
  publishedVersionId: string | null;
  /** The saved draft differs from the published version (or nothing is published yet). */
  unpublishedChanges: boolean;
  approval: ApprovalState;
  effects: WorkflowEffect[];
  hourlyRunLimit: number;
  lastRunAt: string | null;
  runsToday: number;
  failuresToday: number;
  liveRuns: number;
  createdAt: string;
  updatedAt: string;
}

export interface VersionView {
  id: string;
  version: number;
  publishedAt: string;
  publishedByName: string | null;
  effects: WorkflowEffect[];
  contentHash: string;
  current: boolean;
  approval: ApprovalState;
  approvalId: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  /** The frozen definition, for viewing an older version read-only. */
  definition: WorkflowDefinition;
}

export interface WorkflowDetail extends WorkflowSummary {
  /** The saved working copy, exactly as stored (it may not validate yet). */
  draft: WorkflowDefinition;
  draftRevision: number;
  /** The draft's content hash when it parses, to compare with versions. */
  draftHash: string | null;
  /** Problems with the draft against the workspace as it is now (errors block publishing). */
  issues: ValidationIssue[];
  versions: VersionView[];
  createdByName: string | null;
  updatedByName: string | null;
  /** The published version's private inbound URL, for inbound-webhook workflows. */
  inboundUrl: string | null;
  /** Why runs are held right now even though the workflow is on (a workspace pause, the agency pause, a provider switch), or null. */
  pausedReason: string | null;
}

interface ListRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  status: WorkflowStatus;
  folder_id: string | null;
  folder_name: string | null;
  draft: unknown;
  draft_revision: number;
  published_version_id: string | null;
  hourly_run_limit: number;
  created_at: Date;
  updated_at: Date;
  created_by_name: string | null;
  updated_by_name: string | null;
  version: number | null;
  trigger_config: { type?: string } | null;
  effects: string[] | null;
  content_hash: string | null;
  approved_hash: string | null;
  approval_id: string | null;
  approval_status: string | null;
  approval_expires_at: Date | null;
  last_run_at: Date | null;
  runs_today: number;
  failures_today: number;
  live_runs: number;
}

const LIST_SQL = `
  select w.id, w.key, w.name, w.description, w.status, w.folder_id, f.name as folder_name, w.draft, w.draft_revision, w.published_version_id, w.hourly_run_limit,
         w.created_at, w.updated_at, cu.full_name as created_by_name, uu.full_name as updated_by_name,
         v.version, v.trigger_config, v.effects, v.content_hash, v.approved_hash, v.approval_id, a.status as approval_status, a.expires_at as approval_expires_at,
         (select max(r.created_at) from crm_workflow_runs r where r.workflow_id = w.id and r.org_id = w.org_id and r.started_via <> 'test') as last_run_at,
         (select count(*)::int from crm_workflow_runs r where r.workflow_id = w.id and r.org_id = w.org_id and r.started_via <> 'test'
            and r.created_at >= now() - interval '24 hours' and coalesce(r.context->>'outcome', '') <> 'rate_limited') as runs_today,
         (select count(*)::int from crm_workflow_runs r where r.workflow_id = w.id and r.org_id = w.org_id and r.status in ('failed', 'dead')
            and coalesce(r.finished_at, r.created_at) >= now() - interval '24 hours') as failures_today,
         (select count(*)::int from crm_workflow_runs r where r.workflow_id = w.id and r.org_id = w.org_id and r.status in ('queued', 'running', 'waiting', 'awaiting_approval')) as live_runs
  from crm_workflows w
  left join crm_folders f on f.id = w.folder_id and f.org_id = w.org_id
  left join users cu on cu.id = w.created_by
  left join users uu on uu.id = w.updated_by
  left join crm_workflow_versions v on v.id = w.published_version_id and v.org_id = w.org_id
  left join approval_requests a on a.id = v.approval_id and a.org_id = w.org_id`;

/** The approval state of a version from its own columns and its approval request. */
export function approvalStateOf(v: { effects: readonly string[]; content_hash: string; approved_hash: string | null; approval_id: string | null }, a: { status: string | null; expires_at: Date | null } | null, now = new Date()): ApprovalState {
  if (!needsOwnerApproval(v.effects)) return "not_needed";
  if (!v.approval_id || !a?.status) return "needed";
  if (a.status === "approved") {
    if (v.approved_hash !== v.content_hash) return "needed";
    return a.expires_at && new Date(a.expires_at).getTime() <= now.getTime() ? "expired" : "approved";
  }
  if (a.status === "pending") return a.expires_at && new Date(a.expires_at).getTime() <= now.getTime() ? "expired" : "pending";
  if (a.status === "rejected" || a.status === "changes_requested") return "rejected";
  return "expired";
}

/** A stored draft as a definition the editor can open (an empty or unreadable draft opens as a blank one). */
function storedDraft(raw: unknown): WorkflowDefinition {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const r = raw as { trigger?: unknown; steps?: unknown };
    if (r.trigger && typeof r.trigger === "object" && Array.isArray(r.steps)) return r as WorkflowDefinition;
  }
  return emptyDefinition();
}

function draftHashOf(raw: unknown): string | null {
  const parsed = parseDefinition(raw);
  return parsed.definition && parsed.ok ? definitionHash(parsed.definition) : null;
}

function toSummary(r: ListRow, now: Date): WorkflowSummary {
  const draft = storedDraft(r.draft);
  const draftHash = draftHashOf(r.draft);
  const approval = r.published_version_id && r.content_hash
    ? approvalStateOf({ effects: r.effects ?? [], content_hash: r.content_hash, approved_hash: r.approved_hash, approval_id: r.approval_id }, r.approval_status ? { status: r.approval_status, expires_at: r.approval_expires_at } : null, now)
    : "not_needed";
  const triggerType = isTriggerType(draft.trigger?.type) ? draft.trigger.type : null;
  const published = r.trigger_config?.type;
  return {
    id: r.id, key: r.key, name: r.name, description: r.description, status: r.status, folderId: r.folder_id, folderName: r.folder_name,
    triggerType, publishedTriggerType: isTriggerType(published) ? published : null, stepCount: Array.isArray(draft.steps) ? draft.steps.length : 0,
    publishedVersion: r.version, publishedVersionId: r.published_version_id,
    unpublishedChanges: !r.published_version_id || !draftHash || draftHash !== r.content_hash,
    approval, effects: (r.effects ?? []) as WorkflowEffect[], hourlyRunLimit: r.hourly_run_limit,
    lastRunAt: iso(r.last_run_at), runsToday: r.runs_today, failuresToday: r.failures_today, liveRuns: r.live_runs,
    createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!,
  };
}

const notFound = () => new AppError("not_found", "Workflow not found.");

export interface WorkflowListQuery {
  folderId?: string | null;
  status?: WorkflowStatus | "all" | "live";
  search?: string;
}

/** Workflows of the workspace, archived ones only when asked for (status "archived" or "all"). */
export async function listWorkflows(actor: CrmActor, q: WorkflowListQuery = {}): Promise<WorkflowSummary[]> {
  assertCan(actor, "workflows.view");
  if (q.folderId && !UUID.test(q.folderId)) return [];
  return withSystem(async (db) => {
    const params: unknown[] = [actor.orgId];
    const where = ["w.org_id = $1"];
    if (q.status === "all") {
      // everything
    } else if (q.status === "archived") where.push("w.status = 'archived'");
    else if (q.status === "live") where.push("w.status = 'active'");
    else if (q.status) {
      params.push(q.status);
      where.push(`w.status = $${params.length}`);
    } else where.push("w.status <> 'archived'");
    if (q.folderId) {
      params.push(q.folderId);
      where.push(`w.folder_id = $${params.length}`);
    }
    const search = q.search?.trim().slice(0, 80);
    if (search) {
      params.push(`%${search.toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
      where.push(`(lower(w.name) like $${params.length} escape '\\' or lower(coalesce(w.description, '')) like $${params.length} escape '\\')`);
    }
    const { rows } = await db.query<ListRow>(`${LIST_SQL} where ${where.join(" and ")} order by lower(w.name), w.created_at limit 500`, params);
    const now = new Date();
    return rows.map((r) => toSummary(r, now));
  });
}

async function versionViews(db: Queryable, orgId: string, workflowId: string, publishedVersionId: string | null, now: Date): Promise<VersionView[]> {
  const { rows } = await db.query<VersionRow & { published_by_name: string | null; approved_by_name: string | null; approval_status: string | null; approval_expires_at: Date | null }>(
    `select ${VERSION_COLUMNS}, pu.full_name as published_by_name, au.full_name as approved_by_name, a.status as approval_status, a.expires_at as approval_expires_at
     from crm_workflow_versions v
     left join users pu on pu.id = v.published_by
     left join users au on au.id = v.approved_by
     left join approval_requests a on a.id = v.approval_id and a.org_id = v.org_id
     where v.workflow_id = $1 and v.org_id = $2 order by v.version desc limit 100`,
    [workflowId, orgId],
  );
  return rows.map((v) => ({
    id: v.id, version: v.version, publishedAt: iso(v.published_at)!, publishedByName: v.published_by_name, effects: v.effects as WorkflowEffect[], contentHash: v.content_hash,
    current: v.id === publishedVersionId,
    approval: approvalStateOf(v, v.approval_status ? { status: v.approval_status, expires_at: v.approval_expires_at } : null, now),
    approvalId: v.approval_id, approvedByName: v.approved_by_name, approvedAt: iso(v.approved_at),
    definition: { trigger: v.trigger_config, steps: v.steps },
  }));
}

/** Why the workspace holds workflow runs right now, in words, or null. */
async function heldReason(db: Queryable, orgId: string): Promise<string | null> {
  const gate = await checkOrgAutomation(db, orgId, "workflows");
  if (!gate.allowed) return gate.detail;
  if (await isSwitching(db, orgId)) return "This workspace is switching CRM providers, so workflow runs wait until that finishes.";
  try {
    await assertNativeOwner(db, orgId, "workflows");
  } catch (err) {
    if (err instanceof AppError) return err.message;
    throw err;
  }
  return null;
}

export async function getWorkflow(actor: CrmActor, id: string): Promise<WorkflowDetail> {
  assertCan(actor, "workflows.view");
  if (!UUID.test(id)) throw notFound();
  return withSystem(async (db) => {
    const r = (await db.query<ListRow>(`${LIST_SQL} where w.id = $1 and w.org_id = $2`, [id, actor.orgId])).rows[0];
    if (!r) throw notFound();
    const now = new Date();
    const summary = toSummary(r, now);
    const versions = await versionViews(db, actor.orgId, id, r.published_version_id, now);
    const current = versions.find((v) => v.current) ?? null;
    const trig = current?.definition.trigger;
    const nonce = trig?.type === "inbound_webhook" ? trig.inbound?.nonce : null;
    return {
      ...summary,
      draft: storedDraft(r.draft),
      draftRevision: r.draft_revision,
      draftHash: draftHashOf(r.draft),
      issues: validateDefinition(r.draft, await loadValidationContext(db, actor.orgId)),
      versions,
      createdByName: r.created_by_name,
      updatedByName: r.updated_by_name,
      inboundUrl: nonce ? inboundUrlFor(id, nonce) : null,
      pausedReason: await heldReason(db, actor.orgId),
    };
  });
}

export async function listWorkflowVersions(actor: CrmActor, id: string): Promise<VersionView[]> {
  assertCan(actor, "workflows.view");
  if (!UUID.test(id)) throw notFound();
  return withSystem(async (db) => {
    const w = (await db.query<{ published_version_id: string | null }>("select published_version_id from crm_workflows where id = $1 and org_id = $2", [id, actor.orgId])).rows[0];
    if (!w) throw notFound();
    return versionViews(db, actor.orgId, id, w.published_version_id, new Date());
  });
}

/** Everything the editor's pickers offer (and the validator checks against): approved templates, verified n8n mappings, active webhooks… */
export async function getWorkflowBuilderOptions(actor: CrmActor): Promise<WorkflowBuilderOptions & { folders: Array<{ id: string; name: string }> }> {
  assertCan(actor, "workflows.view");
  return withSystem(async (db) => {
    const options = await loadBuilderOptions(db, actor.orgId);
    const folders = await db.query<{ id: string; name: string }>("select id, name from crm_folders where org_id = $1 and kind = 'workflow' order by position, lower(name)", [actor.orgId]);
    return { ...options, folders: folders.rows };
  });
}

/** Live validation of a definition the editor holds (saved or not) against the workspace. */
export async function validateWorkflowDraft(actor: CrmActor, definition: unknown): Promise<ValidationIssue[]> {
  assertCan(actor, "workflows.view");
  return withSystem(async (db) => validateDefinition(definition, await loadValidationContext(db, actor.orgId)));
}

// ---------------------------------------------------------------------------
// Creating, editing, cloning
// ---------------------------------------------------------------------------

function cleanName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (!name) throw new AppError("invalid_input", "Give the workflow a name.");
  if (name.length > 80) throw new AppError("invalid_input", "Keep the name to 80 characters.");
  return name;
}

function cleanDescription(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") throw new AppError("invalid_input", "The description must be text.");
  const d = raw.trim();
  if (d.length > 500) throw new AppError("invalid_input", "Keep the description to 500 characters.");
  return d || null;
}

async function assertFolder(db: Queryable, orgId: string, folderId: string | null | undefined) {
  if (!folderId) return;
  if (!UUID.test(folderId)) throw new AppError("not_found", "Folder not found.");
  const f = await db.query("select 1 from crm_folders where id = $1 and org_id = $2 and kind = 'workflow'", [folderId, orgId]);
  if (!f.rows[0]) throw new AppError("not_found", "Folder not found.");
}

/** A key unique among the workspace's workflows that aren't archived, from the name. */
async function uniqueKey(db: Queryable, orgId: string, name: string, exceptId: string | null = null): Promise<string> {
  const base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "workflow";
  const { rows } = await db.query<{ key: string }>("select key from crm_workflows where org_id = $1 and archived_at is null and key like $2 and ($3::uuid is null or id <> $3)", [orgId, `${base}%`, exceptId]);
  const taken = new Set(rows.map((r) => r.key));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 10_000; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${crypto.randomBytes(3).toString("hex")}`;
}

/** A new inbound URL nonce (what the editor generates; the signature is derived on the server). */
const newNonce = () => crypto.randomBytes(18).toString("base64url");

/** Checks a draft is a storable shape: an object with a trigger object and a steps list, within the size limit. */
function storableDraft(raw: unknown): WorkflowDefinition {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AppError("invalid_input", "This workflow can't be saved: it isn't a workflow definition.");
  const r = raw as { trigger?: unknown; steps?: unknown };
  if (!r.trigger || typeof r.trigger !== "object" || Array.isArray(r.trigger) || typeof (r.trigger as { type?: unknown }).type !== "string") throw new AppError("invalid_input", "Choose what starts this workflow.");
  if (!Array.isArray(r.steps)) throw new AppError("invalid_input", "This workflow can't be saved: its steps are missing.");
  if (r.steps.length > WORKFLOW_LIMITS.maxSteps * 2) throw new AppError("invalid_input", `A workflow can have at most ${WORKFLOW_LIMITS.maxSteps} steps.`);
  const draft = { trigger: r.trigger, steps: r.steps } as WorkflowDefinition;
  if (Buffer.byteLength(JSON.stringify(draft), "utf8") > MAX_DRAFT_BYTES) throw new AppError("invalid_input", "This workflow is too large to save. Split it into two workflows.");
  return draft;
}

export async function createWorkflow(actor: CrmActor, input: { name: string; description?: string | null; folderId?: string | null; triggerType?: string | null; definition?: unknown }): Promise<{ id: string; key: string }> {
  assertCan(actor, "workflows.manage", "Building automations needs the automations permission.");
  const name = cleanName(input.name);
  const description = cleanDescription(input.description);
  if (input.triggerType && !isTriggerType(input.triggerType)) throw new AppError("invalid_input", "Choose what starts this workflow.");
  const draft = input.definition !== undefined ? storableDraft(input.definition) : emptyDefinition((input.triggerType as TriggerType | null) ?? "contact.created");
  return withSystem(async (db) => {
    await assertFolder(db, actor.orgId, input.folderId);
    const count = await db.query<{ n: number }>("select count(*)::int as n from crm_workflows where org_id = $1 and archived_at is null", [actor.orgId]);
    if (count.rows[0].n >= 500) throw new AppError("conflict", "This workspace has 500 workflows. Archive some before adding more.");
    const key = await uniqueKey(db, actor.orgId, name);
    const { rows } = await db.query<{ id: string }>(
      "insert into crm_workflows (org_id, key, name, description, folder_id, draft, created_by, updated_by) values ($1, $2, $3, $4, $5, $6, $7, $7) returning id",
      [actor.orgId, key, name, description, input.folderId || null, JSON.stringify(draft), actor.userId],
    );
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.workflow_created", targetType: "crm_workflow", targetId: rows[0].id, result: "success", metadata: { key, trigger: draft.trigger.type } }, db);
    return { id: rows[0].id, key };
  });
}

/**
 * Saves the editor's working copy. `expectedRevision` is the revision the editor loaded: when someone else saved in between, nothing is
 * overwritten and the save is refused. Returns the new revision and the draft's problems (which don't stop saving, only publishing).
 */
export async function saveWorkflowDraft(actor: CrmActor, id: string, input: { definition: unknown; expectedRevision: number }): Promise<{ revision: number; issues: ValidationIssue[]; draftHash: string | null }> {
  assertCan(actor, "workflows.manage", "Changing automations needs the automations permission.");
  if (!UUID.test(id)) throw notFound();
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) throw new AppError("invalid_input", "Reload the workflow and try again.");
  const draft = storableDraft(input.definition);
  return withSystem(async (db) => {
    const { rows } = await db.query<{ draft_revision: number }>(
      "update crm_workflows set draft = $3, draft_revision = draft_revision + 1, updated_by = $4 where id = $1 and org_id = $2 and draft_revision = $5 and status <> 'archived' returning draft_revision",
      [id, actor.orgId, JSON.stringify(draft), actor.userId, input.expectedRevision],
    );
    if (!rows[0]) {
      const w = (await db.query<{ status: string }>("select status from crm_workflows where id = $1 and org_id = $2", [id, actor.orgId])).rows[0];
      if (!w) throw notFound();
      if (w.status === "archived") throw new AppError("conflict", "This workflow is archived. Restore it to edit it.");
      throw new AppError("conflict", "Someone else saved this workflow since you opened it. Reload to see their changes before saving yours.");
    }
    return { revision: rows[0].draft_revision, issues: validateDefinition(draft, await loadValidationContext(db, actor.orgId)), draftHash: draftHashOf(draft) };
  });
}

export async function updateWorkflowSettings(actor: CrmActor, id: string, input: { name?: string; description?: string | null; folderId?: string | null; hourlyRunLimit?: number }): Promise<void> {
  assertCan(actor, "workflows.manage", "Changing automations needs the automations permission.");
  if (!UUID.test(id)) throw notFound();
  const name = input.name !== undefined ? cleanName(input.name) : undefined;
  const description = input.description !== undefined ? cleanDescription(input.description) : undefined;
  if (input.hourlyRunLimit !== undefined && (!Number.isInteger(input.hourlyRunLimit) || input.hourlyRunLimit < 1 || input.hourlyRunLimit > 10_000)) {
    throw new AppError("invalid_input", "The hourly limit is a whole number from 1 to 10,000.");
  }
  await withSystem(async (db) => {
    const w = (await db.query<{ status: string }>("select status from crm_workflows where id = $1 and org_id = $2 for update", [id, actor.orgId])).rows[0];
    if (!w) throw notFound();
    if (w.status === "archived") throw new AppError("conflict", "This workflow is archived. Restore it to change it.");
    if (input.folderId !== undefined) await assertFolder(db, actor.orgId, input.folderId);
    await db.query(
      `update crm_workflows set name = coalesce($3, name), description = case when $4::boolean then $5 else description end,
         folder_id = case when $6::boolean then $7::uuid else folder_id end, hourly_run_limit = coalesce($8, hourly_run_limit), updated_by = $9
       where id = $1 and org_id = $2`,
      [id, actor.orgId, name ?? null, description !== undefined, description ?? null, input.folderId !== undefined, input.folderId || null, input.hourlyRunLimit ?? null, actor.userId],
    );
    await recordAudit({
      orgId: actor.orgId, ...auditActor(actor), action: "crm.workflow_settings_updated", targetType: "crm_workflow", targetId: id, result: "success",
      metadata: { name: name ?? null, folderChanged: input.folderId !== undefined, hourlyRunLimit: input.hourlyRunLimit ?? null },
    }, db);
  });
}

export const moveWorkflowToFolder = (actor: CrmActor, id: string, folderId: string | null) => updateWorkflowSettings(actor, id, { folderId });

/** A copy of the workflow's working copy as a new draft (never its versions, approvals or runs). An inbound URL gets a new nonce. */
export async function cloneWorkflow(actor: CrmActor, id: string, input: { name?: string } = {}): Promise<{ id: string; key: string }> {
  assertCan(actor, "workflows.manage", "Building automations needs the automations permission.");
  if (!UUID.test(id)) throw notFound();
  return withSystem(async (db) => {
    const w = (await db.query<WorkflowRow>("select * from crm_workflows where id = $1 and org_id = $2", [id, actor.orgId])).rows[0];
    if (!w) throw notFound();
    const name = input.name !== undefined ? cleanName(input.name) : `Copy of ${w.name}`.slice(0, 80);
    const draft = storedDraft(w.draft);
    const copy: WorkflowDefinition = JSON.parse(JSON.stringify(draft));
    if (copy.trigger?.inbound) copy.trigger.inbound = { ...copy.trigger.inbound, nonce: newNonce() };
    const key = await uniqueKey(db, actor.orgId, name);
    const { rows } = await db.query<{ id: string }>(
      "insert into crm_workflows (org_id, key, name, description, folder_id, draft, hourly_run_limit, created_by, updated_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $8) returning id",
      [actor.orgId, key, name, w.description, w.folder_id, JSON.stringify(copy), w.hourly_run_limit, actor.userId],
    );
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.workflow_cloned", targetType: "crm_workflow", targetId: rows[0].id, result: "success", metadata: { from: id } }, db);
    return { id: rows[0].id, key };
  });
}

// ---------------------------------------------------------------------------
// Publishing and approval
// ---------------------------------------------------------------------------

export interface PublishResult {
  versionId: string;
  version: number;
  /** False when the draft is identical to the published version (nothing new was frozen). */
  created: boolean;
  effects: WorkflowEffect[];
  contentHash: string;
  /** The version messages customers or calls outside systems and an owner hasn't approved it yet. */
  needsApproval: boolean;
  approval: ApprovalState;
  status: WorkflowStatus;
  /** The workflow was on, and stays held until the new version is approved. */
  pausedForApproval: boolean;
  /** Warnings that didn't stop publishing. */
  warnings: ValidationIssue[];
}

/** Withdraws pending activation requests for this workflow's older versions: nobody should approve content that no longer runs. */
async function withdrawStaleActivationRequests(db: Queryable, orgId: string, workflowId: string, keepVersionId: string | null, actorUserId: string | null, note: string) {
  const { rows } = await db.query<{ id: string }>(
    `update approval_requests a set status = 'cancelled' from crm_workflow_versions v
     where a.org_id = $1 and a.kind = 'workflow_activation' and a.status = 'pending' and a.target_type = 'crm_workflow_version' and a.target_id = v.id::text
       and v.workflow_id = $2 and v.org_id = $1 and ($3::uuid is null or v.id <> $3)
     returning a.id`,
    [orgId, workflowId, keepVersionId],
  );
  for (const r of rows) {
    await db.query("insert into approval_events (approval_id, org_id, actor_user_id, actor_kind, event, note) values ($1, $2, $3, $4, 'cancelled', $5)", [r.id, orgId, actorUserId, actorUserId ? "user" : "system", note]);
  }
}

/**
 * Freezes the working copy into a new version and makes it the published one. Refused while the draft has errors (checked against the
 * workspace as it is now: tags, fields, stages, people, approved templates, verified n8n automations, active webhooks, rules). When the new
 * version can message customers or call outside systems, it needs an owner's approval of exactly this content before it runs; a workflow
 * that was on is held (paused) until then. Publishing an unchanged draft creates nothing.
 */
export async function publishWorkflow(actor: CrmActor, id: string, input: { expectedRevision?: number } = {}): Promise<PublishResult> {
  assertCan(actor, "workflows.manage", "Publishing automations needs the automations permission.");
  if (!UUID.test(id)) throw notFound();
  return withSystem(async (db) => {
    const w = (await db.query<WorkflowRow>("select * from crm_workflows where id = $1 and org_id = $2 for update", [id, actor.orgId])).rows[0];
    if (!w) throw notFound();
    if (w.status === "archived") throw new AppError("conflict", "This workflow is archived. Restore it to publish it.");
    if (input.expectedRevision !== undefined && input.expectedRevision !== w.draft_revision) {
      throw new AppError("conflict", "Someone else saved this workflow since you opened it. Reload, check their changes, then publish.");
    }
    const { issues, definition } = await validateForPublish(db, actor.orgId, w.draft);
    const errors = issues.filter((i) => i.level === "error");
    if (!definition || errors.length) {
      throw new AppError("invalid_input", errors.length === 1 ? `Fix this before publishing: ${errors[0].message}` : `Fix ${errors.length} problems before publishing. First: ${errors[0]?.message ?? "the workflow can't be read."}`);
    }
    // The workflow will act as the workspace: it can't be given more than the person publishing it may do.
    assertMayRunDefinition(actor, definition, "Publishing");
    const hash = definitionHash(definition);
    const effects = deriveEffects(definition);
    const now = new Date();
    if (w.published_version_id) {
      const cur = (await db.query<VersionRow & { approval_status: string | null; approval_expires_at: Date | null }>(
        `select ${VERSION_COLUMNS}, a.status as approval_status, a.expires_at as approval_expires_at from crm_workflow_versions v
         left join approval_requests a on a.id = v.approval_id and a.org_id = v.org_id where v.id = $1 and v.org_id = $2`,
        [w.published_version_id, actor.orgId],
      )).rows[0];
      if (cur && cur.content_hash === hash) {
        const approval = approvalStateOf(cur, cur.approval_status ? { status: cur.approval_status, expires_at: cur.approval_expires_at } : null, now);
        return {
          versionId: cur.id, version: cur.version, created: false, effects: cur.effects as WorkflowEffect[], contentHash: hash, needsApproval: approval !== "approved" && approval !== "not_needed",
          approval, status: w.status, pausedForApproval: false, warnings: issues.filter((i) => i.level === "warning"),
        };
      }
    }
    const next = (await db.query<{ n: number }>("select coalesce(max(version), 0) + 1 as n from crm_workflow_versions where workflow_id = $1 and org_id = $2", [id, actor.orgId])).rows[0].n;
    const { rows } = await db.query<{ id: string }>(
      `insert into crm_workflow_versions (org_id, workflow_id, version, trigger_config, steps, effects, content_hash, published_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [actor.orgId, id, next, JSON.stringify(definition.trigger), JSON.stringify(definition.steps), effects, hash, actor.userId],
    );
    const versionId = rows[0].id;
    const needsApproval = needsOwnerApproval(effects);
    const pausedForApproval = needsApproval && w.status === "active";
    const status: WorkflowStatus = pausedForApproval ? "paused" : w.status;
    await db.query("update crm_workflows set published_version_id = $3, status = $4, updated_by = $5 where id = $1 and org_id = $2", [id, actor.orgId, versionId, status, actor.userId]);
    await withdrawStaleActivationRequests(db, actor.orgId, id, versionId, actor.userId, `Version ${next} was published, so this request no longer applies.`);
    await recordAudit({
      orgId: actor.orgId, ...auditActor(actor), action: "crm.workflow_published", targetType: "crm_workflow", targetId: id, result: "success",
      metadata: { versionId, version: next, contentHash: hash, effects, needsApproval, pausedForApproval },
    }, db);
    return {
      versionId, version: next, created: true, effects, contentHash: hash, needsApproval, approval: needsApproval ? "needed" : "not_needed", status, pausedForApproval,
      warnings: issues.filter((i) => i.level === "warning"),
    };
  });
}

/** In words, for the owner deciding: what the version does outside the CRM, step by step. */
async function describeEffects(db: Queryable, orgId: string, steps: WorkflowStep[]): Promise<string[]> {
  const out: string[] = [];
  for (const s of steps) {
    if (s.kind === "send_message") {
      const c = s.config as SendMessageConfig;
      const t = (await db.query<{ name: string }>("select name from crm_message_templates where id = $1 and org_id = $2", [c.templateId, orgId])).rows[0];
      out.push(`Sends the ${c.channel === "sms" ? "SMS" : c.channel === "whatsapp" ? "WhatsApp" : "email"} template "${t?.name ?? "a template"}" (its approved wording) as the ${c.sendAs.replace(/_/g, " ")}.`);
    } else if (s.kind === "request_review") {
      const c = s.config as { templateId: string; channel: string };
      const t = (await db.query<{ name: string }>("select name from crm_message_templates where id = $1 and org_id = $2", [c.templateId, orgId])).rows[0];
      out.push(`Asks the contact for a review with the ${c.channel === "sms" ? "SMS" : c.channel === "whatsapp" ? "WhatsApp" : "email"} template "${t?.name ?? "a template"}" (its approved wording), only if they agreed to messages on that channel.`);
    } else if (s.kind === "webhook") {
      const h = (await db.query<{ name: string }>("select name from crm_webhook_subscriptions where id = $1 and org_id = $2", [(s.config as { subscriptionId: string }).subscriptionId, orgId])).rows[0];
      out.push(`Sends a signed webhook to "${h?.name ?? "an endpoint"}"${(s.config as { includeContact: boolean }).includeContact ? " with the contact's name, email and phone" : ""}.`);
    } else if (s.kind === "n8n") {
      out.push(`Starts an agency-verified n8n automation${(s.config as { includeContact: boolean }).includeContact ? " with the contact's name, email and phone" : ""}.`);
    } else if (s.kind === "ai_task") {
      out.push(`Asks the ${(s.config as { roleKey: string }).roleKey.replace(/_/g, " ")} to: "${(s.config as { instruction: string }).instruction.slice(0, 120)}".`);
    }
  }
  return out;
}

export interface ApprovalRequestResult {
  status: "requested" | "pending" | "approved" | "not_needed";
  approvalId: string | null;
}

/**
 * Asks the workspace owner to approve the published version (its exact content). With `activate`, approving also switches the workflow
 * on. Only the owner decides (high risk); a pending request for the same version is reused.
 */
export async function requestWorkflowApproval(actor: CrmActor, workflowId: string, versionId?: string | null, opts: { activate?: boolean } = {}): Promise<ApprovalRequestResult> {
  assertCan(actor, "workflows.manage", "Requesting approval needs the automations permission.");
  if (!UUID.test(workflowId) || (versionId && !UUID.test(versionId))) throw notFound();
  return withSystem(async (db) => {
    const w = (await db.query<WorkflowRow>("select * from crm_workflows where id = $1 and org_id = $2 for update", [workflowId, actor.orgId])).rows[0];
    if (!w) throw notFound();
    if (w.status === "archived") throw new AppError("conflict", "This workflow is archived. Restore it first.");
    if (!w.published_version_id) throw new AppError("conflict", "Publish the workflow first. The owner approves a published version.");
    if (versionId && versionId !== w.published_version_id) throw new AppError("conflict", "Only the version that is published now can be approved. Open the latest version.");
    const v = (await db.query<VersionRow & { approval_status: string | null; approval_expires_at: Date | null }>(
      `select ${VERSION_COLUMNS}, a.status as approval_status, a.expires_at as approval_expires_at from crm_workflow_versions v
       left join approval_requests a on a.id = v.approval_id and a.org_id = v.org_id where v.id = $1 and v.org_id = $2 for update of v`,
      [w.published_version_id, actor.orgId],
    )).rows[0];
    const state = approvalStateOf(v, v.approval_status ? { status: v.approval_status, expires_at: v.approval_expires_at } : null);
    if (state === "not_needed") return { status: "not_needed", approvalId: null };
    if (state === "approved") return { status: "approved", approvalId: v.approval_id };
    if (state === "pending") return { status: "pending", approvalId: v.approval_id };
    // The owner is shown the version's outside effects; what it does inside the CRM must already be within the requester's own access.
    assertMayRunDefinition(actor, { trigger: v.trigger_config, steps: v.steps }, "Asking for approval of");
    const prior = (await db.query<{ n: number }>("select count(*)::int as n from approval_requests where org_id = $1 and target_type = 'crm_workflow_version' and target_id = $2", [actor.orgId, v.id])).rows[0].n;
    const trigger = TRIGGERS[v.trigger_config.type]?.label ?? v.trigger_config.type;
    const lines = await describeEffects(db, actor.orgId, v.steps);
    const effects = (v.effects as WorkflowEffect[]).map((e) => EFFECT_LABELS[e]).join("; ");
    const approvalId = await createApproval(db, {
      orgId: actor.orgId, requestedBy: actor.userId, kind: "workflow_activation", risk: "high", actorKind: actor.kind === "member" || actor.kind === "agency" ? "user" : "system",
      title: `${opts.activate ? "Turn on" : "Approve"} workflow "${w.name}" (version ${v.version})`.slice(0, 200),
      action: { workflowId: w.id, versionId: v.id, version: v.version, contentHash: v.content_hash, effects: v.effects, activate: opts.activate === true },
      targetType: "crm_workflow_version", targetId: v.id, targetLabel: w.name,
      reason: `${actor.label} asked for approval of version ${v.version}. ${effects}.`.slice(0, 2000),
      expectedEffect: [
        `When "${trigger}" happens, this workflow runs its ${v.steps.length} step${v.steps.length === 1 ? "" : "s"}.`,
        ...lines,
        "Every message still goes through consent, opt-outs, quiet hours, frequency limits and credits when it is sent. Any change to the workflow creates a new version that needs approval again.",
      ].join(" ").slice(0, 2000),
      idempotencyKey: `wf-activation:${v.id}:${prior + 1}`,
    });
    if (!approvalId) throw new AppError("conflict", "An approval was just requested for this version. Reload to see it.");
    await db.query("update crm_workflow_versions set approval_id = $2 where id = $1", [v.id, approvalId]);
    await notifyOrgRoles(db, actor.orgId, ["owner"], {
      kind: "approval_requested", severity: "info", title: `Workflow "${w.name}" needs your approval`.slice(0, 200),
      body: `Version ${v.version}: ${effects}.`, link: "/approvals", dedupeKey: `wf-activation:${approvalId}`,
    });
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.workflow_approval_requested", targetType: "crm_workflow", targetId: w.id, approvalId, result: "success", metadata: { versionId: v.id, version: v.version, activate: opts.activate === true } }, db);
    return { status: "requested", approvalId };
  });
}

// ---------------------------------------------------------------------------
// On, off, archive
// ---------------------------------------------------------------------------

/** Stops a workflow's unfinished runs (archiving), withdrawing step approvals they wait on. */
async function cancelLiveRuns(db: Queryable, orgId: string, workflowId: string, reason: string, actorUserId: string | null): Promise<number> {
  const steps = await db.query<{ approval_id: string | null }>(
    `update crm_workflow_run_steps s set status = 'cancelled', error = $3, finished_at = now() from crm_workflow_runs r
     where s.run_id = r.id and s.org_id = r.org_id and r.workflow_id = $1 and r.org_id = $2 and r.status = any($4::text[]) and s.status in ('waiting', 'awaiting_approval')
     returning s.approval_id`,
    [workflowId, orgId, reason, LIVE_RUN_STATUSES],
  );
  for (const s of steps.rows) {
    if (!s.approval_id) continue;
    const res = await db.query("update approval_requests set status = 'cancelled' where id = $1 and org_id = $2 and status = 'pending'", [s.approval_id, orgId]);
    if (res.rowCount) await db.query("insert into approval_events (approval_id, org_id, actor_user_id, actor_kind, event, note) values ($1, $2, $3, $4, 'cancelled', $5)", [s.approval_id, orgId, actorUserId, actorUserId ? "user" : "system", reason]);
  }
  const runs = await db.query(
    "update crm_workflow_runs set status = 'cancelled', finished_at = now(), claimed_at = null, cancelled_by = $3, last_error = $4 where workflow_id = $1 and org_id = $2 and status = any($5::text[])",
    [workflowId, orgId, actorUserId, reason, LIVE_RUN_STATUSES],
  );
  return runs.rowCount;
}

/**
 * Switches a workflow on (active), off (paused), back to a draft that isn't running (draft, also how an archived one is restored), or
 * archives it. Turning on needs a published version that still validates against the workspace, that iAcquire runs this workspace's
 * automations (not GoHighLevel), and, when it messages customers or calls outside systems, the owner's approval of that exact version.
 * Pausing holds waiting runs; archiving stops them.
 */
export async function setWorkflowStatus(actor: CrmActor, id: string, status: WorkflowStatus): Promise<{ status: WorkflowStatus; cancelledRuns: number }> {
  assertCan(actor, "workflows.manage", "Turning automations on or off needs the automations permission.");
  if (!UUID.test(id)) throw notFound();
  if (!["draft", "active", "paused", "archived"].includes(status)) throw new AppError("invalid_input", "Choose on, paused or archived.");
  return withSystem(async (db) => {
    const w = (await db.query<WorkflowRow>("select * from crm_workflows where id = $1 and org_id = $2 for update", [id, actor.orgId])).rows[0];
    if (!w) throw notFound();
    if (w.status === status) return { status, cancelledRuns: 0 };
    let cancelledRuns = 0;
    if (status === "active") {
      if (w.status === "archived") throw new AppError("conflict", "Restore this workflow before turning it on.");
      if (!w.published_version_id) throw new AppError("conflict", "Publish the workflow before turning it on.");
      await assertNativeOwner(db, actor.orgId, "workflows");
      const v = (await db.query<VersionRow & { approval_status: string | null; approval_expires_at: Date | null }>(
        `select ${VERSION_COLUMNS}, a.status as approval_status, a.expires_at as approval_expires_at from crm_workflow_versions v
         left join approval_requests a on a.id = v.approval_id and a.org_id = v.org_id where v.id = $1 and v.org_id = $2`,
        [w.published_version_id, actor.orgId],
      )).rows[0];
      const state = approvalStateOf(v, v.approval_status ? { status: v.approval_status, expires_at: v.approval_expires_at } : null);
      if (state !== "approved" && state !== "not_needed") {
        throw new AppError("conflict", state === "pending"
          ? `Version ${v.version} is waiting for the owner's approval. It can be turned on once it is approved.`
          : `Version ${v.version} messages customers or calls outside systems, so the owner must approve it before it runs. Request approval first.`);
      }
      const problems = validateDefinition({ trigger: v.trigger_config, steps: v.steps }, await loadValidationContext(db, actor.orgId)).filter((i) => i.level === "error");
      if (problems.length) throw new AppError("conflict", `Something this workflow uses changed since it was published: ${problems[0].message} Edit and publish it again.`);
      assertMayRunDefinition(actor, { trigger: v.trigger_config, steps: v.steps }, "Turning on");
    } else if (status === "paused") {
      if (w.status !== "active") throw new AppError("conflict", "Only a workflow that is on can be paused.");
    } else if (status === "draft") {
      if (w.status === "archived") {
        const keyTaken = await db.query("select 1 from crm_workflows where org_id = $1 and key = $2 and archived_at is null and id <> $3", [actor.orgId, w.key, id]);
        if (keyTaken.rows[0]) await db.query("update crm_workflows set key = $2 where id = $1", [id, await uniqueKey(db, actor.orgId, w.name, id)]);
      }
    } else if (status === "archived") {
      cancelledRuns = await cancelLiveRuns(db, actor.orgId, id, "The workflow was archived.", actor.kind === "member" || actor.kind === "agency" ? actor.userId : null);
      await withdrawStaleActivationRequests(db, actor.orgId, id, null, actor.userId, "The workflow was archived.");
    }
    await db.query(
      "update crm_workflows set status = $3, archived_at = case when $3 = 'archived' then now() else null end, updated_by = $4 where id = $1 and org_id = $2",
      [id, actor.orgId, status, actor.userId],
    );
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.workflow_status_changed", targetType: "crm_workflow", targetId: id, result: "success", metadata: { from: w.status, to: status, cancelledRuns } }, db);
    return { status, cancelledRuns };
  });
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export interface WorkflowTemplateView {
  key: string;
  name: string;
  description: string;
  trigger: TriggerType;
  triggerLabel: string;
  /** The trigger's group, as a category for the gallery. */
  category: string;
  /** True: always sends a message (an approved template the user picks); "optional": only when one is picked. */
  sendsMessages: boolean | "optional";
  stepKinds: string[];
  inputs: TemplateInputSpec[];
}

export function listWorkflowTemplates(): WorkflowTemplateView[] {
  return WORKFLOW_TEMPLATES.map((t) => {
    const def = t.build({});
    return {
      key: t.key, name: t.name, description: t.description, trigger: t.trigger, triggerLabel: TRIGGERS[t.trigger].label, category: TRIGGERS[t.trigger].group,
      sendsMessages: t.sendsMessages, stepKinds: def.steps.map((s) => s.kind), inputs: t.inputs,
    };
  });
}

/**
 * Creates a draft from a built-in template with the workspace's own choices. Every choice is checked against the workspace (a message
 * template must be approved; its approved wording is looked up here, never taken from the request). Required choices must be made: a
 * template that sends messages only ever sends the approved template the user picked.
 */
export async function createFromTemplate(actor: CrmActor, key: string, input: { name?: string; folderId?: string | null; inputs?: Record<string, unknown> } = {}): Promise<{ id: string; key: string; issues: ValidationIssue[] }> {
  assertCan(actor, "workflows.manage", "Building automations needs the automations permission.");
  const template = workflowTemplate(key);
  if (!template) throw new AppError("not_found", "That template doesn't exist.");
  const name = cleanName(input.name ?? template.name);
  const raw = input.inputs ?? {};
  const options = await withSystem((db) => loadBuilderOptions(db, actor.orgId));
  const values: TemplateInputs = {};
  for (const spec of template.inputs) {
    const v = raw[spec.key];
    const empty = v === undefined || v === null || v === "";
    if (empty) {
      if (spec.required) throw new AppError("invalid_input", `${spec.label}: choose one.`);
      continue;
    }
    values[spec.key] = resolveTemplateInput(spec, v, options);
  }
  const definition = template.build(values);
  const issues = validateDefinition(definition, validationContextFrom(options));
  const created = await createWorkflow(actor, { name, folderId: input.folderId ?? null, definition, description: template.description });
  return { ...created, issues };
}

function resolveTemplateInput(spec: TemplateInputSpec, v: unknown, o: WorkflowBuilderOptions): string | StageChoice | MessageChoice {
  const id = (x: unknown) => (typeof x === "string" && UUID.test(x) ? x : null);
  const bad = (what: string): never => {
    throw new AppError("invalid_input", `${spec.label}: ${what}`);
  };
  switch (spec.kind) {
    case "tag":
      return o.tags.some((t) => t.id === id(v)) ? (v as string) : bad("that tag doesn't exist.");
    case "user":
      return o.users.some((u) => u.id === id(v)) ? (v as string) : bad("that person isn't in this workspace or can't see contacts.");
    case "pipeline":
      return o.pipelines.some((p) => p.id === id(v)) ? (v as string) : bad("that pipeline doesn't exist.");
    case "stage":
    case "open_stage": {
      const s = v && typeof v === "object" ? (v as { pipelineId?: unknown; stageId?: unknown }) : {};
      const pipe = o.pipelines.find((p) => p.id === id(s.pipelineId));
      const stage = pipe?.stages.find((x) => x.id === id(s.stageId));
      if (!pipe || !stage) return bad("choose a stage of one of your pipelines.");
      if (spec.kind === "open_stage" && stage.kind !== "open") return bad("choose an open stage.");
      return { pipelineId: pipe.id, stageId: stage.id };
    }
    case "message_template": {
      const templateId = typeof v === "string" ? v : v && typeof v === "object" ? (v as { templateId?: unknown }).templateId : null;
      const t = o.templates.find((x) => x.id === id(templateId));
      if (!t) return bad("that message template isn't approved for automated messages.");
      return { templateId: t.id, contentHash: t.contentHash, channel: t.channel };
    }
  }
  return bad("not a valid choice.");
}
