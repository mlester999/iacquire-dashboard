import "server-only";
import type { Queryable } from "@/server/db";
import { cancelPendingAiMessages } from "@/server/messaging/send";
import { aiResumeProblems, recordOwnership } from "@/server/messaging/handoff";
import { recordConversationEvent } from "@/server/messaging/events";
import type { CaseRow } from "@/server/missed-calls/cases";
import { boundPartnerRuntime } from "@/server/workforce/partner-runtime";

// Hand a missed caller's conversation to the workspace's canonical AI Growth Partner when the policy asks for it. The runtime must be linked
// from the tenant's Growth Partner identity, enabled and connected; messaging must not be paused, the channel must work and no escalation may be
// open. A conversation a person owns is left alone. Booking still follows the workspace's existing approval rules.

export type RoutingResult = { status: "done" | "skipped" | "blocked"; reason: string; agentId?: string };

export async function routeToGrowthPartner(db: Queryable, c: CaseRow): Promise<RoutingResult> {
  if (!c.conversation_id) return { status: "skipped", reason: "no_conversation" };
  const conv = (await db.query<{ contact_id: string; channel: string; owner_kind: "ai" | "human" | "unassigned"; owner_user_id: string | null; ai_agent_id: string | null }>(
    "select contact_id, channel, owner_kind, owner_user_id, ai_agent_id from conversations where id = $1 and org_id = $2 for update",
    [c.conversation_id, c.org_id],
  )).rows[0];
  if (!conv) return { status: "skipped", reason: "no_conversation" };
  if (conv.owner_kind === "human") return { status: "skipped", reason: "human_owner" };
  const agent = await boundPartnerRuntime(db, c.org_id);
  if (!agent || !agent.enabled) return { status: "blocked", reason: "no_growth_partner" };
  const problems = await aiResumeProblems(db, c.org_id, { ai_agent_id: agent.agentId, channel: conv.channel }, c.conversation_id);
  if (problems.length) return { status: "blocked", reason: "employee_not_ready" };
  if (conv.ai_agent_id === agent.agentId && conv.owner_kind === "ai") return { status: "done", reason: "already_assigned", agentId: agent.agentId };
  await db.query("update conversations set ai_agent_id = $3, owner_kind = 'ai', ai_paused_at = null, ownership_version = ownership_version + 1 where id = $1 and org_id = $2", [c.conversation_id, c.org_id, agent.agentId]);
  // Replies the previous employee had queued were prepared under the old assignment; they are stopped. Drafts stay for a person to judge.
  await cancelPendingAiMessages(db, c.org_id, c.conversation_id, "reassigned", { queuedOnly: true });
  if (conv.owner_kind !== "ai") {
    await recordOwnership(db, {
      orgId: c.org_id, conversationId: c.conversation_id, from: { kind: conv.owner_kind, userId: conv.owner_user_id }, to: { kind: "ai", userId: null },
      actorKind: "system", actorUserId: null, reason: "Missed-call follow-up routed to the AI Growth Partner",
    });
  }
  await recordConversationEvent(db, { orgId: c.org_id, conversationId: c.conversation_id, kind: "ai_assigned", actor: { kind: "system" }, detail: { agentId: agent.agentId, roleKey: "growth_partner", by: "missed_call" } });
  return { status: "done", reason: "assigned", agentId: agent.agentId };
}
