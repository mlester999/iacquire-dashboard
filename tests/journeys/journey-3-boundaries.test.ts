// Journey 3, the edges: missed-call recovery, asked what journey 3 does not.
//   * denied access: a viewer can neither read a case nor assign, pause or close it, nor change the policy; a caller who never agreed to be texted is sent nothing;
//   * tenant isolation: the case, its actions and the text are invisible to a member of another workspace (row-level security, as the application role), and another workspace's
//     recovery numbers count none of it;
//   * duplicates and replays: the phone system reporting the same call twice and the engine running twice make one call, one case and one text;
//   * audit: what a person did to a case is on the case's history and in the audit log with their name, and the text that went out is on the record as sent by the system;
//   * what the caller is told: the wording of the text, and that nothing at all is sent to someone who did not agree.
// The phone system and the messaging provider are the stand-ins of tests/support/missed-calls.ts and tests/support/messaging.ts, as in journey 3.
import { describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { dispatchMessage } from "@/server/messaging/send";
import { processMissedCalls } from "@/server/missed-calls/engine";
import { recoveryStats } from "@/server/missed-calls/analytics";
import { assignCase, closeCase, getCase, pauseCase } from "@/server/missed-calls/ops";
import { activatePolicy, savePolicy } from "@/server/missed-calls/policy";
import { actionsOf, caseOf, count, eventsOf, messagesFor, minutesAfter, missedCallFrom, recordCall, recoveryWorkspace, rows, voice, T0 } from "../support/missed-calls";

const run = (orgId: string, now: Date) => processMissedCalls({ now, orgId });

describe("journey 3: who may act, who can see the case, and what a repeat does", () => {
  it("refuses a viewer the case and every action on it, and the policy, and the refused attempts change nothing", async () => {
    const r = await recoveryWorkspace({ mode: "manual" });
    const { caseRow } = await missedCallFrom(r);
    // A viewer's role does not include call records at all: not even reading the case is allowed, while the owner and a manager can.
    await expect(getCase(r.viewer, caseRow.id)).rejects.toMatchObject({ code: "forbidden" });
    expect((await getCase(r.owner, caseRow.id)).id).toBe(caseRow.id);
    await expect(assignCase(r.viewer, caseRow.id, r.w.people.sales.id, caseRow.owner_version)).rejects.toMatchObject({ code: "forbidden" });
    await expect(pauseCase(r.viewer, caseRow.id, caseRow.owner_version)).rejects.toMatchObject({ code: "forbidden" });
    await expect(closeCase(r.viewer, caseRow.id, "no_recovery", "Not my call to make")).rejects.toMatchObject({ code: "forbidden" });
    await expect(savePolicy(r.viewer, { expectedVersion: r.version, enabled: true, mode: "automatic" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(activatePolicy(r.viewer, r.version)).rejects.toMatchObject({ code: "forbidden" });
    const after = await caseOf(r.w.org.id, caseRow.caller_number as string);
    expect(after).toMatchObject({ owner_version: caseRow.owner_version, state: caseRow.state, paused_at: null });
  });

  it("sends nothing to a caller who never agreed to be texted, and the case says why instead of pretending it tried", async () => {
    const r = await recoveryWorkspace({ mode: "automatic", policy: { delayMinutes: 0 } });
    const stranger = await missedCallFrom(r, { consent: false, name: "No Consent Nora" });
    await run(r.w.org.id, minutesAfter(5));
    await run(r.w.org.id, minutesAfter(10));
    expect(await messagesFor(stranger.contact.id)).toEqual([]);
    expect(r.transport.calls).toHaveLength(0);
    const c = await caseOf(r.w.org.id, stranger.caller);
    expect(c.state).not.toBe("awaiting_response");
    expect(c.state).not.toBe("recovered");
    expect(await actionsOf(c.id)).not.toContainEqual(expect.objectContaining({ kind: "message", status: "sent" }));
    // The reason is on the record for the team: either on the case or on the action that was held back.
    const trail = JSON.stringify([c.state_reason, await actionsOf(c.id), await eventsOf(c.id)]);
    expect(trail).toMatch(/consent|agreed|permission|blocked|not allowed/i);
  });

  it("keeps the case, its actions and the text away from another workspace, and its numbers out of that workspace's report", async () => {
    const a = await recoveryWorkspace({ mode: "automatic", policy: { delayMinutes: 0 } });
    const b = await recoveryWorkspace({ mode: "manual" });
    const first = await missedCallFrom(a);
    await run(a.w.org.id, minutesAfter(5));
    const [message] = await messagesFor(first.contact.id);
    await dispatchMessage(message.id, { transport: a.transport.transport, now: minutesAfter(6) });
    const seen = (table: string) => withUser(b.w.people.owner.id, async (db) => (await db.query(`select 1 from ${table} where org_id = $1`, [a.w.org.id])).rows.length);
    for (const table of ["missed_call_cases", "missed_call_actions", "missed_call_case_events", "conversations", "conversation_messages"]) {
      expect(await count(`select count(*)::text as n from ${table} where org_id = $1`, [a.w.org.id]), `${table} exists`).toBeGreaterThan(0);
      expect(await seen(table), `${table} seen by another workspace's owner`).toBe(0);
    }
    await expect(getCase(b.owner, first.caseRow.id)).rejects.toMatchObject({ code: "not_found" });
    const mine = await recoveryStats(a.owner, 30);
    const theirs = await recoveryStats(b.owner, 30);
    expect(mine.calls.missed).toBe(1);
    expect(theirs.calls).toMatchObject({ inbound: 0, missed: 0 });
    expect(theirs.cases.total).toBe(0);
  });

  it("makes one call, one case and one text when the phone system reports the same call twice and the engine runs twice", async () => {
    const r = await recoveryWorkspace({ mode: "automatic", policy: { delayMinutes: 0 } });
    const callId = `call_dup_${Math.random().toString(36).slice(2, 10)}`;
    const first = await missedCallFrom(r, { over: { callId, receiptKey: `${callId}:end` } });
    // The same end-of-call report arrives again (the provider retried), then once more: same call id, same receipt key.
    const ev = voice({ customerNumber: first.caller, startedAt: T0, callId, receiptKey: `${callId}:end` });
    await recordCall(r.w.org.id, ev, T0);
    await recordCall(r.w.org.id, ev, T0);
    expect(await count("select count(*)::text as n from missed_call_cases where org_id = $1 and caller_number = $2", [r.w.org.id, first.caller])).toBe(1);
    expect(await count("select count(*)::text as n from crm_call_records where org_id = $1 and provider_call_id = $2", [r.w.org.id, callId])).toBe(1);
    await run(r.w.org.id, minutesAfter(5));
    await run(r.w.org.id, minutesAfter(6));
    await run(r.w.org.id, minutesAfter(7));
    const texts = await messagesFor(first.contact.id);
    expect(texts).toHaveLength(1);
    expect(texts[0].dedupe_key).toBe(`mcc:${first.caseRow.id}:message:1`);
    expect(await count("select count(*)::text as n from missed_call_actions where case_id = $1 and kind = 'message'", [first.caseRow.id])).toBe(1);
  });

  it("puts what a person did on the case's history and in the audit log under their name, and the text on the record as the system's", async () => {
    const r = await recoveryWorkspace({ mode: "automatic", policy: { delayMinutes: 0 } });
    const { caseRow, contact } = await missedCallFrom(r);
    await assignCase(r.manager, caseRow.id, r.w.people.sales.id, caseRow.owner_version);
    const afterAssign = await caseOf(r.w.org.id, caseRow.caller_number as string);
    await pauseCase(r.manager, caseRow.id, afterAssign.owner_version);
    const events = (await eventsOf(caseRow.id)).map((e) => e.kind);
    expect(events).toEqual(expect.arrayContaining(["owner_assigned"]));
    const audit = await rows<{ action: string; actor_user_id: string | null }>("select action, actor_user_id from audit_logs where org_id = $1 and target_id = $2 and action like 'missed_call.%' order by created_at, id", [r.w.org.id, caseRow.id]);
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["missed_call.assigned"]));
    for (const a of audit) expect(a.actor_user_id).toBe(r.w.people.manager.id);
    // While paused nothing is sent; the policy's own saves and activation are in the log too, under the owner.
    await run(r.w.org.id, minutesAfter(10));
    expect(await messagesFor(contact.id)).toEqual([]);
    const policyAudit = await rows<{ action: string; actor_user_id: string | null }>("select action, actor_user_id from audit_logs where org_id = $1 and action like 'missed_call.policy_%'", [r.w.org.id]);
    expect(policyAudit.map((a) => a.action)).toEqual(expect.arrayContaining(["missed_call.policy_saved", "missed_call.policy_activated"]));
    for (const a of policyAudit) expect(a.actor_user_id).toBe(r.w.people.owner.id);
    // Unpaused work is sent by the system, never in a person's name.
    await withSystem((db) => db.query("update missed_call_cases set paused_at = null where id = $1", [caseRow.id]));
    await run(r.w.org.id, minutesAfter(20));
    const [sent] = await messagesFor(contact.id);
    expect(sent).toMatchObject({ author_kind: "system" });
    expect(sent.body).toMatch(/Sorry we missed your call/);
  });
});
