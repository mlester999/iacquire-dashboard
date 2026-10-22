// Missed-call detection against the database: a missed call becomes one case; an answered, outbound or transferred call never does; redelivered and
// corrected provider events change nothing twice; callers are matched to a contact only by an exact number; and what people see (the contact's
// timeline, the conversation, the event outbox) is written once. Synthetic workspaces only: nothing leaves the machine.
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { recordVoiceEvent } from "@/server/crm/calls";
import { createContact } from "@/server/crm/contacts";
import { memberActor } from "@/server/crm/actor";
import { syncCaseForCall } from "@/server/missed-calls/cases";
import { savePolicy } from "@/server/missed-calls/policy";
import type { VoiceCallEvent } from "@/server/integrations/voice/types";
import { messagingOrg, phone as testPhone } from "./support/messaging";
import { callerNumber } from "./support/missed-calls";

const T0 = new Date("2026-10-22T15:00:00.000Z");
const BUSINESS = "+15555550100";
const number = () => callerNumber();

function voice(over: Partial<VoiceCallEvent> = {}): VoiceCallEvent {
  const callId = over.callId ?? `call_${crypto.randomBytes(5).toString("hex")}`;
  return {
    provider: "vapi", eventType: "end-of-call-report", receiptKey: `${callId}:end`, callId, externalIds: ["asst_1"], direction: "inbound", status: "no_answer", final: true,
    customerNumber: number(), businessNumber: BUSINESS, startedAt: T0, endedAt: null, durationSeconds: null, disposition: null, summary: null,
    recordingUrl: null, hasTranscript: false, ...over,
    ...(over.endedAt === undefined ? { endedAt: new Date((over.startedAt ?? T0).getTime() + 20_000) } : {}),
  };
}
const record = (orgId: string, ev: VoiceCallEvent, now = T0) => withSystem((db) => recordVoiceEvent(db, { orgId, storeRecordings: false }, ev, now));
const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[]) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;
const caseFor = async (orgId: string, callerNumber: string) => (await rows<{ id: string; state: string; call_count: number; classification: string; contact_id: string | null; conversation_id: string | null; after_hours: boolean }>(
  "select * from missed_call_cases where org_id = $1 and caller_number = $2 order by created_at", [orgId, callerNumber]))[0];
const count = async (sql: string, params: unknown[]) => Number((await rows<{ n: string }>(sql, params))[0].n);

async function enablePolicy(w: Awaited<ReturnType<typeof messagingOrg>>) {
  const owner = memberActor(w.ctx("owner"));
  await savePolicy(owner, { expectedVersion: 0, enabled: true });
}

describe("which calls open a case", () => {
  it("opens one case for a missed inbound call, with its class, and nothing for calls that were answered, transferred or outbound", async () => {
    const w = await messagingOrg();
    const caller = number();
    const missed = await record(w.org.id, voice({ customerNumber: caller, status: "no_answer" }));
    const c = await caseFor(w.org.id, caller);
    expect(c).toMatchObject({ state: "detected", call_count: 1, classification: "ring_no_answer" });
    expect(missed.outcome).toBe("created");

    const before = await count("select count(*)::text as n from missed_call_cases where org_id = $1", [w.org.id]);
    await record(w.org.id, voice({ status: "completed", durationSeconds: 180, disposition: "customer-ended-call", startedAt: T0, endedAt: new Date(T0.getTime() + 180_000), summary: null, hasTranscript: true }));
    await record(w.org.id, voice({ status: "completed", durationSeconds: 5, disposition: "assistant-forwarded-call" }));
    await record(w.org.id, voice({ direction: "outbound", status: "no_answer" }));
    await record(w.org.id, voice({ status: "completed", durationSeconds: null }));
    expect(await count("select count(*)::text as n from missed_call_cases where org_id = $1", [w.org.id])).toBe(before);
  });

  it("classifies voicemail, a call that hung up within seconds, and a failed connection each as its own kind", async () => {
    const w = await messagingOrg();
    const a = number(), b = number(), c = number();
    await record(w.org.id, voice({ customerNumber: a, status: "voicemail" }));
    await record(w.org.id, voice({ customerNumber: b, status: "completed", durationSeconds: 3, disposition: "customer-ended-call" }));
    await record(w.org.id, voice({ customerNumber: c, status: "failed", disposition: "twilio-failed-to-connect-call" }));
    expect((await caseFor(w.org.id, a)).classification).toBe("voicemail");
    expect((await caseFor(w.org.id, b)).classification).toBe("abandoned");
    expect((await caseFor(w.org.id, c)).classification).toBe("provider_failed");
  });

  it("marks a call outside the workspace's opening hours as after hours", async () => {
    const w = await messagingOrg();
    await withSystem((db) => db.query(
      "update messaging_settings set business_hours = $2::jsonb where org_id = $1",
      [w.org.id, JSON.stringify({ mon: [["09:00", "17:00"]], tue: [["09:00", "17:00"]], wed: [["09:00", "17:00"]], thu: [["09:00", "17:00"]], fri: [["09:00", "17:00"]] })],
    ));
    const inHours = number(), late = number(), weekend = number();
    await record(w.org.id, voice({ customerNumber: inHours, startedAt: new Date("2026-10-22T15:00:00Z") })); // Thursday 15:00 UTC
    await record(w.org.id, voice({ customerNumber: late, startedAt: new Date("2026-10-22T22:30:00Z") })); // Thursday 22:30
    await record(w.org.id, voice({ customerNumber: weekend, startedAt: new Date("2026-10-24T11:00:00Z") })); // Saturday
    expect((await caseFor(w.org.id, inHours)).after_hours).toBe(false);
    expect((await caseFor(w.org.id, late)).after_hours).toBe(true);
    expect((await caseFor(w.org.id, weekend)).after_hours).toBe(true);
  });
});

describe("the same call twice", () => {
  it("a redelivered end-of-call report changes nothing: one case, one call link, one timeline entry, one event", async () => {
    const w = await messagingOrg();
    await enablePolicy(w);
    const caller = number();
    const contact = await createContact(memberActor(w.ctx("owner")), { displayName: "Dana Lee", phone: caller });
    const ev = voice({ customerNumber: caller });
    await record(w.org.id, ev);
    await record(w.org.id, ev);
    await record(w.org.id, { ...ev, receiptKey: `${ev.callId}:other` });
    const c = await caseFor(w.org.id, caller);
    expect(c.call_count).toBe(1);
    expect(c.contact_id).toBe(contact.id);
    expect(await count("select count(*)::text as n from missed_call_cases where org_id = $1 and caller_number = $2", [w.org.id, caller])).toBe(1);
    expect(await count("select count(*)::text as n from missed_call_case_calls where org_id = $1 and case_id = $2", [w.org.id, c.id])).toBe(1);
    expect(await count("select count(*)::text as n from crm_activities where org_id = $1 and contact_id = $2 and kind = 'call.missed'", [w.org.id, contact.id])).toBe(1);
    expect(await count("select count(*)::text as n from crm_events where org_id = $1 and type = 'call.missed' and contact_id = $2", [w.org.id, contact.id])).toBe(1);
  });

  it("syncing a call that already has a case is a no-op", async () => {
    const w = await messagingOrg();
    const caller = number();
    const r = await record(w.org.id, voice({ customerNumber: caller }));
    const again = await withSystem((db) => syncCaseForCall(db, w.org.id, r.outcome === "rejected" ? "" : r.recordId, T0));
    expect(again.outcome).toBe("unchanged");
  });

  it("two missed calls from the same number share one open case", async () => {
    const w = await messagingOrg();
    const caller = number();
    await record(w.org.id, voice({ customerNumber: caller, startedAt: T0 }));
    await record(w.org.id, voice({ customerNumber: caller, startedAt: new Date(T0.getTime() + 600_000), status: "voicemail" }));
    const c = await caseFor(w.org.id, caller);
    expect(c.call_count).toBe(2);
    expect(await count("select count(*)::text as n from missed_call_cases where org_id = $1 and caller_number = $2", [w.org.id, caller])).toBe(1);
    const history = await rows<{ kind: string }>("select kind from missed_call_case_events where case_id = $1 order by id", [c.id]);
    expect(history.map((h) => h.kind)).toEqual(["case_created", "call_added"]);
  });

  it("a different workspace's missed call from the same number is its own case", async () => {
    const a = await messagingOrg();
    const b = await messagingOrg();
    const caller = number();
    await record(a.org.id, voice({ customerNumber: caller }));
    await record(b.org.id, voice({ customerNumber: caller }));
    expect(await caseFor(a.org.id, caller)).toBeTruthy();
    expect(await caseFor(b.org.id, caller)).toBeTruthy();
    expect((await caseFor(a.org.id, caller)).id).not.toBe((await caseFor(b.org.id, caller)).id);
  });
});

describe("late corrections", () => {
  it("a call that turns out to have been answered cancels its case and says so", async () => {
    const w = await messagingOrg();
    const caller = number();
    const callId = `call_${crypto.randomBytes(5).toString("hex")}`;
    // The provider first reports a three-second call (hung up), then the final report shows it lasted two minutes.
    await record(w.org.id, voice({ callId, customerNumber: caller, status: "completed", durationSeconds: 3, receiptKey: `${callId}:a` }));
    expect((await caseFor(w.org.id, caller)).state).toBe("detected");
    await record(w.org.id, voice({ callId, customerNumber: caller, status: "completed", durationSeconds: 120, receiptKey: `${callId}:b`, hasTranscript: true }));
    const c = await caseFor(w.org.id, caller);
    expect(c.state).toBe("canceled");
    const link = await rows<{ counted: boolean }>("select counted from missed_call_case_calls where case_id = $1", [c.id]);
    expect(link[0].counted).toBe(false);
    const events = await rows<{ kind: string; to_state: string | null; detail: { reason?: string } }>("select kind, to_state, detail from missed_call_case_events where case_id = $1 order by id", [c.id]);
    expect(events.map((e) => e.kind)).toEqual(["case_created", "call_reclassified", "state_changed"]);
    expect(events[2]).toMatchObject({ to_state: "canceled", detail: { reason: "answered_later" } });
  });

  it("when one of two calls was answered after all, the case stays open for the other", async () => {
    const w = await messagingOrg();
    const caller = number();
    const first = `call_${crypto.randomBytes(5).toString("hex")}`;
    await record(w.org.id, voice({ callId: first, customerNumber: caller, status: "completed", durationSeconds: 2, receiptKey: `${first}:a` }));
    await record(w.org.id, voice({ customerNumber: caller, status: "voicemail", startedAt: new Date(T0.getTime() + 300_000) }));
    await record(w.org.id, voice({ callId: first, customerNumber: caller, status: "completed", durationSeconds: 90, hasTranscript: true, receiptKey: `${first}:b` }));
    const c = await caseFor(w.org.id, caller);
    expect(c.state).toBe("detected");
    expect(c.call_count).toBe(1);
  });

  it("a person calling the caller back and being answered settles the case as recovered", async () => {
    const w = await messagingOrg();
    const caller = number();
    await record(w.org.id, voice({ customerNumber: caller }));
    await record(w.org.id, voice({ direction: "outbound", status: "completed", customerNumber: caller, startedAt: new Date(T0.getTime() + 900_000), endedAt: new Date(T0.getTime() + 1_000_000), durationSeconds: 100 }));
    const c = await caseFor(w.org.id, caller);
    expect(c.state).toBe("recovered");
    const row = await rows<{ recovered_via: string }>("select recovered_via from missed_call_cases where id = $1", [c.id]);
    expect(row[0].recovered_via).toBe("callback_completed");
    expect(await count("select count(*)::text as n from crm_events where org_id = $1 and type = 'recovery.completed' and entity_id = $2", [w.org.id, c.id])).toBe(1);
  });

  it("an outbound call made before the missed one does not settle it", async () => {
    const w = await messagingOrg();
    const caller = number();
    await record(w.org.id, voice({ customerNumber: caller, startedAt: new Date(T0.getTime() + 900_000) }));
    await record(w.org.id, voice({ direction: "outbound", status: "completed", customerNumber: caller, startedAt: T0, durationSeconds: 100 }));
    expect((await caseFor(w.org.id, caller)).state).toBe("detected");
  });
});

describe("who the caller is", () => {
  it("links the one contact that holds the exact number, and writes the call to their timeline and conversation", async () => {
    const w = await messagingOrg();
    await enablePolicy(w);
    const caller = number();
    const contact = await createContact(memberActor(w.ctx("owner")), { displayName: "Dana Lee", phone: caller });
    await record(w.org.id, voice({ customerNumber: caller }));
    const c = await caseFor(w.org.id, caller);
    expect(c.contact_id).toBe(contact.id);
    expect(c.conversation_id).toBeTruthy();
    const ev = await rows<{ kind: string; detail: { caseId?: string; class?: string } }>("select kind, detail from conversation_events where conversation_id = $1", [c.conversation_id]);
    expect(ev).toEqual([{ kind: "missed_call", detail: expect.objectContaining({ caseId: c.id, class: "ring_no_answer" }) }]);
    const conv = await rows<{ last_message_preview: string; unread_count: number; status: string }>("select last_message_preview, unread_count, status from conversations where id = $1", [c.conversation_id]);
    expect(conv[0]).toMatchObject({ last_message_preview: "Missed call", unread_count: 1, status: "open" });
    expect(await count("select count(*)::text as n from crm_activities where org_id = $1 and contact_id = $2 and kind = 'call.missed'", [w.org.id, contact.id])).toBe(1);
    expect((await rows<{ contact_id: string }>("select contact_id from crm_call_records where org_id = $1 and from_number = $2", [w.org.id, caller]))[0].contact_id).toBe(contact.id);
  });

  it("links nobody when two contacts share the number, and never merges them", async () => {
    const w = await messagingOrg();
    await enablePolicy(w);
    const caller = number();
    const a = await createContact(memberActor(w.ctx("owner")), { displayName: "Dana Lee", phone: caller });
    // A second record with the same number (the CRM refuses to create one by hand, but an old import or sync can leave two).
    const b = (await rows<{ id: string }>("insert into contacts (org_id, display_name, phone) values ($1, 'Dan Lee', $2) returning id", [w.org.id, caller]))[0];
    await record(w.org.id, voice({ customerNumber: caller }));
    const c = await caseFor(w.org.id, caller);
    expect(c.contact_id).toBeNull();
    expect(c.conversation_id).toBeNull();
    expect(await count("select count(*)::text as n from contacts where org_id = $1 and phone = $2 and deleted_at is null", [w.org.id, caller])).toBe(2);
    void a; void b;
  });

  it("creates an unverified contact for an unknown caller only when recovery is switched on", async () => {
    const off = await messagingOrg();
    const on = await messagingOrg();
    await enablePolicy(on);
    const callerOff = number(), callerOn = number();
    await record(off.org.id, voice({ customerNumber: callerOff }));
    await record(on.org.id, voice({ customerNumber: callerOn }));
    expect((await caseFor(off.org.id, callerOff)).contact_id).toBeNull();
    expect(await count("select count(*)::text as n from contacts where org_id = $1 and phone = $2", [off.org.id, callerOff])).toBe(0);
    const made = await caseFor(on.org.id, callerOn);
    expect(made.contact_id).toBeTruthy();
    const ident = await rows<{ verified: boolean; value: string }>("select verified, value from contact_identities where contact_id = $1", [made.contact_id]);
    expect(ident).toEqual([{ verified: false, value: callerOn }]);
    const contact = await rows<{ source: string; created_via: string }>("select source, created_via from contacts where id = $1", [made.contact_id]);
    expect(contact[0]).toEqual({ source: "missed_call", created_via: "call" });
  });

  it("keeps a withheld number as a case of its own with no contact and no way to message it", async () => {
    const w = await messagingOrg();
    await enablePolicy(w);
    const r = await record(w.org.id, voice({ customerNumber: null, status: "no_answer" }));
    const found = await rows<{ id: string; caller_number: string | null; contact_id: string | null }>("select id, caller_number, contact_id from missed_call_cases where org_id = $1", [w.org.id]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ caller_number: null, contact_id: null });
    expect(r.outcome).toBe("created");
  });

  it("never reads a number that is not E.164 as a match", async () => {
    const w = await messagingOrg();
    await record(w.org.id, voice({ customerNumber: "5550001111" as unknown as string }));
    expect(await count("select count(*)::text as n from missed_call_cases where org_id = $1 and caller_number is not null", [w.org.id])).toBe(0);
    void testPhone;
  });
});

describe("a failure in the recovery code never loses the call", () => {
  it("keeps the call record when the case sync fails, and the sweep picks the call up afterwards", async () => {
    const w = await messagingOrg();
    const caller = number();
    // Make the case table refuse the insert for this call only.
    const ev = voice({ customerNumber: caller });
    await withSystem((db) => db.query("alter table missed_call_cases add constraint mcc_test_block check (caller_number is distinct from '" + caller + "') not valid"));
    try {
      const r = await record(w.org.id, ev);
      expect(r.outcome).toBe("created");
      expect(await count("select count(*)::text as n from crm_call_records where org_id = $1 and from_number = $2", [w.org.id, caller])).toBe(1);
      expect(await count("select count(*)::text as n from missed_call_cases where org_id = $1 and caller_number = $2", [w.org.id, caller])).toBe(0);
    } finally {
      await withSystem((db) => db.query("alter table missed_call_cases drop constraint mcc_test_block"));
    }
    const { sweepRecentCalls } = await import("@/server/missed-calls/engine");
    expect(await sweepRecentCalls(T0, 50, w.org.id)).toBe(1);
    expect((await caseFor(w.org.id, caller)).state).toBe("detected");
  });
});
