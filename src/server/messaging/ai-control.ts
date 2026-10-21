import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyUser } from "@/server/notifications";
import { assertConversationVisible } from "@/server/messaging/access";
import { recordConversationEvent, type ConversationEventActor } from "@/server/messaging/events";
import { aiResumeProblems, recordOwnership, type OwnerKind } from "@/server/messaging/handoff";
import { cancelPendingAiMessages } from "@/server/messaging/send";
import { cancelFollowUps } from "@/server/messaging/followups";
import { canHandleConversations } from "@/lib/inbox";
import type { OrgContext } from "@/server/tenancy/context";

// Who may speak for a conversation: pausing the AI, choosing which AI employee handles it, and handing it from one person to another.
// Every function here re-reads the conversation under a row lock, bumps ownership_version (the fence that makes a reply prepared earlier
// stale, see SendRequest.fenceVersion) and leaves a lifecycle event and an audit entry.

interface ConvRow {
  owner_kind: OwnerKind;
  owner_user_id: string | null;
  ai_agent_id: string | null;
  ai_paused_at: Date | null;
  channel: string;
  contact_id: string;
  ownership_version: number;
}

async function lockConversation(db: Queryable, orgId: string, conversationId: string): Promise<ConvRow> {
  const { rows } = await db.query<ConvRow>(
    "select owner_kind, owner_user_id, ai_agent_id, ai_paused_at, channel, contact_id, ownership_version from conversations where id = $1 and org_id = $2 for update",
    [conversationId, orgId],
  );
  if (!rows[0]) throw new AppError("not_found", "Conversation not found.");
  return rows[0];
}

/**
 * Stops the AI replying on this conversation without handing it to a person. The AI employee stays attached, replies that were queued but not
 * yet sent are stopped, follow-ups are cancelled, and drafts waiting for approval stay (approving one is a person's own decision). Lifting the
 * pause is `resumeAi` in handoff.ts.
 */
export async function pauseAi(ctx: OrgContext, conversationId: string, reason?: string): Promise<{ changed: boolean }> {
  if (!ctx.can("inbox.reply")) throw new AppError("forbidden", "Your role can't pause the AI on a conversation.");
  await assertConversationVisible(ctx, conversationId);
  const why = (reason ?? "").trim().slice(0, 300);
  return withSystem(async (db) => {
    const r = await pauseAiInTx(db, { orgId: ctx.org.orgId, conversationId, actor: { kind: "user", userId: ctx.user.id }, userId: ctx.user.id, reason: why });
    if (r.changed) {
      await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "conversation.ai_paused", targetType: "conversation", targetId: conversationId, result: "success" }, db);
      return { changed: true };
    }
    if (r.why === "human_owner") throw new AppError("conflict", "A person is handling this conversation, so the AI is not replying.");
    if (r.why === "no_ai") throw new AppError("conflict", "No AI employee is handling this conversation, so there is nothing to pause.");
    return { changed: false };
  });
}

export type PauseResult = { changed: true } | { changed: false; why: "already_paused" | "human_owner" | "no_ai" };

/**
 * The pause itself, shared by a person pressing Pause AI and a workflow step (which passes `actor: { kind: "workflow" }` and no user). The
 * caller has already checked who may do it; this locks the conversation, refuses to pause what is not an AI-owned conversation, and returns
 * why instead of throwing so each caller can answer in its own words.
 */
export async function pauseAiInTx(
  db: Queryable,
  p: { orgId: string; conversationId: string; actor: ConversationEventActor; userId: string | null; reason: string; causedBy?: { eventId: number; depth: number } | null },
): Promise<PauseResult> {
  const conv = await lockConversation(db, p.orgId, p.conversationId);
  if (conv.owner_kind !== "ai") return { changed: false, why: conv.owner_kind === "human" ? "human_owner" : "no_ai" };
  if (conv.ai_paused_at) return { changed: false, why: "already_paused" };
  await db.query(
    "update conversations set ai_paused_at = now(), ai_paused_by = $3, ai_pause_reason = nullif($4, ''), ownership_version = ownership_version + 1 where id = $1 and org_id = $2",
    [p.conversationId, p.orgId, p.userId, p.reason],
  );
  await cancelPendingAiMessages(db, p.orgId, p.conversationId, "ai_paused", { queuedOnly: true });
  await cancelFollowUps(db, { orgId: p.orgId, contactId: conv.contact_id, reason: "ai_paused" });
  await recordConversationEvent(db, { orgId: p.orgId, conversationId: p.conversationId, kind: "ai_paused", actor: p.actor, detail: p.reason ? { reason: p.reason.slice(0, 120) } : {}, causedBy: p.causedBy ?? null });
  return { changed: true };
}

/**
 * Chooses which AI employee handles a conversation. Only roles that can talk to customers are accepted (CONVERSATION_AI_ROLES); the other
 * employees are refused here, not just hidden. On an unassigned conversation the employee also becomes its owner, after the same safety
 * checks as handing a conversation back; on a conversation a person owns it is only attached, and stays silent until it is handed back.
 */
export async function assignAiEmployee(ctx: OrgContext, conversationId: string, agentId: string): Promise<{ agentId: string; ownerKind: OwnerKind }> {
  if (!ctx.can("inbox.assign")) throw new AppError("forbidden", "Only owners and managers can choose the AI employee for a conversation.");
  await assertConversationVisible(ctx, conversationId);
  return withSystem(async (db) => {
    const { rows } = await db.query<{ id: string; role_key: string; enabled: boolean; display_name: string }>("select id, role_key, enabled, display_name from agent_instances where id = $1 and org_id = $2", [agentId, ctx.org.orgId]);
    const agent = rows[0];
    if (!agent) throw new AppError("not_found", "That AI employee isn't part of this workspace.");
    if (!canHandleConversations(agent.role_key)) throw new AppError("invalid_input", `${agent.display_name} works behind the scenes and can't talk to customers. Choose the Sales Assistant or the Appointment Setter.`);
    if (!agent.enabled) throw new AppError("conflict", `${agent.display_name} isn't included in this workspace.`);
    const conv = await lockConversation(db, ctx.org.orgId, conversationId);
    if (conv.ai_agent_id === agentId) return { agentId, ownerKind: conv.owner_kind };
    const becomesOwner = conv.owner_kind !== "human";
    if (becomesOwner) {
      const problems = await aiResumeProblems(db, ctx.org.orgId, { ai_agent_id: agentId, channel: conv.channel }, conversationId);
      if (problems.length) throw new AppError("conflict", `${agent.display_name} can't take this conversation yet. ${problems.join(" ")}`);
    }
    const next: OwnerKind = becomesOwner ? "ai" : conv.owner_kind;
    await db.query("update conversations set ai_agent_id = $3, owner_kind = $4, ownership_version = ownership_version + 1 where id = $1 and org_id = $2", [conversationId, ctx.org.orgId, agentId, next]);
    // Replies the previous employee had queued were prepared under the old assignment. They are stopped; drafts stay for a person to judge.
    await cancelPendingAiMessages(db, ctx.org.orgId, conversationId, "reassigned", { queuedOnly: true });
    if (conv.owner_kind !== next) {
      await recordOwnership(db, { orgId: ctx.org.orgId, conversationId, from: { kind: conv.owner_kind, userId: conv.owner_user_id }, to: { kind: next, userId: null }, actorKind: "user", actorUserId: ctx.user.id, reason: `Assigned to ${agent.display_name}` });
    }
    await recordConversationEvent(db, { orgId: ctx.org.orgId, conversationId, kind: "ai_assigned", actor: { kind: "user", userId: ctx.user.id }, detail: { agentId, roleKey: agent.role_key } });
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "conversation.ai_assigned", targetType: "conversation", targetId: conversationId, result: "success", metadata: { agentId, roleKey: agent.role_key } }, db);
    return { agentId, ownerKind: next };
  });
}

/**
 * Hands a conversation from one person to another (or from the AI to a person). The new person becomes the owner, the AI stops, and they
 * are told. The current owner may do it, and so may a manager (inbox.assign); during the owner's priority window on an escalation only the
 * owner may act, as for any takeover. The recipient must be an active teammate whose role can reply to customers.
 */
export async function transferConversation(ctx: OrgContext, conversationId: string, toUserId: string): Promise<{ ownerUserId: string }> {
  if (!ctx.can("inbox.reply")) throw new AppError("forbidden", "Your role can't hand conversations to a teammate.");
  await assertConversationVisible(ctx, conversationId);
  return withSystem(async (db) => {
    const target = await db.query<{ role: string; name: string }>(
      `select m.role, coalesce(nullif(u.full_name, ''), u.email::text) as name from organization_memberships m join users u on u.id = m.user_id
       where m.org_id = $1 and m.user_id = $2 and m.status = 'active'`,
      [ctx.org.orgId, toUserId],
    );
    if (!target.rows[0]) throw new AppError("not_found", "That person is not on your team.");
    const canReply = await db.query("select 1 from role_permissions where role = $1 and permission = 'inbox.reply'", [target.rows[0].role]);
    if (!canReply.rows[0]) throw new AppError("invalid_input", "That person's role can't reply to customers.");
    const conv = await lockConversation(db, ctx.org.orgId, conversationId);
    const mine = conv.owner_kind === "human" && conv.owner_user_id === ctx.user.id;
    if (conv.owner_kind === "human" && !mine && !ctx.can("inbox.assign")) throw new AppError("forbidden", "Only the person handling this, or a manager, can hand it to someone else.");
    const pending = await db.query<{ owner_user_id: string | null }>("select owner_user_id from human_escalations where conversation_id = $1 and status = 'awaiting_owner'", [conversationId]);
    if (pending.rows[0] && pending.rows[0].owner_user_id !== ctx.user.id) throw new AppError("conflict", "The business owner has first priority on this conversation right now.");
    if (conv.owner_kind === "human" && conv.owner_user_id === toUserId) return { ownerUserId: toUserId };

    const bumped = await db.query<{ ownership_version: number }>(
      `update conversations set owner_kind = 'human', owner_user_id = $3, assigned_user_id = $3, ownership_version = ownership_version + 1,
         ai_paused_at = null, ai_paused_by = null, ai_pause_reason = null where id = $1 and org_id = $2 returning ownership_version`,
      [conversationId, ctx.org.orgId, toUserId],
    );
    await cancelPendingAiMessages(db, ctx.org.orgId, conversationId, "human_owner");
    await cancelFollowUps(db, { orgId: ctx.org.orgId, contactId: conv.contact_id, reason: "human_took_over" });
    await recordOwnership(db, { orgId: ctx.org.orgId, conversationId, from: { kind: conv.owner_kind, userId: conv.owner_user_id }, to: { kind: "human", userId: toUserId }, actorKind: "user", actorUserId: ctx.user.id, reason: `Handed to ${target.rows[0].name}` });
    await recordConversationEvent(db, { orgId: ctx.org.orgId, conversationId, kind: "assigned", actor: { kind: "user", userId: ctx.user.id }, detail: { to: toUserId, transfer: true } });
    if (toUserId !== ctx.user.id) {
      await notifyUser(db, toUserId, ctx.org.orgId, {
        kind: "conversation_assigned",
        severity: "info",
        title: `${ctx.user.fullName || "A teammate"} handed you a conversation`,
        body: "Open it to continue. The AI will not reply while you own it.",
        link: `/inbox?conversation=${conversationId}`,
        dedupeKey: `conv_assigned:${conversationId}:${bumped.rows[0].ownership_version}`,
      });
    }
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "conversation.transferred", targetType: "conversation", targetId: conversationId, result: "success", metadata: { to: toUserId } }, db);
    return { ownerUserId: toUserId };
  });
}
