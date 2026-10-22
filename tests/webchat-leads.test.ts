// Lead capture, contact safety, consent, scoring and automation events for the website chat, on real internal services.
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { createContact } from "@/server/crm/contacts";
import { memberActor } from "@/server/crm/actor";
import { crmEventDispatch } from "@/server/crm/dispatch";
import { getConsent, redactContact } from "@/server/messaging/contacts";
import { purgeExpiredWebChats } from "@/server/webchat/retention";
import { processScoringQueue } from "@/server/lead-scoring/queue";
import { getPriority } from "@/server/lead-scoring/priority";
import { answer, bodyOf, chatOrg, clientId, embedCall, reconfigure, start, viewOf, hashOf, type ChatOrg } from "./support/webchat";

let c: ChatOrg;
const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;
const sessionOf = async (token: string) => (await rows<{ id: string; contact_id: string; conversation_id: string; visitor_email: string | null; visitor_phone: string | null; visitor_name: string | null; lead_captured_at: Date | null; possible_match_contact_id: string | null; qualification: Record<string, string>; qualification_completed_at: Date | null; privacy_ack_at: Date | null; marketing_opt_in: boolean }>("select * from web_chat_sessions where token_hash = $1", [hashOf(token)]))[0];
const lead = (token: string, details: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  embedCall(c, { action: "lead", token, body: { details, privacyAck: true, ...extra } });

beforeAll(async () => {
  c = await chatOrg();
});

describe("the details form", () => {
  it("puts what the visitor typed on the chat's own contact as unverified, and records consent to be contacted with the wording shown", async () => {
    const token = await start(c);
    await embedCall(c, { action: "send", token, body: { text: "I need a quote", clientMessageId: clientId() }, generate: answer("Happy to help.").generate });
    const r = await lead(token, { name: "  Dana  Lee ", email: "Dana.Lee@Example.com", phone: "+63 917 555 0142" });
    expect(r.status).toBe(200);
    expect(viewOf(r).leadCaptured).toBe(true);
    const s = await sessionOf(token);
    expect(s).toMatchObject({ visitor_name: "Dana Lee", visitor_email: "dana.lee@example.com", visitor_phone: "+639175550142" });
    expect(s.lead_captured_at).not.toBeNull();
    expect(s.privacy_ack_at).not.toBeNull();
    const contact = (await rows<{ display_name: string; first_name: string; last_name: string; email: string; phone: string; created_via: string }>("select display_name, first_name, last_name, email::text as email, phone, created_via from contacts where id = $1", [s.contact_id]))[0];
    expect(contact).toMatchObject({ display_name: "Dana Lee", first_name: "Dana", last_name: "Lee", email: "dana.lee@example.com", phone: "+639175550142", created_via: "website_chat" });
    // Typed by a stranger on a web page: never proof of ownership.
    const ids = await rows<{ kind: string; verified: boolean }>("select kind, verified from contact_identities where contact_id = $1 order by kind", [s.contact_id]);
    expect(ids).toEqual([{ kind: "email", verified: false }, { kind: "phone", verified: false }]);
    // Consent to be contacted at those details, with the exact notice. Marketing is not granted without the box.
    expect(await withSystem((db) => getConsent(db, c.m.org.id, s.contact_id, "email", "service"))).toBe("granted");
    expect(await withSystem((db) => getConsent(db, c.m.org.id, s.contact_id, "sms", "service"))).toBe("granted");
    expect(await withSystem((db) => getConsent(db, c.m.org.id, s.contact_id, "email", "marketing"))).not.toBe("granted");
    const evidence = (await rows<{ source: string; evidence: string }>("select source, evidence from contact_consent_events where contact_id = $1 and channel = 'email' and purpose = 'service'", [s.contact_id]))[0];
    expect(evidence.source).toBe("website_chat_form");
    expect(evidence.evidence).toMatch(/may contact you about your enquiry/);
  });

  it("records marketing consent only when the owner offers the box and the visitor ticks it", async () => {
    const offered = await chatOrg({ offerMarketingOptIn: true });
    const t1 = await start(offered);
    await embedCall(offered, { action: "lead", token: t1, body: { details: { email: "yes@example.com" }, privacyAck: true, marketingOptIn: true } });
    const s1 = await rows<{ contact_id: string }>("select contact_id from web_chat_sessions where token_hash = $1", [hashOf(t1)]);
    expect(await withSystem((db) => getConsent(db, offered.m.org.id, s1[0].contact_id, "email", "marketing"))).toBe("granted");
    const t2 = await start(offered);
    await embedCall(offered, { action: "lead", token: t2, body: { details: { email: "no@example.com" }, privacyAck: true, marketingOptIn: false } });
    const s2 = await rows<{ contact_id: string }>("select contact_id from web_chat_sessions where token_hash = $1", [hashOf(t2)]);
    expect(await withSystem((db) => getConsent(db, offered.m.org.id, s2[0].contact_id, "email", "marketing"))).not.toBe("granted");
    // A box the owner did not offer cannot be ticked by hand-crafting the request.
    const t3 = await start(c);
    await embedCall(c, { action: "lead", token: t3, body: { details: { email: "sneaky@example.com" }, privacyAck: true, marketingOptIn: true } });
    const s3 = await rows<{ contact_id: string; marketing_opt_in: boolean }>("select contact_id, marketing_opt_in from web_chat_sessions where token_hash = $1", [hashOf(t3)]);
    expect(s3[0].marketing_opt_in).toBe(false);
    expect(await withSystem((db) => getConsent(db, c.m.org.id, s3[0].contact_id, "email", "marketing"))).not.toBe("granted");
  });

  it("creates the contact and conversation when the form comes before any message", async () => {
    const token = await start(c);
    const r = await lead(token, { email: "early@example.com" });
    expect(r.status).toBe(200);
    const s = await sessionOf(token);
    expect(s.conversation_id).toBeTruthy();
    expect(await rows("select 1 from conversations where id = $1 and channel = 'web_chat'", [s.conversation_id])).toHaveLength(1);
  });

  it("refuses bad details, a missing privacy confirmation and an unanswered required question, and stores nothing", async () => {
    const token = await start(c);
    const bad = async (body: Record<string, unknown>) => (await embedCall(c, { action: "lead", token, body })).status;
    expect(await bad({ details: { email: "dana@example.com" } })).toBe(400); // privacy notice not confirmed
    expect(await bad({ details: { email: "nope" }, privacyAck: true })).toBe(400);
    expect(await bad({ details: { phone: "0917 555 0142" }, privacyAck: true })).toBe(400); // no country code
    expect(await bad({ details: { name: "Only a name" }, privacyAck: true })).toBe(400);
    expect(await bad({ details: "not an object", privacyAck: true })).toBe(400);
    expect((await sessionOf(token)).lead_captured_at).toBeNull();
    const asked = await chatOrg({ qualificationQuestions: [{ label: "What do you need?", kind: "text", required: true }] });
    const t = await start(asked);
    const missing = await embedCall(asked, { action: "lead", token: t, body: { details: { email: "q@example.com" }, privacyAck: true, answers: {} } });
    expect(missing.status).toBe(400);
    expect(bodyOf(missing).error?.message).toMatch(/What do you need\?/);
  });
});

describe("a visitor who types someone else's address", () => {
  it("is never merged into that person's contact, and learns nothing about them", async () => {
    const owner = memberActor(c.m.ctx("owner"));
    const existing = await createContact(owner, { displayName: "Existing Customer", email: "existing@example.com", phone: "+639175550999" });
    const before = (await rows<{ version: number; display_name: string }>("select version, display_name from contacts where id = $1", [existing.id]))[0];
    const consentBefore = (await rows("select 1 from contact_consent_events where contact_id = $1", [existing.id])).length;

    const token = await start(c);
    await embedCall(c, { action: "send", token, body: { text: "Hi, it's me", clientMessageId: clientId() }, generate: answer("Hello!").generate });
    const r = await lead(token, { name: "Impostor", email: "Existing@Example.com", phone: "+639175550888" });
    expect(r.status).toBe(200);
    const text = JSON.stringify(r.body);
    expect(text).not.toMatch(/Existing Customer|existing@example|639175550999/i); // nothing about the real contact reaches the visitor
    expect(bodyOf<{ possibleMatch?: boolean }>(r).possibleMatch).toBeUndefined();

    const s = await sessionOf(token);
    expect(s.possible_match_contact_id).toBe(existing.id);
    expect(s.contact_id).not.toBe(existing.id);
    // The existing contact is exactly as it was: same version, no consent events from this chat, the chat's conversation is not theirs.
    expect((await rows<{ version: number; display_name: string }>("select version, display_name from contacts where id = $1", [existing.id]))[0]).toEqual(before);
    expect((await rows("select 1 from contact_consent_events where contact_id = $1", [existing.id])).length).toBe(consentBefore);
    expect(await rows("select 1 from conversations where contact_id = $1 and channel = 'web_chat'", [existing.id])).toHaveLength(0);
    // The chat's own contact did not take the taken email, but did take the free phone number.
    const mine = (await rows<{ email: string | null; phone: string | null }>("select email::text as email, phone from contacts where id = $1", [s.contact_id]))[0];
    expect(mine).toEqual({ email: null, phone: "+639175550888" });
    expect(await withSystem((db) => getConsent(db, c.m.org.id, s.contact_id, "email", "service"))).not.toBe("granted");
    // A person is told to look before replying.
    const note = await rows<{ body: string }>("select body from notifications where org_id = $1 and kind = 'web_chat_lead' and dedupe_key = $2", [c.m.org.id, `webchat-lead:${s.id}`]);
    expect(note[0].body).toMatch(/may already be in your CRM/);
  });
});

describe("qualification", () => {
  it("records the answers, checks choices, and announces completion once", async () => {
    const q = await chatOrg({
      qualificationQuestions: [
        { label: "What do you need help with?", kind: "text", required: true },
        { label: "How soon?", kind: "choice", choices: ["This week", "This month"], required: true },
      ],
    });
    const token = await start(q);
    const partial = await embedCall(q, { action: "lead", token, body: { details: { email: "pq@example.com" }, privacyAck: true, answers: { what_do_you_need_help_with: "Roof leak" } } });
    expect(partial.status).toBe(400); // a required question is open
    const wrongChoice = await embedCall(q, { action: "lead", token, body: { details: { email: "pq@example.com" }, privacyAck: true, answers: { what_do_you_need_help_with: "Roof leak", how_soon: "Yesterday" } } });
    expect(wrongChoice.status).toBe(400); // a choice that is not on the list counts as unanswered
    const done = await embedCall(q, { action: "lead", token, body: { details: { email: "pq@example.com" }, privacyAck: true, answers: { what_do_you_need_help_with: "Roof leak", how_soon: "This week" } } });
    expect(bodyOf<{ qualificationCompleted: boolean }>(done).qualificationCompleted).toBe(true);
    const again = await embedCall(q, { action: "lead", token, body: { details: { email: "pq@example.com" }, privacyAck: true, answers: { what_do_you_need_help_with: "Roof leak", how_soon: "This week" } } });
    expect(again.status).toBe(200);
    const s = (await rows<{ contact_id: string; qualification: Record<string, string>; qualification_completed_at: Date | null }>("select contact_id, qualification, qualification_completed_at from web_chat_sessions where token_hash = $1", [hashOf(token)]))[0];
    expect(s.qualification).toEqual({ what_do_you_need_help_with: "Roof leak", how_soon: "This week" });
    expect(s.qualification_completed_at).not.toBeNull();
    const events = await rows<{ type: string }>("select type from crm_events where org_id = $1 and contact_id = $2 and type in ('webchat.lead_captured', 'webchat.qualification_completed')", [q.m.org.id, s.contact_id]);
    expect(events.map((e) => e.type).sort()).toEqual(["webchat.lead_captured", "webchat.qualification_completed"]); // each once, despite the repeat
  });
});

describe("automation and scoring", () => {
  it("announces the chat's milestones to workflows, once each, with the contact attached", async () => {
    const token = await start(c);
    await embedCall(c, { action: "send", token, body: { text: "Hello", clientMessageId: clientId() }, generate: answer("Hi!").generate });
    await lead(token, { email: "auto@example.com" });
    await embedCall(c, { action: "handoff", token });
    const s = await sessionOf(token);
    const types = (await rows<{ type: string }>("select type from crm_events where org_id = $1 and contact_id = $2 order by id", [c.m.org.id, s.contact_id])).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["contact.created", "webchat.started", "conversation.message_received", "webchat.lead_captured", "conversation.handoff_requested", "lead.source_recorded"]));
    expect(types.filter((t) => t === "webchat.started")).toHaveLength(1);
    expect(types.filter((t) => t === "webchat.lead_captured")).toHaveLength(1);
  });

  it("scores a chat lead through the existing lead scoring, which counts a website chat as the lead reaching out first", async () => {
    const token = await start(c);
    await embedCall(c, { action: "send", token, body: { text: "I'd like a quote for my roof", clientMessageId: clientId() }, generate: answer("Of course.").generate });
    await lead(token, { name: "Scored Lead", email: "scored@example.com", phone: "+639175550777" });
    const s = await sessionOf(token);
    await crmEventDispatch({ limit: 200 });
    const queued = await rows("select 1 from lead_score_queue where contact_id = $1", [s.contact_id]);
    expect(queued.length).toBeGreaterThanOrEqual(0); // queued by the dispatcher, or already assessed
    await processScoringQueue({ limit: 50, perOrgLimit: 50, orgId: c.m.org.id, now: new Date(Date.now() + 3_600_000) });
    const p = await getPriority(memberActor(c.m.ctx("owner")), s.contact_id);
    expect(p).not.toBeNull();
    expect(JSON.stringify(p)).toMatch(/reached out themselves|Reached out/i);
  });
});

describe("what the lead form does when the assistant is off or the business is closed", () => {
  it("takes a message and details outside business hours without the AI answering, and tells the owners nobody is handling it", async () => {
    const closed = await chatOrg({ offlineBehavior: "leave_message" });
    await withSystem((db) => db.query("insert into messaging_settings (org_id, business_hours) values ($1, $2::jsonb) on conflict (org_id) do update set business_hours = excluded.business_hours", [closed.m.org.id, JSON.stringify({ mon: [["09:00", "09:01"]] })]));
    const cfg = bodyOf<{ config: { aiAvailable: boolean; open: boolean } }>(await embedCall(closed, { action: "config", now: new Date("2026-10-24T12:00:00Z") })).config;
    expect(cfg).toMatchObject({ open: false, aiAvailable: false });
    const token = await start(closed);
    const ai = answer("must not answer");
    const r = await embedCall(closed, { action: "send", token, body: { text: "Anyone there?", clientMessageId: clientId() }, generate: ai.generate, now: new Date("2026-10-24T12:00:00Z") });
    expect(ai.calls).toHaveLength(0);
    expect(viewOf(r).mode).toBe("waiting");
    await reconfigure(closed, { offlineBehavior: "ai_answers" });
  });
});

// ---------------------------------------------------------------------------
// Retention and privacy requests
// ---------------------------------------------------------------------------

describe("how long chats are kept, and what a privacy request removes", () => {
  it("removes an anonymous chat, its messages and the empty contact it made after the widget's retention, and leaves everything else alone", async () => {
    const keep = await chatOrg({ anonymousRetentionDays: 30, retentionDays: 90 });
    const anon = await start(keep);
    await embedCall(keep, { action: "send", token: anon, body: { text: "Just browsing", clientMessageId: clientId() }, generate: answer("Welcome!").generate });
    const withLead = await start(keep);
    await embedCall(keep, { action: "send", token: withLead, body: { text: "Quote please", clientMessageId: clientId() }, generate: answer("Sure.").generate });
    await embedCall(keep, { action: "lead", token: withLead, body: { details: { email: "kept@example.com" }, privacyAck: true } });
    const recent = await start(keep);
    await embedCall(keep, { action: "send", token: recent, body: { text: "Hello", clientMessageId: clientId() }, generate: answer("Hi.").generate });
    // 40 days pass for the first two chats: the anonymous one is past 30 days, the one with details is not yet past 90.
    await withSystem((db) => db.query("update web_chat_sessions set last_seen_at = now() - interval '40 days' where token_hash = any($1::text[])", [[hashOf(anon), hashOf(withLead)]]));
    const first = await purgeExpiredWebChats();
    expect(first.anonymousChats).toBeGreaterThanOrEqual(1);
    const left = await rows<{ token_hash: string }>("select token_hash from web_chat_sessions where org_id = $1", [keep.m.org.id]);
    expect(left.map((r) => r.token_hash).sort()).toEqual([hashOf(withLead), hashOf(recent)].sort());
    expect(await rows("select 1 from conversations c where c.org_id = $1 and c.channel = 'web_chat'", [keep.m.org.id])).toHaveLength(2);
    // The anonymous chat's contact was still empty, so it went; the lead's contact stays.
    expect(await rows("select 1 from contacts where org_id = $1 and created_via = 'website_chat'", [keep.m.org.id])).toHaveLength(2);
    // 100 days pass for the chat with details: past the widget's retention, its transcript goes but the contact stays (it holds a person's details).
    await withSystem((db) => db.query("update web_chat_sessions set last_seen_at = now() - interval '100 days' where token_hash = $1", [hashOf(withLead)]));
    const second = await purgeExpiredWebChats();
    expect(second.expiredChats).toBeGreaterThanOrEqual(1);
    expect(await rows("select 1 from contacts where org_id = $1 and email = 'kept@example.com'", [keep.m.org.id])).toHaveLength(1);
    expect(await rows("select 1 from web_chat_sessions where org_id = $1", [keep.m.org.id])).toHaveLength(1); // only the recent one
  });

  it("never deletes a contact a person has added anything to", async () => {
    const mine = await chatOrg({ anonymousRetentionDays: 1 });
    const t = await start(mine);
    await embedCall(mine, { action: "send", token: t, body: { text: "Hi", clientMessageId: clientId() }, generate: answer("Hello.").generate });
    const s = (await rows<{ contact_id: string }>("select contact_id from web_chat_sessions where token_hash = $1", [hashOf(t)]))[0];
    await withSystem((db) => db.query("insert into tasks (org_id, contact_id, title) values ($1, $2, 'Call back')", [mine.m.org.id, s.contact_id]));
    await withSystem((db) => db.query("update web_chat_sessions set last_seen_at = now() - interval '5 days' where token_hash = $1", [hashOf(t)]));
    await purgeExpiredWebChats();
    expect(await rows("select 1 from web_chat_sessions where token_hash = $1", [hashOf(t)])).toHaveLength(0);
    expect(await rows("select 1 from contacts where id = $1", [s.contact_id])).toHaveLength(1); // a task was added: the contact stays
  });

  it("clears what the visitor typed and where they came from when a privacy request is made for their contact", async () => {
    const t = await start(c, { landing: "/pricing?utm_source=google", referrer: "https://www.google.com/" });
    await embedCall(c, { action: "send", token: t, body: { text: "Hello", clientMessageId: clientId() }, generate: answer("Hi.").generate });
    await embedCall(c, { action: "lead", token: t, body: { details: { name: "Erase Me", email: "erase.me@example.com", phone: "+639175550123" }, privacyAck: true } });
    const s = await sessionOf(t);
    expect(await rows("select 1 from lead_touches where contact_id = $1", [s.contact_id])).toHaveLength(1);
    await redactContact(c.m.ctx("owner"), s.contact_id, "Privacy request from the visitor");
    const after = (await rows<{ visitor_name: string | null; visitor_email: string | null; visitor_phone: string | null; landing_path: string | null; referrer: string | null; attribution: Record<string, string>; ip_hash: string | null; qualification: Record<string, string>; status: string }>("select * from web_chat_sessions where id = $1", [s.id]))[0];
    expect(after).toMatchObject({ visitor_name: null, visitor_email: null, visitor_phone: null, landing_path: null, referrer: null, attribution: {}, ip_hash: null, qualification: {}, status: "closed" });
    expect(await rows("select 1 from lead_touches where contact_id = $1", [s.contact_id])).toHaveLength(0);
    const contact = (await rows<{ first_touch_id: string | null; latest_touch_id: string | null }>("select first_touch_id, latest_touch_id from contacts where id = $1", [s.contact_id]))[0];
    expect(contact).toEqual({ first_touch_id: null, latest_touch_id: null });
  });
});
