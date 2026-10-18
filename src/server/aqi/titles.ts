import "server-only";
import { withUser } from "@/server/db";
import { llmComplete, resolveLlmConfig } from "@/server/llm/client";
import {
  buildAqiTitlePrompt,
  fallbackAqiConversationTitle,
  firstMeaningfulUserMessage,
  isMeaningfulAqiMessage,
  sanitizeGeneratedTitle,
  type AqiTitleMessage,
} from "@/lib/aqi/title";
import type { AqiViewer } from "@/server/aqi/access";

export interface AqiTitleResult {
  title: string;
  generated: boolean;
}

/** Title generation is coalesced per conversation inside this process; the database guard is authoritative. */
const inFlight = new Map<string, Promise<AqiTitleResult | null>>();

interface ConversationTitleRow {
  id: string;
  title: string;
  title_source: "default" | "auto" | "manual";
}

async function loadConversation(viewer: AqiViewer, conversationId: string): Promise<ConversationTitleRow | null> {
  return withUser(viewer.user.id, async (db) => {
    const { rows } = await db.query<ConversationTitleRow>(
      `select id, title, title_source from aqi_conversations
       where id = $1 and user_id = $2 and (($3::uuid is null and org_id is null) or org_id = $3::uuid)`,
      [conversationId, viewer.user.id, viewer.org?.orgId ?? null],
    );
    return rows[0] ?? null;
  });
}

async function conversationMessages(viewer: AqiViewer, conversationId: string): Promise<AqiTitleMessage[]> {
  return withUser(viewer.user.id, async (db) => {
    const { rows } = await db.query<AqiTitleMessage>(
      `select role, content from aqi_messages
       where conversation_id = $1 and user_id = $2 and status = 'complete' and content <> ''
       order by created_at asc limit 8`,
      [conversationId, viewer.user.id],
    );
    return rows.map((row) => ({ role: row.role, content: row.content }));
  });
}

async function modelTitle(messages: AqiTitleMessage[]): Promise<string | null> {
  try {
    const llm = await resolveLlmConfig();
    if (!llm) return null;
    const prompt = buildAqiTitlePrompt(messages);
    const reply = await llmComplete(llm, {
      system: prompt.system,
      user: prompt.user,
      // A title is a handful of tokens. A tight budget keeps automatic naming inexpensive and fast,
      // and the deterministic fallback still produces a usable title when the provider is down.
      maxTokens: 40,
      temperature: 0.2,
      timeoutMs: 8000,
    });
    return reply.ok ? sanitizeGeneratedTitle(reply.text) : null;
  } catch {
    return null;
  }
}

/**
 * Generate and persist a title for one conversation.
 *
 * Safety properties:
 * - only the owner's conversation is read or updated (plus RLS);
 * - a manual rename always wins (`title_source = 'default'` is required for the update);
 * - a deleted conversation can never be recreated (the operation is a conditional UPDATE, never an
 *   insert);
 * - greeting-only conversations keep the neutral placeholder;
 * - failure keeps a usable deterministic title rather than blocking the chat.
 */
export async function generateAqiConversationTitle(viewer: AqiViewer, conversationId: string): Promise<AqiTitleResult | null> {
  const key = `${viewer.user.id}:${conversationId}`;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const task = generate(viewer, conversationId).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, task);
  return task;
}

async function generate(viewer: AqiViewer, conversationId: string): Promise<AqiTitleResult | null> {
  const conversation = await loadConversation(viewer, conversationId);
  if (!conversation) return null;
  if (conversation.title_source !== "default") return { title: conversation.title, generated: false };

  const messages = await conversationMessages(viewer, conversationId);
  if (!firstMeaningfulUserMessage(messages)) return { title: conversation.title, generated: false };

  // The model gets the first few turns only; the fallback never needs a provider.
  const generated = (await modelTitle(messages)) ?? fallbackAqiConversationTitle(messages);
  if (!generated) return { title: conversation.title, generated: false };

  return withUser(viewer.user.id, async (db) => {
    const updated = await db.query<{ title: string }>(
      `update aqi_conversations
       set title = $2, title_source = 'auto', title_generated_at = now(), updated_at = now()
       where id = $1 and user_id = $3
         and (($4::uuid is null and org_id is null) or org_id = $4::uuid)
         and title_source = 'default'
       returning title`,
      [conversationId, generated, viewer.user.id, viewer.org?.orgId ?? null],
    );
    if (updated.rows[0]) return { title: updated.rows[0].title, generated: true };

    // A manual rename or a delete won the race. Re-read only to report the winner; never overwrite.
    const current = await db.query<{ title: string }>(
      `select title from aqi_conversations
       where id = $1 and user_id = $2 and (($3::uuid is null and org_id is null) or org_id = $3::uuid)`,
      [conversationId, viewer.user.id, viewer.org?.orgId ?? null],
    );
    return current.rows[0] ? { title: current.rows[0].title, generated: false } : null;
  });
}

/**
 * Repair a default title after a refresh interrupted generation. Only used when the conversation
 * already contains a meaningful topic; AQi never generates a title from a greeting.
 */
export function shouldOfferAqiTitle(message: string): boolean {
  return isMeaningfulAqiMessage(message);
}
