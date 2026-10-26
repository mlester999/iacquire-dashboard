// A prospect's chat message in its three steps (reserve, answer, give back): the count under many simultaneous posts, the same message again, the window's edge, the platform's
// daily budget, and what happens when no answer comes. The language model is never involved: the "answer" is a string the test supplies. Embedded Postgres only.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { completeDemoMessage, releaseDemoMessage, releaseStaleReservations, reserveDemoMessage } from "@/server/demo/chat";
import { blockProspect, extendDemo } from "@/server/demo/admin";
import { getRoom } from "@/server/demo/public";
import { count, demoEnv, messageId, messagePace, openDemo, prospectRow, rows, say, startDemo, team, type Started, type Team } from "./support/demo";

let people: Team;
const T0 = new Date("2026-11-02T09:00:00Z");
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);
const hours = (n: number) => new Date(T0.getTime() + n * 3_600_000);

beforeAll(async () => {
  demoEnv();
  messagePace("relaxed");
  people = await team();
  await openDemo(people.superAdmin, { windowHours: 24, messageLimit: 10, aiEnabled: true, dailyStartCap: 10_000, dailyMessageCap: 10_000 });
});
afterEach(() => demoEnv());

/** Reserves one message and returns the whole answer. */
const reserve = (s: Started, text = "Hello", over: { id?: string; at?: Date; role?: unknown } = {}) =>
  reserveDemoMessage({ text, clientMessageId: over.id ?? messageId(), employeeRole: over.role }, s.ctx(over.at ? { now: over.at } : {}));

const reservedOf = (r: Awaited<ReturnType<typeof reserve>>) => {
  if (!r.ok || r.kind !== "reserved") throw new Error(`not reserved: ${JSON.stringify(r)}`);
  return r;
};

describe("reserving, answering and giving back", () => {
  it("counts the message first, keeps it pending, and stores the answer after it", async () => {
    const s = await startDemo({}, T0);
    const r = reservedOf(await reserve(s, "What do the six employees do?", { at: minutes(5), role: "operations_manager" }));
    expect(r).toMatchObject({ seq: 1, messagesLeft: 9, employeeRole: "operations_manager", text: "What do the six employees do?" });
    expect(await prospectRow(s.prospectId)).toMatchObject({ messages_used: 1, message_seq: 1 });
    expect((await rows("select seq, role, state, body, input_chars from demo_messages where prospect_id = $1", [s.prospectId]))[0]).toMatchObject({ seq: 1, role: "user", state: "pending", input_chars: 29 });
    const done = await completeDemoMessage({ prospectId: s.prospectId, messageId: r.messageId, reply: "They answer, book, follow up and report. This demo uses sample data.", now: minutes(6) });
    expect(done).toMatchObject({ ok: true, reply: { role: "assistant", seq: 2, employeeRole: "operations_manager" } });
    expect((await rows("select seq, role, state, reply_to_id::text as reply_to_id from demo_messages where prospect_id = $1 order by seq", [s.prospectId])).map((m) => [m.seq, m.role, m.state])).toEqual([[1, "user", "answered"], [2, "assistant", null]]);
    expect(await prospectRow(s.prospectId)).toMatchObject({ messages_used: 1, message_seq: 2 });
  });

  it("lets exactly ten of twenty simultaneous posts through when ten are left, and never counts more", async () => {
    const s = await startDemo({}, T0);
    const answers = await Promise.all(Array.from({ length: 20 }, (_, i) => reserve(s, `Question ${i + 1}`, { at: minutes(10) })));
    const reserved = answers.filter((a) => a.ok && a.kind === "reserved");
    const refused = answers.filter((a) => !a.ok);
    expect(reserved).toHaveLength(10);
    expect(refused).toHaveLength(10);
    expect(refused.every((a) => !a.ok && a.reason === "limit_reached")).toBe(true);
    expect(await prospectRow(s.prospectId)).toMatchObject({ messages_used: 10, message_seq: 10 });
    expect(await count("demo_messages", "prospect_id = $1 and role = 'user'", [s.prospectId])).toBe(10);
    expect(new Set(reserved.map((a) => (a.ok && a.kind === "reserved" ? a.seq : 0))).size).toBe(10);
    expect(await count("demo_events", "prospect_id = $1 and kind = 'limit_reached'", [s.prospectId])).toBe(1);
    // And one more, later, is still refused.
    expect(await reserve(s, "One more", { at: minutes(20) })).toMatchObject({ ok: false, reason: "limit_reached" });
    expect(await prospectRow(s.prospectId)).toMatchObject({ messages_used: 10 });
  });

  it("counts a message sent twenty times at once (same key) once", async () => {
    const s = await startDemo({}, T0);
    const id = messageId();
    const answers = await Promise.all(Array.from({ length: 20 }, () => reserve(s, "Same message", { id, at: minutes(10) })));
    expect(answers.filter((a) => a.ok && a.kind === "reserved")).toHaveLength(1);
    expect(answers.filter((a) => a.ok && a.kind === "duplicate")).toHaveLength(19);
    expect(await prospectRow(s.prospectId)).toMatchObject({ messages_used: 1 });
    expect(await count("demo_messages", "prospect_id = $1", [s.prospectId])).toBe(1);
  });

  it("gives the stored message and answer for a replay, counts nothing, and still can after the window ended or the last message was used", async () => {
    const s = await startDemo({}, T0);
    const id = messageId();
    const first = reservedOf(await reserve(s, "Please replay me", { id, at: minutes(1) }));
    await completeDemoMessage({ prospectId: s.prospectId, messageId: first.messageId, reply: "Replayed answer", now: minutes(2) });
    const pending = await reserve(s, "Pending one", { at: minutes(3) });
    expect(pending.ok).toBe(true);
    const used = (await prospectRow(s.prospectId)).messages_used;
    const again = await reserve(s, "Please replay me", { id, at: minutes(4) });
    expect(again).toMatchObject({ ok: true, kind: "duplicate", message: { body: "Please replay me", state: "answered" }, reply: { body: "Replayed answer", role: "assistant" } });
    // The window is over by the time the browser retries.
    expect(await reserve(s, "Please replay me", { id, at: hours(30) })).toMatchObject({ ok: true, kind: "duplicate", reply: { body: "Replayed answer" } });
    // A different message in the same state is refused.
    expect(await reserve(s, "New", { at: hours(30) })).toMatchObject({ ok: false, reason: "window_ended" });
    expect((await prospectRow(s.prospectId)).messages_used).toBe(used);
    // A replay of a message still waiting says so, with no answer yet.
    const waiting = (await rows<{ client_message_id: string }>("select client_message_id from demo_messages where prospect_id = $1 and state = 'pending'", [s.prospectId]))[0].client_message_id;
    expect(await reserve(s, "Pending one", { id: waiting, at: minutes(5) })).toMatchObject({ ok: true, kind: "duplicate", message: { state: "pending" }, reply: null });
  });

  it("opens the chat strictly before the window ends: one millisecond early is fine, the very moment is not", async () => {
    const s = await startDemo({}, T0);
    const end = hours(24);
    expect(await reserve(s, "Just in time", { at: new Date(end.getTime() - 1) })).toMatchObject({ ok: true, kind: "reserved" });
    expect(await reserve(s, "Too late", { at: end })).toMatchObject({ ok: false, reason: "window_ended", message: "Your demo window has ended. You can still read your conversation and ask for a consultation." });
    expect(await reserve(s, "Much too late", { at: new Date(end.getTime() + 1) })).toMatchObject({ ok: false, reason: "window_ended" });
    expect((await prospectRow(s.prospectId)).messages_used).toBe(1);
  });

  it("refuses a message that is empty, too long, without a usable key, or for a seventh employee, and counts nothing", async () => {
    const s = await startDemo({}, T0);
    const bad: Array<[string, Parameters<typeof reserveDemoMessage>[0]]> = [
      ["empty", { text: "   ", clientMessageId: messageId() }],
      ["not text", { text: 5, clientMessageId: messageId() }],
      ["too long", { text: "x".repeat(1001), clientMessageId: messageId() }],
      ["short key", { text: "hi", clientMessageId: "abc" }],
      ["key with a space", { text: "hi", clientMessageId: "abcdefgh ijkl" }],
      ["no key", { text: "hi", clientMessageId: undefined }],
      ["a seventh employee", { text: "hi", clientMessageId: messageId(), employeeRole: "social_media_manager" }],
      ["a role that is not text", { text: "hi", clientMessageId: messageId(), employeeRole: 7 }],
    ];
    for (const [label, input] of bad) expect(await reserveDemoMessage(input, s.ctx({ now: minutes(1) })), label).toMatchObject({ ok: false, reason: "invalid" });
    expect(await prospectRow(s.prospectId)).toMatchObject({ messages_used: 0, message_seq: 0 });
    expect(await count("demo_messages", "prospect_id = $1", [s.prospectId])).toBe(0);
    // Exactly the longest message is fine, and control characters do not reach the stored text.
    const BEL = String.fromCharCode(7);
    const ok = reservedOf(await reserve(s, `${"y".repeat(998)}${BEL}ok`, { at: minutes(2) }));
    expect(ok.text).toHaveLength(1000);
    expect(ok.text.includes(BEL)).toBe(false);
  });

  it("needs a session, and a made-up or ended session counts nothing", async () => {
    const s = await startDemo({}, T0);
    expect(await reserveDemoMessage({ text: "hi", clientMessageId: messageId() }, { ip: s.ip, now: minutes(1) })).toMatchObject({ ok: false, reason: "no_session" });
    expect(await reserveDemoMessage({ text: "hi", clientMessageId: messageId() }, { ip: s.ip, sessionToken: "B".repeat(43), now: minutes(1) })).toMatchObject({ ok: false, reason: "no_session" });
    const blocked = await startDemo({}, T0);
    await blockProspect(people.superAdmin, blocked.prospectId, "Seen abusing the demo chat", minutes(1));
    expect(await reserve(blocked, "hi", { at: minutes(2) })).toMatchObject({ ok: false, reason: "no_session" });
    expect(await prospectRow(blocked.prospectId)).toMatchObject({ messages_used: 0 });
  });

  it("refuses everything while the AI chat is off, except giving back what was already said", async () => {
    const s = await startDemo({}, T0);
    const id = messageId();
    reservedOf(await reserve(s, "Before it was switched off", { id, at: minutes(1) }));
    await openDemo(people.superAdmin, { aiEnabled: false });
    try {
      expect(await reserve(s, "After", { at: minutes(2) })).toMatchObject({ ok: false, reason: "ai_off", message: "The AI chat is not available right now. The guided tour shows what the AI team does, with sample data." });
      expect(await reserve(s, "Before it was switched off", { id, at: minutes(3) })).toMatchObject({ ok: true, kind: "duplicate" });
      expect((await prospectRow(s.prospectId)).messages_used).toBe(1);
    } finally {
      await openDemo(people.superAdmin, { aiEnabled: true });
    }
  });

  it("answers 'unavailable' for the whole chat while the emergency stop or the deployment switch says so", async () => {
    const s = await startDemo({}, T0);
    demoEnv({ DEMO_PUBLIC_DISABLED: "true" });
    expect(await reserve(s, "hi", { at: minutes(1) })).toMatchObject({ ok: false, reason: "unavailable", retryAfterSeconds: 300 });
    demoEnv({ DEMO_ENABLED: undefined });
    expect(await reserve(s, "hi", { at: minutes(1) })).toMatchObject({ ok: false, reason: "unavailable" });
    demoEnv();
    expect((await prospectRow(s.prospectId)).messages_used).toBe(0);
  });

  it("holds a session to six messages a minute", async () => {
    messagePace("real");
    await openDemo(people.superAdmin, { messageLimit: 100 });
    try {
      const burst = await startDemo({}, T0);
      const answers = [];
      // Fourteen at once-ish: at most twelve can pass even when the minute turns over in the middle of the run.
      for (let i = 0; i < 14; i += 1) answers.push(await reserve(burst, `Burst ${i}`, { at: minutes(1) }));
      const passed = answers.filter((a) => a.ok).length;
      expect(passed).toBeGreaterThanOrEqual(6);
      expect(passed).toBeLessThanOrEqual(12);
      const slowed = answers.filter((a) => !a.ok && a.reason === "rate_limited");
      expect(slowed.length).toBe(14 - passed);
      expect(slowed.every((a) => !a.ok && (a.retryAfterSeconds ?? 0) > 0)).toBe(true);
      expect((await prospectRow(burst.prospectId)).messages_used).toBe(passed);
    } finally {
      messagePace("relaxed");
      await openDemo(people.superAdmin, { messageLimit: 10 });
    }
  });
});

describe("the platform's daily budget", () => {
  it("refuses the message that would pass it, counts it as refused, tells the team once, and leaves the prospect's count alone", async () => {
    const day = new Date("2027-01-10T20:00:00Z");
    await openDemo(people.superAdmin, { dailyMessageCap: 2 });
    try {
      const a = await startDemo({}, day);
      const b = await startDemo({}, day);
      expect(await reserve(a, "one", { at: day })).toMatchObject({ ok: true });
      expect(await reserve(b, "two", { at: day })).toMatchObject({ ok: true });
      for (const s of [a, b, a]) expect(await reserve(s, "three", { at: day }), "past the budget").toMatchObject({ ok: false, reason: "daily_cap", message: "The demo chat has reached its limit for today. Please try again tomorrow, or ask for a consultation." });
      const usage = (await rows<{ messages: number; blocked: number }>("select messages, blocked from demo_usage_days where day = '2027-01-10'"))[0];
      expect(usage).toEqual({ messages: 2, blocked: 3 });
      expect((await prospectRow(a.prospectId)).messages_used).toBe(1);
      expect(await count("demo_messages", "prospect_id = $1", [a.prospectId])).toBe(1);
      const notes = await rows<{ user_id: string }>("select user_id from notifications where kind = 'demo_budget_reached' and dedupe_key = $1", ["demo-budget:2027-01-10"]);
      expect(notes.filter((n) => n.user_id === people.superAdmin.id)).toHaveLength(1);
      expect(notes.filter((n) => n.user_id === people.manager.id)).toHaveLength(1);
      expect(notes.some((n) => n.user_id === people.staff.id)).toBe(false);
      // The next day starts fresh.
      expect(await reserve(a, "tomorrow", { at: new Date(day.getTime() + 6 * 3_600_000) })).toMatchObject({ ok: true });
    } finally {
      await openDemo(people.superAdmin, { dailyMessageCap: 10_000 });
    }
  });

  it("stops the chat altogether when the daily budget is zero", async () => {
    const s = await startDemo({}, T0);
    await openDemo(people.superAdmin, { dailyMessageCap: 0 });
    try {
      expect(await reserve(s, "hi", { at: minutes(1) })).toMatchObject({ ok: false, reason: "daily_cap" });
    } finally {
      await openDemo(people.superAdmin, { dailyMessageCap: 10_000 });
    }
  });

  it("is taken from and given back to the day the message was made, and kept when the model was already asked", async () => {
    const day = new Date("2027-02-03T22:30:00Z");
    const s = await startDemo({}, day);
    const before = async () => Number((await rows<{ messages: number }>("select coalesce((select messages from demo_usage_days where day = '2027-02-03'), 0) as messages"))[0].messages);
    const start = await before();
    const one = reservedOf(await reserve(s, "first", { at: day }));
    const two = reservedOf(await reserve(s, "second", { at: day }));
    expect(await before()).toBe(start + 2);
    // Released the next morning: the unit goes back to the day it was taken from, not to today.
    expect(await releaseDemoMessage({ prospectId: s.prospectId, messageId: one.messageId, reason: "provider_failed", now: new Date("2027-02-04T01:00:00Z") })).toMatchObject({ ok: true });
    expect(await before()).toBe(start + 1);
    expect(await releaseDemoMessage({ prospectId: s.prospectId, messageId: two.messageId, reason: "reply_blocked", spent: true, now: day })).toMatchObject({ ok: true });
    expect(await before()).toBe(start + 1);
  });
});

describe("when no answer comes", () => {
  it("gives the message back: failed, not counted, with the reason on the timeline, and the sequence never goes down", async () => {
    const s = await startDemo({}, T0);
    const r = reservedOf(await reserve(s, "Will fail", { at: minutes(1) }));
    expect(await releaseDemoMessage({ prospectId: s.prospectId, messageId: r.messageId, reason: "provider_failed", now: minutes(2) })).toEqual({ ok: true, messagesLeft: 10 });
    expect(await prospectRow(s.prospectId)).toMatchObject({ messages_used: 0, message_seq: 1 });
    expect((await rows("select state from demo_messages where id = $1::bigint", [r.messageId]))[0]).toEqual({ state: "failed" });
    expect((await rows<{ kind: string; detail: { reason: string } }>("select kind, detail from demo_events where prospect_id = $1 and kind = 'message_released'", [s.prospectId]))[0].detail).toEqual({ reason: "provider_failed" });
    // The next message takes the next number, not the one that was given back.
    expect(reservedOf(await reserve(s, "Second try", { at: minutes(3) })).seq).toBe(2);
    // Giving back twice, or something that was answered, does nothing.
    expect(await releaseDemoMessage({ prospectId: s.prospectId, messageId: r.messageId, reason: "provider_failed" })).toEqual({ ok: false, reason: "not_pending" });
    expect((await prospectRow(s.prospectId)).messages_used).toBe(1);
  });

  it("records an answer that was held back by a safety check as a held-back message, not a release", async () => {
    const s = await startDemo({}, T0);
    const r = reservedOf(await reserve(s, "Invent a price", { at: minutes(1) }));
    await releaseDemoMessage({ prospectId: s.prospectId, messageId: r.messageId, reason: "reply_blocked", spent: true });
    expect(await count("demo_events", "prospect_id = $1 and kind = 'message_blocked'", [s.prospectId])).toBe(1);
    expect(await count("demo_events", "prospect_id = $1 and kind = 'message_released'", [s.prospectId])).toBe(0);
  });

  it("does not store an answer twice, an empty answer, or one for a message that is not waiting", async () => {
    const s = await startDemo({}, T0);
    const r = reservedOf(await reserve(s, "Answer me", { at: minutes(1) }));
    expect(await completeDemoMessage({ prospectId: s.prospectId, messageId: r.messageId, reply: "   " })).toEqual({ ok: false, reason: "empty" });
    expect(await completeDemoMessage({ prospectId: s.prospectId, messageId: r.messageId, reply: "Here you go" })).toMatchObject({ ok: true });
    expect(await completeDemoMessage({ prospectId: s.prospectId, messageId: r.messageId, reply: "Again" })).toEqual({ ok: false, reason: "not_pending" });
    expect(await count("demo_messages", "prospect_id = $1 and role = 'assistant'", [s.prospectId])).toBe(1);
    // Another prospect's message cannot be answered through this prospect.
    const other = await startDemo({}, T0);
    const theirs = reservedOf(await reserve(other, "Mine", { at: minutes(1) }));
    expect(await completeDemoMessage({ prospectId: s.prospectId, messageId: theirs.messageId, reply: "Wrong person" })).toEqual({ ok: false, reason: "not_pending" });
    expect(await releaseDemoMessage({ prospectId: s.prospectId, messageId: theirs.messageId, reason: "timeout" })).toEqual({ ok: false, reason: "not_pending" });
  });

  it("is given back by the clean-up when the process that held it died, at five minutes and not before", async () => {
    const s = await startDemo({}, T0);
    const r = reservedOf(await reserve(s, "Stuck", { at: minutes(1) }));
    expect(await releaseStaleReservations(new Date(minutes(1).getTime() + 5 * 60_000 - 1))).toBe(0);
    expect(await prospectRow(s.prospectId)).toMatchObject({ messages_used: 1 });
    expect(await releaseStaleReservations(new Date(minutes(1).getTime() + 5 * 60_000))).toBeGreaterThanOrEqual(1);
    expect(await prospectRow(s.prospectId)).toMatchObject({ messages_used: 0 });
    expect((await rows("select state from demo_messages where id = $1::bigint", [r.messageId]))[0]).toEqual({ state: "failed" });
  });
});

describe("what a prospect with more time and messages can do", () => {
  it("can send past the original allowance after an extension, and the room shows the new count", async () => {
    const s = await startDemo({}, T0);
    for (let i = 0; i < 10; i += 1) await say(s, `Message ${i}`, { at: minutes(1 + i * 2) });
    expect(await reserve(s, "Eleventh", { at: minutes(30) })).toMatchObject({ ok: false, reason: "limit_reached" });
    await extendDemo(people.superAdmin, s.prospectId, { hours: 0, extraMessages: 5, reason: "Asked for more time on a call" }, minutes(31));
    expect(await reserve(s, "Eleventh", { at: minutes(32) })).toMatchObject({ ok: true, kind: "reserved", messagesLeft: 4 });
    const room = await getRoom(s.ctx({ now: minutes(33) }));
    expect(room).toMatchObject({ ok: true, room: { messagesLeft: 4, messageAllowance: 15, extended: true } });
  });

  it("cannot be counted past the allowance by the database either, whatever the code does", async () => {
    const s = await startDemo({}, T0);
    await expect(rows("update demo_prospects set messages_used = 11 where id = $1", [s.prospectId])).rejects.toThrow(/check/i);
    await expect(rows("update demo_prospects set messages_used = -1 where id = $1", [s.prospectId])).rejects.toThrow(/check/i);
  });
});
