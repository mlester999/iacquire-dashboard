import "server-only";
import crypto from "node:crypto";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { automationGate } from "@/server/automation/gate";
import { createApproval } from "@/server/approvals/service";
import type { QueueResult, SendRequest } from "@/server/messaging/send";

// A reply to a website visitor. The visitor's open widget collects it, so nothing leaves through a provider: no sender to verify, no consent
// ledger, no credits for a text segment, no quiet hours. What does apply is everything about WHO may speak in the conversation: a person who owns
// it silences the AI, a pause or a takeover that happened after the reply was prepared makes it stale, an AI reply waits while someone is being
// asked to take over, and the workspace's automation switches (paused, agent not ready, approvals required) still win.
//
// The widget's own "assistant on" switch is the workspace's decision to let the AI answer visitors live, so an AI reply here does not also need
// the SMS-style "automatic replies" autopilot switch. It is still recorded and still visible in the Inbox.

type ConversationRow = {
  id: string;
  contact_id: string;
  owner_kind: "ai" | "human" | "unassigned";
  ownership_version: number;
  ai_paused_at: Date | null;
  contact_deleted: Date | null;
  ai_enabled: boolean | null;
};

type Denial = { reason: string; detail: string; permanent: boolean; needsApproval?: boolean };

export async function queueWebChatOutbound(db: Queryable, req: SendRequest & { agentId?: string | null; approvalId?: string | null }): Promise<QueueResult> {
  const { rows } = await db.query<ConversationRow>(
    `select c.id, c.contact_id, c.owner_kind, c.ownership_version, c.ai_paused_at, k.deleted_at as contact_deleted, w.ai_enabled
     from conversations c join contacts k on k.id = c.contact_id and k.org_id = c.org_id left join web_chat_widgets w on w.org_id = c.org_id
     where c.id = $1 and c.org_id = $2 and c.channel = 'web_chat'`,
    [req.conversationId, req.orgId],
  );
  const conv = rows[0];
  if (!conv) throw new AppError("not_found", "Conversation not found.");

  const denial = await denyReason(db, req, conv);
  const messageId = crypto.randomUUID();
  const author = req.actor.kind === "ai" ? { kind: "ai", userId: null, agentId: req.actor.agentId } : { kind: req.actor.kind, userId: req.actor.userId, agentId: null };
  const fence = req.actor.kind === "ai" ? (req.fenceVersion ?? conv.ownership_version) : null;
  const insert = (status: "sent" | "draft" | "blocked", extra: { reason?: string; detail?: string } = {}) =>
    db.query(
      `insert into conversation_messages (id, org_id, conversation_id, direction, author_kind, author_user_id, agent_id, body, status, status_detail, blocked_reason, scope,
         approval_id, provider, dedupe_key, purpose, ownership_fence, queued_at, sent_at, created_at)
       values ($1, $2, $3, 'outbound', $4, $5, $6, $7, $8, $9, $10, $11, $12, 'web_chat', $13, 'service', $14, null, case when $8 = 'sent' then now() end,
         greatest(clock_timestamp(), coalesce((select max(created_at) from conversation_messages where conversation_id = $3), clock_timestamp()) + interval '1 millisecond'))`,
      [messageId, req.orgId, req.conversationId, author.kind, author.userId, author.agentId, req.body, status, extra.detail?.slice(0, 300) ?? null, extra.reason ?? null, req.scope,
        req.approvalId ?? (req.actor.kind === "ai" ? req.actor.approvalId ?? null : null), req.dedupeKey ?? null, fence],
    );

  if (denial) {
    // A person's own reply that cannot go is refused with the reason, like every other channel.
    if (req.actor.kind === "human") throw new AppError("conflict", denial.detail);
    if (denial.needsApproval) {
      await insert("draft", { reason: "needs_approval", detail: denial.detail });
      const approvalId = await createApproval(db, {
        orgId: req.orgId,
        agentId: req.actor.kind === "ai" ? req.actor.agentId : null,
        kind: "follow_up_message",
        title: "Send AI reply to a website visitor",
        action: { messageId },
        targetType: "conversation",
        targetId: req.conversationId,
        reason: "Your AI employee prepared this reply to a website visitor and needs a person to approve it before it is sent.",
        expectedEffect: "The reply appears in the visitor's chat window.",
        risk: "medium",
        idempotencyKey: `draft:${messageId}`,
        actorKind: "agent",
      });
      if (approvalId) await db.query("update conversation_messages set approval_id = $2 where id = $1", [messageId, approvalId]);
      return { messageId, status: "draft", reason: "needs_approval", detail: denial.detail };
    }
    await insert("blocked", { reason: denial.reason, detail: denial.detail });
    return { messageId, status: "blocked", reason: denial.reason, detail: denial.detail };
  }

  await insert("sent");
  // The conversation's last activity, as a provider send would record it. "sent" means stored for the widget; the widget's next fetch makes it "delivered".
  await db.query("update conversations set last_outbound_at = now(), last_message_at = now(), last_message_preview = left($2, 200) where id = $1", [req.conversationId, req.body]);
  // A queued-and-sent web reply has no dispatcher step; "queued" in the result means "accepted for the visitor", the same word the other channels use.
  return { messageId, status: "queued" };
}

async function denyReason(db: Queryable, req: SendRequest, conv: ConversationRow): Promise<Denial | null> {
  if (conv.contact_deleted) return { reason: "contact_unreachable", detail: "This contact was removed.", permanent: true };
  if (req.actor.kind !== "ai") return null;
  if (conv.owner_kind !== "ai") return { reason: "human_owner", detail: "A person has taken over this conversation.", permanent: true };
  if (req.fenceVersion != null && req.fenceVersion !== conv.ownership_version) {
    return { reason: "stale_ownership", detail: "This conversation changed hands after the reply was prepared, so it was not sent.", permanent: true };
  }
  const approvalId = req.actor.approvalId ?? null;
  if (conv.ai_paused_at && !approvalId) return { reason: "ai_paused", detail: "AI replies are paused for this conversation.", permanent: true };
  if (conv.ai_enabled === false && !approvalId) return { reason: "automation_paused", detail: "The website assistant is switched off for this workspace.", permanent: true };
  const pending = await db.query("select 1 from human_escalations where conversation_id = $1 and status in ('awaiting_owner', 'open')", [req.conversationId]);
  if (pending.rows[0]) return { reason: "escalation_pending", detail: "A person is being asked to take over this conversation.", permanent: false };
  const gate = await automationGate(db, { orgId: req.orgId, agentId: req.actor.agentId, scope: "reply", approvalId });
  if (gate.decision === "blocked") {
    const reason = gate.reason === "org_inactive" ? "org_inactive" : ["agent_not_ready", "agent_missing", "agent_disabled"].includes(gate.reason) ? "agent_not_ready" : "automation_paused";
    return { reason, detail: gate.detail, permanent: true };
  }
  if (gate.decision === "needs_approval") return { reason: "needs_approval", detail: gate.detail, permanent: false, needsApproval: true };
  return null;
}
