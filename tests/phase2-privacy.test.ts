// What Phase 2 keeps and for how long: a privacy request reaches missed-call cases, calls and lead scores; routine retention removes only what is old and
// finished; and what the logs say about a failure is a name and a code, never a message that could carry a number or a name.
import { afterEach, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { redactContact } from "@/server/messaging/contacts";
import { createContact } from "@/server/crm/contacts";
import { assessContact } from "@/server/lead-scoring/service";
import { setOverride } from "@/server/lead-scoring/priority";
import { requestReassessment } from "@/server/lead-scoring/queue";
import { processMissedCalls } from "@/server/missed-calls/engine";
import { purgeExpiredPhase2Records } from "@/server/missed-calls/retention";
import { syncCaseForCallSafely } from "@/server/missed-calls/sync";
import { inbound } from "./support/messaging";
import { actionsOf, callerNumber, caseOf, count, eventsOf, messagesFor, minutesAfter, missedCallFrom, recordCall, recoveryWorkspace, rows, voice } from "./support/missed-calls";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.MCC_DEBUG;
});

describe("a privacy request", () => {
  it("closes the person's missed-call cases, removes their number and what was said, stops anything queued, and clears their lead scores", async () => {
    const r = await recoveryWorkspace({ mode: "assisted" });
    const { caller, contact } = await missedCallFrom(r, { name: "Erase Me Ella", over: { status: "completed", durationSeconds: 4, summary: "She asked about a leak", hasTranscript: true } });
    // The workspace keeps call content, so the record holds a summary and a transcript reference.
    await withSystem((db) => db.query("update crm_call_records set summary = 'She asked about a leak', transcript_ref = 'vapi:call/x/transcript', notes = 'Call her Tuesday' where org_id = $1 and contact_id = $2", [r.w.org.id, contact.id]));
    await processMissedCalls({ now: minutesAfter(5), orgId: r.w.org.id });
    const before = await caseOf(r.w.org.id, caller);
    expect(before.state).toBe("eligible");
    const draft = (await actionsOf(before.id)).find((a) => a.kind === "message")!;
    expect(draft.draft_body).toBeTruthy();
    await inbound(r.w.org.id, { provider: "twilio", address: caller, providerMessageId: "erase_1", body: "I need a quote please", receivedAt: new Date(Date.now() - 3 * 60_000) });
    await assessContact(r.w.org.id, contact.id);
    await setOverride(r.owner, contact.id, { label: "hot", reason: "Called twice today" });
    await withSystem((db) => requestReassessment(db, r.w.org.id, contact.id, "contact.updated"));
    const other = await missedCallFrom(r, { name: "Keep Me Kai" });

    await redactContact(r.owner, contact.id, "Customer asked us to delete everything");

    const after = (await rows<{ state: string; state_reason: string | null; caller_number: string | null }>("select state, state_reason, caller_number from missed_call_cases where id = $1", [before.id]))[0];
    expect(after).toEqual({ state: "canceled", state_reason: "privacy_request", caller_number: null });
    expect((await eventsOf(before.id)).map((e) => e.to_state).filter(Boolean)).toContain("canceled");
    const call = (await rows<{ from_number: string | null; to_number: string | null; summary: string | null; notes: string | null; transcript_ref: string | null }>(
      "select from_number, to_number, summary, notes, transcript_ref from crm_call_records where org_id = $1 and contact_id = $2", [r.w.org.id, contact.id]))[0];
    expect(call).toMatchObject({ from_number: null, summary: null, notes: null, transcript_ref: null });
    expect(call.to_number).not.toBe(caller);
    const action = (await actionsOf(before.id)).find((a) => a.kind === "message")!;
    expect(action).toMatchObject({ status: "canceled", reason: "privacy_request", draft_body: null });
    for (const m of await messagesFor(contact.id)) expect(["blocked", "failed"]).toContain(m.status);
    expect(await count("select count(*)::text as n from lead_score_assessments where contact_id = $1", [contact.id])).toBe(0);
    expect(await count("select count(*)::text as n from lead_score_overrides where contact_id = $1", [contact.id])).toBe(0);
    expect(await count("select count(*)::text as n from lead_score_queue where contact_id = $1", [contact.id])).toBe(0);
    const c = (await rows<{ priority_label: string | null; priority_score: number | null; priority_reason: string | null }>("select priority_label, priority_score, priority_reason from contacts where id = $1", [contact.id]))[0];
    expect(c).toEqual({ priority_label: null, priority_score: null, priority_reason: null });
    // The number appears nowhere in what recovery and scoring keep about her.
    const kept = JSON.stringify(await rows("select detail from missed_call_case_events where org_id = $1", [r.w.org.id])) + JSON.stringify(await rows("select detail from missed_call_actions where org_id = $1", [r.w.org.id]));
    expect(kept).not.toContain(caller);
    // Somebody else's records are untouched.
    expect((await caseOf(r.w.org.id, other.caller)).state).toBe("detected");
    expect(await count("select count(*)::text as n from crm_call_records where org_id = $1 and contact_id = $2 and from_number is not null", [r.w.org.id, other.contact.id])).toBe(1);
  });

  it("is not available across workspaces", async () => {
    const a = await recoveryWorkspace({ mode: "manual" });
    const b = await recoveryWorkspace({ mode: "manual" });
    const mine = await missedCallFrom(a, { name: "Mine Mia" });
    await expect(redactContact(b.owner, mine.contact.id, "Not their customer at all")).rejects.toThrow(/not found/i);
    expect((await caseOf(a.w.org.id, mine.caller)).caller_number).not.toBeUndefined();
    expect((await rows<{ caller_number: string | null }>("select caller_number from missed_call_cases where id = $1", [mine.caseRow.id]))[0].caller_number).toBe(mine.caller);
  });
});

describe("routine retention", () => {
  it("removes finished cases after two years and keeps open and recent ones", async () => {
    const r = await recoveryWorkspace({ mode: "manual" });
    const old = await missedCallFrom(r, { name: "Old Case" });
    const recent = await missedCallFrom(r, { name: "Recent Case" });
    const open = await missedCallFrom(r, { name: "Open Case" });
    await withSystem(async (db) => {
      await db.query("update missed_call_cases set state = 'completed_without_recovery', resolved_at = now() - interval '800 days' where id = $1", [old.caseRow.id]);
      await db.query("update missed_call_cases set state = 'recovered', resolved_at = now() - interval '30 days' where id = $1", [recent.caseRow.id]);
    });
    const out = await purgeExpiredPhase2Records();
    expect(out.cases).toBeGreaterThanOrEqual(1);
    expect(await count("select count(*)::text as n from missed_call_cases where id = $1", [old.caseRow.id])).toBe(0);
    expect(await count("select count(*)::text as n from missed_call_case_events where case_id = $1", [old.caseRow.id])).toBe(0);
    expect(await count("select count(*)::text as n from missed_call_cases where id = any($1::uuid[])", [[recent.caseRow.id, open.caseRow.id]])).toBe(2);
    // The call itself is not a Phase 2 record: it stays.
    expect(await count("select count(*)::text as n from crm_call_records where org_id = $1", [r.w.org.id])).toBe(3);
  });

  it("keeps a contact's newest ten assessments and the current one, and removes the older ones past a year", async () => {
    const r = await recoveryWorkspace({ mode: "manual" });
    const c = await createContact(r.owner, { displayName: "Many Assessments", phone: callerNumber() });
    await withSystem(async (db) => {
      for (let seq = 1; seq <= 16; seq += 1) {
        await db.query(
          `insert into lead_score_assessments (org_id, contact_id, seq, score, label, inputs_hash, facts_as_of, engine_version, profile_version, is_current, created_at)
           values ($1, $2, $3, 50, 'warm', $4, now(), 'rules-1', 0, $5, case when $3 = 16 then now() else now() - interval '400 days' + ($3 * interval '1 hour') end)`,
          [r.w.org.id, c.id, seq, `hash-${seq}-${c.id}`.padEnd(20, "x"), seq === 16],
        );
      }
      await db.query("insert into lead_score_overrides (org_id, contact_id, label, reason, cleared_at) values ($1, $2, 'cold', 'old override', now() - interval '800 days')", [r.w.org.id, c.id]);
      await db.query("insert into lead_score_usage (org_id, day, assessments) values ($1, (now() - interval '500 days')::date, 5), ($1, now()::date, 1)", [r.w.org.id]);
    });
    const out = await purgeExpiredPhase2Records();
    expect(out.assessments).toBeGreaterThanOrEqual(6);
    const left = await rows<{ seq: number }>("select seq from lead_score_assessments where contact_id = $1 order by seq", [c.id]);
    expect(left.map((x) => x.seq)).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect(await count("select count(*)::text as n from lead_score_overrides where contact_id = $1", [c.id])).toBe(0);
    expect(await count("select count(*)::text as n from lead_score_usage where org_id = $1", [r.w.org.id])).toBe(1);
  });
});

describe("what the logs say", () => {
  it("a failure while syncing a case logs nothing identifying in production mode, and the call is still saved", async () => {
    const r = await recoveryWorkspace({ mode: "manual" });
    const caller = callerNumber();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const prior = process.env.NODE_ENV;
    await withSystem((db) => db.query("alter table missed_call_cases add constraint mcc_log_block check (caller_number is distinct from '" + caller + "') not valid"));
    try {
      (process.env as Record<string, string>).NODE_ENV = "production";
      const res = await withSystem(async (db) => {
        const call = await db.query<{ id: string }>(
          "insert into crm_call_records (org_id, provider, provider_call_id, direction, status, from_number, to_number) values ($1, 'vapi', $2, 'inbound', 'no_answer', $3, '+15555550100') returning id",
          [r.w.org.id, `log-${caller}`, caller],
        );
        return syncCaseForCallSafely(db, r.w.org.id, call.rows[0].id, minutesAfter(1));
      });
      expect(res).toBeNull();
    } finally {
      (process.env as Record<string, string>).NODE_ENV = prior ?? "test";
      await withSystem((db) => db.query("alter table missed_call_cases drop constraint mcc_log_block"));
    }
    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).not.toContain(caller);
    expect(logged).not.toContain("duplicate key");
    expect(logged).toContain("missed call sync failed");
    expect(await count("select count(*)::text as n from crm_call_records where org_id = $1 and from_number = $2", [r.w.org.id, caller])).toBe(1);
    void recordCall; void voice;
  });
});
