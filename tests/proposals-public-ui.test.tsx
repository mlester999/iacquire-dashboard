// The customer's proposal page, rendered from real service output (a seeded synthetic workspace), not hand-written fixtures. It checks what a customer is told and not told, that
// each state shows the right forms and only those, that nothing prints undefined / NaN / [object Object], that a person's typing can never become markup, and the accessibility
// basics a static render can show (one h1, labelled fields, status and alert roles). The browser behaviours (the viewed beacon, the layout at 375 and 1280) are for the lead's check.
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { Wording, ProposalDocument } from "@/components/proposals/public/document";
import { noticeFor, PublicProposal } from "@/components/proposals/public/public-proposal";
import { CODE_TEXT, DECIDE_TEXT, PUBLIC_STATE_TEXT } from "@/lib/proposals/share";
import { decideOnProposal, loadPublicProposal, type PublicProposalView } from "@/server/proposals/public";
import { freeze } from "@/lib/proposals/snapshot";
import { emptyDoc } from "@/lib/proposals/doc";
import { withdrawProposal } from "@/server/proposals/proposals";
import { freshIp, NOW, proposalOrg, sentWithLink, verifiedSession } from "./support/proposals";

const BAD = /undefined|NaN|\[object Object\]|>null<|\bnull\b/;
const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");
const page = (token: string, view: PublicProposalView, opts: { result?: ReturnType<typeof noticeFor>; code?: ReturnType<typeof noticeFor> } = {}) =>
  html(<PublicProposal token={token} view={view} result={opts.result ?? null} code={opts.code ?? null} />);
const ctx = (sessionToken?: string | null) => ({ ip: freshIp(), now: NOW, sessionToken });

describe("an open proposal, before the code", () => {
  it("shows the document and the way to answer, and offers neither an accept button nor an acknowledgement yet", async () => {
    const p = await proposalOrg();
    await withSystem((db) => db.query("insert into company_profiles (org_id, brand_color, contact_email) values ($1, '#1d4ed8', 'hello@acme.example') on conflict (org_id) do update set brand_color = excluded.brand_color, contact_email = excluded.contact_email", [p.org.id]));
    const { token } = await sentWithLink(p, { validUntil: "2026-11-30" });
    const view = await loadPublicProposal(token, ctx());
    const markup = page(token, view);
    const t = text(markup);
    expect(t).not.toMatch(BAD);
    for (const needle of ["Proposal P-0001", "Version 1", "Website proposal", "Prepared for", "Maria Santos", "Valid until", "November 30, 2026", "Investment", "Website build", "USD 1,680.00", "Terms", "Payment is due within 14 days.", p.org.name, "Download PDF", "Your answer"]) {
      expect(t, needle).toContain(needle);
    }
    // One level-one heading, and the sections under it.
    expect((markup.match(/<h1\b/g) ?? []).length).toBe(1);
    expect(markup).toContain('href="#proposal-main"');
    expect(markup).toContain(`href="/proposal/${token}/pdf"`);
    // The code forms post to the proposals API, work without scripts, and every field is labelled.
    expect(markup).toContain(`action="/api/public/proposals/${token}/code"`);
    expect(markup).toContain(`action="/api/public/proposals/${token}/verify"`);
    expect((markup.match(/<form[^>]*method="post"/g) ?? []).length).toBe(2);
    expect(markup).toMatch(/<label[^>]*for="proposal-code"[^>]*>6-digit code<\/label>/);
    const codeInput = /<input[^>]*id="proposal-code"[^>]*>/.exec(markup)?.[0] ?? "";
    for (const attr of ['name="code"', 'autoComplete="one-time-code"', 'inputMode="numeric"', 'required=""']) expect(codeInput, attr).toContain(attr);
    expect(t).toContain("m***@example.test");
    expect(t).toContain("It is not a signature");
    expect(markup).not.toContain('name="decision"');
    expect(markup).not.toContain('name="ack"');
    expect(t).not.toContain("Accept this proposal");
    expect(t).not.toContain("I confirm I have reviewed");
    // Nothing of the team's, and nothing that is a credential, is printed.
    expect(markup).not.toMatch(/token_hash|internal_notes|catalogItemId/);
  });

  it("says plainly when the business has no address on file, and gives their contact details instead of a code form", async () => {
    const p = await proposalOrg();
    await withSystem((db) => db.query("insert into company_profiles (org_id, contact_email) values ($1, 'hello@acme.example') on conflict (org_id) do update set contact_email = excluded.contact_email", [p.org.id]));
    const { token } = await sentWithLink(p, { clientEmail: null });
    const markup = page(token, await loadPublicProposal(token, ctx()));
    expect(text(markup)).toContain("has no email address on file for you");
    expect(markup).toContain('href="mailto:hello@acme.example"');
    expect(markup).not.toContain("/code");
  });

  it("warns on the last day, in the words of a reminder, not an alarm", async () => {
    const p = await proposalOrg();
    const { token } = await sentWithLink(p, { validUntil: "2026-11-30" });
    const markup = page(token, await loadPublicProposal(token, { ip: freshIp(), now: new Date("2026-11-30T10:00:00Z") }));
    expect(text(markup)).toContain("Today is the last day this proposal can be accepted (valid until November 30, 2026).");
  });
});

describe("a verified customer", () => {
  it("sees the three ways to answer, each its own form, with the acknowledgement sentence beside its box and the version's hash in each", async () => {
    const p = await proposalOrg();
    const { token, email } = await sentWithLink(p);
    const session = await verifiedSession(token, email);
    const view = await loadPublicProposal(token, ctx(session));
    const markup = page(token, view);
    const t = text(markup);
    expect(t).not.toMatch(BAD);
    expect(t).toContain("Email confirmed: m***@example.test");
    expect((markup.match(new RegExp(`action="/api/public/proposals/${token}/decide"`, "g")) ?? []).length).toBe(3);
    expect(markup).toContain('value="accept"');
    expect(markup).toContain('value="request_changes"');
    expect(markup).toContain('value="decline"');
    expect((markup.match(new RegExp(`name="h" value="${view.proposal?.contentHash}"`, "g")) ?? []).length).toBe(3);
    // The tick box is required and sits in a label with the full sentence, which says what it is and what it is not.
    const tick = /<label[^>]*>\s*<input type="checkbox"[^>]*>/.exec(markup)?.[0] ?? "";
    for (const attr of ['name="ack"', 'value="1"', 'required=""']) expect(tick, attr).toContain(attr);
    expect(t).toContain("I confirm I have reviewed proposal P-0001 (version 1).");
    expect(t).toContain("It is not an electronic signature and has not been verified by a signing service.");
    expect(t).toContain("Accept this proposal");
    expect(t).toContain("Decline this proposal");
    expect(markup).toMatch(/<label[^>]*for="proposal-changes"[^>]*>Ask for changes<\/label>/);
    expect(markup).toMatch(/<textarea[^>]*id="proposal-changes"[^>]*required=""/);
    // Phones get 16 px fields (no zoom on focus) and full-width buttons.
    expect(markup).toContain("text-[16px]");
    expect(markup).toContain("w-full");
  });

  it("is not offered acceptance for a proposal that needs a signature, and is told why", async () => {
    const p = await proposalOrg();
    const { token, email, proposal } = await sentWithLink(p);
    await withSystem((db) => db.query("update proposals set requires_signature = true where id = $1", [proposal.id]));
    const session = await verifiedSession(token, email);
    const markup = page(token, await loadPublicProposal(token, ctx(session)));
    const t = text(markup);
    expect(markup).not.toContain('name="ack"');
    expect(markup).not.toContain('value="accept"');
    expect(t).not.toContain("Accept this proposal");
    expect(t).toContain("accepted by signing a document");
    expect(t).toContain("They haven't sent it yet");
    expect(markup).toContain('value="request_changes"');
    expect(markup).toContain('value="decline"');
  });

  it("is told how many times they have already asked for changes", async () => {
    const p = await proposalOrg();
    const { token, email } = await sentWithLink(p);
    const session = await verifiedSession(token, email);
    await decideOnProposal(token, { decision: "request_changes", note: "Lower the price" }, ctx(session));
    await decideOnProposal(token, { decision: "request_changes", note: "Add a care plan" }, ctx(session));
    expect(text(page(token, await loadPublicProposal(token, ctx(session))))).toContain("asked");
    expect(text(page(token, await loadPublicProposal(token, ctx(session))))).toContain("for changes 2 times");
  });
});

describe("after the answer", () => {
  it("shows the record, in its own words, with no forms, and the document and PDF still there", async () => {
    const p = await proposalOrg();
    const { token, email } = await sentWithLink(p);
    const session = await verifiedSession(token, email);
    await decideOnProposal(token, { decision: "accept", acknowledged: "1" }, ctx(session));
    const view = await loadPublicProposal(token, ctx(session));
    const markup = page(token, view);
    const t = text(markup);
    expect(view.state).toBe("answered");
    expect(t).toContain("Your answer");
    expect(t).toContain("Accepted.");
    expect(t).toContain("It was recorded with the email address m***@example.test, which you confirmed with a code. That is a record of your answer, not an electronic signature.");
    expect(t).toContain(`${p.org.name} has been told.`);
    expect(markup).not.toMatch(/<form\b/);
    expect(markup).toContain(`href="/proposal/${token}/pdf"`);
    expect(t).toContain("Website build");
    expect(t).not.toMatch(BAD);
  });

  it("words a decline as a decline", async () => {
    const p = await proposalOrg();
    const { token, email } = await sentWithLink(p);
    const session = await verifiedSession(token, email);
    await decideOnProposal(token, { decision: "decline" }, ctx(session));
    const t = text(page(token, await loadPublicProposal(token, ctx(session))));
    expect(t).toContain("Declined.");
    expect(t).toContain("You declined this proposal");
    expect(t).not.toContain("Accepted.");
  });
});

describe("a link that cannot be used", () => {
  it("shows one calm message per state, with the business's contact details where they are known, and never the document", async () => {
    const p = await proposalOrg();
    await withSystem((db) => db.query("insert into company_profiles (org_id, contact_email, contact_phone) values ($1, 'hello@acme.example', '+639175550100') on conflict (org_id) do update set contact_email = excluded.contact_email, contact_phone = excluded.contact_phone", [p.org.id]));
    const { token, proposal } = await sentWithLink(p, { validUntil: "2026-11-30" });
    const expired = await loadPublicProposal(token, { ip: freshIp(), now: new Date("2026-12-05T00:00:00Z") });
    const m1 = page(token, expired);
    expect(text(m1)).toContain(PUBLIC_STATE_TEXT.expired.title);
    expect(text(m1)).toContain(PUBLIC_STATE_TEXT.expired.body);
    expect(m1).toContain('href="mailto:hello@acme.example"');
    expect(m1).toContain('href="tel:+639175550100"');
    expect(text(m1)).not.toContain("Website build");
    await withdrawProposal(p.actor("sales"), proposal.id, { now: NOW });
    const m2 = page(token, await loadPublicProposal(token, ctx()));
    expect(text(m2)).toContain(PUBLIC_STATE_TEXT.withdrawn.title);
    expect(text(m2)).not.toContain("Website build");
    // States that know nothing about the business say nothing about it.
    for (const state of ["invalid", "rate_limited", "disabled"] as const) {
      const view: PublicProposalView = { state, business: null, proposal: null, answer: null, changeRequests: 0, recipient: { maskedEmail: null }, verified: null, acknowledgement: null, signing: null };
      const m = page("x", view);
      expect(text(m)).toContain(PUBLIC_STATE_TEXT[state].title);
      expect(m).not.toContain("mailto:");
      expect(text(m)).not.toMatch(BAD);
    }
  });
});

describe("what the page says about what just happened", () => {
  it("shows only words it knows, with the right role, and ignores everything else in the address", () => {
    for (const key of Object.keys(DECIDE_TEXT)) expect(noticeFor("r", key)).toEqual(DECIDE_TEXT[key as keyof typeof DECIDE_TEXT]);
    for (const key of Object.keys(CODE_TEXT)) expect(noticeFor("c", key)?.text.startsWith(CODE_TEXT[key as keyof typeof CODE_TEXT].text)).toBe(true);
    for (const junk of [undefined, "", "constructor", "__proto__", "toString", "<script>alert(1)</script>", "accepted ", "ACCEPTED"]) {
      expect(noticeFor("r", junk), String(junk)).toBeNull();
      expect(noticeFor("c", junk), String(junk)).toBeNull();
    }
    expect(noticeFor("c", "wrong", "4")?.text).toContain("You have 4 tries left for this code.");
    expect(noticeFor("c", "wrong", "1")?.text).toContain("You have 1 try left");
    expect(noticeFor("c", "wrong", "99")?.text).toBe(CODE_TEXT.wrong.text);
    expect(noticeFor("c", "wrong", "<b>")?.text).toBe(CODE_TEXT.wrong.text);
  });

  it("puts an error where the customer is looking and announces it, and a success as a status", async () => {
    const p = await proposalOrg();
    const { token, email } = await sentWithLink(p);
    const open = await loadPublicProposal(token, ctx());
    const error = page(token, open, { result: noticeFor("r", "not_verified") });
    expect(error).toMatch(/<p role="alert"[^>]*>[\s\S]*Confirm your email address with the code first\./);
    const session = await verifiedSession(token, email);
    const done = await decideOnProposal(token, { decision: "accept", acknowledged: "1" }, ctx(session));
    expect(done.outcome).toBe("accepted");
    const answered = page(token, await loadPublicProposal(token, ctx(session)), { result: noticeFor("r", "accepted") });
    expect(answered).toMatch(/<p role="status"[^>]*>[\s\S]*Your acceptance was recorded\./);
    const sent = page(token, open, { code: noticeFor("c", "sent") });
    expect(sent).toMatch(/<p role="status"[^>]*>[\s\S]*We emailed a 6-digit code\./);
  });
});

describe("what a person typed can never become markup", () => {
  it("renders tags, scripts and event handlers as the text they are", () => {
    const evil = '<img src=x onerror="alert(1)"> <script>alert(2)</script> **bold** [link](javascript:alert(3)) &lt;b&gt;';
    const m = html(<Wording text={evil} />);
    expect(m).not.toContain("<img");
    expect(m).not.toContain("<script");
    expect(m).toContain("&lt;img src=x");
    expect(m).toContain("&lt;script&gt;");
    expect(m).toContain("<strong");
    // A whole document built from such text prints it as text, in every place wording appears.
    const doc = emptyDoc();
    doc.sections.push({ id: "sec-000001", heading: "<b>Heading</b>", body: evil });
    doc.lines.push({
      id: "line-000001", catalogItemId: null, name: "<i>Item</i>", description: evil, unitLabel: "<u>unit</u>", quantityMilli: 1000, unitPriceMinor: 1000, catalogPriceMinor: null, billing: "one_time",
      taxRateId: null, taxName: null, taxBps: 0, discount: null, note: "<em>note</em>",
    });
    doc.terms = evil;
    const snapshot = freeze({ number: "P-0009", title: "<h1>Title</h1>", currency: "USD", validUntil: null, requiresSignature: false, client: { name: "<b>Maria</b>", company: "", email: null }, business: { name: "<b>Acme</b>", website: null }, sender: { name: null }, dealName: null, doc }).snapshot;
    const out = html(<ProposalDocument snapshot={snapshot} version={1} />);
    expect(out).not.toMatch(/<(img|script|b|i|u|em)\b/);
    expect(out).toContain("&lt;b&gt;Heading&lt;/b&gt;");
    expect(out).toContain("&lt;h1&gt;Title&lt;/h1&gt;");
    expect((out.match(/<h1\b/g) ?? []).length).toBe(1);
  });
});
