// The pure rules behind sending an issued invoice's link to the customer: the fixed wording and what it may carry, the fingerprint of what the sender read, how a message is
// described to the team (never as delivered or read), what the invoice's send section offers, and how the customer's link is hidden in anything a person or an AI reads.
// No database, no provider.
import { describe, expect, it } from "vitest";
import { CURRENCY_CODES, formatMinor } from "@/lib/money";
import { invoiceDeliveryWordingHash } from "@/lib/invoices/delivery-hash";
import {
  DELIVERY_CHANNELS, INVOICE_DELIVERY_TEMPLATES, INVOICE_DELIVERY_WORDING_VERSION, INVOICE_LINK_PLACEHOLDER, MAX_INVOICE_DELIVERIES_PER_LINK, MAX_INVOICE_DELIVERY_LENGTH,
  invoiceDeliveryTextProblem, invoiceLinkPlaceholderCount, previewInvoiceDeliveryBody, renderInvoiceDelivery, type InvoiceDeliveryFacts,
} from "@/lib/invoices/delivery-text";
import {
  describeInvoiceDelivery, INVOICE_WITHDRAWN_REASON_TEXT, invoiceBlockedReasonText, invoiceDeliveryVerdict, invoiceRefusalReasonText, type DeliveryFacts, type InvoiceWithdrawReason,
} from "@/lib/invoices/delivery-state";
import { invoiceOfferFor, sendSectionFor, type InvoiceSendFacts } from "@/lib/invoices/delivery-ui";
import { eventSentence } from "@/lib/invoices/labels";
import { fillInvoiceLink, hasInvoiceLinkPlaceholder, INVOICE_LINK_LABEL, maskCustomerLinks } from "@/server/messaging/redact";

const NOW = new Date("2026-10-24T10:00:00Z");
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde".slice(0, 43);
const facts = (over: Partial<InvoiceDeliveryFacts> = {}): InvoiceDeliveryFacts => ({
  channel: "email", firstName: "Maria", business: "Acme Dental", number: "INV-0007", totalMinor: 150_000, currency: "PHP", dueOn: "2026-11-06", ...over,
});

function timed(fn: () => unknown): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

describe("the fixed wording", () => {
  it("carries the customer's link as a placeholder exactly once, on every channel, and no web address of its own", () => {
    for (const channel of DELIVERY_CHANNELS) {
      const m = renderInvoiceDelivery(facts({ channel }));
      expect(invoiceLinkPlaceholderCount(m.body), channel).toBe(1);
      expect(m.body, channel).toContain(INVOICE_LINK_PLACEHOLDER);
      expect(invoiceDeliveryTextProblem(m.body), channel).toBeNull();
      expect(m.body, channel).not.toMatch(/https?:|www\./);
      expect(m.body.length, channel).toBeLessThanOrEqual(MAX_INVOICE_DELIVERY_LENGTH);
    }
  });

  it("gives an email a subject and the other channels none, and puts the business, the number, the total and the due date in the text", () => {
    const email = renderInvoiceDelivery(facts());
    expect(email.subject).toBe("Invoice INV-0007 from Acme Dental");
    expect(email.body).toContain("Hi Maria,");
    expect(email.body).toContain("Invoice INV-0007 from Acme Dental for PHP 1,500.00 is ready for you. It is due on 6 Nov 2026.");
    for (const channel of ["sms", "whatsapp"] as const) {
      const short = renderInvoiceDelivery(facts({ channel }));
      expect(short.subject).toBeNull();
      expect(short.body).not.toContain("\n");
      expect(short.body).toContain("Invoice INV-0007 from Acme Dental for PHP 1,500.00, due on 6 Nov 2026, is ready for you.");
    }
  });

  it("states the total in the invoice's own currency, with its own number of decimals, for every supported currency, and never a balance or a fee", () => {
    for (const currency of CURRENCY_CODES) {
      const m = renderInvoiceDelivery(facts({ currency, totalMinor: 123_456 }));
      expect(m.body, currency).toContain(formatMinor(123_456, currency, "code"));
      expect(m.body, currency).not.toMatch(/balance|fee|interest|late|collect/i);
    }
    expect(renderInvoiceDelivery(facts({ currency: "JPY", totalMinor: 150_000 })).body).toContain("JPY 150,000");
  });

  it("leaves out what it does not have: no name, no business", () => {
    const m = renderInvoiceDelivery(facts({ firstName: null, business: "" }));
    expect(m.body.startsWith("Hello,")).toBe(true);
    expect(m.body).toContain("Invoice INV-0007 for PHP 1,500.00 is ready for you.");
    expect(m.subject).toBe("Invoice INV-0007");
  });

  it("does not say the customer can pay online, because the page says whether the business takes payment that way, and makes no promise, threat or claim about rights", () => {
    for (const t of Object.values(INVOICE_DELIVERY_TEMPLATES)) {
      expect(t).not.toMatch(/pay (it )?online|pay now|secure|guarantee|overdue|legal|penalt|collection|must|immediately|final notice/i);
    }
  });

  it("cannot be made to carry a second placeholder, a web address or a long text by what was typed into the name, the business or the number", () => {
    const sneaky = renderInvoiceDelivery(facts({ firstName: "Maria {{invoice.link}}", business: "A {{invoice.link}} {greeting} B", number: "INV-{{invoice.link}}" }));
    expect(invoiceLinkPlaceholderCount(sneaky.body)).toBe(1);
    expect(sneaky.body).not.toContain("{greeting}");
    const long = renderInvoiceDelivery(facts({ business: "B".repeat(500), number: "N".repeat(500), firstName: "F".repeat(500) }));
    expect(long.body.length).toBeLessThanOrEqual(MAX_INVOICE_DELIVERY_LENGTH);
    expect(invoiceDeliveryTextProblem(long.body)).toBeNull();
    expect(invoiceDeliveryTextProblem(renderInvoiceDelivery(facts({ business: "see www.example.test" })).body)).toMatch(/web address/);
    expect(invoiceDeliveryTextProblem(renderInvoiceDelivery(facts({ business: "http://x.test" })).body)).toMatch(/web address/);
  });

  it("refuses a stored message that does not carry the link exactly once, carries an address of its own, or is too long", () => {
    expect(invoiceDeliveryTextProblem("no link here")).toMatch(/exactly once/);
    expect(invoiceDeliveryTextProblem("{{invoice.link}} and {{ invoice.link }}")).toMatch(/exactly once/);
    expect(invoiceDeliveryTextProblem("{{proposal.link}}")).toMatch(/exactly once/);
    expect(invoiceDeliveryTextProblem("see https://example.test {{invoice.link}}")).toMatch(/web address/);
    expect(invoiceDeliveryTextProblem(`${"x".repeat(MAX_INVOICE_DELIVERY_LENGTH)} {{invoice.link}}`)).toMatch(/too long/);
    expect(invoiceDeliveryTextProblem("Hello {{invoice.link}}")).toBeNull();
  });

  it("shows the link as words in a preview", () => {
    const preview = previewInvoiceDeliveryBody(renderInvoiceDelivery(facts()).body);
    expect(preview).toContain("[the customer's own link to the invoice]");
    expect(preview).not.toContain("{{");
  });

  it("stays fast on 20,000 characters of anything", () => {
    const heavy = [" ".repeat(20_000), "{{ ".repeat(7000), "{".repeat(20_000), "}".repeat(20_000), `{{${" ".repeat(20_000)}`, "a".repeat(20_000), "http://".repeat(3000), "\n".repeat(20_000)];
    for (const text of heavy) {
      expect(timed(() => renderInvoiceDelivery(facts({ business: text, firstName: text, number: text }))), "render").toBeLessThan(250);
      expect(timed(() => invoiceDeliveryTextProblem(text)), "problem").toBeLessThan(100);
      expect(timed(() => invoiceLinkPlaceholderCount(text)), "count").toBeLessThan(100);
      expect(timed(() => previewInvoiceDeliveryBody(text)), "preview").toBeLessThan(100);
      expect(timed(() => maskCustomerLinks(text)), "mask").toBeLessThan(150);
    }
    // Text that looks like the start of a link over and over, for the pattern that hides links.
    const linkish = ["/pay/".repeat(4000), `https://${"a".repeat(20_000)}`, `${"/pay/" + "A".repeat(43)}`.repeat(400), `/pay/${"A".repeat(20_000)}`, `invoice.link ${"{{invoice.link".repeat(1500)}`];
    for (const text of linkish) expect(timed(() => maskCustomerLinks(text)), "mask a link-like text").toBeLessThan(250);
  });
});

describe("the fingerprint of what the sender read", () => {
  const message = renderInvoiceDelivery(facts());
  it("is a sha256 that changes with the channel, the subject, the text, the amounts and the wording, and with nothing else", () => {
    const h = invoiceDeliveryWordingHash("email", message);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(invoiceDeliveryWordingHash("email", renderInvoiceDelivery(facts()))).toBe(h);
    expect(invoiceDeliveryWordingHash("sms", message)).not.toBe(h);
    expect(invoiceDeliveryWordingHash("email", { ...message, subject: `${message.subject}!` })).not.toBe(h);
    expect(invoiceDeliveryWordingHash("email", { ...message, body: `${message.body} ` })).not.toBe(h);
    expect(invoiceDeliveryWordingHash("email", renderInvoiceDelivery(facts({ number: "INV-0008" })))).not.toBe(h);
    expect(invoiceDeliveryWordingHash("email", renderInvoiceDelivery(facts({ totalMinor: 150_001 })))).not.toBe(h);
    expect(invoiceDeliveryWordingHash("email", renderInvoiceDelivery(facts({ dueOn: "2026-11-07" })))).not.toBe(h);
    expect(INVOICE_DELIVERY_WORDING_VERSION).toMatch(/^draft-/);
  });
});

describe("how a message is described to the team", () => {
  const base: DeliveryFacts = {
    channel: "email", addressMask: "m***@example.test", messageStatus: "queued", blockedReason: null, statusDetail: null, failureKind: null, sendAfter: null, withdrawnAt: null, withdrawnReason: null, now: NOW,
  };

  it("says queued, waiting, being sent, sent and not sent, and each is only as strong as the record", () => {
    expect(describeInvoiceDelivery(base)).toMatchObject({ state: "queued", label: "Queued", ended: false });
    expect(describeInvoiceDelivery({ ...base, sendAfter: new Date(NOW.getTime() + 3_600_000) })).toMatchObject({ state: "waiting", label: "Waiting for sending hours", ended: false });
    expect(describeInvoiceDelivery({ ...base, messageStatus: "sending" })).toMatchObject({ state: "sending", ended: false });
    expect(describeInvoiceDelivery({ ...base, messageStatus: "sent" })).toMatchObject({ state: "sent", label: "Sent by email", tone: "success", ended: false });
    expect(describeInvoiceDelivery({ ...base, messageStatus: "blocked", blockedReason: "no_consent" })).toMatchObject({ state: "blocked", label: "Not sent", ended: true });
    expect(describeInvoiceDelivery({ ...base, messageStatus: "failed", failureKind: "unconfirmed" })).toMatchObject({ state: "failed", label: "Not confirmed", ended: true });
    expect(describeInvoiceDelivery({ ...base, messageStatus: "failed", failureKind: "rejected", sentAt: NOW, statusDetail: "The mailbox is full." })).toMatchObject({ label: "Failed after it was sent" });
  });

  it("never says a message was delivered, read, received, opened or seen, whatever the provider reported and whatever stopped it", () => {
    const statuses = [null, "draft", "queued", "sending", "sent", "delivered", "read", "failed", "blocked", "received", "undelivered", "something_new"];
    const reasons = [null, "no_consent", "suppressed", "held_by_person", "invoice_link_unavailable", "identity_unverified", "credits", "provider_error", "a_reason_nobody_wrote_words_for", ...Object.keys(INVOICE_WITHDRAWN_REASON_TEXT)];
    const forbidden = /\b(delivered|read|received|opened|seen|reads|viewed)\b/i;
    let checked = 0;
    for (const messageStatus of statuses) {
      for (const blockedReason of reasons) {
        for (const failureKind of [null, "rejected", "unconfirmed"]) {
          for (const withdrawn of [false, true]) {
            for (const sentAt of [null, NOW]) {
              for (const channel of DELIVERY_CHANNELS) {
                const d = describeInvoiceDelivery({ ...base, channel, messageStatus, blockedReason, failureKind, sentAt, withdrawnAt: withdrawn ? NOW : null, withdrawnReason: withdrawn ? blockedReason : null, statusDetail: null });
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

  it("says why a stopped message was stopped, in the invoice's own words", () => {
    for (const reason of Object.keys(INVOICE_WITHDRAWN_REASON_TEXT) as InvoiceWithdrawReason[]) {
      expect(describeInvoiceDelivery({ ...base, withdrawnAt: NOW, withdrawnReason: reason })).toMatchObject({ state: "withdrawn", ended: true, explain: INVOICE_WITHDRAWN_REASON_TEXT[reason] });
      expect(INVOICE_WITHDRAWN_REASON_TEXT[reason]).not.toMatch(/proposal/i);
      expect(invoiceBlockedReasonText(reason, null)).toBe(INVOICE_WITHDRAWN_REASON_TEXT[reason]);
    }
    expect(describeInvoiceDelivery({ ...base, withdrawnAt: NOW, withdrawnReason: "proposal_withdrawn" }).explain).toMatch(/stopped before it went out/);
  });

  it("speaks of an invoice, never of a proposal, in every reason it can give", () => {
    for (const reason of ["no_consent", "suppressed", "held_by_person", "org_inactive", "automation_paused", "credits", "budget", "channel_not_ready", "contact_unreachable", "identity_unverified", "whatsapp_window_closed", "no_customer", "not_issued", "test_invoice", "public_pages_off"]) {
      expect(invoiceBlockedReasonText(reason, null), reason).toMatch(/, so the message was not sent\.$/);
      expect(invoiceRefusalReasonText(reason, null), reason).toMatch(/, so it can't be sent\.$/);
      expect(invoiceBlockedReasonText(reason, null) + invoiceRefusalReasonText(reason, null), reason).not.toMatch(/proposal/i);
    }
    expect(invoiceBlockedReasonText("invoice_link_unavailable", null)).toMatch(/invoice's link had stopped working/);
    expect(invoiceRefusalReasonText("test_invoice", null)).toBe("A test invoice is never sent to a customer, so it can't be sent.");
  });

  it("tells the sender what the chain would do, and that nothing is sent before they confirm", () => {
    expect(invoiceDeliveryVerdict({ allow: true }, "email", "m***@example.test")).toMatchObject({ kind: "ready" });
    expect(invoiceDeliveryVerdict({ allow: true }, "email", "m***@example.test").text).toContain("Nothing is sent until you confirm");
    const until = new Date("2026-10-25T01:00:00Z");
    expect(invoiceDeliveryVerdict({ allow: false, reason: "quiet_hours", retryAt: until }, "sms", "***4567")).toMatchObject({ kind: "waiting", waitingUntil: until.toISOString() });
    expect(invoiceDeliveryVerdict({ allow: false, reason: "no_consent", retryAt: until, permanent: true }, "email", null)).toMatchObject({ kind: "refused", waitingUntil: null });
    expect(invoiceDeliveryVerdict({ allow: false, reason: "no_customer" }, "email", null).text).toBe("The invoice is not linked to a customer record, so there is no address to send to, so it can't be sent.");
  });
});

describe("what the invoice's send section offers", () => {
  const issued: InvoiceSendFacts = { status: "issued", paymentStatus: "unpaid", writtenOff: false, balanceMinor: 150_000, isTest: false, canSend: true };

  it("is there for an issued, owing invoice that is not a test, for someone who can send invoices", () => {
    expect(sendSectionFor(issued)).toEqual({ show: true, note: null });
    expect(sendSectionFor({ ...issued, paymentStatus: "partially_paid", balanceMinor: 10 })).toEqual({ show: true, note: null });
  });

  it("is not there for anyone who cannot send, nor for a draft, a submitted or a void invoice", () => {
    expect(sendSectionFor({ ...issued, canSend: false })).toEqual({ show: false, note: null });
    for (const status of ["draft", "pending_approval", "void"] as const) expect(sendSectionFor({ ...issued, status })).toEqual({ show: false, note: null });
  });

  it("says why, instead of showing the section, for a test invoice, a written-off one, a disputed one and a paid one", () => {
    expect(sendSectionFor({ ...issued, isTest: true })).toEqual({ show: false, note: "A test invoice is never sent to a customer: nothing is owed on it." });
    expect(sendSectionFor({ ...issued, writtenOff: true }).note).toMatch(/written off/);
    expect(sendSectionFor({ ...issued, paymentStatus: "disputed" }).note).toMatch(/disputed/);
    expect(sendSectionFor({ ...issued, paymentStatus: "paid", balanceMinor: 0 }).note).toMatch(/paid/);
    expect(sendSectionFor({ ...issued, balanceMinor: 0 }).show).toBe(false);
    for (const f of [{ isTest: true }, { writtenOff: true }, { paymentStatus: "disputed" as const }, { paymentStatus: "paid" as const, balanceMinor: 0 }]) expect(sendSectionFor({ ...issued, ...f }).show).toBe(false);
  });

  it("offers Send when the chain says yes or says to wait, and says why when it does not", () => {
    const ready = { verdict: { kind: "ready" as const, text: "ok" }, standing: null, remaining: MAX_INVOICE_DELIVERIES_PER_LINK };
    expect(invoiceOfferFor(ready)).toEqual({ canSend: true, why: null });
    expect(invoiceOfferFor({ ...ready, verdict: { kind: "waiting", text: "later" } })).toEqual({ canSend: true, why: null });
    expect(invoiceOfferFor({ ...ready, verdict: { kind: "refused", text: "No consent." } })).toEqual({ canSend: false, why: "No consent." });
    const standing = { label: "Queued", explain: "Queued to go by email.", channelLabel: "Email" };
    const o = invoiceOfferFor({ ...ready, standing });
    expect(o.canSend).toBe(false);
    expect(o.why).toContain("Email: Queued.");
    expect(o.why).toContain("replace the customer's link first");
    expect(invoiceOfferFor({ ...ready, remaining: 0 })).toMatchObject({ canSend: false, why: expect.stringMatching(/Copy the link/) });
  });
});

describe("the invoice's history", () => {
  it("says a message was queued and which channel, and what stopped one, without any address", () => {
    expect(eventSentence("delivery_queued", { channel: "email", deliveryId: "d1", waitingUntil: null })).toBe("A message with the customer's link was queued, to go by email. The list of messages shows where it went and what became of it.");
    expect(eventSentence("delivery_queued", { channel: "sms", waitingUntil: "2026-10-25T01:00:00.000Z" })).toContain("to go by text message when sending hours open");
    expect(eventSentence("delivery_withdrawn", { count: 1, reason: "invoice_paid" })).toBe(`A message that had not gone out was stopped. ${INVOICE_WITHDRAWN_REASON_TEXT.invoice_paid}`);
    expect(eventSentence("delivery_withdrawn", { count: 3, reason: "invoice_voided" })).toMatch(/^3 messages that had not gone out were stopped\./);
  });

  it("says where an invoice made from a proposal came from and what was left off", () => {
    expect(eventSentence("created", { via: "proposal", proposalNumber: "P-0004", proposalVersion: 2, lines: 3, recurringLines: 1 }))
      .toBe("Draft made from proposal P-0004 (version 2): 3 lines the customer pays once were copied. 1 monthly or yearly line was not copied.");
    expect(eventSentence("created", { via: "proposal", proposalNumber: "P-0004", proposalVersion: 1, lines: 1, recurringLines: 0 })).toBe("Draft made from proposal P-0004 (version 1): 1 line the customer pays once was copied.");
    expect(eventSentence("created", { via: "proposal" })).toMatch(/^Draft made from a proposal: 0 lines/);
    expect(eventSentence("created", { via: "manual" })).toBe("Draft created.");
  });
});

describe("the customer's link in anything a person or an AI reads", () => {
  it("is hidden as words, in the placeholder and in a filled-in link, and filled in only on request", () => {
    const body = renderInvoiceDelivery(facts()).body;
    expect(hasInvoiceLinkPlaceholder(body)).toBe(true);
    expect(maskCustomerLinks(body)).toContain(INVOICE_LINK_LABEL);
    expect(maskCustomerLinks(body)).not.toContain("{{");
    const filled = fillInvoiceLink(body, `https://app.example.test/pay/${TOKEN}`);
    expect(filled).toContain(`/pay/${TOKEN}`);
    expect(maskCustomerLinks(filled)).not.toContain(TOKEN);
    expect(maskCustomerLinks(filled)).toContain(INVOICE_LINK_LABEL);
    expect(maskCustomerLinks(`see /pay/${TOKEN}.`)).toBe(`see ${INVOICE_LINK_LABEL}.`);
  });
});
