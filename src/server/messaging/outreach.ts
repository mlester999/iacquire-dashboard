import "server-only";
import type { Queryable } from "@/server/db";
import { contactAddress } from "@/server/messaging/contacts";
import { evaluateSend, queueOutbound, type SendPurpose } from "@/server/messaging/send";
import { withDisclosure, type Channel } from "@/lib/messaging";

const CHANNEL_ORDER: Channel[] = ["sms", "whatsapp", "email"];

export interface OutreachRequest {
  orgId: string;
  contactId: string;
  /** The AI employee the message goes out under. */
  agentId: string | null;
  scope: "reminder" | "retention";
  purpose?: SendPurpose;
  body: string;
  /** Email subject when the message goes by email. */
  subject: string;
  /** The owner's standing authorization, which satisfies an employee that normally asks first. */
  approvalId: string | null;
  dedupeKey: string;
  now: Date;
  /** Add the "I'm an AI assistant" line when this is the first AI message the customer receives. */
  disclose?: boolean;
  businessHoursOnly?: boolean;
}

export type OutreachResult = { status: "queued" | "draft" | "blocked"; messageId?: string; reason?: string; detail?: string };

/** Where to reach a customer: the channel they last wrote on first, then any other channel we have an address for. */
async function conversationsFor(db: Queryable, req: OutreachRequest): Promise<Array<{ id: string; channel: Channel; subject: string | null }>> {
  const existing = await db.query<{ id: string; channel: Channel; subject: string | null }>(
    "select id, channel, subject from conversations where org_id = $1 and contact_id = $2 and status <> 'closed' order by last_inbound_at desc nulls last, created_at",
    [req.orgId, req.contactId],
  );
  const out = [...existing.rows];
  for (const channel of CHANNEL_ORDER) {
    if (out.some((c) => c.channel === channel)) continue;
    if (!(await contactAddress(db, req.orgId, req.contactId, channel))) continue;
    const created = await db.query<{ id: string; subject: string | null }>(
      `insert into conversations (org_id, contact_id, channel, status, subject, ai_agent_id, owner_kind)
       values ($1, $2, $3, 'open', $4, $5, 'ai') on conflict (org_id, contact_id, channel, thread_key) do update set updated_at = now() returning id, subject`,
      [req.orgId, req.contactId, channel, req.subject.slice(0, 300), req.agentId],
    );
    out.push({ id: created.rows[0].id, channel, subject: created.rows[0].subject });
  }
  return out;
}

/**
 * Sends one automated message to a customer on the best channel that every rule allows. The same rule chain as any other customer message
 * decides each candidate (consent for this purpose, opt-outs, quiet hours, pauses, a person owning the conversation, the employee's mode,
 * credits, frequency limits); a message that is only waiting for a better time is queued for it, and one that cannot go is reported with the reason.
 */
export async function queueOutreach(db: Queryable, req: OutreachRequest): Promise<OutreachResult> {
  const conversations = await conversationsFor(db, req);
  const org = await db.query<{ name: string; disclosure: string | null }>(
    "select o.name, s.ai_disclosure as disclosure from organizations o left join messaging_settings s on s.org_id = o.id where o.id = $1",
    [req.orgId],
  );
  const business = org.rows[0]?.name ?? "";
  const disclosure = org.rows[0]?.disclosure ?? "I'm an AI assistant for {business}.";

  let first: { reason: string; detail: string } | null = null;
  for (const c of conversations) {
    let body = req.body;
    if (req.disclose) {
      const prior = await db.query("select 1 from conversation_messages where conversation_id = $1 and author_kind = 'ai' and direction = 'outbound' and status in ('sent', 'delivered', 'read', 'queued') limit 1", [c.id]);
      body = withDisclosure(body, disclosure, business, prior.rows.length === 0);
    }
    const send = { orgId: req.orgId, conversationId: c.id, scope: req.scope, purpose: req.purpose, actor: { kind: "ai" as const, agentId: req.agentId, approvalId: req.approvalId }, body, now: req.now, businessHoursOnly: req.businessHoursOnly };
    const decision = await evaluateSend(db, send);
    // "Not yet" (quiet hours, spacing) and "needs a person's approval" are both acceptable: the message is queued for later or held as a draft.
    const waiting = !decision.allow && decision.retryAt && !decision.permanent;
    if (decision.allow || waiting || (!decision.allow && decision.needsApproval)) {
      const res = await queueOutbound(db, { ...send, dedupeKey: req.dedupeKey });
      return { status: res.status, messageId: res.messageId, reason: res.reason, detail: res.detail };
    }
    first ??= { reason: decision.reason, detail: decision.detail };
  }
  return { status: "blocked", reason: first?.reason ?? "no_contact_channel", detail: first?.detail ?? "There is no phone number or email address on file for this customer." };
}
