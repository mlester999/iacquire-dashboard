import "server-only";
import { withSystem } from "@/server/db";
import { sendEmail, type OutgoingEmail } from "@/server/email";
import { systemActor } from "@/server/crm/actor";
import { emitEvent } from "@/server/crm/events";
import { createEscalation } from "@/server/messaging/handoff";
import { respondToConversation, type ReplyGenerator, type RespondResult } from "@/server/messaging/responder";
import type { AppointmentProvider } from "@/server/appointments/provider";
import { systemMessageToVisitor } from "@/server/webchat/visitor";

// What happens after a visitor's message is stored: the conversation's AI employee answers through the same reply path every channel uses
// (ownership fence, pause, takeover, escalation, booking from the real calendar). When it cannot, nobody is left waiting unseen: a person is asked
// to look, and the visitor is told plainly in the chat that a team member will follow up. A person who has taken the chat over is never answered over.

/** Skips that mean the AI could not or would not answer for a reason the visitor should not be left guessing about. */
const UNANSWERED_SKIPS = new Set(["credits", "automation_paused", "agent_not_ready", "agent_missing", "agent_disabled", "org_inactive", "approval_required"]);

const WAIT_MESSAGE = "Thanks, I've asked a team member to follow up. If you'd like them to reach you, leave your details below.";

export interface ReplyDeps {
  generate?: ReplyGenerator;
  /** How long the visitor's request waits for the AI before it returns and lets the recovery sweep finish the reply. */
  timeoutMs?: number;
  now?: Date;
  provider?: AppointmentProvider;
}

export async function replyToVisitor(orgId: string, conversationId: string, deps: ReplyDeps = {}): Promise<RespondResult | { status: "timeout" }> {
  const startedAt = new Date(Date.now() - 1000);
  const work = respondToConversation(orgId, conversationId, { generate: deps.generate, now: deps.now, provider: deps.provider });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ status: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timeout" }), deps.timeoutMs ?? 28_000);
  });
  const result = await Promise.race([work, timeout]).finally(() => clearTimeout(timer));
  if (result.status === "timeout") {
    // The reply keeps being prepared and will be stored when ready; the widget's next fetch shows it. A failure after this point is swept up by the worker.
    work.catch(() => undefined);
    return result;
  }
  const emails: OutgoingEmail[] = [];
  await withSystem(async (db) => {
    // A booking the assistant took from this visitor is announced to workflows once, whatever became of it.
    const booked = await db.query<{ id: string; contact_id: string; status: string }>("select id, contact_id, status from appointment_bookings where org_id = $1 and conversation_id = $2 and created_at >= $3", [orgId, conversationId, startedAt]);
    for (const b of booked.rows) {
      await emitEvent(db, systemActor({ id: orgId }), { type: "webchat.booking_requested", entityType: "contact", entityId: b.contact_id, contactId: b.contact_id, byContact: true, payload: { conversationId, bookingId: b.id, status: b.status }, dedupeKey: `webchat.booking_requested:${b.id}` });
    }
    const last = await db.query<{ id: string }>("select id from conversation_messages where conversation_id = $1 and org_id = $2 and direction = 'inbound' order by created_at desc, id desc limit 1", [conversationId, orgId]);
    const inbound = last.rows[0]?.id ?? "none";
    if (result.status === "unavailable") {
      await systemMessageToVisitor(db, orgId, conversationId, WAIT_MESSAGE, `webchat:unavailable:${inbound}`);
    } else if (result.status === "escalated") {
      await systemMessageToVisitor(db, orgId, conversationId, "I've asked a team member to join this chat. If you close the page, leave your details below so they can reach you.", `webchat:handoff:${result.escalationId}`);
    } else if (result.status === "draft") {
      await systemMessageToVisitor(db, orgId, conversationId, WAIT_MESSAGE, `webchat:await:${inbound}`);
    } else if (result.status === "skipped" && UNANSWERED_SKIPS.has(result.reason)) {
      const conv = await db.query<{ ai_agent_id: string | null }>("select ai_agent_id from conversations where id = $1 and org_id = $2", [conversationId, orgId]);
      const esc = await createEscalation(db, { orgId, conversationId, category: "unanswered_question", summary: "The website assistant could not answer this visitor, so a person needs to reply.", sourceMessageId: inbound === "none" ? null : inbound, agentId: conv.rows[0]?.ai_agent_id ?? null, now: deps.now });
      emails.push(...esc.emails);
      await systemMessageToVisitor(db, orgId, conversationId, WAIT_MESSAGE, `webchat:unavailable:${inbound}`);
    }
  });
  await Promise.all(emails.map((e) => sendEmail(e)));
  return result;
}
