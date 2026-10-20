import "server-only";
import { withSystem, withUser } from "@/server/db";
import { hasDbErrorCode } from "@/server/diagnostics";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { loadActionCards } from "@/server/aqi/ops/actions";
import type { OpsMessageContext, OpsScope } from "@/lib/aqi/ops/types";

/**
 * Investigation history for the Super Admin copilot. These are ordinary `aqi_conversations` rows with
 * `surface = 'operations'` and no organization, owned by the administrator and protected by the same
 * row-level security as every AQi chat; the Client assistant never lists or opens them. Deleting a
 * conversation deletes its messages and cards. Action records are kept as the audit trail.
 */

export interface OpsConversationSummary { id: string; title: string; lastMessageAt: string; createdAt: string }

export interface OpsConversationMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: string;
  feedbackRating: number | null;
  feedbackComment: string | null;
  createdAt: string;
  suggestedQuestions?: string[];
  scope?: OpsScope;
  ops?: OpsMessageContext;
}

const iso = (value: Date | string) => (value instanceof Date ? value : new Date(value)).toISOString();

function assertSuperAdmin(user: { platformRole: string }) {
  if (user.platformRole !== "agency_super_admin") throw new AppError("forbidden", "AQi Operations is available to Super Admins only.");
}

export async function listOpsConversations(
  user: { id: string; platformRole: string },
  options: { query?: string | null; before?: string | null; limit?: number } = {},
): Promise<{ conversations: OpsConversationSummary[]; hasMore: boolean }> {
  assertSuperAdmin(user);
  const limit = Math.min(30, Math.max(1, options.limit ?? 15));
  const query = options.query?.trim().slice(0, 120) ?? "";
  return withUser(user.id, async (db) => {
    const { rows } = await db.query<{ id: string; title: string; last_message_at: Date; created_at: Date }>(
      `select id, title, last_message_at, created_at from aqi_conversations
        where user_id = $1 and surface = 'operations' and org_id is null
          and ($2::text = '' or position(lower($2::text) in lower(title)) > 0)
          and ($3::timestamptz is null or last_message_at < $3::timestamptz)
        order by last_message_at desc limit $4`,
      [user.id, query, options.before ?? null, limit + 1],
    );
    return {
      conversations: rows.slice(0, limit).map((r) => ({ id: r.id, title: r.title, lastMessageAt: iso(r.last_message_at), createdAt: iso(r.created_at) })),
      hasMore: rows.length > limit,
    };
  });
}

export async function getOpsConversation(
  user: { id: string; platformRole: string },
  conversationId: string,
  before?: string | null,
): Promise<{ conversation: OpsConversationSummary; messages: OpsConversationMessage[]; hasMore: boolean }> {
  assertSuperAdmin(user);
  return withUser(user.id, async (db) => {
    const { rows } = await db.query<{ id: string; title: string; last_message_at: Date; created_at: Date }>(
      "select id, title, last_message_at, created_at from aqi_conversations where id = $1 and user_id = $2 and surface = 'operations' and org_id is null",
      [conversationId, user.id],
    );
    const conversation = rows[0];
    if (!conversation) throw new AppError("not_found", "Conversation not found.");
    const { rows: messages } = await db.query<{
      id: string; role: "user" | "assistant"; content: string; status: string; feedback_rating: number | null; feedback_comment: string | null; created_at: Date;
      context: { scope?: OpsScope; ops?: OpsMessageContext; suggestedQuestions?: string[] } | null;
    }>(
      `select id, role, content, status, feedback_rating, feedback_comment, context, created_at from aqi_messages
        where conversation_id = $1 and ($2::timestamptz is null or created_at < $2::timestamptz) order by created_at desc limit 21`,
      [conversationId, before ?? null],
    );
    const page = messages.slice(0, 20).reverse();
    return {
      conversation: { id: conversation.id, title: conversation.title, lastMessageAt: iso(conversation.last_message_at), createdAt: iso(conversation.created_at) },
      messages: page.map((m) => ({
        id: m.id, role: m.role, content: m.content, status: m.status, feedbackRating: m.feedback_rating, feedbackComment: m.feedback_comment, createdAt: iso(m.created_at),
        suggestedQuestions: Array.isArray(m.context?.suggestedQuestions) ? m.context!.suggestedQuestions : undefined, scope: m.context?.scope, ops: m.context?.ops,
      })),
      hasMore: messages.length > 20,
    };
  }).then(async (result) => {
    // Stored cards are a snapshot. Proposals are re-read so a reloaded chat shows what really happened to them.
    const ids = result.messages.flatMap((m) => m.ops?.actionIds ?? []);
    const actions = await loadActionCards(user.id, ids);
    if (actions.size) {
      for (const m of result.messages) {
        if (!m.ops?.actionIds.length) continue;
        const kept = m.ops.cards.filter((c) => !("actionId" in c && actions.has(c.actionId)));
        m.ops = { ...m.ops, cards: [...kept, ...m.ops.actionIds.flatMap((id) => actions.get(id) ?? [])] };
      }
    }
    return result;
  });
}

export async function renameOpsConversation(user: { id: string; platformRole: string }, conversationId: string, title: string): Promise<string> {
  assertSuperAdmin(user);
  const clean = title.trim().slice(0, 120);
  if (!clean) throw new AppError("invalid_input", "Give the conversation a name.");
  return withUser(user.id, async (db) => {
    const result = await db.query<{ title: string }>(
      "update aqi_conversations set title = $2, title_source = 'manual', updated_at = now() where id = $1 and user_id = $3 and surface = 'operations' and org_id is null returning title",
      [conversationId, clean, user.id],
    );
    if (!result.rows[0]) throw new AppError("not_found", "Conversation not found.");
    return result.rows[0].title;
  });
}

/** How long an investigation is kept after its last message. Confirmed actions outlive it in aqi_ops_actions and audit_logs. */
export const OPS_CONVERSATION_RETENTION_DAYS = 180;

/**
 * Retention for investigation history. Bounded (100 per run) and idempotent, so the scheduler can call it on every tick. The Client
 * assistant's conversations are not touched: only `surface = 'operations'` rows. Action records keep their audit value because
 * their conversation link is set null by the foreign key, not deleted.
 */
export async function purgeExpiredOpsConversations(): Promise<number> {
  try {
    const result = await withSystem((db) => db.query(
      `delete from aqi_conversations where id in (
         select id from aqi_conversations where surface = 'operations' and last_message_at < now() - make_interval(days => $1) order by last_message_at limit 100)`,
      [OPS_CONVERSATION_RETENTION_DAYS],
    ));
    return result.rowCount;
  } catch (err) {
    // The code can be deployed before migration 0068: there is no `surface` column yet, so there is nothing to purge.
    if (hasDbErrorCode(err, "42703")) return 0;
    throw err;
  }
}

export async function deleteOpsConversation(user: { id: string; platformRole: string }, conversationId: string): Promise<void> {
  assertSuperAdmin(user);
  await withUser(user.id, async (db) => {
    const result = await db.query("delete from aqi_conversations where id = $1 and user_id = $2 and surface = 'operations' and org_id is null", [conversationId, user.id]);
    if (!result.rowCount) throw new AppError("not_found", "Conversation not found.");
  });
  await recordAudit({ actorUserId: user.id, actorKind: "agency", action: "aqi.ops_conversation_deleted", targetType: "aqi_conversation", targetId: conversationId, result: "success" });
}
