// The pure rules behind sending a proposal's link to the customer: the fixed wording and what it may carry, the fingerprint of what the sender read, how a message is described to
// the team (never as delivered or read), what the Delivery tab offers, and how the customer's link is hidden in anything a person or an AI reads. No database, no provider.
import { describe, expect, it } from "vitest";
import { deliveryWordingHash } from "@/lib/proposals/delivery-hash";
import {
  DELIVERY_CHANNELS, DELIVERY_TEMPLATES, DELIVERY_WORDING_VERSION, MAX_DELIVERY_LENGTH, deliveryTextProblem, greetingName, linkPlaceholderCount, previewDeliveryBody, renderDelivery,
  type DeliveryChannel, type DeliveryTextFacts,
} from "@/lib/proposals/delivery-text";
import {
  blockedReasonText, deliveryVerdict, describeDelivery, maskAddress, refusalReasonText, WITHDRAWN_REASON_TEXT, type DeliveryFacts, type WithdrawReason,
} from "@/lib/proposals/delivery-state";
import { confirmLabelFor, offerFor, outcomeText } from "@/lib/proposals/delivery-ui";
import { describeEvent } from "@/lib/proposals/activity";
import { fillProposalLink, hasProposalLinkPlaceholder, maskCustomerLinks, PROPOSAL_LINK_LABEL, PROPOSAL_LINK_PLACEHOLDER } from "@/server/messaging/redact";

const NOW = new Date("2026-10-24T10:00:00Z");
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde".slice(0, 43);
const facts = (over: Partial<DeliveryTextFacts> = {}): DeliveryTextFacts => ({ channel: "email", firstName: "Maria", business: "Acme Dental", number: "P-0007", validUntil: "2026-11-30", ...over });

/** Runs `fn` and says how long it took, in milliseconds. */
function timed(fn: () => unknown): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

describe("the fixed wording", () => {
  it("carries the customer's link as a placeholder exactly once, on every channel, and never a price", () => {
    for (const channel of DELIVERY_CHANNELS) {
      const m = renderDelivery(facts({ channel }));
      expect(linkPlaceholderCount(m.body), channel).toBe(1);
      expect(m.body, channel).toContain(PROPOSAL_LINK_PLACEHOLDER);
      expect(deliveryTextProblem(m.body), channel).toBeNull();
      expect(m.body, channel).not.toMatch(/[$€£₱]|\d+\.\d\d|https?:|www\./);
      expect(m.body.length, channel).toBeLessThanOrEqual(MAX_DELIVERY_LENGTH);
    }
  });

  it("gives an email a subject and the other channels none, and puts the business, the number and the last day in the text", () => {
    const email = renderDelivery(facts());
    expect(email.subject).toBe("Proposal P-0007 from Acme Dental");
    expect(email.body).toContain("Hi Maria,");
    expect(email.body).toContain("Proposal P-0007 from Acme Dental is ready for you.");
    expect(email.body).toContain("It is open until November 30, 2026.");
    for (const channel of ["sms", "whatsapp"] as const) {
      const short = renderDelivery(facts({ channel }));
      expect(short.subject).toBeNull();
      expect(short.body).not.toContain("\n");
      expect(short.body).toContain("It is open until November 30, 2026.");
    }
  });

  it("leaves out what it does not have: no name, no business, no date", () => {
    const m = renderDelivery(facts({ firstName: null, business: "", validUntil: null }));
    expect(m.body.startsWith("Hello,")).toBe(true);
    expect(m.body).toContain("Proposal P-0007 is ready for you.");
    expect(m.body).not.toContain("open until");
    expect(m.subject).toBe("Proposal P-0007");
  });

  it("does not describe how the proposal is answered, because a proposal that asks for a signature is answered somewhere else", () => {
    for (const t of Object.values(DELIVERY_TEMPLATES)) expect(t).not.toMatch(/accept|sign|respond|reply|answer/i);
  });

  it("cannot be made to carry a second placeholder, a web address or a long text by what was typed into the name, the business or the number", () => {
    const sneaky = renderDelivery(facts({ firstName: "Maria {{proposal.link}}", business: "A {{proposal.link}} {greeting} B", number: "P-{{proposal.link}}" }));
    expect(linkPlaceholderCount(sneaky.body)).toBe(1);
    expect(sneaky.body).not.toContain("{greeting}");
    const long = renderDelivery(facts({ business: "B".repeat(500), number: "N".repeat(500), firstName: "F".repeat(500) }));
    expect(long.body.length).toBeLessThanOrEqual(MAX_DELIVERY_LENGTH);
    expect(deliveryTextProblem(long.body)).toBeNull();
    expect(deliveryTextProblem(renderDelivery(facts({ business: "see www.example.test" })).body)).toMatch(/web address/);
    expect(deliveryTextProblem(renderDelivery(facts({ business: "http://x.test" })).body)).toMatch(/web address/);
  });

  it("refuses a stored message that does not carry the link exactly once, carries an address of its own, or is too long", () => {
    expect(deliveryTextProblem("no link here")).toMatch(/exactly once/);
    expect(deliveryTextProblem("{{proposal.link}} and {{ proposal.link }}")).toMatch(/exactly once/);
    expect(deliveryTextProblem("see https://example.test {{proposal.link}}")).toMatch(/web address/);
    expect(deliveryTextProblem(`${"x".repeat(MAX_DELIVERY_LENGTH)} {{proposal.link}}`)).toMatch(/too long/);
    expect(deliveryTextProblem("Hello {{proposal.link}}")).toBeNull();
  });

  it("shows the link as words in a preview", () => {
    const preview = previewDeliveryBody(renderDelivery(facts()).body);
    expect(preview).toContain("[the customer's own link to the proposal]");
    expect(preview).not.toContain("{{");
  });

  it("greets a customer only by a plain name", () => {
    expect(greetingName("Maria Santos")).toBe("Maria");
    expect(greetingName("  Jean-Luc  Picard")).toBe("Jean-Luc");
    expect(greetingName("O'Brien")).toBe("O'Brien");
    expect(greetingName("Zoë")).toBe("Zoë");
    expect(greetingName("María")).toBe("María");
    for (const bad of [null, undefined, "", "   ", "maria@example.test", "http://evil.test", "www.evil.test", "12345", "+15551234567", "{{proposal.link}}", "A".repeat(41), "x_y", "<b>Hi</b>", "-Maria"]) {
      expect(greetingName(bad), String(bad)).toBeNull();
    }
  });

  it("stays fast on 20,000 characters of anything", () => {
    const heavy = [" ".repeat(20_000), "{{ ".repeat(7000), "{".repeat(20_000), "}".repeat(20_000), `{{${" ".repeat(20_000)}`, "a".repeat(20_000), "http://".repeat(3000), "\n".repeat(20_000)];
    for (const text of heavy) {
      expect(timed(() => renderDelivery(facts({ business: text, firstName: text, number: text }))), "render").toBeLessThan(250);
      expect(timed(() => greetingName(text)), "greeting").toBeLessThan(50);
      expect(timed(() => deliveryTextProblem(text)), "problem").toBeLessThan(100);
      expect(timed(() => linkPlaceholderCount(text)), "count").toBeLessThan(100);
      expect(timed(() => previewDeliveryBody(text)), "preview").toBeLessThan(100);
    }
  });
});

describe("the fingerprint of what the sender read", () => {
  const message = renderDelivery(facts());
  it("is a sha256 that changes with the channel, the subject, the text and the wording, and with nothing else", () => {
    const h = deliveryWordingHash("email", message);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(deliveryWordingHash("email", renderDelivery(facts()))).toBe(h);
    expect(deliveryWordingHash("sms", message)).not.toBe(h);
    expect(deliveryWordingHash("email", { ...message, subject: `${message.subject}!` })).not.toBe(h);
    expect(deliveryWordingHash("email", { ...message, body: `${message.body} ` })).not.toBe(h);
    expect(deliveryWordingHash("email", renderDelivery(facts({ number: "P-0008" })))).not.toBe(h);
    expect(DELIVERY_WORDING_VERSION).toMatch(/^draft-/);
  });
});

describe("how a message is described to the team", () => {
  const base: DeliveryFacts = {
    channel: "email", addressMask: "m***@example.test", messageStatus: "queued", blockedReason: null, statusDetail: null, failureKind: null, sendAfter: null, withdrawnAt: null, withdrawnReason: null, now: NOW,
  };

  it("masks an address to something that can be recognised and not learned", () => {
    expect(maskAddress("email", "maria.santos@example.test")).toBe("m***@example.test");
    expect(maskAddress("sms", "+15551234567")).toBe("***4567");
    expect(maskAddress("whatsapp", "+639171234567")).toBe("***4567");
    expect(maskAddress("sms", "123")).toBe("***");
    expect(maskAddress("email", "not-an-address")).toBe("***");
  });

  it("says queued, waiting, being sent, sent and not sent, and each is only as strong as the record", () => {
    expect(describeDelivery(base)).toMatchObject({ state: "queued", label: "Queued", ended: false, tone: "neutral" });
    expect(describeDelivery({ ...base, sendAfter: new Date(NOW.getTime() + 3_600_000) })).toMatchObject({ state: "waiting", label: "Waiting for sending hours", ended: false });
    expect(describeDelivery({ ...base, sendAfter: new Date(NOW.getTime() - 1000) })).toMatchObject({ state: "queued" });
    expect(describeDelivery({ ...base, messageStatus: "draft" })).toMatchObject({ state: "queued" });
    expect(describeDelivery({ ...base, messageStatus: "sending" })).toMatchObject({ state: "sending", ended: false });
    expect(describeDelivery({ ...base, messageStatus: "sent" })).toMatchObject({ state: "sent", label: "Sent by email", tone: "success", ended: false });
    expect(describeDelivery({ ...base, messageStatus: "blocked", blockedReason: "no_consent" })).toMatchObject({ state: "blocked", label: "Not sent", ended: true });
    expect(describeDelivery({ ...base, messageStatus: "failed", failureKind: "rejected", statusDetail: "The address was refused." })).toMatchObject({ state: "failed", label: "Not sent", ended: true });
    expect(describeDelivery({ ...base, messageStatus: "failed", failureKind: "unconfirmed" })).toMatchObject({ state: "failed", label: "Not confirmed", ended: true });
    // A provider that took the message and reported a failure afterwards is not described as having refused it, and "nothing reached the customer" is not claimed.
    const late = describeDelivery({ ...base, messageStatus: "failed", failureKind: "rejected", statusDetail: "The mailbox is full.", sentAt: new Date("2026-10-24T09:00:00Z") });
    expect(late).toMatchObject({ state: "failed", label: "Failed after it was sent", ended: true, tone: "danger" });
    expect(late.explain).toBe("The email provider took the message to m***@example.test and later reported that it failed: The mailbox is full. Check the customer's details before you send it again.");
    expect(describeDelivery({ ...base, messageStatus: null })).toMatchObject({ state: "withdrawn", label: "Message removed", ended: true });
  });

  it("names the channel and the masked address in the words of a message that was sent or is queued", () => {
    expect(describeDelivery({ ...base, messageStatus: "sent" }).explain).toContain("email provider");
    expect(describeDelivery({ ...base, messageStatus: "sent" }).explain).toContain("m***@example.test");
    expect(describeDelivery({ ...base, channel: "sms", addressMask: "***4567", messageStatus: "queued" }).explain).toContain("text message");
    expect(describeDelivery({ ...base, channel: "whatsapp", addressMask: "***4567", messageStatus: "sent" }).label).toBe("Sent by WhatsApp");
    expect(describeDelivery({ ...base, addressMask: null }).explain).not.toContain(" to null");
  });

  it("never says a message was delivered, read, received, opened or seen, whatever the provider reported", () => {
    const statuses = [null, "draft", "queued", "sending", "sent", "delivered", "read", "failed", "blocked", "received", "note", "undelivered", "something_new"];
    const reasons = [null, "no_consent", "suppressed", "held_by_person", "proposal_link_unavailable", "identity_unverified", "whatsapp_window_closed", "credits", "provider_error", "a_reason_nobody_wrote_words_for"];
    const forbidden = /\b(delivered|read|received|opened|seen|reads|viewed)\b/i;
    let checked = 0;
    for (const messageStatus of statuses) {
      for (const blockedReason of reasons) {
        for (const failureKind of [null, "rejected", "unconfirmed"]) {
          for (const withdrawn of [false, true]) {
            for (const sentAt of [null, NOW]) {
              for (const channel of DELIVERY_CHANNELS) {
                const d = describeDelivery({ ...base, channel, messageStatus, blockedReason, failureKind, sentAt, withdrawnAt: withdrawn ? NOW : null, withdrawnReason: withdrawn ? "proposal_withdrawn" : null, statusDetail: null });
                expect(`${d.label} ${d.explain}`, `${messageStatus}/${blockedReason}/${failureKind}/${withdrawn}/${sentAt}`).not.toMatch(forbidden);
                checked += 1;
              }
            }
          }
        }
      }
    }
    expect(checked).toBe(statuses.length * reasons.length * 3 * 2 * 2 * 3);
  });

  it("treats a message the provider later reported as delivered or read as sent, and nothing more", () => {
    for (const messageStatus of ["delivered", "read"]) {
      const d = describeDelivery({ ...base, messageStatus });
      expect(d.state).toBe("sent");
      expect(d.label).toBe("Sent by email");
    }
  });

  it("says why a stopped message was stopped, in the words of the reason it was stopped for", () => {
    for (const reason of Object.keys(WITHDRAWN_REASON_TEXT) as WithdrawReason[]) {
      const d = describeDelivery({ ...base, withdrawnAt: NOW, withdrawnReason: reason });
      expect(d).toMatchObject({ state: "withdrawn", ended: true, explain: WITHDRAWN_REASON_TEXT[reason] });
    }
    expect(describeDelivery({ ...base, withdrawnAt: NOW, withdrawnReason: "something_else" }).explain).toMatch(/stopped before it went out/);
  });

  it("gives every reason the send chain can give as a whole sentence, before and after the fact", () => {
    for (const reason of ["no_consent", "suppressed", "held_by_person", "org_inactive", "automation_paused", "credits", "budget", "channel_not_ready", "contact_unreachable", "identity_unverified", "whatsapp_window_closed", "address_differs", "no_customer"]) {
      expect(blockedReasonText(reason, null), reason).toMatch(/, so the message was not sent\.$/);
      expect(refusalReasonText(reason, null), reason).toMatch(/, so it can't be sent\.$/);
    }
    expect(blockedReasonText("proposal_link_unavailable", null)).toMatch(/link had stopped working/);
    expect(blockedReasonText("proposal_withdrawn", null)).toBe(WITHDRAWN_REASON_TEXT.proposal_withdrawn);
    // A reason nobody wrote words for falls back to the chain's own sentence, then to its label, then to something honest.
    expect(blockedReasonText("odd_reason", "The provider said no.")).toBe("The provider said no, so the message was not sent.");
    expect(blockedReasonText("quiet_hours", null)).toBe("Quiet hours, so the message was not sent.");
    expect(blockedReasonText(null, null)).toBe("The message could not be sent.");
    expect(refusalReasonText(null, null)).toBe("It can't be sent right now.");
  });

  it("tells the sender what the chain would do, and that nothing is sent before they confirm", () => {
    const ready = deliveryVerdict({ allow: true }, "email", "m***@example.test");
    expect(ready).toMatchObject({ kind: "ready", reason: null, waitingUntil: null });
    expect(ready.text).toContain("Nothing is sent until you confirm");
    expect(ready.text).toContain("m***@example.test");
    const until = new Date("2026-10-25T01:00:00Z");
    const waiting = deliveryVerdict({ allow: false, reason: "quiet_hours", detail: "Quiet.", retryAt: until }, "sms", "***4567");
    expect(waiting).toMatchObject({ kind: "waiting", reason: "quiet_hours", waitingUntil: until.toISOString() });
    expect(waiting.text).toContain("text message");
    expect(waiting.text).toContain("Nothing is sent until you confirm");
    // A time to wait never turns a final refusal into a wait.
    expect(deliveryVerdict({ allow: false, reason: "no_consent", retryAt: until, permanent: true }, "email", null)).toMatchObject({ kind: "refused", reason: "no_consent", waitingUntil: null });
    const refused = deliveryVerdict({ allow: false, reason: "no_consent", detail: "This customer has not agreed." }, "email", null);
    expect(refused).toMatchObject({ kind: "refused", reason: "no_consent" });
    expect(refused.text).toMatch(/can't be sent/);
  });
});

describe("what the Delivery tab offers", () => {
  const ready = { verdict: { kind: "ready" as const, text: "ok" }, standing: null, remaining: 6 };

  it("offers Send when the chain says yes or says to wait, and says why when it does not", () => {
    expect(offerFor(ready)).toEqual({ canSend: true, why: null });
    expect(offerFor({ ...ready, verdict: { kind: "waiting", text: "later" } })).toEqual({ canSend: true, why: null });
    expect(offerFor({ ...ready, verdict: { kind: "refused", text: "No consent." } })).toEqual({ canSend: false, why: "No consent." });
  });

  it("does not offer a second message while one is on its way or was accepted, and says how to send again", () => {
    const standing = { label: "Queued", explain: "Queued to go by email.", channelLabel: "Email" };
    const o = offerFor({ ...ready, standing });
    expect(o.canSend).toBe(false);
    expect(o.why).toContain("Email: Queued.");
    expect(o.why).toContain("make a new link first");
  });

  it("stops offering when the version has had its most messages", () => {
    const o = offerFor({ ...ready, remaining: 0 });
    expect(o.canSend).toBe(false);
    expect(o.why).toMatch(/Copy the link/);
  });

  it("never labels the button for a waiting message 'Send'", () => {
    expect(confirmLabelFor("ready")).toBe("Send this message");
    expect(confirmLabelFor("waiting")).toBe("Queue this message");
  });

  it("says queued is not sent, and that a repeated request sent nothing new", () => {
    const when = (iso: string) => `at ${iso}`;
    const queued = outcomeText({ status: "queued", waitingUntil: null, delivery: { channelLabel: "Email", addressMask: "m***@example.test" } }, when);
    expect(queued.tone).toBe("ok");
    expect(queued.text).toContain("It has not been sent yet");
    expect(queued.text).toContain("m***@example.test");
    const waiting = outcomeText({ status: "queued", waitingUntil: "2026-10-25T01:00:00.000Z", delivery: { channelLabel: "Text message", addressMask: null } }, when);
    expect(waiting.text).toContain("when sending hours open (at 2026-10-25T01:00:00.000Z)");
    expect(waiting.text).toContain("It has not been sent yet");
    expect(outcomeText({ status: "already", delivery: { channelLabel: "Email", label: "Sent by email", explain: "Handed to the email provider." } }, when)).toMatchObject({ tone: "info" });
    expect(outcomeText({ status: "already", delivery: { channelLabel: "Email", label: "Queued", explain: "x" } }, when).text).toMatch(/^Nothing new was sent/);
    expect(outcomeText({ status: "refused", text: "No consent." }, when)).toEqual({ tone: "error", text: "No consent." });
    for (const o of [queued, waiting]) expect(o.text).not.toMatch(/\b(delivered|received|read|seen)\b/i);
  });
});

describe("the history lines", () => {
  const event = (kind: string, detail: Record<string, unknown> = {}, version: number | null = 2) => describeEvent({ kind, actorKind: "user", actorName: "Sam Sales", version, detail });

  it("says a message was queued and by which channel, without saying where it went, and sends the reader to the tab for the outcome", () => {
    const e = event("delivery_queued", { channel: "email", waitingUntil: null });
    expect(e.text).toBe("Sam Sales queued a message with the customer's link, to go by email (version 2). The Delivery tab shows where it went and what became of it.");
    expect(event("delivery_queued", { channel: "sms", waitingUntil: "2026-10-25T01:00:00Z" }).text).toContain("by text message when sending hours open");
    expect(event("delivery_queued", {}).text).toContain("to go by a message");
    expect(e.text).not.toMatch(/\b(sent|delivered|read)\b/i);
    // An old line that still carries a masked address does not print it.
    expect(event("delivery_queued", { channel: "email", addressMask: "m***@example.test" }).text).not.toContain("m***");
  });

  it("says how many messages were stopped and why", () => {
    expect(event("delivery_withdrawn", { count: 1, reason: "proposal_revised" }).text).toBe(`A message that had not gone out was stopped. ${WITHDRAWN_REASON_TEXT.proposal_revised}`);
    expect(event("delivery_withdrawn", { count: 3, reason: "proposal_withdrawn" }).text).toContain("3 messages that had not gone out were stopped.");
    expect(event("delivery_withdrawn", { count: 2 }).tone).toBe("warning");
  });
});

describe("hiding the customer's link wherever a person or an AI reads a message", () => {
  const url = `https://app.example.test/proposal/${TOKEN}`;

  it("replaces the placeholder and every shape of the real address with a label", () => {
    expect(PROPOSAL_LINK_PLACEHOLDER).toBe("{{proposal.link}}");
    expect(maskCustomerLinks("Read it here: {{proposal.link}}")).toBe(`Read it here: ${PROPOSAL_LINK_LABEL}`);
    expect(maskCustomerLinks("Read it here: {{ proposal.link }} thanks")).toBe(`Read it here: ${PROPOSAL_LINK_LABEL} thanks`);
    expect(maskCustomerLinks(`Read it here: ${url}`)).toBe(`Read it here: ${PROPOSAL_LINK_LABEL}`);
    expect(maskCustomerLinks(`Read it here: ${url}.`)).toBe(`Read it here: ${PROPOSAL_LINK_LABEL}.`);
    expect(maskCustomerLinks(`Read it here: /proposal/${TOKEN}`)).toBe(`Read it here: ${PROPOSAL_LINK_LABEL}`);
    expect(maskCustomerLinks(`PDF: ${url}/pdf`)).toBe(`PDF: ${PROPOSAL_LINK_LABEL}`);
    expect(maskCustomerLinks(`<${url}>`)).toBe(`<${PROPOSAL_LINK_LABEL}>`);
    expect(maskCustomerLinks(`(${url}?x=1)`)).toBe(`(${PROPOSAL_LINK_LABEL}?x=1)`);
    // The token is the credential, so it is hidden whatever follows it.
    expect(maskCustomerLinks(`${url}/anything/else`)).toBe(`${PROPOSAL_LINK_LABEL}/anything/else`);
    expect(maskCustomerLinks(`${url}/pdfx`)).toBe(`${PROPOSAL_LINK_LABEL}/pdfx`);
    expect(maskCustomerLinks(`first ${url} second ${url}/pdf`)).toBe(`first ${PROPOSAL_LINK_LABEL} second ${PROPOSAL_LINK_LABEL}`);
  });

  it("leaves alone what is not a proposal link: a longer run, another path, plain text, nothing", () => {
    expect(maskCustomerLinks(`/proposal/${TOKEN}x`)).toBe(`/proposal/${TOKEN}x`);
    expect(maskCustomerLinks(`/proposals/${TOKEN}`)).toBe(`/proposals/${TOKEN}`);
    expect(maskCustomerLinks("/proposal/short")).toBe("/proposal/short");
    expect(maskCustomerLinks("We will send you a proposal.")).toBe("We will send you a proposal.");
    expect(maskCustomerLinks("")).toBe("");
    expect(maskCustomerLinks(null)).toBeNull();
  });

  it("still hides the other links it always hid, in the same text", () => {
    const text = `a {{invoice.link}} b {{review.link}} c {{appointment.manage_link}} d {{proposal.link}} e https://x.test/pay/${TOKEN} f https://x.test/r/${TOKEN}`;
    expect(maskCustomerLinks(text)).toBe(`a [customer invoice link] b [customer review link] c [customer booking link] d ${PROPOSAL_LINK_LABEL} e [customer invoice link] f [customer review link]`);
  });

  it("finds and fills the placeholder without reading '$' in a link as a pattern", () => {
    expect(hasProposalLinkPlaceholder("x {{proposal.link}}")).toBe(true);
    expect(hasProposalLinkPlaceholder("x {{proposal.link}}")).toBe(true);
    expect(hasProposalLinkPlaceholder("x {{invoice.link}}")).toBe(false);
    expect(hasProposalLinkPlaceholder("")).toBe(false);
    expect(fillProposalLink("a {{proposal.link}} b", "https://x.test/$&/$1")).toBe("a https://x.test/$&/$1 b");
    expect(fillProposalLink("a {{ proposal.link }} b {{proposal.link}}", "L")).toBe("a L b L");
  });

  it("is fast on 20,000 characters of anything that looks a little like a link", () => {
    const heavy = [
      `/proposal/${"a".repeat(20_000)}`, "/proposal/".repeat(2000), "http://a".repeat(5000), `https://${"h".repeat(20_000)}/proposal/${TOKEN}`, "{{".repeat(10_000), `{{${" ".repeat(20_000)}proposal.link`,
      `${url}/pdf`.repeat(150), "/proposal/aaaa".repeat(1500),
    ];
    for (const text of heavy) {
      expect(timed(() => maskCustomerLinks(text)), text.slice(0, 20)).toBeLessThan(250);
      expect(timed(() => hasProposalLinkPlaceholder(text)), text.slice(0, 20)).toBeLessThan(100);
      expect(timed(() => fillProposalLink(text, "L")), text.slice(0, 20)).toBeLessThan(100);
    }
  });
});

describe("the channels", () => {
  it("are email, text message and WhatsApp, in that order, and nothing else", () => {
    expect([...DELIVERY_CHANNELS]).toEqual(["email", "sms", "whatsapp"] satisfies DeliveryChannel[]);
  });
});
