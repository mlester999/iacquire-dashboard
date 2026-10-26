// A merge must never turn what a website visitor only typed into something that looks confirmed. The typed state belongs to the address (contact_identities.typed_by_visitor)
// and to the consent event (its source), so it travels with them when two contacts become one. Every case drives the real chat form, the real merge and the real send chain.
import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { memberActor } from "@/server/crm/actor";
import { createContact, setContactConsent } from "@/server/crm/contacts";
import { getConversationDetail } from "@/server/messaging/inbox";
import { confirmContactIdentity, latestConsentSource, typedByVisitorAddress } from "@/server/messaging/consent-identity";
import { contactAddress, getConsent, mergeContacts, recordConsent } from "@/server/messaging/contacts";
import { evaluateSend, type SendRequest } from "@/server/messaging/send";
import { IDENTITY_UNVERIFIED_DETAIL, TYPED_CONSENT_SOURCE, typedByVisitorOnly, unverifiedIdentityRefusal } from "@/lib/webchat/identity";
import { phone } from "./support/messaging";
import { channelConversation, identityOf, nativeChatOrg, typedLead, uniqueEmail } from "./support/unverified";
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
const merge = (keptId: string, mergedId: string) => mergeContacts(owner(), { keptId, mergedId, reason: "Same person, confirmed by the team" });
const consentOf = (contactId: string, purpose: "service" | "marketing", channel: "sms" | "email" = "sms") => withSystem((db) => getConsent(db, c.m.org.id, contactId, channel, purpose));

/** A customer entered by hand, the way staff do: the address starts unverified and was not typed by a visitor. */
async function manual(over: { email?: string; phone?: string | null; consent?: boolean } = {}): Promise<{ id: string; email: string | null; phone: string | null }> {
  const actor = memberActor(owner());
  const email = over.email ?? null;
  const tel = over.phone ?? null;
  const k = await createContact(actor, { firstName: "Kim", lastName: crypto.randomUUID().slice(0, 6), email: email ?? undefined, phone: tel });
  if (over.consent) await setContactConsent(actor, k.id, { channel: "sms", purpose: "service", status: "granted", evidence: "Asked to be texted at the counter." });
  return { id: k.id, email, phone: tel };
}

// Who may reach an address that is still only typed: a person's own one-to-one message, and nothing else.
const automated = (): Array<{ name: string; req: Partial<SendRequest> }> => [
  { name: "an AI reply nobody approved", req: { scope: "reply", actor: ai() } },
  { name: "an AI follow-up", req: { scope: "followup", actor: ai() } },
  { name: "an appointment reminder", req: { scope: "reminder", actor: ai() } },
  { name: "a retention program message", req: { scope: "retention", actor: ai() } },
  { name: "a review request (a system send)", req: { scope: "retention", actor: system() } },
  { name: "an invoice reminder", req: { scope: "billing", actor: system(), purpose: "service" } },
  { name: "a promotional campaign", req: { scope: "retention", actor: system(), purpose: "marketing" } },
  { name: "a promotional message from a person", req: { scope: "human", actor: person(), purpose: "marketing" } },
];
const personsOwn = (): Array<{ name: string; req: Partial<SendRequest> }> => [
  { name: "a person's own one-to-one message", req: { scope: "human", actor: person() } },
  { name: "a person's reply", req: { scope: "reply", actor: person() } },
];

describe("the pure rule reads the address, not the contact it sits on", () => {
  it("applies to an unverified address a visitor typed, whatever kind of contact now holds it", () => {
    expect(typedByVisitorOnly({ typedByVisitor: true, verified: false })).toBe(true);
    expect(typedByVisitorOnly({ typedByVisitor: true, verified: true })).toBe(false);
    expect(typedByVisitorOnly({ typedByVisitor: true, verified: null })).toBe(false);
    expect(typedByVisitorOnly({ typedByVisitor: false, verified: false })).toBe(false);
    const facts = { actor: "system" as const, approvedByPerson: false, scope: "retention", purpose: "service" as const };
    expect(unverifiedIdentityRefusal({ typedByVisitor: true, verified: false }, facts)).toEqual({ reason: "identity_unverified", detail: IDENTITY_UNVERIFIED_DETAIL });
    expect(unverifiedIdentityRefusal({ typedByVisitor: false, verified: false }, facts)).toBeNull();
  });
});

describe("a typed chat contact merged into a customer entered by hand", () => {
  it("keeps the phone typed: nothing automated or promotional reaches it, a person's own message still can, and confirming it lifts the refusal", async () => {
    // The visitor types a new phone and an email the customer already has, then staff follow the "may already be in your CRM" notice and merge.
    const keptEmail = uniqueEmail();
    const kept = await manual({ email: keptEmail });
    const lead = await typedLead(c, { email: keptEmail, marketing: true });
    expect(await identityOf(c.m.org.id, "phone", lead.phone!)).toMatchObject({ contact_id: lead.contactId, verified: false });
    await merge(kept.id, lead.contactId);

    // The address moved with its typed state, and nothing about it looks confirmed.
    const moved = await identityOf(c.m.org.id, "phone", lead.phone!);
    expect(moved).toMatchObject({ contact_id: kept.id, verified: false, verified_via: null });
    expect((await rows<{ typed_by_visitor: boolean }>("select typed_by_visitor from contact_identities where id = $1", [moved.id]))[0].typed_by_visitor).toBe(true);
    expect(await withSystem((db) => typedByVisitorAddress(db, c.m.org.id, kept.id, "sms", lead.phone!))).toBe(true);

    // The consent that came with it keeps its source and its words: it is still the visitor's tick, not an agreement the customer gave the business.
    expect(await consentOf(kept.id, "service")).toBe("granted");
    expect(await consentOf(kept.id, "marketing")).toBe("granted");
    for (const purpose of ["service", "marketing"] as const) {
      expect(await withSystem((db) => latestConsentSource(db, c.m.org.id, kept.id, "sms", purpose))).toBe(TYPED_CONSENT_SOURCE);
    }
    const carried = await rows<{ source: string; evidence: string }>("select source, evidence from contact_consent_events where contact_id = $1 and channel = 'sms' order by id", [kept.id]);
    expect(carried).toHaveLength(2);
    for (const e of carried) {
      expect(e.source).toBe(TYPED_CONSENT_SOURCE);
      expect(e.evidence).toMatch(/^Typed by the visitor in the website chat, unverified\./);
      expect(e.evidence).toMatch(/merge/i);
    }

    const conv = await channelConversation(c, kept.id, "sms");
    for (const k of automated()) {
      expect(await decide(conv, k.req), k.name).toMatchObject({ allow: false, reason: "identity_unverified", detail: IDENTITY_UNVERIFIED_DETAIL, permanent: true });
    }
    for (const k of personsOwn()) expect((await decide(conv, k.req)).allow, k.name).toBe(true);

    // The inbox still shows it as typed, with its Confirm button.
    const detail = await getConversationDetail(owner(), conv);
    expect(detail.contact.identities.find((i) => i.value === lead.phone)).toMatchObject({ verified: false, typedByVisitor: true });

    // A person confirming the number is what lifts the refusal, for service messages; the visitor's promotional tick still does not count.
    await confirmContactIdentity(owner(), { identityId: moved.id, how: "I called the number and the customer answered." });
    expect(await withSystem((db) => typedByVisitorAddress(db, c.m.org.id, kept.id, "sms", lead.phone!))).toBe(false);
    for (const k of automated().filter((x) => x.req.purpose !== "marketing")) expect((await decide(conv, k.req)).allow, k.name).toBe(true);
    const promo = await decide(conv, { scope: "human", actor: person(), purpose: "marketing" });
    expect(promo).toMatchObject({ allow: false, reason: "no_consent" });
    expect((promo as { detail: string }).detail).toMatch(/ticked in the website chat/);
    await withSystem((db) => recordConsent(db, { orgId: c.m.org.id, contactId: kept.id, channel: "sms", purpose: "marketing", status: "granted", source: "staff_recorded", evidence: "The customer agreed on the phone.", recordedBy: c.m.people.owner.id }));
    expect((await decide(conv, { scope: "human", actor: person(), purpose: "marketing" })).allow).toBe(true);
  });

  it("is the same for a typed email, and a withdrawal on the chat contact still wins", async () => {
    const kept = await manual({ phone: phone() });
    const lead = await typedLead(c, { phone: kept.phone, email: uniqueEmail() });
    await withSystem((db) => recordConsent(db, { orgId: c.m.org.id, contactId: lead.contactId, channel: "email", purpose: "service", status: "revoked", source: "stop_keyword", evidence: "Unsubscribed." }));
    await merge(kept.id, lead.contactId);
    expect(await consentOf(kept.id, "service", "email")).toBe("revoked");
    const conv = await channelConversation(c, kept.id, "email");
    expect(await decide(conv, { scope: "human", actor: person() })).toMatchObject({ allow: false, reason: "no_consent" });

    const other = await manual({ phone: phone() });
    const typed = await typedLead(c, { phone: other.phone, email: uniqueEmail() });
    await merge(other.id, typed.contactId);
    const emailConv = await channelConversation(c, other.id, "email");
    expect(await decide(emailConv, { scope: "followup", actor: ai() })).toMatchObject({ allow: false, reason: "identity_unverified" });
    expect((await decide(emailConv, { scope: "human", actor: person() })).allow).toBe(true);
  });

  it("does not hand the visitor's consent for one number to the customer's own, different number", async () => {
    // The visitor's number is the older one, so only a deliberate preference for the number staff entered puts the customer's own first.
    const lead = await typedLead(c, { email: null, marketing: true });
    const own = phone();
    const kept = await manual({ phone: own });
    await merge(kept.id, lead.contactId);
    // The tick was for the number the visitor typed. The customer's own number has no agreement of its own, so none is invented for it.
    expect(await consentOf(kept.id, "service")).toBe("unknown");
    expect(await consentOf(kept.id, "marketing")).toBe("unknown");
    // Messages go to the address staff entered, not the one a visitor typed, even though the typed one is older.
    expect(await withSystem((db) => contactAddress(db, c.m.org.id, kept.id, "sms"))).toBe(own);
    const conv = await channelConversation(c, kept.id, "sms");
    expect(await decide(conv, { scope: "retention", actor: system() })).toMatchObject({ allow: false, reason: "no_consent" });
    // The typed number is still on the record, still typed.
    expect(await withSystem((db) => typedByVisitorAddress(db, c.m.org.id, kept.id, "sms", lead.phone!))).toBe(true);
  });
});

describe("the typed state follows the address through every merge", () => {
  it("stays typed when the merged-in contact is merged again into a third", async () => {
    const first = await manual({ email: uniqueEmail() });
    const second = await manual({ email: uniqueEmail() });
    const lead = await typedLead(c, { email: first.email, marketing: false });
    await merge(first.id, lead.contactId);
    await merge(second.id, first.id);
    expect(await withSystem((db) => typedByVisitorAddress(db, c.m.org.id, second.id, "sms", lead.phone!))).toBe(true);
    const conv = await channelConversation(c, second.id, "sms");
    expect(await decide(conv, { scope: "followup", actor: ai() })).toMatchObject({ allow: false, reason: "identity_unverified" });
  });

  it("does not mark a customer's own number as typed when a chat contact is the one that is kept", async () => {
    const lead = await typedLead(c, { email: null, marketing: false });
    const theirs = await manual({ phone: phone(), consent: true });
    await merge(lead.contactId, theirs.id);
    // The number staff entered keeps being reachable by the usual rules; the one the visitor typed does not.
    expect(await withSystem((db) => typedByVisitorAddress(db, c.m.org.id, lead.contactId, "sms", theirs.phone!))).toBe(false);
    expect(await withSystem((db) => typedByVisitorAddress(db, c.m.org.id, lead.contactId, "sms", lead.phone!))).toBe(true);
  });
});
