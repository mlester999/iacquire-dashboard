// @vitest-environment jsdom
// The invoice page's "Send it to the customer" part and the list of messages, as a person meets them: what is read first, what is offered, what is said afterwards, and that the
// words never claim more than the record holds. The server actions are replaced by spies; the server's own rules are in invoices-delivery.test.ts. The browser-only things (layout at
// 375 and 1280 pixels, focus rings, the dialog's placement, light and dark) are for the lead's check.
import * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { InvoiceDeliveryList, SendInvoiceToCustomer } from "@/components/invoices/delivery-send";
import { SourceNote } from "@/components/invoices/invoice-sections";
import type { InvoiceDeliveryView } from "@/lib/invoices/delivery-state";
import { madeByText } from "@/lib/invoices/labels";
import type { InvoiceDeliveryPreview, InvoiceDeliveryUnavailable } from "@/server/invoices/delivery";
import type { InvoiceFullDetail } from "@/server/invoices/invoices";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  a: { previewInvoiceDeliveryAction: vi.fn(), sendInvoiceDeliveryAction: vi.fn() },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: mocks.refresh, replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  usePathname: () => "/invoices",
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/actions/invoices", () => mocks.a);
vi.mock("@/app/actions/crm", () => ({ searchContactsAction: async () => ({ ok: true, data: [] }) }));

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
});
beforeEach(() => {
  mocks.refresh.mockReset();
  for (const m of Object.values(mocks.a)) m.mockReset();
});
afterEach(cleanup);

const INV = "55555555-5555-4555-8555-555555555555";
const HASH = "a".repeat(64);
const ok = <T,>(data: T) => ({ ok: true as const, data });
const button = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;

const view = (over: Partial<InvoiceDeliveryView> = {}): InvoiceDeliveryView => ({
  id: "d-1", linkVersion: 1, channel: "email", channelLabel: "Email", requestedByName: "Sam Sales", requestedAt: "2026-10-23T12:00:00.000Z", addressMask: "m***@example.test", sendAfter: null, sentAt: null,
  state: "queued", label: "Queued", explain: "Queued to go by email to m***@example.test. It has not been sent yet.", tone: "neutral", ended: false, ...over,
});

const preview = (over: Partial<InvoiceDeliveryPreview> = {}): InvoiceDeliveryPreview => ({
  available: true, linkVersion: 1, channel: "email", channelLabel: "Email", subject: "Invoice INV-0001 from Acme Dental",
  body: "Hi Maria,\n\nInvoice INV-0001 from Acme Dental for PHP 1,500.00 is ready for you. It is due on Nov 6, 2026.\n\nYou can see it, and how to pay it, here:\n[the customer's own link to the invoice]",
  wordingVersion: "draft-2026-10-24", wordingIsDraft: true, wordingHash: HASH, addressMask: "m***@example.test", usesCredits: false,
  verdict: { kind: "ready", reason: null, text: "Nothing is sent until you confirm. Then it is queued to go by email to m***@example.test on the next sending run.", waitingUntil: null },
  standing: null, remaining: 6, ...over,
});

const unavailable = (over: Partial<InvoiceDeliveryUnavailable> = {}): InvoiceDeliveryUnavailable => ({
  available: false, linkVersion: 1, channel: "email", channelLabel: "Email", reason: "no_customer", text: "This invoice is not linked to a customer record, so there is no address to send it to. Copy the link instead.", ...over,
});

/** Opens the section: nothing is read until the person asks for the message. */
async function open() {
  fireEvent.click(button("Write the message"));
}
function section(deliveries: InvoiceDeliveryView[] = []) {
  return render(<SendInvoiceToCustomer invoiceId={INV} deliveries={deliveries} tz="UTC" />);
}

describe("the message is read when the person opens the section, and not before", () => {
  it("asks for nothing while it is closed, says what it is for, and reads the email message when it is opened", async () => {
    mocks.a.previewInvoiceDeliveryAction.mockResolvedValue(ok(preview()));
    section();
    await new Promise((r) => setTimeout(r, 20));
    expect(mocks.a.previewInvoiceDeliveryAction).not.toHaveBeenCalled();
    const toggle = button("Write the message");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText(/It goes through the same checks as every other message to a customer/)).toBeTruthy();
    expect(screen.getByRole("group", { name: "Send by", hidden: true })).toBeTruthy();
    await open();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await waitFor(() => expect(mocks.a.previewInvoiceDeliveryAction).toHaveBeenCalledWith(INV, "email"));
    expect(await screen.findByText(/Hi Maria,/)).toBeTruthy();
    expect(toggle.textContent).toBe("Hide the message");
  });

  it("hides the message again, keeps what was read on screen while it is read afresh, and reads it afresh each time it is opened because the sending rules can change", async () => {
    mocks.a.previewInvoiceDeliveryAction.mockResolvedValue(ok(preview()));
    section();
    await open();
    await screen.findByText(/Hi Maria,/);
    fireEvent.click(button("Hide the message"));
    expect(screen.getByText(/Hi Maria,/).closest("[hidden]")).not.toBeNull();
    fireEvent.click(button("Write the message"));
    expect(screen.getByText(/Hi Maria,/).closest("[hidden]")).toBeNull();
    await waitFor(() => expect(mocks.a.previewInvoiceDeliveryAction).toHaveBeenCalledTimes(2));
  });
});

describe("what is shown before anything is sent", () => {
  it("shows where it goes (masked), the subject, the exact words with the link as words, and that nothing is sent until the person confirms", async () => {
    mocks.a.previewInvoiceDeliveryAction.mockResolvedValue(ok(preview()));
    section();
    await open();
    expect(await screen.findByText("The message the customer will read")).toBeTruthy();
    const region = within(screen.getByRole("region", { name: "Send it to the customer" }));
    expect(region.getByText("m***@example.test", { selector: "dd" })).toBeTruthy();
    expect(region.getByText("Invoice INV-0001 from Acme Dental")).toBeTruthy();
    expect(region.getByText(/\[the customer's own link to the invoice\]/)).toBeTruthy();
    expect(region.getByText(/is not kept in the message, the history or any export/)).toBeTruthy();
    expect(region.getByText(/This wording is a draft that nobody has approved yet/)).toBeTruthy();
    expect(region.getByText(/Nothing is sent until you confirm/)).toBeTruthy();
    expect(button("Send this message").disabled).toBe(false);
    expect(mocks.a.sendInvoiceDeliveryAction).not.toHaveBeenCalled();
    // The whole region never claims more than it knows.
    expect(region.queryByText(/\b(delivered|received|read by|has read)\b/i)).toBeNull();
    expect(document.body.textContent).not.toMatch(/https?:|\{\{|undefined|NaN|\[object Object\]/);
  });

  it("offers the three channels as labelled radio buttons at a touch-friendly size, and reads the message again for the one chosen", async () => {
    mocks.a.previewInvoiceDeliveryAction.mockImplementation(async (_id: string, channel: string) =>
      ok(channel === "sms" ? preview({ channel: "sms", channelLabel: "Text message", subject: null, body: "Hi Maria, Invoice INV-0001 is ready for you. [the customer's own link to the invoice]", addressMask: "***4567", usesCredits: true }) : preview()));
    section();
    await open();
    await screen.findByText(/Hi Maria,/);
    const group = screen.getByRole("group", { name: "Send by" });
    const radios = within(group).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => r.closest("label")?.textContent)).toEqual(["Email", "Text message", "WhatsApp"]);
    expect(radios[0].checked).toBe(true);
    for (const r of radios) expect(r.closest("label")?.className).toContain("min-h-11");
    fireEvent.click(radios[1]);
    await waitFor(() => expect(mocks.a.previewInvoiceDeliveryAction).toHaveBeenLastCalledWith(INV, "sms"));
    expect(await screen.findByText("***4567", { selector: "dd" })).toBeTruthy();
    expect(screen.getByText(/uses your prepaid service credits/)).toBeTruthy();
    expect(screen.queryByText("Subject")).toBeNull();
    fireEvent.click(radios[2]);
    await waitFor(() => expect(mocks.a.previewInvoiceDeliveryAction).toHaveBeenLastCalledWith(INV, "whatsapp"));
  });

  it("drops an answer for a channel the person has already left", async () => {
    let releaseEmail: (v: unknown) => void = () => undefined;
    mocks.a.previewInvoiceDeliveryAction.mockImplementation((_id: string, channel: string) =>
      channel === "email" ? new Promise((resolve) => { releaseEmail = resolve; }) : Promise.resolve(ok(preview({ channel: "sms", channelLabel: "Text message", subject: null, body: "Text body [the customer's own link to the invoice]", addressMask: "***4567" }))));
    section();
    await open();
    fireEvent.click(screen.getByRole("radio", { name: "Text message" }));
    expect(await screen.findByText(/Text body/)).toBeTruthy();
    releaseEmail(ok(preview({ body: "Email body that arrived late [the customer's own link to the invoice]" })));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(/Email body that arrived late/)).toBeNull();
    expect(screen.getByText(/Text body/)).toBeTruthy();
  });

  it("says when the message cannot be offered, and offers no button", async () => {
    mocks.a.previewInvoiceDeliveryAction.mockResolvedValue(ok(unavailable()));
    section();
    await open();
    expect(await screen.findByText(/is not linked to a customer record/)).toBeTruthy();
    expect(screen.getByText(/Copy the link instead\./).getAttribute("role")).toBe("status");
    expect(screen.queryByRole("button", { name: /Send this message|Queue this message/ })).toBeNull();
  });

  it("says what the send chain refused, with the reason, and keeps the button off", async () => {
    mocks.a.previewInvoiceDeliveryAction.mockResolvedValue(ok(preview({ verdict: { kind: "refused", reason: "no_consent", text: "There is no consent on record for this customer on this channel, so it can't be sent.", waitingUntil: null } })));
    section();
    await open();
    expect(await screen.findByText(/There is no consent on record/)).toBeTruthy();
    expect(button("Send this message").disabled).toBe(true);
  });

  it("says a message will wait for sending hours, and does not call the button 'Send'", async () => {
    mocks.a.previewInvoiceDeliveryAction.mockResolvedValue(ok(preview({ verdict: { kind: "waiting", reason: "quiet_hours", text: "Sending hours are closed for this customer right now. If you confirm, it is queued to go by email when they open. Nothing is sent until you confirm.", waitingUntil: "2026-10-23T14:00:00.000Z" } })));
    section();
    await open();
    expect(await screen.findByText(/Sending hours are closed for this customer right now/)).toBeTruthy();
    expect(screen.getByText(/Next window: Oct 23, 2026, 2:00 PM/)).toBeTruthy();
    expect(button("Queue this message").disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Send this message" })).toBeNull();
  });

  it("does not offer a second message while one is on its way or was accepted, and says how to send again", async () => {
    const standing = view({ state: "sent", label: "Sent by email", explain: "Handed to the email provider to m***@example.test. That only means the provider accepted it: iAcquire cannot tell you it arrived or that the customer saw it.", tone: "success" });
    mocks.a.previewInvoiceDeliveryAction.mockResolvedValue(ok(preview({ standing })));
    section();
    await open();
    expect(await screen.findByText(/To send it again, replace the customer's link first/)).toBeTruthy();
    expect(button("Send this message").disabled).toBe(true);
  });

  it("says when a link has used up its messages, and points at copying it", async () => {
    mocks.a.previewInvoiceDeliveryAction.mockResolvedValue(ok(preview({ remaining: 0 })));
    section();
    await open();
    expect(await screen.findByText(/Copy the link and give it to the customer yourself/)).toBeTruthy();
    expect(button("Send this message").disabled).toBe(true);
  });

  it("says so in an alert when the message could not be read", async () => {
    mocks.a.previewInvoiceDeliveryAction.mockResolvedValue({ ok: false, error: "That invoice was not found.", code: "not_found" });
    section();
    await open();
    expect((await screen.findByRole("alert")).textContent).toBe("That invoice was not found.");
    cleanup();
    mocks.a.previewInvoiceDeliveryAction.mockRejectedValue(new Error("offline"));
    section();
    await open();
    expect((await screen.findByRole("alert")).textContent).toMatch(/That didn't load/);
  });

  it("reads the message again when the list of messages changes, so it never offers a button for a message already on its way", async () => {
    mocks.a.previewInvoiceDeliveryAction.mockResolvedValueOnce(ok(preview())).mockResolvedValue(ok(preview({ standing: view() })));
    const { rerender } = section();
    await open();
    await screen.findByText(/Hi Maria,/);
    expect(button("Send this message").disabled).toBe(false);
    rerender(<SendInvoiceToCustomer invoiceId={INV} deliveries={[view()]} tz="UTC" />);
    await waitFor(() => expect(mocks.a.previewInvoiceDeliveryAction).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/To send it again, replace the customer's link first/)).toBeTruthy();
    expect(button("Send this message").disabled).toBe(true);
  });
});

describe("confirming", () => {
  const confirmSend = async () => {
    await open();
    await screen.findByText("The message the customer will read");
    fireEvent.click(button(/Send this message|Queue this message/));
    return within(screen.getByRole("dialog"));
  };

  it("sends the message that was read, bound to the link and the fingerprint, only after a confirmation", async () => {
    mocks.a.previewInvoiceDeliveryAction.mockResolvedValue(ok(preview({ linkVersion: 3, wordingHash: "b".repeat(64) })));
    mocks.a.sendInvoiceDeliveryAction.mockResolvedValue(ok({ status: "queued", waitingUntil: null, delivery: view({ linkVersion: 3 }) }));
    section();
    const dialog = await confirmSend();
    expect(mocks.a.sendInvoiceDeliveryAction).not.toHaveBeenCalled();
    expect(dialog.getByText(/It is checked again just before it leaves, and it is stopped if the invoice is voided, paid, disputed or written off, or its link is replaced, first/)).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: "Send this message" }));
    await waitFor(() => expect(mocks.a.sendInvoiceDeliveryAction).toHaveBeenCalledWith(INV, { channel: "email", linkVersion: 3, wordingHash: "b".repeat(64) }));
    expect(mocks.a.sendInvoiceDeliveryAction).toHaveBeenCalledTimes(1);
  });

  it("can be cancelled without sending anything", async () => {
    mocks.a.previewInvoiceDeliveryAction.mockResolvedValue(ok(preview()));
    section();
    const dialog = await confirmSend();
    fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mocks.a.sendInvoiceDeliveryAction).not.toHaveBeenCalled();
  });

  it("says queued is not sent, in a status region the focus moves to, and refreshes the page", async () => {
    mocks.a.previewInvoiceDeliveryAction.mockResolvedValue(ok(preview()));
    mocks.a.sendInvoiceDeliveryAction.mockResolvedValue(ok({ status: "queued", waitingUntil: null, delivery: view() }));
    section();
    const dialog = await confirmSend();
    fireEvent.click(dialog.getByRole("button", { name: "Send this message" }));
    const said = await screen.findByText(/Queued to go by email to m\*\*\*@example\.test\. It has not been sent yet/);
    expect(said.closest("[role=status]")).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(said.closest("[role=status]")));
    expect(mocks.refresh).toHaveBeenCalled();
    expect(said.textContent).not.toMatch(/\b(delivered|received|read)\b/i);
  });

  it("says when a message waits for sending hours", async () => {
    mocks.a.previewInvoiceDeliveryAction.mockResolvedValue(ok(preview({ verdict: { kind: "waiting", reason: "quiet_hours", text: "Sending hours are closed.", waitingUntil: "2026-10-23T14:00:00.000Z" } })));
    mocks.a.sendInvoiceDeliveryAction.mockResolvedValue(ok({ status: "queued", waitingUntil: "2026-10-23T14:00:00.000Z", delivery: view({ state: "waiting", label: "Waiting for sending hours" }) }));
    section();
    const dialog = await confirmSend();
    fireEvent.click(dialog.getByRole("button", { name: "Queue this message" }));
    expect(await screen.findByText(/when sending hours open \(Oct 23, 2026, 2:00 PM\)\. It has not been sent yet/)).toBeTruthy();
  });

  it("says nothing new was sent when the server returns the first message, and shows a refusal as an alert", async () => {
    mocks.a.previewInvoiceDeliveryAction.mockResolvedValue(ok(preview()));
    mocks.a.sendInvoiceDeliveryAction.mockResolvedValueOnce(ok({ status: "already", delivery: view({ label: "Queued", explain: "Queued to go by email." }) }));
    section();
    let dialog = await confirmSend();
    fireEvent.click(dialog.getByRole("button", { name: "Send this message" }));
    expect(await screen.findByText(/^Nothing new was sent\. Email: Queued\./)).toBeTruthy();
    cleanup();
    mocks.a.sendInvoiceDeliveryAction.mockResolvedValueOnce(ok({ status: "refused", reason: "no_consent", text: "There is no consent on record for this customer on this channel, so it can't be sent." }));
    section();
    dialog = await confirmSend();
    fireEvent.click(dialog.getByRole("button", { name: "Send this message" }));
    expect((await screen.findByRole("alert")).textContent).toContain("There is no consent on record");
  });

  it("shows a server error in the page, in an alert, reads the message again, and leaves the choice open", async () => {
    mocks.a.previewInvoiceDeliveryAction.mockResolvedValueOnce(ok(preview())).mockResolvedValue(ok(preview({ body: "The message as it reads now [the customer's own link to the invoice]", wordingHash: "c".repeat(64) })));
    mocks.a.sendInvoiceDeliveryAction.mockResolvedValue({ ok: false, error: "The message changed since you read it. Read it again before you send it.", code: "conflict" });
    section();
    const dialog = await confirmSend();
    fireEvent.click(dialog.getByRole("button", { name: "Send this message" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("The message changed since you read it. Read it again before you send it.");
    await waitFor(() => expect(mocks.a.previewInvoiceDeliveryAction).toHaveBeenCalledTimes(2));
    // The new reading replaces the old one, with the new fingerprint, so the next confirmation can be the right one.
    expect(await screen.findByText(/The message as it reads now/)).toBeTruthy();
    fireEvent.click(button("Send this message"));
    mocks.a.sendInvoiceDeliveryAction.mockResolvedValue(ok({ status: "queued", waitingUntil: null, delivery: view() }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Send this message" }));
    await waitFor(() => expect(mocks.a.sendInvoiceDeliveryAction).toHaveBeenLastCalledWith(INV, { channel: "email", linkVersion: 1, wordingHash: "c".repeat(64) }));
  });

  it("says so in an alert when the request itself fails, and reads the message again", async () => {
    mocks.a.previewInvoiceDeliveryAction.mockResolvedValue(ok(preview()));
    mocks.a.sendInvoiceDeliveryAction.mockRejectedValue(new Error("offline"));
    section();
    const dialog = await confirmSend();
    fireEvent.click(dialog.getByRole("button", { name: "Send this message" }));
    expect((await screen.findByRole("alert")).textContent).toBe("That didn't go through. Check your connection and try again.");
    await waitFor(() => expect(mocks.a.previewInvoiceDeliveryAction).toHaveBeenCalledTimes(2));
  });
});

describe("the list of messages", () => {
  it("says nothing was sent from here when nothing was, and that the product has no record of a link given by hand", () => {
    render(<InvoiceDeliveryList deliveries={[]} tz="UTC" />);
    expect(screen.getByText(/No message has been sent from here\. If you gave the customer the link yourself, iAcquire has no record of that/)).toBeTruthy();
  });

  it("shows each message with its state in words, channel, who asked and when, the link it carried, and the due time of a waiting one", () => {
    const list: InvoiceDeliveryView[] = [
      view({ id: "d-3", linkVersion: 2, state: "waiting", label: "Waiting for sending hours", sendAfter: "2026-10-23T14:00:00.000Z", explain: "Queued to go by email when sending hours open. It has not been sent yet." }),
      view({ id: "d-2", channel: "sms", channelLabel: "Text message", state: "sent", label: "Sent by text message", tone: "success", addressMask: "***4567", explain: "Handed to the text message provider to ***4567. That only means the provider accepted it: iAcquire cannot tell you it arrived or that the customer saw it." }),
      view({ id: "d-1", state: "blocked", label: "Not sent", tone: "warning", ended: true, explain: "There is no consent on record for this customer on this channel, so the message was not sent." }),
    ];
    render(<InvoiceDeliveryList deliveries={list} tz="UTC" />);
    const items = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toContain("Waiting for sending hours");
    expect(items[0].textContent).toContain("Due Oct 23, 2026, 2:00 PM.");
    expect(items[0].textContent).toContain("link 2");
    expect(items[1].textContent).toContain("Sent by text message");
    expect(items[1].textContent).toContain("Text message");
    expect(items[1].textContent).toContain("Sam Sales");
    expect(items[1].textContent).not.toContain("link ");
    expect(items[2].textContent).toContain("Not sent");
    const all = screen.getByRole("region", { name: "Messages to the customer" }).textContent ?? "";
    expect(all).not.toMatch(/\b(delivered|received|read by|has read|opened)\b/i);
  });
});

// The part of the invoice page that says where a draft came from. It reads nothing but the source and the invoice's status and currency.
function sourced(over: Partial<NonNullable<InvoiceFullDetail["source"]>> = {}, status: "draft" | "issued" = "draft"): InvoiceFullDetail {
  return {
    invoice: { status, currency: "USD" },
    source: { proposalId: "66666666-6666-4666-8666-666666666666", proposalVersion: 2, proposalNumber: "P-0007", recurring: [], recurringCount: 0, ...over },
  } as unknown as InvoiceFullDetail;
}

describe("where a draft made from a proposal came from", () => {
  it("says which proposal and version, links to it, and says nothing was issued or sent", () => {
    render(<SourceNote detail={sourced()} />);
    const region = screen.getByRole("heading", { name: "Made from a proposal" }).closest("section") as HTMLElement;
    expect(within(region).getByRole("link", { name: "proposal P-0007" }).getAttribute("href")).toBe("/proposals/66666666-6666-4666-8666-666666666666");
    expect(region.textContent).toContain("version 2");
    expect(region.textContent).toContain("Nothing else was copied, and nothing was issued or sent.");
    expect(region.textContent).toContain("You can change this draft before it is issued.");
    expect(within(region).queryByLabelText("Lines that were not copied")).toBeNull();
  });

  it("does not name the proposal to someone who cannot read proposals, and does not offer to change an issued invoice", () => {
    render(<SourceNote detail={sourced({ proposalNumber: null }, "issued")} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(/copied from an accepted proposal/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("You can change this draft");
  });

  it("lists the monthly and yearly lines that were left off, with what the customer pays each time, and counts the ones the history could not keep", () => {
    const recurring = Array.from({ length: 8 }, (_, n) => ({ name: `Service ${n}`, billing: n % 2 ? ("yearly" as const) : ("monthly" as const), totalMinor: 9_900 + n }));
    render(<SourceNote detail={sourced({ recurring, recurringCount: 12 })} />);
    expect(screen.getByText("12 lines are not on this invoice.")).toBeTruthy();
    const list = screen.getByRole("list", { name: "Lines that were not copied" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(9);
    expect(items[0].textContent).toBe("Service 0, every month, USD 99.00 each time");
    expect(items[1].textContent).toBe("Service 1, every year, USD 99.01 each time");
    expect(items[8].textContent).toBe("and 4 more");
    expect(screen.getByText(/whether and when to invoice them is yours to decide/)).toBeTruthy();
  });

  it("is not there for an invoice made any other way", () => {
    const { container } = render(<SourceNote detail={{ invoice: { status: "draft", currency: "USD" }, source: null } as unknown as InvoiceFullDetail} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("the badge for a draft a person did not type", () => {
  it("names what made it, and never calls a proposal a deal", () => {
    expect(madeByText("manual")).toBeNull();
    expect(madeByText("workflow")).toBe("Made by an automation");
    expect(madeByText("deal")).toBe("Made by a deal");
    expect(madeByText("proposal")).toBe("Made from a proposal");
    expect(madeByText("something_new")).toBe("Made by something else");
  });
});
