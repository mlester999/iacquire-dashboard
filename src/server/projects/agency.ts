import "server-only";
import { z } from "zod";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyOrgRoles, notifyUser } from "@/server/notifications";
import type { SessionUser } from "@/server/auth/service";
import { STATUS_TRANSITIONS, PROJECT_STATUS_LABEL, type MilestoneStatus, type ProjectStatus } from "@/lib/projects";
import { loadProjectDetail, storeProjectFile } from "@/server/projects/client";
import { addDays } from "@/lib/calendars/slots";
import { CLIENT_ROLES, addUpdate, agencyAccessInTx, authorizeRequest, closeTasks, isStaff, orgToday } from "@/server/projects/access";
import { withdrawOpenChangeOrders } from "@/server/projects/change-orders";
import { assertHandoverAllowed, assertStartAllowed } from "@/server/projects/prerequisites";
import { REQUEST_COLUMNS, iso, quoteContentHash, toQuoteView, toRequestView, type ProjectDetail, type QuoteRow, type RequestRow, type RequestView } from "@/server/projects/shared";

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Queue and detail
// ---------------------------------------------------------------------------

export interface AgencyProjectItem extends RequestView {
  orgName: string;
  assignedToName: string | null;
  quoteStatus: string | null;
  openTasks: number;
  milestonesDone: number;
  milestonesTotal: number;
  agreedPriceCents: number | null;
  /** Changes the client asked for that nobody has answered yet (received, being reviewed, waiting for the client, or quoted). */
  openChanges: number;
}

export async function listAgencyProjects(user: SessionUser, filters: { status?: string; orgId?: string; assignedToMe?: boolean; needsReview?: boolean } = {}): Promise<AgencyProjectItem[]> {
  if (!isStaff(user)) throw new AppError("forbidden", "Agency access is required.");
  const view = await withSystem((db) => db.query<{ allowed: boolean }>("select coalesce(app.user_has_agency_permission($1,'projects.view'),false) as allowed", [user.id]));
  if (view.rows[0]?.allowed !== true) throw new AppError("forbidden", "Your role does not allow viewing client projects.");
  const status = filters.status && filters.status !== "all" ? filters.status : null;
  const { rows } = await withSystem((db) =>
    db.query<RequestRow & { org_name: string; assigned_to_name: string | null; quote_status: string | null; open_tasks: number; ms_done: number; ms_total: number; agreed_price_cents: number | null; open_changes: number }>(
      `select ${REQUEST_COLUMNS}, o.name as org_name, au.full_name as assigned_to_name,
         (select q.status from project_quotes q where q.request_id = r.id order by q.version desc limit 1) as quote_status,
         (select count(*)::int from project_review_tasks t where t.request_id = r.id and t.status = 'open') as open_tasks,
         (select count(*)::int from project_milestones m where m.request_id = r.id and m.status = 'completed') as ms_done,
         (select count(*)::int from project_milestones m where m.request_id = r.id) as ms_total,
         cp.agreed_price_cents,
         (select count(*)::int from project_change_orders c where c.request_id = r.id and c.status in ('submitted','under_review','needs_info','quoted')) as open_changes
       from client_project_requests r
       join organizations o on o.id = r.org_id
       left join service_catalog s on s.id = r.service_id
       left join users au on au.id = r.assigned_to
       left join client_projects cp on cp.request_id = r.id
       where app.user_can_access_org($1,r.org_id)
         and ($2::text is null or r.status = $2)
         and ($3::uuid is null or r.org_id = $3)
         and (not $4::boolean or r.assigned_to = $1)
         and (not $5::boolean or exists (select 1 from project_review_tasks t where t.request_id = r.id and t.status = 'open')
              or exists (select 1 from project_change_orders c where c.request_id = r.id and c.status in ('submitted','under_review')))
       order by (r.status in ('submitted','under_review','discovery_needed')) desc, r.last_activity_at desc limit 300`,
      [user.id, status, filters.orgId ?? null, Boolean(filters.assignedToMe), Boolean(filters.needsReview)],
    ),
  );
  return rows.map((r) => ({ ...toRequestView(r), orgName: r.org_name, assignedToName: r.assigned_to_name, quoteStatus: r.quote_status, openTasks: r.open_tasks, milestonesDone: r.ms_done, milestonesTotal: r.ms_total, agreedPriceCents: r.agreed_price_cents, openChanges: r.open_changes }));
}

export interface AgencyProjectDetail extends ProjectDetail {
  orgName: string;
  createdByName: string | null;
  internalNotes: string | null;
  assignedTo: { id: string; name: string } | null;
  assignable: Array<{ id: string; name: string }>;
  tasks: Array<{ id: string; kind: string; title: string; dueAt: string | null; createdAt: string }>;
  suggestedServices: Array<{ id: string; slug: string; name: string }>;
  quoteInternalNotes: Record<string, string | null>;
}

export async function getAgencyProject(user: SessionUser, requestId: string): Promise<AgencyProjectDetail | null> {
  if (!isStaff(user) || !z.string().uuid().safeParse(requestId).success) return null;
  return withSystem(async (db) => {
    const view = await db.query<{ allowed: boolean }>("select coalesce(app.user_has_agency_permission($1,'projects.view'),false) as allowed", [user.id]);
    if (view.rows[0]?.allowed !== true) throw new AppError("forbidden", "Your role does not allow viewing client projects.");
    const head = (await db.query<{ org_id: string; org_name: string; org_timezone: string; internal_notes: string | null; assigned_to: string | null; created_by_name: string | null; suggested_service_ids: string[] }>(
      `select r.org_id, o.name as org_name, o.timezone as org_timezone, r.internal_notes, r.assigned_to, cu.full_name as created_by_name, r.suggested_service_ids
       from client_project_requests r join organizations o on o.id = r.org_id left join users cu on cu.id = r.created_by where r.id = $1`,
      [requestId],
    )).rows[0];
    if (!head || !(await agencyAccessInTx(db, user, head.org_id))) return null;
    const detail = await loadProjectDetail(db, requestId, { internal: true, timeZone: head.org_timezone });
    if (!detail) return null;
    const assignable = (await db.query<{ id: string; name: string }>(
      `select u.id, coalesce(nullif(u.full_name,''), u.email::text) as name from users u
       where u.status = 'active' and u.platform_role in ('agency_super_admin','agency_manager','agency_staff') and app.user_can_access_org(u.id,$1)
       order by name`,
      [head.org_id],
    )).rows;
    const tasks = (await db.query<{ id: string; kind: string; title: string; due_at: Date | null; created_at: Date }>(
      "select id, kind, title, due_at, created_at from project_review_tasks where request_id = $1 and status = 'open' order by created_at", [requestId],
    )).rows;
    const suggested = head.suggested_service_ids.length
      ? (await db.query<{ id: string; slug: string; name: string }>("select id, slug, name from service_catalog where id = any($1::uuid[])", [head.suggested_service_ids])).rows
      : [];
    const qn = (await db.query<{ id: string; internal_notes: string | null }>("select id, internal_notes from project_quotes where request_id = $1", [requestId])).rows;
    return {
      ...detail,
      orgName: head.org_name,
      createdByName: head.created_by_name,
      internalNotes: head.internal_notes,
      assignedTo: head.assigned_to ? (assignable.find((a) => a.id === head.assigned_to) ?? { id: head.assigned_to, name: "Former team member" }) : null,
      assignable,
      tasks: tasks.map((t) => ({ id: t.id, kind: t.kind, title: t.title, dueAt: iso(t.due_at), createdAt: iso(t.created_at)! })),
      suggestedServices: suggested,
      quoteInternalNotes: Object.fromEntries(qn.map((q) => [q.id, q.internal_notes])),
    };
  });
}

export async function agencyProjectStats(user: SessionUser) {
  if (!isStaff(user)) throw new AppError("forbidden", "Agency access is required.");
  const view = await withSystem((db) => db.query<{ allowed: boolean }>("select coalesce(app.user_has_agency_permission($1,'projects.view'),false) as allowed", [user.id]));
  if (view.rows[0]?.allowed !== true) throw new AppError("forbidden", "Your role does not allow viewing client projects.");
  const { rows } = await withSystem((db) =>
    db.query<{ status: string; n: number }>(
      `select r.status, count(*)::int as n from client_project_requests r
       where app.user_can_access_org($1,r.org_id) group by r.status`,
      [user.id],
    ),
  );
  return Object.fromEntries(rows.map((r) => [r.status, r.n])) as Record<string, number>;
}

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export async function updateProjectStatus(user: SessionUser, requestId: string, change: { status?: ProjectStatus; resume?: boolean; reason?: string }) {
  await withSystem(async (db) => {
    const r = await authorizeRequest(db, user, requestId);
    const reason = (change.reason ?? "").trim().slice(0, 500);
    let next: ProjectStatus;
    if (change.resume) {
      if (r.status !== "on_hold") throw new AppError("conflict", "This project isn't on hold.");
      next = r.status_before_hold ?? "under_review";
    } else {
      if (!change.status) throw new AppError("invalid_input", "Choose a status.");
      next = change.status;
      if (!STATUS_TRANSITIONS[r.status].includes(next)) throw new AppError("conflict", `A project can't move from ${PROJECT_STATUS_LABEL[r.status]} to ${PROJECT_STATUS_LABEL[next]}.`);
      if (next === "completed") throw new AppError("conflict", "Record the handover to complete a project.");
      if (next === "cancelled" && reason.length < 3) throw new AppError("invalid_input", "Add a short reason for cancelling.");
    }
    if (["quote_sent", "awaiting_approval"].includes(next) && !change.resume) {
      const live = await db.query("select 1 from project_quotes where request_id = $1 and status = 'sent'", [requestId]);
      if (!live.rows[0]) throw new AppError("conflict", "Send a quote before marking this as sent or awaiting approval.");
    }
    // Work starts once, and not before the things asked for first (the agreement, a payment a person confirmed, access) are confirmed or waived with a reason.
    if (next === "in_development") {
      const started = (await db.query<{ started_at: Date | null }>("select started_at from client_projects where request_id = $1", [requestId])).rows[0];
      if (!started?.started_at) await assertStartAllowed(db, requestId);
    }
    const holding = next === "on_hold";
    await db.query(
      `update client_project_requests set status = $2, status_before_hold = case when $3::boolean then $4 else null end,
         cancel_reason = case when $2 = 'cancelled' then $5 else cancel_reason end,
         closed_at = case when $2 = 'cancelled' then now() else closed_at end, last_activity_at = now() where id = $1`,
      [requestId, next, holding, r.status, reason || null],
    );
    if (next === "in_development") await db.query("update client_projects set started_at = coalesce(started_at, now()) where request_id = $1", [requestId]);
    // A quote still waiting for a decision on a project that is now closed would show the client a quote nobody can act on. A hold keeps it: the project can resume.
    // The same goes for a change the client asked for that is still open, a waiting quote for it included.
    if (next === "cancelled") {
      await db.query("update project_quotes set status = 'withdrawn' where request_id = $1 and status = 'sent'", [requestId]);
      await withdrawOpenChangeOrders(db, r, user.id);
    }
    if (r.status === "submitted") await closeTasks(db, requestId, ["initial_review"], user.id);
    const updateId = await addUpdate(db, r, user.id, "status_change", `Status changed to ${PROJECT_STATUS_LABEL[next]}.${next === "on_hold" && reason ? ` ${reason}` : ""}`);
    await notifyOrgRoles(db, r.org_id, CLIENT_ROLES, { kind: "project_update", title: `${r.ref} is now ${PROJECT_STATUS_LABEL[next]}`, link: `/projects/${requestId}`, dedupeKey: `project:${requestId}:update:${updateId}` });
    await recordAudit({ orgId: r.org_id, actorUserId: user.id, actorKind: "agency", action: "project.status_changed", targetType: "project_request", targetId: requestId, result: "success", metadata: { from: r.status, to: next, ref: r.ref } }, db);
  });
}

export async function assignProject(user: SessionUser, requestId: string, assigneeId: string | null) {
  await withSystem(async (db) => {
    const r = await authorizeRequest(db, user, requestId);
    if (assigneeId) {
      const ok = (await db.query("select 1 from users u where u.id = $1 and u.status = 'active' and u.platform_role in ('agency_super_admin','agency_manager','agency_staff') and app.user_can_access_org(u.id,$2)", [assigneeId, r.org_id])).rows[0];
      if (!ok) throw new AppError("invalid_input", "Choose a team member who works on this client.");
    }
    // Assigning the person who already has it changes nothing, so it announces nothing (a double click or a retry).
    const { rows } = await db.query<{ updated_at: Date }>("update client_project_requests set assigned_to = $2 where id = $1 and assigned_to is distinct from $2 returning updated_at", [requestId, assigneeId]);
    if (!rows[0]) return;
    // The moment of the change names this assignment, so handing it back and forth is announced each time and only once each.
    if (assigneeId && assigneeId !== user.id) await notifyUser(db, assigneeId, r.org_id, { kind: "project_update", title: `${r.ref} was assigned to you`, body: r.title, link: `/admin/projects/${requestId}`, dedupeKey: `project:${requestId}:assigned:${assigneeId}:${new Date(rows[0].updated_at).getTime()}` });
    await recordAudit({ orgId: r.org_id, actorUserId: user.id, actorKind: "agency", action: "project.assigned", targetType: "project_request", targetId: requestId, result: "success", metadata: { assignee: assigneeId } }, db);
  });
}

export async function saveInternalNotes(user: SessionUser, requestId: string, notes: string) {
  await withSystem(async (db) => {
    const r = await authorizeRequest(db, user, requestId);
    await db.query("update client_project_requests set internal_notes = $2 where id = $1", [requestId, notes.trim().slice(0, 8000) || null]);
    // The audit entry records that notes changed, never their contents.
    await recordAudit({ orgId: r.org_id, actorUserId: user.id, actorKind: "agency", action: "project.internal_notes_saved", targetType: "project_request", targetId: requestId, result: "success" }, db);
  });
}

export async function postAgencyMessage(user: SessionUser, requestId: string, body: string, opts: { internal?: boolean; infoRequest?: boolean } = {}) {
  const text = body.trim();
  if (!text || text.length > 5000) throw new AppError("invalid_input", "Messages can be up to 5,000 characters.");
  await withSystem(async (db) => {
    const r = await authorizeRequest(db, user, requestId);
    const internal = Boolean(opts.internal);
    const message = (await db.query<{ id: string }>("insert into project_messages (request_id, org_id, author_id, author_kind, kind, body, internal) values ($1,$2,$3,'agency',$4,$5,$6) returning id", [requestId, r.org_id, user.id, opts.infoRequest ? "info_request" : "message", text, internal])).rows[0];
    await db.query("update client_project_requests set last_activity_at = now(), assigned_to = coalesce(assigned_to, $2) where id = $1", [requestId, user.id]);
    if (!internal) {
      await closeTasks(db, requestId, ["respond_to_client", ...(r.status === "submitted" ? ["initial_review"] : [])], user.id);
      if (opts.infoRequest && ["submitted", "under_review", "quote_preparing"].includes(r.status)) {
        await db.query("update client_project_requests set status = 'discovery_needed' where id = $1", [requestId]);
        await addUpdate(db, r, user.id, "status_change", "Status changed to Discovery Needed. We need a little more information.");
      } else if (r.status === "submitted") {
        await db.query("update client_project_requests set status = 'under_review' where id = $1", [requestId]);
      }
      await notifyOrgRoles(db, r.org_id, CLIENT_ROLES, { kind: "project_message", title: opts.infoRequest ? `${r.ref}: iAcquire needs more information` : `${r.ref}: new message from iAcquire`, body: text.slice(0, 140), link: `/projects/${requestId}`, dedupeKey: `project:${requestId}:message:${message.id}` });
    }
    await recordAudit({ orgId: r.org_id, actorUserId: user.id, actorKind: "agency", action: internal ? "project.internal_note" : opts.infoRequest ? "project.info_requested" : "project.agency_message", targetType: "project_request", targetId: requestId, result: "success" }, db);
  });
}

export async function addProgressUpdate(user: SessionUser, requestId: string, body: string, visibility: "client" | "internal" = "client") {
  const text = body.trim();
  if (!text || text.length > 4000) throw new AppError("invalid_input", "Updates can be up to 4,000 characters.");
  await withSystem(async (db) => {
    const r = await authorizeRequest(db, user, requestId);
    const updateId = await addUpdate(db, r, user.id, "progress", text, visibility);
    if (visibility === "client") await notifyOrgRoles(db, r.org_id, CLIENT_ROLES, { kind: "project_update", title: `${r.ref}: progress update`, body: text.slice(0, 140), link: `/projects/${requestId}`, dedupeKey: `project:${requestId}:update:${updateId}` });
    await recordAudit({ orgId: r.org_id, actorUserId: user.id, actorKind: "agency", action: "project.progress_update", targetType: "project_request", targetId: requestId, result: "success", metadata: { visibility } }, db);
  });
}

// ---------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------

export const milestoneSchema = z.object({
  id: z.string().uuid().optional(),
  title: z.string().trim().min(2).max(160),
  description: z.string().trim().max(1000).nullable().optional(),
  dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  requiresClientApproval: z.boolean().default(false),
  sortOrder: z.number().int().min(0).max(1000).optional(),
});

export async function saveMilestone(user: SessionUser, requestId: string, input: z.input<typeof milestoneSchema>) {
  const d = milestoneSchema.parse(input);
  await withSystem(async (db) => {
    const r = await authorizeRequest(db, user, requestId);
    if (d.id) {
      const cur = (await db.query<{ title: string; description: string | null; requires_client_approval: boolean; status: MilestoneStatus; client_approved_at: Date | null }>(
        "select title, description, requires_client_approval, status, client_approved_at from project_milestones where id = $1 and request_id = $2 for update", [d.id, requestId],
      )).rows[0];
      if (!cur) throw new AppError("not_found", "Milestone not found.");
      // What a milestone says is what the client approved: once they approved it, or it is completed, only its date and place in the list can move.
      if (cur.title !== d.title || (cur.description ?? "") !== (d.description ?? "") || cur.requires_client_approval !== d.requiresClientApproval) {
        if (cur.client_approved_at) throw new AppError("conflict", "The client already approved this milestone, so what it says can't change. Add a new milestone for new work.");
        if (cur.status === "completed") throw new AppError("conflict", "This milestone is completed, so what it says can't change. Add a new milestone for new work.");
        if (cur.status === "awaiting_approval") throw new AppError("conflict", "This milestone is waiting for the client's approval. Wait for their answer before changing what it says.");
      }
      await db.query("update project_milestones set title=$3, description=$4, due_on=$5, requires_client_approval=$6, sort_order=coalesce($7, sort_order) where id=$1 and request_id=$2", [d.id, requestId, d.title, d.description ?? null, d.dueOn ?? null, d.requiresClientApproval, d.sortOrder ?? null]);
    } else {
      await db.query("insert into project_milestones (request_id, org_id, title, description, due_on, requires_client_approval, sort_order) values ($1,$2,$3,$4,$5,$6,coalesce($7,(select coalesce(max(sort_order),0)+10 from project_milestones where request_id = $1)))", [requestId, r.org_id, d.title, d.description ?? null, d.dueOn ?? null, d.requiresClientApproval, d.sortOrder ?? null]);
    }
    await db.query("update client_project_requests set last_activity_at = now() where id = $1", [requestId]);
    await recordAudit({ orgId: r.org_id, actorUserId: user.id, actorKind: "agency", action: d.id ? "project.milestone_updated" : "project.milestone_added", targetType: "project_request", targetId: requestId, result: "success", metadata: { title: d.title } }, db);
  });
}

export async function deleteMilestone(user: SessionUser, requestId: string, milestoneId: string) {
  await withSystem(async (db) => {
    const r = await authorizeRequest(db, user, requestId);
    if (!z.string().uuid().safeParse(milestoneId).success) throw new AppError("not_found", "Milestone not found.");
    const m = (await db.query<{ title: string; status: MilestoneStatus; client_approved_at: Date | null }>("select title, status, client_approved_at from project_milestones where id = $1 and request_id = $2 for update", [milestoneId, requestId])).rows[0];
    if (!m) throw new AppError("not_found", "Milestone not found.");
    // Deleting would destroy the client's recorded approval (who, when, their note), or erase work that was finished.
    if (m.client_approved_at) throw new AppError("conflict", "The client already approved this milestone, so it can't be deleted. Its approval stays on the project's record.");
    if (m.status === "completed") throw new AppError("conflict", "This milestone is completed, so it can't be deleted.");
    await db.query("delete from project_milestones where id = $1 and request_id = $2", [milestoneId, requestId]);
    await recordAudit({ orgId: r.org_id, actorUserId: user.id, actorKind: "agency", action: "project.milestone_removed", targetType: "project_request", targetId: requestId, result: "success", metadata: { title: m.title } }, db);
  });
}

/** Staff move a milestone along. A milestone needing client approval is only completed by the client's own approval. */
export async function setMilestoneStatus(user: SessionUser, requestId: string, milestoneId: string, status: MilestoneStatus) {
  await withSystem(async (db) => {
    const r = await authorizeRequest(db, user, requestId);
    const m = (await db.query<{ title: string; requires_client_approval: boolean; client_approved_at: Date | null }>("select title, requires_client_approval, client_approved_at from project_milestones where id = $1 and request_id = $2 for update", [milestoneId, requestId])).rows[0];
    if (!m) throw new AppError("not_found", "Milestone not found.");
    if (status === "awaiting_approval" && !m.requires_client_approval) throw new AppError("conflict", "This milestone doesn't need client approval.");
    if (status === "completed" && m.requires_client_approval && !m.client_approved_at) throw new AppError("conflict", "The client has to approve this milestone before it can be completed.");
    await db.query("update project_milestones set status = $2, completed_at = case when $2 = 'completed' then coalesce(completed_at, now()) else null end where id = $1", [milestoneId, status]);
    if (status === "awaiting_approval") {
      const updateId = await addUpdate(db, r, user.id, "milestone", `Ready for your review: ${m.title}`);
      await notifyOrgRoles(db, r.org_id, CLIENT_ROLES, { kind: "project_update", severity: "warning", title: `${r.ref}: your approval is needed`, body: m.title, link: `/projects/${requestId}`, dedupeKey: `project:${requestId}:update:${updateId}` });
    } else if (status === "completed") {
      await addUpdate(db, r, user.id, "milestone", `Completed: ${m.title}`);
    }
    await recordAudit({ orgId: r.org_id, actorUserId: user.id, actorKind: "agency", action: "project.milestone_status", targetType: "project_milestone", targetId: milestoneId, result: "success", metadata: { status } }, db);
  });
}

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

export const quoteDraftSchema = z.object({
  id: z.string().uuid().optional(),
  projectName: z.string().trim().min(3).max(160),
  scope: z.string().trim().max(8000).default(""),
  deliverables: z.array(z.string().trim().min(1).max(300)).max(30).default([]),
  includedIntegrations: z.array(z.string().trim().min(1).max(100)).max(30).default([]),
  exclusions: z.array(z.string().trim().min(1).max(300)).max(30).default([]),
  timelineText: z.string().trim().max(300).default(""),
  estimatedWeeksMin: z.number().int().min(1).max(104).nullable().default(null),
  estimatedWeeksMax: z.number().int().min(1).max(104).nullable().default(null),
  oneTimeCents: z.number().int().min(0).max(100_000_000).default(0),
  ongoingMonthlyCents: z.number().int().min(0).max(10_000_000).nullable().default(null),
  ongoingDescription: z.string().trim().max(1000).nullable().default(null),
  revisionTerms: z.string().trim().max(2000).default(""),
  paymentTerms: z.string().trim().max(2000).default(""),
  warrantyTerms: z.string().trim().max(2000).default(""),
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  internalNotes: z.string().trim().max(4000).nullable().default(null),
});
export type QuoteDraftInput = z.input<typeof quoteDraftSchema>;

const QUOTE_BLOCKING = ["approved", "in_development", "testing", "ready_for_review", "completed", "cancelled"];

/** Creates a new draft version, or edits an existing draft. Sent quotes are never edited; revise by drafting a new version. */
export async function saveQuoteDraft(user: SessionUser, requestId: string, input: QuoteDraftInput): Promise<{ id: string }> {
  const d = quoteDraftSchema.parse(input);
  if (d.estimatedWeeksMin && d.estimatedWeeksMax && d.estimatedWeeksMax < d.estimatedWeeksMin) throw new AppError("invalid_input", "The latest estimate can't be earlier than the earliest.");
  return withSystem(async (db) => {
    const r = await authorizeRequest(db, user, requestId, "quotes.manage");
    if (QUOTE_BLOCKING.includes(r.status)) throw new AppError("conflict", "This project can no longer take a new quote.");
    const v = [d.projectName, d.scope, d.deliverables, d.includedIntegrations, d.exclusions, d.timelineText, d.estimatedWeeksMin, d.estimatedWeeksMax, d.oneTimeCents, d.ongoingMonthlyCents, d.ongoingDescription, d.revisionTerms, d.paymentTerms, d.warrantyTerms, d.validUntil, d.internalNotes, user.id];
    let id = d.id;
    if (id) {
      const x = await db.query<{ status: string }>("select status from project_quotes where id = $1 and request_id = $2 for update", [id, requestId]);
      if (!x.rows[0]) throw new AppError("not_found", "Quote not found.");
      if (x.rows[0].status !== "draft") throw new AppError("conflict", "Only drafts can be edited. Start a new version instead.");
      await db.query(
        `update project_quotes set project_name=$2, scope=$3, deliverables=$4, included_integrations=$5, exclusions=$6, timeline_text=$7, estimated_weeks_min=$8,
           estimated_weeks_max=$9, one_time_cents=$10, ongoing_monthly_cents=$11, ongoing_description=$12, revision_terms=$13, payment_terms=$14, warranty_terms=$15,
           valid_until=$16, internal_notes=$17, prepared_by=$18 where id=$1`,
        [id, ...v],
      );
    } else {
      const open = await db.query("select 1 from project_quotes where request_id = $1 and status = 'draft'", [requestId]);
      if (open.rows[0]) throw new AppError("conflict", "There is already a draft. Edit or send it first.");
      id = (await db.query<{ id: string }>(
        `insert into project_quotes (request_id, org_id, version, project_name, scope, deliverables, included_integrations, exclusions, timeline_text, estimated_weeks_min,
           estimated_weeks_max, one_time_cents, ongoing_monthly_cents, ongoing_description, revision_terms, payment_terms, warranty_terms, valid_until, internal_notes, prepared_by)
         values ($1,$2,(select coalesce(max(version),0)+1 from project_quotes where request_id = $1),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) returning id`,
        [requestId, r.org_id, ...v],
      )).rows[0].id;
      if (["submitted", "under_review", "discovery_needed"].includes(r.status)) {
        await db.query("update client_project_requests set status = 'quote_preparing', last_activity_at = now() where id = $1", [requestId]);
        await closeTasks(db, requestId, ["initial_review"], user.id);
      }
    }
    await recordAudit({ orgId: r.org_id, actorUserId: user.id, actorKind: "agency", action: "project.quote_drafted", targetType: "project_quote", targetId: id!, result: "success", metadata: { ref: r.ref, oneTimeCents: d.oneTimeCents } }, db);
    return { id: id! };
  });
}

/** Sending is the point at which pricing becomes visible to the client. Only quote managers can do it. */
export async function sendQuote(user: SessionUser, requestId: string, quoteId: string) {
  await withSystem(async (db) => {
    const r = await authorizeRequest(db, user, requestId, "quotes.manage");
    if (QUOTE_BLOCKING.includes(r.status)) throw new AppError("conflict", "This project can no longer take a new quote.");
    const q = (await db.query<QuoteRow>(
      `select id, version, status, project_name, scope, deliverables, included_integrations, exclusions, timeline_text, estimated_weeks_min, estimated_weeks_max,
              one_time_cents, ongoing_monthly_cents, ongoing_description, revision_terms, payment_terms, warranty_terms, currency, valid_until::text as valid_until,
              content_hash, sent_at, first_viewed_at, created_at from project_quotes where id = $1 and request_id = $2 for update`,
      [quoteId, requestId],
    )).rows[0];
    if (!q) throw new AppError("not_found", "Quote not found.");
    if (q.status !== "draft") throw new AppError("conflict", "Only a draft can be sent.");
    const missing: string[] = [];
    if (q.scope.length < 20) missing.push("scope of work");
    if (!q.deliverables.length) missing.push("deliverables");
    if (!q.timeline_text) missing.push("estimated timeline");
    if (q.one_time_cents <= 0) missing.push("one-time cost");
    if (!q.revision_terms) missing.push("revision terms");
    if (!q.payment_terms) missing.push("payment terms");
    if (!q.warranty_terms) missing.push("support or warranty period");
    if (missing.length) throw new AppError("invalid_input", `Complete the quote before sending: ${missing.join(", ")}.`);
    if (q.valid_until && q.valid_until < new Date().toISOString().slice(0, 10)) throw new AppError("invalid_input", "The quote's valid-until date is in the past.");
    const hash = quoteContentHash(toQuoteView(q));
    await db.query("update project_quotes set status = 'superseded' where request_id = $1 and status = 'sent'", [requestId]);
    await db.query("update project_quotes set status = 'sent', sent_at = now(), sent_by = $2, content_hash = $3 where id = $1", [quoteId, user.id, hash]);
    await db.query("update client_project_requests set status = 'quote_sent', last_activity_at = now(), assigned_to = coalesce(assigned_to, $2) where id = $1", [requestId, user.id]);
    await closeTasks(db, requestId, ["prepare_quote", "initial_review"], user.id);
    await addUpdate(db, r, user.id, "system", `Quote v${q.version} sent for your review.`);
    await notifyOrgRoles(db, r.org_id, ["owner", "admin"], { kind: "project_quote", severity: "warning", title: `${r.ref}: your quote is ready`, body: q.project_name, link: `/projects/${requestId}`, dedupeKey: `project:${requestId}:quote:${quoteId}:sent` });
    await recordAudit({ orgId: r.org_id, actorUserId: user.id, actorKind: "agency", action: "project.quote_sent", targetType: "project_quote", targetId: quoteId, result: "success", metadata: { ref: r.ref, version: q.version, oneTimeCents: q.one_time_cents, hash: hash.slice(0, 12) } }, db);
  });
}

export async function withdrawQuote(user: SessionUser, requestId: string, quoteId: string) {
  await withSystem(async (db) => {
    const r = await authorizeRequest(db, user, requestId, "quotes.manage");
    const x = await db.query<{ status: string }>("select status from project_quotes where id = $1 and request_id = $2 for update", [quoteId, requestId]);
    if (!x.rows[0]) throw new AppError("not_found", "Quote not found.");
    if (!["sent", "draft"].includes(x.rows[0].status)) throw new AppError("conflict", "This quote can't be withdrawn.");
    await db.query("update project_quotes set status = 'withdrawn' where id = $1", [quoteId]);
    if (x.rows[0].status === "sent") {
      await db.query("update client_project_requests set status = 'quote_preparing', last_activity_at = now() where id = $1 and status in ('quote_sent','awaiting_approval')", [requestId]);
      await addUpdate(db, r, user.id, "system", "A quote was withdrawn. An updated quote is being prepared.");
    }
    await recordAudit({ orgId: r.org_id, actorUserId: user.id, actorKind: "agency", action: "project.quote_withdrawn", targetType: "project_quote", targetId: quoteId, result: "success" }, db);
  });
}

// ---------------------------------------------------------------------------
// Deliverables and handover
// ---------------------------------------------------------------------------

export async function uploadDeliverable(user: SessionUser, requestId: string, file: { name: string; bytes: Buffer }, opts: { kind?: "deliverable" | "reference" | "handover"; visibility?: "client" | "internal"; description?: string | null } = {}) {
  const r = await withSystem((db) => authorizeRequest(db, user, requestId));
  const stored = await storeProjectFile({ userId: user.id, orgId: r.org_id, requestId, file, by: "agency", kind: opts.kind ?? "deliverable", visibility: opts.visibility ?? "client", description: opts.description });
  if ((opts.visibility ?? "client") === "client") {
    await withSystem(async (db) => {
      const updateId = await addUpdate(db, r, user.id, "deliverable", `New file shared: ${stored.filename}`);
      await notifyOrgRoles(db, r.org_id, CLIENT_ROLES, { kind: "project_update", title: `${r.ref}: a file was shared with you`, body: stored.filename, link: `/projects/${requestId}`, dedupeKey: `project:${requestId}:update:${updateId}` });
    });
  }
  return stored;
}

/**
 * What the team records about the agreed terms: how many revisions the agreement includes and how long the support period lasts. Both stay empty until a person records
 * them (nothing is assumed when a quote is silent); the quote's own wording remains the terms. The count of revisions used can never pass the number included.
 */
export const projectTermsSchema = z.object({
  warrantyDays: z.number().int().min(0, "The support period can't be negative.").max(3650, "The support period can be up to 3,650 days.").nullable().optional(),
  revisionsIncluded: z.number().int().min(0, "Revisions can't be negative.").max(100, "Up to 100 revisions can be recorded.").nullable().optional(),
});
export type ProjectTermsInput = z.input<typeof projectTermsSchema>;

export async function setProjectTerms(user: SessionUser, requestId: string, input: ProjectTermsInput) {
  const parsed = projectTermsSchema.safeParse(input);
  if (!parsed.success) throw new AppError("invalid_input", parsed.error.issues[0]?.message ?? "Check the numbers and try again.");
  const terms = parsed.data;
  await withSystem(async (db) => {
    const r = await authorizeRequest(db, user, requestId);
    const cp = (await db.query<{ warranty_days: number | null; revisions_included: number | null; revisions_used: number; completed_at: Date | null }>(
      "select warranty_days, revisions_included, revisions_used, completed_at from client_projects where request_id = $1 for update", [requestId],
    )).rows[0];
    if (!cp) throw new AppError("conflict", "This project has no agreed quote yet.");
    if (cp.completed_at || r.status === "cancelled") throw new AppError("conflict", "This project is closed, so its terms were fixed when it was handed over.");
    const revisionsIncluded = terms.revisionsIncluded !== undefined ? terms.revisionsIncluded : cp.revisions_included;
    const warrantyDays = terms.warrantyDays !== undefined ? terms.warrantyDays : cp.warranty_days;
    if (revisionsIncluded !== null && revisionsIncluded < cp.revisions_used) throw new AppError("invalid_input", `${cp.revisions_used} revision${cp.revisions_used === 1 ? " is" : "s are"} already used, so the number included can't be lower.`);
    await db.query("update client_projects set revisions_included = $2, warranty_days = $3 where request_id = $1", [requestId, revisionsIncluded, warrantyDays]);
    await recordAudit({ orgId: r.org_id, actorUserId: user.id, actorKind: "agency", action: "project.terms_recorded", targetType: "project_request", targetId: requestId, result: "success", metadata: { ref: r.ref, revisionsIncluded, warrantyDays } }, db);
  });
}

export async function recordHandover(user: SessionUser, requestId: string, notes: string, termsInput: ProjectTermsInput = {}) {
  const text = notes.trim();
  if (text.length < 10 || text.length > 4000) throw new AppError("invalid_input", "Write the handover notes (10–4,000 characters): what was delivered and how it is used.");
  const parsedTerms = projectTermsSchema.safeParse(termsInput);
  if (!parsedTerms.success) throw new AppError("invalid_input", parsedTerms.error.issues[0]?.message ?? "Check the numbers and try again.");
  const terms = parsedTerms.data;
  await withSystem(async (db) => {
    const r = await authorizeRequest(db, user, requestId);
    if (r.status !== "ready_for_review") throw new AppError("conflict", "Move the project to Ready for Review before recording the handover.");
    const open = await db.query("select 1 from project_milestones where request_id = $1 and requires_client_approval and status <> 'completed'", [requestId]);
    if (open.rows[0]) throw new AppError("conflict", "A milestone that needs client approval is still open.");
    await assertHandoverAllowed(db, requestId);
    // A change still being decided, or accepted and not yet made, would be left with nobody able to act on it once the project is closed.
    const changes = await db.query<{ ref: string }>("select ref from project_change_orders where request_id = $1 and status in ('submitted','under_review','needs_info','quoted','accepted') order by ref", [requestId]);
    if (changes.rows.length) throw new AppError("conflict", `Finish, decline or withdraw the open changes first (${changes.rows.map((c) => c.ref).join(", ")}).`);
    const agreed = (await db.query<{ warranty_days: number | null; revisions_included: number | null; revisions_used: number }>("select warranty_days, revisions_included, revisions_used from client_projects where request_id = $1 for update", [requestId])).rows[0];
    if (!agreed) throw new AppError("conflict", "This project has no agreed quote to hand over.");
    const warrantyDays = terms.warrantyDays !== undefined ? terms.warrantyDays : agreed.warranty_days;
    const revisionsIncluded = terms.revisionsIncluded !== undefined ? terms.revisionsIncluded : agreed.revisions_included;
    if (revisionsIncluded !== null && revisionsIncluded < agreed.revisions_used) throw new AppError("invalid_input", `${agreed.revisions_used} revision${agreed.revisions_used === 1 ? " is" : "s are"} already used, so the number included can't be lower.`);
    // The support period runs from the day of handover in the workspace's own calendar.
    const endsOn = warrantyDays === null ? null : addDays(await orgToday(db, r.org_id), warrantyDays);
    await db.query(
      "update client_projects set completed_at = now(), handover_notes = $2, handover_recorded_by = $3, warranty_days = $4, warranty_ends_on = $5::date, revisions_included = $6 where request_id = $1",
      [requestId, text, user.id, warrantyDays, endsOn, revisionsIncluded],
    );
    await db.query("update client_project_requests set status = 'completed', closed_at = now(), last_activity_at = now() where id = $1", [requestId]);
    const updateId = await addUpdate(db, r, user.id, "handover", `Project completed and handed over. ${text}`);
    await notifyOrgRoles(db, r.org_id, CLIENT_ROLES, { kind: "project_update", severity: "success", title: `${r.ref} is complete`, body: "Your handover notes are on the project page.", link: `/projects/${requestId}`, dedupeKey: `project:${requestId}:update:${updateId}` });
    await recordAudit({ orgId: r.org_id, actorUserId: user.id, actorKind: "agency", action: "project.handover_recorded", targetType: "project_request", targetId: requestId, result: "success", metadata: { ref: r.ref } }, db);
  });
}

export async function completeReviewTask(user: SessionUser, taskId: string) {
  await withSystem(async (db) => {
    const t = (await db.query<{ request_id: string }>("select request_id from project_review_tasks where id = $1 and status = 'open'", [taskId])).rows[0];
    if (!t) throw new AppError("not_found", "Task not found.");
    const r = await authorizeRequest(db, user, t.request_id);
    await db.query("update project_review_tasks set status = 'done', completed_at = now(), completed_by = $2 where id = $1", [taskId, user.id]);
    await recordAudit({ orgId: r.org_id, actorUserId: user.id, actorKind: "agency", action: "project.task_completed", targetType: "project_request", targetId: t.request_id, result: "success" }, db);
  });
}

/** Clients that have project requests inside the viewer's scope, for the queue's client filter. */
export async function listProjectClients(user: SessionUser): Promise<Array<{ id: string; name: string }>> {
  if (!isStaff(user)) throw new AppError("forbidden", "Agency access is required.");
  const view = await withSystem((db) => db.query<{ allowed: boolean }>("select coalesce(app.user_has_agency_permission($1,'projects.view'),false) as allowed", [user.id]));
  if (view.rows[0]?.allowed !== true) throw new AppError("forbidden", "Your role does not allow viewing client projects.");
  const { rows } = await withSystem((db) =>
    db.query<{ id: string; name: string }>(
      `select distinct o.id, o.name from client_project_requests r join organizations o on o.id = r.org_id
       where app.user_can_access_org($1,r.org_id) order by o.name`,
      [user.id],
    ),
  );
  return rows;
}
