// How an address a visitor only typed becomes confirmed: the customer writes from it (a message from a proven sender), or a person of the business confirms it and says
// how they know. And what the Inbox shows about it.
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { evaluateSend } from "@/server/messaging/send";
import { confirmContactIdentity, typedByVisitorAddress, verifyIdentityOnInbound } from "@/server/messaging/consent-identity";
import { getConversationDetail } from "@/server/messaging/inbox";
import { IdentityList, TYPED_HELP } from "@/components/inbox/identity-list";
import { inbound, phone } from "./support/messaging";
import { channelConversation, identityOf, nativeChatOrg, typedLead, uniqueEmail } from "./support/unverified";
import type { ChatOrg } from "./support/webchat";

const NOW = new Date("2026-10-21T12:00:00Z");
let c: ChatOrg;
let other: ChatOrg;
beforeAll(async () => {
  c = await nativeChatOrg();
  other = await nativeChatOrg();
});

const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;
const consentCount = async (contactId: string) => (await rows("select 1 from contact_consent_events where contact_id = $1", [contactId])).length;
const canFollowUp = async (conversationId: string) =>
  (await withSystem((db) => evaluateSend(db, { orgId: c.m.org.id, conversationId, scope: "followup", actor: { kind: "ai", agentId: c.m.salesAgentId }, body: "Just checking in.", businessHoursOnly: false, now: NOW }))).allow;

describe("a customer who writes from the number", () => {
  it("confirms a number the visitor typed, once a message comes from it through the carrier, and leaves consent as it was", async () => {
    const lead = await typedLead(c);
    const conv = await channelConversation(c, lead.contactId, "sms");
    expect(await canFollowUp(conv)).toBe(false);
    const consentBefore = await consentCount(lead.contactId);
    const r = await inbound(c.m.org.id, { provider: "twilio", channel: "sms", address: lead.phone!, ghlContactId: null, body: "Hi, it's Dana, I asked for a quote." });
    expect(r.contactId).toBe(lead.contactId); // matched by the exact number, to the chat's own contact
    expect(await identityOf(c.m.org.id, "phone", lead.phone!)).toMatchObject({ verified: true, verified_via: "provider_inbound" });
    expect(await consentCount(lead.contactId)).toBe(consentBefore); // consent was already on record; nothing new is invented
    // Only the number is confirmed: the typed email still is not, and the automated message to it is still refused.
    expect((await identityOf(c.m.org.id, "email", lead.email!)).verified).toBe(false);
    expect(await canFollowUp(conv)).toBe(true);
    const emailConv = await channelConversation(c, lead.contactId, "email");
    expect(await canFollowUp(emailConv)).toBe(false);
  });

  it("confirms the number from a WhatsApp message too", async () => {
    const lead = await typedLead(c);
    await inbound(c.m.org.id, { provider: "meta_whatsapp", channel: "whatsapp", address: lead.phone!, ghlContactId: null });
    expect((await identityOf(c.m.org.id, "phone", lead.phone!)).verified).toBe(true);
  });

  it("does not confirm a number from a message the receiving side did not prove", async () => {
    const lead = await typedLead(c);
    await inbound(c.m.org.id, { provider: "twilio", channel: "sms", address: lead.phone!, ghlContactId: null, senderVerified: false });
    expect((await identityOf(c.m.org.id, "phone", lead.phone!)).verified).toBe(false);
  });

  it("confirms an email address only when the receiving mail server authenticated the sender; a relay that says nothing, or an unauthenticated message, does not", async () => {
    const lead = await typedLead(c);
    await inbound(c.m.org.id, { provider: "ghl", channel: "email", address: lead.email!, subject: "Quote", ghlContactId: null });
    await inbound(c.m.org.id, { provider: "resend", channel: "email", address: lead.email!, subject: "Quote", senderVerified: false, ghlContactId: null });
    expect((await identityOf(c.m.org.id, "email", lead.email!)).verified).toBe(false);
    await inbound(c.m.org.id, { provider: "resend", channel: "email", address: lead.email!, subject: "Quote", senderVerified: true, ghlContactId: null });
    expect(await identityOf(c.m.org.id, "email", lead.email!)).toMatchObject({ verified: true, verified_via: "provider_inbound" });
  });

  it("confirms only the number that wrote, never another visitor's typed number", async () => {
    const a = await typedLead(c);
    const b = await typedLead(c);
    await inbound(c.m.org.id, { provider: "twilio", channel: "sms", address: a.phone!, ghlContactId: null });
    expect((await identityOf(c.m.org.id, "phone", a.phone!)).verified).toBe(true);
    expect((await identityOf(c.m.org.id, "phone", b.phone!)).verified).toBe(false);
  });

  it("does nothing for an address that is not on the contact, a contact of another workspace, or an identity that is already confirmed", async () => {
    const lead = await typedLead(c);
    const one = (orgId: string, contactId: string, address: string) => withSystem((db) => verifyIdentityOnInbound(db, { orgId, contactId, channel: "sms", address }));
    expect(await one(c.m.org.id, lead.contactId, phone())).toBe(false);
    expect(await one(other.m.org.id, lead.contactId, lead.phone!)).toBe(false);
    expect((await identityOf(c.m.org.id, "phone", lead.phone!)).verified).toBe(false);
    expect(await one(c.m.org.id, lead.contactId, lead.phone!)).toBe(true);
    expect(await one(c.m.org.id, lead.contactId, lead.phone!)).toBe(false);
  });

  it("is not undone or repeated by the same provider message arriving again", async () => {
    const lead = await typedLead(c);
    const args = { provider: "twilio", channel: "sms", address: lead.phone!, ghlContactId: null, providerMessageId: `dup-${lead.contactId}` } as const;
    const first = await inbound(c.m.org.id, args);
    const again = await inbound(c.m.org.id, args);
    expect(first.status).toBe("created");
    expect(again.status).toBe("duplicate");
    expect(await identityOf(c.m.org.id, "phone", lead.phone!)).toMatchObject({ verified: true, verified_via: "provider_inbound" });
  });

  it("leaves a contact the chat did not make exactly as it was treated before: its number is confirmed by writing too, and nothing else about it changes", async () => {
    const number = phone();
    const first = await inbound(c.m.org.id, { provider: "twilio", channel: "sms", address: number, ghlContactId: null });
    expect((await identityOf(c.m.org.id, "phone", number)).verified).toBe(true); // a texting number is proven by the carrier from the first message
    expect(await withSystem((db) => typedByVisitorAddress(db, c.m.org.id, first.contactId, "sms", number))).toBe(false);
  });
});

describe("a person of the business confirms it", () => {
  const confirm = (ctx: ReturnType<ChatOrg["m"]["ctx"]>, identityId: string, how = "I called the number and they answered.") => confirmContactIdentity(ctx, { identityId, how });

  it("records it on the address and in the audit trail with what the person said, and records no consent", async () => {
    const lead = await typedLead(c);
    const id = await identityOf(c.m.org.id, "phone", lead.phone!);
    const consentBefore = await consentCount(lead.contactId);
    const r = await confirm(c.m.ctx("owner"), id.id, "  I called   this number and Dana answered. ");
    expect(r).toEqual({ identityId: id.id, alreadyVerified: false });
    expect(await identityOf(c.m.org.id, "phone", lead.phone!)).toMatchObject({ verified: true, verified_via: "staff_confirmed" });
    expect(await consentCount(lead.contactId)).toBe(consentBefore);
    const audit = await rows<{ actor_user_id: string; actor_kind: string; target_type: string; target_id: string; result: string; metadata: Record<string, unknown> }>(
      "select actor_user_id, actor_kind, target_type, target_id, result, metadata from audit_logs where org_id = $1 and action = 'contact.identity_confirmed' and target_id = $2",
      [c.m.org.id, lead.contactId],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_user_id: c.m.people.owner.id, actor_kind: "user", target_type: "contact", result: "success", metadata: { identityKind: "phone", how: "I called this number and Dana answered." } });
    // The address itself never goes into the audit trail.
    expect(JSON.stringify(audit[0].metadata)).not.toContain(lead.phone!);
    expect((await identityOf(c.m.org.id, "email", lead.email!)).verified).toBe(false);
  });

  it("is safe to repeat: the second time says it was already confirmed and writes nothing more", async () => {
    const lead = await typedLead(c);
    const id = (await identityOf(c.m.org.id, "email", lead.email!)).id;
    await confirm(c.m.ctx("owner"), id);
    expect(await confirm(c.m.ctx("manager"), id)).toEqual({ identityId: id, alreadyVerified: true });
    expect(await rows("select 1 from audit_logs where org_id = $1 and action = 'contact.identity_confirmed' and target_id = $2", [c.m.org.id, lead.contactId])).toHaveLength(1);
    // An address the customer's own message already confirmed is left as it was confirmed.
    const viaMessage = await typedLead(c);
    await inbound(c.m.org.id, { provider: "twilio", channel: "sms", address: viaMessage.phone!, ghlContactId: null });
    expect((await confirm(c.m.ctx("owner"), (await identityOf(c.m.org.id, "phone", viaMessage.phone!)).id)).alreadyVerified).toBe(true);
    expect((await identityOf(c.m.org.id, "phone", viaMessage.phone!)).verified_via).toBe("provider_inbound");
  });

  it("belongs to the people who can edit contacts: the owner, managers, sales and support yes; a viewer no", async () => {
    for (const who of ["owner", "manager", "sales", "support"] as const) {
      const lead = await typedLead(c);
      const id = (await identityOf(c.m.org.id, "phone", lead.phone!)).id;
      expect((await confirm(c.m.ctx(who), id)).alreadyVerified, who).toBe(false);
    }
    const lead = await typedLead(c);
    const id = (await identityOf(c.m.org.id, "phone", lead.phone!)).id;
    await expect(confirm(c.m.ctx("viewer"), id)).rejects.toMatchObject({ code: "forbidden" });
    expect((await identityOf(c.m.org.id, "phone", lead.phone!)).verified).toBe(false);
  });

  it("asks for how the person knows, in their own words, within reason", async () => {
    const lead = await typedLead(c);
    const id = (await identityOf(c.m.org.id, "phone", lead.phone!)).id;
    for (const how of ["", "   ", "ok", "1234"]) await expect(confirm(c.m.ctx("owner"), id, how), JSON.stringify(how)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(confirm(c.m.ctx("owner"), id, "x".repeat(301))).rejects.toMatchObject({ code: "invalid_input" });
    expect((await identityOf(c.m.org.id, "phone", lead.phone!)).verified).toBe(false);
    await expect(confirm(c.m.ctx("owner"), id, "a".repeat(300))).resolves.toMatchObject({ alreadyVerified: false });
  });

  it("cannot reach another workspace's address, or an unknown one, or a removed contact's", async () => {
    const theirs = await typedLead(other);
    const theirId = (await identityOf(other.m.org.id, "phone", theirs.phone!)).id;
    const err = await confirm(c.m.ctx("owner"), theirId).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: "not_found" });
    expect((await identityOf(other.m.org.id, "phone", theirs.phone!)).verified).toBe(false);
    await expect(confirm(c.m.ctx("owner"), "00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({ code: "not_found" });
    const gone = await typedLead(c);
    const goneId = (await identityOf(c.m.org.id, "phone", gone.phone!)).id;
    await withSystem((db) => db.query("update contacts set deleted_at = now() where id = $1", [gone.contactId]));
    await expect(confirm(c.m.ctx("owner"), goneId)).rejects.toMatchObject({ code: "not_found" });
  });

  it("lets automatic messages reach the address from then on, subject to every other rule", async () => {
    const lead = await typedLead(c);
    const conv = await channelConversation(c, lead.contactId, "sms");
    expect(await canFollowUp(conv)).toBe(false);
    await confirm(c.m.ctx("owner"), (await identityOf(c.m.org.id, "phone", lead.phone!)).id);
    expect(await canFollowUp(conv)).toBe(true);
    // Withdrawn consent still wins.
    await withSystem((db) => db.query("insert into contact_consent_events (org_id, contact_id, channel, purpose, status, source) values ($1, $2, 'sms', 'service', 'revoked', 'stop_keyword')", [c.m.org.id, lead.contactId]));
    expect(await canFollowUp(conv)).toBe(false);
  });
});

describe("what the Inbox shows", () => {
  it("marks an address the visitor typed, and stops marking it once it is confirmed", async () => {
    const lead = await typedLead(c);
    const owner = c.m.ctx("owner");
    const detail = () => getConversationDetail(owner, lead.conversationId);
    const before = (await detail()).contact.identities;
    expect(before).toHaveLength(2);
    expect(before.every((i) => i.typedByVisitor && !i.verified && /^[0-9a-f-]{36}$/.test(i.id))).toBe(true);
    await confirmContactIdentity(owner, { identityId: before.find((i) => i.kind === "phone")!.id, how: "Confirmed on a call." });
    const after = (await detail()).contact.identities;
    expect(after.find((i) => i.kind === "phone")).toMatchObject({ verified: true, typedByVisitor: false });
    expect(after.find((i) => i.kind === "email")).toMatchObject({ verified: false, typedByVisitor: true });
  });

  it("does not call an unverified address typed into the CRM a visitor's", async () => {
    const address = uniqueEmail();
    const contactId = await withSystem(async (db) => {
      const k = await db.query<{ id: string }>("insert into contacts (org_id, display_name, created_via) values ($1, 'Typed by staff', 'manual') returning id", [c.m.org.id]);
      await db.query("insert into contact_identities (org_id, contact_id, kind, value, verified) values ($1, $2, 'email', $3, false)", [c.m.org.id, k.rows[0].id, address]);
      return k.rows[0].id;
    });
    expect(await withSystem((db) => typedByVisitorAddress(db, c.m.org.id, contactId, "email", address))).toBe(false);
  });
});

describe("the identity list in the contact panel", () => {
  const item = (over: Partial<Parameters<typeof IdentityList>[0]["identities"][number]> = {}) => ({ id: "11111111-1111-4111-8111-111111111111", kind: "phone", value: "+639170000001", verified: false, typedByVisitor: true, ...over });
  const html = (identities: Array<ReturnType<typeof item>>, canConfirm = true) => renderToStaticMarkup(React.createElement(IdentityList, { identities, canConfirm, onConfirm: vi.fn(async () => true) }));
  const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ");

  it("says an address was typed by the visitor, what that holds back, and offers the confirmation to people who can edit contacts", () => {
    const out = html([item()]);
    expect(text(out)).toContain("Typed by visitor");
    expect(text(out)).toContain(text(TYPED_HELP));
    expect(text(out)).toContain("Confirm it is theirs");
    expect(out).toContain("+639170000001");
  });

  it("offers nothing to someone who cannot edit contacts, but still says what the address is", () => {
    const out = html([item()], false);
    expect(text(out)).toContain("Typed by visitor");
    expect(text(out)).not.toContain("Confirm it is theirs");
  });

  it("shows a confirmed address as verified, and any other unverified address as unverified, with no confirmation offered", () => {
    const out = html([item({ verified: true, typedByVisitor: false, value: "+639170000002" }), item({ id: "22222222-2222-4222-8222-222222222222", typedByVisitor: false, verified: false, value: "pat@example.test", kind: "email" })]);
    expect(text(out)).toContain("Verified");
    expect(text(out)).toContain("Unverified");
    expect(text(out)).not.toContain("Confirm it is theirs");
    expect(text(out)).not.toContain(text(TYPED_HELP));
  });
});
