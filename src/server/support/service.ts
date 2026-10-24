import "server-only";
import { z } from "zod";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { sendAgencySlackAlert } from "@/server/notifications";
import type { OrgContext } from "@/server/tenancy/context";
import {
  AFFECTED_FEATURES, ALL_CATEGORIES, CLIENT_URGENCIES, PRIORITIES, REQUEST_TYPES, REQUEST_TYPE_LABELS, TICKET_STATUSES, categoryLabel, clientCanReopen,
  isCategoryForType, isAwaitingAgency, type FeedbackStage, type RequestType, type TicketPriority, type TicketStatus,
} from "@/lib/support/lifecycle";
import { cleanText, likePattern, sanitizeDiagnostics, type Diagnostics } from "@/lib/support/content";
import { firstName } from "@/lib/utils";
import { loadSupportSettings, clientExpectationText } from "@/server/support/settings";
import { recordTicketEvent } from "@/server/support/events";
import { agencyHandlers, dispatchSupportNotice, sendQueuedSupportEmails } from "@/server/support/notify";
import { ensureResponseClock } from "@/server/support/response-clock";
import { applyStatusChange } from "@/server/support/lifecycle";
import { bindStagedAttachments } from "@/server/support/attachments";
import { requestChangesEnabled } from "@/server/support/change-feature";
import { linkedChangeFor } from "@/server/support/change";
import { createChangeOrderTx } from "@/server/projects/change-orders";
import { REQUEST_CHANGES_NOT_ENABLED_MESSAGE, changeTargetFor, projectTakesChangeRequest } from "@/lib/support/change";
import type { TicketCore } from "@/server/support/access";
import type { ClientRequestDetail, RequestListItem, RequestPage, ThreadAttachment, ThreadMessage, TimelineEntry } from "@/server/support/types";

export { TICKET_STATUSES };
export type { TicketStatus };

// ---------------------------------------------------------------------------
// Creating a request
// ---------------------------------------------------------------------------

const PAGE_PATH = /^\/[A-Za-z0-9/_-]*$/;

export const submitRequestSchema = z.object({
  requestType: z.enum(REQUEST_TYPES).default("support"),
  subject: z.string().trim().min(3, "Add a short title.").max(160),
  /** The description. For an issue report it can be left out when `issue.happened` is given. */
  message: z.string().trim().max(5000).optional(),
  issue: z.object({
    happened: z.string().trim().max(3000).optional(),
    expected: z.string().trim().max(1500).optional(),
    steps: z.string().trim().max(1500).optional(),
  }).optional(),
  category: z.string().refine((c) => ALL_CATEGORIES.includes(c), "Choose what this is about.").default("general"),
  affectedFeature: z.enum(AFFECTED_FEATURES).optional(),
  clientUrgency: z.enum(CLIENT_URGENCIES).optional(),
  pageContext: z.string().max(200).regex(PAGE_PATH).optional().catch(undefined),
  projectId: z.string().uuid().optional(),
  /** A change request about an agreed project can also be filed as a change to what was agreed (the project's change list), which the team then prices or declines. */
  asChangeOrder: z.boolean().optional(),
  idempotencyKey: z.string().min(8).max(80).optional(),
  attachmentIds: z.array(z.string().uuid()).max(10).default([]),
  /** Must be true for any technical details to be stored. */
  shareDiagnostics: z.boolean().default(false),
  diagnostics: z.unknown().optional(),
  /** Older callers sent a priority. Clients no longer set the team's priority; it is read as how urgent the person says it is. */
  priority: z.enum(PRIORITIES).optional(),
});
/** Kept for the callers that existed before request types. */
export const newTicketSchema = submitRequestSchema;

/** The text of a request as the team reads it. An issue report keeps its three answers under plain headings. */
export function composeRequestBody(data: z.infer<typeof submitRequestSchema>): string {
  if (data.requestType === "issue" && data.issue?.happened) {
    const parts = [`What happened:\n${data.issue.happened}`];
    if (data.issue.expected) parts.push(`What I expected:\n${data.issue.expected}`);
    if (data.issue.steps) parts.push(`Steps to reproduce:\n${data.issue.steps}`);
    if (data.message) parts.push(`More details:\n${data.message}`);
    return cleanText(parts.join("\n\n"), 5000);
  }
  return cleanText(data.message ?? "", 5000);
}

export interface SubmitResult {
  id: string;
  ref: string;
  status: TicketStatus;
  /** True when this key had already created the request: nothing new was made. */
  existing: boolean;
  externalNotification: string;
  expectation: string | null;
  /** The change on the project's list this request was also filed as, if the person asked for that. */
  changeOrderRef?: string | null;
}

function urgencyFromLegacy(priority: string | undefined) {
  return priority === "urgent" ? "blocking" : priority === "high" ? "soon" : null;
}

export async function submitRequest(ctx: OrgContext, input: z.input<typeof submitRequestSchema>): Promise<SubmitResult> {
  if (!ctx.can("support.use")) throw new AppError("forbidden", "Your role can't open support requests.");
  const parsed = submitRequestSchema.safeParse(input);
  if (!parsed.success) throw new AppError("invalid_input", parsed.error.issues[0]?.message ?? "Check the form and try again.");
  const data = parsed.data;
  const type: RequestType = data.requestType;
  if (type !== "support" && !isCategoryForType(type, data.category)) throw new AppError("invalid_input", "Choose what this is about.");
  const body = composeRequestBody(data);
  if (body.length < 5) throw new AppError("invalid_input", type === "issue" ? "Tell us what happened." : "Tell us a little more.");
  const subject = cleanText(data.subject, 160).replace(/\s*\n\s*/g, " ");
  if (subject.length < 3) throw new AppError("invalid_input", "Add a short title.");
  // Request a Change: what it is about is read from the category, a project target needs a project, and every other target must not name one (the database keeps the two equal).
  const changeTarget = type === "change" ? changeTargetFor(data.category) : null;
  if (type === "change") {
    if (!changeTarget) throw new AppError("invalid_input", "Choose what the change is about.");
    if (changeTarget === "project" && !data.projectId) throw new AppError("invalid_input", "Choose the project the change is about.");
    if (changeTarget !== "project" && data.projectId) throw new AppError("invalid_input", "Choose \"A custom project\" to ask for a change to a project.");
    if (data.asChangeOrder && changeTarget !== "project") throw new AppError("invalid_input", "Only a change to a custom project can be filed as a change to what was agreed.");
    if (data.asChangeOrder && !ctx.can("projects.request")) throw new AppError("forbidden", "Only a workspace owner or admin can ask for a change to what was agreed on a project.");
    if (!(await requestChangesEnabled(ctx.org.orgId)) || ctx.org.kind !== "client") throw new AppError("not_enabled", REQUEST_CHANGES_NOT_ENABLED_MESSAGE);
  } else {
    // The change categories belong to a change request alone: another type never carries one, so a change is never filed as a plain question.
    if (changeTargetFor(data.category)) throw new AppError("invalid_input", "Choose what this is about.");
    if (data.asChangeOrder) throw new AppError("invalid_input", "Only a change request can be filed as a change to a project.");
  }
  const settings = await loadSupportSettings();

  // A retry of the same submission (double click, dropped connection) returns the request that already exists.
  if (data.idempotencyKey) {
    const found = await withSystem(async (db) =>
      (await db.query<{ id: string; ref: string; status: TicketStatus; priority: string; external_notification: string }>(
        "select id, ref, status, priority, external_notification from support_tickets where org_id = $1 and created_by = $2 and idempotency_key = $3",
        [ctx.org.orgId, ctx.user.id, data.idempotencyKey],
      )).rows[0],
    );
    if (found) return { id: found.id, ref: found.ref, status: found.status, existing: true, externalNotification: found.external_notification, expectation: clientExpectationText(settings, "first", found.priority) };
  }
  const limit = await consumeRateLimit(RATE_LIMITS.supportTicketByUser, ctx.user.id);
  if (!limit.allowed) throw new AppError("rate_limited", "You've opened several requests recently. Please add to an existing one.");

  const priority = settings.defaultPriority[type];
  const diagnostics = data.shareDiagnostics ? sanitizeDiagnostics(data.diagnostics) : null;
  const urgency = data.clientUrgency ?? urgencyFromLegacy(data.priority);
  const stage: FeedbackStage | null = type === "feedback" ? "received" : null;

  const outcome = await withSystem(async (db) => {
    if (data.projectId) {
      const own = await db.query<{ status: string }>("select status from client_project_requests where id = $1 and org_id = $2", [data.projectId, ctx.org.orgId]);
      if (!own.rows[0]) throw new AppError("not_found", "Project not found.");
      // A change belongs to a project that was agreed (or finished); before that, the project's own conversation and quote are the place for it.
      if (type === "change" && !projectTakesChangeRequest(own.rows[0].status)) throw new AppError("conflict", "Changes can be asked for once a project is agreed. Until then, use the project's conversation.");
    }
    const inserted = await db.query<{ id: string; ref: string }>(
      `insert into support_tickets (org_id, created_by, subject, category, priority, status, request_type, affected_feature, client_urgency, feedback_stage, diagnostics, page_context, project_id, idempotency_key)
       values ($1, $2, $3, $4, $5, 'new', $6, $7, $8, $9, $10, $11, $12, $13)
       on conflict (org_id, created_by, idempotency_key) where idempotency_key is not null do nothing returning id, ref`,
      [ctx.org.orgId, ctx.user.id, subject, data.category, priority, type, data.affectedFeature ?? null, urgency, stage, diagnostics ? JSON.stringify(diagnostics) : null, data.pageContext ?? null, data.projectId ?? null, data.idempotencyKey ?? null],
    );
    const t = inserted.rows[0];
    if (!t) {
      // Two identical submissions arrived together; the other one won.
      const again = await db.query<{ id: string; ref: string; status: TicketStatus; priority: string; external_notification: string }>(
        "select id, ref, status, priority, external_notification from support_tickets where org_id = $1 and created_by = $2 and idempotency_key = $3",
        [ctx.org.orgId, ctx.user.id, data.idempotencyKey],
      );
      return { existing: again.rows[0], created: null, changeOrderRef: null };
    }
    const message = await db.query<{ id: string }>(
      "insert into support_messages (ticket_id, org_id, author_id, author_kind, body) values ($1, $2, $3, 'client', $4) returning id",
      [t.id, ctx.org.orgId, ctx.user.id, body],
    );
    await bindStagedAttachments(db, { ticketId: t.id, orgId: ctx.org.orgId, messageId: message.rows[0].id, userId: ctx.user.id, ids: data.attachmentIds, visibility: "client", maxCount: settings.maxAttachmentsPerMessage });
    // The team's own record of what kind of change this is (and, for a project, which). It is not shown to the client and says nothing about price or timing.
    if (changeTarget) {
      await db.query("insert into support_ticket_change (ticket_id, org_id, target_kind, project_id) values ($1, $2, $3, $4)", [t.id, ctx.org.orgId, changeTarget, data.projectId ?? null]);
    }
    // Filed as a change to what was agreed too: one request and one entry on the project's change list, linked, made in the same transaction.
    const changeOrder = data.asChangeOrder && data.projectId
      ? await createChangeOrderTx(db, { orgId: ctx.org.orgId, orgName: ctx.org.name, userId: ctx.user.id }, data.projectId, { title: subject, description: body.slice(0, 4000), idempotencyKey: data.idempotencyKey, ticketId: t.id })
      : null;
    await recordTicketEvent(db, { ticketId: t.id, orgId: ctx.org.orgId, kind: "created", actorUserId: ctx.user.id, actorKind: "client" });
    await ensureResponseClock(db, { id: t.id, org_id: ctx.org.orgId, priority, status: "new", first_responded_at: null }, { settings });
    await dispatchSupportNotice(db, {
      event: "request_submitted",
      ticket: { id: t.id, org_id: ctx.org.orgId, ref: t.ref, subject },
      eventKey: `submitted:${t.id}`,
      recipients: await agencyHandlers(db, { org_id: ctx.org.orgId, assigned_to: null }),
      title: `${t.ref}: ${subject}`,
      body: `${ctx.org.name} · ${REQUEST_TYPE_LABELS[type].label} · ${categoryLabel(data.category)}`,
      severity: urgency === "blocking" ? "warning" : "info",
    });
    await recordAudit(
      { orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "support.ticket_created", targetType: "support_ticket", targetId: t.id, result: "success", metadata: { ref: t.ref, type, category: data.category, attachments: data.attachmentIds.length, diagnostics: Boolean(diagnostics) } },
      db,
    );
    return { existing: null, created: t, changeOrderRef: changeOrder?.ref ?? null };
  });

  if (!outcome.created) {
    const e = outcome.existing;
    return { id: e.id, ref: e.ref, status: e.status, existing: true, externalNotification: e.external_notification, expectation: clientExpectationText(settings, "first", e.priority) };
  }
  const ticket = outcome.created;
  // The outside alert carries no message text: only the reference, workspace name, type and category.
  const external = await sendAgencySlackAlert(`New iAcquire ${REQUEST_TYPE_LABELS[type].label.toLowerCase()} ${ticket.ref} from ${ctx.org.name} (${data.category}).`);
  await withSystem((db) => db.query("update support_tickets set external_notification = $2 where id = $1", [ticket.id, external]));
  await sendQueuedSupportEmails(ticket.id);
  return { id: ticket.id, ref: ticket.ref, status: "new", existing: false, externalNotification: external, expectation: clientExpectationText(settings, "first", priority), changeOrderRef: outcome.changeOrderRef };
}

/** The earlier entry point, kept for existing callers (help widget, maintenance, CRM setup). */
export async function createTicket(ctx: OrgContext, input: z.input<typeof submitRequestSchema>) {
  return submitRequest(ctx, input);
}

// ---------------------------------------------------------------------------
// Listing (the client's own requests)
// ---------------------------------------------------------------------------

export const CLIENT_STATUS_FILTERS = ["all", "open", "in_progress", "waiting", "resolved", "closed"] as const;
export type ClientStatusFilter = (typeof CLIENT_STATUS_FILTERS)[number];

export interface MyRequestsQuery {
  status?: ClientStatusFilter;
  requestType?: RequestType;
  q?: string;
  sort?: "updated" | "newest" | "oldest" | "status";
  /** Owners and managers can look at only their own requests. */
  scope?: "all" | "mine";
  page?: number;
  pageSize?: number;
}

const STATUS_SQL: Record<Exclude<ClientStatusFilter, "all">, string> = {
  open: "t.status in ('new', 'open')",
  in_progress: "t.status = 'in_progress'",
  waiting: "t.status = 'waiting_for_client'",
  resolved: "t.status = 'resolved'",
  closed: "t.status = 'closed'",
};

interface ListRow {
  id: string; ref: string; subject: string; category: string; request_type: RequestType; status: TicketStatus; feedback_stage: FeedbackStage | null;
  client_urgency: string | null; affected_feature: string | null; created_at: Date; last_message_at: Date; created_by_name: string | null; is_assigned: boolean;
  has_unread_reply: boolean; total: string;
}

const toListItem = (r: ListRow): RequestListItem => ({
  id: r.id, ref: r.ref, subject: r.subject, category: r.category, requestType: r.request_type, status: r.status, feedbackStage: r.feedback_stage,
  clientUrgency: r.client_urgency, affectedFeature: r.affected_feature, createdAt: new Date(r.created_at).toISOString(), lastActivityAt: new Date(r.last_message_at).toISOString(),
  createdByName: r.created_by_name, isAssigned: r.is_assigned, hasUnreadReply: r.has_unread_reply,
});

export async function listMyRequests(ctx: OrgContext, query: MyRequestsQuery = {}): Promise<RequestPage<RequestListItem>> {
  if (!ctx.can("support.use")) throw new AppError("forbidden", "Your role can't open support requests.");
  const pageSize = Math.min(50, Math.max(1, Math.floor(query.pageSize ?? 10)));
  const page = Math.max(1, Math.floor(query.page ?? 1));
  const seesAll = ctx.can("support.view_all") && query.scope !== "mine";
  const params: unknown[] = [ctx.org.orgId];
  const where = ["t.org_id = $1"];
  if (!seesAll) {
    params.push(ctx.user.id);
    where.push(`t.created_by = $${params.length}`);
  }
  if (query.status && query.status !== "all") where.push(STATUS_SQL[query.status]);
  if (query.requestType && (REQUEST_TYPES as readonly string[]).includes(query.requestType)) {
    params.push(query.requestType);
    where.push(`t.request_type = $${params.length}`);
  }
  const q = (query.q ?? "").trim().slice(0, 100);
  if (q) {
    params.push(likePattern(q));
    // Public messages only: row-level security hides internal notes from this query as well.
    where.push(`(t.subject ilike $${params.length} or t.ref ilike $${params.length} or exists (select 1 from support_messages m where m.ticket_id = t.id and not m.internal and m.author_kind <> 'system' and m.body ilike $${params.length}))`);
  }
  const order = {
    updated: "t.last_message_at desc",
    newest: "t.created_at desc",
    oldest: "t.created_at asc",
    status: "case t.status when 'waiting_for_client' then 0 when 'new' then 1 when 'open' then 2 when 'in_progress' then 3 when 'resolved' then 4 else 5 end, t.last_message_at desc",
  }[query.sort ?? "updated"];
  params.push(pageSize, (page - 1) * pageSize);
  return withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<ListRow>(
      `select t.id, t.ref, t.subject, t.category, t.request_type, t.status, t.feedback_stage, t.client_urgency, t.affected_feature, t.created_at, t.last_message_at,
         cu.full_name as created_by_name, (t.assigned_to is not null) as is_assigned,
         exists (select 1 from support_messages m where m.ticket_id = t.id and m.author_kind = 'agency' and not m.internal and m.created_at > coalesce(t.client_last_read_at, t.created_at)) as has_unread_reply,
         count(*) over ()::text as total
       from support_tickets t left join users cu on cu.id = t.created_by
       where ${where.join(" and ")} order by ${order} limit $${params.length - 1} offset $${params.length}`,
      params,
    );
    return { items: rows.map(toListItem), total: rows[0] ? Number(rows[0].total) : 0, page, pageSize };
  });
}

/** Counts for the filter tabs on My Requests. */
export async function countMyRequests(ctx: OrgContext, scope: "all" | "mine" = "all"): Promise<Record<ClientStatusFilter, number>> {
  const seesAll = ctx.can("support.view_all") && scope !== "mine";
  const { rows } = await withUser(ctx.user.id, (db) =>
    db.query<{ status: TicketStatus; n: number }>(
      `select t.status, count(*)::int as n from support_tickets t where t.org_id = $1 and ($3 or t.created_by = $2) group by t.status`,
      [ctx.org.orgId, ctx.user.id, seesAll],
    ),
  );
  const by = (...s: TicketStatus[]) => rows.filter((r) => s.includes(r.status)).reduce((a, r) => a + r.n, 0);
  return { all: by(...TICKET_STATUSES), open: by("new", "open"), in_progress: by("in_progress"), waiting: by("waiting_for_client"), resolved: by("resolved"), closed: by("closed") };
}

/** Legacy shape used by the help widget and older callers. */
export async function listTickets(ctx: OrgContext) {
  const page = await listMyRequests(ctx, { pageSize: 50 });
  return page.items.map((t) => ({ id: t.id, ref: t.ref, subject: t.subject, category: t.category, status: t.status, last_message_at: new Date(t.lastActivityAt), created_at: new Date(t.createdAt), created_by_name: t.createdByName, is_assigned: t.isAssigned }));
}

// ---------------------------------------------------------------------------
// One request, as its owner sees it
// ---------------------------------------------------------------------------

interface DetailRow extends ListRow {
  priority: TicketPriority; resolved_at: Date | null; closed_at: Date | null; reopened_count: number; diagnostics: Diagnostics | null; project_id: string | null;
  first_responded_at: Date | null; org_id: string; created_by: string | null; assigned_to: string | null; updated_at: Date; client_last_read_at: Date | null; agency_last_read_at: Date | null;
}

async function namesFor(ids: string[], orgId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const { rows } = await withSystem((db) =>
    db.query<{ id: string; full_name: string | null; email: string; platform_role: string; member: boolean }>(
      `select u.id, u.full_name, u.email::text as email, u.platform_role,
         exists (select 1 from organization_memberships m where m.user_id = u.id and m.org_id = $2) as member
       from users u where u.id = any($1::uuid[])`,
      [ids, orgId],
    ),
  );
  for (const r of rows) {
    // The team shows by first name only; a colleague on the client's side shows by name.
    if (r.platform_role !== "none") out.set(r.id, firstName(r.full_name) || "iAcquire Support");
    else if (r.member) out.set(r.id, r.full_name?.trim() || r.email.split("@")[0]);
  }
  return out;
}

export async function getRequestDetail(ctx: OrgContext, ticketId: string): Promise<ClientRequestDetail | null> {
  if (!ctx.can("support.use")) throw new AppError("forbidden", "Your role can't open support requests.");
  if (!/^[0-9a-f-]{36}$/i.test(ticketId)) return null;
  const settings = await loadSupportSettings();
  const loaded = await withUser(ctx.user.id, async (db) => {
    const t = (await db.query<DetailRow>(
      `select t.id, t.ref, t.subject, t.category, t.request_type, t.status, t.priority, t.feedback_stage, t.client_urgency, t.affected_feature, t.created_at, t.updated_at, t.last_message_at,
         t.resolved_at, t.closed_at, t.reopened_count, t.diagnostics, t.project_id, t.first_responded_at, t.org_id, t.created_by, t.assigned_to, t.client_last_read_at, t.agency_last_read_at,
         cu.full_name as created_by_name, (t.assigned_to is not null) as is_assigned, false as has_unread_reply, '1' as total
       from support_tickets t left join users cu on cu.id = t.created_by where t.id = $1 and t.org_id = $2`,
      [ticketId, ctx.org.orgId],
    )).rows[0];
    if (!t) return null;
    // Row-level security keeps internal notes, internal files and internal timeline entries out of these reads.
    const messages = (await db.query<{ id: string; author_kind: "client" | "agency" | "system"; author_id: string | null; body: string; internal: boolean; created_at: Date; client_message_id: string | null }>(
      "select id, author_kind, author_id, body, internal, created_at, client_message_id from support_messages where ticket_id = $1 and not internal order by created_at asc, id asc",
      [ticketId],
    )).rows;
    const attachments = (await db.query<{ id: string; message_id: string | null; filename: string; mime_type: string; size_bytes: number; visibility: "client" | "internal" }>(
      `select a.id, a.message_id, f.filename, f.mime_type, f.size_bytes, a.visibility from support_attachments a join private_files f on f.id = a.private_file_id and f.status = 'ready'
       where a.ticket_id = $1 and a.status = 'attached' and a.visibility = 'client' order by a.created_at`,
      [ticketId],
    )).rows;
    const events = (await db.query<{ id: string; kind: string; created_at: Date; actor_kind: "client" | "agency" | "system"; from_value: string | null; to_value: string | null; detail: string | null }>(
      "select id, kind, created_at, actor_kind, from_value, to_value, detail from support_ticket_events where ticket_id = $1 and visibility = 'client' order by seq asc",
      [ticketId],
    )).rows;
    return { t, messages, attachments, events };
  });
  if (!loaded) return null;
  const { t, messages, attachments, events } = loaded;
  const names = await namesFor([...new Set(messages.map((m) => m.author_id).filter((x): x is string => Boolean(x)))], ctx.org.orgId);
  const byMessage = new Map<string, ThreadAttachment[]>();
  for (const a of attachments) {
    if (!a.message_id) continue;
    const list = byMessage.get(a.message_id) ?? [];
    list.push({ id: a.id, filename: a.filename, mimeType: a.mime_type, sizeBytes: a.size_bytes, visibility: a.visibility });
    byMessage.set(a.message_id, list);
  }
  const thread: ThreadMessage[] = messages.map((m) => ({
    id: m.id, authorKind: m.author_kind, authorName: m.author_kind === "agency" ? (m.author_id ? names.get(m.author_id) ?? "iAcquire Support" : "iAcquire Support") : m.author_id ? names.get(m.author_id) ?? null : null,
    body: m.body, internal: false, createdAt: new Date(m.created_at).toISOString(), clientMessageId: m.client_message_id, attachments: byMessage.get(m.id) ?? [],
  }));
  const timeline: TimelineEntry[] = events.map((e) => ({ id: e.id, kind: e.kind, createdAt: new Date(e.created_at).toISOString(), actorKind: e.actor_kind, from: e.from_value, to: e.to_value, detail: e.detail }));
  const firstClientMessage = messages.find((m) => m.author_kind === "client");
  const canReopen = clientCanReopen({ status: t.status, resolvedAt: t.resolved_at, windowDays: settings.reopenWindowDays });
  let blocked: string | null = null;
  if (t.status === "closed") blocked = "This request is closed. Open a new one if you still need help.";
  else if (t.status === "resolved" && !canReopen) blocked = "This request was resolved a while ago. Open a new request if you still need help.";
  const waitingOnTeam = isAwaitingAgency(t.status);
  return {
    ticket: {
      ...toListItem(t), description: firstClientMessage?.body ?? "", resolvedAt: t.resolved_at ? new Date(t.resolved_at).toISOString() : null,
      closedAt: t.closed_at ? new Date(t.closed_at).toISOString() : null, reopenedCount: t.reopened_count, diagnostics: t.diagnostics, projectId: t.project_id,
    },
    messages: thread,
    timeline,
    teamLastReadAt: t.agency_last_read_at ? new Date(t.agency_last_read_at).toISOString() : null,
    canReply: blocked === null,
    replyBlockedReason: blocked,
    canReopen,
    expectation: waitingOnTeam ? clientExpectationText(settings, t.first_responded_at ? "follow_up" : "first", t.priority) : null,
    maxAttachmentMb: settings.maxAttachmentMb,
    maxAttachments: settings.maxAttachmentsPerMessage,
    reopenWindowDays: settings.reopenWindowDays,
    linkedChange: t.request_type === "change" ? await linkedChangeFor(ctx.user.id, ticketId) : null,
  };
}

/** Marks the team's replies as read for this person. Only the opener is tracked: that is who the "new reply" dot is for. */
export async function markRequestRead(ctx: OrgContext, ticketId: string): Promise<void> {
  if (!ctx.can("support.use")) return;
  await withSystem((db) =>
    db.query("update support_tickets set client_last_read_at = now() where id = $1 and org_id = $2 and created_by = $3", [ticketId, ctx.org.orgId, ctx.user.id]),
  );
}

// ---------------------------------------------------------------------------
// Replying and reopening
// ---------------------------------------------------------------------------

export const clientMessageSchema = z.object({
  body: z.string().max(5000),
  clientMessageId: z.string().uuid().optional(),
  attachmentIds: z.array(z.string().uuid()).max(10).default([]),
});

export interface PostedMessage { id: string; existing: boolean; createdAt: string }

async function loadOwnTicket(ctx: OrgContext, ticketId: string): Promise<TicketCore & { priority: TicketPriority }> {
  // Read as the person (row-level security), so a request that is not theirs to see reads as not found.
  const row = await withUser(ctx.user.id, async (db) =>
    (await db.query<TicketCore>(
      `select id, ref, org_id, created_by, subject, request_type, category, status, priority, assigned_to, feedback_stage, first_responded_at, resolved_at, reopened_count
       from support_tickets where id = $1 and org_id = $2`,
      [ticketId, ctx.org.orgId],
    )).rows[0],
  );
  if (!row) throw new AppError("not_found", "Support request not found.");
  return row;
}

/**
 * Re-reads the request under a lock inside the write transaction. The earlier read decides what to tell a person quickly; what is written is decided
 * here, so a reply that raced the team's resolve or close acts on what is true now (a closed request is never flipped open without being reopened).
 */
async function lockOwnTicket(db: Queryable, ctx: OrgContext, ticketId: string): Promise<TicketCore> {
  const row = (await db.query<TicketCore>(
    `select id, ref, org_id, created_by, subject, request_type, category, status, priority, assigned_to, feedback_stage, first_responded_at, resolved_at, reopened_count
     from support_tickets where id = $1 and org_id = $2 for update`,
    [ticketId, ctx.org.orgId],
  )).rows[0];
  if (!row) throw new AppError("not_found", "Support request not found.");
  return row;
}

export async function postClientMessage(ctx: OrgContext, ticketId: string, input: z.input<typeof clientMessageSchema>): Promise<PostedMessage> {
  if (!ctx.can("support.use")) throw new AppError("forbidden", "Your role can't reply to support requests.");
  const parsed = clientMessageSchema.safeParse(input);
  if (!parsed.success) throw new AppError("invalid_input", "That reply could not be read. Please try again.");
  const text = cleanText(parsed.data.body, 5000);
  if (!text) throw new AppError("invalid_input", "Write a reply first.");
  const t = await loadOwnTicket(ctx, ticketId);
  const settings = await loadSupportSettings();

  // The same message sent twice (retry after a dropped connection) returns the one that was saved.
  if (parsed.data.clientMessageId) {
    const dup = await withUser(ctx.user.id, async (db) =>
      (await db.query<{ id: string; created_at: Date }>("select id, created_at from support_messages where ticket_id = $1 and client_message_id = $2", [ticketId, parsed.data.clientMessageId])).rows[0],
    );
    if (dup) return { id: dup.id, existing: true, createdAt: new Date(dup.created_at).toISOString() };
  }
  const limit = await consumeRateLimit(RATE_LIMITS.supportReplyByUser, ctx.user.id);
  if (!limit.allowed) throw new AppError("rate_limited", "You're sending replies quickly. Please wait a little and try again.");
  if (t.status === "closed") throw new AppError("conflict", "This request is closed. Open a new one if you still need help.");
  if (t.status === "resolved" && !clientCanReopen({ status: t.status, resolvedAt: t.resolved_at, windowDays: settings.reopenWindowDays })) {
    throw new AppError("conflict", "This request was resolved a while ago. Open a new request if you still need help.");
  }

  const posted = await withSystem(async (db) => {
    // What is written follows the request as it is now (locked), not the read above: the team may have resolved or closed it in between.
    const cur = await lockOwnTicket(db, ctx, ticketId);
    const inserted = await db.query<{ id: string; created_at: Date }>(
      `insert into support_messages (ticket_id, org_id, author_id, author_kind, body, client_message_id) values ($1, $2, $3, 'client', $4, $5)
       on conflict (ticket_id, client_message_id) where client_message_id is not null do nothing returning id, created_at`,
      [ticketId, ctx.org.orgId, ctx.user.id, text, parsed.data.clientMessageId ?? null],
    );
    if (!inserted.rows[0]) {
      const dup = await db.query<{ id: string; created_at: Date }>("select id, created_at from support_messages where ticket_id = $1 and client_message_id = $2", [ticketId, parsed.data.clientMessageId]);
      return { id: dup.rows[0].id, existing: true, createdAt: new Date(dup.rows[0].created_at).toISOString() };
    }
    // Refusing here rolls the message back with everything else this transaction did.
    if (cur.status === "closed") throw new AppError("conflict", "This request is closed. Open a new one if you still need help.");
    const reopeningNow = cur.status === "resolved";
    if (reopeningNow && !clientCanReopen({ status: cur.status, resolvedAt: cur.resolved_at, windowDays: settings.reopenWindowDays })) {
      throw new AppError("conflict", "This request was resolved a while ago. Open a new request if you still need help.");
    }
    const messageId = inserted.rows[0].id;
    await bindStagedAttachments(db, { ticketId, orgId: ctx.org.orgId, messageId, userId: ctx.user.id, ids: parsed.data.attachmentIds, visibility: "client", maxCount: settings.maxAttachmentsPerMessage });
    await db.query("update support_tickets set last_message_at = now() where id = $1", [ticketId]);
    let status = cur.status;
    if (reopeningNow) {
      await applyStatusChange(db, cur, "open", { userId: ctx.user.id, kind: "client" }, {});
      status = "open";
    } else if (cur.status === "waiting_for_client") {
      await applyStatusChange(db, cur, "open", { userId: ctx.user.id, kind: "client" }, { silent: true });
      status = "open";
    }
    await recordTicketEvent(db, { ticketId, orgId: ctx.org.orgId, kind: "reply", actorUserId: ctx.user.id, actorKind: "client" });
    await ensureResponseClock(db, { id: ticketId, org_id: ctx.org.orgId, priority: cur.priority, status, first_responded_at: cur.first_responded_at }, { settings });
    // The notice carries the reference, workspace and subject; what the client wrote stays in the portal.
    await dispatchSupportNotice(db, {
      event: "client_reply", ticket: { id: ticketId, org_id: ctx.org.orgId, ref: cur.ref, subject: cur.subject }, eventKey: `msg:${messageId}`,
      recipients: await agencyHandlers(db, { org_id: ctx.org.orgId, assigned_to: cur.assigned_to }),
      title: `${cur.ref}: new reply from ${ctx.org.name}`, body: cur.subject,
    });
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "support.client_reply", targetType: "support_ticket", targetId: ticketId, result: "success", metadata: { ref: cur.ref, attachments: parsed.data.attachmentIds.length, reopened: reopeningNow } }, db);
    return { id: messageId, existing: false, createdAt: new Date(inserted.rows[0].created_at).toISOString() };
  });
  if (!posted.existing) await sendQueuedSupportEmails(ticketId);
  return posted;
}

/** Older callers: a plain-text reply. */
export async function clientReply(ctx: OrgContext, ticketId: string, body: string) {
  await postClientMessage(ctx, ticketId, { body });
}

/** Reopens a resolved request inside the agency's reopen window. */
export async function reopenRequest(ctx: OrgContext, ticketId: string, note?: string): Promise<void> {
  if (!ctx.can("support.use")) throw new AppError("forbidden", "Your role can't change support requests.");
  const t = await loadOwnTicket(ctx, ticketId);
  const settings = await loadSupportSettings();
  if (t.status !== "resolved") throw new AppError("conflict", "Only a resolved request can be reopened.");
  if (!clientCanReopen({ status: t.status, resolvedAt: t.resolved_at, windowDays: settings.reopenWindowDays })) {
    throw new AppError("conflict", "This request was resolved a while ago. Open a new request if you still need help.");
  }
  const text = note ? cleanText(note, 1000) : "";
  await withSystem(async (db) => {
    // Locked and re-read: if the team closed the request after the earlier read, this is refused instead of flipping it open.
    const cur = await lockOwnTicket(db, ctx, ticketId);
    if (cur.status !== "resolved") throw new AppError("conflict", "Only a resolved request can be reopened.");
    if (!clientCanReopen({ status: cur.status, resolvedAt: cur.resolved_at, windowDays: settings.reopenWindowDays })) {
      throw new AppError("conflict", "This request was resolved a while ago. Open a new request if you still need help.");
    }
    if (text) {
      await db.query("insert into support_messages (ticket_id, org_id, author_id, author_kind, body) values ($1, $2, $3, 'client', $4)", [ticketId, ctx.org.orgId, ctx.user.id, text]);
      await recordTicketEvent(db, { ticketId, orgId: ctx.org.orgId, kind: "reply", actorUserId: ctx.user.id, actorKind: "client", detail: null });
    }
    await db.query("update support_tickets set last_message_at = now() where id = $1", [ticketId]);
    await applyStatusChange(db, cur, "open", { userId: ctx.user.id, kind: "client" }, { note: text ? undefined : "Reopened by the client." });
  });
  await sendQueuedSupportEmails(ticketId);
}

// ---------------------------------------------------------------------------
// Compatibility: the agency-side functions callers imported from this module before the split
// ---------------------------------------------------------------------------

export { listAgencyTickets, getTicketForAgency, agencyReply, updateTicket } from "@/server/support/agency";
export type { TicketRow, TicketMessage } from "@/server/support/agency";

/** The earlier detail shape (status, thread) for callers that predate request types. Clients never get a priority or a team member's name. */
export async function getTicketForClient(ctx: OrgContext, ticketId: string) {
  const d = await getRequestDetail(ctx, ticketId);
  if (!d) return null;
  const t = d.ticket;
  return {
    ticket: {
      id: t.id, ref: t.ref, subject: t.subject, category: t.category, status: t.status, created_by_name: t.createdByName, is_assigned: t.isAssigned,
      assigned_to_name: null as string | null, created_at: new Date(t.createdAt), last_message_at: new Date(t.lastActivityAt),
    },
    messages: d.messages.map((m) => ({ id: m.id, author_kind: m.authorKind, author_name: m.authorName, body: m.body, internal: m.internal, created_at: new Date(m.createdAt) })),
  };
}
