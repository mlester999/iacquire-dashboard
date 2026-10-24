import "server-only";
import { withSystem, withUser } from "@/server/db";
import { AppError } from "@/server/errors";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { isId, loadStaffActor, namesFor, nameOrFormer, type PersonName, type StaffUser } from "@/server/staff-messages/access";
import { plainMentions } from "@/lib/staff-messages/mentions";
import { likePattern, normaliseQuery, snippetOf, type Snippet } from "@/lib/staff-messages/search";
import { SEARCH_MAX_RESULTS } from "@/lib/staff-messages/limits";
import { peerOf } from "@/lib/staff-messages/direct";
import { seqOf } from "@/lib/staff-messages/unread";
import type { ConversationKind } from "@/lib/staff-messages/conversations";

export interface SearchHit {
  messageId: string;
  conversationId: string;
  conversationKind: ConversationKind;
  /** The conversation's name; for a direct message, the other person's. */
  conversationName: string;
  seq: number;
  threadRootId: string | null;
  author: PersonName;
  createdAt: string;
  snippet: Snippet;
}

export interface SearchResult {
  hits: SearchHit[];
  /** True when there were more matches than are listed. */
  truncated: boolean;
}

interface Raw {
  id: string;
  conversation_id: string;
  kind: ConversationKind;
  conv_name: string | null;
  direct_key: string | null;
  seq: string;
  thread_root_id: string | null;
  author_id: string | null;
  body: string;
  mentions: string[];
  created_at: Date | string;
}

/**
 * Searches the messages of the conversations the person is in, newest first. The query is looked for as text, never as a pattern. Row-level security limits the rows to the
 * person's own conversations (the person's current standing, so a person who lost access finds nothing), and the statement repeats the limit itself.
 */
export async function searchMessages(user: StaffUser, input: { query: unknown; conversationId?: unknown }): Promise<SearchResult> {
  const actor = await loadStaffActor(user);
  const q = normaliseQuery(input.query);
  if (!q.ok) throw new AppError("invalid_input", q.message);
  if (input.conversationId !== undefined && input.conversationId !== null && !isId(input.conversationId)) throw new AppError("not_found", "That conversation was not found.");
  const limit = await consumeRateLimit(RATE_LIMITS.staffMessageSearchByUser, actor.userId);
  if (!limit.allowed) throw new AppError("rate_limited", "You are searching very quickly. Wait a moment and try again.", { retryAfterSeconds: limit.retryAfterSeconds });
  const rows = await withUser(actor.userId, async (db) =>
    (await db.query<Raw>(
      `select m.id, m.conversation_id, c.kind, c.name as conv_name, c.direct_key, m.seq::text as seq, m.thread_root_id, m.author_id, m.body, m.mentions, m.created_at
         from staff_messages m join staff_conversations c on c.id = m.conversation_id
        where m.deleted_at is null
          and m.conversation_id = any((select app.staff_conversation_ids())::uuid[])
          and ($2::uuid is null or m.conversation_id = $2::uuid)
          and m.body ilike $1
        order by m.created_at desc, m.id desc limit $3`,
      // Rows are read in excess because a short query can match inside a mention's id (the text holds <@id>), which is not what the person typed: those are dropped below.
      [likePattern(q.query), input.conversationId ?? null, SEARCH_MAX_RESULTS * 3],
    )).rows,
  );
  const names = await withSystem((db) => namesFor(db, [...rows.map((r) => r.author_id), ...rows.flatMap((r) => r.mentions), ...rows.map((r) => (r.direct_key ? peerOf(r.direct_key, actor.userId) : null))]));
  const needle = q.query.toLowerCase();
  const real = rows
    .map((r) => ({ r, text: plainMentions(r.body, (id) => names.get(id)?.name ?? null) }))
    .filter(({ text }) => text.toLowerCase().includes(needle));
  const truncated = real.length > SEARCH_MAX_RESULTS || rows.length === SEARCH_MAX_RESULTS * 3;
  return {
    truncated,
    hits: real.slice(0, SEARCH_MAX_RESULTS).map(({ r, text }) => {
      const peerId = r.direct_key ? peerOf(r.direct_key, actor.userId) : null;
      return {
        messageId: r.id,
        conversationId: r.conversation_id,
        conversationKind: r.kind,
        conversationName: peerId ? nameOrFormer(names, peerId).name : (r.conv_name ?? ""),
        seq: seqOf(r.seq),
        threadRootId: r.thread_root_id,
        author: nameOrFormer(names, r.author_id),
        createdAt: new Date(r.created_at).toISOString(),
        snippet: snippetOf(text, q.query),
      };
    }),
  };
}
