import "server-only";
import { readSystem } from "@/server/db";
import { neutralizeUntrusted } from "@/server/aqi/ops/redact";
import { recentOpsActions } from "@/server/aqi/ops/actions";
import { opsScopeKey, type OpsScope } from "@/lib/aqi/ops/types";

/**
 * Operational memory for the Super Admin copilot: earlier investigations in the SAME scope, recent
 * actions the administrator proposed or approved, and proposals still waiting. It is scoped by the
 * verified investigation scope (a tenant's history is never offered in another tenant's context),
 * expires after 30 days, and is always presented to the model as context, never as evidence of the
 * current state. Deleting a conversation removes its text; action records stay as the audit trail.
 */
export const OPS_MEMORY_DAYS = 30;

export async function loadOpsMemory(userId: string, scope: OpsScope, currentConversationId: string | null): Promise<string[]> {
  const key = opsScopeKey(scope);
  const [investigations, actions] = await Promise.all([
    readSystem((db) => db.query<{ title: string; last_message_at: Date }>(
      `select c.title, c.last_message_at from aqi_conversations c
        where c.user_id = $1 and c.surface = 'operations' and ($3::uuid is null or c.id <> $3)
          and c.last_message_at > now() - make_interval(days => $4)
          and exists (select 1 from aqi_messages m where m.conversation_id = c.id and m.context->>'scopeKey' = $2)
        order by c.last_message_at desc limit 4`,
      [userId, key, currentConversationId, OPS_MEMORY_DAYS],
    )),
    recentOpsActions(userId, scope.orgId, 5),
  ]);
  const lines: string[] = [];
  for (const row of investigations.rows) lines.push(`Earlier investigation in this scope: "${neutralizeUntrusted(row.title, 80).text}" (${new Date(row.last_message_at).toISOString().slice(0, 10)})`);
  for (const a of actions) lines.push(`Action ${a.tool} on ${a.target || "the platform"}: ${a.status} (${a.at.slice(0, 10)})`);
  return lines;
}
