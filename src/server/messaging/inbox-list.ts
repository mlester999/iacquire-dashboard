import "server-only";
import { withUser } from "@/server/db";
import { AppError } from "@/server/errors";
import { maskCustomerLinks } from "@/server/messaging/redact";
import { AWAITING_REPLY_MINUTES, INBOX_VIEWS, type AttentionReason, type ConversationOutcome, type InboxSort, type InboxView } from "@/lib/inbox";
import type { Channel } from "@/lib/messaging";
import type { OrgContext } from "@/server/tenancy/context";

// The conversation list: views, search, sorting and keyset paging. Everything runs as the signed-in person (withUser), so row-level security
// decides what exists for them; nothing here widens it. The definitions of the views live in INBOX_VIEW_HELP (src/lib/inbox.ts) and are
// applied literally below.

export interface ConversationListItem {
  id: string;
  contactId: string;
  contactName: string;
  channel: Channel;
  status: "open" | "snoozed" | "closed";
  ownerKind: "ai" | "human" | "unassigned";
  ownerName: string | null;
  ownerUserId: string | null;
  assignedUserId: string | null;
  priority: "low" | "normal" | "high" | "urgent";
  unread: number;
  lastMessageAt: string | null;
  preview: string | null;
  escalation: { id: string; status: string; urgency: string } | null;
  /** The AI employee attached to the conversation (it replies only while ownerKind is "ai" and aiPaused is false). */
  aiAgent: { id: string; name: string; roleKey: string } | null;
  aiPaused: boolean;
  archivedAt: string | null;
  resolvedAt: string | null;
  outcome: ConversationOutcome | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  /** We spoke last, so we are waiting for the customer. */
  waitingOnCustomer: boolean;
  /** Why this needs attention, from facts in the database. Empty when it does not. */
  attention: AttentionReason[];
  /** Bumped on every change to the conversation row; the live sync keeps the highest it has seen. */
  revision: number;
}

export interface ConversationFilters {
  q?: string;
  channel?: Channel;
  /** Legacy filters, kept for callers that predate views. */
  status?: "open" | "closed";
  owner?: "ai" | "human" | "unassigned" | "mine";
  unreadOnly?: boolean;
  priority?: "low" | "normal" | "high" | "urgent";
  view?: InboxView;
  sort?: InboxSort;
  /** An opaque cursor from the previous page. */
  cursor?: string | null;
  limit?: number;
}

export type ViewCounts = Record<InboxView, number>;

export const LIST_PAGE_DEFAULT = 50;
export const LIST_PAGE_MAX = 100;

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Recently failed outbound messages that nobody has re-sent, and the unresolved escalations of a workspace: small sets, joined by id. */
const CTES = `
  failed as (
    select distinct fm.conversation_id from conversation_messages fm
    where fm.org_id = $1 and fm.direction = 'outbound' and fm.status = 'failed' and fm.failed_at > now() - interval '7 days'
      and not exists (select 1 from conversation_messages r where r.retry_of = fm.id)
  ),
  esc as (
    select id, conversation_id, status, urgency from human_escalations where org_id = $1 and status in ('awaiting_owner', 'open', 'claimed')
  )`;

const FROM = `
  from conversations c
  join contacts k on k.id = c.contact_id and k.org_id = c.org_id and k.deleted_at is null
  left join users u on u.id = c.owner_user_id
  left join agent_instances a on a.id = c.ai_agent_id and a.org_id = c.org_id
  left join esc on esc.conversation_id = c.id
  left join failed on failed.conversation_id = c.id`;

const IS_OPEN = "c.status <> 'closed'";
const NOT_ARCHIVED = "c.archived_at is null";
const NEEDS_PERSON = "(esc.status in ('awaiting_owner', 'open'))";
const SEND_FAILED = "(failed.conversation_id is not null)";
const URGENT = "(c.priority = 'urgent')";
const AWAITING_REPLY = `(c.unread_count > 0 and c.last_inbound_at is not null and c.last_inbound_at < now() - interval '${AWAITING_REPLY_MINUTES} minutes' and (c.last_outbound_at is null or c.last_outbound_at < c.last_inbound_at))`;
const WAITING = "(c.last_outbound_at is not null and (c.last_inbound_at is null or c.last_outbound_at >= c.last_inbound_at))";

/** The predicate of each view. `me()` is the bound parameter holding the person's id; it is only called by a view that uses it (an unused parameter is an error). */
const VIEW_SQL: Record<InboxView, (me: () => string) => string> = {
  all: () => NOT_ARCHIVED,
  unread: () => `${NOT_ARCHIVED} and c.unread_count > 0`,
  mine: (me) => `${NOT_ARCHIVED} and ${IS_OPEN} and (c.owner_user_id = ${me()} or c.assigned_user_id = ${me()})`,
  ai: () => `${NOT_ARCHIVED} and ${IS_OPEN} and c.owner_kind = 'ai'`,
  unassigned: () => `${NOT_ARCHIVED} and ${IS_OPEN} and c.owner_kind = 'unassigned' and c.assigned_user_id is null`,
  attention: () => `${NOT_ARCHIVED} and ${IS_OPEN} and (${NEEDS_PERSON} or ${SEND_FAILED} or ${URGENT} or ${AWAITING_REPLY})`,
  open: () => `${NOT_ARCHIVED} and ${IS_OPEN}`,
  waiting: () => `${NOT_ARCHIVED} and ${IS_OPEN} and ${WAITING}`,
  resolved: () => `${NOT_ARCHIVED} and c.status = 'closed'`,
  archived: () => "c.archived_at is not null",
};

/** The ordering of each sort: a rank, a time and the id, with the direction of the time. The cursor carries all three. */
const SORT_SQL: Record<InboxSort, { rank: string; key: string; dir: "asc" | "desc" }> = {
  priority: { rank: `(case when ${NEEDS_PERSON} then 0 when c.priority = 'urgent' then 1 when c.priority = 'high' then 2 else 3 end)`, key: "coalesce(c.last_message_at, c.created_at)", dir: "desc" },
  recent: { rank: "(0::int)", key: "coalesce(c.last_message_at, c.created_at)", dir: "desc" },
  waiting_longest: { rank: `(case when ${AWAITING_REPLY} then 0 else 1 end)`, key: "coalesce(c.last_inbound_at, c.created_at)", dir: "asc" },
};

interface Cursor {
  rank: number;
  key: string;
  id: string;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify([c.rank, c.key, c.id]), "utf8").toString("base64url");
}

export function decodeCursor(raw: string | null | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const [rank, key, id] = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as [unknown, unknown, unknown];
    if (typeof rank !== "number" || !Number.isInteger(rank) || typeof key !== "string" || key.length > 64 || !/^[0-9T:. +\-Zz]+$/.test(key) || typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return null;
    return { rank, key, id };
  } catch {
    return null;
  }
}

type Row = {
  id: string; contact_id: string; display_name: string; channel: Channel; status: "open" | "snoozed" | "closed"; owner_kind: "ai" | "human" | "unassigned"; owner_name: string | null;
  owner_user_id: string | null; assigned_user_id: string | null; priority: "low" | "normal" | "high" | "urgent"; unread_count: number; last_message_at: Date | null;
  last_message_preview: string | null; last_inbound_at: Date | null; last_outbound_at: Date | null; esc_id: string | null; esc_status: string | null; esc_urgency: string | null;
  agent_id: string | null; agent_name: string | null; agent_role: string | null; ai_paused_at: Date | null; archived_at: Date | null; resolved_at: Date | null;
  outcome: ConversationOutcome | null; revision: string; needs_person: boolean; send_failed: boolean; awaiting_reply: boolean; waiting: boolean;
  sort_rank: number; sort_key: string;
};

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

export const LIST_COLUMNS = `c.id, c.contact_id, k.display_name, c.channel, c.status, c.owner_kind, u.full_name as owner_name, c.owner_user_id, c.assigned_user_id, c.priority, c.unread_count,
  c.last_message_at, c.last_message_preview, c.last_inbound_at, c.last_outbound_at, esc.id as esc_id, esc.status as esc_status, esc.urgency as esc_urgency,
  a.id as agent_id, a.display_name as agent_name, a.role_key as agent_role, c.ai_paused_at, c.archived_at, c.resolved_at, c.outcome, c.revision::text as revision,
  coalesce(${NEEDS_PERSON}, false) as needs_person, ${SEND_FAILED} as send_failed, ${AWAITING_REPLY} as awaiting_reply, ${WAITING} as waiting`;

export function toListItem(r: Row): ConversationListItem {
  const attention: AttentionReason[] = [];
  if (r.needs_person) attention.push("needs_person");
  if (r.send_failed) attention.push("send_failed");
  if (r.priority === "urgent") attention.push("urgent");
  if (r.awaiting_reply) attention.push("awaiting_reply");
  const open = r.status !== "closed" && !r.archived_at;
  return {
    id: r.id,
    contactId: r.contact_id,
    contactName: r.display_name || "Unknown contact",
    channel: r.channel,
    status: r.status,
    ownerKind: r.owner_kind,
    ownerName: r.owner_name,
    ownerUserId: r.owner_user_id,
    assignedUserId: r.assigned_user_id,
    priority: r.priority,
    unread: r.unread_count,
    lastMessageAt: iso(r.last_message_at),
    preview: maskCustomerLinks(r.last_message_preview),
    escalation: r.esc_id ? { id: r.esc_id, status: r.esc_status as string, urgency: r.esc_urgency as string } : null,
    aiAgent: r.agent_id ? { id: r.agent_id, name: r.agent_name ?? "AI employee", roleKey: r.agent_role ?? "" } : null,
    aiPaused: r.ai_paused_at !== null,
    archivedAt: iso(r.archived_at),
    resolvedAt: iso(r.resolved_at),
    outcome: r.outcome,
    lastInboundAt: iso(r.last_inbound_at),
    lastOutboundAt: iso(r.last_outbound_at),
    waitingOnCustomer: open && r.waiting,
    attention: open ? attention : [],
    revision: Number(r.revision),
  };
}

export interface PageOptions {
  /** The largest page that may be asked for (LIST_PAGE_MAX unless a caller with an older contract needs more). */
  max?: number;
  /** Read one extra row to learn whether a next page exists (default true). */
  lookahead?: boolean;
}

export interface ListPage {
  items: ConversationListItem[];
  /** Pass back as `cursor` for the next page; null when this was the last. */
  nextCursor: string | null;
}

/**
 * One page of the list. Conversations the person cannot see never appear (row-level security), a malformed cursor is ignored (first page),
 * and the order is total (rank, time, id) so a page boundary never repeats or skips a row while the list is changing.
 */
export async function listConversationsPage(ctx: OrgContext, f: ConversationFilters = {}, onlyId: string | null = null, opts: PageOptions = {}): Promise<ListPage> {
  if (!ctx.can("inbox.view")) throw new AppError("forbidden", "You can't view the inbox.");
  const params: unknown[] = [ctx.org.orgId];
  const bind = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  let meParam: string | null = null;
  const me = () => (meParam ??= bind(ctx.user.id));
  const where: string[] = ["c.org_id = $1"];
  if (onlyId) where.push(`c.id = ${bind(onlyId)}`);
  const view = f.view && (INBOX_VIEWS as readonly string[]).includes(f.view) ? f.view : null;
  if (view) where.push(`(${VIEW_SQL[view](me)})`);
  if (f.channel) where.push(`c.channel = ${bind(f.channel)}`);
  if (f.status) where.push(f.status === "closed" ? "c.status = 'closed'" : "c.status <> 'closed'");
  if (f.priority) where.push(`c.priority = ${bind(f.priority)}`);
  if (f.unreadOnly) where.push("c.unread_count > 0");
  if (f.owner === "mine") where.push(`c.owner_user_id = ${me()}`);
  else if (f.owner) where.push(`c.owner_kind = ${bind(f.owner)}`);
  const term = f.q?.trim().slice(0, 80) ?? "";
  if (term.length >= 1) {
    const p = bind(`%${escapeLike(term)}%`);
    where.push(
      `(k.display_name ilike ${p} escape '\\' or c.last_message_preview ilike ${p} escape '\\' or c.subject ilike ${p} escape '\\'
        or exists (select 1 from contact_identities i where i.contact_id = k.id and i.org_id = c.org_id and i.value ilike ${p} escape '\\')
        or (${term.length >= 3 ? "true" : "false"} and exists (select 1 from conversation_messages sm where sm.conversation_id = c.id and sm.org_id = c.org_id and sm.direction <> 'internal' and sm.body ilike ${p} escape '\\')))`,
    );
  }

  const sort = SORT_SQL[f.sort ?? "priority"] ?? SORT_SQL.priority;
  const cursor = decodeCursor(f.cursor);
  if (cursor) {
    const r = bind(cursor.rank);
    const k = bind(cursor.key);
    const i = bind(cursor.id);
    const past = sort.dir === "desc" ? "<" : ">";
    // The row after the cursor in (rank asc, key, id) order; the key and the id run the same way.
    where.push(`(${sort.rank} > ${r} or (${sort.rank} = ${r} and (${sort.key} ${past} ${k}::timestamptz or (${sort.key} = ${k}::timestamptz and c.id ${past} ${i}::uuid))))`);
  }
  const limit = Math.min(Math.max(Math.trunc(f.limit ?? LIST_PAGE_DEFAULT), 1), opts.max ?? LIST_PAGE_MAX);
  // One extra row says whether there is a next page, without a count. The older whole-list read (listConversations) has no next page to point to.
  const lookahead = opts.lookahead !== false;
  const limitParam = bind(limit + (lookahead ? 1 : 0));
  const sql = `with ${CTES}
    select ${LIST_COLUMNS}, ${sort.rank}::int as sort_rank, (${sort.key})::text as sort_key
    ${FROM}
    where ${where.join(" and ")}
    order by ${sort.rank} asc, ${sort.key} ${sort.dir}, c.id ${sort.dir}
    limit ${limitParam}`;
  const rows = await withUser(ctx.user.id, async (db) => (await db.query<Row>(sql, params)).rows);
  const more = lookahead && rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return { items: page.map(toListItem), nextCursor: more && last ? encodeCursor({ rank: last.sort_rank, key: last.sort_key, id: last.id }) : null };
}

/** One conversation's list row, read as the person (so opening one does not depend on it being in the first page). */
export async function getConversationListItem(ctx: OrgContext, conversationId: string): Promise<ConversationListItem | null> {
  const page = await listConversationsPage(ctx, { limit: 1 }, conversationId);
  return page.items[0] ?? null;
}

/**
 * How many conversations each view holds, for the badges. One pass over the workspace's conversations the person can see. The counts use
 * the same predicates as the list, so a badge never promises rows the view does not show.
 */
export async function inboxViewCounts(ctx: OrgContext): Promise<ViewCounts> {
  if (!ctx.can("inbox.view")) throw new AppError("forbidden", "You can't view the inbox.");
  const params: unknown[] = [ctx.org.orgId, ctx.user.id];
  const select = INBOX_VIEWS.map((v) => `count(*) filter (where ${VIEW_SQL[v](() => "$2")})::int as ${v}`).join(", ");
  const sql = `with ${CTES}
    select ${select} ${FROM} where c.org_id = $1`;
  const { rows } = await withUser(ctx.user.id, (db) => db.query<Record<InboxView, number>>(sql, params));
  const r = rows[0];
  return Object.fromEntries(INBOX_VIEWS.map((v) => [v, Number(r?.[v] ?? 0)])) as ViewCounts;
}
