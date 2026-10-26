// Journey 3: a missed call becomes one recovery case, one recovery text, an honest failure when the provider refuses, and numbers that count exactly that.
//
// The call arrives through the existing voice-event intake, the recovery engine decides what may happen and when, the text leaves only through the one send chain
// every other message uses, and the analytics read the rows that exist. Nothing here is estimated: a queued message is not a delivery, and a refused message is a
// failure on the record.
//
// External boundaries, simulated here and only here:
//   * the phone system that reports the call: tests/support/missed-calls.ts voice() writes the end-of-call report by hand and recordCall feeds it to the real
//     intake; no call is made;
//   * the messaging provider: tests/support/messaging.ts recordingProvider records what the send chain asked it to send and answers the way a provider would
//     (an acceptance, or a refusal). TWILIO_WRITES_ENABLED is never set, so the real transport is never resolved.
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { dispatchMessage } from "@/server/messaging/send";
import { processMissedCalls } from "@/server/missed-calls/engine";
import { recoveryStats } from "@/server/missed-calls/analytics";
import { recordingProvider } from "../support/messaging";
import { actionsOf, caseOf, count, messagesFor, minutesAfter, missedCallFrom, recoveryWorkspace, rows } from "../support/missed-calls";

const run = (orgId: string, now: Date) => processMissedCalls({ now, orgId });

describe("a missed call is recovered through the one send chain", () => {
  it("waits out the policy delay, queues one text, sends it only through the send chain, records a provider refusal as a failure, and counts both", async () => {
    // The policy sends by itself, only after a 30-minute delay. Everything else is the fixture's: a contact who agreed to texts, and a call they made.
    const r = await recoveryWorkspace({ mode: "automatic", policy: { delayMinutes: 30 } });
    const orgId = r.w.org.id;
    const first = await missedCallFrom(r);

    // 1. The call became exactly one case, waiting for its delay. No text exists yet, and the case says when it will act.
    expect(first.caseRow.id).toBeTruthy();
    expect(await count("select count(*)::text as n from missed_call_cases where org_id = $1 and caller_number = $2", [orgId, first.caller])).toBe(1);
    await run(orgId, minutesAfter(1));
    expect(await messagesFor(first.contact.id)).toEqual([]);
    let c = await caseOf(orgId, first.caller);
    expect(c.state).toBe("scheduled");
    expect(c.next_action_at?.getTime()).toBe(minutesAfter(30).getTime());
    // Running again while it waits changes nothing: the delay is a rule, not an attempt.
    await run(orgId, minutesAfter(2));
    expect(await messagesFor(first.contact.id)).toEqual([]);

    // 2. Once the delay is over the engine queues one text. It is queued, not sent: the row is written by the send chain and the provider has not been asked.
    const queued = await run(orgId, minutesAfter(31));
    expect(queued.queued).toBe(1);
    const [message] = await messagesFor(first.contact.id);
    expect(message).toMatchObject({ status: "queued", scope: "followup", author_kind: "system" });
    expect(message.body).toMatch(/Sorry we missed your call/);
    expect(message.dedupe_key).toBe(`mcc:${first.caseRow.id}:message:1`);
    expect(r.transport.calls).toHaveLength(0);

    // 3. The dispatcher sends it through the provider stand-in. This is the only place the text leaves the machine in this journey.
    await dispatchMessage(message.id, { transport: r.transport.transport, now: minutesAfter(32) });
    expect(r.transport.calls).toHaveLength(1);
    expect(r.transport.calls[0]).toMatchObject({ to: first.caller });
    expect(r.transport.calls[0].body).toMatch(/Sorry we missed your call/);
    // The provider accepted it, so the record says so and the case now waits for the caller's answer.
    await run(orgId, minutesAfter(33));
    expect((await messagesFor(first.contact.id))[0].status).toBe("sent");
    c = await caseOf(orgId, first.caller);
    expect(c.state).toBe("awaiting_response");
    expect((await actionsOf(c.id)).find((a) => a.kind === "message")).toMatchObject({ status: "sent" });
    // A second engine pass does not produce a second case or a second text for the same call.
    await run(orgId, minutesAfter(34));
    expect(await messagesFor(first.contact.id)).toHaveLength(1);

    // 4. A second caller's provider refuses the text. The refusal is recorded as a failure of that message and of the case, never as a delivery, and the team is
    // told to call instead. The failing answer is the stand-in's, standing in for the provider's own reply.
    const second = await missedCallFrom(r, { name: "Refused Rita" });
    await run(orgId, minutesAfter(40));
    const [secondMessage] = await messagesFor(second.contact.id);
    expect(secondMessage.status).toBe("queued");
    const refusing = recordingProvider("twilio", () => ({ ok: false, retryable: false, error: "Invalid destination number." }));
    await dispatchMessage(secondMessage.id, { transport: refusing.transport, now: minutesAfter(41) });
    expect(refusing.calls).toHaveLength(1);
    expect((await messagesFor(second.contact.id))[0]).toMatchObject({ status: "failed" });
    await run(orgId, minutesAfter(42));
    const failed = await caseOf(orgId, second.caller);
    expect(failed.state).toBe("failed");
    expect((await actionsOf(failed.id)).find((a) => a.kind === "message")!.status).toBe("failed");
    expect((await rows<{ type: string }>("select type from crm_events where org_id = $1 and entity_id = $2 order by id", [orgId, failed.id])).map((e) => e.type)).toContain("recovery.failed");
    expect(await count("select count(*)::text as n from notifications where org_id = $1 and kind = 'missed_call_follow_up' and severity = 'warning'", [orgId])).toBeGreaterThanOrEqual(1);
    // The engine never reopens a failed case by itself.
    await run(orgId, minutesAfter(43));
    expect((await caseOf(orgId, second.caller)).state).toBe("failed");

    // 5. The analytics are counts of these rows, not estimates. The report reads its own period from the clock (7, 30 or 90 days back), so 30 days is asked
    // for: the fixture's call timeline is fixed and the records are stamped then.
    const stats = await recoveryStats(r.owner, 30);
    expect(stats.calls).toMatchObject({ inbound: 2, missed: 2, answered: 0 });
    expect(stats.cases).toMatchObject({ total: 2, open: 1, failed: 1, recovered: 0 });
    expect(stats.funnel).toMatchObject({ eligible: 2, attempts: 2, contacted: 1, failed: 1, recovered: 0 });
    // Nothing was recovered yet, and of the one text that reached the provider none came back: zero is the honest answer, not an absent one.
    expect(stats.rates).toEqual({ recoveryRate: 0, responseRate: 0 });
    expect(stats.speed.casesWithAnAction).toBe(2);
    expect(stats.speed.medianMinutesToFirstAction).not.toBeNull();
    // No money is invented for these calls.
    expect(stats.association).toMatchObject({ wonDeals: 0, wonValueByCurrency: [] });
  });

  it("holds a text for a call that came in during quiet hours, and sends it when they end", async () => {
    // The delay is not the only rule between a call and a text: quiet hours stop it too. This workspace is its own (the policy table is shared by the test
    // database), so the numbers in the journey above are untouched by it.
    const r = await recoveryWorkspace({ mode: "automatic" });
    await withSystem((db) => db.query("update messaging_policy set quiet_hours_start = '21:00', quiet_hours_end = '08:00'"));
    try {
      const lateCall = new Date("2026-10-22T21:30:00Z");
      const { caller, contact } = await missedCallFrom(r, { at: lateCall });
      // Five minutes after the call the delay has passed, but the workspace is closed: the case waits for the morning instead of texting at night.
      await run(r.w.org.id, minutesAfter(5, lateCall));
      expect(await messagesFor(contact.id)).toEqual([]);
      const waiting = await caseOf(r.w.org.id, caller);
      expect(waiting.state).toBe("scheduled");
      expect(waiting.next_action_at!.getTime()).toBeGreaterThanOrEqual(new Date("2026-10-23T08:00:00Z").getTime());

      // The next morning the same rule lets it through, and the text still only leaves when the send chain is run.
      await run(r.w.org.id, new Date("2026-10-23T08:20:00Z"));
      const [message] = await messagesFor(contact.id);
      expect(message.status).toBe("queued");
      expect(message.body).toMatch(/Sorry we missed your call/);
      expect(r.transport.calls).toHaveLength(0);
      await dispatchMessage(message.id, { transport: r.transport.transport, now: new Date("2026-10-23T08:21:00Z") });
      expect(r.transport.calls).toHaveLength(1);
      expect(r.transport.calls[0]).toMatchObject({ to: caller });
    } finally {
      // The shared policy goes back to how the fixtures leave it, so a later test does not inherit these hours.
      await withSystem((db) => db.query("update messaging_policy set quiet_hours_start = '00:00', quiet_hours_end = '00:00'"));
    }
  });
});
