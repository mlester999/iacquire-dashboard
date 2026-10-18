import "server-only";
import { z } from "zod";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyAgency } from "@/server/notifications";
import type { SessionUser } from "@/server/auth/service";
import { runChecks } from "@/server/setup/automation";
import {
  assertAgencyAccess,
  clientTitle,
  loadCheckStatuses,
  loadRuleTasks,
  lockAgencySetupAccess,
  mutateSetup,
  recordSetupEvent,
  syncSetupApplicability,
  TASK_COLUMNS,
  type InstanceRow,
  type TaskRow,
} from "@/server/setup/core";
import { applyTransition } from "@/server/setup/transition";
import { setupDate, setupHttpsUrl } from "@/server/setup/validation";
import { removePrivateFile } from "@/server/storage/private";
import { evaluateReadiness, isApplicable, SETUP_SERVICE_KEYS, TASK_STATUSES, unmetDependencies, type Section } from "@/lib/setup";

const text = (max: number) => z.string().trim().max(max);
const httpsUrl = setupHttpsUrl;
const uuid = z.string().uuid();
const dateOnly = setupDate;

async function loadTask(db: Queryable, orgId: string, taskId: string): Promise<TaskRow> {
  const { rows } = await db.query<TaskRow>(`select ${TASK_COLUMNS} from client_setup_tasks t where t.id = $1 and t.org_id = $2`, [taskId, orgId]);
  if (!rows[0]) throw new AppError("not_found", "That setup step wasn't found.");
  return rows[0];
}

const MANAGED_BY_REVIEW = "This step is managed by the final review and activation controls.";

function agencyMutation<T>(admin: SessionUser, orgId: string, fn: (db: Queryable, inst: InstanceRow, h: import("@/server/setup/core").TxHelpers) => Promise<T>) {
  return mutateSetup(orgId, async (db,inst,h) => { await lockAgencySetupAccess(db,admin,orgId); return fn(db,inst,h); });
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export const statusSchema = z.object({
  status: z.enum(TASK_STATUSES),
  /** Shown to the client: a completion note, what is needed, or why the step is blocked. */
  note: text(2000).optional().default(""),
  /** Staff only. Required when reopening a completed step. */
  reason: text(2000).optional().default(""),
  evidenceUrl: z.union([z.literal(""), httpsUrl]).optional().default(""),
  notifyClient: z.boolean().optional().default(true),
});

export async function updateTaskStatus(admin: SessionUser, orgId: string, taskId: string, input: z.input<typeof statusSchema>) {
  await assertAgencyAccess(admin, orgId);
  const data = statusSchema.parse(input);
  return agencyMutation(admin, orgId, async (db, inst, h) => {
    const task = await loadTask(db, orgId, taskId);
    if (task.completion_mode === "activation") throw new AppError("invalid_input", MANAGED_BY_REVIEW);
    if (data.status === "completed" && task.completion_mode === "verified") {
      throw new AppError(
        "invalid_input",
        "This step is completed by a system check, not by changing its status. Use Verify now, or record an attestation if the portal can't check it yet.",
      );
    }
    if (data.status === "waiting_for_client" && !data.note && !task.client_note && !task.client_action) {
      throw new AppError("invalid_input", "Tell the client what you need from them.");
    }
    if (data.evidenceUrl && data.status === "completed") {
      await db.query(
        "insert into client_setup_task_attachments (org_id, task_id, label, url, kind, visibility, created_by) values ($1, $2, 'Completion evidence', $3, 'evidence', 'internal', $4)",
        [orgId, taskId, data.evidenceUrl, admin.id],
      );
    }
    await applyTransition(db, h, inst, {
      task,
      to: data.status,
      actor: { userId: admin.id, kind: "agency" },
      clientText: data.note || null,
      internalReason: data.reason || null,
      source: data.status === "completed" ? "agency" : undefined,
      notify: data.notifyClient,
    });
    return { taskId };
  });
}

// ---------------------------------------------------------------------------
// Details, assignment, estimates
// ---------------------------------------------------------------------------

export const detailsSchema = z.object({
  title: text(160).min(1).optional(),
  clientTitle: z.union([text(160), z.null()]).optional(),
  description: text(600).optional(),
  required: z.boolean().optional(),
  requiresEvidence: z.boolean().optional(),
  assignedTo: z.union([uuid, z.null()]).optional(),
  estimatedCompletionAt: z.union([dateOnly, z.null()]).optional(),
});

async function assertAssignable(db: Queryable, orgId: string, userId: string) {
  const { rows } = await db.query(
    `select 1 from users u where u.id = $1 and u.status = 'active'
       and u.platform_role in ('agency_super_admin','agency_manager','agency_staff')
       and app.user_can_access_org(u.id,$2)`,
    [userId, orgId],
  );
  if (!rows.length) throw new AppError("invalid_input", "Choose an agency team member who has access to this client.");
}

export async function updateTaskDetails(admin: SessionUser, orgId: string, taskId: string, input: z.input<typeof detailsSchema>) {
  await assertAgencyAccess(admin, orgId);
  const data = detailsSchema.parse(input);
  return agencyMutation(admin, orgId, async (db, inst) => {
    const task = await loadTask(db, orgId, taskId);
    const sets: string[] = [];
    const params: unknown[] = [taskId, orgId, admin.id];
    const add = (col: string, value: unknown) => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };
    const changed: string[] = [];
    if (data.title !== undefined) {
      if (task.template_key) throw new AppError("invalid_input", "Built-in steps keep their name. Set a client-facing title instead.");
      add("title", data.title);
      changed.push("title");
    }
    if (data.clientTitle !== undefined) {
      add("client_title", data.clientTitle?.trim() || null);
      changed.push("clientTitle");
    }
    if (data.description !== undefined) {
      add("description", data.description);
      changed.push("description");
    }
    if (data.requiresEvidence !== undefined) {
      add("requires_evidence", data.requiresEvidence);
      changed.push("requiresEvidence");
    }
    if (data.required !== undefined) {
      if (task.completion_mode === "activation" && !data.required) throw new AppError("invalid_input", "Final activation is always required.");
      add("required", data.required);
      // A step can only be hidden while optional, so making it required brings it back.
      if (data.required && task.hidden) sets.push("hidden = false");
      changed.push("required");
    }
    if (data.estimatedCompletionAt !== undefined) {
      add("estimated_completion_at", data.estimatedCompletionAt);
      changed.push("estimate");
    }
    if (data.assignedTo !== undefined) {
      if (data.assignedTo) await assertAssignable(db, orgId, data.assignedTo);
      add("assigned_to", data.assignedTo);
    }
    if (!sets.length) return { taskId };
    await db.query(`update client_setup_tasks set ${sets.join(", ")}, updated_by = $3 where id = $1 and org_id = $2`, params);
    if (data.assignedTo !== undefined) {
      await recordSetupEvent(db, { orgId, instanceId: inst.id, taskId, actorUserId: admin.id, actorKind: "agency", event: "assigned", visibility: "internal", metadata: { assignedTo: data.assignedTo } });
    }
    if (changed.length) {
      await recordSetupEvent(db, { orgId, instanceId: inst.id, taskId, actorUserId: admin.id, actorKind: "agency", event: "details_changed", visibility: "internal", metadata: { fields: changed } });
      await recordAudit({ orgId, actorUserId: admin.id, actorKind: "agency", action: "setup.task_updated", targetType: "setup_task", targetId: taskId, result: "success", metadata: { fields: changed } }, db);
    }
    return { taskId };
  });
}

// ---------------------------------------------------------------------------
// Asking the client for something
// ---------------------------------------------------------------------------

export const requestSchema = z.object({
  type: z.enum(["approve", "review_and_approve", "provide_info", "external"]),
  label: text(120).min(2, "Give the request a short title."),
  instructions: text(1000).min(5, "Tell the client what to do."),
  requireResponse: z.boolean().optional().default(true),
  notifyClient: z.boolean().optional().default(true),
});

export async function requestClientAction(admin: SessionUser, orgId: string, taskId: string, input: z.input<typeof requestSchema>) {
  await assertAgencyAccess(admin, orgId);
  const data = requestSchema.parse(input);
  return agencyMutation(admin, orgId, async (db, inst, h) => {
    const task = await loadTask(db, orgId, taskId);
    if (task.completion_mode === "activation") throw new AppError("invalid_input", MANAGED_BY_REVIEW);
    if (task.status === "completed") throw new AppError("invalid_input", "Reopen this step before asking the client for something.");
    const action = { type: data.type, label: data.label, instructions: data.instructions };
    await db.query(
      `update client_setup_tasks set client_action = $3, requires_client_response = $4, client_response = null, client_responded_at = null,
         client_responded_by = null, updated_by = $5 where id = $1 and org_id = $2`,
      [taskId, orgId, JSON.stringify(action), data.requireResponse, admin.id],
    );
    const fresh = { ...task, client_action: action, requires_client_response: data.requireResponse, client_responded_at: null };
    if (task.status === "waiting_for_client") {
      await db.query("update client_setup_tasks set client_note = $3 where id = $1 and org_id = $2", [taskId, orgId, data.instructions]);
      await recordSetupEvent(db, { orgId, instanceId: inst.id, taskId, actorUserId: admin.id, actorKind: "agency", event: "client_requested", body: data.instructions, visibility: "client", metadata: { type: data.type } });
      if (data.notifyClient) {
        await h.notifyClient({ kind: "setup_action_required", severity: "warning", title: `Action needed: ${data.label}`, body: data.instructions, link: "/setup" });
      }
    } else {
      await applyTransition(db, h, inst, { task: fresh, to: "waiting_for_client", actor: { userId: admin.id, kind: "agency" }, clientText: data.instructions, notify: data.notifyClient });
      await recordSetupEvent(db, { orgId, instanceId: inst.id, taskId, actorUserId: admin.id, actorKind: "agency", event: "client_requested", visibility: "internal", metadata: { type: data.type } });
    }
    await recordAudit({ orgId, actorUserId: admin.id, actorKind: "agency", action: "setup.client_requested", targetType: "setup_task", targetId: taskId, result: "success", metadata: { type: data.type } }, db);
    return { taskId };
  });
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export const noteSchema = z.object({
  body: text(2000),
  visibility: z.enum(["internal", "client"]),
  notifyClient: z.boolean().optional().default(false),
});

/** Internal notes are staff-only. A client-visible note replaces the message shown on the client's card. */
export async function addTaskNote(admin: SessionUser, orgId: string, taskId: string, input: z.input<typeof noteSchema>) {
  await assertAgencyAccess(admin, orgId);
  const data = noteSchema.parse(input);
  if (data.visibility === "internal" && !data.body) throw new AppError("invalid_input", "Write a note first.");
  return agencyMutation(admin, orgId, async (db, inst, h) => {
    const task = await loadTask(db, orgId, taskId);
    if (data.visibility === "internal") {
      await recordSetupEvent(db, { orgId, instanceId: inst.id, taskId, actorUserId: admin.id, actorKind: "agency", event: "note", reason: data.body, visibility: "internal" });
      return { taskId };
    }
    await db.query("update client_setup_tasks set client_note = $3, updated_by = $4 where id = $1 and org_id = $2", [taskId, orgId, data.body || null, admin.id]);
    if (data.body) {
      await recordSetupEvent(db, { orgId, instanceId: inst.id, taskId, actorUserId: admin.id, actorKind: "agency", event: "note", body: data.body, visibility: "client" });
      if (data.notifyClient && isApplicable({ hidden: task.hidden, serviceExcluded: task.service_excluded })) {
        await h.notifyClient({ kind: "setup_milestone", severity: "info", title: `Update on ${clientTitle(task)}`, body: data.body, link: "/setup" });
      }
    }
    return { taskId };
  });
}

// ---------------------------------------------------------------------------
// Custom tasks, order, visibility, dependencies
// ---------------------------------------------------------------------------

export const customTaskSchema = z.object({
  title: text(160).min(2, "Give the step a name."),
  description: text(600).optional().default(""),
  section: z.enum(["agency", "client"]).default("agency"),
  required: z.boolean().optional().default(true),
  assignedTo: z.union([uuid, z.null()]).optional().default(null),
  estimatedCompletionAt: z.union([dateOnly, z.null()]).optional().default(null),
  dependsOn: z.array(uuid).max(20).optional().default([]),
});

function wouldCycle(edges: Map<string, string[]>, taskId: string, newDeps: string[]): boolean {
  const seen = new Set<string>();
  const stack = [...newDeps];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === taskId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(edges.get(id) ?? []));
  }
  return false;
}

async function loadEdges(db: Queryable, orgId: string) {
  const { rows } = await db.query<{ task_id: string; depends_on_task_id: string }>("select task_id, depends_on_task_id from client_setup_task_dependencies where org_id = $1", [orgId]);
  const edges = new Map<string, string[]>();
  for (const r of rows) edges.set(r.task_id, [...(edges.get(r.task_id) ?? []), r.depends_on_task_id]);
  return edges;
}

async function assertDepsInOrg(db: Queryable, orgId: string, ids: string[]) {
  if (!ids.length) return;
  const { rows } = await db.query<{ n: number }>("select count(*)::int as n from client_setup_tasks where org_id = $1 and id = any($2::uuid[])", [orgId, ids]);
  if (rows[0].n !== new Set(ids).size) throw new AppError("invalid_input", "One of the selected prerequisites doesn't belong to this client.");
}

export async function createCustomTask(admin: SessionUser, orgId: string, input: z.input<typeof customTaskSchema>) {
  await assertAgencyAccess(admin, orgId);
  const data = customTaskSchema.parse(input);
  return agencyMutation(admin, orgId, async (db, inst) => {
    if (data.assignedTo) await assertAssignable(db, orgId, data.assignedTo);
    await assertDepsInOrg(db, orgId, data.dependsOn);
    const { rows: max } = await db.query<{ n: number }>("select coalesce(max(sort_order), 0)::int as n from client_setup_tasks where org_id = $1 and section = $2", [orgId, data.section]);
    const { rows } = await db.query<{ id: string }>(
      `insert into client_setup_tasks (org_id, instance_id, title, description, section, completion_mode, required, assigned_to, estimated_completion_at, sort_order, created_by, updated_by)
       values ($1, $2, $3, $4, $5, 'manual', $6, $7, $8, $9, $10, $10) returning id`,
      [orgId, inst.id, data.title, data.description, data.section, data.required, data.assignedTo, data.estimatedCompletionAt, max[0].n + 10, admin.id],
    );
    const id = rows[0].id;
    for (const dep of new Set(data.dependsOn)) {
      await db.query("insert into client_setup_task_dependencies (org_id, task_id, depends_on_task_id) values ($1, $2, $3)", [orgId, id, dep]);
    }
    await recordSetupEvent(db, { orgId, instanceId: inst.id, taskId: id, actorUserId: admin.id, actorKind: "agency", event: "task_created", visibility: "internal" });
    await recordAudit({ orgId, actorUserId: admin.id, actorKind: "agency", action: "setup.task_created", targetType: "setup_task", targetId: id, result: "success" }, db);
    return { taskId: id };
  });
}

/** `orderedIds` is the complete new order of one section (including hidden steps). */
export async function reorderTasks(admin: SessionUser, orgId: string, section: Section, orderedIds: string[]) {
  await assertAgencyAccess(admin, orgId);
  if (!z.array(uuid).max(200).safeParse(orderedIds).success) throw new AppError("invalid_input", "Invalid order.");
  return agencyMutation(admin, orgId, async (db, inst) => {
    const { rows } = await db.query<{ id: string }>("select id from client_setup_tasks where org_id = $1 and section = $2", [orgId, section]);
    const current = new Set(rows.map((r) => r.id));
    if (orderedIds.length !== current.size || new Set(orderedIds).size !== orderedIds.length || orderedIds.some((id) => !current.has(id))) {
      throw new AppError("conflict", "The checklist changed while you were reordering. Refresh and try again.");
    }
    for (let i = 0; i < orderedIds.length; i += 1) {
      await db.query("update client_setup_tasks set sort_order = $3 where id = $1 and org_id = $2", [orderedIds[i], orgId, (i + 1) * 10]);
    }
    await recordSetupEvent(db, { orgId, instanceId: inst.id, actorUserId: admin.id, actorKind: "agency", event: "reordered", visibility: "internal", metadata: { section } });
    await recordAudit({ orgId, actorUserId: admin.id, actorKind: "agency", action: "setup.tasks_reordered", targetType: "setup", targetId: inst.id, result: "success", metadata: { section } }, db);
    return {};
  });
}

export async function setTaskHidden(admin: SessionUser, orgId: string, taskId: string, hidden: boolean) {
  await assertAgencyAccess(admin, orgId);
  return agencyMutation(admin, orgId, async (db, inst) => {
    const task = await loadTask(db, orgId, taskId);
    if (hidden && task.required) throw new AppError("invalid_input", "Required steps can't be hidden. Mark the step optional first.");
    if (task.hidden === hidden) return { taskId };
    await db.query("update client_setup_tasks set hidden = $3, updated_by = $4 where id = $1 and org_id = $2", [taskId, orgId, hidden, admin.id]);
    await recordSetupEvent(db, { orgId, instanceId: inst.id, taskId, actorUserId: admin.id, actorKind: "agency", event: "visibility_changed", visibility: "internal", metadata: { hidden } });
    await recordAudit({ orgId, actorUserId: admin.id, actorKind: "agency", action: "setup.task_visibility_changed", targetType: "setup_task", targetId: taskId, result: "success", metadata: { hidden } }, db);
    return { taskId };
  });
}

export async function setTaskDependencies(admin: SessionUser, orgId: string, taskId: string, dependsOn: string[]) {
  await assertAgencyAccess(admin, orgId);
  if (!z.array(uuid).max(20).safeParse(dependsOn).success) throw new AppError("invalid_input", "Invalid prerequisites.");
  const wanted = [...new Set(dependsOn)];
  return agencyMutation(admin, orgId, async (db, inst) => {
    const task = await loadTask(db, orgId, taskId);
    if (wanted.includes(taskId)) throw new AppError("invalid_input", "A step can't depend on itself.");
    await assertDepsInOrg(db, orgId, wanted);
    const edges = await loadEdges(db, orgId);
    edges.delete(taskId);
    if (wouldCycle(edges, taskId, wanted)) throw new AppError("invalid_input", "That would create a loop: those steps already depend on this one.");
    if (task.status === "completed") {
      const tasks = await loadRuleTasks(db, orgId);
      const byId = new Map(tasks.map((t) => [t.id, t]));
      const unmet = unmetDependencies({ dependsOn: wanted }, byId);
      if (unmet.length) throw new AppError("invalid_input", `This step is already completed. Reopen it before depending on "${unmet[0].title}".`);
    }
    await db.query("delete from client_setup_task_dependencies where task_id = $1 and org_id = $2", [taskId, orgId]);
    for (const dep of wanted) await db.query("insert into client_setup_task_dependencies (org_id, task_id, depends_on_task_id) values ($1, $2, $3)", [orgId, taskId, dep]);
    await recordSetupEvent(db, { orgId, instanceId: inst.id, taskId, actorUserId: admin.id, actorKind: "agency", event: "dependencies_changed", visibility: "internal", metadata: { count: wanted.length } });
    await recordAudit({ orgId, actorUserId: admin.id, actorKind: "agency", action: "setup.dependencies_changed", targetType: "setup_task", targetId: taskId, result: "success", metadata: { count: wanted.length } }, db);
    return { taskId };
  });
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export const attachmentSchema = z.object({
  label: text(120).min(1, "Add a label."),
  url: httpsUrl,
  kind: z.enum(["evidence", "documentation", "website_preview", "instructions"]).default("documentation"),
  visibility: z.enum(["internal", "client"]).default("internal"),
});

export async function addTaskAttachment(admin: SessionUser, orgId: string, taskId: string, input: z.input<typeof attachmentSchema>) {
  await assertAgencyAccess(admin, orgId);
  const data = attachmentSchema.parse(input);
  return agencyMutation(admin, orgId, async (db, inst) => {
    await loadTask(db, orgId, taskId);
    const { rows } = await db.query<{ id: string }>(
      "insert into client_setup_task_attachments (org_id, task_id, label, url, kind, visibility, created_by) values ($1, $2, $3, $4, $5, $6, $7) returning id",
      [orgId, taskId, data.label, data.url, data.kind, data.visibility, admin.id],
    );
    await recordSetupEvent(db, { orgId, instanceId: inst.id, taskId, actorUserId: admin.id, actorKind: "agency", event: "attachment_added", visibility: "internal", metadata: { kind: data.kind, visibility: data.visibility } });
    await recordAudit({ orgId, actorUserId: admin.id, actorKind: "agency", action: "setup.attachment_added", targetType: "setup_task", targetId: taskId, result: "success", metadata: { kind: data.kind } }, db);
    return { attachmentId: rows[0].id };
  });
}

export async function removeTaskAttachment(admin: SessionUser, orgId: string, attachmentId: string) {
  await assertAgencyAccess(admin, orgId);
  const { rows: files } = await withSystem((db) => db.query<{ storage_bucket: "project-files" | null; storage_key: string | null }>(
    "select storage_bucket, storage_key from client_setup_task_attachments where id = $1 and org_id = $2", [attachmentId, orgId],
  ));
  if (files[0]?.storage_bucket && files[0].storage_key) await removePrivateFile({ userId: admin.id, orgId, bucket: files[0].storage_bucket, path: files[0].storage_key });
  return agencyMutation(admin, orgId, async (db, inst) => {
    const { rows } = await db.query<{ task_id: string }>("delete from client_setup_task_attachments where id = $1 and org_id = $2 returning task_id", [attachmentId, orgId]);
    if (!rows[0]) throw new AppError("not_found", "Attachment not found.");
    await recordSetupEvent(db, { orgId, instanceId: inst.id, taskId: rows[0].task_id, actorUserId: admin.id, actorKind: "agency", event: "attachment_removed", visibility: "internal" });
    return {};
  });
}

// ---------------------------------------------------------------------------
// Package, owner
// ---------------------------------------------------------------------------

export async function setServices(admin: SessionUser, orgId: string, services: string[]) {
  await assertAgencyAccess(admin, orgId, "super_admin");
  const clean = [...new Set(services)].filter((s): s is (typeof SETUP_SERVICE_KEYS)[number] => (SETUP_SERVICE_KEYS as string[]).includes(s));
  return agencyMutation(admin, orgId, async (db, inst) => {
    await db.query("update client_setup_instances set services = $2 where id = $1", [inst.id, clean]);
    // Purchased services and the CRM provider together decide what applies (a native client never gets the GoHighLevel location step back).
    await syncSetupApplicability(db, orgId);
    await recordSetupEvent(db, { orgId, instanceId: inst.id, actorUserId: admin.id, actorKind: "agency", event: "services_changed", visibility: "internal", metadata: { services: clean } });
    await recordAudit({ orgId, actorUserId: admin.id, actorKind: "agency", action: "setup.services_changed", targetType: "setup", targetId: inst.id, result: "success", metadata: { services: clean } }, db);
    return { services: clean };
  });
}

export async function setResponsibleStaff(admin: SessionUser, orgId: string, userId: string | null) {
  await assertAgencyAccess(admin, orgId);
  return agencyMutation(admin, orgId, async (db, inst) => {
    if (userId) await assertAssignable(db, orgId, userId);
    await db.query("update client_setup_instances set responsible_user_id = $2 where id = $1", [inst.id, userId]);
    await recordSetupEvent(db, { orgId, instanceId: inst.id, actorUserId: admin.id, actorKind: "agency", event: "assigned", visibility: "internal", metadata: { responsible: userId } });
    await recordAudit({ orgId, actorUserId: admin.id, actorKind: "agency", action: "setup.assigned", targetType: "setup", targetId: inst.id, result: "success" }, db);
    return {};
  });
}

// ---------------------------------------------------------------------------
// Final review and activation
// ---------------------------------------------------------------------------

async function readinessOf(db: Queryable, inst: InstanceRow) {
  const [tasks, checks] = await Promise.all([loadRuleTasks(db, inst.org_id), loadCheckStatuses(db, inst.org_id)]);
  return evaluateReadiness({ state: inst.state, tasks, checks });
}

export async function markReadyForReview(admin: SessionUser, orgId: string) {
  await assertAgencyAccess(admin, orgId);
  return agencyMutation(admin, orgId, async (db, inst, h) => {
    if (inst.state !== "in_setup") throw new AppError("invalid_input", inst.state === "activated" ? "This client is already activated." : "Setup is already in final review.");
    const r = await readinessOf(db, inst);
    if (!r.canMarkReady) throw new AppError("conflict", `Not ready for final review yet: ${r.taskBlockers.slice(0, 3).map((b) => b.message).join(" ")}`);
    await db.query("update client_setup_instances set state = 'ready_for_review', ready_for_review_at = now(), ready_for_review_by = $2 where id = $1", [inst.id, admin.id]);
    await recordSetupEvent(db, { orgId, instanceId: inst.id, actorUserId: admin.id, actorKind: "agency", event: "ready_for_review", body: "All setup steps are finished and your system is now in final review.", visibility: "client" });
    await recordAudit({ orgId, actorUserId: admin.id, actorKind: "agency", action: "setup.ready_for_review", targetType: "setup", targetId: inst.id, result: "success" }, db);
    await h.notifyClient({ kind: "setup_milestone", severity: "success", title: "Your setup is in final review", body: "Every setup step is finished. Our team is doing a last review before activation.", link: "/setup" });
    const { rows } = await db.query<{ name: string }>("select name from organizations where id = $1", [orgId]);
    await notifyAgency(db, null, { kind: "system", severity: "info", title: `${rows[0]?.name ?? "A client"} is ready for final review`, body: "A super admin can approve activation once readiness checks pass.", link: `/admin/clients/${orgId}/setup` });
    return {};
  });
}

export async function sendBackToSetup(admin: SessionUser, orgId: string, reason: string) {
  await assertAgencyAccess(admin, orgId);
  const why = reason.trim();
  if (why.length < 5) throw new AppError("invalid_input", "Add a short reason.");
  return agencyMutation(admin, orgId, async (db, inst) => {
    if (inst.state !== "ready_for_review") throw new AppError("invalid_input", "Only a setup in final review can be sent back.");
    await db.query("update client_setup_instances set state = 'in_setup', ready_for_review_at = null, ready_for_review_by = null where id = $1", [inst.id]);
    await recordSetupEvent(db, { orgId, instanceId: inst.id, actorUserId: admin.id, actorKind: "agency", event: "sent_back", reason: why.slice(0, 2000), visibility: "internal" });
    await recordAudit({ orgId, actorUserId: admin.id, actorKind: "agency", action: "setup.sent_back", targetType: "setup", targetId: inst.id, result: "success" }, db);
    return {};
  });
}

export const activationSchema = z.object({
  acknowledgeAttested: z.boolean().optional().default(false),
  note: text(2000).optional().default(""),
});

/**
 * Approves the system for activation. It re-runs every live check first, then requires the final
 * review state, every required step complete, no blocked steps and passing provider checks.
 * Attestations cannot replace technical verification. This records an immutable decision;
 * it never switches on workflows or outbound messaging by itself.
 */
export async function activateSetup(admin: SessionUser, orgId: string, input: z.input<typeof activationSchema> = {}) {
  await assertAgencyAccess(admin, orgId, "super_admin");
  const data = activationSchema.parse(input);
  await runChecks(orgId, { actorUserId: admin.id, agency: admin, live: true, force: true });
  const outcome = await agencyMutation(admin, orgId, async (db, inst, h) => {
    if (inst.state === "activated") throw new AppError("invalid_input", "This client is already activated.");
    const r = await readinessOf(db, inst);
    const jobs = await db.query<{ n: number }>("select count(*)::int as n from provisioning_jobs where org_id = $1 and status in ('running', 'failed')", [orgId]);
    const allowed = r.canActivate && jobs.rows[0].n === 0;
    await db.query(
      `insert into activation_reviews (org_id, setup_instance_id, reviewed_by, decision, setup_revision, readiness_snapshot, note)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [orgId, inst.id, admin.id, allowed ? "approved" : "blocked", inst.revision, JSON.stringify({ ...r, unresolvedJobs: jobs.rows[0].n, externalActivation: false }), data.note],
    );
    if (!allowed) {
      await recordAudit({ orgId, actorUserId: admin.id, actorKind: "agency", action: "setup.activation_blocked", targetType: "setup", targetId: inst.id, result: "denied", metadata: { blockers: r.blockers.length, unresolvedJobs: jobs.rows[0].n } }, db);
      if (inst.state !== "ready_for_review") return { blocked: "Mark the setup ready for final review before activating." };
      return { blocked: `Activation is blocked: ${r.blockers.slice(0, 3).map((b) => b.message).join(" ")}${jobs.rows[0].n ? " Preparation jobs still need attention." : ""}` };
    }
    const { rows } = await db.query<TaskRow>(`select ${TASK_COLUMNS} from client_setup_tasks t where t.org_id = $1 and t.completion_mode = 'activation' and not t.hidden and not t.service_excluded`, [orgId]);
    for (const t of rows) {
      if (t.status !== "completed") await applyTransition(db, h, inst, { task: t, to: "completed", actor: { userId: admin.id, kind: "agency" }, source: "activation", clientText: data.note || null, notify: false });
    }
    await db.query("update client_setup_instances set state = 'activated', activated_at = now(), activated_by = $2, activation_note = $3 where id = $1", [inst.id, admin.id, data.note || null]);
    await db.query("update billing_accounts set activation_status = 'active' where org_id = $1 and activation_status = 'pending'", [orgId]);
    await recordSetupEvent(db, { orgId, instanceId: inst.id, actorUserId: admin.id, actorKind: "agency", event: "activated", body: "Your system was approved for activation.", reason: data.note || null, visibility: "client", metadata: { attested: r.attestedChecks } });
    await recordAudit({ orgId, actorUserId: admin.id, actorKind: "agency", action: "setup.activated", targetType: "setup", targetId: inst.id, result: "success", metadata: { attested: r.attestedChecks } }, db);
    await h.notifyClient({ kind: "setup_ready", severity: "success", title: "Your full system is approved for activation", body: "Final review is complete. The iAcquire team will confirm before any automation is switched on.", link: "/setup" });
    return { blocked: null };
  });
  if (outcome.result.blocked) throw new AppError("conflict", outcome.result.blocked);
  return outcome;
}
