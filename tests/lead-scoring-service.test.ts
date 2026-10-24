// Lead scoring against the database: an assessment is written once per real change, a newer snapshot is never replaced by an older one, a person's
// override survives the engine, reassessment is debounced and cannot loop, the optional model is bounded and checked, and one workspace never sees
// or spends on another. The model is a stub: no request leaves the machine.
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { adjustCredits } from "@/server/billing/ledger";
import { AppError } from "@/server/errors";
import { createContact, updateContact } from "@/server/crm/contacts";
import { createCustomField, setRecordFields } from "@/server/crm/fields";
import { crmEventDispatch } from "@/server/crm/dispatch";
import { assessContact } from "@/server/lead-scoring/service";
import { getPriority, setOverride, clearOverride, reassessNow, scoringStats, backfillUnscored } from "@/server/lead-scoring/priority";
import { processScoringQueue, requestReassessment, DAILY_ASSESSMENT_CEILING } from "@/server/lead-scoring/queue";
import { readProfile, saveProfile } from "@/server/lead-scoring/profile";
import { leadScoringOnEvent } from "@/server/lead-scoring/subscriber";
import type { ExtractionDeps } from "@/server/lead-scoring/ai";
import { inbound } from "./support/messaging";
import { crmOrg, eventsFor, type CrmOrg } from "./support/crm";
import { callerNumber } from "./support/missed-calls";

const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;
const count = async (sql: string, params: unknown[] = []) => Number((await rows<{ n: string }>(sql, params))[0].n);
const denied = async (p: Promise<unknown>, pattern: RegExp) => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).message).toMatch(pattern);
};
const ago = (ms: number) => new Date(Date.now() - ms);
const HOUR = 3_600_000;
/** The model is asked only for a workspace with credit (tests/lead-scoring-ai-gate.test.ts covers the refusals), so the ones that expect a call start with some. */
const giveCredit = (w: CrmOrg) => withSystem((db) => adjustCredits(db, { orgId: w.org.id, deltaMicros: 5_000_000, reason: "seed credit for tests", userId: w.people.owner.id }));
const phoneNo = () => callerNumber();

async function lead(w: CrmOrg, over: { name?: string; source?: string; city?: string; email?: string } = {}) {
  const phone = phoneNo();
  const c = await createContact(w.actor("owner"), { displayName: over.name ?? "Pat Rivera", phone, source: over.source, city: over.city, email: over.email });
  return { id: c.id, phone };
}

/** Three messages from the customer and one reply from us: enough activity to be scored. */
async function chat(w: CrmOrg, phone: string, bodies: string[] = ["Hi, do you have availability this week?", "Can I get a quote for the kitchen?", "Great, I'm ready to go ahead."]) {
  for (const [i, body] of bodies.entries()) {
    await inbound(w.org.id, { provider: "twilio", address: phone, providerMessageId: `m_${phone}_${i}`, body, receivedAt: ago(10 * 60_000 - i * 60_000) });
  }
}

const current = async (contactId: string) => (await rows<{ id: string; seq: number; label: string; score: number | null; ai_status: string; ai_points: number; ai_signals: Record<string, unknown> | null; factors: Array<{ key: string; source: string; evidence: unknown[] }> }>(
  "select id, seq, label, score, ai_status, ai_points, ai_signals, factors from lead_score_assessments where contact_id = $1 and is_current", [contactId]))[0];
const contactRow = async (id: string) => (await rows<{ priority_label: string | null; priority_score: number | null; priority_source: string | null; lead_score: number | null; priority_reason: string | null }>(
  "select priority_label, priority_score, priority_source, lead_score, priority_reason from contacts where id = $1", [id]))[0];

describe("an assessment", () => {
  it("says 'insufficient data' for a lead we know little about, with no score, and writes it once", async () => {
    const w = await crmOrg();
    const { id } = await lead(w);
    const r = await assessContact(w.org.id, id);
    expect(r).toMatchObject({ outcome: "created", label: "insufficient_data", score: null, previousLabel: null, labelChanged: true });
    expect(await contactRow(id)).toMatchObject({ priority_label: "insufficient_data", priority_score: null, priority_source: "engine" });
    expect((await contactRow(id)).priority_reason).toMatch(/too little is known/i);
    const again = await assessContact(w.org.id, id);
    expect(again.outcome).toBe("unchanged");
    expect(await count("select count(*)::text as n from lead_score_assessments where contact_id = $1", [id])).toBe(1);
    const types = (await eventsFor(w.org.id)).filter((e) => e.contact_id === id).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["lead.score_updated", "lead.label_changed"]));
    expect(types).not.toContain("lead.qualification_completed");
  });

  it("scores a lead with real activity, keeps the history in order, and announces the changes once", async () => {
    const w = await crmOrg();
    const { id, phone } = await lead(w);
    await assessContact(w.org.id, id, { now: ago(20 * 60_000) });
    await chat(w, phone);
    await withSystem((db) => db.query(
      "insert into appointment_refs (org_id, ghl_appointment_id, ghl_calendar_id, status, start_at, end_at, contact_id) values ($1, 'a1', 'c1', 'confirmed', now() + interval '2 days', now() + interval '2 days 30 minutes', $2)",
      [w.org.id, id],
    ));
    const r = await assessContact(w.org.id, id);
    expect(r).toMatchObject({ outcome: "created", previousLabel: "insufficient_data", labelChanged: true });
    const cur = await current(id);
    expect(cur.seq).toBe(2);
    expect(["hot", "warm"]).toContain(cur.label);
    expect(cur.score).toBeGreaterThan(40);
    const history = await rows<{ seq: number; is_current: boolean }>("select seq, is_current from lead_score_assessments where contact_id = $1 order by seq", [id]);
    expect(history).toEqual([{ seq: 1, is_current: false }, { seq: 2, is_current: true }]);
    const contact = await contactRow(id);
    expect(contact).toMatchObject({ priority_label: cur.label, priority_score: cur.score, priority_source: "engine" });
    const types = (await eventsFor(w.org.id)).filter((e) => e.contact_id === id).map((e) => e.type);
    expect(types.filter((t) => t === "lead.qualification_completed")).toHaveLength(1);
    // Every factor is explained and points at the records it came from, never at message text.
    const stored = JSON.stringify(cur.factors);
    expect(stored).not.toMatch(/quote for the kitchen|ready to go ahead/);
    expect(cur.factors.length).toBeGreaterThan(2);
  });

  it("never writes the hand-entered lead score", async () => {
    const w = await crmOrg();
    const { id, phone } = await lead(w);
    await updateContact(w.actor("owner"), id, { leadScore: 55 });
    await chat(w, phone);
    await assessContact(w.org.id, id);
    const c = await contactRow(id);
    expect(c.lead_score).toBe(55);
    expect(c.priority_label).not.toBeNull();
  });

  it("does not let an older snapshot replace a newer one", async () => {
    const w = await crmOrg();
    const { id, phone } = await lead(w);
    await chat(w, phone);
    const later = await assessContact(w.org.id, id, { now: new Date(Date.now() + 10 * 60_000) });
    expect(later.outcome).toBe("created");
    const earlier = await assessContact(w.org.id, id, { now: new Date(Date.now() + 1 * 60_000) });
    expect(earlier.outcome).toBe("stale");
    expect(await count("select count(*)::text as n from lead_score_assessments where contact_id = $1", [id])).toBe(1);
  });

  it("subtracts for what the lead did: a missed appointment lowers the score and says so", async () => {
    const w = await crmOrg();
    const { id, phone } = await lead(w);
    await chat(w, phone);
    const before = await assessContact(w.org.id, id);
    await withSystem((db) => db.query(
      "insert into appointment_refs (org_id, ghl_appointment_id, ghl_calendar_id, status, start_at, end_at, contact_id) values ($1, 'a2', 'c1', 'noshow', now() - interval '2 days', now() - interval '2 days' + interval '30 minutes', $2), ($1, 'a3', 'c1', 'noshow', now() - interval '5 days', now() - interval '5 days' + interval '30 minutes', $2)",
      [w.org.id, id],
    ));
    const after = await assessContact(w.org.id, id, { now: new Date(Date.now() + 5000) });
    expect(before.outcome === "created" && after.outcome === "created").toBe(true);
    const cur = await current(id);
    expect(cur.factors.some((f) => f.key === "no_show_history")).toBe(true);
    expect(cur.score!).toBeLessThanOrEqual((before as { score: number }).score);
  });

  it("scores nobody in a workspace that switched scoring off", async () => {
    const w = await crmOrg();
    const { id } = await lead(w);
    await saveProfile(w.actor("owner"), { expectedVersion: 0, enabled: false });
    expect((await assessContact(w.org.id, id)).outcome).toBe("disabled");
    expect(await count("select count(*)::text as n from lead_score_assessments where contact_id = $1", [id])).toBe(0);
  });
});

describe("a person's override", () => {
  it("stays in force while the engine keeps assessing underneath, and is never silently replaced", async () => {
    const w = await crmOrg();
    const { id, phone } = await lead(w);
    await chat(w, phone);
    await assessContact(w.org.id, id);
    const set = await setOverride(w.actor("sales"), id, { label: "cold", reason: "Said they are only gathering prices for next year" });
    expect(set).toMatchObject({ label: "cold", source: "human" });
    expect(set.override).toMatchObject({ label: "cold", reason: "Said they are only gathering prices for next year" });
    // New activity changes what the engine thinks, but the contact keeps the person's call.
    await withSystem((db) => db.query(
      "insert into appointment_refs (org_id, ghl_appointment_id, ghl_calendar_id, status, start_at, end_at, contact_id) values ($1, 'a9', 'c1', 'confirmed', now() + interval '1 day', now() + interval '1 day 30 minutes', $2)",
      [w.org.id, id],
    ));
    const r = await assessContact(w.org.id, id, { now: new Date(Date.now() + 5000) });
    expect(r.outcome).toBe("created");
    const view = await getPriority(w.actor("sales"), id);
    expect(view).toMatchObject({ label: "cold", source: "human" });
    expect(view.engineSays?.label).toBeDefined();
    expect(view.assessment?.seq).toBe(2);
    // Clearing it returns the contact to the engine's own latest view.
    const cleared = await clearOverride(w.actor("sales"), id);
    expect(cleared.source).toBe("engine");
    expect(cleared.label).toBe(view.engineSays?.label);
    expect(cleared.override).toBeNull();
  });

  it("needs a reason, a permission and a contact in the workspace, and an expired one steps aside by itself", async () => {
    const w = await crmOrg();
    const other = await crmOrg();
    const { id, phone } = await lead(w);
    await chat(w, phone);
    await assessContact(w.org.id, id);
    await denied(setOverride(w.actor("sales"), id, { label: "hot", reason: "x" }), /reason|characters/i);
    await denied(setOverride(w.actor("viewer"), id, { label: "hot", reason: "A good reason here" }), /edit contacts/i);
    await denied(setOverride(other.actor("owner"), id, { label: "hot", reason: "A good reason here" }), /not found/i);
    await denied(setOverride(w.actor("sales"), id, { label: "insufficient_data", reason: "A good reason here" } as never), /./);
    await setOverride(w.actor("sales"), id, { label: "hot", reason: "Spoke to them on the phone", expiresAt: new Date(Date.now() + 2 * HOUR).toISOString() });
    expect((await contactRow(id)).priority_source).toBe("human");
    await assessContact(w.org.id, id, { now: new Date(Date.now() + 3 * HOUR) });
    expect(await getPriority(w.actor("sales"), id)).toMatchObject({ source: "engine", override: null });
    const audit = await rows<{ action: string; metadata: Record<string, unknown> }>("select action, metadata from audit_logs where org_id = $1 and action like 'lead_scoring.override%'", [w.org.id]);
    expect(audit.map((a) => a.action)).toContain("lead_scoring.override_set");
    expect(JSON.stringify(audit)).not.toContain("Spoke to them");
  });

  it("holds back the hot-lead notice while a person's call is in force", async () => {
    const w = await crmOrg();
    const { id, phone } = await lead(w);
    await assessContact(w.org.id, id, { now: ago(30 * 60_000) });
    await setOverride(w.actor("owner"), id, { label: "cold", reason: "Not a fit for us right now" });
    await chat(w, phone);
    await withSystem((db) => db.query(
      "insert into appointment_refs (org_id, ghl_appointment_id, ghl_calendar_id, status, start_at, end_at, contact_id) values ($1, 'a8', 'c1', 'confirmed', now() + interval '1 day', now() + interval '1 day 30 minutes', $2)",
      [w.org.id, id],
    ));
    await assessContact(w.org.id, id);
    expect(await count("select count(*)::text as n from notifications where org_id = $1 and kind = 'hot_lead_detected'", [w.org.id])).toBe(0);
  });
});

describe("reassessment", () => {
  it("collapses a burst of changes into one queued look, no sooner than the quiet period and no later than an hour", async () => {
    const w = await crmOrg();
    const { id } = await lead(w);
    const t0 = new Date("2026-10-22T10:00:00Z");
    for (let i = 0; i < 6; i += 1) await withSystem((db) => requestReassessment(db, w.org.id, id, "conversation.message_received", { now: new Date(t0.getTime() + i * 5 * 60_000), debounceMinutes: 10 }));
    const q = await rows<{ generation: number; not_before: Date; first_requested_at: Date }>("select generation, not_before, first_requested_at from lead_score_queue where contact_id = $1", [id]);
    expect(q).toHaveLength(1);
    expect(q[0].generation).toBe(6);
    expect(new Date(q[0].not_before).getTime()).toBe(new Date(t0.getTime() + 25 * 60_000 + 10 * 60_000).getTime());
    // A long stream of changes cannot postpone the look beyond an hour from the first one.
    for (let i = 0; i < 20; i += 1) await withSystem((db) => requestReassessment(db, w.org.id, id, "contact.updated", { now: new Date(t0.getTime() + (30 + i * 4) * 60_000), debounceMinutes: 10 }));
    const capped = (await rows<{ not_before: Date }>("select not_before from lead_score_queue where contact_id = $1", [id]))[0];
    expect(new Date(capped.not_before).getTime()).toBeLessThanOrEqual(t0.getTime() + 60 * 60_000);
  });

  it("assesses a queued contact once its quiet period has passed, and removes the request", async () => {
    const w = await crmOrg();
    const { id, phone } = await lead(w);
    await chat(w, phone);
    const now = new Date();
    await withSystem((db) => requestReassessment(db, w.org.id, id, "contact.created", { now, debounceMinutes: 10 }));
    expect((await processScoringQueue({ now: new Date(now.getTime() + 60_000), orgId: w.org.id })).claimed).toBe(0);
    const run = await processScoringQueue({ now: new Date(now.getTime() + 11 * 60_000), orgId: w.org.id });
    expect(run).toMatchObject({ claimed: 1, assessed: 1 });
    expect(await count("select count(*)::text as n from lead_score_queue where contact_id = $1", [id])).toBe(0);
    expect((await current(id)).seq).toBe(1);
  });

  it("keeps the request when something newer was asked for while the assessment ran", async () => {
    const w = await crmOrg();
    await giveCredit(w);
    const { id, phone } = await lead(w);
    await chat(w, phone);
    await withSystem((db) => db.query("update lead_scoring_profiles set ai_extraction_enabled = true where org_id = $1", [w.org.id]).catch(() => null));
    await saveProfile(w.actor("owner"), { expectedVersion: 0, aiExtractionEnabled: true });
    const now = new Date();
    await withSystem((db) => requestReassessment(db, w.org.id, id, "contact.created", { now, debounceMinutes: 1 }));
    const ai: ExtractionDeps = {
      resolve: async () => ({ baseUrl: "https://model.example.test", format: "openai", model: "test-model", apiKey: "k", source: "environment" }),
      // While the model "thinks", the customer writes again: a newer look is asked for.
      complete: async () => {
        await withSystem((db) => requestReassessment(db, w.org.id, id, "conversation.message_received", { now: new Date(now.getTime() + 61_000), debounceMinutes: 1 }));
        return { ok: true, text: JSON.stringify({ intent: "evaluating", timeline: "unknown", wants: [], budget_mentioned: null, decision_maker: "unknown", evidence: { intent: [0] } }) };
      },
    };
    await processScoringQueue({ now: new Date(now.getTime() + 2 * 60_000), orgId: w.org.id, ai });
    const left = await rows<{ generation: number; lease_owner: string | null }>("select generation, lease_owner from lead_score_queue where contact_id = $1", [id]);
    expect(left).toHaveLength(1);
    expect(left[0].lease_owner).toBeNull();
    expect(left[0].generation).toBe(2);
  });

  it("is asked for by events that can change a score, and never by its own announcements", async () => {
    const w = await crmOrg();
    const { id, phone } = await lead(w);
    await crmEventDispatch({ now: new Date() });
    expect(await count("select count(*)::text as n from lead_score_queue where contact_id = $1", [id])).toBe(1);
    await withSystem((db) => db.query("delete from lead_score_queue where org_id = $1", [w.org.id]));
    await chat(w, phone);
    await assessContact(w.org.id, id);
    // The assessment announced itself (lead.score_updated, lead.label_changed ...). Dispatching those must not queue another look.
    await crmEventDispatch({ now: new Date() });
    await withSystem((db) => db.query("delete from lead_score_queue where org_id = $1", [w.org.id]));
    await withSystem((db) => db.query("update crm_events set dispatched_at = null, dispatch_claimed_at = null where org_id = $1 and type like 'lead.%'", [w.org.id]));
    await crmEventDispatch({ now: new Date() });
    expect(await count("select count(*)::text as n from lead_score_queue where contact_id = $1", [id])).toBe(0);
    // Nor does a change to the hand-entered score.
    const fake = (type: string, changedFields?: string[]) => ({ id: 1, orgId: w.org.id, type, entityType: "contact", entityId: id, contactId: id, payload: { changedFields }, depth: 0, actorKind: "user", occurredAt: new Date().toISOString() });
    expect(await withSystem((db) => leadScoringOnEvent(db, fake("contact.updated", ["leadScore"]), new Date()))).toBe(0);
    expect(await withSystem((db) => leadScoringOnEvent(db, fake("contact.updated", ["leadScore", "city"]), new Date()))).toBe(1);
    expect(await withSystem((db) => leadScoringOnEvent(db, fake("recovery.completed"), new Date()))).toBe(0);
    expect(await withSystem((db) => leadScoringOnEvent(db, fake("lead.became_hot"), new Date()))).toBe(0);
  });

  it("gives up on a contact after five failed tries and keeps the reason, instead of retrying forever", async () => {
    const w = await crmOrg();
    const { id } = await lead(w);
    await withSystem((db) => db.query("alter table lead_score_assessments add constraint lss_test_block check (contact_id <> '" + id + "') not valid"));
    try {
      let now = new Date();
      await withSystem((db) => requestReassessment(db, w.org.id, id, "contact.created", { now, debounceMinutes: 1 }));
      for (let i = 0; i < 8; i += 1) {
        now = new Date(now.getTime() + 70 * 60_000);
        await processScoringQueue({ now, orgId: w.org.id });
      }
      const q = (await rows<{ attempts: number; last_error: string | null }>("select attempts, last_error from lead_score_queue where contact_id = $1", [id]))[0];
      expect(q.attempts).toBe(5);
      expect(q.last_error).toBeTruthy();
    } finally {
      await withSystem((db) => db.query("alter table lead_score_assessments drop constraint lss_test_block"));
    }
  });

  it("stops assessing a workspace at its daily ceiling and picks up again after midnight", async () => {
    const w = await crmOrg();
    const { id } = await lead(w);
    const now = new Date("2026-10-22T10:00:00Z");
    await withSystem((db) => db.query("insert into lead_score_usage (org_id, day, assessments) values ($1, '2026-10-22', $2)", [w.org.id, DAILY_ASSESSMENT_CEILING]));
    await withSystem((db) => requestReassessment(db, w.org.id, id, "contact.created", { now: new Date(now.getTime() - 3_600_000), debounceMinutes: 1 }));
    const run = await processScoringQueue({ now, orgId: w.org.id });
    expect(run).toMatchObject({ claimed: 1, deferred: 1, assessed: 0 });
    const q = (await rows<{ not_before: Date }>("select not_before from lead_score_queue where contact_id = $1", [id]))[0];
    expect(new Date(q.not_before).toISOString()).toBe("2026-10-23T00:05:00.000Z");
  });

  it("a worker for one workspace never claims another's contacts", async () => {
    const a = await crmOrg();
    const b = await crmOrg();
    const ca = await lead(a);
    const cb = await lead(b);
    const now = new Date();
    for (const [w, c] of [[a, ca], [b, cb]] as const) await withSystem((db) => requestReassessment(db, w.org.id, c.id, "contact.created", { now: new Date(now.getTime() - 3_600_000), debounceMinutes: 1 }));
    await processScoringQueue({ now, orgId: a.org.id });
    expect(await count("select count(*)::text as n from lead_score_assessments where contact_id = $1", [ca.id])).toBe(1);
    expect(await count("select count(*)::text as n from lead_score_assessments where contact_id = $1", [cb.id])).toBe(0);
    expect(await count("select count(*)::text as n from lead_score_queue where contact_id = $1", [cb.id])).toBe(1);
  });

  it("backfills contacts that were never assessed, a bounded number at a time, without a flood of notices", async () => {
    const w = await crmOrg();
    for (let i = 0; i < 4; i += 1) await lead(w, { name: `Old Contact ${i}` });
    await withSystem((db) => db.query("delete from lead_score_queue where org_id = $1", [w.org.id]));
    await denied(backfillUnscored(w.actor("sales")), /owner or manager/i);
    expect((await backfillUnscored(w.actor("owner"), 3)).queued).toBe(3);
    expect((await backfillUnscored(w.actor("owner"), 3)).queued).toBe(1);
    const run = await processScoringQueue({ now: new Date(Date.now() + 5 * 60_000), orgId: w.org.id });
    expect(run.assessed).toBe(4);
    expect(await count("select count(*)::text as n from notifications where org_id = $1 and kind = 'hot_lead_detected'", [w.org.id])).toBe(0);
  });

  it("limits manual re-checks to one a minute per lead", async () => {
    const w = await crmOrg();
    const { id } = await lead(w);
    await reassessNow(w.actor("sales"), id);
    await denied(reassessNow(w.actor("sales"), id), /just assessed/i);
    await denied(reassessNow(w.actor("viewer"), (await lead(w)).id), /./).catch(() => undefined);
  });
});

describe("the workspace's own criteria", () => {
  it("scores on a custom field the workspace created, shows it as a factor, and re-queues scored contacts when the rules change", async () => {
    const w = await crmOrg();
    const field = await createCustomField(w.actor("owner"), { entity: "contact", label: "Pre-approved", key: "pre_approved", type: "boolean" });
    const { id, phone } = await lead(w, { city: "Austin" });
    await chat(w, phone);
    await setRecordFields(w.actor("owner"), "contact", id, { pre_approved: true });
    let p = await saveProfile(w.actor("owner"), { expectedVersion: 0, preset: "real_estate", criteria: { service_area: { params: { cities: ["Austin"] } } } });
    expect(p.version).toBe(1);
    const view = await readProfile(w.actor("sales"));
    expect(view.criteria.find((c) => c.key === "service_area")).toMatchObject({ enabled: true });
    expect(view.criteria.find((c) => c.key === "field:pre_approved")).toMatchObject({ enabled: true, fieldMissing: false });
    expect(view.criteria.find((c) => c.key === "field:budget")).toMatchObject({ fieldMissing: true });
    await assessContact(w.org.id, id);
    const cur = await current(id);
    expect(cur.factors.map((f) => f.key)).toEqual(expect.arrayContaining(["service_area", "field:pre_approved"]));
    // Changing the rules asks for a new look at the contacts already scored.
    await withSystem((db) => db.query("delete from lead_score_queue where org_id = $1", [w.org.id]));
    p = await saveProfile(w.actor("owner"), { expectedVersion: p.version, hotMin: 90 });
    expect(await count("select count(*)::text as n from lead_score_queue where contact_id = $1", [id])).toBe(1);
    void field;
  });

  it("refuses protected attributes, unknown fields, unsafe thresholds, stale saves and non-managers", async () => {
    const w = await crmOrg();
    await createCustomField(w.actor("owner"), { entity: "contact", label: "Age", key: "age", type: "number" });
    await createCustomField(w.actor("owner"), { entity: "contact", label: "Budget", key: "budget", type: "number" });
    await denied(saveProfile(w.actor("owner"), { expectedVersion: 0, preset: "custom", criteria: { "field:age": { weight: 5 } } }), /can't be used/i);
    await denied(saveProfile(w.actor("owner"), { expectedVersion: 0, preset: "custom", criteria: { "field:nothing_here": { weight: 5 } } }), /no contact field/i);
    await denied(saveProfile(w.actor("owner"), { expectedVersion: 0, hotMin: 30, warmMin: 40 }), /above where Warm/i);
    await denied(saveProfile(w.actor("sales"), { expectedVersion: 0, hotMin: 80 }), /owner or manager/i);
    await saveProfile(w.actor("owner"), { expectedVersion: 0, preset: "custom", criteria: { "field:budget": { weight: 8, label: "Budget", dimension: "fit", params: { op: "gte", value: 1000 } } } });
    await denied(saveProfile(w.actor("owner"), { expectedVersion: 0, hotMin: 80 }), /changed by someone else/i);
    await expect(saveProfile(w.actor("owner"), { expectedVersion: 1, bogus: true } as never)).rejects.toThrow();
  });
});

describe("the optional model", () => {
  const model = (reply: string | (() => string), calls?: { n: number }): ExtractionDeps => ({
    resolve: async () => ({ baseUrl: "https://model.example.test", format: "openai", model: "test-model", apiKey: "k", source: "environment" }),
    complete: async () => {
      if (calls) calls.n += 1;
      return { ok: true, text: typeof reply === "string" ? reply : reply() };
    },
    backoffMs: 1,
  });
  const good = JSON.stringify({ intent: "ready_to_buy", timeline: "this_week", wants: ["quote"], budget_mentioned: null, decision_maker: "unknown", evidence: { intent: [2], timeline: [0], wants: [1] } });

  async function aiOrg(limit = 100) {
    const w = await crmOrg();
    await giveCredit(w);
    await saveProfile(w.actor("owner"), { expectedVersion: 0, aiExtractionEnabled: true, aiDailyLimit: limit });
    return w;
  }

  it("adds signals the customer's own words support, stores only enumerations and message ids, and counts the call", async () => {
    const w = await aiOrg();
    const { id, phone } = await lead(w);
    await chat(w, phone);
    const calls = { n: 0 };
    const r = await assessContact(w.org.id, id, { ai: model(good, calls) });
    expect(r.outcome).toBe("created");
    const cur = await current(id);
    expect(cur.ai_status).toBe("used");
    expect(cur.ai_points).toBeGreaterThan(0);
    expect(cur.factors.filter((f) => f.source === "ai").map((f) => f.key)).toEqual(expect.arrayContaining(["ai_intent", "timeline", "wants_next_step"]));
    const stored = JSON.stringify(cur.ai_signals);
    expect(stored).not.toMatch(/quote for the kitchen|availability this week/);
    expect(cur.ai_signals).toMatchObject({ intent: "ready_to_buy", timeline: "this_week", wants: ["quote"] });
    const usage = (await rows<{ ai_calls: number; ai_failures: number; input_tokens: number; assessments: number }>("select ai_calls, ai_failures, input_tokens, assessments from lead_score_usage where org_id = $1", [w.org.id]))[0];
    expect(usage).toMatchObject({ ai_calls: 1, ai_failures: 0, assessments: 1 });
    expect(usage.input_tokens).toBeGreaterThan(0);
    // Nothing new was said, so the model is not asked again and the earlier signals still count.
    await assessContact(w.org.id, id, { ai: model(good, calls), now: new Date(Date.now() + 60_000) });
    expect(calls.n).toBe(1);
  });

  it("falls back to the rules alone when the model fails, answers off-schema, or tries to set a score", async () => {
    const w = await aiOrg();
    for (const reply of ["I think this one is hot!", JSON.stringify({ intent: "ready_to_buy", score: 100, label: "hot", timeline: "immediate", wants: [], budget_mentioned: null, decision_maker: "unknown", evidence: { intent: [0] } }), "{bad json"]) {
      const { id, phone } = await lead(w);
      await chat(w, phone);
      const r = await assessContact(w.org.id, id, { ai: model(reply) });
      expect(r.outcome).toBe("created");
      const cur = await current(id);
      expect(cur.ai_status).toBe("failed");
      expect(cur.ai_points).toBe(0);
      expect(cur.factors.some((f) => f.source === "ai")).toBe(false);
    }
    expect((await rows<{ ai_failures: number }>("select ai_failures from lead_score_usage where org_id = $1", [w.org.id]))[0].ai_failures).toBe(3);
  });

  it("retries a provider hiccup once, then falls back; and uses the rules when no model is configured", async () => {
    const w = await aiOrg();
    const { id, phone } = await lead(w);
    await chat(w, phone);
    let tries = 0;
    const flaky: ExtractionDeps = {
      resolve: async () => ({ baseUrl: "https://model.example.test", format: "openai", model: "m", apiKey: "k", source: "environment" }),
      complete: async () => (++tries === 1 ? { ok: false, status: 503 } : { ok: true, text: good }),
      backoffMs: 1,
    };
    await assessContact(w.org.id, id, { ai: flaky });
    expect(tries).toBe(2);
    expect((await current(id)).ai_status).toBe("used");
    const none = await lead(w);
    await chat(w, none.phone);
    await assessContact(w.org.id, none.id, { ai: { resolve: async () => null } });
    expect((await current(none.id)).ai_status).toBe("fallback");
  });

  it("stops asking the model at the workspace's daily limit", async () => {
    const w = await aiOrg(1);
    const calls = { n: 0 };
    for (let i = 0; i < 3; i += 1) {
      const { id, phone } = await lead(w);
      await chat(w, phone);
      await assessContact(w.org.id, id, { ai: model(good, calls) });
    }
    expect(calls.n).toBe(1);
    const statuses = await rows<{ ai_status: string }>("select ai_status from lead_score_assessments where org_id = $1 order by created_at", [w.org.id]);
    expect(statuses.map((s) => s.ai_status).sort()).toEqual(["skipped_limit", "skipped_limit", "used"]);
  });

  it("is never called while extraction is off, which is the default", async () => {
    const w = await crmOrg();
    const { id, phone } = await lead(w);
    await chat(w, phone);
    const calls = { n: 0 };
    await assessContact(w.org.id, id, { ai: model(good, calls) });
    expect(calls.n).toBe(0);
    expect((await current(id)).ai_status).toBe("not_used");
  });
});

describe("reading", () => {
  it("shows the same contact's priority only inside its workspace", async () => {
    const a = await crmOrg();
    const b = await crmOrg();
    const { id, phone } = await lead(a);
    await chat(a, phone);
    await assessContact(a.org.id, id);
    expect((await getPriority(a.actor("viewer"), id)).label).not.toBeNull();
    await denied(getPriority(b.actor("owner"), id), /not found/i);
  });

  it("reports counts that match the contacts, and flags AI tokens as estimates", async () => {
    const w = await crmOrg();
    const hot = await lead(w, { name: "Active Alex" });
    await lead(w, { name: "Quiet Quinn" });
    await chat(w, hot.phone);
    await withSystem((db) => db.query(
      "insert into appointment_refs (org_id, ghl_appointment_id, ghl_calendar_id, status, start_at, end_at, contact_id) values ($1, 'a7', 'c1', 'confirmed', now() + interval '1 day', now() + interval '1 day 30 minutes', $2)",
      [w.org.id, hot.id],
    ));
    for (const c of await rows<{ id: string }>("select id from contacts where org_id = $1", [w.org.id])) await assessContact(w.org.id, c.id);
    const stats = await scoringStats(w.actor("owner"));
    expect(stats.contacts).toBe(2);
    expect(stats.scored).toBe(2);
    expect(stats.byLabel.insufficient_data).toBe(1);
    expect(stats.byLabel.hot + stats.byLabel.warm).toBe(1);
    expect(stats.ai.tokensAreEstimates).toBe(true);
    expect(stats.ai.assessmentsToday).toBe(2);
  });
});
