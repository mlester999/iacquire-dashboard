import "server-only";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyStaffBatch } from "@/server/notifications";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import {
  assertEligible, factsOf, loadConversation, loadReadableConversation, loadStaffActor, namesFor, nameOrFormer, requireStaffCap, standingOf, isId,
  type ConversationRow, type PersonName, type StaffActor, type StaffUser,
} from "@/server/staff-messages/access";
import { bumpConversation, bumpInbox } from "@/server/staff-messages/inbox";
import {
  canArchive, canCreate, canJoin, canLeave, canManageMembers, canPost, canRename, normaliseName, normaliseTopic,
  type ChannelVisibility, type ConversationKind, type MemberRole,
} from "@/lib/staff-messages/conversations";
import { directKey, isUserId, peerOf } from "@/lib/staff-messages/direct";
import { MAX_MEMBERS } from "@/lib/staff-messages/limits";
import { noticeLink, noticeWords } from "@/lib/staff-messages/notices";
import { unreadCount } from "@/lib/staff-messages/unread";

// Conversations: direct messages (one per pair), private groups, and channels (open to the whole team, or by invitation). Reads go through the person's own row-level
// security; every write runs in one transaction in trusted code after the person's standing and place in the conversation were read from the database. Who joined, left,
// renamed or archived is recorded as an event for the members and as an audit row (ids and kinds only, never a name's text or a message).

export type EventKind = "created" | "member_added" | "member_removed" | "member_left" | "renamed" | "topic_changed" | "archived" | "unarchived";

export async function addEvent(db: Queryable, orgId: string, conversationId: string, kind: EventKind, actorId: string | null, subjectId: string | null = null): Promise<void> {
  await db.query("insert into staff_conversation_events (org_id, conversation_id, kind, actor_id, subject_id) values ($1, $2, $3, $4, $5)", [orgId, conversationId, kind, actorId, subjectId]);
}

/** Turns the database's refusals into sentences. Anything else is rethrown as it is (the action wrapper hides it from the person). */
export function translate(error: unknown): never {
  const text = error instanceof Error ? error.message : String(error);
  if (text.includes("staff_conversations_channel_name_idx")) throw new AppError("conflict", "A channel with that name already exists. Choose another name.");
  if (text.includes("staff_conversation_is_full")) throw new AppError("conflict", `A conversation can have up to ${MAX_MEMBERS} people.`);
  if (text.includes("staff_member_not_eligible")) throw new AppError("invalid_input", "Someone you chose is not on the agency team or cannot use Messages.");
  throw error;
}

async function limitManage(userId: string): Promise<void> {
  const limit = await consumeRateLimit(RATE_LIMITS.staffMessageManageByUser, userId);
  if (!limit.allowed) throw new AppError("rate_limited", "You have changed a lot of conversations in a short time. Try again later.", { retryAfterSeconds: limit.retryAfterSeconds });
}

const uniqueOthers = (me: string, ids: readonly unknown[] | undefined): string[] => {
  const out = new Set<string>();
  for (const id of ids ?? []) {
    if (typeof id !== "string" || !isUserId(id)) throw new AppError("invalid_input", "Someone you chose is not a valid person.");
    if (id.toLowerCase() !== me.toLowerCase()) out.add(id.toLowerCase());
  }
  return [...out];
};

/** Puts people in a conversation, or back in it if they had left. Returns the ones who are newly in (the others were already members). They start with nothing unread. */
async function putMembers(db: Queryable, conversationId: string, ids: readonly string[], notify: "all" | "mentions", addedBy: string): Promise<string[]> {
  if (!ids.length) return [];
  const { rows } = await db.query<{ user_id: string }>(
    `insert into staff_conversation_members (conversation_id, user_id, org_id, role, notify, added_by, last_read_seq)
     select c.id, u, c.org_id, 'member', $3, $4, c.last_seq from staff_conversations c, unnest($2::uuid[]) as u where c.id = $1
     on conflict (conversation_id, user_id) do update
       set left_at = null, role = 'member', notify = excluded.notify, added_by = excluded.added_by, last_read_seq = excluded.last_read_seq, last_read_at = null
       where staff_conversation_members.left_at is not null
     returning user_id`,
    [conversationId, ids, notify, addedBy],
  );
  return rows.map((r) => r.user_id);
}

/** A group or channel always has an owner while it has people: if the last one has gone, the member who has been in it longest takes over. A direct message has no owners. */
export async function ensureOwner(db: Queryable, conversationId: string): Promise<void> {
  await db.query(
    `update staff_conversation_members m set role = 'owner'
      where m.conversation_id = $1 and m.left_at is null
        and exists (select 1 from staff_conversations c where c.id = $1 and c.kind <> 'direct')
        and not exists (select 1 from staff_conversation_members o where o.conversation_id = $1 and o.left_at is null and o.role = 'owner')
        and m.user_id = (select x.user_id from staff_conversation_members x where x.conversation_id = $1 and x.left_at is null order by x.joined_at, x.user_id limit 1)`,
    [conversationId],
  );
}

async function announceAdded(db: Queryable, actor: StaffActor, conversation: Pick<ConversationRow, "id" | "kind" | "name">, ids: readonly string[]): Promise<void> {
  if (!ids.length || conversation.kind === "direct") return;
  const words = noticeWords("staff_message_added", conversation.kind, actor.name, conversation.name);
  // No dedupe key: only people who were not in the conversation a moment ago are named here, so each is told once per time they are added.
  await notifyStaffBatch(db, ids.map((userId) => ({ userId, kind: "staff_message_added" as const, title: words.title, body: words.body, link: noticeLink(conversation.id) })));
}

// ---------------------------------------------------------------------------
// Starting conversations
// ---------------------------------------------------------------------------

export interface CreatedConversation {
  id: string;
  created: boolean;
}

/** The direct message with another person, made if it is not there yet (one per pair, whoever opens it first). */
export async function createDirect(user: StaffUser, otherUserId: unknown): Promise<CreatedConversation> {
  const actor = await loadStaffActor(user);
  if (typeof otherUserId !== "string" || !isUserId(otherUserId)) throw new AppError("invalid_input", "Choose a person to message.");
  if (otherUserId.toLowerCase() === actor.userId.toLowerCase()) throw new AppError("invalid_input", "You can't send a direct message to yourself.");
  const key = directKey(actor.userId, otherUserId);
  const existing = await withSystem(async (db) => (await db.query<{ id: string }>("select id from staff_conversations where direct_key = $1", [key])).rows[0]);
  if (!existing) await limitManage(actor.userId);
  return withSystem(async (db) => {
    await assertEligible(db, [otherUserId.toLowerCase()]);
    const made = await db.query<{ id: string }>(
      "insert into staff_conversations (org_id, kind, direct_key, created_by) values ($1, 'direct', $2, $3) on conflict (direct_key) where direct_key is not null do nothing returning id",
      [actor.agencyOrgId, key, actor.userId],
    );
    const id = made.rows[0]?.id ?? (await db.query<{ id: string }>("select id from staff_conversations where direct_key = $1", [key])).rows[0].id;
    // Both people are in it; someone who had been closed out of it (their account stopped being agency staff, then came back) is let back in.
    const added = await putMembers(db, id, [actor.userId.toLowerCase(), otherUserId.toLowerCase()], "all", actor.userId);
    if (made.rows[0]) {
      await addEvent(db, actor.agencyOrgId, id, "created", actor.userId);
      await recordAudit({ orgId: actor.agencyOrgId, actorUserId: actor.userId, actorKind: "agency", action: "staff_messages.conversation_created", targetType: "staff_conversation", targetId: id, result: "success", metadata: { kind: "direct" } }, db);
    }
    if (added.length) await bumpInbox(db, actor.agencyOrgId, [actor.userId, otherUserId]);
    return { id, created: Boolean(made.rows[0]) };
  }).catch(translate);
}

/** A private group of the people chosen (and the person making it, who owns it). */
export async function createGroup(user: StaffUser, input: { name: unknown; memberIds: readonly unknown[] }): Promise<CreatedConversation> {
  const actor = await loadStaffActor(user);
  if (!canCreate("group", actor.caps)) throw new AppError("forbidden", "You can't start a group.");
  const name = normaliseName("group", input.name);
  if (!name.ok) throw new AppError("invalid_input", name.message);
  const others = uniqueOthers(actor.userId, input.memberIds);
  if (!others.length) throw new AppError("invalid_input", "Choose at least one other person for the group.");
  if (others.length + 1 > MAX_MEMBERS) throw new AppError("invalid_input", `A conversation can have up to ${MAX_MEMBERS} people.`);
  await limitManage(actor.userId);
  return withSystem(async (db) => {
    await assertEligible(db, others);
    const { rows } = await db.query<{ id: string }>("insert into staff_conversations (org_id, kind, name, created_by) values ($1, 'group', $2, $3) returning id", [actor.agencyOrgId, name.value, actor.userId]);
    const id = rows[0].id;
    await db.query("insert into staff_conversation_members (conversation_id, user_id, org_id, role, notify, added_by) values ($1, $2, $3, 'owner', 'all', $2)", [id, actor.userId, actor.agencyOrgId]);
    await putMembers(db, id, others, "all", actor.userId);
    await addEvent(db, actor.agencyOrgId, id, "created", actor.userId);
    for (const subject of others) await addEvent(db, actor.agencyOrgId, id, "member_added", actor.userId, subject);
    await announceAdded(db, actor, { id, kind: "group", name: name.value }, others);
    await bumpConversation(db, actor.agencyOrgId, id);
    await recordAudit({ orgId: actor.agencyOrgId, actorUserId: actor.userId, actorKind: "agency", action: "staff_messages.conversation_created", targetType: "staff_conversation", targetId: id, result: "success", metadata: { kind: "group", members: others.length + 1 } }, db);
    return { id, created: true };
  }).catch(translate);
}

/** A channel: open to the whole team to join, or by invitation. Needs the channels permission. */
export async function createChannel(user: StaffUser, input: { name: unknown; topic?: unknown; visibility: unknown; memberIds?: readonly unknown[] }): Promise<CreatedConversation> {
  const actor = await requireStaffCap(user, "channels");
  const name = normaliseName("channel", input.name);
  if (!name.ok) throw new AppError("invalid_input", name.message);
  const topic = normaliseTopic(input.topic);
  if (!topic.ok) throw new AppError("invalid_input", topic.message);
  if (input.visibility !== "staff" && input.visibility !== "private") throw new AppError("invalid_input", "Choose whether the channel is open to the team or private.");
  const visibility: ChannelVisibility = input.visibility;
  const others = uniqueOthers(actor.userId, input.memberIds);
  if (others.length + 1 > MAX_MEMBERS) throw new AppError("invalid_input", `A conversation can have up to ${MAX_MEMBERS} people.`);
  await limitManage(actor.userId);
  return withSystem(async (db) => {
    await assertEligible(db, others);
    const { rows } = await db.query<{ id: string }>(
      "insert into staff_conversations (org_id, kind, name, topic, visibility, created_by) values ($1, 'channel', $2, $3, $4, $5) returning id",
      [actor.agencyOrgId, name.value, topic.value || null, visibility, actor.userId],
    );
    const id = rows[0].id;
    // People in a channel hear about mentions by default, not about every message.
    await db.query("insert into staff_conversation_members (conversation_id, user_id, org_id, role, notify, added_by) values ($1, $2, $3, 'owner', 'mentions', $2)", [id, actor.userId, actor.agencyOrgId]);
    await putMembers(db, id, others, "mentions", actor.userId);
    await addEvent(db, actor.agencyOrgId, id, "created", actor.userId);
    for (const subject of others) await addEvent(db, actor.agencyOrgId, id, "member_added", actor.userId, subject);
    await announceAdded(db, actor, { id, kind: "channel", name: name.value }, others);
    await bumpConversation(db, actor.agencyOrgId, id);
    await recordAudit({ orgId: actor.agencyOrgId, actorUserId: actor.userId, actorKind: "agency", action: "staff_messages.conversation_created", targetType: "staff_conversation", targetId: id, result: "success", metadata: { kind: "channel", visibility, members: others.length + 1 } }, db);
    return { id, created: true };
  }).catch(translate);
}

// ---------------------------------------------------------------------------
// Changing who is in a conversation, and what it is called
// ---------------------------------------------------------------------------

export async function joinChannel(user: StaffUser, conversationId: unknown): Promise<void> {
  const actor = await loadStaffActor(user);
  await limitManage(actor.userId);
  await withSystem(async (db) => {
    const c = await loadConversation(db, actor, conversationId, { lock: true });
    if (c.memberRole) return;
    if (!canJoin(factsOf(c), standingOf(actor, c))) throw new AppError("not_found", "That conversation was not found.");
    const added = await putMembers(db, c.id, [actor.userId], "mentions", actor.userId);
    if (added.length) {
      await addEvent(db, actor.agencyOrgId, c.id, "member_added", actor.userId, actor.userId);
      await recordAudit({ orgId: actor.agencyOrgId, actorUserId: actor.userId, actorKind: "agency", action: "staff_messages.member_joined", targetType: "staff_conversation", targetId: c.id, result: "success" }, db);
      await bumpConversation(db, actor.agencyOrgId, c.id);
    }
  }).catch(translate);
}

export async function leaveConversation(user: StaffUser, conversationId: unknown): Promise<void> {
  const actor = await loadStaffActor(user);
  await limitManage(actor.userId);
  await withSystem(async (db) => {
    const c = await loadReadableConversation(db, actor, conversationId, { lock: true });
    if (!canLeave(factsOf(c), standingOf(actor, c))) throw new AppError("invalid_input", "A direct message can't be left. Mute it instead.");
    await db.query("update staff_conversation_members set left_at = now() where conversation_id = $1 and user_id = $2 and left_at is null", [c.id, actor.userId]);
    await ensureOwner(db, c.id);
    await addEvent(db, actor.agencyOrgId, c.id, "member_left", actor.userId, actor.userId);
    await recordAudit({ orgId: actor.agencyOrgId, actorUserId: actor.userId, actorKind: "agency", action: "staff_messages.member_left", targetType: "staff_conversation", targetId: c.id, result: "success" }, db);
    await bumpConversation(db, actor.agencyOrgId, c.id, [actor.userId]);
  }).catch(translate);
}

export async function addMembers(user: StaffUser, conversationId: unknown, memberIds: readonly unknown[]): Promise<{ added: number }> {
  const actor = await loadStaffActor(user);
  const wanted = uniqueOthers(actor.userId, memberIds);
  if (!wanted.length) throw new AppError("invalid_input", "Choose the people to add.");
  await limitManage(actor.userId);
  return withSystem(async (db) => {
    const c = await loadConversation(db, actor, conversationId, { lock: true });
    if (!canManageMembers(factsOf(c), standingOf(actor, c))) throw new AppError(c.memberRole ? "forbidden" : "not_found", c.memberRole ? "You can't change who is in this conversation." : "That conversation was not found.");
    await assertEligible(db, wanted);
    const added = await putMembers(db, c.id, wanted, c.kind === "channel" ? "mentions" : "all", actor.userId);
    for (const subject of added) await addEvent(db, actor.agencyOrgId, c.id, "member_added", actor.userId, subject);
    await announceAdded(db, actor, c, added);
    if (added.length) {
      await recordAudit({ orgId: actor.agencyOrgId, actorUserId: actor.userId, actorKind: "agency", action: "staff_messages.members_added", targetType: "staff_conversation", targetId: c.id, result: "success", metadata: { subjects: added } }, db);
      await bumpConversation(db, actor.agencyOrgId, c.id);
    }
    return { added: added.length };
  }).catch(translate);
}

export async function removeMember(user: StaffUser, conversationId: unknown, memberId: unknown): Promise<void> {
  const actor = await loadStaffActor(user);
  if (typeof memberId !== "string" || !isUserId(memberId)) throw new AppError("invalid_input", "Choose a person to remove.");
  if (memberId.toLowerCase() === actor.userId.toLowerCase()) throw new AppError("invalid_input", "To leave a conversation, use Leave.");
  await limitManage(actor.userId);
  await withSystem(async (db) => {
    const c = await loadConversation(db, actor, conversationId, { lock: true });
    if (!canManageMembers(factsOf(c), standingOf(actor, c))) throw new AppError(c.memberRole ? "forbidden" : "not_found", c.memberRole ? "You can't change who is in this conversation." : "That conversation was not found.");
    const { rows } = await db.query<{ user_id: string }>("update staff_conversation_members set left_at = now() where conversation_id = $1 and user_id = $2 and left_at is null returning user_id", [c.id, memberId.toLowerCase()]);
    if (!rows.length) throw new AppError("not_found", "That person is not in this conversation.");
    await ensureOwner(db, c.id);
    await addEvent(db, actor.agencyOrgId, c.id, "member_removed", actor.userId, memberId.toLowerCase());
    await recordAudit({ orgId: actor.agencyOrgId, actorUserId: actor.userId, actorKind: "agency", action: "staff_messages.member_removed", targetType: "staff_conversation", targetId: c.id, result: "success", metadata: { subjects: [memberId.toLowerCase()] } }, db);
    await bumpConversation(db, actor.agencyOrgId, c.id, [memberId.toLowerCase()]);
  }).catch(translate);
}

export const RENAME_CONFLICT_MESSAGE = "Someone else changed this conversation's name or topic while you were editing. Nothing was saved. Look at the new values and try again.";

/**
 * Renames a conversation or changes its topic. `expectedName` and `expectedTopic` are the values the form started from: when one is given and the stored value is different
 * now, nothing is saved and the person is told, so two people editing at once cannot silently overwrite each other.
 */
export async function updateConversation(user: StaffUser, conversationId: unknown, input: { name?: unknown; topic?: unknown; expectedName?: string | null; expectedTopic?: string | null }): Promise<void> {
  const actor = await loadStaffActor(user);
  await limitManage(actor.userId);
  await withSystem(async (db) => {
    const c = await loadConversation(db, actor, conversationId, { lock: true });
    if (!canRename(factsOf(c), standingOf(actor, c))) throw new AppError(c.memberRole ? "forbidden" : "not_found", c.memberRole ? "You can't rename this conversation." : "That conversation was not found.");
    if ((input.name !== undefined && input.expectedName !== undefined && (c.name ?? null) !== input.expectedName) || (input.topic !== undefined && input.expectedTopic !== undefined && (c.topic ?? null) !== input.expectedTopic)) {
      throw new AppError("conflict", RENAME_CONFLICT_MESSAGE);
    }
    if (input.name !== undefined) {
      const name = normaliseName(c.kind === "channel" ? "channel" : "group", input.name);
      if (!name.ok) throw new AppError("invalid_input", name.message);
      if (name.value !== c.name) {
        await db.query("update staff_conversations set name = $2 where id = $1", [c.id, name.value]);
        await addEvent(db, actor.agencyOrgId, c.id, "renamed", actor.userId);
      }
    }
    if (input.topic !== undefined) {
      const topic = normaliseTopic(input.topic);
      if (!topic.ok) throw new AppError("invalid_input", topic.message);
      if ((topic.value || null) !== c.topic) {
        await db.query("update staff_conversations set topic = $2 where id = $1", [c.id, topic.value || null]);
        await addEvent(db, actor.agencyOrgId, c.id, "topic_changed", actor.userId);
      }
    }
    await recordAudit({ orgId: actor.agencyOrgId, actorUserId: actor.userId, actorKind: "agency", action: "staff_messages.conversation_changed", targetType: "staff_conversation", targetId: c.id, result: "success" }, db);
    await bumpConversation(db, actor.agencyOrgId, c.id);
  }).catch(translate);
}

/** Archive a conversation or bring it back. Archiving needs no read access: the holder of the channels or moderation permission can archive a channel by its id. */
export async function setArchived(user: StaffUser, conversationId: unknown, archived: boolean): Promise<void> {
  const actor = await loadStaffActor(user);
  await limitManage(actor.userId);
  await withSystem(async (db) => {
    // A private channel the person is not in reads as not found to everyone but the holders of the permissions that may archive it.
    const found = isId(conversationId)
      ? (await db.query<{ kind: ConversationKind; visibility: ChannelVisibility; archived: boolean; member_role: MemberRole | null }>(
          `select c.kind, c.visibility, c.archived_at is not null as archived, m.role as member_role from staff_conversations c
             left join staff_conversation_members m on m.conversation_id = c.id and m.user_id = $2 and m.left_at is null where c.id = $1 for update of c`,
          [conversationId, actor.userId],
        )).rows[0]
      : undefined;
    if (!found) throw new AppError("not_found", "That conversation was not found.");
    if (!canArchive({ kind: found.kind, visibility: found.visibility, archived: found.archived }, { caps: actor.caps, memberRole: found.member_role })) {
      throw new AppError(found.member_role ? "forbidden" : "not_found", found.member_role ? "You can't archive this conversation." : "That conversation was not found.");
    }
    if (found.archived === archived) return;
    await db.query("update staff_conversations set archived_at = $2::timestamptz, archived_by = $3 where id = $1", [conversationId, archived ? new Date().toISOString() : null, archived ? actor.userId : null]);
    await addEvent(db, actor.agencyOrgId, conversationId as string, archived ? "archived" : "unarchived", actor.userId);
    await recordAudit({ orgId: actor.agencyOrgId, actorUserId: actor.userId, actorKind: "agency", action: archived ? "staff_messages.conversation_archived" : "staff_messages.conversation_restored", targetType: "staff_conversation", targetId: conversationId as string, result: "success" }, db);
    await bumpConversation(db, actor.agencyOrgId, conversationId as string);
  }).catch(translate);
}

/** Mute or unmute, and choose what to be told about. For the person's own place in the conversation only. */
export async function setPreferences(user: StaffUser, conversationId: unknown, input: { muted?: unknown; notify?: unknown }): Promise<void> {
  const actor = await loadStaffActor(user);
  if (input.muted !== undefined && typeof input.muted !== "boolean") throw new AppError("invalid_input", "Choose whether to mute.");
  if (input.notify !== undefined && input.notify !== "all" && input.notify !== "mentions" && input.notify !== "none") throw new AppError("invalid_input", "Choose what to be told about.");
  await withSystem(async (db) => {
    const c = await loadReadableConversation(db, actor, conversationId);
    await db.query(
      "update staff_conversation_members set muted = coalesce($3::boolean, muted), notify = coalesce($4::text, notify) where conversation_id = $1 and user_id = $2 and left_at is null",
      [c.id, actor.userId, input.muted ?? null, input.notify ?? null],
    );
    await bumpInbox(db, actor.agencyOrgId, [actor.userId]);
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface RailItem {
  id: string;
  kind: ConversationKind;
  visibility: ChannelVisibility;
  /** The conversation's name; for a direct message, the other person's. */
  name: string;
  topic: string | null;
  archived: boolean;
  lastSeq: number;
  lastReadSeq: number;
  unread: number;
  muted: boolean;
  notify: "all" | "mentions" | "none";
  lastMessageAt: string | null;
  memberCount: number;
  peer: (PersonName & { id: string }) | null;
}

interface RailRow {
  id: string;
  kind: ConversationKind;
  visibility: ChannelVisibility;
  archived: boolean;
  name: string | null;
  topic: string | null;
  direct_key: string | null;
  last_seq: string;
  last_read_seq: string;
  muted: boolean;
  notify: "all" | "mentions" | "none";
  last_message_at: Date | string | null;
  created_at: Date | string;
  member_count: number;
}

/** The person's conversations, newest activity first, with what is unread in each. Read under their own row-level security. */
export async function listConversations(user: StaffUser): Promise<RailItem[]> {
  const actor = await loadStaffActor(user);
  const rows = await withUser(actor.userId, async (db) =>
    (await db.query<RailRow>(
      `select c.id, c.kind, c.visibility, c.archived_at is not null as archived, c.name, c.topic, c.direct_key, c.last_seq::text as last_seq, m.last_read_seq::text as last_read_seq,
              m.muted, m.notify, c.last_message_at, c.created_at,
              (select count(*)::int from staff_conversation_members x where x.conversation_id = c.id and x.left_at is null) as member_count
         from staff_conversations c
         join staff_conversation_members m on m.conversation_id = c.id and m.user_id = $1 and m.left_at is null
        order by coalesce(c.last_message_at, c.created_at) desc, c.id`,
      [actor.userId],
    )).rows,
  );
  const peers = rows.map((r) => (r.kind === "direct" && r.direct_key ? peerOf(r.direct_key, actor.userId) : null));
  const names = await withSystem((db) => namesFor(db, peers));
  return rows.map((r, i) => {
    const peerId = peers[i];
    const peer = peerId ? { id: peerId, ...nameOrFormer(names, peerId) } : null;
    return {
      id: r.id,
      kind: r.kind,
      visibility: r.visibility,
      name: peer ? peer.name : (r.name ?? ""),
      topic: r.topic,
      archived: r.archived,
      lastSeq: Number(r.last_seq),
      lastReadSeq: Number(r.last_read_seq),
      unread: unreadCount(Number(r.last_seq), Number(r.last_read_seq)),
      muted: r.muted,
      notify: r.notify,
      lastMessageAt: r.last_message_at ? new Date(r.last_message_at).toISOString() : null,
      memberCount: r.member_count,
      peer,
    };
  });
}

export interface DirectoryChannel {
  id: string;
  name: string;
  topic: string | null;
  memberCount: number;
  joined: boolean;
  lastMessageAt: string | null;
}

/** The channels open to the whole team, joined or not. Names, topics and head counts only: the messages stay with the members. */
export async function channelDirectory(user: StaffUser): Promise<DirectoryChannel[]> {
  const actor = await loadStaffActor(user);
  return withSystem(async (db) =>
    (await db.query<{ id: string; name: string; topic: string | null; member_count: number; joined: boolean; last_message_at: Date | string | null }>(
      `select c.id, c.name, c.topic, c.last_message_at,
              (select count(*)::int from staff_conversation_members x where x.conversation_id = c.id and x.left_at is null) as member_count,
              exists (select 1 from staff_conversation_members m where m.conversation_id = c.id and m.user_id = $1 and m.left_at is null) as joined
         from staff_conversations c where c.kind = 'channel' and c.visibility = 'staff' and c.archived_at is null order by lower(c.name)`,
      [actor.userId],
    )).rows.map((r) => ({ id: r.id, name: r.name, topic: r.topic, memberCount: r.member_count, joined: r.joined, lastMessageAt: r.last_message_at ? new Date(r.last_message_at).toISOString() : null })),
  );
}

export interface MemberView extends PersonName {
  userId: string;
  role: MemberRole;
  joinedAt: string;
}

export interface ConversationView {
  conversation: Omit<RailItem, "unread" | "memberCount" | "peer"> & { memberRole: MemberRole | null; createdBy: string | null };
  /** The members, only for someone who is in the conversation (an open channel previewed from the directory shows a head count instead). */
  members: MemberView[] | null;
  memberCount: number;
  peer: RailItem["peer"];
  can: { post: boolean; join: boolean; leave: boolean; manageMembers: boolean; rename: boolean; archive: boolean };
  events: Array<{ kind: EventKind; at: string; actor: string | null; subject: string | null }>;
}

export async function getConversation(user: StaffUser, conversationId: unknown): Promise<ConversationView> {
  const actor = await loadStaffActor(user);
  return withSystem(async (db) => {
    const c = await loadConversation(db, actor, conversationId);
    const facts = factsOf(c);
    const standing = standingOf(actor, c);
    const count = Number((await db.query<{ n: string }>("select count(*)::text as n from staff_conversation_members where conversation_id = $1 and left_at is null", [c.id])).rows[0].n);
    let members: MemberView[] | null = null;
    let events: ConversationView["events"] = [];
    let peer: RailItem["peer"] = null;
    if (c.memberRole) {
      const m = await db.query<{ user_id: string; role: MemberRole; joined_at: Date | string }>(
        "select user_id, role, joined_at from staff_conversation_members where conversation_id = $1 and left_at is null order by (role = 'owner') desc, joined_at, user_id",
        [c.id],
      );
      const ev = await db.query<{ kind: EventKind; at: Date | string; actor_id: string | null; subject_id: string | null }>(
        "select kind, at, actor_id, subject_id from staff_conversation_events where conversation_id = $1 order by id desc limit 30",
        [c.id],
      );
      const peerId = c.kind === "direct" && c.directKey ? peerOf(c.directKey, actor.userId) : null;
      const names = await namesFor(db, [...m.rows.map((r) => r.user_id), ...ev.rows.flatMap((r) => [r.actor_id, r.subject_id]), peerId]);
      members = m.rows.map((r) => ({ userId: r.user_id, role: r.role, joinedAt: new Date(r.joined_at).toISOString(), ...nameOrFormer(names, r.user_id) }));
      events = ev.rows.map((r) => ({ kind: r.kind, at: new Date(r.at).toISOString(), actor: r.actor_id, subject: r.subject_id })).reverse();
      peer = peerId ? { id: peerId, ...nameOrFormer(names, peerId) } : null;
    }
    return {
      conversation: {
        id: c.id, kind: c.kind, visibility: c.visibility, name: peer ? peer.name : (c.name ?? ""), topic: c.topic, archived: c.archived, lastSeq: c.lastSeq, lastReadSeq: c.lastReadSeq,
        muted: c.muted, notify: c.notify, lastMessageAt: c.lastMessageAt, memberRole: c.memberRole, createdBy: c.createdBy,
      },
      members,
      memberCount: count,
      peer,
      can: {
        post: canPost(facts, standing),
        join: canJoin(facts, standing),
        leave: canLeave(facts, standing),
        manageMembers: canManageMembers(facts, standing),
        rename: canRename(facts, standing),
        archive: canArchive(facts, standing),
      },
      events,
    };
  });
}
