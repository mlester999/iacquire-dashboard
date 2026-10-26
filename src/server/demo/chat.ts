import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { isAgentRoleKey, type AgentRoleKey } from "@/lib/agents";
import { PUBLIC_COPY } from "@/lib/demo/copy";
import { chatRefusalFor, cleanMessage, isClientMessageId, MAX_MESSAGE_CHARS, MAX_REPLY_CHARS, messagesLeft, REFUSAL_COPY, RESERVATION_TIMEOUT_MINUTES, type ChatRefusal } from "@/lib/demo/rules";
import { addEvent, addressKey, dayOf, factsOf, lockProspect } from "@/server/demo/core";
import { notifyProspectTeam, type ProspectNotice } from "@/server/demo/notify";
import { findSession, transcriptOf, type DemoContext, type TranscriptLine } from "@/server/demo/public";
import { readDemoSettings } from "@/server/demo/settings";
import { demoDeploymentEnabled, demoPublicDisabled } from "@/server/demo/switch";
import { hashDemoToken, looksLikeDemoToken } from "@/server/demo/tokens";
import { countRefused, giveMessageBack, takeMessage } from "@/server/demo/usage";

// A prospect's chat message in three steps, each its own transaction, so the language model is never asked while a row is locked:
//
//   reserveDemoMessage   counts the message (the prospect's own allowance AND the platform's daily budget) and stores it as "pending". Atomic: the prospect's row is locked, the
//                        rules are read from it, and the count is raised by a guarded update, so twenty simultaneous posts of a prospect with ten messages left reserve exactly
//                        ten. The same clientMessageId again finds the stored message and counts nothing, even after the window has ended.
//   completeDemoMessage  stores the answer, and the message becomes "answered".
//   releaseDemoMessage   the answer never came (the model failed, was unavailable, or its answer was held back): the message is given back, marked "failed", and the timeline
//                        says why. A message whose process died is given back by the expiry job after RESERVATION_TIMEOUT_MINUTES.
//
// Who writes the answer (a scripted tour or the model, with its checks and metering) is the caller's; this file knows nothing of either. The chat has no tools and sees no workspace.

export type ReserveRefusal = ChatRefusal | "ai_off" | "daily_cap" | "rate_limited" | "unavailable" | "invalid" | "no_session";

export interface ReserveRefused {
  ok: false;
  reason: ReserveRefusal;
  message: string;
  retryAfterSeconds?: number;
}

export type ReserveResult =
  | {
      ok: true;
      kind: "reserved";
      prospectId: string;
      messageId: string;
      seq: number;
      /** The cleaned text of the message, as stored. */
      text: string;
      employeeRole: AgentRoleKey | null;
      messagesLeft: number;
      /** The UTC day whose budget the message was taken from. */
      day: string;
    }
  | { ok: true; kind: "duplicate"; message: TranscriptLine; reply: TranscriptLine | null };

export interface ReserveInput {
  text: unknown;
  clientMessageId: unknown;
  /** Which of the six AI Employees the prospect is asking (only a persona). */
  employeeRole?: unknown;
}

const reason = (r: ReserveRefusal, retryAfterSeconds?: number): ReserveRefused => ({
  ok: false,
  reason: r,
  message: r in REFUSAL_COPY ? REFUSAL_COPY[r as keyof typeof REFUSAL_COPY] : r === "no_session" ? PUBLIC_COPY.no_session : PUBLIC_COPY.unavailable,
  ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
});

export interface ReserveOptions {
  /** False when the caller found no model to ask (generator.ts). A message that would be new is then refused as "ai_off" before anything is counted; a repeated one still returns what was stored. */
  modelReady?: boolean;
}

export async function reserveDemoMessage(input: ReserveInput, ctx: DemoContext, opts: ReserveOptions = {}): Promise<ReserveResult | ReserveRefused> {
  const now = ctx.now ?? new Date();
  if (demoPublicDisabled()) return reason("unavailable", 300);
  if (!demoDeploymentEnabled()) return reason("unavailable");
  const ip = addressKey(ctx.ip);
  const pace = await consumeRateLimit(RATE_LIMITS.demoPublicByIp, ip);
  if (!pace.allowed) return reason("rate_limited", pace.retryAfterSeconds);
  if (!looksLikeDemoToken(ctx.sessionToken)) return reason("no_session");
  const text = cleanMessage(input.text);
  if (!text || text.length > MAX_MESSAGE_CHARS || !isClientMessageId(input.clientMessageId)) return reason("invalid");
  let employeeRole: AgentRoleKey | null = null;
  if (input.employeeRole !== undefined && input.employeeRole !== null && input.employeeRole !== "") {
    if (typeof input.employeeRole !== "string" || !isAgentRoleKey(input.employeeRole)) return reason("invalid");
    employeeRole = input.employeeRole;
  }
  const sessionKey = hashDemoToken(ctx.sessionToken as string).slice(0, 40);
  const burst = await consumeRateLimit(RATE_LIMITS.demoMessageByProspect, sessionKey);
  if (!burst.allowed) return reason("rate_limited", burst.retryAfterSeconds);
  const hourly = await consumeRateLimit(RATE_LIMITS.demoMessageByIp, ip);
  if (!hourly.allowed) return reason("rate_limited", hourly.retryAfterSeconds);
  const clientMessageId = input.clientMessageId;
  const notices: ProspectNotice[] = [];

  const result = await withSystem(async (db): Promise<ReserveResult | ReserveRefused> => {
    const { settings } = await readDemoSettings(db);
    if (!settings.enabled) return reason("unavailable");
    const found = await findSession(db, ctx.sessionToken, now, { lock: true });
    if (!found) return reason("no_session");
    const p = found.prospect;

    // The same message again: whatever was stored is returned and nothing is counted. This comes before every other check, so a reply to a message sent just before the window
    // ended (or the last message) is still readable by the browser that retries.
    const existing = (await db.query<{ id: string }>("select id::text as id from demo_messages where prospect_id = $1 and client_message_id = $2", [p.id, clientMessageId])).rows[0];
    if (existing) {
      const lines = await transcriptOf(db, p.id);
      const message = lines.find((l) => l.id === existing.id) as TranscriptLine;
      const answer = (await db.query<{ id: string }>("select id::text as id from demo_messages where prospect_id = $1 and reply_to_id = $2::bigint", [p.id, existing.id])).rows[0];
      return { ok: true, kind: "duplicate", message, reply: answer ? (lines.find((l) => l.id === answer.id) ?? null) : null };
    }

    if (!settings.aiEnabled || opts.modelReady === false) return reason("ai_off");
    const facts = factsOf(p);
    const refusal = chatRefusalFor(facts, now);
    if (refusal) return reason(refusal);

    // The platform's budget for the day, taken in this same transaction: when it is used up nothing about the prospect changes.
    if (!(await takeMessage(db, now, settings.dailyMessageCap))) {
      const refused = await countRefused(db, now);
      if (refused === 1) {
        notices.push({
          kind: "demo_budget_reached", severity: "warning", title: "The demo reached today's AI message budget",
          body: `Prospects are told the demo chat is full until tomorrow. The budget is ${settings.dailyMessageCap} message${settings.dailyMessageCap === 1 ? "" : "s"} a day and can be changed in the demo settings.`,
          link: "/admin/prospects", dedupeKey: `demo-budget:${dayOf(now)}`,
        });
      }
      return reason("daily_cap");
    }

    // The guarded update is the last line of defence behind the rules above: whatever the code decided, a message past the allowance is never counted.
    const counted = await db.query<{ message_seq: number; messages_used: number }>(
      `update demo_prospects set messages_used = messages_used + 1, message_seq = message_seq + 1, last_seen_at = $2::timestamptz
       where id = $1 and erased_at is null and verified_at is not null and status in ('active', 'consultation_requested', 'purchase_started')
         and window_ends_at > $2::timestamptz and messages_used < message_limit + extra_messages
       returning message_seq, messages_used`,
      [p.id, now.toISOString()],
    );
    const row = counted.rows[0];
    if (!row) throw new Error("A demo message passed the rules but not the guarded count; rolled back.");
    const inserted = await db.query<{ id: string }>(
      `insert into demo_messages (prospect_id, seq, role, employee_role, body, client_message_id, state, input_chars, created_at)
       values ($1, $2, 'user', $3, $4, $5, 'pending', $6, $7::timestamptz) returning id::text as id`,
      [p.id, row.message_seq, employeeRole, text, clientMessageId, text.length, now.toISOString()],
    );
    const left = messagesLeft({ messageLimit: p.message_limit, extraMessages: p.extra_messages, messagesUsed: row.messages_used });
    if (left === 0) await addEvent(db, p.id, "limit_reached", { kind: "prospect" }, { messagesUsed: row.messages_used }, now);
    return { ok: true, kind: "reserved", prospectId: p.id, messageId: inserted.rows[0].id, seq: row.message_seq, text, employeeRole, messagesLeft: left, day: dayOf(now) };
  });
  for (const n of notices) await withSystem((db) => notifyProspectTeam(db, n)).catch(() => undefined);
  return result;
}

export type CompleteResult = { ok: true; reply: TranscriptLine } | { ok: false; reason: "not_pending" | "empty" };

/** Stores the answer to a pending message and marks the message answered. The answer is cut to the stored length; what it says is the caller's responsibility. */
export async function completeDemoMessage(args: { prospectId: string; messageId: string; reply: string; now?: Date }): Promise<CompleteResult> {
  const now = args.now ?? new Date();
  const body = args.reply.slice(0, MAX_REPLY_CHARS).trimEnd();
  // An answer with nothing in it is not an answer: the message stays pending, and the caller gives it back.
  if (!body.trim()) return { ok: false, reason: "empty" };
  return withSystem(async (db) => {
    const p = await lockProspect(db, args.prospectId);
    if (!p) return { ok: false as const, reason: "not_pending" as const };
    const m = (await db.query<{ employee_role: string | null }>("select employee_role from demo_messages where id = $1::bigint and prospect_id = $2 and role = 'user' and state = 'pending' for update", [args.messageId, p.id])).rows[0];
    if (!m) return { ok: false as const, reason: "not_pending" as const };
    const seq = p.message_seq + 1;
    await db.query("update demo_prospects set message_seq = $2 where id = $1", [p.id, seq]);
    const reply = await db.query<{ id: string }>(
      `insert into demo_messages (prospect_id, seq, role, employee_role, body, reply_to_id, output_chars, created_at)
       values ($1, $2, 'assistant', $3, $4, $5::bigint, $6, $7::timestamptz) returning id::text as id`,
      [p.id, seq, m.employee_role, body, args.messageId, body.length, now.toISOString()],
    );
    await db.query("update demo_messages set state = 'answered', output_chars = $2 where id = $1::bigint", [args.messageId, body.length]);
    const line = (await transcriptOf(db, p.id)).find((l) => l.id === reply.rows[0].id) as TranscriptLine;
    return { ok: true as const, reply: line };
  });
}

/** Why a message was given back. Fixed words only: this is stored on the timeline. */
export const RELEASE_REASONS = ["provider_failed", "no_model", "reply_blocked", "input_blocked", "timeout", "internal"] as const;
export type ReleaseReason = (typeof RELEASE_REASONS)[number];

export type ReleaseResult = { ok: true; messagesLeft: number } | { ok: false; reason: "not_pending" };

/**
 * Gives a pending message back: it is marked failed, the prospect's count goes down by one, and the timeline says why (a held-back message is "message_blocked", anything else
 * "message_released"). The day's budget goes back too unless the model was already asked (`spent`), because then the platform paid for the attempt.
 */
export async function releaseDemoMessage(args: { prospectId: string; messageId: string; reason: ReleaseReason; spent?: boolean; now?: Date }): Promise<ReleaseResult> {
  const now = args.now ?? new Date();
  return withSystem((db) => release(db, args.prospectId, args.messageId, args.reason, args.spent === true, now));
}

async function release(db: Queryable, prospectId: string, messageId: string, why: ReleaseReason, spent: boolean, now: Date): Promise<ReleaseResult> {
  const p = await lockProspect(db, prospectId);
  if (!p) return { ok: false, reason: "not_pending" };
  const m = (await db.query<{ created_at: Date }>("select created_at from demo_messages where id = $1::bigint and prospect_id = $2 and role = 'user' and state = 'pending' for update", [messageId, p.id])).rows[0];
  if (!m) return { ok: false, reason: "not_pending" };
  await db.query("update demo_messages set state = 'failed' where id = $1::bigint", [messageId]);
  const used = await db.query<{ messages_used: number }>("update demo_prospects set messages_used = greatest(messages_used - 1, 0) where id = $1 returning messages_used", [p.id]);
  if (!spent) await giveMessageBack(db, dayOf(new Date(m.created_at)));
  await addEvent(db, p.id, why === "reply_blocked" || why === "input_blocked" ? "message_blocked" : "message_released", { kind: "system" }, { reason: why }, now);
  return { ok: true, messagesLeft: messagesLeft({ messageLimit: p.message_limit, extraMessages: p.extra_messages, messagesUsed: used.rows[0].messages_used }) };
}

/**
 * Gives back every message that was counted and never answered for longer than RESERVATION_TIMEOUT_MINUTES (the process that held it died). The day's budget is not given
 * back: nobody knows whether the model was asked. Bounded per run; the rest wait for the next one.
 */
export async function releaseStaleReservations(now: Date, limit = 200): Promise<number> {
  const cutoff = new Date(now.getTime() - RESERVATION_TIMEOUT_MINUTES * 60_000).toISOString();
  const stale = await withSystem((db) =>
    db.query<{ id: string; prospect_id: string }>("select id::text as id, prospect_id from demo_messages where state = 'pending' and created_at <= $1::timestamptz order by created_at limit $2", [cutoff, limit]),
  );
  let released = 0;
  for (const m of stale.rows) {
    const r = await withSystem((db) => release(db, m.prospect_id, m.id, "timeout", true, now));
    if (r.ok) released += 1;
  }
  return released;
}
