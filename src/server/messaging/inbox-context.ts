import "server-only";
import { getPriority, type PriorityView } from "@/server/lead-scoring/priority";
import { openCaseFor, type CaseView } from "@/server/missed-calls/ops";
import { withSystem, withUser } from "@/server/db";
import { AppError } from "@/server/errors";
import { memberActor } from "@/server/crm/actor";
import { getContactDetail, listContactAppointments, listContactConversations, updateContact, type ContactDetail } from "@/server/crm/contacts";
import { listTasks, createTask, type TaskPriority } from "@/server/crm/tasks";
import { listNotes, addNote, type NoteView } from "@/server/crm/notes";
import { createOpportunity, listOpportunities } from "@/server/crm/opportunities";
import { listContactCalls, type CallRecordView } from "@/server/crm/calls";
import { assertConversationVisible } from "@/server/messaging/access";
import { recordConversationEvent } from "@/server/messaging/events";
import { recordAudit } from "@/server/audit";
import { canHandleConversations } from "@/lib/inbox";
import { LEAD_STATUSES, type LeadStatus } from "@/lib/crm/types";
import type { OrgContext } from "@/server/tenancy/context";

// The customer panel beside a conversation: the one canonical CRM record, read through the same permission-checked CRM services the CRM screens
// use. Each section is shown only when the person's role allows it; a section they cannot see says so instead of silently being empty, and a
// section that fails to load never takes the rest of the panel down.

export type Section<T> = { state: "ok"; items: T[] } | { state: "no_access" } | { state: "error" };

export interface ContextDeal {
  id: string;
  name: string;
  status: string;
  pipeline: string;
  stage: string;
  value: number | null;
  currency: string;
  owner: string | null;
  expectedCloseDate: string | null;
}

export interface ContextTask {
  id: string;
  title: string;
  status: string;
  priority: string;
  dueAt: string | null;
  overdue: boolean;
  assignee: string | null;
}

export interface ContextAppointment {
  id: string;
  title: string;
  status: string;
  startAt: string;
  endAt: string;
}

export interface ContextCall {
  id: string;
  direction: "inbound" | "outbound";
  status: string;
  startedAt: string | null;
  durationSeconds: number | null;
  summary: string | null;
  hasRecording: boolean;
  hasTranscript: boolean;
}

export interface ContextConversation {
  id: string;
  channel: string;
  status: string;
  lastMessageAt: string | null;
  preview: string | null;
}

export interface InboxCrmContext {
  /** False when the workspace has no native CRM contact behind this conversation, or the person cannot open contacts. */
  contact: null | {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    leadStatus: LeadStatus;
    leadScore: number | null;
    lifecycleStage: string;
    source: string;
    createdVia: string;
    owner: { id: string; name: string } | null;
    companies: ContextCompanyView[];
    tags: Array<{ id: string; name: string; color: string }>;
    timezone: string | null;
    preferredChannel: string | null;
    createdAt: string;
  };
  deals: Section<ContextDeal>;
  tasks: Section<ContextTask>;
  appointments: Section<ContextAppointment>;
  notes: Section<Pick<NoteView, "id" | "body" | "pinned" | "authorName" | "createdAt">>;
  calls: Section<ContextCall>;
  otherConversations: Section<ContextConversation>;
  possibleDuplicates: Array<{ id: string; name: string }>;
  ai: { employees: Array<{ id: string; name: string; roleKey: string }>; aiMessages: number; lastAiMessageAt: string | null; draftsWaiting: number; handoffs: number };
  /** The lead's explained priority (people who may see contacts), or null; and the missed call still waiting for an answer (people who may see calls). */
  priority: PriorityView | null;
  missedCall: CaseView | null;
  links: { contact: string; deals: string; tasks: string; appointments: string; calls: string };
  /** What this person may do from here, so the interface offers only what the server will accept. The server checks again on every action. */
  can: { task: boolean; deal: boolean; note: boolean; leadStatus: boolean };
}

type ContextCompanyView = { id: string; name: string; title: string | null };

async function section<T>(allowed: boolean, load: () => Promise<T[]>): Promise<Section<T>> {
  if (!allowed) return { state: "no_access" };
  try {
    return { state: "ok", items: await load() };
  } catch {
    return { state: "error" };
  }
}

export async function getInboxCrmContext(ctx: OrgContext, conversationId: string): Promise<InboxCrmContext> {
  if (!ctx.can("inbox.view")) throw new AppError("forbidden", "You can't view the inbox.");
  await assertConversationVisible(ctx, conversationId);
  const conv = await withUser(ctx.user.id, (db) => db.query<{ contact_id: string }>("select contact_id from conversations where id = $1 and org_id = $2", [conversationId, ctx.org.orgId]));
  const contactId = conv.rows[0]?.contact_id;
  if (!contactId) throw new AppError("not_found", "Conversation not found.");
  const actor = memberActor(ctx);

  const detail: ContactDetail | null = actor.can("contacts.view") ? await getContactDetail(actor, contactId).catch(() => null) : null;
  // Neither may stop the rest of the panel from loading.
  const [priority, missedCall] = await Promise.all([
    detail ? getPriority(actor, contactId).catch(() => null) : Promise.resolve(null),
    actor.can("calls.view") ? openCaseFor(actor, { contactId }).catch(() => null) : Promise.resolve(null),
  ]);
  const [deals, tasks, appointments, notes, calls, others, duplicates, ai] = await Promise.all([
    section(actor.can("sales.view"), async () =>
      (await listOpportunities(actor, { contactId, status: "all", pageSize: 10, sort: { by: "updated_at", dir: "desc" } })).rows.map((o) => ({
        id: o.id, name: o.name, status: o.status, pipeline: o.pipelineName, stage: o.stageName, value: o.value, currency: o.currency, owner: o.owner?.name ?? null, expectedCloseDate: o.expectedCloseDate,
      })),
    ),
    section(actor.can("crm.view"), async () =>
      (await listTasks(actor, { view: "all", contactId, limit: 10 })).filter((t) => t.status === "open" || t.status === "in_progress").map((t) => ({
        id: t.id, title: t.title, status: t.status, priority: t.priority, dueAt: t.dueAt, overdue: t.overdue, assignee: t.assignee?.name ?? null,
      })),
    ),
    section(actor.can("appointments.view"), async () => (await listContactAppointments(actor, contactId)).slice(0, 10)),
    section(actor.can("contacts.view"), async () => (await listNotes(actor, "contact", contactId)).slice(0, 8).map((n) => ({ id: n.id, body: n.body.slice(0, 500), pinned: n.pinned, authorName: n.authorName, createdAt: n.createdAt }))),
    section(actor.can("calls.view"), async () =>
      (await listContactCalls(actor, contactId, 8)).map((c: CallRecordView) => ({
        id: c.id, direction: c.direction, status: c.status, startedAt: c.startedAt, durationSeconds: c.durationSeconds, summary: c.summary, hasRecording: Boolean(c.recordingRef), hasTranscript: Boolean(c.transcriptRef),
      })),
    ),
    section(actor.can("inbox.view"), async () =>
      (await listContactConversations(actor, contactId)).filter((c) => c.id !== conversationId).slice(0, 8).map((c) => ({ id: c.id, channel: c.channel, status: c.status, lastMessageAt: c.lastMessageAt, preview: c.preview })),
    ),
    // Possible duplicates are a hint for a person, never an automatic merge: the same display name under another contact record.
    actor.can("contacts.view") && detail?.displayName && detail.displayName.trim().length >= 3
      ? withUser(ctx.user.id, async (db) =>
          (await db.query<{ id: string; display_name: string }>(
            "select id, display_name from contacts where org_id = $1 and id <> $2 and deleted_at is null and lower(display_name) = lower($3) order by created_at limit 3",
            [ctx.org.orgId, contactId, detail.displayName.trim()],
          )).rows.map((r) => ({ id: r.id, name: r.display_name })),
        ).catch(() => [])
      : Promise.resolve([] as Array<{ id: string; name: string }>),
    aiActivity(ctx, conversationId),
  ]);

  return {
    contact: detail
      ? {
          id: detail.id, name: detail.displayName || "Unknown contact", email: detail.email, phone: detail.phone, leadStatus: detail.leadStatus, leadScore: detail.leadScore, lifecycleStage: detail.lifecycleStage,
          source: detail.source, createdVia: detail.createdVia, owner: detail.owner, companies: detail.companies.map((c) => ({ id: c.id, name: c.name, title: c.title })), tags: detail.tags, timezone: detail.timezone,
          preferredChannel: detail.preferredChannel, createdAt: detail.createdAt,
        }
      : null,
    deals, tasks, appointments, notes, calls, otherConversations: others, possibleDuplicates: duplicates, ai, priority, missedCall,
    links: { contact: `/crm/contacts/${contactId}`, deals: "/crm/opportunities", tasks: "/crm/tasks", appointments: "/crm/appointments", calls: "/crm/calls" },
    can: { task: actor.can("tasks.manage") && actor.can("contacts.view"), deal: actor.can("opportunities.create"), note: actor.can("notes.write") && actor.can("contacts.view"), leadStatus: actor.can("contacts.edit") },
  };
}

async function aiActivity(ctx: OrgContext, conversationId: string): Promise<InboxCrmContext["ai"]> {
  return withUser(ctx.user.id, async (db) => {
    const msgs = await db.query<{ n: string; last: Date | null; drafts: string }>(
      `select count(*) filter (where status in ('sent', 'delivered', 'read'))::text as n, max(created_at) as last, count(*) filter (where status = 'draft')::text as drafts
       from conversation_messages where conversation_id = $1 and org_id = $2 and direction = 'outbound' and author_kind = 'ai'`,
      [conversationId, ctx.org.orgId],
    );
    const emps = await db.query<{ id: string; display_name: string; role_key: string }>(
      `select distinct a.id, a.display_name, a.role_key from agent_instances a
       where a.org_id = $2 and (a.id = (select ai_agent_id from conversations where id = $1) or a.id in (select agent_id from conversation_messages where conversation_id = $1 and agent_id is not null))`,
      [conversationId, ctx.org.orgId],
    );
    const handoffs = await db.query<{ n: string }>("select count(*)::text as n from human_escalations where conversation_id = $1 and org_id = $2", [conversationId, ctx.org.orgId]).catch(() => ({ rows: [{ n: "0" }] }));
    return {
      employees: emps.rows.map((e) => ({ id: e.id, name: e.display_name, roleKey: e.role_key })),
      aiMessages: Number(msgs.rows[0]?.n ?? 0),
      lastAiMessageAt: msgs.rows[0]?.last ? new Date(msgs.rows[0].last).toISOString() : null,
      draftsWaiting: Number(msgs.rows[0]?.drafts ?? 0),
      handoffs: Number(handoffs.rows[0]?.n ?? 0),
    };
  });
}

export interface ConversationAiEmployee {
  id: string;
  name: string;
  roleKey: string;
  /** Whether it could take a conversation right now, and if not, why (never hidden: the person is told). */
  ready: boolean;
  problem: string | null;
}

/** The AI employees that may be attached to a conversation (customer-facing roles only), with whether each could take one right now. */
export async function listConversationAiEmployees(ctx: OrgContext): Promise<ConversationAiEmployee[]> {
  if (!ctx.can("inbox.assign")) return [];
  return withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<{ id: string; display_name: string; role_key: string; enabled: boolean; status: string; mode: string }>(
      "select id, display_name, role_key, enabled, status, mode from agent_instances where org_id = $1 and enabled order by display_name",
      [ctx.org.orgId],
    );
    return rows
      .filter((a) => canHandleConversations(a.role_key))
      .map((a) => {
        const ready = ["online", "busy"].includes(a.status) && a.mode !== "paused";
        return { id: a.id, name: a.display_name, roleKey: a.role_key, ready, problem: ready ? null : a.mode === "paused" ? "Paused" : "Not connected yet" };
      });
  });
}

// ---------------------------------------------------------------------------
// Quick actions from a conversation. Each is the CRM's own service, called as the signed-in person, so the CRM's permissions, validation,
// activity timeline and events all apply; the conversation only gains a line on its trail.
// ---------------------------------------------------------------------------

async function contactOf(ctx: OrgContext, conversationId: string): Promise<{ contactId: string; name: string }> {
  await assertConversationVisible(ctx, conversationId);
  const { rows } = await withUser(ctx.user.id, (db) =>
    db.query<{ contact_id: string; display_name: string }>("select c.contact_id, k.display_name from conversations c join contacts k on k.id = c.contact_id and k.org_id = c.org_id where c.id = $1 and c.org_id = $2", [conversationId, ctx.org.orgId]),
  );
  if (!rows[0]) throw new AppError("not_found", "Conversation not found.");
  return { contactId: rows[0].contact_id, name: rows[0].display_name };
}

export async function createTaskFromConversation(ctx: OrgContext, conversationId: string, input: { title: string; dueAt?: string | null; priority?: TaskPriority; assigneeId?: string | null }): Promise<{ taskId: string }> {
  const { contactId } = await contactOf(ctx, conversationId);
  const { id } = await createTask(memberActor(ctx), {
    title: input.title,
    description: `Created from an inbox conversation: /inbox?conversation=${conversationId}`,
    dueAt: input.dueAt ?? null,
    priority: input.priority ?? "normal",
    assigneeId: input.assigneeId ?? ctx.user.id,
    contactId,
  });
  await withSystem((db) => recordConversationEvent(db, { orgId: ctx.org.orgId, conversationId, kind: "task_linked", actor: { kind: "user", userId: ctx.user.id }, detail: { taskId: id } }));
  return { taskId: id };
}

/** One deal per conversation at most: the idempotency key makes a second click return the deal that already exists. */
export async function createDealFromConversation(ctx: OrgContext, conversationId: string, input: { name?: string | null; value?: number | null } = {}): Promise<{ opportunityId: string }> {
  const { contactId, name } = await contactOf(ctx, conversationId);
  const { id } = await createOpportunity(
    memberActor(ctx),
    { name: input.name?.trim() || `${name || "New"} enquiry`, contactId, value: input.value ?? null, source: "inbox", ownerId: ctx.user.id },
    { idempotencyKey: `inbox:${conversationId}` },
  );
  await withSystem((db) => recordConversationEvent(db, { orgId: ctx.org.orgId, conversationId, kind: "opportunity_linked", actor: { kind: "user", userId: ctx.user.id }, detail: { opportunityId: id } }));
  return { opportunityId: id };
}

export async function addContactNoteFromConversation(ctx: OrgContext, conversationId: string, body: string): Promise<{ noteId: string }> {
  const { contactId } = await contactOf(ctx, conversationId);
  const { id } = await addNote(memberActor(ctx), "contact", contactId, body);
  return { noteId: id };
}

export async function setLeadStatusFromConversation(ctx: OrgContext, conversationId: string, leadStatus: string): Promise<void> {
  if (!(LEAD_STATUSES as readonly string[]).includes(leadStatus)) throw new AppError("invalid_input", "Choose a lead status.");
  const { contactId } = await contactOf(ctx, conversationId);
  const actor = memberActor(ctx);
  if (!actor.can("contacts.edit")) throw new AppError("forbidden", "Your role can't change a contact's lead status.");
  await updateContact(actor, contactId, { leadStatus: leadStatus as LeadStatus });
  await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "conversation.lead_status_set", targetType: "conversation", targetId: conversationId, result: "success", metadata: { leadStatus } });
}
