// Lead scoring asks a paid model only for a workspace that is active, not paused by the agency, and has credit. Otherwise the rules score on their own, nothing is
// sent to the model, the day's allowance is not used up, and the result says why. The model is a stub: no request leaves the machine.
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { adjustCredits } from "@/server/billing/ledger";
import { createContact } from "@/server/crm/contacts";
import { assessContact } from "@/server/lead-scoring/service";
import { extractSignals, type ExtractionDeps } from "@/server/lead-scoring/ai";
import { processScoringQueue, requestReassessment } from "@/server/lead-scoring/queue";
import { saveProfile } from "@/server/lead-scoring/profile";
import { inbound } from "./support/messaging";
import { crmOrg, type CrmOrg } from "./support/crm";
import { callerNumber } from "./support/missed-calls";

const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;
const good = JSON.stringify({ intent: "ready_to_buy", timeline: "this_week", wants: ["quote"], budget_mentioned: null, decision_maker: "unknown", evidence: { intent: [2], timeline: [0], wants: [1] } });
const ago = (ms: number) => new Date(Date.now() - ms);

/** A model that answers well and counts the times it was asked. */
function model() {
  const calls = { n: 0 };
  const deps: ExtractionDeps = {
    resolve: async () => ({ baseUrl: "https://model.example.test", format: "openai", model: "test-model", apiKey: "k", source: "environment" }),
    complete: async () => {
      calls.n += 1;
      return { ok: true, text: good, usage: { inputTokens: 300, outputTokens: 30 } };
    },
    backoffMs: 1,
  };
  return { calls, deps };
}

/** A workspace with signal extraction switched on, credit, and a contact whose customer has written three times. */
async function world(opts: { credits?: number } = {}) {
  const w: CrmOrg = await crmOrg();
  await saveProfile(w.actor("owner"), { expectedVersion: 0, aiExtractionEnabled: true });
  const credit = opts.credits ?? 5;
  if (credit > 0) await withSystem((db) => adjustCredits(db, { orgId: w.org.id, deltaMicros: Math.round(credit * 1_000_000), reason: "seed credit for tests", userId: w.people.owner.id }));
  const phone = callerNumber();
  const c = await createContact(w.actor("owner"), { displayName: "Gate Customer", phone });
  const bodies = ["Hi, do you have availability this week?", "Can I get a quote for the kitchen?", "Great, I'm ready to go ahead."];
  for (const [i, body] of bodies.entries()) await inbound(w.org.id, { provider: "twilio", address: phone, providerMessageId: `gate_${phone}_${i}`, body, receivedAt: ago(10 * 60_000 - i * 60_000) });
  return { w, id: c.id };
}

const current = async (contactId: string) => (await rows<{ ai_status: string; ai_points: number; score: number | null }>("select ai_status, ai_points, score from lead_score_assessments where contact_id = $1 and is_current", [contactId]))[0];
const usage = async (orgId: string) => (await rows<{ ai_calls: number }>("select ai_calls from lead_score_usage where org_id = $1", [orgId]))[0];
const metered = async (orgId: string) => (await rows("select 1 from metered_usage_events where org_id = $1 and provider = 'llm'", [orgId])).length;

describe("the model is skipped, and the rules still score", () => {
  it("for a suspended workspace", async () => {
    const { w, id } = await world();
    await withSystem((db) => db.query("update organizations set status = 'suspended' where id = $1", [w.org.id]));
    const m = model();
    const r = await assessContact(w.org.id, id, { ai: m.deps });
    expect(m.calls.n).toBe(0);
    expect(r).toMatchObject({ outcome: "created", aiSkipped: "org_inactive" });
    expect(await current(id)).toMatchObject({ ai_status: "fallback", ai_points: 0 });
    expect((await current(id)).score).not.toBeNull();
    expect(await usage(w.org.id)).toMatchObject({ ai_calls: 0 }); // the day's allowance was not spent on a call that never happened
    expect(await metered(w.org.id)).toBe(0);
  });

  it("for an archived workspace", async () => {
    const { w, id } = await world();
    await withSystem((db) => db.query("update organizations set status = 'archived' where id = $1", [w.org.id]));
    const m = model();
    expect(await assessContact(w.org.id, id, { ai: m.deps })).toMatchObject({ outcome: "created", aiSkipped: "org_inactive" });
    expect(m.calls.n).toBe(0);
  });

  it("for a workspace with no credit", async () => {
    const { w, id } = await world({ credits: 0 });
    const m = model();
    const r = await assessContact(w.org.id, id, { ai: m.deps });
    expect(m.calls.n).toBe(0);
    expect(r).toMatchObject({ outcome: "created", aiSkipped: "no_credits" });
    expect(await current(id)).toMatchObject({ ai_status: "fallback", ai_points: 0 });
    expect(await usage(w.org.id)).toMatchObject({ ai_calls: 0 });
    expect(await metered(w.org.id)).toBe(0);
  });

  it("for a workspace the agency has paused", async () => {
    const { w, id } = await world();
    await withSystem((db) => db.query("insert into automation_pauses (org_id, scope, active, set_at) values ($1, 'agency', true, now())", [w.org.id]));
    const m = model();
    const r = await assessContact(w.org.id, id, { ai: m.deps });
    expect(m.calls.n).toBe(0);
    expect(r).toMatchObject({ outcome: "created", aiSkipped: "agency_paused" });
    expect((await current(id)).ai_status).toBe("fallback");
  });

  it("when the day's credit is all reserved elsewhere, because only what is available counts", async () => {
    const { w, id } = await world();
    await withSystem((db) => db.query("update credit_accounts set reserved_micros = balance_micros where org_id = $1", [w.org.id]));
    const m = model();
    expect(await assessContact(w.org.id, id, { ai: m.deps })).toMatchObject({ aiSkipped: "no_credits" });
    expect(m.calls.n).toBe(0);
  });

  it("through the job a tick runs, which counts what it skipped and leaves the contact scored", async () => {
    const { w, id } = await world();
    await withSystem((db) => db.query("update organizations set status = 'suspended' where id = $1", [w.org.id]));
    const m = model();
    const now = new Date();
    await withSystem((db) => requestReassessment(db, w.org.id, id, "conversation.message_received", { now: new Date(now.getTime() - 3_600_000), debounceMinutes: 1 }));
    const run = await processScoringQueue({ now, orgId: w.org.id, ai: m.deps });
    expect(run).toMatchObject({ claimed: 1, assessed: 1, aiSkipped: { org_inactive: 1 } });
    expect(m.calls.n).toBe(0);
    expect(await current(id)).toMatchObject({ ai_status: "fallback" });
  });
});

describe("the model is still asked when everything is in order", () => {
  it("for an active workspace with credit, once, and the call is metered", async () => {
    const { w, id } = await world();
    const m = model();
    const r = await assessContact(w.org.id, id, { ai: m.deps });
    expect(m.calls.n).toBe(1);
    expect(r).toMatchObject({ outcome: "created" });
    expect(r).not.toHaveProperty("aiSkipped");
    expect(await current(id)).toMatchObject({ ai_status: "used" });
    expect(await usage(w.org.id)).toMatchObject({ ai_calls: 1 });
    expect(await metered(w.org.id)).toBe(2);
  });

  it("checks before it looks for a model, so an unconnected model is not mistaken for a paused workspace", async () => {
    const { w } = await world({ credits: 0 });
    const out = await extractSignals(w.org.id, [{ id: "m1", text: "I want a quote for a kitchen remodel." }], { enabled: true, dailyLimit: 5 }, new Date(), { resolve: async () => null });
    expect(out).toEqual({ status: "fallback", reason: "no_credits" });
    const { w: active } = await world();
    expect(await extractSignals(active.org.id, [{ id: "m1", text: "I want a quote for a kitchen remodel." }], { enabled: true, dailyLimit: 5 }, new Date(), { resolve: async () => null })).toEqual({ status: "fallback", reason: "no_model" });
  });
});
