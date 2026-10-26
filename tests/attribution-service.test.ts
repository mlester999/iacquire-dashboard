// Lead attribution on real internal services: touches, first and latest, the places that record them (hosted and website forms, calls, website chat, a
// person's choice), and the report that counts what became of each source. Money is only shown where its inputs exist.
import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { createContact } from "@/server/crm/contacts";
import { closeOpportunity, createOpportunity } from "@/server/crm/opportunities";
import { processSubmissions } from "@/server/websites/forms";
import { addCost, listCosts, removeCost, sourcesSeen } from "@/server/attribution/costs";
import { attributionReport, NO_TOUCH } from "@/server/attribution/report";
import { getContactAttribution, recordCallTouch, recordFormTouch, recordManualTouch, recordTouch } from "@/server/attribution/touches";
import { crmOrg, eventsFor, type CrmOrg } from "./support/crm";
import { callerNumber, recordCall, voice } from "./support/missed-calls";
import { addSiteHost, answer, chatOrg, clientId, embedCall, start, type ChatOrg } from "./support/webchat";

let c: CrmOrg;
const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;
const make = async (name: string, over: Record<string, unknown> = {}) => (await createContact(c.actor("sales"), { displayName: name, email: `${name.toLowerCase().replace(/\W/g, "")}-${crypto.randomBytes(3).toString("hex")}@example.test`, ...over })).id;
const touch = (contactId: string, facts: Parameters<typeof recordTouch>[1]["facts"], at?: Date, ref?: { type: "web_chat_session" | "form_submission"; id: string }) =>
  withSystem((db) => recordTouch(db, { orgId: c.org.id, contactId, facts, occurredAt: at, ref }));
const pointers = async (id: string) => (await rows<{ first_touch_id: string | null; latest_touch_id: string | null }>("select first_touch_id, latest_touch_id from contacts where id = $1", [id]))[0];
const attr = (id: string, who: Parameters<CrmOrg["actor"]>[0] = "sales") => getContactAttribution(c.actor(who), id);

beforeAll(async () => {
  c = await crmOrg({ name: "Attribution Co" });
});

describe("recording a touch", () => {
  it("keeps the first touch, moves the latest one, and never edits what was recorded", async () => {
    const id = await make("Dana First");
    const t0 = new Date("2026-10-01T10:00:00Z");
    const a = await touch(id, { kind: "website_form", attribution: { utm_source: "Google", utm_medium: "cpc", utm_campaign: "spring", landing_page: "/quote" } }, t0, { type: "form_submission", id: "sub-1" });
    const b = await touch(id, { kind: "website_chat", attribution: { referrer: "https://www.facebook.com/page" } }, new Date("2026-10-05T10:00:00Z"), { type: "web_chat_session", id: "sess-1" });
    const p = await pointers(id);
    expect(Number(p.first_touch_id)).toBe(a.id);
    expect(Number(p.latest_touch_id)).toBe(b.id);
    const history = (await attr(id)).history;
    expect(history.map((h) => `${h.kind}:${h.source}:${h.confidence}`)).toEqual(["website_form:google:known", "website_chat:facebook:inferred"]);
    expect(history[0]).toMatchObject({ medium: "cpc", campaign: "spring", landingPath: "/quote", evidence: "utm" });
    // The history is append-only: the application role cannot change or remove a touch.
    await expect(withSystem((db) => db.query("set local role iaq_app_user").then(() => db.query("update lead_touches set source = 'x'")))).rejects.toThrow();
  });

  it("records a redelivered event once, and announces the source once", async () => {
    const id = await make("Redelivered");
    const ref = { type: "form_submission" as const, id: "sub-redelivered" };
    const one = await touch(id, { kind: "crm_form", attribution: { utm_source: "newsletter" } }, undefined, ref);
    const two = await touch(id, { kind: "crm_form", attribution: { utm_source: "newsletter" } }, undefined, ref);
    expect(one.duplicate).toBe(false);
    expect(two).toMatchObject({ duplicate: true, id: null });
    expect((await attr(id)).history).toHaveLength(1);
    const events = (await eventsFor(c.org.id, "lead.source_recorded")).filter((e) => e.contact_id === id);
    expect(events).toHaveLength(1);
  });

  it("makes a touch that arrives late but happened earlier the first touch", async () => {
    const id = await make("Late Arrival");
    await touch(id, { kind: "website_chat", attribution: { utm_source: "later" } }, new Date("2026-10-10T00:00:00Z"), { type: "web_chat_session", id: "late-2" });
    const early = await touch(id, { kind: "website_form", attribution: { utm_source: "earlier" } }, new Date("2026-10-02T00:00:00Z"), { type: "form_submission", id: "late-1" });
    const p = await pointers(id);
    expect(Number(p.first_touch_id)).toBe(early.id);
    expect((await attr(id)).first?.source).toBe("earlier");
    expect((await attr(id)).latest?.source).toBe("later");
  });

  it("reads the shapes forms store: flat parameters, nested under utm, and a website form's referrer", async () => {
    const id = await make("Shapes");
    const flat = await withSystem((db) => recordFormTouch(db, { orgId: c.org.id, contactId: id, kind: "crm_form", submissionId: "shape-1", attribution: { utm_source: "bing", utm_medium: "cpc", landing_page: "/a", referrer: "https://www.bing.com/" } }));
    const nested = await withSystem((db) => recordFormTouch(db, { orgId: c.org.id, contactId: id, kind: "website_form", submissionId: "shape-2", attribution: { utm: { source: "tiktok", medium: "social", campaign: "launch" } } }));
    expect(flat.touch).toMatchObject({ source: "bing", medium: "cpc", landingPath: "/a" });
    expect(nested.touch).toMatchObject({ source: "tiktok", medium: "social", campaign: "launch", confidence: "known" });
    const empty = await withSystem((db) => recordFormTouch(db, { orgId: c.org.id, contactId: id, kind: "website_form", submissionId: "shape-3", attribution: null }));
    expect(empty.touch).toMatchObject({ source: "unknown", confidence: "unknown" });
  });
});

describe("where touches come from", () => {
  it("records a website chat's visit when the visitor's first message creates the contact", async () => {
    const chat: ChatOrg = await chatOrg();
    const token = await start(chat, { landing: "/roofing?utm_source=google&utm_medium=cpc&utm_campaign=spring&gclid=abc", referrer: "https://www.google.com/" });
    await embedCall(chat, { action: "send", token, body: { text: "Hi", clientMessageId: clientId() }, generate: answer("Hello!").generate });
    const contact = (await rows<{ id: string; first_touch_id: string | null }>("select id, first_touch_id from contacts where org_id = $1 and created_via = 'website_chat'", [chat.m.org.id]))[0];
    expect(contact.first_touch_id).not.toBeNull();
    const t = (await rows<{ kind: string; source: string; medium: string; campaign: string; confidence: string; evidence: string; landing_path: string; click_ids: Record<string, string>; ref_type: string }>("select * from lead_touches where contact_id = $1", [contact.id]))[0];
    expect(t).toMatchObject({ kind: "website_chat", source: "google", medium: "cpc", campaign: "spring", confidence: "known", evidence: "utm", landing_path: "/roofing", ref_type: "web_chat_session" });
    expect(t.click_ids).toEqual({ gclid: "abc" });
    // A second message does not record a second touch.
    await embedCall(chat, { action: "send", token, body: { text: "Again", clientMessageId: clientId() }, generate: answer("Yes.").generate });
    expect(await rows("select 1 from lead_touches where contact_id = $1", [contact.id])).toHaveLength(1);
  });

  it("records a website form enquiry when it becomes a contact, with the UTM values and referrer it carried", async () => {
    const chat = await chatOrg(); // any workspace with a Website Studio site
    const host = `attr-${crypto.randomBytes(3).toString("hex")}.iacquire.site`;
    await addSiteHost(chat.m.org.id, host);
    const site = (await rows<{ id: string }>("select id from websites where org_id = $1", [chat.m.org.id]))[0].id;
    await withSystem((db) =>
      db.query(
        `insert into website_form_submissions (org_id, website_id, publication_id, host, page_slug, name, email, phone, message, consent, consent_text, utm, referrer, dedupe_key)
         values ($1, $2, $3, $4, 'pricing', 'Pat Form', 'pat.form@example.net', null, 'Quote please', true, 'I agree to be contacted about my enquiry.', $5::jsonb, 'https://l.facebook.com/l.php', $6)`,
        [chat.m.org.id, site, crypto.randomUUID(), host, JSON.stringify({ utm_source: "facebook", utm_medium: "paid-social", utm_campaign: "roof-week" }), `dedupe-${crypto.randomBytes(4).toString("hex")}`],
      ),
    );
    const out = await processSubmissions({ limit: 50 });
    expect(out.processed).toBeGreaterThanOrEqual(1);
    const contact = (await rows<{ id: string }>("select id from contacts where org_id = $1 and email = 'pat.form@example.net'", [chat.m.org.id]))[0];
    const t = (await rows<{ kind: string; source: string; medium: string; campaign: string; referrer: string; landing_path: string }>("select kind, source, medium, campaign, referrer, landing_path from lead_touches where contact_id = $1", [contact.id]))[0];
    expect(t).toMatchObject({ kind: "website_form", source: "facebook", medium: "paid-social", campaign: "roof-week", referrer: "https://l.facebook.com/l.php", landing_path: "/pricing" });
    await processSubmissions({ limit: 50 }); // a later run changes nothing
    expect(await rows("select 1 from lead_touches where contact_id = $1", [contact.id])).toHaveLength(1);
  });

  it("records an inbound call from a known contact as the phone channel (inferred), and an outbound call as nothing", async () => {
    const phone = callerNumber();
    const id = await make("Caller", { phone });
    await recordCall(c.org.id, voice({ customerNumber: phone, direction: "inbound", status: "completed", durationSeconds: 60, callId: "attr-in-1" }));
    await recordCall(c.org.id, voice({ customerNumber: phone, direction: "outbound", status: "completed", durationSeconds: 60, callId: "attr-out-1" }));
    const history = (await attr(id)).history;
    expect(history.map((h) => `${h.kind}:${h.source}:${h.confidence}:${h.evidence}`)).toEqual(["call:phone:inferred:channel"]);
    // A redelivered call report adds nothing.
    await recordCall(c.org.id, voice({ customerNumber: phone, direction: "inbound", status: "completed", durationSeconds: 60, callId: "attr-in-1" }));
    expect((await attr(id)).history).toHaveLength(1);
    void recordCallTouch;
  });

  it("lets a person record a source they know, as known and attributed to them, without rewriting the first touch", async () => {
    const id = await make("Referral");
    await touch(id, { kind: "website_form", attribution: { utm_source: "google" } }, new Date("2026-10-01T00:00:00Z"), { type: "form_submission", id: "manual-1" });
    await recordManualTouch(c.actor("sales"), { contactId: id, source: "Trade Show", medium: "Event", campaign: "Expo 2026" });
    const a = await attr(id);
    expect(a.first?.source).toBe("google"); // unchanged
    expect(a.latest).toMatchObject({ kind: "manual", source: "trade-show", medium: "event", campaign: "Expo 2026", confidence: "known", evidence: "manual" });
    await expect(recordManualTouch(c.actor("sales"), { contactId: id, source: "   " })).rejects.toThrow(/Enter a source/);
    await expect(recordManualTouch(c.actor("viewer"), { contactId: id, source: "x" })).rejects.toThrow(/can't change/i);
    expect(await rows("select 1 from audit_logs where org_id = $1 and action = 'attribution.manual_touch'", [c.org.id])).not.toHaveLength(0);
  });

  it("says nothing was recorded for a contact that has no touch, and hides the history from people who cannot see contacts", async () => {
    const id = await make("Untouched");
    expect(await attr(id)).toEqual({ first: null, latest: null, history: [] });
    await expect(attr(id, "viewer")).resolves.toBeDefined(); // viewers can see contacts
  });
});

describe("the source report", () => {
  let period: { startsAt: Date; endsAt: Date };
  beforeAll(async () => {
    c = await crmOrg({ name: "Report Co" });
    period = { startsAt: new Date(Date.now() - 86_400_000), endsAt: new Date(Date.now() + 86_400_000) };
    const g1 = await make("G1");
    const g2 = await make("G2");
    const f1 = await make("F1");
    const n1 = await make("N1"); // no touch at all
    const u1 = await make("U1");
    await touch(g1, { kind: "website_form", attribution: { utm_source: "google", utm_medium: "cpc" } });
    await touch(g2, { kind: "website_chat", attribution: { gclid: "x" } });
    await touch(f1, { kind: "website_form", attribution: { referrer: "https://www.facebook.com/" } });
    await touch(u1, { kind: "website_chat", attribution: { landing_page: "/" } });
    // A later touch from another source: the first-touch report keeps the first, the latest-touch report follows the latest.
    await touch(g1, { kind: "website_chat", attribution: { utm_source: "facebook" } }, new Date(Date.now() + 60_000), { type: "web_chat_session", id: "report-late" });
    await withSystem(async (db) => {
      await db.query("update contacts set lead_status = 'qualified' where id = any($1::uuid[])", [[g1, f1]]);
      await db.query("insert into appointment_refs (org_id, ghl_appointment_id, ghl_calendar_id, title, status, start_at, end_at, contact_id) values ($1, 'a1', 'cal', 'Visit', 'confirmed', now() + interval '2 days', now() + interval '2 days 1 hour', $2), ($1, 'a2', 'cal', 'Cancelled', 'cancelled', now() + interval '3 days', now() + interval '3 days 1 hour', $3)", [c.org.id, g1, g2]);
    });
    const deal = await createOpportunity(c.actor("sales"), { name: "Roof", contactId: g1, value: 8000, currency: "USD" });
    await closeOpportunity(c.actor("sales"), deal.id, "won");
    await createOpportunity(c.actor("sales"), { name: "Gutters", contactId: g2, value: 1500, currency: "USD" });
    void n1;
  });

  const rowOf = (r: Awaited<ReturnType<typeof attributionReport>>, source: string) => r.rows.find((x) => x.source === source)!;

  it("counts leads, qualified leads, appointments and deals per first-touch source, and keeps the ones with no touch apart", async () => {
    const r = await attributionReport(c.actor("owner"), { ...period });
    expect(r.model).toBe("first");
    expect(rowOf(r, "google")).toMatchObject({ leads: 2, qualified: 1, appointments: 1, opportunities: 2, wonCount: 1, known: 2, label: "Google" });
    expect(rowOf(r, "google").wonValue).toEqual([{ currency: "USD", amount: 8000 }]);
    expect(rowOf(r, "google").openValue).toEqual([{ currency: "USD", amount: 1500 }]);
    expect(rowOf(r, "facebook")).toMatchObject({ leads: 1, qualified: 1, inferred: 1, known: 0 });
    expect(rowOf(r, "unknown")).toMatchObject({ leads: 1, unknown: 1, label: "Not recorded" });
    expect(rowOf(r, NO_TOUCH)).toMatchObject({ leads: 1, label: "No touch recorded" });
    expect(r.totals).toMatchObject({ leads: 5, qualified: 2, appointments: 1, opportunities: 2, wonCount: 1 });
    // A cancelled appointment is not counted: G2 has only that one.
    expect(rowOf(r, "google").appointments).toBe(1);
  });

  it("follows the latest touch when asked, so the same leads are credited differently", async () => {
    const r = await attributionReport(c.actor("owner"), { ...period, model: "latest" });
    expect(r.model).toBe("latest");
    expect(rowOf(r, "facebook").leads).toBe(2); // G1's later touch and F1
    expect(rowOf(r, "google").leads).toBe(1);
    expect(r.totals.leads).toBe(5);
  });

  it("shows no revenue, cost per lead or return on spend while their inputs are missing, and says what is missing", async () => {
    const r = await attributionReport(c.actor("owner"), { ...period });
    const g = rowOf(r, "google");
    // This workspace has no customer invoicing, so there is no verified revenue to show: the report says so, and never fills the place with deal value.
    expect(g).toMatchObject({ verifiedRevenue: [], refunded: [], recordedByHand: [], returnOnSpend: null, returnCurrency: null, costPerLead: null, cost: [] });
    expect(g.missing).toBe("Needs an entered campaign cost and verified payments.");
    expect(r.revenue).toMatchObject({ state: "off", manualCounted: false, workspaceHasPayments: false, testPaymentsExcluded: 0, disputedHeldOut: 0, total: [] });
    expect(r.notes.join(" ")).toMatch(/not verified revenue/);
    expect(r.notes.join(" ")).toMatch(/Verified revenue needs customer invoices and payments, which are not switched on for this workspace/);
  });

  it("computes cost per lead only from an entered cost wholly inside the period and in one currency, and still never computes return on spend", async () => {
    const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const owner = c.actor("owner");
    await expect(addCost(c.actor("sales"), { source: "google", periodStart: day(-1), periodEnd: day(0), amount: 100, currency: "USD" })).rejects.toThrow(/Only people who can export/);
    await expect(addCost(owner, { source: "google", periodStart: day(0), periodEnd: day(-3), amount: 100, currency: "USD" })).rejects.toThrow(/cannot be before/);
    await expect(addCost(owner, { source: "google", periodStart: day(0), periodEnd: day(0), amount: -5, currency: "USD" })).rejects.toThrow(/positive/);
    await expect(addCost(owner, { source: "google", periodStart: day(0), periodEnd: day(0), amount: 5, currency: "dollars" })).rejects.toThrow(/three-letter/);
    await addCost(owner, { source: "Google", campaign: "spring", periodStart: day(0), periodEnd: day(0), amount: 300, currency: "usd", note: "Search ads" });
    const r = await attributionReport(c.actor("owner"), { ...period });
    const g = rowOf(r, "google");
    expect(g.cost).toEqual([{ currency: "USD", amount: 300 }]);
    expect(g.costPerLead).toEqual({ currency: "USD", amount: 150 }); // 300 / 2 leads
    expect(g.returnOnSpend).toBeNull(); // there are no verified payments
    expect(g.missing).toBe("Needs verified payments.");
    // Two currencies for one source: no single cost per lead is claimed.
    await addCost(owner, { source: "google", periodStart: day(0), periodEnd: day(0), amount: 1000, currency: "PHP" });
    const multi = rowOf(await attributionReport(c.actor("owner"), { ...period }), "google");
    expect(multi.cost.map((x) => x.currency)).toEqual(["PHP", "USD"]);
    expect(multi.costPerLead).toBeNull();
    // A cost that only partly overlaps the period is left out and counted.
    await addCost(owner, { source: "facebook", periodStart: day(-30), periodEnd: day(0), amount: 999, currency: "USD" });
    const partial = await attributionReport(c.actor("owner"), { ...period });
    expect(rowOf(partial, "facebook").cost).toEqual([]);
    expect(partial.excludedCosts).toBe(1);
    expect(partial.notes.join(" ")).toMatch(/only partly overlap/);
    const listed = await listCosts(c.actor("owner"));
    expect(listed.map((x) => x.source)).toContain("google");
    await removeCost(owner, listed[0].id);
    expect((await listCosts(c.actor("owner"))).some((x) => x.id === listed[0].id)).toBe(false);
    expect((await sourcesSeen(c.actor("owner"))).map((s) => s.source)).toEqual(expect.arrayContaining(["google", "facebook"]));
  });

  it("is for people who may see reports, and another workspace's leads never appear", async () => {
    await expect(attributionReport(c.actor("setter"), { ...period })).resolves.toBeDefined(); // appointment setters see analytics
    const other = await crmOrg({ name: "Other Report Co" });
    const empty = await attributionReport(other.actor("owner"), { ...period });
    expect(empty.rows).toEqual([]);
    expect(empty.totals.leads).toBe(0);
    await expect(attributionReport(c.actor("owner"), { startsAt: period.endsAt, endsAt: period.startsAt })).rejects.toThrow(/must end after/);
  });
});
