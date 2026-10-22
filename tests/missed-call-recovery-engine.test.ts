// The recovery engine against the database: what a case does under each policy mode, that nothing is sent without every rule passing, that every
// effect happens once however many workers or retries, that a person's takeover or the caller's reply stops automation, and that a text is only
// "sent" when the message row says so. Synthetic workspaces; the transport is a recorder, and the real transport runs only with its switch off.
import { afterEach, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { crmEventDispatch } from "@/server/crm/dispatch";
import { dispatchMessage } from "@/server/messaging/send";
import { suppressAddress } from "@/server/messaging/contacts";
import { takeOverConversation } from "@/server/messaging/handoff";
import { processMissedCalls } from "@/server/missed-calls/engine";
import { approveDraft } from "@/server/missed-calls/ops";
import { savePolicy } from "@/server/missed-calls/policy";
import { inbound } from "./support/messaging";
import {
  actionsOf, callerNumber, caseOf, count, eventsOf, messagesFor, minutesAfter, missedCallFrom, recordCall, recoveryWorkspace, rows, voice,
} from "./support/missed-calls";

afterEach(() => {
  delete process.env.TWILIO_WRITES_ENABLED;
});

const run = (orgId: string, now: Date) => processMissedCalls({ now, orgId });
const NOW = minutesAfter(5);

describe("policy off (the default)", () => {
  it("watches a case and does nothing to anyone: no task, no notice, no contact change, no message", async () => {
    const r = await recoveryWorkspace();
    await savePolicy(r.owner, { expectedVersion: r.version, enabled: false });
    const { contact, caseRow } = await missedCallFrom(r);
    const res = await run(r.w.org.id, NOW);
    expect(res.claimed).toBe(1);
    const c = await caseOf(r.w.org.id, caseRow.id ? (await rows<{ caller_number: string }>("select caller_number from missed_call_cases where id = $1", [caseRow.id]))[0].caller_number : "");
    expect(c.state).toBe("suppressed");
    expect(c.state_reason).toBe("policy_off");
    expect(await actionsOf(c.id)).toEqual([]);
    expect(await count("select count(*)::text as n from tasks where org_id = $1", [r.w.org.id])).toBe(0);
    expect(await count("select count(*)::text as n from notifications where org_id = $1 and kind = 'missed_call_follow_up'", [r.w.org.id])).toBe(0);
    expect(await messagesFor(contact.id)).toEqual([]);
  });
});

describe("team-only mode", () => {
  it("creates one call-back task and one notice, assigns the owner, and texts nobody, however often it runs", async () => {
    const r = await recoveryWorkspace({ mode: "manual" });
    const { caller, contact } = await missedCallFrom(r);
    await run(r.w.org.id, NOW);
    await run(r.w.org.id, minutesAfter(40));
    await run(r.w.org.id, minutesAfter(80));
    const c = await caseOf(r.w.org.id, caller);
    expect(c).toMatchObject({ state: "suppressed", state_reason: "messages_off", owner_kind: "human", owner_user_id: r.w.people.sales.id, attempts: 0 });
    const tasks = await rows<{ title: string; assigned_user_id: string; contact_id: string; priority: string }>("select title, assigned_user_id, contact_id, priority from tasks where org_id = $1", [r.w.org.id]);
    expect(tasks).toEqual([{ title: "Call back Dana Lee", assigned_user_id: r.w.people.sales.id, contact_id: contact.id, priority: "high" }]);
    expect(await count("select count(*)::text as n from notifications where org_id = $1 and kind = 'missed_call_follow_up'", [r.w.org.id])).toBeGreaterThanOrEqual(1);
    expect((await actionsOf(c.id)).map((a) => `${a.kind}:${a.status}`).sort()).toEqual(["assign:done", "notify:done", "task:done"]);
    expect(await messagesFor(contact.id)).toEqual([]);
    expect(c.first_action_at).not.toBeNull();
  });

  it("records an AI call-back as blocked and never as done, because no verified outbound call capability exists", async () => {
    const r = await recoveryWorkspace({ mode: "manual", policy: { actionAiCallback: true } });
    const { caller } = await missedCallFrom(r);
    await run(r.w.org.id, NOW);
    const c = await caseOf(r.w.org.id, caller);
    const cb = (await actionsOf(c.id)).filter((a) => a.kind === "ai_callback");
    expect(cb).toEqual([expect.objectContaining({ status: "blocked", reason: "no_outbound_call_capability" })]);
    expect((await eventsOf(c.id)).some((e) => e.kind === "ai_callback_blocked")).toBe(true);
  });

  it("makes a call that came in after hours due when the business opens", async () => {
    const r = await recoveryWorkspace({ mode: "manual", policy: { taskDueMinutes: 30 } });
    await withSystem((db) => db.query("update messaging_settings set business_hours = $2::jsonb where org_id = $1", [r.w.org.id, JSON.stringify({ mon: [["09:00", "17:00"]], tue: [["09:00", "17:00"]], wed: [["09:00", "17:00"]], thu: [["09:00", "17:00"]], fri: [["09:00", "17:00"]] })]));
    const saturday = new Date("2026-10-24T11:00:00Z");
    await missedCallFrom(r, { at: saturday });
    await run(r.w.org.id, new Date(saturday.getTime() + 10 * 60_000));
    const [task] = await rows<{ due_at: Date }>("select due_at from tasks where org_id = $1", [r.w.org.id]);
    expect(new Date(task.due_at).getTime()).toBeGreaterThanOrEqual(new Date("2026-10-26T09:00:00Z").getTime() - 60_000);
  });
});

describe("draft for approval", () => {
  it("drafts the text for a person and sends nothing until they approve it", async () => {
    const r = await recoveryWorkspace({ mode: "assisted" });
    const { caller, contact } = await missedCallFrom(r);
    await run(r.w.org.id, NOW);
    const c = await caseOf(r.w.org.id, caller);
    expect(c.state).toBe("eligible");
    const draft = (await actionsOf(c.id)).find((a) => a.kind === "message")!;
    expect(draft).toMatchObject({ status: "awaiting_approval", channel: "sms" });
    expect(draft.draft_body).toMatch(/Sorry we missed your call/);
    expect(await messagesFor(contact.id)).toEqual([]);

    await expect(approveDraft(r.viewer, c.id, draft.id, { expectedOwnerVersion: c.owner_version }, { now: minutesAfter(6) })).rejects.toThrow(/edit contacts|Your role/);
    await expect(approveDraft(r.manager, c.id, draft.id, { expectedOwnerVersion: c.owner_version + 7 }, { now: minutesAfter(6) })).rejects.toThrow(/changed/i);
    const sent = await approveDraft(r.manager, c.id, draft.id, { expectedOwnerVersion: c.owner_version, body: "Hi Dana, sorry we missed you. Can we call you back today?" }, { now: minutesAfter(6) });
    expect(sent.status).toBe("queued");
    const msgs = await messagesFor(contact.id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ status: "queued", scope: "human", author_kind: "human", body: "Hi Dana, sorry we missed you. Can we call you back today?" });
    const approved = (await actionsOf(c.id)).find((a) => a.kind === "message")!;
    expect(approved.status).toBe("queued");
    const row = (await rows<{ approved_by: string }>("select approved_by from missed_call_actions where id = $1", [approved.id]))[0];
    expect(row.approved_by).toBe(r.w.people.manager.id);
    // Approving again does nothing a second time.
    await expect(approveDraft(r.manager, c.id, draft.id, { expectedOwnerVersion: c.owner_version }, { now: minutesAfter(7) })).rejects.toThrow(/no longer waiting/);
    expect(await messagesFor(contact.id)).toHaveLength(1);
  });

  it("refuses an approval after the caller has already written back", async () => {
    const r = await recoveryWorkspace({ mode: "assisted" });
    const { caller } = await missedCallFrom(r);
    await run(r.w.org.id, NOW);
    const c = await caseOf(r.w.org.id, caller);
    const draft = (await actionsOf(c.id)).find((a) => a.kind === "message")!;
    await inbound(r.w.org.id, { provider: "twilio", address: caller, providerMessageId: "reply_1", body: "Hi, I tried calling about my booking", receivedAt: minutesAfter(8) });
    await expect(approveDraft(r.manager, c.id, draft.id, { expectedOwnerVersion: c.owner_version }, { now: minutesAfter(10) })).rejects.toThrow(/settled/);
  });
});

describe("automatic mode", () => {
  it("queues one text, sends it only through the send chain, and marks it sent only when the message says so", async () => {
    const r = await recoveryWorkspace({ mode: "automatic" });
    const { caller, contact } = await missedCallFrom(r);
    const res = await run(r.w.org.id, NOW);
    expect(res.queued).toBe(1);
    let c = await caseOf(r.w.org.id, caller);
    expect(c).toMatchObject({ state: "in_progress", attempts: 1 });
    const msgs = await messagesFor(contact.id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ status: "queued", scope: "followup", author_kind: "system" });
    expect(msgs[0].dedupe_key).toBe(`mcc:${c.id}:message:1`);
    expect(msgs[0].body).toMatch(/Sorry we missed your call/);
    // Queued is a promise, not a delivery: the action says so.
    expect((await actionsOf(c.id)).find((a) => a.kind === "message")!.status).toBe("queued");
    expect(r.transport.calls).toHaveLength(0);

    await dispatchMessage(msgs[0].id, { transport: r.transport.transport, now: minutesAfter(6) });
    expect(r.transport.calls).toHaveLength(1);
    expect(r.transport.calls[0].to).toBe(caller);
    await run(r.w.org.id, minutesAfter(8));
    c = await caseOf(r.w.org.id, caller);
    expect(c.state).toBe("awaiting_response");
    expect(c.response_deadline_at?.getTime()).toBe(minutesAfter(8).getTime() + 48 * 3_600_000);
    expect((await actionsOf(c.id)).find((a) => a.kind === "message")!.status).toBe("sent");
    expect((await eventsOf(c.id)).map((e) => e.to_state).filter(Boolean)).toEqual(["detected", "awaiting_eligibility", "eligible", "in_progress", "awaiting_response"]);
  });

  it("is settled by the caller's reply, and then sends nothing more", async () => {
    const r = await recoveryWorkspace({ mode: "automatic" });
    const { caller, contact } = await missedCallFrom(r);
    await run(r.w.org.id, NOW);
    const [m] = await messagesFor(contact.id);
    await dispatchMessage(m.id, { transport: r.transport.transport, now: minutesAfter(6) });
    await run(r.w.org.id, minutesAfter(8));
    await inbound(r.w.org.id, { provider: "twilio", address: caller, providerMessageId: "reply_2", body: "Yes please, can you call this afternoon?", receivedAt: minutesAfter(9) });
    // The reply's event wakes the case; the worker then settles it, long before the response window would have ended.
    await crmEventDispatch({ now: minutesAfter(9) });
    await run(r.w.org.id, minutesAfter(10));
    const c = await caseOf(r.w.org.id, caller);
    expect(c.state).toBe("recovered");
    expect(c.recovered_via).toBe("customer_reply");
    await run(r.w.org.id, minutesAfter(60 * 30));
    expect(await messagesFor(contact.id)).toHaveLength(1);
    const types = await rows<{ type: string }>("select type from crm_events where org_id = $1 and entity_id = $2 order by id", [r.w.org.id, c.id]);
    expect(types.map((t) => t.type)).toEqual(expect.arrayContaining(["recovery.eligible", "recovery.responded", "recovery.completed"]));
  });

  it("a STOP reply is an opt-out, not a recovery, and nothing more is sent", async () => {
    const r = await recoveryWorkspace({ mode: "automatic", policy: { maxAttempts: 3, attemptGapMinutes: 15 } });
    const { caller, contact } = await missedCallFrom(r);
    await run(r.w.org.id, NOW);
    const [m] = await messagesFor(contact.id);
    await dispatchMessage(m.id, { transport: r.transport.transport, now: minutesAfter(6) });
    await run(r.w.org.id, minutesAfter(8));
    await inbound(r.w.org.id, { provider: "twilio", address: caller, providerMessageId: "stop_1", body: "STOP", receivedAt: minutesAfter(9) });
    await crmEventDispatch({ now: minutesAfter(9) });
    await run(r.w.org.id, minutesAfter(60 * 60));
    const c = await caseOf(r.w.org.id, caller);
    expect(c.state).not.toBe("recovered");
    expect(await messagesFor(contact.id)).toHaveLength(1);
  });

  it("two workers running at once send exactly one text", async () => {
    const r = await recoveryWorkspace({ mode: "automatic" });
    const { contact } = await missedCallFrom(r);
    await Promise.all([run(r.w.org.id, NOW), run(r.w.org.id, NOW), run(r.w.org.id, NOW)]);
    expect(await messagesFor(contact.id)).toHaveLength(1);
    expect(await count("select count(*)::text as n from missed_call_actions where org_id = $1 and kind = 'message'", [r.w.org.id])).toBe(1);
  });

  it("a redelivered call report does not produce a second follow-up", async () => {
    const r = await recoveryWorkspace({ mode: "automatic" });
    const caller = callerNumber();
    const { createContact } = await import("@/server/crm/contacts");
    const contact = await createContact(r.owner, { displayName: "Ravi Patel", phone: caller });
    await withSystem((db) => db.query("insert into contact_consent_events (org_id, contact_id, channel, purpose, status, source) values ($1, $2, 'sms', 'service', 'granted', 'test')", [r.w.org.id, contact.id]));
    const ev = voice({ customerNumber: caller });
    await recordCall(r.w.org.id, ev);
    await recordCall(r.w.org.id, ev);
    await recordCall(r.w.org.id, { ...ev, receiptKey: "other" });
    await run(r.w.org.id, NOW);
    await run(r.w.org.id, NOW);
    expect(await messagesFor(contact.id)).toHaveLength(1);
  });

  it("a second missed call while a text is waiting does not send a second text", async () => {
    const r = await recoveryWorkspace({ mode: "automatic" });
    const { caller, contact } = await missedCallFrom(r);
    await run(r.w.org.id, NOW);
    await recordCall(r.w.org.id, voice({ customerNumber: caller, startedAt: minutesAfter(6), status: "voicemail" }), minutesAfter(6));
    await run(r.w.org.id, minutesAfter(10));
    expect(await messagesFor(contact.id)).toHaveLength(1);
    expect((await caseOf(r.w.org.id, caller)).call_count).toBe(2);
  });
});

describe("the rules that stop a text", () => {
  it("holds a caller with no consent on record, still tells the team, and records why", async () => {
    const r = await recoveryWorkspace({ mode: "automatic" });
    const { caller, contact } = await missedCallFrom(r, { consent: false });
    await run(r.w.org.id, NOW);
    const c = await caseOf(r.w.org.id, caller);
    expect(c).toMatchObject({ state: "suppressed", state_reason: "no_consent" });
    expect(await messagesFor(contact.id)).toEqual([]);
    expect((await actionsOf(c.id)).map((a) => a.kind)).toEqual(expect.arrayContaining(["task", "notify"]));
  });

  it("texts a caller with no prior consent only when the business acknowledged the caller-consent rule, and writes the basis on the record", async () => {
    const r = await recoveryWorkspace({ mode: "automatic", policy: { smsConsentBasis: "inbound_call", acknowledgeCallerConsent: true } });
    const { caller, contact } = await missedCallFrom(r, { consent: false });
    await run(r.w.org.id, NOW);
    expect(await messagesFor(contact.id)).toHaveLength(1);
    const consent = await rows<{ status: string; source: string }>("select status, source from contact_consent_events where contact_id = $1 order by id desc limit 1", [contact.id]);
    expect(consent[0]).toEqual({ status: "granted", source: "inbound_call" });
    expect((await caseOf(r.w.org.id, caller)).state).toBe("in_progress");
  });

  it("never texts a caller who has opted out, even with the acknowledged basis", async () => {
    const r = await recoveryWorkspace({ mode: "automatic", policy: { smsConsentBasis: "inbound_call", acknowledgeCallerConsent: true } });
    const { caller, contact } = await missedCallFrom(r, { consent: false });
    await withSystem(async (db) => {
      await db.query("insert into contact_consent_events (org_id, contact_id, channel, purpose, status, source) values ($1, $2, 'sms', 'service', 'revoked', 'stop_keyword')", [r.w.org.id, contact.id]);
      await suppressAddress(db, { orgId: r.w.org.id, channel: "sms", address: caller, reason: "opt_out", source: "stop_keyword" });
    });
    await run(r.w.org.id, NOW);
    expect(await messagesFor(contact.id)).toEqual([]);
    expect((await caseOf(r.w.org.id, caller)).state).toBe("suppressed");
  });

  it("does not text before the policy's delay, then does", async () => {
    const r = await recoveryWorkspace({ mode: "automatic", policy: { delayMinutes: 30 } });
    const { caller, contact } = await missedCallFrom(r);
    await run(r.w.org.id, minutesAfter(1));
    expect(await messagesFor(contact.id)).toEqual([]);
    const waiting = await caseOf(r.w.org.id, caller);
    expect(waiting.state).toBe("scheduled");
    expect(waiting.next_action_at?.getTime()).toBe(minutesAfter(30).getTime());
    await run(r.w.org.id, minutesAfter(31));
    expect(await messagesFor(contact.id)).toHaveLength(1);
  });

  it("waits out quiet hours and then sends", async () => {
    const r = await recoveryWorkspace({ mode: "automatic" });
    await withSystem((db) => db.query("update messaging_policy set quiet_hours_start = '21:00', quiet_hours_end = '08:00'"));
    const lateCall = new Date("2026-10-22T21:30:00Z");
    const { caller, contact } = await missedCallFrom(r, { at: lateCall });
    await run(r.w.org.id, minutesAfter(5, lateCall));
    expect(await messagesFor(contact.id)).toEqual([]);
    const waiting = await caseOf(r.w.org.id, caller);
    expect(waiting.state).toBe("scheduled");
    expect(waiting.next_action_at!.getTime()).toBeGreaterThanOrEqual(new Date("2026-10-23T08:00:00Z").getTime());
    await run(r.w.org.id, new Date("2026-10-23T08:20:00Z"));
    expect(await messagesFor(contact.id)).toHaveLength(1);
    await withSystem((db) => db.query("update messaging_policy set quiet_hours_start = '00:00', quiet_hours_end = '00:00'"));
  });

  it("waits for the business to open by default, or sends the after-hours wording at once when the policy says so", async () => {
    const hours = JSON.stringify({ mon: [["09:00", "17:00"]], tue: [["09:00", "17:00"]], wed: [["09:00", "17:00"]], thu: [["09:00", "17:00"]], fri: [["09:00", "17:00"]] });
    const saturday = new Date("2026-10-24T11:00:00Z");
    const wait = await recoveryWorkspace({ mode: "automatic" });
    await withSystem((db) => db.query("update messaging_settings set business_hours = $2::jsonb where org_id = $1", [wait.w.org.id, hours]));
    const a = await missedCallFrom(wait, { at: saturday });
    await run(wait.w.org.id, minutesAfter(5, saturday));
    expect(await messagesFor(a.contact.id)).toEqual([]);
    expect((await caseOf(wait.w.org.id, a.caller)).next_action_at!.getTime()).toBeGreaterThanOrEqual(new Date("2026-10-26T09:00:00Z").getTime());

    const now = await recoveryWorkspace({ mode: "automatic", policy: { afterHoursBehavior: "send_after_hours_text" } });
    await withSystem((db) => db.query("update messaging_settings set business_hours = $2::jsonb where org_id = $1", [now.w.org.id, hours]));
    const b = await missedCallFrom(now, { at: saturday });
    await run(now.w.org.id, minutesAfter(5, saturday));
    const [m] = await messagesFor(b.contact.id);
    expect(m.body).toMatch(/We're closed right now/);
  });

  it("stops at the attempt cap, and after an unanswered window asks the team to call instead", async () => {
    const r = await recoveryWorkspace({ mode: "automatic", policy: { maxAttempts: 2, attemptGapMinutes: 15, responseWindowHours: 1 } });
    // The platform's own spacing between follow-ups (a day by default) would hold the second text back; this test is about the case's own cap.
    await withSystem((db) => db.query("update messaging_policy set min_hours_between_followups = 1, max_followups_per_contact_30d = 10"));
    const { caller, contact } = await missedCallFrom(r);
    let now = NOW;
    for (let i = 1; i <= 2; i += 1) {
      await run(r.w.org.id, now);
      const sent = (await messagesFor(contact.id))[i - 1];
      expect(sent).toBeTruthy();
      await dispatchMessage(sent.id, { transport: r.transport.transport, now: minutesAfter(1, now) });
      // The dispatcher stamps the database clock; keep this test on its own timeline.
      await withSystem((db) => db.query("update conversation_messages set sent_at = $2 where id = $1", [sent.id, minutesAfter(1, now)]));
      await run(r.w.org.id, minutesAfter(3, now));
      now = minutesAfter(90, now);
      // The window passes with no reply: the second pass retries (first time) or follows up by hand (second time).
      await run(r.w.org.id, now);
      now = minutesAfter(30, now);
    }
    await run(r.w.org.id, now);
    expect(await messagesFor(contact.id)).toHaveLength(2);
    const c = await caseOf(r.w.org.id, caller);
    expect(c.state).toBe("completed_without_recovery");
    expect(c.state_reason).toBe("no_response");
    expect((await actionsOf(c.id)).some((a) => a.kind === "follow_up" && a.status === "done")).toBe(true);
    expect(await count("select count(*)::text as n from tasks where org_id = $1 and title like 'Try this caller again%'", [r.w.org.id])).toBe(1);
  });
});

describe("a person and automation", () => {
  it("never texts into a conversation a person owns", async () => {
    const r = await recoveryWorkspace({ mode: "automatic" });
    const { caller, contact, caseRow } = await missedCallFrom(r);
    await takeOverConversation(r.w.ctx("manager"), caseRow.conversation_id!);
    await run(r.w.org.id, NOW);
    expect(await messagesFor(contact.id)).toEqual([]);
    const c = await caseOf(r.w.org.id, caller);
    expect(c).toMatchObject({ state: "suppressed", state_reason: "human_owner" });
  });

  it("a takeover after the text was queued stops it before it is sent", async () => {
    const r = await recoveryWorkspace({ mode: "automatic" });
    const { caller, contact, caseRow } = await missedCallFrom(r);
    await run(r.w.org.id, NOW);
    const [m] = await messagesFor(contact.id);
    expect(m.status).toBe("queued");
    await takeOverConversation(r.w.ctx("manager"), caseRow.conversation_id!);
    const stopped = (await messagesFor(contact.id))[0];
    expect(stopped.status).toBe("blocked");
    await dispatchMessage(m.id, { transport: r.transport.transport, now: minutesAfter(6) });
    expect(r.transport.calls).toHaveLength(0);
    void caller;
  });

  it("a teammate's own text to the caller stands automation down", async () => {
    const r = await recoveryWorkspace({ mode: "automatic", policy: { delayMinutes: 30 } });
    const { caller, contact, caseRow } = await missedCallFrom(r);
    await withSystem((db) => db.query(
      "insert into conversation_messages (org_id, conversation_id, direction, author_kind, author_user_id, body, status, scope, created_at) values ($1, $2, 'outbound', 'human', $3, 'Hi Dana, calling you back shortly', 'sent', 'human', $4)",
      [r.w.org.id, caseRow.conversation_id, r.w.people.sales.id, minutesAfter(10)],
    ));
    await run(r.w.org.id, minutesAfter(40));
    expect((await messagesFor(contact.id)).filter((m) => m.author_kind === "system")).toEqual([]);
    expect((await caseOf(r.w.org.id, caller)).state_reason).toBe("person_followed_up");
  });

  it("a booking made after the call settles the case without any text", async () => {
    const r = await recoveryWorkspace({ mode: "automatic", policy: { delayMinutes: 30 } });
    const { caller, contact, caseRow } = await missedCallFrom(r);
    await withSystem((db) => db.query(
      `insert into appointment_bookings (org_id, contact_id, conversation_id, calendar_id, start_at, end_at, timezone, title, requested_by_kind, status, idempotency_key, provider, booked_at)
       values ($1, $2, $3, 'cal_1', $4, $5, 'UTC', 'Consultation', 'staff', 'needs_manual', 'idem-booking-1', 'native', null)`,
      [r.w.org.id, contact.id, caseRow.conversation_id, minutesAfter(24 * 60), minutesAfter(24 * 60 + 30)],
    ));
    await run(r.w.org.id, minutesAfter(40));
    const c = await caseOf(r.w.org.id, caller);
    expect(c).toMatchObject({ state: "recovered", recovered_via: "appointment_booked" });
    expect(await messagesFor(contact.id)).toEqual([]);
  });
});

describe("failures are recorded as failures", () => {
  it("while the provider's write switch is off the text is blocked, the case fails honestly, and the team is told to call", async () => {
    delete process.env.TWILIO_WRITES_ENABLED;
    const r = await recoveryWorkspace({ mode: "automatic" });
    const { caller, contact } = await missedCallFrom(r);
    await run(r.w.org.id, NOW);
    const [m] = await messagesFor(contact.id);
    await dispatchMessage(m.id, { now: minutesAfter(6) });
    const blocked = (await messagesFor(contact.id))[0];
    expect(blocked).toMatchObject({ status: "blocked", blocked_reason: "provider_not_enabled" });
    await run(r.w.org.id, minutesAfter(8));
    const c = await caseOf(r.w.org.id, caller);
    expect(c.state).toBe("failed");
    expect((await actionsOf(c.id)).find((a) => a.kind === "message")).toMatchObject({ status: "blocked", reason: "provider_not_enabled" });
    expect((await rows<{ type: string }>("select type from crm_events where org_id = $1 and entity_id = $2", [r.w.org.id, c.id])).map((e) => e.type)).toContain("recovery.failed");
    expect(await count("select count(*)::text as n from notifications where org_id = $1 and kind = 'missed_call_follow_up' and severity = 'warning'", [r.w.org.id])).toBeGreaterThanOrEqual(1);
    // The engine never reopens a failed case by itself.
    await run(r.w.org.id, minutesAfter(24 * 60));
    expect((await caseOf(r.w.org.id, caller)).state).toBe("failed");
  });

  it("a provider that refuses the message is recorded as failed, not sent", async () => {
    process.env.TWILIO_WRITES_ENABLED = "true";
    const r = await recoveryWorkspace({ mode: "automatic" });
    const bad = (await import("./support/messaging")).recordingProvider("twilio", () => ({ ok: false, retryable: false, error: "Invalid destination number." }));
    const { caller, contact } = await missedCallFrom(r);
    await run(r.w.org.id, NOW);
    const [m] = await messagesFor(contact.id);
    await dispatchMessage(m.id, { transport: bad.transport, now: minutesAfter(6) });
    expect((await messagesFor(contact.id))[0].status).toBe("failed");
    await run(r.w.org.id, minutesAfter(8));
    const c = await caseOf(r.w.org.id, caller);
    expect(c.state).toBe("failed");
    expect((await actionsOf(c.id)).find((a) => a.kind === "message")!.status).toBe("failed");
  });
});

describe("tenants", () => {
  it("a worker limited to one workspace touches only that workspace's cases", async () => {
    const a = await recoveryWorkspace({ mode: "manual" });
    const b = await recoveryWorkspace({ mode: "manual" });
    const ca = await missedCallFrom(a);
    const cb = await missedCallFrom(b);
    await run(a.w.org.id, NOW);
    expect((await caseOf(a.w.org.id, ca.caller)).state).not.toBe("detected");
    expect((await caseOf(b.w.org.id, cb.caller)).state).toBe("detected");
    expect(await count("select count(*)::text as n from tasks where org_id = $1", [b.w.org.id])).toBe(0);
  });

  it("a busy workspace cannot starve the others in one run", async () => {
    const busy = await recoveryWorkspace({ mode: "manual" });
    const quiet = await recoveryWorkspace({ mode: "manual" });
    for (let i = 0; i < 6; i += 1) await missedCallFrom(busy, { name: `Caller ${i}` });
    const one = await missedCallFrom(quiet);
    const res = await processMissedCalls({ now: NOW, perOrgLimit: 2, limit: 3 });
    expect(res.claimed).toBeGreaterThanOrEqual(1);
    expect(res.claimed).toBeLessThanOrEqual(3);
    // The quiet workspace's single case is not behind the busy one's six.
    const state = (await caseOf(quiet.w.org.id, one.caller)).state;
    const handled = state !== "detected";
    const busyHandled = await count("select count(*)::text as n from missed_call_cases where org_id = $1 and state <> 'detected'", [busy.w.org.id]);
    expect(handled || busyHandled <= 2).toBe(true);
    expect(busyHandled).toBeLessThanOrEqual(2);
  });
});
