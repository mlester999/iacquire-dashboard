import "server-only";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyStaffBatch, type StaffNoticeInput } from "@/server/notifications";
import { removeStoredObjectTrusted } from "@/server/storage/private";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import {
  factsOf, isId, loadReadableConversation, loadStaffActor, namesFor, nameOrFormer, standingOf, type ConversationRow, type PersonName, type StaffActor, type StaffUser,
} from "@/server/staff-messages/access";
import { bumpConversation } from "@/server/staff-messages/inbox";
import { translate } from "@/server/staff-messages/conversations";
import { normaliseBody } from "@/lib/staff-messages/body";
import { resolveMentions } from "@/lib/staff-messages/mentions";
import { isReaction, tallyReactions, type ReactionCount } from "@/lib/staff-messages/reactions";
import { threadRootFor } from "@/lib/staff-messages/threads";
import { attachmentIds } from "@/lib/staff-messages/attachments";
import { canDeleteMessage, canEditMessage, canPost, canReact } from "@/lib/staff-messages/conversations";
import { noticeLink, noticeWords, planMessageNotices, type Recipient } from "@/lib/staff-messages/notices";
import { MAX_PAGE_SIZE, PAGE_SIZE } from "@/lib/staff-messages/limits";
import { seqOf } from "@/lib/staff-messages/unread";

// Messages. A send takes the conversation's next number inside the sending transaction (the update of the counter also makes writers to one conversation take turns), so the
// order is the database's. A send carries an id its sender made, so a retry after a lost answer or a double click finds the message it already made and posts nothing twice.
// Nothing here puts a message's text in an audit row, a notification, a log or an error: those carry ids, kinds and the sender's name.

export interface AttachmentView {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface MessageView {
  id: string;
  conversationId: string;
  seq: number;
  threadRootId: string | null;
  authorId: string | null;
  author: PersonName;
  /** Empty for a message that was deleted. */
  body: string;
  mentions: string[];
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  /** Replies that still stand, for a message that starts a thread. */
  replyCount: number;
  reactions: ReactionCount[];
  attachments: AttachmentView[];
  mine: boolean;
}

interface RawMessage {
  id: string;
  conversation_id: string;
  seq: string;
  thread_root_id: string | null;
  author_id: string | null;
  body: string;
  mentions: string[];
  created_at: Date | string;
  edited_at: Date | string | null;
  deleted_at: Date | string | null;
  reply_count: number;
}

const MESSAGE_COLUMNS = `m.id, m.conversation_id, m.seq::text as seq, m.thread_root_id, m.author_id, m.body, m.mentions, m.created_at, m.edited_at, m.deleted_at,
  (select count(*)::int from staff_messages r where r.thread_root_id = m.id and r.deleted_at is null) as reply_count`;

/** Reactions, files and names for a set of messages, on whichever connection read them. Names are read separately (see readNames). */
async function decorate(db: Queryable, viewerId: string, rows: readonly RawMessage[]): Promise<{ reactions: Map<string, ReactionCount[]>; attachments: Map<string, AttachmentView[]> }> {
  const reactions = new Map<string, ReactionCount[]>();
  const attachments = new Map<string, AttachmentView[]>();
  const ids = rows.map((r) => r.id);
  if (!ids.length) return { reactions, attachments };
  const r = await db.query<{ message_id: string; reaction: string; user_id: string }>("select message_id, reaction, user_id from staff_message_reactions where message_id = any($1::uuid[])", [ids]);
  const byMessage = new Map<string, Array<{ reaction: string; userId: string }>>();
  for (const x of r.rows) byMessage.set(x.message_id, [...(byMessage.get(x.message_id) ?? []), { reaction: x.reaction, userId: x.user_id }]);
  for (const [id, list] of byMessage) reactions.set(id, tallyReactions(list, viewerId));
  const a = await db.query<{ id: string; message_id: string; filename: string; mime_type: string; size_bytes: number }>(
    "select id, message_id, filename, mime_type, size_bytes from staff_message_attachments where message_id = any($1::uuid[]) and status = 'attached' order by created_at, id",
    [ids],
  );
  for (const x of a.rows) attachments.set(x.message_id, [...(attachments.get(x.message_id) ?? []), { id: x.id, filename: x.filename, mimeType: x.mime_type, sizeBytes: Number(x.size_bytes) }]);
  return { reactions, attachments };
}

function toView(row: RawMessage, viewerId: string, names: Map<string, PersonName>, extra: Awaited<ReturnType<typeof decorate>>): MessageView {
  const deleted = row.deleted_at !== null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    seq: seqOf(row.seq),
    threadRootId: row.thread_root_id,
    authorId: row.author_id,
    author: nameOrFormer(names, row.author_id),
    body: deleted ? "" : row.body,
    mentions: deleted ? [] : row.mentions,
    createdAt: new Date(row.created_at).toISOString(),
    editedAt: row.edited_at ? new Date(row.edited_at).toISOString() : null,
    deleted,
    replyCount: row.reply_count,
    reactions: deleted ? [] : (extra.reactions.get(row.id) ?? []),
    attachments: deleted ? [] : (extra.attachments.get(row.id) ?? []),
    mine: row.author_id === viewerId,
  };
}

async function limitSend(userId: string): Promise<void> {
  const limit = await consumeRateLimit(RATE_LIMITS.staffMessageSendByUser, userId);
  if (!limit.allowed) throw new AppError("rate_limited", "You are sending messages very quickly. Wait a moment and try again.", { retryAfterSeconds: limit.retryAfterSeconds });
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export interface SendInput {
  conversationId: unknown;
  /** Made by the sender's browser for each message it composes; a retry carries the same one. */
  clientMessageId: unknown;
  body: unknown;
  /** The message to reply to; a reply to a reply joins the same thread. */
  threadRootId?: unknown;
  attachmentIds?: unknown;
}

export interface SendResult {
  message: MessageView;
  /** True when this exact send had already been made: nothing new was posted. */
  duplicate: boolean;
}

interface Member {
  user_id: string;
  notify: "all" | "mentions" | "none";
  muted: boolean;
  last_read_seq: string;
}

async function bindAttachments(db: Queryable, p: { messageId: string; conversationId: string; userId: string; ids: readonly string[] }): Promise<void> {
  if (!p.ids.length) return;
  const { rows } = await db.query<{ id: string }>(
    `update staff_message_attachments set message_id = $2, status = 'attached', attached_at = now()
      where id = any($1::uuid[]) and conversation_id = $3 and uploaded_by = $4 and status = 'staged' and message_id is null and expires_at > now() returning id`,
    [p.ids, p.messageId, p.conversationId, p.userId],
  );
  if (rows.length !== p.ids.length) throw new AppError("invalid_input", "One of the attachments is no longer available. Remove it and add it again.");
}

async function announceMessage(db: Queryable, actor: StaffActor, c: ConversationRow, p: { messageId: string; mentions: readonly string[]; members: readonly Member[] }): Promise<void> {
  const recipients: Recipient[] = p.members.map((m) => ({ userId: m.user_id, notify: m.notify, muted: m.muted, lastReadSeq: seqOf(m.last_read_seq) }));
  const plan = planMessageNotices({ conversationId: c.id, messageId: p.messageId, authorId: actor.userId, mentions: p.mentions }, recipients);
  const notices: StaffNoticeInput[] = plan.map((n) => {
    const words = noticeWords(n.kind, c.kind, actor.name, c.name);
    return { userId: n.userId, kind: n.kind, title: words.title, body: words.body, link: noticeLink(c.id), dedupeKey: n.dedupeKey };
  });
  await notifyStaffBatch(db, notices);
}

/** Posts a message. A repeat of an earlier send (same conversation, same sender, same client id) posts nothing and returns the message that exists. */
export async function sendMessage(user: StaffUser, input: SendInput): Promise<SendResult> {
  const actor = await loadStaffActor(user);
  if (!isId(input.clientMessageId)) throw new AppError("invalid_input", "That message is missing its id. Reload the page and try again.");
  const body = normaliseBody(input.body);
  if (!body.ok) throw new AppError("invalid_input", body.message);
  const files = attachmentIds(input.attachmentIds);
  if (!files.ok) throw new AppError("invalid_input", files.message);
  if (files.ids.some((id) => !isId(id))) throw new AppError("invalid_input", "Those attachments are not valid.");
  if (input.threadRootId !== undefined && input.threadRootId !== null && !isId(input.threadRootId)) throw new AppError("invalid_input", "That message is no longer there.");
  await limitSend(actor.userId);
  const clientId = (input.clientMessageId as string).toLowerCase();

  const attempt = () =>
    withSystem(async (db): Promise<SendResult> => {
      // The conversation's row is taken first: everyone writing to it takes turns, so the check for an earlier send below cannot race another copy of the same send.
      const c = await loadReadableConversation(db, actor, input.conversationId, { lock: true });
      const existing = await db.query<{ id: string }>("select id from staff_messages where conversation_id = $1 and author_id = $2 and client_message_id = $3", [c.id, actor.userId, clientId]);
      if (existing.rows[0]) return { message: (await viewOne(db, actor.userId, existing.rows[0].id)) as MessageView, duplicate: true };
      if (!canPost(factsOf(c), standingOf(actor, c))) throw new AppError(c.archived ? "conflict" : "forbidden", c.archived ? "This conversation is archived. Bring it back to write in it." : "You can't write in this conversation.");

      const members = (await db.query<Member>("select user_id, notify, muted, last_read_seq::text as last_read_seq from staff_conversation_members where conversation_id = $1 and left_at is null", [c.id])).rows;
      const mentions = resolveMentions(body.body, members.map((m) => m.user_id));
      if (!mentions.ok) throw new AppError("invalid_input", mentions.message);

      let rootId: string | null = null;
      if (typeof input.threadRootId === "string") {
        const target = (await db.query<{ id: string; thread_root_id: string | null }>("select id, thread_root_id from staff_messages where id = $1 and conversation_id = $2", [input.threadRootId, c.id])).rows[0];
        if (!target) throw new AppError("invalid_input", "That message is no longer there.");
        rootId = threadRootFor({ id: target.id, threadRootId: target.thread_root_id });
      }

      const seq = (await db.query<{ last_seq: string }>("update staff_conversations set last_seq = last_seq + 1, last_message_at = now() where id = $1 returning last_seq::text as last_seq", [c.id])).rows[0].last_seq;
      const inserted = await db.query<{ id: string }>(
        `insert into staff_messages (org_id, conversation_id, seq, thread_root_id, author_id, body, mentions, client_message_id)
         values ($1, $2, $3::bigint, $4, $5, $6, $7::uuid[], $8) returning id`,
        [actor.agencyOrgId, c.id, seq, rootId, actor.userId, body.body, mentions.ids, clientId],
      );
      const id = inserted.rows[0].id;
      await bindAttachments(db, { messageId: id, conversationId: c.id, userId: actor.userId, ids: files.ids });
      // Writing in a conversation counts as having read it up to the new message.
      await db.query("update staff_conversation_members set last_read_seq = $3::bigint, last_read_at = now() where conversation_id = $1 and user_id = $2", [c.id, actor.userId, seq]);
      await announceMessage(db, actor, c, { messageId: id, mentions: mentions.ids, members });
      await bumpConversation(db, actor.agencyOrgId, c.id);
      return { message: (await viewOne(db, actor.userId, id)) as MessageView, duplicate: false };
    });

  try {
    return await attempt();
  } catch (error) {
    // The unique key on (conversation, sender, client id) is the last word on a race the lock above should already have settled: if it fired, the message exists.
    if (error instanceof Error && error.message.includes("staff_messages_conversation_id_author_id_client_message_id_key")) {
      return withSystem(async (db): Promise<SendResult> => {
        const c = await loadReadableConversation(db, actor, input.conversationId);
        const found = await db.query<{ id: string }>("select id from staff_messages where conversation_id = $1 and author_id = $2 and client_message_id = $3", [c.id, actor.userId, clientId]);
        if (!found.rows[0]) throw error;
        return { message: (await viewOne(db, actor.userId, found.rows[0].id)) as MessageView, duplicate: true };
      });
    }
    return translate(error);
  }
}

/** One message as the sender sees it, read on the sending connection (so a message not yet committed is found). */
async function viewOne(db: Queryable, viewerId: string, id: string): Promise<MessageView | null> {
  const { rows } = await db.query<RawMessage>(`select ${MESSAGE_COLUMNS} from staff_messages m where m.id = $1`, [id]);
  if (!rows[0]) return null;
  const names = await namesFor(db, [rows[0].author_id]);
  return toView(rows[0], viewerId, names, await decorate(db, viewerId, rows));
}

// ---------------------------------------------------------------------------
// Editing, deleting, reacting
// ---------------------------------------------------------------------------

interface Located {
  c: ConversationRow;
  message: { id: string; author_id: string | null; deleted: boolean; body: string; mentions: string[]; thread_root_id: string | null; edited_at: string | null };
}

async function locate(db: Queryable, actor: StaffActor, messageId: unknown, opts: { lock?: boolean } = {}): Promise<Located> {
  if (!isId(messageId)) throw new AppError("not_found", "That message was not found.");
  const row = (await db.query<{ id: string; conversation_id: string; author_id: string | null; deleted_at: Date | null; body: string; mentions: string[]; thread_root_id: string | null; edited_at: Date | string | null }>(
    "select id, conversation_id, author_id, deleted_at, body, mentions, thread_root_id, edited_at from staff_messages where id = $1",
    [messageId],
  )).rows[0];
  if (!row) throw new AppError("not_found", "That message was not found.");
  // A message in a conversation the person is not in reads as not found, in the same words as an id that never existed.
  const c = await loadReadableConversation(db, actor, row.conversation_id, opts).catch((error) => {
    if (error instanceof AppError && error.code === "not_found") throw new AppError("not_found", "That message was not found.");
    throw error;
  });
  return { c, message: { id: row.id, author_id: row.author_id, deleted: row.deleted_at !== null, body: row.body, mentions: row.mentions, thread_root_id: row.thread_root_id, edited_at: row.edited_at ? new Date(row.edited_at).toISOString() : null } };
}

export const EDIT_CONFLICT_MESSAGE = "This message was changed somewhere else (another tab or window) after you opened it. Your edit was not saved. Close the editor and open it again to see the latest text.";

/**
 * Changes the text of the person's own message. The edit is marked on the message; a mention that is new is announced. `expectedEditedAt` is the edit stamp the editor started
 * from (null for a message never edited): when it is given and the message has been edited since, nothing is saved and the person is told, instead of the later edit being
 * silently overwritten.
 */
export async function editMessage(user: StaffUser, input: { messageId: unknown; body: unknown; expectedEditedAt?: unknown }): Promise<MessageView> {
  const actor = await loadStaffActor(user);
  const body = normaliseBody(input.body);
  if (!body.ok) throw new AppError("invalid_input", body.message);
  const expected = input.expectedEditedAt;
  if (expected !== undefined && expected !== null && (typeof expected !== "string" || Number.isNaN(new Date(expected).getTime()))) throw new AppError("invalid_input", "That edit stamp is not valid. Reload the page and try again.");
  await limitSend(actor.userId);
  return withSystem(async (db) => {
    const { c, message } = await locate(db, actor, input.messageId, { lock: true });
    if (!canEditMessage(factsOf(c), standingOf(actor, c), actor.userId, { authorId: message.author_id, deleted: message.deleted })) {
      throw new AppError(message.author_id === actor.userId ? "conflict" : "forbidden", message.author_id === actor.userId ? "This message can't be edited any more." : "You can only edit your own messages.");
    }
    if (expected !== undefined && (expected === null ? null : new Date(expected as string).toISOString()) !== message.edited_at) throw new AppError("conflict", EDIT_CONFLICT_MESSAGE);
    // The same text again is not an edit: nothing is checked, stamped or announced.
    if (body.body === message.body) return (await viewOne(db, actor.userId, message.id)) as MessageView;
    const members = (await db.query<Member>("select user_id, notify, muted, last_read_seq::text as last_read_seq from staff_conversation_members where conversation_id = $1 and left_at is null", [c.id])).rows;
    const mentions = resolveMentions(body.body, members.map((m) => m.user_id));
    if (!mentions.ok) throw new AppError("invalid_input", mentions.message);
    await db.query("update staff_messages set body = $2, mentions = $3::uuid[] where id = $1", [message.id, body.body, mentions.ids]);
    // Only people newly named are told: the key of a mention notice is the message, so someone named before is not told again. Ordinary notices are not repeated for an edit
    // (every recipient is treated as having muted the conversation, which leaves mentions as the only thing announced).
    await announceMessage(db, actor, c, { messageId: message.id, mentions: mentions.ids, members: members.map((m) => ({ ...m, muted: true })) });
    await bumpConversation(db, actor.agencyOrgId, c.id);
    return (await viewOne(db, actor.userId, message.id)) as MessageView;
  });
}

/** Removes the files of a deleted message from storage (access was already withdrawn in the transaction). Best effort: the maintenance job finishes what could not be removed here. */
export async function finishRemovedFiles(messageIds: readonly string[]): Promise<number> {
  if (!messageIds.length) return 0;
  const files = (await withSystem((db) =>
    db.query<{ id: string; org_id: string; storage_key: string }>(
      `select a.id, a.org_id, f.storage_key from staff_message_attachments a join private_files f on f.id = a.private_file_id
        where a.message_id = any($1::uuid[]) and a.status = 'attached' and f.status = 'deleted' and f.bucket = 'staff-messages'`,
      [messageIds],
    ),
  )).rows;
  let done = 0;
  for (const f of files) {
    try {
      await removeStoredObjectTrusted({ orgId: f.org_id, bucket: "staff-messages", storageKey: f.storage_key });
    } catch {
      continue;
    }
    await withSystem((db) => db.query("update staff_message_attachments set status = 'removed' where id = $1", [f.id]));
    done += 1;
  }
  return done;
}

/** Deletes a message: its place stays and its text, reactions and files go. The author deletes their own; a moderator deletes one in a channel they belong to (audited). */
export async function deleteMessage(user: StaffUser, messageId: unknown): Promise<void> {
  const actor = await loadStaffActor(user);
  await limitSend(actor.userId);
  const id = await withSystem(async (db) => {
    const { c, message } = await locate(db, actor, messageId, { lock: true });
    if (message.deleted) return null;
    if (!canDeleteMessage(factsOf(c), standingOf(actor, c), actor.userId, { authorId: message.author_id, deleted: message.deleted })) {
      throw new AppError("forbidden", message.author_id === actor.userId ? "This message can't be deleted." : "You can only delete your own messages.");
    }
    await db.query("update staff_messages set body = '', mentions = '{}', deleted_at = now(), deleted_by = $2 where id = $1 and deleted_at is null", [message.id, actor.userId]);
    await db.query("delete from staff_message_reactions where message_id = $1", [message.id]);
    // Access to the files is withdrawn now; the stored bytes are removed right after the commit.
    await db.query("update private_files set status = 'deleted' where id in (select private_file_id from staff_message_attachments where message_id = $1)", [message.id]);
    if (message.author_id !== actor.userId) {
      await recordAudit({ orgId: actor.agencyOrgId, actorUserId: actor.userId, actorKind: "agency", action: "staff_messages.message_removed_by_moderator", targetType: "staff_message", targetId: message.id, result: "success", metadata: { conversation: c.id } }, db);
    }
    await bumpConversation(db, actor.agencyOrgId, c.id);
    return message.id;
  });
  if (id) await finishRemovedFiles([id]).catch(() => 0);
}

/** Adds or takes away the person's own reaction. Returns the message's reactions as they stand. */
export async function setReaction(user: StaffUser, input: { messageId: unknown; reaction: unknown; on: boolean }): Promise<ReactionCount[]> {
  const actor = await loadStaffActor(user);
  if (!isReaction(input.reaction)) throw new AppError("invalid_input", "That reaction is not available.");
  const limit = await consumeRateLimit(RATE_LIMITS.staffMessageReactByUser, actor.userId);
  if (!limit.allowed) throw new AppError("rate_limited", "You are reacting very quickly. Wait a moment and try again.", { retryAfterSeconds: limit.retryAfterSeconds });
  return withSystem(async (db) => {
    const { c, message } = await locate(db, actor, input.messageId);
    if (!canReact(factsOf(c), standingOf(actor, c), { authorId: message.author_id, deleted: message.deleted })) throw new AppError("conflict", "You can't react to this message.");
    if (input.on) {
      const added = await db.query(
        "insert into staff_message_reactions (message_id, user_id, reaction, conversation_id, org_id) values ($1, $2, $3, $4, $5) on conflict do nothing returning message_id",
        [message.id, actor.userId, input.reaction, c.id, actor.agencyOrgId],
      );
      if (added.rows.length) await bumpConversation(db, actor.agencyOrgId, c.id);
    } else {
      const removed = await db.query("delete from staff_message_reactions where message_id = $1 and user_id = $2 and reaction = $3 returning message_id", [message.id, actor.userId, input.reaction]);
      if (removed.rows.length) await bumpConversation(db, actor.agencyOrgId, c.id);
    }
    const r = await db.query<{ reaction: string; user_id: string }>("select reaction, user_id from staff_message_reactions where message_id = $1", [message.id]);
    return tallyReactions(r.rows.map((x) => ({ reaction: x.reaction, userId: x.user_id })), actor.userId);
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface MessagePage {
  messages: MessageView[];
  /** True when older messages exist above the first one returned. */
  hasMore: boolean;
  lastSeq: number;
  lastReadSeq: number;
}

/**
 * A page of a conversation, oldest first. The main view lists the messages that start a thread or stand alone, with their reply counts; a thread view lists the starting
 * message and its replies. Read under the person's own row-level security, after a check that they are a member (so a conversation they are not in reads as not found).
 */
export async function listMessages(user: StaffUser, conversationId: unknown, opts: { beforeSeq?: number | null; limit?: number; threadRootId?: string | null } = {}): Promise<MessagePage> {
  const actor = await loadStaffActor(user);
  if (!isId(conversationId)) throw new AppError("not_found", "That conversation was not found.");
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(opts.limit ?? PAGE_SIZE)));
  const before = opts.beforeSeq !== undefined && opts.beforeSeq !== null && Number.isSafeInteger(opts.beforeSeq) && opts.beforeSeq > 0 ? opts.beforeSeq : null;
  if (opts.threadRootId && !isId(opts.threadRootId)) throw new AppError("not_found", "That message was not found.");
  const read = await withUser(actor.userId, async (db) => {
    const mine = (await db.query<{ last_read_seq: string; last_seq: string }>(
      `select m.last_read_seq::text as last_read_seq, c.last_seq::text as last_seq from staff_conversation_members m join staff_conversations c on c.id = m.conversation_id
        where m.conversation_id = $1 and m.user_id = $2 and m.left_at is null`,
      [conversationId, actor.userId],
    )).rows[0];
    if (!mine) throw new AppError("not_found", "That conversation was not found.");
    const rows = opts.threadRootId
      ? (await db.query<RawMessage>(`select ${MESSAGE_COLUMNS} from staff_messages m where m.conversation_id = $1 and (m.id = $2 or m.thread_root_id = $2) order by m.seq limit $3`, [conversationId, opts.threadRootId, limit + 1])).rows
      : (await db.query<RawMessage>(
          `select ${MESSAGE_COLUMNS} from staff_messages m where m.conversation_id = $1 and m.thread_root_id is null and ($2::bigint is null or m.seq < $2::bigint) order by m.seq desc limit $3`,
          [conversationId, before, limit + 1],
        )).rows.reverse();
    const hasMore = rows.length > limit;
    // A page of the main view dropped its oldest row to make room for the check; a thread view drops its newest.
    const page = hasMore ? (opts.threadRootId ? rows.slice(0, limit) : rows.slice(1)) : rows;
    return { page, hasMore, mine, extra: await decorate(db, actor.userId, page) };
  });
  const names = await withSystem((db) => namesFor(db, read.page.map((r) => r.author_id)));
  return {
    messages: read.page.map((r) => toView(r, actor.userId, names, read.extra)),
    hasMore: read.hasMore,
    lastSeq: seqOf(read.mine.last_seq),
    lastReadSeq: seqOf(read.mine.last_read_seq),
  };
}
