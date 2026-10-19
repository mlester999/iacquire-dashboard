import "server-only";
import { z } from "zod";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import type { SessionUser } from "@/server/auth/service";
import {
  PRIORITIES, PRIORITY_RANK, REQUEST_TYPES, FEEDBACK_STAGES, TICKET_STATUSES, canTransition, isActiveStatus, isReopen,
  type FeedbackStage, type RequestType, type TicketPriority, type TicketStatus,
} from "@/lib/support/lifecycle";
import { cleanText, likePattern, type Diagnostics } from "@/lib/support/content";
import {
  assertAgencySupportPermission, isEligibleAssignee, listAssignableStaff, loadAgencySupportCaps, loadTicketForAgency, type AgencySupportCaps, type Assignee, type TicketCore,
} from "@/server/support/access";
import { loadSupportSettings } from "@/server/support/settings";
import { recordTicketEvent } from "@/server/support/events";
import { acknowledgeIfNew, applyStatusChange } from "@/server/support/lifecycle";
import { agencyManagers, clientParticipants, dispatchSupportNotice, sendQueuedSupportEmails } from "@/server/support/notify";
import { clearResponseClock, recomputeResponseClock, slaViewFor } from "@/server/support/response-clock";
import { bindStagedAttachments } from "@/server/support/attachments";
import type {
  AgencyListItem, AgencyListQuery, AgencyViewCounts, RequestPage, ThreadAttachment, ThreadMessage, TimelineEntry,
} from "@/server/support/types";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function throttle(user: SessionUser) {
  const limit = await consumeRateLimit(RATE_LIMITS.supportAgencyActionByUser, user.id);
  if (!limit.allowed) throw new AppError("rate_limited", "You're making changes very quickly. Please wait a moment.");
}

const actorOf = (user: SessionUser) => ({ userId: user.id, kind: "agency" as const });

/** Re-reads and locks the request inside the transaction, so two people acting at once see each other's changes. */
async function lock(db: Queryable, ticketId: string): Promise<TicketCore> {
  const { rows } = await db.query<TicketCore>(
    `select id, ref, org_id, created_by, subject, request_type, category, status, priority, assigned_to, feedback_stage, first_responded_at, resolved_at, reopened_count
     from support_tickets where id = $1 for update`,
    [ticketId],
  );
  if (!rows[0]) throw new AppError("not_found", "Support request not found.");
  return rows[0];
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

interface QueueRow {
  id: string; ref: string; subject: string; category: string; request_type: RequestType; status: TicketStatus; priority: TicketPriority; feedback_stage: FeedbackStage | null;
  client_urgency: string | null; created_at: Date; last_message_at: Date; org_id: string; org_name: string; created_by_name: string | null; assigned_to: string | null;
  assigned_to_name: string | null; first_responded_at: Date | null; escalated: boolean; client_waiting: boolean;
  response_due_at: Date | null; response_kind: "first" | "follow_up" | null; response_started_at: Date | null; total: string;
}

const ACTIVE = "t.status in ('new', 'open', 'in_progress', 'waiting_for_client')";

export async function listAgencyRequests(user: SessionUser, query: AgencyListQuery = {}): Promise<RequestPage<AgencyListItem> & { counts: AgencyViewCounts }> {
  await assertAgencySupportPermission(user, null, "agency.support.view");
  const caps = await loadAgencySupportCaps(user.id);
  const settings = await loadSupportSettings();
  const pageSize = Math.min(100, Math.max(1, Math.floor(query.pageSize ?? 25)));
  const page = Math.max(1, Math.floor(query.page ?? 1));
  // Without "see the full queue" the person works only the requests assigned to them.
  const scope = `app.user_can_access_org($1, t.org_id) and ($2 or t.assigned_to = $1)`;
  const base: unknown[] = [user.id, caps["agency.support.queue"]];
  const params = [...base];
  const where = [scope];
  const view = query.view ?? "active";
  const viewSql: Record<NonNullable<AgencyListQuery["view"]>, string | null> = {
    active: ACTIVE,
    unassigned: `${ACTIVE} and t.assigned_to is null`,
    mine: `${ACTIVE} and t.assigned_to = $1`,
    overdue: "t.status in ('new', 'open', 'in_progress') and ops.response_due_at is not null and ops.response_due_at < now()",
    escalated: `${ACTIVE} and ops.escalated_at is not null`,
    waiting_on_client: "t.status = 'waiting_for_client'",
    client_replied: `${ACTIVE} and exists (select 1 from support_messages m where m.ticket_id = t.id and m.author_kind = 'client' and m.created_at > coalesce(t.agency_last_read_at, t.created_at))`,
    resolved: "t.status = 'resolved'",
    closed: "t.status = 'closed'",
    all: null,
  };
  if (viewSql[view]) where.push(viewSql[view]!);
  if (query.status && (TICKET_STATUSES as readonly string[]).includes(query.status)) { params.push(query.status); where.push(`t.status = $${params.length}`); }
  if (query.requestType && (REQUEST_TYPES as readonly string[]).includes(query.requestType)) { params.push(query.requestType); where.push(`t.request_type = $${params.length}`); }
  if (query.category && /^[a-z_]{2,40}$/.test(query.category)) { params.push(query.category); where.push(`t.category = $${params.length}`); }
  if (query.priority && (PRIORITIES as readonly string[]).includes(query.priority)) { params.push(query.priority); where.push(`t.priority = $${params.length}`); }
  if (query.orgId && ID.test(query.orgId)) { params.push(query.orgId); where.push(`t.org_id = $${params.length}`); }
  if (query.assignee === "me") where.push("t.assigned_to = $1");
  else if (query.assignee === "unassigned") where.push("t.assigned_to is null");
  else if (query.assignee && ID.test(query.assignee)) { params.push(query.assignee); where.push(`t.assigned_to = $${params.length}`); }
  const q = (query.q ?? "").trim().slice(0, 100);
  if (q) {
    params.push(likePattern(q));
    const n = params.length;
    // The team may search internal notes too; clients' searches (service.ts) never can.
    where.push(`(t.subject ilike $${n} or t.ref ilike $${n} or o.name ilike $${n} or exists (select 1 from support_messages m where m.ticket_id = t.id and m.author_kind <> 'system' and m.body ilike $${n}))`);
  }
  const order = {
    priority: "case t.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end, t.last_message_at desc",
    latest: "t.last_message_at desc",
    oldest: "t.created_at asc",
    due: "ops.response_due_at asc nulls last, t.last_message_at desc",
  }[query.sort ?? "priority"];
  params.push(pageSize, (page - 1) * pageSize);
  const select = `t.id, t.ref, t.subject, t.category, t.request_type, t.status, t.priority, t.feedback_stage, t.client_urgency, t.created_at, t.last_message_at, t.org_id, o.name as org_name,
      cu.full_name as created_by_name, t.assigned_to, au.full_name as assigned_to_name, t.first_responded_at, (ops.escalated_at is not null) as escalated,
      exists (select 1 from support_messages m where m.ticket_id = t.id and m.author_kind = 'client' and m.created_at > coalesce(t.agency_last_read_at, t.created_at)) as client_waiting,
      ops.response_due_at, ops.response_kind, ops.response_started_at`;
  const from = `support_tickets t join organizations o on o.id = t.org_id left join support_ticket_ops ops on ops.ticket_id = t.id
      left join users cu on cu.id = t.created_by left join users au on au.id = t.assigned_to`;
  return withUser(user.id, async (db) => {
    const { rows } = await db.query<QueueRow>(
      `select ${select}, count(*) over ()::text as total from ${from} where ${where.join(" and ")} order by ${order} limit $${params.length - 1} offset $${params.length}`,
      params,
    );
    const c = (await db.query<Record<keyof AgencyViewCounts, number>>(
      `select count(*) filter (where ${ACTIVE})::int as active,
              count(*) filter (where ${ACTIVE} and t.assigned_to is null)::int as unassigned,
              count(*) filter (where ${ACTIVE} and t.assigned_to = $1)::int as mine,
              count(*) filter (where t.status in ('new', 'open', 'in_progress') and ops.response_due_at is not null and ops.response_due_at < now())::int as overdue,
              count(*) filter (where ${ACTIVE} and ops.escalated_at is not null)::int as escalated,
              count(*) filter (where t.status = 'waiting_for_client')::int as "waitingOnClient",
              count(*) filter (where ${ACTIVE} and exists (select 1 from support_messages m where m.ticket_id = t.id and m.author_kind = 'client' and m.created_at > coalesce(t.agency_last_read_at, t.created_at)))::int as "clientReplied"
       from support_tickets t left join support_ticket_ops ops on ops.ticket_id = t.id where ${scope}`,
      base,
    )).rows[0];
    const now = new Date();
    const items: AgencyListItem[] = rows.map((r) => ({
      id: r.id, ref: r.ref, subject: r.subject, category: r.category, requestType: r.request_type, status: r.status, priority: r.priority, feedbackStage: r.feedback_stage,
      clientUrgency: r.client_urgency, createdAt: new Date(r.created_at).toISOString(), lastActivityAt: new Date(r.last_message_at).toISOString(), orgId: r.org_id, orgName: r.org_name,
      createdByName: r.created_by_name, assignedToId: r.assigned_to, assignedToName: r.assigned_to_name, escalated: r.escalated, clientWaiting: r.client_waiting,
      firstRespondedAt: r.first_responded_at ? new Date(r.first_responded_at).toISOString() : null, sla: slaViewFor(r, settings, now),
    }));
    return { items, total: rows[0] ? Number(rows[0].total) : 0, page, pageSize, counts: c };
  });
}

// ---------------------------------------------------------------------------
// One request, as the team sees it
// ---------------------------------------------------------------------------

export interface AgencyRequestDetail {
  ticket: AgencyListItem & {
    description: string;
    affectedFeature: string | null;
    pageContext: string | null;
    diagnostics: Diagnostics | null;
    externalNotification: string;
    resolvedAt: string | null;
    closedAt: string | null;
    reopenedCount: number;
    projectId: string | null;
    escalation: { at: string; reason: string | null; byName: string | null } | null;
    clientLastReadAt: string | null;
    aiSummary: { text: string; at: string } | null;
  };
  messages: ThreadMessage[];
  timeline: TimelineEntry[];
  looseAttachments: ThreadAttachment[];
  links: Array<{ id: string; ref: string; subject: string; status: TicketStatus; kind: "related" | "duplicate_of" | "merged_into"; direction: "from" | "to" }>;
  recent: Array<{ id: string; ref: string; subject: string; status: TicketStatus; requestType: RequestType; createdAt: string }>;
  org: { id: string; name: string; status: string; timezone: string; ownerName: string | null; ownerEmail: string | null; openRequests: number };
  assignable: Assignee[];
  caps: AgencySupportCaps;
  maxAttachmentMb: number;
  maxAttachments: number;
}

export async function getAgencyRequest(user: SessionUser, ticketId: string): Promise<AgencyRequestDetail | null> {
  let core: TicketCore;
  try {
    core = await loadTicketForAgency(user, ticketId);
  } catch (error) {
    if (error instanceof AppError && error.code === "not_found") return null;
    throw error;
  }
  const settings = await loadSupportSettings();
  const caps = await loadAgencySupportCaps(user.id);
  const data = await withUser(user.id, async (db) => {
    const t = (await db.query<QueueRow & {
      affected_feature: string | null; page_context: string | null; diagnostics: Diagnostics | null; external_notification: string; resolved_at: Date | null; closed_at: Date | null;
      reopened_count: number; project_id: string | null; escalated_at: Date | null; escalation_reason: string | null; escalated_by_name: string | null; client_last_read_at: Date | null;
      ai_summary: string | null; ai_summary_at: Date | null;
    }>(
      `select t.id, t.ref, t.subject, t.category, t.request_type, t.status, t.priority, t.feedback_stage, t.client_urgency, t.created_at, t.last_message_at, t.org_id, o.name as org_name,
         cu.full_name as created_by_name, t.assigned_to, au.full_name as assigned_to_name, t.first_responded_at, (ops.escalated_at is not null) as escalated, false as client_waiting,
         ops.response_due_at, ops.response_kind, ops.response_started_at, '1' as total,
         t.affected_feature, t.page_context, t.diagnostics, t.external_notification, t.resolved_at, t.closed_at, t.reopened_count, t.project_id, ops.escalated_at, ops.escalation_reason,
         eu.full_name as escalated_by_name, t.client_last_read_at, ops.ai_summary, ops.ai_summary_at
       from support_tickets t join organizations o on o.id = t.org_id left join support_ticket_ops ops on ops.ticket_id = t.id
         left join users cu on cu.id = t.created_by left join users au on au.id = t.assigned_to left join users eu on eu.id = ops.escalated_by
       where t.id = $1`,
      [ticketId],
    )).rows[0];
    if (!t) return null;
    const messages = (await db.query<{ id: string; author_kind: "client" | "agency" | "system"; author_id: string | null; author_name: string | null; body: string; internal: boolean; created_at: Date; client_message_id: string | null }>(
      `select m.id, m.author_kind, m.author_id, u.full_name as author_name, m.body, m.internal, m.created_at, m.client_message_id
       from support_messages m left join users u on u.id = m.author_id where m.ticket_id = $1 order by m.created_at asc, m.id asc`,
      [ticketId],
    )).rows;
    const files = (await db.query<{ id: string; message_id: string | null; filename: string; mime_type: string; size_bytes: number; visibility: "client" | "internal" }>(
      `select a.id, a.message_id, f.filename, f.mime_type, f.size_bytes, a.visibility from support_attachments a join private_files f on f.id = a.private_file_id and f.status = 'ready'
       where a.ticket_id = $1 and a.status = 'attached' order by a.created_at`,
      [ticketId],
    )).rows;
    const events = (await db.query<{ id: string; kind: string; created_at: Date; actor_kind: "client" | "agency" | "system"; from_value: string | null; to_value: string | null; detail: string | null }>(
      "select id, kind, created_at, actor_kind, from_value, to_value, detail from support_ticket_events where ticket_id = $1 order by seq asc", [ticketId],
    )).rows;
    const links = (await db.query<{ id: string; ref: string; subject: string; status: TicketStatus; kind: "related" | "duplicate_of" | "merged_into"; direction: "from" | "to" }>(
      `select r.id, r.ref, r.subject, r.status, l.kind, case when l.ticket_id = $1 then 'from' else 'to' end as direction
       from support_ticket_links l join support_tickets r on r.id = case when l.ticket_id = $1 then l.related_ticket_id else l.ticket_id end
       where l.ticket_id = $1 or l.related_ticket_id = $1 order by l.created_at`,
      [ticketId],
    )).rows;
    const recent = (await db.query<{ id: string; ref: string; subject: string; status: TicketStatus; request_type: RequestType; created_at: Date }>(
      "select id, ref, subject, status, request_type, created_at from support_tickets where org_id = $1 and id <> $2 order by created_at desc limit 5", [t.org_id, ticketId],
    )).rows;
    const org = (await db.query<{ status: string; timezone: string; owner_name: string | null; owner_email: string | null; open_requests: number }>(
      `select o.status, o.timezone,
         (select u.full_name from organization_memberships m join users u on u.id = m.user_id where m.org_id = o.id and m.role = 'owner' and m.status = 'active' order by m.created_at limit 1) as owner_name,
         (select u.email::text from organization_memberships m join users u on u.id = m.user_id where m.org_id = o.id and m.role = 'owner' and m.status = 'active' order by m.created_at limit 1) as owner_email,
         (select count(*)::int from support_tickets x where x.org_id = o.id and x.status in ('new', 'open', 'in_progress', 'waiting_for_client')) as open_requests
       from organizations o where o.id = $1`,
      [t.org_id],
    )).rows[0];
    return { t, messages, files, events, links, recent, org };
  });
  if (!data) return null;
  const { t, messages, files, events, links, recent, org } = data;
  const byMessage = new Map<string, ThreadAttachment[]>();
  const loose: ThreadAttachment[] = [];
  for (const f of files) {
    const a: ThreadAttachment = { id: f.id, filename: f.filename, mimeType: f.mime_type, sizeBytes: f.size_bytes, visibility: f.visibility };
    if (!f.message_id) loose.push(a);
    else byMessage.set(f.message_id, [...(byMessage.get(f.message_id) ?? []), a]);
  }
  const firstClient = messages.find((m) => m.author_kind === "client");
  const assignable = caps["agency.support.assign"] || caps["agency.support.manage"] ? await listAssignableStaff(core.org_id) : [];
  return {
    ticket: {
      id: t.id, ref: t.ref, subject: t.subject, category: t.category, requestType: t.request_type, status: t.status, priority: t.priority, feedbackStage: t.feedback_stage,
      clientUrgency: t.client_urgency, createdAt: new Date(t.created_at).toISOString(), lastActivityAt: new Date(t.last_message_at).toISOString(), orgId: t.org_id, orgName: t.org_name,
      createdByName: t.created_by_name, assignedToId: t.assigned_to, assignedToName: t.assigned_to_name, escalated: t.escalated, clientWaiting: false,
      firstRespondedAt: t.first_responded_at ? new Date(t.first_responded_at).toISOString() : null, sla: slaViewFor(t, settings),
      description: firstClient?.body ?? "", affectedFeature: t.affected_feature, pageContext: t.page_context, diagnostics: t.diagnostics, externalNotification: t.external_notification,
      resolvedAt: t.resolved_at ? new Date(t.resolved_at).toISOString() : null, closedAt: t.closed_at ? new Date(t.closed_at).toISOString() : null, reopenedCount: t.reopened_count,
      projectId: t.project_id, escalation: t.escalated_at ? { at: new Date(t.escalated_at).toISOString(), reason: t.escalation_reason, byName: t.escalated_by_name } : null,
      clientLastReadAt: t.client_last_read_at ? new Date(t.client_last_read_at).toISOString() : null,
      aiSummary: t.ai_summary && t.ai_summary_at ? { text: t.ai_summary, at: new Date(t.ai_summary_at).toISOString() } : null,
    },
    messages: messages.map((m) => ({
      id: m.id, authorKind: m.author_kind, authorName: m.author_name, body: m.body, internal: m.internal, createdAt: new Date(m.created_at).toISOString(),
      clientMessageId: m.client_message_id, attachments: byMessage.get(m.id) ?? [],
    })),
    timeline: events.map((e) => ({ id: e.id, kind: e.kind, createdAt: new Date(e.created_at).toISOString(), actorKind: e.actor_kind, from: e.from_value, to: e.to_value, detail: e.detail })),
    looseAttachments: loose,
    links,
    recent: recent.map((r) => ({ id: r.id, ref: r.ref, subject: r.subject, status: r.status, requestType: r.request_type, createdAt: new Date(r.created_at).toISOString() })),
    org: { id: t.org_id, name: t.org_name, status: org.status, timezone: org.timezone, ownerName: org.owner_name, ownerEmail: org.owner_email, openRequests: org.open_requests },
    assignable,
    caps,
    maxAttachmentMb: settings.maxAttachmentMb,
    maxAttachments: settings.maxAttachmentsPerMessage,
  };
}

export async function markAgencyRead(user: SessionUser, ticketId: string): Promise<void> {
  await loadTicketForAgency(user, ticketId);
  await withSystem((db) => db.query("update support_tickets set agency_last_read_at = now() where id = $1", [ticketId]));
}

// ---------------------------------------------------------------------------
// Messages and notes
// ---------------------------------------------------------------------------

export const agencyMessageSchema = z.object({
  body: z.string().max(5000),
  internal: z.boolean().default(false),
  status: z.enum(TICKET_STATUSES).optional(),
  clientMessageId: z.string().uuid().optional(),
  attachmentIds: z.array(z.string().uuid()).max(10).default([]),
});

export async function agencyPostMessage(user: SessionUser, ticketId: string, input: z.input<typeof agencyMessageSchema>): Promise<{ id: string; existing: boolean }> {
  const parsed = agencyMessageSchema.safeParse(input);
  if (!parsed.success) throw new AppError("invalid_input", "That message could not be read. Please try again.");
  const { internal, status: target } = parsed.data;
  const text = cleanText(parsed.data.body, 5000);
  if (!text) throw new AppError("invalid_input", "Replies can be up to 5,000 characters.");
  const t = await loadTicketForAgency(user, ticketId, "agency.support.manage");
  if (internal) await assertAgencySupportPermission(user, t.org_id, "agency.support.notes");
  if (target && (target === "resolved" || target === "closed")) await assertAgencySupportPermission(user, t.org_id, "agency.support.resolve");
  await throttle(user);
  const settings = await loadSupportSettings();

  const done = await withSystem(async (db) => {
    const dup = parsed.data.clientMessageId
      ? (await db.query<{ id: string }>("select id from support_messages where ticket_id = $1 and client_message_id = $2", [ticketId, parsed.data.clientMessageId])).rows[0]
      : undefined;
    if (dup) return { id: dup.id, existing: true };
    const cur = await lock(db, ticketId);
    if (cur.status === "closed" && !internal && !target) throw new AppError("conflict", "This request is closed. Reopen it before replying.");
    const inserted = await db.query<{ id: string }>(
      `insert into support_messages (ticket_id, org_id, author_id, author_kind, body, internal, client_message_id) values ($1, $2, $3, 'agency', $4, $5, $6) returning id`,
      [ticketId, cur.org_id, user.id, text, internal, parsed.data.clientMessageId ?? null],
    );
    const messageId = inserted.rows[0].id;
    await bindStagedAttachments(db, { ticketId, orgId: cur.org_id, messageId, userId: user.id, ids: parsed.data.attachmentIds, visibility: internal ? "internal" : "client", maxCount: settings.maxAttachmentsPerMessage });
    // Whoever replies first picks the request up (the existing behaviour), and the team reading it counts as reading it.
    const claimed = !cur.assigned_to;
    await db.query(
      `update support_tickets set last_message_at = now(), assigned_to = coalesce(assigned_to, $2), agency_last_read_at = now(),
         first_responded_at = case when $3 then coalesce(first_responded_at, now()) else first_responded_at end where id = $1`,
      [ticketId, user.id, !internal],
    );
    if (claimed) {
      await recordTicketEvent(db, { ticketId, orgId: cur.org_id, kind: "assigned", visibility: "client", actorUserId: user.id, actorKind: "agency" });
      await recordTicketEvent(db, { ticketId, orgId: cur.org_id, kind: "assigned", visibility: "internal", actorUserId: user.id, actorKind: "agency", to: user.fullName ?? user.email, detail: "Took over by replying." });
    }
    let current: TicketCore = { ...cur, assigned_to: cur.assigned_to ?? user.id, first_responded_at: !internal ? cur.first_responded_at ?? new Date() : cur.first_responded_at };
    const status = await acknowledgeIfNew(db, current, actorOf(user));
    current = { ...current, status };
    // Legacy default: a public reply hands the next move to the client unless the person chose a status.
    const next = target ?? (internal ? null : "waiting_for_client");
    let statusNotified = false;
    if (next && next !== current.status) {
      const finishing = next === "resolved" || next === "closed";
      if (current.request_type === "feedback" && !finishing) throw new AppError("invalid_input", "Use the feedback status control for feedback.");
      await applyStatusChange(db, current, next, actorOf(user), { silent: !finishing, note: finishing && !internal ? text.slice(0, 200) : undefined, stage: undefined });
      statusNotified = finishing && !internal;
    }
    await recordTicketEvent(db, { ticketId, orgId: cur.org_id, kind: internal ? "note" : "reply", actorUserId: user.id, actorKind: "agency" });
    if (!internal) await clearResponseClock(db, current);
    if (!internal && !statusNotified) {
      await dispatchSupportNotice(db, {
        event: "agency_reply", ticket: { id: ticketId, org_id: cur.org_id, ref: cur.ref, subject: cur.subject }, eventKey: `msg:${messageId}`,
        recipients: await clientParticipants(db, ticketId, cur.org_id, user.id), title: `iAcquire replied to ${cur.ref}`, body: text.slice(0, 140),
      });
    }
    await recordAudit({ orgId: cur.org_id, actorUserId: user.id, actorKind: "agency", action: internal ? "support.internal_note" : "support.agency_reply", targetType: "support_ticket", targetId: ticketId, result: "success", metadata: { ref: cur.ref, attachments: parsed.data.attachmentIds.length } }, db);
    return { id: messageId, existing: false };
  });
  if (!done.existing) await sendQueuedSupportEmails(ticketId);
  return done;
}

// ---------------------------------------------------------------------------
// Status, feedback stage, priority, assignment, escalation
// ---------------------------------------------------------------------------

export async function changeRequestStatus(user: SessionUser, ticketId: string, to: TicketStatus, note?: string): Promise<void> {
  if (!(TICKET_STATUSES as readonly string[]).includes(to) || to === "new") throw new AppError("invalid_input", "Unknown status.");
  const t = await loadTicketForAgency(user, ticketId, "agency.support.manage");
  if (t.request_type === "feedback") throw new AppError("invalid_input", "Use the feedback status control for feedback.");
  // Ending or reopening a request is its own permission, on top of being able to work the request.
  if (to === "resolved" || to === "closed" || isReopen(t.status, to)) await assertAgencySupportPermission(user, t.org_id, "agency.support.resolve");
  await throttle(user);
  await withSystem(async (db) => {
    const cur = await lock(db, ticketId);
    if (cur.status === to) return;
    if (!canTransition(cur.status, to)) throw new AppError("conflict", `A ${cur.status.replace(/_/g, " ")} request can't move to ${to.replace(/_/g, " ")}.`);
    await applyStatusChange(db, cur, to, actorOf(user), { note: note ? cleanText(note, 300) : undefined });
    await db.query("update support_tickets set agency_last_read_at = now() where id = $1", [ticketId]);
  });
  await sendQueuedSupportEmails(ticketId);
}

export async function setFeedbackStage(user: SessionUser, ticketId: string, stage: FeedbackStage, note?: string): Promise<void> {
  if (!(FEEDBACK_STAGES as readonly string[]).includes(stage)) throw new AppError("invalid_input", "Unknown feedback status.");
  const t = await loadTicketForAgency(user, ticketId, "agency.support.manage");
  if (t.request_type !== "feedback") throw new AppError("invalid_input", "Only feedback has a feedback status.");
  if (stage === "completed" || stage === "not_planned") await assertAgencySupportPermission(user, t.org_id, "agency.support.resolve");
  await throttle(user);
  await withSystem(async (db) => {
    const cur = await lock(db, ticketId);
    const toStatus = ({ received: "new", under_review: "open", planned: "in_progress", completed: "resolved", not_planned: "closed" } as const)[stage];
    if (cur.feedback_stage === stage) return;
    // Moving from a finished stage back to "received" is a reopen; everything else follows the shared lifecycle.
    const via: TicketStatus = toStatus === "new" ? "open" : toStatus;
    if (!canTransition(cur.status, via) && cur.status !== via) {
      // Completed -> planned and similar: step through the reopen path first.
      await applyStatusChange(db, cur, "open", actorOf(user), { silent: true });
      const reread = await lock(db, ticketId);
      await applyStatusChange(db, reread, via, actorOf(user), { stage, note: note ? cleanText(note, 300) : undefined });
    } else {
      await applyStatusChange(db, cur, via, actorOf(user), { stage, note: note ? cleanText(note, 300) : undefined });
    }
    await db.query("update support_tickets set agency_last_read_at = now() where id = $1", [ticketId]);
  });
  await sendQueuedSupportEmails(ticketId);
}

export async function changePriority(user: SessionUser, ticketId: string, priority: TicketPriority, reason?: string): Promise<void> {
  if (!(PRIORITIES as readonly string[]).includes(priority)) throw new AppError("invalid_input", "Unknown priority.");
  const t = await loadTicketForAgency(user, ticketId, "agency.support.manage");
  await assertAgencySupportPermission(user, t.org_id, "agency.support.priority");
  await throttle(user);
  await withSystem(async (db) => {
    const cur = await lock(db, ticketId);
    if (cur.priority === priority) return;
    await db.query("update support_tickets set priority = $2 where id = $1", [ticketId, priority]);
    const eventId = await recordTicketEvent(db, { ticketId, orgId: cur.org_id, kind: "priority_changed", actorUserId: user.id, actorKind: "agency", from: cur.priority, to: priority, detail: reason ? cleanText(reason, 300) : null });
    await recomputeResponseClock(db, { id: ticketId, org_id: cur.org_id, priority, status: cur.status, first_responded_at: cur.first_responded_at });
    // Raising a request to high or urgent tells the people who manage priorities; lowering one is just recorded.
    if (PRIORITY_RANK[priority] < PRIORITY_RANK[cur.priority] && (priority === "high" || priority === "urgent") && isActiveStatus(cur.status)) {
      await dispatchSupportNotice(db, {
        event: "priority_escalated", ticket: { id: ticketId, org_id: cur.org_id, ref: cur.ref, subject: cur.subject }, eventKey: `ev:${eventId}`,
        recipients: await agencyManagers(db, { org_id: cur.org_id, assigned_to: cur.assigned_to }, user.id), title: `${cur.ref} was raised to ${priority} priority`, body: cur.subject, severity: priority === "urgent" ? "critical" : "warning",
      });
    }
    await recordAudit({ orgId: cur.org_id, actorUserId: user.id, actorKind: "agency", action: "support.priority_changed", targetType: "support_ticket", targetId: ticketId, result: "success", metadata: { ref: cur.ref, from: cur.priority, to: priority } }, db);
  });
}

export async function assignRequest(user: SessionUser, ticketId: string, assigneeId: string | null): Promise<void> {
  if (assigneeId !== null && !ID.test(assigneeId)) throw new AppError("invalid_input", "Choose a team member.");
  const t = await loadTicketForAgency(user, ticketId, "agency.support.manage");
  // Taking a request for yourself needs only the right to work it; giving it to someone else, or taking it away, needs "assign".
  const own = assigneeId === user.id || (assigneeId === null && t.assigned_to === user.id);
  if (!own) await assertAgencySupportPermission(user, t.org_id, "agency.support.assign");
  if (assigneeId !== null && !(await isEligibleAssignee(assigneeId, t.org_id))) {
    throw new AppError("forbidden", "That person can't work this client's support requests.");
  }
  await throttle(user);
  await withSystem(async (db) => {
    const cur = await lock(db, ticketId);
    if (cur.assigned_to === assigneeId) return;
    const names = await db.query<{ id: string; name: string }>("select id, coalesce(nullif(full_name, ''), email::text) as name from users where id = any($1::uuid[])", [[cur.assigned_to, assigneeId].filter(Boolean)]);
    const nameOf = (id: string | null) => (id ? names.rows.find((n) => n.id === id)?.name ?? "A team member" : null);
    await db.query("update support_tickets set assigned_to = $2, agency_last_read_at = now() where id = $1", [ticketId, assigneeId]);
    const eventId = await recordTicketEvent(db, {
      ticketId, orgId: cur.org_id, kind: assigneeId ? (cur.assigned_to ? "assigned" : "assigned") : "unassigned", visibility: "internal", actorUserId: user.id, actorKind: "agency",
      from: nameOf(cur.assigned_to), to: nameOf(assigneeId),
    });
    // The client is told only that someone picked it up, and only the first time.
    if (assigneeId && !cur.assigned_to) await recordTicketEvent(db, { ticketId, orgId: cur.org_id, kind: "assigned", visibility: "client", actorUserId: user.id, actorKind: "agency" });
    await acknowledgeIfNew(db, cur, actorOf(user));
    if (assigneeId && assigneeId !== user.id) {
      await dispatchSupportNotice(db, {
        event: "assigned", ticket: { id: ticketId, org_id: cur.org_id, ref: cur.ref, subject: cur.subject }, eventKey: `ev:${eventId}`,
        recipients: [{ userId: assigneeId, audience: "agency" }], title: `${cur.ref} was assigned to you`, body: cur.subject,
      });
    }
    await recordAudit({ orgId: cur.org_id, actorUserId: user.id, actorKind: "agency", action: assigneeId ? "support.assigned" : "support.unassigned", targetType: "support_ticket", targetId: ticketId, result: "success", metadata: { ref: cur.ref, from: cur.assigned_to, to: assigneeId } }, db);
  });
  await sendQueuedSupportEmails(ticketId);
}

export async function escalateRequest(user: SessionUser, ticketId: string, reason: string): Promise<void> {
  const why = cleanText(reason, 500);
  if (why.length < 3) throw new AppError("invalid_input", "Say briefly why this needs attention.");
  const t = await loadTicketForAgency(user, ticketId, "agency.support.manage");
  if (!isActiveStatus(t.status)) throw new AppError("conflict", "Only an active request can be escalated.");
  await throttle(user);
  await withSystem(async (db) => {
    const cur = await lock(db, ticketId);
    const res = await db.query(
      `insert into support_ticket_ops (ticket_id, org_id, escalated_at, escalated_by, escalation_reason) values ($1, $2, now(), $3, $4)
       on conflict (ticket_id) do update set escalated_at = now(), escalated_by = excluded.escalated_by, escalation_reason = excluded.escalation_reason where support_ticket_ops.escalated_at is null`,
      [ticketId, cur.org_id, user.id, why],
    );
    if (!res.rowCount) return;
    const eventId = await recordTicketEvent(db, { ticketId, orgId: cur.org_id, kind: "escalated", actorUserId: user.id, actorKind: "agency", detail: why });
    await dispatchSupportNotice(db, {
      event: "priority_escalated", ticket: { id: ticketId, org_id: cur.org_id, ref: cur.ref, subject: cur.subject }, eventKey: `ev:${eventId}`,
      recipients: await agencyManagers(db, { org_id: cur.org_id, assigned_to: cur.assigned_to }, user.id), title: `${cur.ref} was escalated`, body: why, severity: "critical",
    });
    await recordAudit({ orgId: cur.org_id, actorUserId: user.id, actorKind: "agency", action: "support.escalated", targetType: "support_ticket", targetId: ticketId, result: "success", metadata: { ref: cur.ref } }, db);
  });
}

export async function clearEscalation(user: SessionUser, ticketId: string): Promise<void> {
  const t = await loadTicketForAgency(user, ticketId, "agency.support.manage");
  await assertAgencySupportPermission(user, t.org_id, "agency.support.priority");
  await withSystem(async (db) => {
    const res = await db.query("update support_ticket_ops set escalated_at = null, escalated_by = null, escalation_reason = null where ticket_id = $1 and escalated_at is not null", [ticketId]);
    if (!res.rowCount) return;
    await recordTicketEvent(db, { ticketId, orgId: t.org_id, kind: "de_escalated", actorUserId: user.id, actorKind: "agency" });
    await recordAudit({ orgId: t.org_id, actorUserId: user.id, actorKind: "agency", action: "support.escalation_cleared", targetType: "support_ticket", targetId: ticketId, result: "success", metadata: { ref: t.ref } }, db);
  });
}

// ---------------------------------------------------------------------------
// Linking and merging (same workspace only)
// ---------------------------------------------------------------------------

export async function linkRequests(user: SessionUser, ticketId: string, relatedId: string, kind: "related" | "duplicate_of"): Promise<void> {
  if (!ID.test(relatedId) || ticketId === relatedId) throw new AppError("invalid_input", "Choose a different request.");
  const t = await loadTicketForAgency(user, ticketId, "agency.support.manage");
  const other = await loadTicketForAgency(user, relatedId, "agency.support.manage");
  // Requests from different clients are never linked: the foreign keys enforce it too.
  if (other.org_id !== t.org_id) throw new AppError("not_found", "Support request not found.");
  await withSystem(async (db) => {
    const res = await db.query(
      "insert into support_ticket_links (ticket_id, related_ticket_id, org_id, kind, created_by) values ($1, $2, $3, $4, $5) on conflict do nothing",
      [ticketId, relatedId, t.org_id, kind, user.id],
    );
    if (!res.rowCount) return;
    await recordTicketEvent(db, { ticketId, orgId: t.org_id, kind: "linked", actorUserId: user.id, actorKind: "agency", to: other.ref, detail: kind === "duplicate_of" ? "Marked as a duplicate" : "Linked as related" });
    await recordAudit({ orgId: t.org_id, actorUserId: user.id, actorKind: "agency", action: "support.linked", targetType: "support_ticket", targetId: ticketId, result: "success", metadata: { ref: t.ref, with: other.ref, kind } }, db);
  });
}

/**
 * Closes `ticketId` as a duplicate of `intoId` (same workspace, team permission "assign"). Nothing is moved or deleted: both requests keep
 * their own history, the link records the merge, and the client of the closed request is told where it went.
 */
export async function mergeRequest(user: SessionUser, ticketId: string, intoId: string): Promise<void> {
  if (!ID.test(intoId) || ticketId === intoId) throw new AppError("invalid_input", "Choose a different request.");
  const t = await loadTicketForAgency(user, ticketId, "agency.support.manage");
  await assertAgencySupportPermission(user, t.org_id, "agency.support.assign");
  await assertAgencySupportPermission(user, t.org_id, "agency.support.resolve");
  const target = await loadTicketForAgency(user, intoId, "agency.support.manage");
  if (target.org_id !== t.org_id) throw new AppError("not_found", "Support request not found.");
  if (!isActiveStatus(t.status)) throw new AppError("conflict", "Only an active request can be merged.");
  if (target.status === "closed") throw new AppError("conflict", "That request is closed; choose an active one.");
  await throttle(user);
  await withSystem(async (db) => {
    const cur = await lock(db, ticketId);
    if (!isActiveStatus(cur.status)) throw new AppError("conflict", "Only an active request can be merged.");
    await db.query("insert into support_ticket_links (ticket_id, related_ticket_id, org_id, kind, created_by) values ($1, $2, $3, 'merged_into', $4) on conflict do nothing", [ticketId, intoId, cur.org_id, user.id]);
    await recordTicketEvent(db, { ticketId, orgId: cur.org_id, kind: "merged", actorUserId: user.id, actorKind: "agency", to: target.ref, visibility: "internal", detail: `Merged into ${target.ref}` });
    await recordTicketEvent(db, { ticketId: intoId, orgId: cur.org_id, kind: "merged", actorUserId: user.id, actorKind: "agency", to: cur.ref, visibility: "internal", detail: `${cur.ref} was merged into this request` });
    await applyStatusChange(db, cur, "closed", actorOf(user), { note: `Merged into ${target.ref}.`, threadLine: `This request was merged into ${target.ref}, which the team is now working on.` });
    await recordAudit({ orgId: cur.org_id, actorUserId: user.id, actorKind: "agency", action: "support.merged", targetType: "support_ticket", targetId: ticketId, result: "success", metadata: { ref: cur.ref, into: target.ref } }, db);
  });
  await sendQueuedSupportEmails(ticketId);
}

// ---------------------------------------------------------------------------
// Compatibility: the shapes the earlier agency inbox used
// ---------------------------------------------------------------------------

export interface TicketRow {
  id: string;
  ref: string;
  subject: string;
  category: string;
  priority: string;
  status: TicketStatus;
  created_at: Date;
  updated_at: Date;
  last_message_at: Date;
  external_notification: string;
  created_by_name: string | null;
  assigned_to_name: string | null;
  is_assigned: boolean;
  org_name?: string;
  org_id?: string;
}

export interface TicketMessage {
  id: string;
  author_kind: "client" | "agency" | "system";
  author_name: string | null;
  body: string;
  internal: boolean;
  created_at: Date;
}

const toLegacy = (i: AgencyListItem): TicketRow => ({
  id: i.id, ref: i.ref, subject: i.subject, category: i.category, priority: i.priority, status: i.status, created_at: new Date(i.createdAt), updated_at: new Date(i.lastActivityAt),
  last_message_at: new Date(i.lastActivityAt), external_notification: "not_configured", created_by_name: i.createdByName, assigned_to_name: i.assignedToName, is_assigned: Boolean(i.assignedToId),
  org_name: i.orgName, org_id: i.orgId,
});

export async function listAgencyTickets(user: SessionUser, status?: TicketStatus | "active"): Promise<TicketRow[]> {
  const page = await listAgencyRequests(user, status && status !== "active" ? { view: "all", status, pageSize: 100 } : { view: "active", pageSize: 100 });
  return page.items.map(toLegacy);
}

export async function getTicketForAgency(user: SessionUser, ticketId: string) {
  const detail = await getAgencyRequest(user, ticketId);
  if (!detail) return null;
  const ticket: TicketRow = { ...toLegacy({ ...detail.ticket }), created_at: new Date(detail.ticket.createdAt), external_notification: detail.ticket.externalNotification };
  const messages: TicketMessage[] = detail.messages.map((m) => ({ id: m.id, author_kind: m.authorKind, author_name: m.authorName, body: m.body, internal: m.internal, created_at: new Date(m.createdAt) }));
  return { ticket, messages };
}

export async function agencyReply(user: SessionUser, ticketId: string, body: string, opts: { internal: boolean; status?: TicketStatus }) {
  await agencyPostMessage(user, ticketId, { body, internal: opts.internal, status: opts.status });
}

export async function updateTicket(user: SessionUser, ticketId: string, changes: { status?: TicketStatus; assignToMe?: boolean; priority?: string }) {
  if (changes.status && !(TICKET_STATUSES as readonly string[]).includes(changes.status)) throw new AppError("invalid_input", "Unknown status.");
  if (changes.priority && !(PRIORITIES as readonly string[]).includes(changes.priority)) throw new AppError("invalid_input", "Unknown priority.");
  if (changes.status) await changeRequestStatus(user, ticketId, changes.status);
  if (changes.priority) await changePriority(user, ticketId, changes.priority as TicketPriority);
  if (changes.assignToMe) await assignRequest(user, ticketId, user.id);
  // Nothing requested still has to prove the person may touch this request.
  if (!changes.status && !changes.priority && !changes.assignToMe) await loadTicketForAgency(user, ticketId, "agency.support.manage");
}

