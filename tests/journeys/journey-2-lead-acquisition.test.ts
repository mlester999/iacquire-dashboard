// Journey 2: a website visitor becomes a lead with a recorded source, and the Lead Sources report counts it.
//
// One visitor arrives from a campaign, the website chat captures the details they typed, the attribution service records where the visit came from, and the
// attribution report reads that record back. A second visitor is stopped by the same form because they did not confirm the privacy notice: nothing is captured
// for them, so the report is not inflated by a contact nobody agreed to.
//
// External boundaries, simulated here and only here:
//   * the language model: tests/support/webchat.ts answer() is a stub that returns fixed text and records what it was asked; nothing is generated;
//   * the messaging provider: no message is dispatched in this journey. The send chain is asked for a decision with evaluateSend, which is where the rule that
//     refuses an address only a visitor typed lives; a person's one-to-one reply is allowed and a follow-up or a promotion is refused before any provider is
//     chosen.
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { memberActor } from "@/server/crm/actor";
import { attributionReport } from "@/server/attribution/report";
import { evaluateSend, type SendRequest } from "@/server/messaging/send";
import { IDENTITY_UNVERIFIED_DETAIL, TYPED_CONSENT_SOURCE } from "@/lib/webchat/identity";
import { answer, bodyOf, clientId, embedCall, hashOf, start, viewOf } from "../support/webchat";
import { channelConversation, identityOf, nativeChatOrg, uniqueEmail } from "../support/unverified";
import { phone } from "../support/messaging";

const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;

const sessionOf = async (orgId: string, token: string) =>
  (await rows<{ id: string; contact_id: string | null; conversation_id: string | null; lead_captured_at: Date | null; privacy_ack_at: Date | null; marketing_opt_in: boolean }>(
    "select id, contact_id, conversation_id, lead_captured_at, privacy_ack_at, marketing_opt_in from web_chat_sessions where org_id = $1 and token_hash = $2", [orgId, hashOf(token)],
  ))[0];

describe("a website chat visitor becomes a lead the report can count", () => {
  it("captures the typed details, records the campaign the visit carried, and counts one lead; a visitor who did not agree is captured by neither", async () => {
    // A workspace whose SMS and email go out through native providers, so the send chain can reach a contact's own address (no outside system is called here).
    const c = await nativeChatOrg({ offerMarketingOptIn: true });
    const orgId = c.m.org.id;
    const owner = memberActor(c.m.ctx("owner"));
    const typedPhone = phone();
    const typedEmail = uniqueEmail();

    // 1. The visitor arrives from a campaign and opens the chat. The landing address is what records the campaign; the referring site is recorded too.
    const token = await start(c, {
      landing: "/pricing?utm_source=google&utm_medium=cpc&utm_campaign=roofing-journey",
      referrer: "https://www.google.com/",
    });
    const visit = (await rows<{ landing_path: string; referrer: string; attribution: Record<string, string> }>("select landing_path, referrer, attribution from web_chat_sessions where token_hash = $1", [hashOf(token)]))[0];
    expect(visit.landing_path).toBe("/pricing");
    expect(visit.attribution).toMatchObject({ utm_source: "google", utm_medium: "cpc", utm_campaign: "roofing-journey" });

    // 2. Their first message creates the chat's own contact and conversation, and records the touch that says where the visit came from. The model is the
    // stand-in: it is asked once, and its answer is stored as the assistant's reply.
    const reply = answer("Happy to help with your roof. What is the address?");
    const sent = await embedCall(c, { action: "send", token, body: { text: "I need a quote for a roof leak", clientMessageId: clientId() }, generate: reply.generate });
    expect(sent.status).toBe(200);
    expect(reply.calls).toHaveLength(1);
    const afterMessage = await sessionOf(orgId, token);
    expect(afterMessage.contact_id).toBeTruthy();
    expect(afterMessage.conversation_id).toBeTruthy();

    const touches = await rows<{ kind: string; source: string; medium: string | null; campaign: string | null; confidence: string; evidence: string }>(
      "select kind, source, medium, campaign, confidence, evidence from lead_touches where org_id = $1 and contact_id = $2 order by id", [orgId, afterMessage.contact_id],
    );
    expect(touches).toHaveLength(1);
    // An explicit campaign tag is "known": it is what the visit carried, not a guess about the referring site.
    expect(touches[0]).toMatchObject({ kind: "website_chat", source: "google", medium: "cpc", campaign: "roofing-journey", confidence: "known", evidence: "utm" });
    const [contact] = await rows<{ first_touch_id: string | null; latest_touch_id: string | null; created_via: string }>("select first_touch_id, latest_touch_id, created_via from contacts where id = $1", [afterMessage.contact_id]);
    expect(contact.created_via).toBe("website_chat");
    expect(contact.first_touch_id).not.toBeNull();
    expect(contact.latest_touch_id).toBe(contact.first_touch_id);

    // 3. They send the details form. The lead is captured, the details land on the chat's own contact as unverified (a stranger typed them), and the consent
    // to be contacted is recorded with the wording the form showed. Marketing is not granted: the box was not ticked.
    const lead = await embedCall(c, { action: "lead", token, body: { details: { name: "Dana Lee", email: typedEmail, phone: typedPhone }, privacyAck: true, marketingOptIn: false } });
    expect(lead.status).toBe(200);
    expect(viewOf(lead).leadCaptured).toBe(true);
    const captured = await sessionOf(orgId, token);
    expect(captured.lead_captured_at).not.toBeNull();
    expect(captured.privacy_ack_at).not.toBeNull();
    expect(captured.marketing_opt_in).toBe(false);
    expect(captured.contact_id).toBe(afterMessage.contact_id);

    const consent = await rows<{ channel: string; purpose: string; status: string; source: string; evidence: string }>(
      "select channel, purpose, status, source, evidence from contact_consent_events where org_id = $1 and contact_id = $2 order by channel, purpose", [orgId, captured.contact_id],
    );
    expect(consent.map((e) => `${e.channel}:${e.purpose}`)).toEqual(["email:service", "sms:service"]);
    for (const e of consent) {
      expect(e).toMatchObject({ status: "granted", source: TYPED_CONSENT_SOURCE });
      // The record says, in so many words, that the visitor typed the details and nobody checked them.
      expect(e.evidence).toMatch(/^Typed by the visitor in the website chat, unverified\./);
    }
    const emailIdentity = await identityOf(orgId, "email", typedEmail);
    const phoneIdentity = await identityOf(orgId, "phone", typedPhone);
    expect(emailIdentity).toMatchObject({ verified: false, contact_id: captured.contact_id });
    expect(phoneIdentity).toMatchObject({ verified: false, contact_id: captured.contact_id });

    // 4. The visitor-typed-contact rule refuses anything automatic or promotional at that number or address, while a person's own one-to-one reply is still
    // allowed. The decision is the send chain's, so this is where every outbound message passes.
    const conversationId = await channelConversation(c, captured.contact_id as string, "sms");
    const decide = (over: Partial<SendRequest>) =>
      withSystem((db) => evaluateSend(db, {
        orgId, conversationId, scope: "reply", actor: { kind: "ai", agentId: c.m.salesAgentId, approvalId: null }, body: "Thanks for getting in touch.", businessHoursOnly: false, ...over,
      }));
    // An AI follow-up nobody approved, to a number the visitor typed: refused, and the reason names the unconfirmed address.
    expect(await decide({ scope: "followup" })).toMatchObject({ allow: false, reason: "identity_unverified", detail: IDENTITY_UNVERIFIED_DETAIL });
    // A promotion from a person: also refused while the address is unconfirmed, even though the person is allowed to write one-to-one.
    expect(await decide({ scope: "human", actor: { kind: "human", userId: c.m.people.sales.id }, purpose: "marketing" })).toMatchObject({ allow: false, reason: "identity_unverified" });
    // The exception the rule keeps: a person answering this visitor, about their enquiry.
    expect(await decide({ scope: "reply", actor: { kind: "human", userId: c.m.people.sales.id } })).toMatchObject({ allow: true });

    // 5. A second visitor opens the chat and tries the details form without confirming the privacy notice. The form refuses, and nothing is captured: no lead
    // time, no contact, no consent and no touch. This is the consent rule, not a client-side check: the refusal comes from the server's own lead capture.
    const blockedToken = await start(c, { landing: "/pricing?utm_source=google&utm_medium=cpc&utm_campaign=roofing-journey" });
    const blockedEmail = uniqueEmail();
    const blocked = await embedCall(c, { action: "lead", token: blockedToken, body: { details: { email: blockedEmail }, privacyAck: false } });
    expect(blocked.status).toBe(400);
    expect(bodyOf(blocked).error?.message).toMatch(/privacy notice/i);
    const blockedSession = await sessionOf(orgId, blockedToken);
    expect(blockedSession).toMatchObject({ lead_captured_at: null, privacy_ack_at: null, contact_id: null, conversation_id: null });
    expect(await rows("select 1 from contacts where org_id = $1 and email = $2", [orgId, blockedEmail])).toHaveLength(0);
    expect(await rows("select 1 from lead_touches where org_id = $1 and contact_id = $2", [orgId, captured.contact_id])).toHaveLength(1);

    // 6. The Lead Sources report counts the lead once, under the campaign's source. The window is chosen around the moment the records were written (the
    // database stamps them); the report itself is read as of a fixed instant so its "revenue to date" answers do not drift while it runs.
    const asOf = new Date();
    const report = await attributionReport(owner, { startsAt: new Date(asOf.getTime() - 3_600_000), endsAt: new Date(asOf.getTime() + 3_600_000), asOf });
    expect(report.totals.leads).toBe(1);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({ source: "google", label: "Google", leads: 1, known: 1, inferred: 0, unknown: 0 });
    // Nothing was credited to a source nobody recorded, and the blocked visitor added no second lead.
    expect(report.rows.some((r) => r.source === "no-touch-recorded")).toBe(false);

    // The first-touch and latest-touch readings agree here: one touch, so the report is the same whichever model is asked for.
    const latest = await attributionReport(owner, { startsAt: new Date(asOf.getTime() - 3_600_000), endsAt: new Date(asOf.getTime() + 3_600_000), model: "latest", asOf });
    expect(latest.totals.leads).toBe(1);
    expect(latest.rows[0]).toMatchObject({ source: "google", leads: 1 });
  });
});
