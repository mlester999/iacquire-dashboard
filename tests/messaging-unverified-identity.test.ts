// A phone number or email address that only a website visitor typed must not be reachable by anything automated or promotional, while a person's own reply stays
// possible; once the address is confirmed, the usual rules apply as before. The rule is evaluateSend's (src/lib/webchat/identity.ts has its pure half), so it is
// tested where every outbound message passes: the matrix of who is sending, what for, and on which channel.
import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { createContact, setContactConsent } from "@/server/crm/contacts";
import { memberActor } from "@/server/crm/actor";
import { recordConsent } from "@/server/messaging/contacts";
import { confirmContactIdentity } from "@/server/messaging/consent-identity";
import { evaluateSend, queueOutbound, type SendRequest } from "@/server/messaging/send";
import { BLOCK_REASON_LABELS } from "@/lib/messaging";
import { IDENTITY_UNVERIFIED_DETAIL, TYPED_CONSENT_SOURCE, typedByVisitorOnly, typedConsentEvidence, unverifiedIdentityRefusal, type DestinationFacts, type SendFacts } from "@/lib/webchat/identity";
import { channelConversation, identityOf, nativeChatOrg, typedLead } from "./support/unverified";
import type { ChatOrg } from "./support/webchat";

const NOW = new Date("2026-10-21T12:00:00Z"); // a Wednesday, midday UTC
let c: ChatOrg;
beforeAll(async () => {
  c = await nativeChatOrg();
});

const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;
const owner = () => c.m.ctx("owner");
const ai = (over: { approvalId?: string | null } = {}) => ({ kind: "ai" as const, agentId: c.m.salesAgentId, approvalId: over.approvalId ?? null });
const person = () => ({ kind: "human" as const, userId: c.m.people.sales.id });
const system = () => ({ kind: "system" as const, userId: c.m.people.owner.id });
const decide = (conversationId: string, over: Partial<SendRequest>) =>
  withSystem((db) => evaluateSend(db, { orgId: c.m.org.id, conversationId, scope: "reply", actor: ai(), body: "Thanks for getting in touch.", businessHoursOnly: false, now: NOW, ...over }));

interface Case {
  name: string;
  req: Partial<SendRequest>;
  /** Whether the message may reach an address a visitor only typed. */
  reachesTyped: boolean;
}
// Built when a test asks (the workspace and its people exist only after the set-up has run).
const cases = (): Case[] => [
  { name: "a person's own one-to-one message", req: { scope: "human", actor: person() }, reachesTyped: true },
  { name: "a person's reply", req: { scope: "reply", actor: person() }, reachesTyped: true },
  { name: "an AI reply that a person approved by name", req: { scope: "reply", actor: ai({ approvalId: crypto.randomUUID() }) }, reachesTyped: true },
  { name: "an AI reply nobody approved", req: { scope: "reply", actor: ai() }, reachesTyped: false },
  { name: "an AI follow-up", req: { scope: "followup", actor: ai() }, reachesTyped: false },
  { name: "an AI follow-up that a person approved (a workflow step)", req: { scope: "followup", actor: ai({ approvalId: crypto.randomUUID() }) }, reachesTyped: false },
  { name: "an appointment reminder", req: { scope: "reminder", actor: ai() }, reachesTyped: false },
  { name: "a retention program message", req: { scope: "retention", actor: ai() }, reachesTyped: false },
  { name: "a system send (a review request)", req: { scope: "followup", actor: system() }, reachesTyped: false },
  { name: "a promotional campaign", req: { scope: "retention", actor: system(), purpose: "marketing" }, reachesTyped: false },
  { name: "a promotional message from a person", req: { scope: "human", actor: person(), purpose: "marketing" }, reachesTyped: false },
];

describe("the pure rule", () => {
  const typed: DestinationFacts = { typedByVisitor: true, verified: false };
  const facts = (over: Partial<SendFacts> = {}): SendFacts => ({ actor: "ai", approvedByPerson: false, scope: "reply", purpose: "service", ...over });

  it("only ever applies to an unverified address that a visitor typed (the address carries that, whatever contact holds it)", () => {
    expect(typedByVisitorOnly(typed)).toBe(true);
    expect(typedByVisitorOnly({ typedByVisitor: true, verified: true })).toBe(false);
    expect(typedByVisitorOnly({ typedByVisitor: true, verified: null })).toBe(false);
    // An address nobody typed in the chat (staff entered it, a form, an import, a booking) is not covered, unverified or not.
    expect(typedByVisitorOnly({ typedByVisitor: false, verified: false })).toBe(false);
    expect(typedByVisitorOnly({ typedByVisitor: false, verified: null })).toBe(false);
    expect(unverifiedIdentityRefusal({ typedByVisitor: false, verified: false }, facts({ scope: "followup" }))).toBeNull();
  });

  it("refuses with the plain reason, and lets through only a person's one-to-one service message", () => {
    const refused = unverifiedIdentityRefusal(typed, facts());
    expect(refused).toEqual({ reason: "identity_unverified", detail: "The visitor typed this number or address and it has not been confirmed." });
    expect(IDENTITY_UNVERIFIED_DETAIL).toBe(refused?.detail);
    const allowed = (over: Partial<SendFacts>) => unverifiedIdentityRefusal(typed, facts(over)) === null;
    expect(allowed({ actor: "human", scope: "human" })).toBe(true);
    expect(allowed({ actor: "human", scope: "reply" })).toBe(true);
    expect(allowed({ actor: "ai", approvedByPerson: true, scope: "reply" })).toBe(true);
    for (const scope of ["followup", "reminder", "retention"] as const) {
      for (const actor of ["ai", "human", "system"] as const) expect(allowed({ actor, scope, approvedByPerson: true }), `${actor} ${scope}`).toBe(false);
    }
    // A scope added later is a program until someone decides otherwise: it fails closed.
    expect(allowed({ actor: "human", scope: "billing", approvedByPerson: true })).toBe(false);
    expect(allowed({ actor: "system", scope: "reply" })).toBe(false);
    expect(allowed({ actor: "ai", scope: "reply", approvedByPerson: false })).toBe(false);
    for (const actor of ["ai", "human", "system"] as const) expect(allowed({ actor, purpose: "marketing", approvedByPerson: true, scope: "human" }), actor).toBe(false);
  });

  it("covers every combination of sender, scope and purpose with one answer, and never lets an automated path through", () => {
    for (const actor of ["ai", "human", "system"] as const) {
      for (const approvedByPerson of [false, true]) {
        for (const scope of ["reply", "followup", "human", "reminder", "retention"] as const) {
          for (const purpose of ["service", "marketing"] as const) {
            const out = unverifiedIdentityRefusal(typed, { actor, approvedByPerson, scope, purpose });
            const personWrote = actor === "human" || (actor === "ai" && approvedByPerson);
            const oneToOne = personWrote && !["followup", "reminder", "retention"].includes(scope);
            expect(out === null, `${actor}/${approvedByPerson}/${scope}/${purpose}`).toBe(oneToOne && purpose === "service");
          }
        }
      }
    }
  });

  it("states in the consent evidence that the details were typed by the visitor and not checked", () => {
    const evidence = typedConsentEvidence("A team member may contact you.", "www.example.test");
    expect(evidence).toMatch(/^Typed by the visitor in the website chat, unverified\./);
    expect(evidence).toContain("A team member may contact you.");
    expect(evidence).toContain("www.example.test");
    expect(BLOCK_REASON_LABELS.identity_unverified).toMatch(/visitor typed/);
  });
});

describe("what the details form records", () => {
  it("keeps the grant but states in its evidence that the visitor typed the details and nobody checked them", async () => {
    const lead = await typedLead(c, { marketing: true });
    const events = await rows<{ channel: string; purpose: string; status: string; source: string; evidence: string }>(
      "select channel, purpose, status, source, evidence from contact_consent_events where contact_id = $1 order by id",
      [lead.contactId],
    );
    expect(events.length).toBe(4); // service and promotional, for email and for sms
    for (const e of events) {
      expect(e).toMatchObject({ status: "granted", source: TYPED_CONSENT_SOURCE });
      expect(e.evidence).toMatch(/^Typed by the visitor in the website chat, unverified\./);
      expect(e.evidence).toMatch(/may contact you about your enquiry/);
    }
    expect(events.filter((e) => e.purpose === "marketing").every((e) => /ticked the box to receive offers/.test(e.evidence))).toBe(true);
    expect((await identityOf(c.m.org.id, "phone", lead.phone!)).verified).toBe(false);
    expect((await identityOf(c.m.org.id, "email", lead.email!)).verified).toBe(false);
  });
});

describe("evaluateSend to an address a visitor typed", () => {
  for (const channel of ["sms", "email"] as const) {
    describe(`on ${channel}`, () => {
      it("lets only a person's one-to-one message through, and refuses everything else with the plain reason", async () => {
        const lead = await typedLead(c);
        const conv = await channelConversation(c, lead.contactId, channel);
        for (const k of cases()) {
          const d = await decide(conv, k.req);
          if (k.reachesTyped) expect(d.allow, k.name).toBe(true);
          else expect(d, k.name).toMatchObject({ allow: false, reason: "identity_unverified", detail: IDENTITY_UNVERIFIED_DETAIL, permanent: true });
        }
      });

      it("lets the usual rules apply again once the address is confirmed, whichever way it was", async () => {
        const lead = await typedLead(c);
        const conv = await channelConversation(c, lead.contactId, channel);
        const typed = channel === "sms" ? lead.phone! : lead.email!;
        const kind = channel === "sms" ? "phone" : "email";
        const id = await identityOf(c.m.org.id, kind, typed);
        await confirmContactIdentity(owner(), { identityId: id.id, how: "I called them on it and they answered." });
        expect(await identityOf(c.m.org.id, kind, typed)).toMatchObject({ verified: true, verified_via: "staff_confirmed" });
        for (const k of cases().filter((x) => x.req.purpose !== "marketing")) {
          expect((await decide(conv, k.req)).allow, k.name).toBe(true);
        }
      });
    });
  }

  it("is the same on WhatsApp: the rule looks at the number the visitor typed, before WhatsApp's own window rule", async () => {
    const lead = await typedLead(c);
    const conv = await channelConversation(c, lead.contactId, "whatsapp");
    expect(await decide(conv, { scope: "followup" })).toMatchObject({ allow: false, reason: "identity_unverified" });
    expect(await decide(conv, { scope: "retention", actor: system(), purpose: "marketing" })).toMatchObject({ allow: false, reason: "identity_unverified" });
    // A person's own message passes this rule and meets the others: the form recorded consent for email and SMS only, and no WhatsApp window is open.
    const own = await decide(conv, { scope: "human", actor: person() });
    expect(own).toMatchObject({ allow: false });
    expect((own as { reason: string }).reason).not.toBe("identity_unverified");
  });

  it("refuses the promotional message even from a person while the address is unconfirmed, and then asks for the agreement to be recorded again", async () => {
    const lead = await typedLead(c, { marketing: true });
    const conv = await channelConversation(c, lead.contactId, "sms");
    const promo: Partial<SendRequest> = { scope: "human", actor: person(), purpose: "marketing" };
    expect(await decide(conv, promo)).toMatchObject({ allow: false, reason: "identity_unverified" });
    const id = await identityOf(c.m.org.id, "phone", lead.phone!);
    await confirmContactIdentity(owner(), { identityId: id.id, how: "Confirmed on a call." });
    // The tick was made by whoever typed the number. Confirming the number does not make it the customer's own agreement.
    const after = await decide(conv, promo);
    expect(after).toMatchObject({ allow: false, reason: "no_consent" });
    expect((after as { detail: string }).detail).toMatch(/ticked in the website chat/);
    // A person recording the agreement with the customer is what makes promotional messages possible.
    await withSystem((db) => recordConsent(db, { orgId: c.m.org.id, contactId: lead.contactId, channel: "sms", purpose: "marketing", status: "granted", source: "staff_recorded", evidence: "The customer agreed on the phone.", recordedBy: c.m.people.owner.id }));
    expect((await decide(conv, promo)).allow).toBe(true);
    // And a withdrawal still wins over everything.
    await withSystem((db) => recordConsent(db, { orgId: c.m.org.id, contactId: lead.contactId, channel: "sms", purpose: "marketing", status: "revoked", source: "stop_keyword" }));
    expect(await decide(conv, promo)).toMatchObject({ allow: false, reason: "no_consent" });
  });

  it("does not need a promotional tick to refuse one: without the box ticked it says there is no agreement, once the address is confirmed", async () => {
    const lead = await typedLead(c, { marketing: false });
    const conv = await channelConversation(c, lead.contactId, "email");
    await confirmContactIdentity(owner(), { identityId: (await identityOf(c.m.org.id, "email", lead.email!)).id, how: "They replied from it." });
    const d = await decide(conv, { scope: "retention", actor: system(), purpose: "marketing" });
    expect(d).toMatchObject({ allow: false, reason: "no_consent" });
    expect((d as { detail: string }).detail).toMatch(/has not agreed to promotional messages/);
  });

  it("leaves every other contact alone: an address someone typed into the CRM, or a form, is reachable as before", async () => {
    const actor = memberActor(owner());
    const manual = await createContact(actor, { firstName: "Mina", lastName: "Cruz", phone: "+639178880001" });
    await setContactConsent(actor, manual.id, { channel: "sms", purpose: "service", status: "granted", evidence: "Asked to be texted at the counter." });
    expect((await rows<{ verified: boolean }>("select verified from contact_identities where contact_id = $1", [manual.id]))[0].verified).toBe(false);
    const conv = await channelConversation(c, manual.id, "sms");
    for (const k of cases().filter((x) => x.req.purpose !== "marketing")) expect((await decide(conv, k.req)).allow, k.name).toBe(true);
  });
});

describe("what is visible when it is refused", () => {
  it("records an AI message to such an address as blocked with the reason, for the inbox to show, and refuses a person's promotional message with the reason", async () => {
    const lead = await typedLead(c);
    const conv = await channelConversation(c, lead.contactId, "sms");
    const queued = await withSystem((db) => queueOutbound(db, { orgId: c.m.org.id, conversationId: conv, scope: "followup", actor: ai(), body: "Just checking in.", now: NOW, businessHoursOnly: false }));
    expect(queued).toMatchObject({ status: "blocked", reason: "identity_unverified", detail: IDENTITY_UNVERIFIED_DETAIL });
    const stored = (await rows<{ status: string; blocked_reason: string }>("select status, blocked_reason from conversation_messages where id = $1", [queued.messageId]))[0];
    expect(stored).toEqual({ status: "blocked", blocked_reason: "identity_unverified" });
    const err = await withSystem((db) => queueOutbound(db, { orgId: c.m.org.id, conversationId: conv, scope: "human", actor: person(), purpose: "marketing", body: "Offers!", now: NOW })).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).message).toMatch(/visitor typed this number or address and it has not been confirmed/);
  });

  it("queues a person's own reply to such an address, because that is the one thing still possible", async () => {
    const lead = await typedLead(c);
    const conv = await channelConversation(c, lead.contactId, "email");
    const queued = await withSystem((db) => queueOutbound(db, { orgId: c.m.org.id, conversationId: conv, scope: "human", actor: person(), body: "Hello Dana, here is your quote.", now: NOW }));
    expect(queued.status).toBe("queued");
  });
});

describe("another workspace's visitor details", () => {
  it("never reach this workspace's rules: the rule reads the contact in the conversation's own workspace", async () => {
    const other = await nativeChatOrg();
    const lead = await typedLead(other);
    const conv = await channelConversation(other, lead.contactId, "sms");
    // Asked through this workspace, a conversation of another one is simply not found.
    await expect(decide(conv, { scope: "followup" })).rejects.toThrow(/Conversation not found/);
  });
});
