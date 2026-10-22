import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { sendEmail, type OutgoingEmail } from "@/server/email";
import { automationGate } from "@/server/automation/gate";
import { chargeUsage, getBalance } from "@/server/billing/ledger";
import { buildRunInstructions, loadConnection } from "@/server/workforce/service";
import { HermesError, startAgentRun, streamRunEvents } from "@/server/integrations/hermes/client";
import { createEscalation } from "@/server/messaging/handoff";
import { getAvailability } from "@/server/appointments/availability";
import { requestBooking, type BookingResult } from "@/server/appointments/booking";
import type { AppointmentProvider } from "@/server/appointments/provider";
import { detectBookingIntent, formatSlot } from "@/lib/appointments";
import { queueOutbound } from "@/server/messaging/send";
import { isEscalationCategory, type EscalationCategory } from "@/lib/escalation";
import { withDisclosure, type ConversationChannel } from "@/lib/messaging";

export interface ReplyContext {
  orgId: string;
  agentId: string;
  conversationId: string;
  contactId: string;
  inboundMessageId: string;
  channel: ConversationChannel;
  /** A website chat's widget may switch booking off; every other channel can always read the calendar. */
  allowBooking?: boolean;
  businessName: string;
  customerMessage: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  confirmedFacts: string[];
  /** Present only when the customer is talking about booking: what the real calendar says, or that it could not be read. */
  availability?: ReplyAvailability;
}

export type ReplyAvailability =
  | { state: "slots"; timeZone: string; slots: Array<{ start: string; label: string }> }
  | { state: "none"; timeZone: string }
  | { state: "unknown"; reason: string };

export type ReplyOutcome =
  | { kind: "reply"; text: string; usage?: { inputTokens: number | null; outputTokens: number | null } | null }
  | { kind: "book"; startIso: string; summary: string; usage?: { inputTokens: number | null; outputTokens: number | null } | null }
  | { kind: "escalate"; category: EscalationCategory; summary: string }
  | { kind: "unavailable"; reason: string };

export type ReplyGenerator = (ctx: ReplyContext) => Promise<ReplyOutcome>;

/**
 * Wraps the employee's configuration for a customer-facing run. The model may answer, or it may ask for a person with the
 * escalation protocol below. It is told never to invent facts, and the portal (not the model) guarantees AI disclosure and the cap on length.
 */
export function customerInstructions(base: string, ctx: ReplyContext): string {
  const facts = ctx.confirmedFacts.length ? `\nConfirmed facts about this customer (from your team, not guesses):\n${ctx.confirmedFacts.map((f) => `- ${f}`).join("\n")}\n` : "";
  return `${base}

## You are replying to a customer
You are writing one ${ctx.channel === "email" ? "email" : ctx.channel === "whatsapp" ? "WhatsApp message" : ctx.channel === "web_chat" ? "chat message on the business's website" : "text message"} to a customer of ${ctx.businessName}. You are an AI assistant, not a person.
Be short, clear, natural and friendly. Use only information from the approved knowledge above and this conversation.
Never invent prices, availability, bookings, policies, results or promises. Never offer discounts or commit to anything legal or financial.
If you do not know, say you will check with the team.
${facts}${bookingBlock(ctx)}
## When a person must take over
If the customer asks for a person, wants a refund, is complaining or upset, wants to negotiate or sign anything, wants a phone call, is ready to buy and needs a human closer, or you are unsure or the request is unsafe, do NOT answer.
Instead reply with exactly one line of JSON and nothing else:
{"escalate":"<ready_to_close|human_requested|phone_consultation|complaint|refund_concern|sensitive_negotiation|frustrated_customer|unanswered_question|unsafe_or_uncertain>","summary":"<one or two factual sentences for the team, from the conversation only>"}
Otherwise reply with the message text only, with no JSON, no preamble and no signature block.`;
}

/**
 * What the model may say about appointments. The list is read from the real calendar a moment ago and is the only thing it may offer
 * or book. Without it, it is told plainly that it cannot see the calendar.
 */
export function bookingBlock(ctx: ReplyContext): string {
  const a = ctx.availability;
  if (!a) return "";
  if (a.state === "unknown") {
    return `\n## Booking\nYou cannot see the calendar right now. Do not offer, confirm or promise any appointment time. Say a team member will confirm a time shortly.\n`;
  }
  if (a.state === "none") {
    return `\n## Booking\nThe calendar shows no free times in the next few days. Do not offer or confirm any time. Ask which days suit them, and say the team will confirm.\n`;
  }
  const list = a.slots.map((s) => `- ${s.start} (${s.label})`).join("\n");
  return `\n## Booking
These are the only times that are really free, read from the calendar just now (shown in ${a.timeZone}). Offer only these exact times, in plain words, never as ISO text:
${list}
Never say or imply any other time is available. If the customer clearly chooses one of them, do not reply with text. Reply with exactly one line of JSON and nothing else:
{"book":"<the exact start value from the list>","summary":"<a short phrase for the team, e.g. Viewing on Tuesday at 2pm>"}
If none suit them, ask what days they prefer and say the team will confirm. Do not book without a clear choice.\n`;
}

/** Reads the model's answer. A malformed escalation is never sent to the customer. */
export function parseReply(raw: string): ReplyOutcome {
  const text = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  if (!text) return { kind: "unavailable", reason: "The AI employee returned an empty reply." };
  if (text.startsWith("{") || text.includes('"escalate"') || text.includes('"book"')) {
    try {
      const parsed = JSON.parse(text) as { escalate?: unknown; summary?: unknown; book?: unknown };
      if (isEscalationCategory(parsed.escalate) && typeof parsed.summary === "string" && parsed.summary.trim()) {
        return { kind: "escalate", category: parsed.escalate, summary: parsed.summary.trim().slice(0, 600) };
      }
      if (typeof parsed.book === "string" && !Number.isNaN(Date.parse(parsed.book))) {
        return { kind: "book", startIso: new Date(parsed.book).toISOString(), summary: typeof parsed.summary === "string" ? parsed.summary.trim().slice(0, 200) : "" };
      }
    } catch {
      /* fall through */
    }
    return { kind: "unavailable", reason: "The AI employee's reply was not in a usable format, so it was not sent." };
  }
  return { kind: "reply", text };
}

export { withDisclosure };

const MAX_LENGTH: Record<ConversationChannel, number> = { sms: 900, whatsapp: 1500, email: 4000, web_chat: 1200 };

/** The reply generator for a conversation's channel when the caller names none: a website chat is answered from the widget's own knowledge, every other channel by the employee's Hermes profile. */
async function defaultGenerator(channel: ConversationChannel): Promise<ReplyGenerator> {
  // Loaded on demand so the website chat module (which imports from this file) is not a static cycle.
  if (channel === "web_chat") return (await import("@/server/webchat/generator")).webChatReplyGenerator;
  return hermesReplyGenerator;
}

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
    const { runId } = await startAgentRun(ctx.agentId, ctx.orgId, prepared.conn, {
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
  return outcome.kind === "reply" || outcome.kind === "book" ? { ...outcome, usage: usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : null } : outcome;
}

export type RespondResult =
  | { status: "queued" | "draft" | "blocked"; messageId: string; reason?: string }
  | { status: "escalated"; escalationId: string }
  | { status: "skipped"; reason: string }
  | { status: "unavailable"; reason: string };

async function loadContext(db: Queryable, orgId: string, conversationId: string): Promise<(ReplyContext & { aiDisclosure: string; aiMessageCount: number; ownerKind: string; ownershipVersion: number; aiPaused: boolean }) | null> {
  const { rows } = await db.query<{ contact_id: string; channel: ConversationChannel; ai_agent_id: string | null; owner_kind: string; ownership_version: number; ai_paused_at: Date | null; name: string; disclosure: string | null; allow_booking: boolean | null }>(
    `select c.contact_id, c.channel, c.ai_agent_id, c.owner_kind, c.ownership_version, c.ai_paused_at, o.name, s.ai_disclosure as disclosure, w.allow_booking
     from conversations c join organizations o on o.id = c.org_id left join messaging_settings s on s.org_id = c.org_id left join web_chat_widgets w on w.org_id = c.org_id
     where c.id = $1 and c.org_id = $2`,
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
    allowBooking: c.channel === "web_chat" ? c.allow_booking !== false : true,
    businessName: c.name,
    customerMessage: last.rows[0].body,
    history: hist.rows.reverse().map((r) => ({ role: r.direction === "inbound" ? ("user" as const) : ("assistant" as const), content: r.body })),
    confirmedFacts: facts.rows.map((f) => f.content),
    aiDisclosure: c.disclosure ?? "I'm an AI assistant for {business}.",
    aiMessageCount: Number(aiCount.rows[0].n),
    ownerKind: c.owner_kind,
    ownershipVersion: c.ownership_version,
    aiPaused: c.ai_paused_at !== null,
  };
}

/**
 * Prepares the AI employee's answer to the latest customer message. It never spends on generation when automation is stopped
 * or credits are exhausted, answers each customer message at most once, and sends nothing itself: the reply goes through the
 * same rule chain as every other outbound message (drafts when approval is required, blocked when anything stops it).
 */
export async function respondToConversation(orgId: string, conversationId: string, deps: { generate?: ReplyGenerator; now?: Date; provider?: AppointmentProvider } = {}): Promise<RespondResult> {
  const pre = await withSystem(async (db) => {
    const ctx = await loadContext(db, orgId, conversationId);
    if (!ctx) return { skip: "no_conversation" as const };
    if (ctx.ownerKind !== "ai") return { skip: "human_owner" as const };
    // Paused by a person: no reply is generated at all (it would only be refused, and the model call costs money).
    if (ctx.aiPaused) return { skip: "ai_paused" as const };
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

  // Only when the customer is talking about booking: read the real calendar so the employee can offer nothing else.
  if (ctx.allowBooking !== false && detectBookingIntent(ctx.customerMessage, ctx.history.map((h) => h.content))) ctx.availability = await readAvailability(ctx, deps);

  const generate = deps.generate ?? (await defaultGenerator(ctx.channel));
  let outcome = await generate(ctx);
  let bookingNote: BookingResult | null = null;
  if (outcome.kind === "book") {
    const chosen = outcome.startIso;
    const offered = ctx.availability?.state === "slots" ? ctx.availability.slots.find((s) => s.start === chosen) : undefined;
    if (!offered) {
      // The employee named a time that was not on the list. Nothing is booked, and a person looks at the conversation.
      outcome = { kind: "unavailable", reason: "The AI employee chose a time that was not on the calendar's list, so nothing was booked." };
    } else {
      const usage = outcome.usage;
      bookingNote = await requestBooking(
        { orgId, contactId: ctx.contactId, conversationId, startAt: new Date(chosen), title: outcome.summary || undefined, actor: { kind: "ai", agentId: ctx.agentId }, now: deps.now },
        { provider: deps.provider },
      );
      outcome = { kind: "reply", text: bookingReplyText(bookingNote, offered.label), usage };
    }
  }
  const emails: OutgoingEmail[] = [];
  const result = await withSystem(async (db): Promise<RespondResult> => {
    // Re-check after the (possibly slow) generation: a person may have taken over meanwhile.
    const fresh = await loadContext(db, orgId, conversationId);
    // The ownership revision is the fence: a takeover (even one handed straight back), a pause or another employee since the reply was
    // prepared means it was written for a situation that no longer holds. Compared by revision, not by owner kind alone.
    if (!fresh || fresh.ownerKind !== "ai" || fresh.ownershipVersion !== ctx.ownershipVersion || fresh.aiPaused || fresh.inboundMessageId !== ctx.inboundMessageId) return { status: "skipped", reason: "conversation_changed" };
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
    if (bookingNote?.status === "booked") {
      // The booking already queued its own confirmation through the same gate; a second message would only repeat it.
      const confirm = await db.query<{ id: string; status: string }>("select id, status from conversation_messages where org_id = $1 and dedupe_key = $2", [orgId, `booking-confirm:${bookingNote.bookingId}`]);
      if (outcome.kind === "reply" && outcome.usage && confirm.rows[0]) await chargeModelUsage(db, orgId, confirm.rows[0].id, outcome.usage);
      return confirm.rows[0]
        ? { status: confirm.rows[0].status === "blocked" ? "blocked" : "queued", messageId: confirm.rows[0].id }
        : { status: "blocked", messageId: "", reason: "booking_confirmation_not_sent" };
    }
    const text = withDisclosure(outcome.text, ctx.aiDisclosure, ctx.businessName, ctx.aiMessageCount === 0).slice(0, MAX_LENGTH[ctx.channel]);
    const queued = await queueOutbound(db, { orgId, conversationId, scope: "reply", actor: { kind: "ai", agentId: ctx.agentId }, body: text, now: deps.now, dedupeKey: `reply-to:${ctx.inboundMessageId}`, fenceVersion: ctx.ownershipVersion });
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


async function readAvailability(ctx: ReplyContext, deps: { now?: Date; provider?: AppointmentProvider }): Promise<ReplyAvailability> {
  try {
    const tz = await withSystem(
      async (db) => (await db.query<{ tz: string }>("select coalesce(k.timezone, o.timezone) as tz from contacts k join organizations o on o.id = k.org_id where k.id = $1 and k.org_id = $2", [ctx.contactId, ctx.orgId])).rows[0]?.tz ?? "UTC",
    );
    const res = await getAvailability(ctx.orgId, { timeZone: tz, limit: 8, perDay: 3, now: deps.now, provider: deps.provider });
    if (!res.ok) return { state: "unknown", reason: res.detail };
    if (!res.slots.length) return { state: "none", timeZone: tz };
    return { state: "slots", timeZone: tz, slots: res.slots.map((s) => ({ start: s.start, label: formatSlot(s.start, tz) })) };
  } catch {
    return { state: "unknown", reason: "The calendar could not be read." };
  }
}

/** What the customer is told after the employee asks to book a time. It never says "booked" unless the calendar confirmed it. */
export function bookingReplyText(r: BookingResult, label: string): string {
  switch (r.status) {
    case "booked":
      return `You're booked for ${label}.`;
    case "awaiting_approval":
      return `Thanks! I've asked the team to confirm ${label}. You'll hear back shortly.`;
    case "needs_manual":
      return `Thanks! I've passed ${label} to the team, who will confirm it with you shortly.`;
    case "unavailable":
      return r.reason === "slot_taken" ? "Sorry, that time was just taken. Would another time work for you?" : "I can't confirm times right now, so I've asked a team member to follow up with you.";
    default:
      return "I couldn't complete that booking, so I've asked a team member to follow up with you.";
  }
}
