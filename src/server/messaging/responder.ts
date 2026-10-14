import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { sendEmail, type OutgoingEmail } from "@/server/email";
import { automationGate } from "@/server/automation/gate";
import { chargeUsage, getBalance } from "@/server/billing/ledger";
import { buildRunInstructions, loadConnection } from "@/server/workforce/service";
import { HermesError, startRun, streamRunEvents } from "@/server/integrations/hermes/client";
import { createEscalation } from "@/server/messaging/handoff";
import { queueOutbound } from "@/server/messaging/send";
import { isEscalationCategory, type EscalationCategory } from "@/lib/escalation";
import type { Channel } from "@/lib/messaging";

export interface ReplyContext {
  orgId: string;
  agentId: string;
  conversationId: string;
  contactId: string;
  inboundMessageId: string;
  channel: Channel;
  businessName: string;
  customerMessage: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  confirmedFacts: string[];
}

export type ReplyOutcome =
  | { kind: "reply"; text: string; usage?: { inputTokens: number | null; outputTokens: number | null } | null }
  | { kind: "escalate"; category: EscalationCategory; summary: string }
  | { kind: "unavailable"; reason: string };

export type ReplyGenerator = (ctx: ReplyContext) => Promise<ReplyOutcome>;

/**
 * Wraps the employee's configuration for a customer-facing run. The model may answer, or it may ask for a person with the
 * escalation protocol below. It is told never to invent facts, and the portal (not the model) guarantees AI disclosure and the cap on length.
 */
function customerInstructions(base: string, ctx: ReplyContext): string {
  const facts = ctx.confirmedFacts.length ? `\nConfirmed facts about this customer (from your team, not guesses):\n${ctx.confirmedFacts.map((f) => `- ${f}`).join("\n")}\n` : "";
  return `${base}

## You are replying to a customer
You are writing one ${ctx.channel === "email" ? "email" : ctx.channel === "whatsapp" ? "WhatsApp message" : "text message"} to a customer of ${ctx.businessName}. You are an AI assistant, not a person.
Be short, clear, natural and friendly. Use only information from the approved knowledge above and this conversation.
Never invent prices, availability, bookings, policies, results or promises. Never offer discounts or commit to anything legal or financial.
If you do not know, say you will check with the team.
${facts}
## When a person must take over
If the customer asks for a person, wants a refund, is complaining or upset, wants to negotiate or sign anything, wants a phone call, is ready to buy and needs a human closer, or you are unsure or the request is unsafe, do NOT answer.
Instead reply with exactly one line of JSON and nothing else:
{"escalate":"<ready_to_close|human_requested|phone_consultation|complaint|refund_concern|sensitive_negotiation|frustrated_customer|unanswered_question|unsafe_or_uncertain>","summary":"<one or two factual sentences for the team, from the conversation only>"}
Otherwise reply with the message text only, with no JSON, no preamble and no signature block.`;
}

/** Reads the model's answer. A malformed escalation is never sent to the customer. */
export function parseReply(raw: string): ReplyOutcome {
  const text = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  if (!text) return { kind: "unavailable", reason: "The AI employee returned an empty reply." };
  if (text.startsWith("{") || text.includes('"escalate"')) {
    try {
      const parsed = JSON.parse(text) as { escalate?: unknown; summary?: unknown };
      if (isEscalationCategory(parsed.escalate) && typeof parsed.summary === "string" && parsed.summary.trim()) {
        return { kind: "escalate", category: parsed.escalate, summary: parsed.summary.trim().slice(0, 600) };
      }
    } catch {
      /* fall through */
    }
    return { kind: "unavailable", reason: "The AI employee's reply was not in a usable format, so it was not sent." };
  }
  return { kind: "reply", text };
}

/** Adds the AI disclosure to the first message the AI sends in a conversation, whatever the model wrote. */
export function withDisclosure(text: string, disclosure: string, businessName: string, isFirstAiMessage: boolean): string {
  if (!isFirstAiMessage || /\b(AI|artificial intelligence|virtual assistant|automated)\b/i.test(text)) return text;
  return `${disclosure.replace("{business}", businessName)} ${text}`;
}

const MAX_LENGTH: Record<Channel, number> = { sms: 900, whatsapp: 1500, email: 4000 };

/** Generates a reply through the employee's own Hermes profile, waiting for the finished answer. */
export const hermesReplyGenerator: ReplyGenerator = async (ctx) => {
  const prepared = await withSystem(async (db) => {
    const conn = await loadConnection(db, ctx.agentId);
    if (!conn) return null;
    const { instructions } = await buildRunInstructions(db, ctx.orgId, ctx.agentId);
    return { conn, instructions };
  }).catch(() => null);
  if (!prepared) return { kind: "unavailable", reason: "The AI employee is not connected." };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 60_000);
  try {
    const { runId } = await startRun(prepared.conn, {
      input: ctx.customerMessage,
      instructions: customerInstructions(prepared.instructions, ctx),
      conversationHistory: ctx.history,
      idempotencyKey: `reply:${ctx.inboundMessageId}`,
      // One memory scope per customer, so what one customer says never reaches another customer's conversation.
      memoryScope: `iaq:${ctx.orgId}:contact:${ctx.contactId}`,
    });
    let output = "";
    for await (const ev of streamRunEvents(prepared.conn, runId, ac.signal)) {
      if (ev.type === "delta") output += ev.text;
      else if (ev.type === "completed") return attachUsage(parseReply(ev.output ?? output), ev.usage);
      else if (ev.type === "failed" || ev.type === "interrupted") return { kind: "unavailable", reason: "The AI employee could not finish a reply." };
      else if (ev.type === "cancelled") return { kind: "unavailable", reason: "The AI employee's run was stopped." };
      else if (ev.type === "approval_request") return { kind: "unavailable", reason: "The AI employee asked for a tool approval, so it did not answer on its own." };
    }
    return { kind: "unavailable", reason: "The AI employee did not finish a reply." };
  } catch (err) {
    return { kind: "unavailable", reason: err instanceof HermesError ? err.message : "The AI employee could not be reached." };
  } finally {
    clearTimeout(timer);
  }
};

function attachUsage(outcome: ReplyOutcome, usage: { inputTokens: number | null; outputTokens: number | null } | null): ReplyOutcome {
  return outcome.kind === "reply" ? { ...outcome, usage: usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : null } : outcome;
}

export type RespondResult =
  | { status: "queued" | "draft" | "blocked"; messageId: string; reason?: string }
  | { status: "escalated"; escalationId: string }
  | { status: "skipped"; reason: string }
  | { status: "unavailable"; reason: string };

async function loadContext(db: Queryable, orgId: string, conversationId: string): Promise<(ReplyContext & { aiDisclosure: string; aiMessageCount: number; ownerKind: string }) | null> {
  const { rows } = await db.query<{ contact_id: string; channel: Channel; ai_agent_id: string | null; owner_kind: string; name: string; disclosure: string | null }>(
    `select c.contact_id, c.channel, c.ai_agent_id, c.owner_kind, o.name, s.ai_disclosure as disclosure
     from conversations c join organizations o on o.id = c.org_id left join messaging_settings s on s.org_id = c.org_id where c.id = $1 and c.org_id = $2`,
    [conversationId, orgId],
  );
  const c = rows[0];
  if (!c?.ai_agent_id) return null;
  const last = await db.query<{ id: string; body: string }>("select id, body from conversation_messages where conversation_id = $1 and direction = 'inbound' order by created_at desc, id desc limit 1", [conversationId]);
  if (!last.rows[0]) return null;
  const hist = await db.query<{ direction: string; body: string }>(
    `select direction, body from conversation_messages where conversation_id = $1 and id <> $2
       and ((direction = 'inbound') or (direction = 'outbound' and status in ('sent', 'delivered', 'read'))) order by created_at desc, id desc limit 12`,
    [conversationId, last.rows[0].id],
  );
  const facts = await db.query<{ content: string }>("select content from contact_memories where contact_id = $1 and kind = 'confirmed_fact' and deleted_at is null order by created_at desc limit 10", [c.contact_id]);
  const aiCount = await db.query<{ n: string }>("select count(*)::text as n from conversation_messages where conversation_id = $1 and author_kind = 'ai' and status in ('sent', 'delivered', 'read', 'queued')", [conversationId]);
  return {
    orgId,
    agentId: c.ai_agent_id,
    conversationId,
    contactId: c.contact_id,
    inboundMessageId: last.rows[0].id,
    channel: c.channel,
    businessName: c.name,
    customerMessage: last.rows[0].body,
    history: hist.rows.reverse().map((r) => ({ role: r.direction === "inbound" ? ("user" as const) : ("assistant" as const), content: r.body })),
    confirmedFacts: facts.rows.map((f) => f.content),
    aiDisclosure: c.disclosure ?? "I'm an AI assistant for {business}.",
    aiMessageCount: Number(aiCount.rows[0].n),
    ownerKind: c.owner_kind,
  };
}

/**
 * Prepares the AI employee's answer to the latest customer message. It never spends on generation when automation is stopped
 * or credits are exhausted, answers each customer message at most once, and sends nothing itself: the reply goes through the
 * same rule chain as every other outbound message (drafts when approval is required, blocked when anything stops it).
 */
export async function respondToConversation(orgId: string, conversationId: string, deps: { generate?: ReplyGenerator; now?: Date } = {}): Promise<RespondResult> {
  const generate = deps.generate ?? hermesReplyGenerator;
  const pre = await withSystem(async (db) => {
    const ctx = await loadContext(db, orgId, conversationId);
    if (!ctx) return { skip: "no_conversation" as const };
    if (ctx.ownerKind !== "ai") return { skip: "human_owner" as const };
    const done = await db.query("select 1 from conversation_messages where org_id = $1 and dedupe_key = $2", [orgId, `reply-to:${ctx.inboundMessageId}`]);
    if (done.rows[0]) return { skip: "already_answered" as const };
    const open = await db.query("select 1 from human_escalations where conversation_id = $1 and status in ('awaiting_owner', 'open', 'claimed')", [conversationId]);
    if (open.rows[0]) return { skip: "escalation_pending" as const };
    const gate = await automationGate(db, { orgId, agentId: ctx.agentId, scope: "reply" });
    if (gate.decision === "blocked") return { skip: gate.reason };
    const bal = await getBalance(db, orgId);
    if (bal.availableMicros <= 0) return { skip: "credits" as const };
    return { ctx };
  });
  if ("skip" in pre) return { status: "skipped", reason: pre.skip as string };
  const { ctx } = pre;

  const outcome = await generate(ctx);
  const emails: OutgoingEmail[] = [];
  const result = await withSystem(async (db): Promise<RespondResult> => {
    // Re-check after the (possibly slow) generation: a person may have taken over meanwhile.
    const fresh = await loadContext(db, orgId, conversationId);
    if (!fresh || fresh.ownerKind !== "ai" || fresh.inboundMessageId !== ctx.inboundMessageId) return { status: "skipped", reason: "conversation_changed" };
    if (outcome.kind === "unavailable") {
      await db.query("insert into conversation_messages (org_id, conversation_id, direction, author_kind, agent_id, body, status, status_detail) values ($1, $2, 'internal', 'system', $3, $4, 'note', 'ai_unavailable')", [orgId, conversationId, ctx.agentId, `The AI employee could not prepare a reply: ${outcome.reason}`]);
      // Nobody should be left waiting unseen: ask a person to look.
      const esc = await createEscalation(db, { orgId, conversationId, category: "unanswered_question", summary: "The AI employee could not answer this message. Please reply.", sourceMessageId: ctx.inboundMessageId, agentId: ctx.agentId, now: deps.now });
      emails.push(...esc.emails);
      return { status: "unavailable", reason: outcome.reason };
    }
    if (outcome.kind === "escalate") {
      const esc = await createEscalation(db, { orgId, conversationId, category: outcome.category, summary: outcome.summary, sourceMessageId: ctx.inboundMessageId, agentId: ctx.agentId, now: deps.now });
      emails.push(...esc.emails);
      return { status: "escalated", escalationId: esc.escalationId };
    }
    const text = withDisclosure(outcome.text, ctx.aiDisclosure, ctx.businessName, ctx.aiMessageCount === 0).slice(0, MAX_LENGTH[ctx.channel]);
    const queued = await queueOutbound(db, { orgId, conversationId, scope: "reply", actor: { kind: "ai", agentId: ctx.agentId }, body: text, now: deps.now, dedupeKey: `reply-to:${ctx.inboundMessageId}` });
    // Meter the model's own usage when a rate has been published for it; otherwise there is nothing priced to charge.
    if (outcome.usage) await chargeModelUsage(db, orgId, queued.messageId, outcome.usage);
    return { status: queued.status, messageId: queued.messageId, reason: queued.reason };
  });
  await Promise.all(emails.map((e) => sendEmail(e)));
  return result;
}

async function chargeModelUsage(db: Queryable, orgId: string, messageId: string, usage: { inputTokens: number | null; outputTokens: number | null }) {
  for (const [unit, tokens] of [["ai_tokens_in", usage.inputTokens], ["ai_tokens_out", usage.outputTokens]] as const) {
    if (!tokens || tokens <= 0) continue;
    const rate = await db.query<{ w: string }>(
      `select r.wholesale_micros_per_unit::text as w from usage_unit_rates r join usage_rate_versions v on v.id = r.rate_version_id
       where r.provider = 'llm' and r.unit_type = $1 order by v.version desc limit 1`,
      [unit],
    );
    if (!rate.rows[0]) continue;
    // Rates are per 1,000 tokens.
    const wholesale = Math.ceil((Number(rate.rows[0].w) * tokens) / 1000);
    await chargeUsage(db, { orgId, usage: { provider: "llm", unitType: unit, quantity: tokens, wholesaleMicros: wholesale, providerReference: `reply:${messageId}:${unit}`, messageId } });
  }
}

/**
 * Recovery sweep for the worker: finds AI-owned conversations whose latest customer message has no answer yet (for example the
 * server restarted after the webhook) and answers them. Each inbound message is answered at most once.
 */
export async function respondToPending(deps: { generate?: ReplyGenerator; limit?: number; olderThanSeconds?: number } = {}): Promise<{ checked: number }> {
  const { rows } = await withSystem((db) =>
    db.query<{ org_id: string; id: string }>(
      `select c.org_id, c.id from conversations c
       where c.owner_kind = 'ai' and c.status <> 'closed' and c.last_inbound_at is not null and c.last_inbound_at < now() - ($2 || ' seconds')::interval
         and coalesce(c.last_outbound_at, 'epoch') < c.last_inbound_at
         and not exists (select 1 from conversation_messages m where m.conversation_id = c.id and m.direction = 'outbound' and m.author_kind = 'ai' and m.created_at > c.last_inbound_at)
       order by c.last_inbound_at limit $1`,
      [deps.limit ?? 20, String(deps.olderThanSeconds ?? 30)],
    ),
  );
  for (const r of rows) await respondToConversation(r.org_id, r.id, { generate: deps.generate });
  return { checked: rows.length };
}

