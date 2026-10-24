// @vitest-environment jsdom
// The Delivery tab's "Send it to the customer" part and the list of messages, as a person meets them: what is read first, what is offered, what is said afterwards, and that the
// words never claim more than the record holds. The server actions are replaced by spies; the server's own rules are in proposals-delivery.test.ts. The browser-only things
// (layout at 375 and 1280 pixels, focus rings, the dialog's placement, light and dark) are for the lead's check.
import * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DeliveryPanel } from "@/components/proposals/delivery-panel";
import { DeliveryList, SendToCustomer } from "@/components/proposals/delivery-send";
import { ProposalWorkspace } from "@/components/proposals/workspace";
import type { DeliveryView } from "@/lib/proposals/delivery-state";
import type { DeliveryPreview, DeliveryUnavailable } from "@/server/proposals/delivery";
import type { ProposalDetail } from "@/server/proposals/view";
import { detailFixture, PID } from "./support/esign-screens";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  a: { previewDeliveryAction: vi.fn(), sendDeliveryAction: vi.fn(), getShareUrlAction: vi.fn(), renewShareLinkAction: vi.fn() },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: mocks.refresh, replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  usePathname: () => "/proposals",
}));
vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
vi.mock("@/app/actions/proposals", () => mocks.a);
vi.mock("@/app/actions/crm", () => ({ searchContactsAction: async () => ({ ok: true, data: [] }) }));

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
});
beforeEach(() => {
  mocks.refresh.mockReset();
  mocks.toastSuccess.mockReset();
  mocks.toastError.mockReset();
  for (const m of Object.values(mocks.a)) m.mockReset();
});
afterEach(cleanup);

const HASH = "a".repeat(64);
const ok = <T,>(data: T) => ({ ok: true as const, data });
const button = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;

const share = (over: Partial<NonNullable<ProposalDetail["share"]>> = {}): NonNullable<ProposalDetail["share"]> => ({
  id: "link-1", version: 1, recipientEmail: "maria@example.test", recipientName: "Maria Santos", createdAt: "2026-10-21T10:00:00.000Z", expiresAt: "2026-12-31T10:00:00.000Z", revokedAt: null, active: true,
  seen: "none", openCount: 0, firstOpenedAt: null, lastOpenedAt: null, viewedCount: 0, firstViewedAt: null, verifiedAt: null, downloadedAt: null, canCopy: true, ...over,
});
const sent = (over: Partial<ProposalDetail> = {}) => detailFixture({ status: "sent", sentVersion: 1, requiresSignature: false, share: share(), ...over });

const view = (over: Partial<DeliveryView> = {}): DeliveryView => ({
  id: "d-1", version: 1, channel: "email", channelLabel: "Email", requestedByName: "Sam Sales", requestedAt: "2026-10-23T12:00:00.000Z", addressMask: "m***@example.test", sendAfter: null, sentAt: null,
  state: "queued", label: "Queued", explain: "Queued to go by email to m***@example.test. It has not been sent yet.", tone: "neutral", ended: false, ...over,
});

const preview = (over: Partial<DeliveryPreview> = {}): DeliveryPreview => ({
  available: true, version: 1, channel: "email", channelLabel: "Email", subject: "Proposal P-0001 from Acme Dental", body: "Hi Maria,\n\nProposal P-0001 from Acme Dental is ready for you.\n\nYou can read it here:\n[the customer's own link to the proposal]",
  wordingVersion: "draft-2026-10-24", wordingIsDraft: true, wordingHash: HASH, addressMask: "m***@example.test", usesCredits: false,
  verdict: { kind: "ready", reason: null, text: "Nothing is sent until you confirm. Then it is queued to go by email to m***@example.test on the next sending run.", waitingUntil: null },
  standing: null, notes: [], remaining: 6, ...over,
});

const unavailable = (over: Partial<DeliveryUnavailable> = {}): DeliveryUnavailable => ({ available: false, version: 1, channel: "email", channelLabel: "Email", reason: "address_differs", text: "The email address on the proposal (m***@example.test) is not the one on the customer's record (x***@example.test). Make them the same, or copy the link.", ...over });

function panel(d: ProposalDetail = sent(), opts: { canSend?: boolean; active?: boolean } = {}) {
  return render(<DeliveryPanel detail={d} canSend={opts.canSend ?? true} tz="UTC" active={opts.active} />);
}

describe("the message is read when the tab is on show, and not before", () => {
  it("asks for nothing while another tab is open, and reads the email message when this one opens", async () => {
    mocks.a.previewDeliveryAction.mockResolvedValue(ok(preview()));
    const { rerender } = panel(sent(), { active: false });
    expect(mocks.a.previewDeliveryAction).not.toHaveBeenCalled();
    rerender(<DeliveryPanel detail={sent()} canSend tz="UTC" active />);
    await waitFor(() => expect(mocks.a.previewDeliveryAction).toHaveBeenCalledWith(PID, "email"));
    expect(await screen.findByText(/Hi Maria,/)).toBeTruthy();
  });

  it("is not there at all for someone who cannot send, for a proposal that is not out with the customer, or for one whose link has closed", () => {
    panel(sent(), { canSend: false });
    expect(screen.queryByRole("region", { name: "Send it to the customer" })).toBeNull();
    cleanup();
    panel(sent({ status: "accepted" }));
    expect(screen.queryByRole("region", { name: "Send it to the customer" })).toBeNull();
    cleanup();
    panel(sent({ share: share({ active: false, revokedAt: "2026-10-22T10:00:00.000Z" }) }));
    expect(screen.queryByRole("region", { name: "Send it to the customer" })).toBeNull();
    expect(mocks.a.previewDeliveryAction).not.toHaveBeenCalled();
  });
});

describe("what is shown before anything is sent", () => {
  it("shows where it goes (masked), the subject, the exact words with the link as words, and that nothing is sent until the person confirms", async () => {
    mocks.a.previewDeliveryAction.mockResolvedValue(ok(preview()));
    panel();
    expect(await screen.findByText("The message the customer will read")).toBeTruthy();
    const region = within(screen.getByRole("region", { name: "Send it to the customer" }));
    expect(region.getByText("m***@example.test", { selector: "dd" })).toBeTruthy();
    expect(region.getByText("Proposal P-0001 from Acme Dental")).toBeTruthy();
    expect(region.getByText(/\[the customer's own link to the proposal\]/)).toBeTruthy();
    expect(region.getByText(/is not kept in the message, the history or any export/)).toBeTruthy();
    expect(region.getByText(/This wording is a draft that nobody has approved yet/)).toBeTruthy();
    expect(region.getByText(/Nothing is sent until you confirm/)).toBeTruthy();
    expect(button("Send this message").disabled).toBe(false);
    expect(mocks.a.sendDeliveryAction).not.toHaveBeenCalled();
    // The whole region never claims more than it knows.
    expect(region.queryByText(/\b(delivered|received|read by|has read)\b/i)).toBeNull();
    expect(document.body.textContent).not.toMatch(/https?:|\{\{|undefined|NaN|\[object Object\]/);
  });

  it("offers the three channels as labelled radio buttons at a touch-friendly size, and reads the message again for the one chosen", async () => {
    mocks.a.previewDeliveryAction.mockImplementation(async (_id: string, channel: string) =>
      ok(channel === "sms" ? preview({ channel: "sms", channelLabel: "Text message", subject: null, body: "Hi Maria, Proposal P-0001 is ready for you. [the customer's own link to the proposal]", addressMask: "***4567", usesCredits: true }) : preview()));
    panel();
    await screen.findByText(/Hi Maria,/);
    const group = screen.getByRole("group", { name: "Send by" });
    const radios = within(group).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => r.closest("label")?.textContent)).toEqual(["Email", "Text message", "WhatsApp"]);
    expect(radios[0].checked).toBe(true);
    for (const r of radios) expect(r.closest("label")?.className).toContain("min-h-11");
    fireEvent.click(radios[1]);
    await waitFor(() => expect(mocks.a.previewDeliveryAction).toHaveBeenLastCalledWith(PID, "sms"));
    expect(await screen.findByText("***4567", { selector: "dd" })).toBeTruthy();
    expect(screen.getByText(/uses your prepaid service credits/)).toBeTruthy();
    expect(screen.queryByText("Subject")).toBeNull();
    fireEvent.click(radios[2]);
    await waitFor(() => expect(mocks.a.previewDeliveryAction).toHaveBeenLastCalledWith(PID, "whatsapp"));
  });

  it("drops an answer for a channel the person has already left", async () => {
    let releaseEmail: (v: unknown) => void = () => undefined;
    mocks.a.previewDeliveryAction.mockImplementation((_id: string, channel: string) =>
      channel === "email" ? new Promise((resolve) => { releaseEmail = resolve; }) : Promise.resolve(ok(preview({ channel: "sms", channelLabel: "Text message", subject: null, body: "Text body [the customer's own link to the proposal]", addressMask: "***4567" }))));
    panel();
    fireEvent.click(screen.getByRole("radio", { name: "Text message" }));
    expect(await screen.findByText(/Text body/)).toBeTruthy();
    releaseEmail(ok(preview({ body: "Email body that arrived late [the customer's own link to the proposal]" })));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(/Email body that arrived late/)).toBeNull();
    expect(screen.getByText(/Text body/)).toBeTruthy();
  });

  it("says when the message cannot be offered, and offers no button", async () => {
    mocks.a.previewDeliveryAction.mockResolvedValue(ok(unavailable()));
    panel();
    expect(await screen.findByText(/is not the one on the customer's record/)).toBeTruthy();
    expect(screen.getByText(/Make them the same, or copy the link\./).getAttribute("role")).toBe("status");
    expect(screen.queryByRole("button", { name: /Send this message|Queue this message/ })).toBeNull();
  });

  it("says what the send chain refused, with the reason, and keeps the button off", async () => {
    mocks.a.previewDeliveryAction.mockResolvedValue(ok(preview({ verdict: { kind: "refused", reason: "no_consent", text: "There is no consent on record for this customer on this channel, so it can't be sent.", waitingUntil: null } })));
    panel();
    expect(await screen.findByText(/There is no consent on record/)).toBeTruthy();
    expect(button("Send this message").disabled).toBe(true);
  });

  it("says a message will wait for sending hours, and does not call the button 'Send'", async () => {
    mocks.a.previewDeliveryAction.mockResolvedValue(ok(preview({ verdict: { kind: "waiting", reason: "quiet_hours", text: "Sending hours are closed for this customer right now. If you confirm, it is queued to go by email when they open. Nothing is sent until you confirm.", waitingUntil: "2026-10-23T14:00:00.000Z" } })));
    panel();
    expect(await screen.findByText(/Sending hours are closed for this customer right now/)).toBeTruthy();
    expect(screen.getByText(/Next window: Oct 23, 2026, 2:00 PM/)).toBeTruthy();
    expect(button("Queue this message").disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Send this message" })).toBeNull();
  });

  it("does not offer a second message while one is on its way or was accepted, and says how to send again", async () => {
    const standing = view({ state: "sent", label: "Sent by email", explain: "Handed to the email provider to m***@example.test. That only means the provider accepted it: iAcquire cannot tell you it arrived or that the customer saw it.", tone: "success" });
    mocks.a.previewDeliveryAction.mockResolvedValue(ok(preview({ standing })));
    panel();
    expect(await screen.findByText(/To send it again, make a new link first/)).toBeTruthy();
    expect(button("Send this message").disabled).toBe(true);
  });

  it("warns about what the preview found, and when a version has used up its messages", async () => {
    mocks.a.previewDeliveryAction.mockResolvedValue(ok(preview({ notes: ["There is no email address on the proposal, so the customer can read it but cannot answer it online."], remaining: 0 })));
    panel();
    expect(await screen.findByText(/the customer can read it but cannot answer it online/)).toBeTruthy();
    expect(screen.getByText(/Copy the link and give it to the customer yourself/)).toBeTruthy();
    expect(button("Send this message").disabled).toBe(true);
  });

  it("says so in an alert when the message could not be read", async () => {
    mocks.a.previewDeliveryAction.mockResolvedValue({ ok: false, error: "That proposal was not found.", code: "not_found" });
    panel();
    expect((await screen.findByRole("alert")).textContent).toBe("That proposal was not found.");
    cleanup();
    mocks.a.previewDeliveryAction.mockRejectedValue(new Error("offline"));
    panel();
    expect((await screen.findByRole("alert")).textContent).toMatch(/That didn't load/);
  });
});

describe("confirming", () => {
  const confirmSend = async () => {
    await screen.findByText("The message the customer will read");
    fireEvent.click(button(/Send this message|Queue this message/));
    return within(screen.getByRole("dialog"));
  };

  it("sends the message that was read, bound to the version and the fingerprint, only after a confirmation", async () => {
    mocks.a.previewDeliveryAction.mockResolvedValue(ok(preview({ version: 3, wordingHash: "b".repeat(64) })));
    mocks.a.sendDeliveryAction.mockResolvedValue(ok({ status: "queued", waitingUntil: null, delivery: view({ version: 3 }) }));
    panel(sent({ version: 3, sentVersion: 3 }));
    const dialog = await confirmSend();
    expect(mocks.a.sendDeliveryAction).not.toHaveBeenCalled();
    expect(dialog.getByText(/It is checked again just before it leaves, and it is stopped if the proposal is withdrawn, revised or answered first/)).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: "Send this message" }));
    await waitFor(() => expect(mocks.a.sendDeliveryAction).toHaveBeenCalledWith(PID, { channel: "email", version: 3, wordingHash: "b".repeat(64) }));
    expect(mocks.a.sendDeliveryAction).toHaveBeenCalledTimes(1);
  });

  it("can be cancelled without sending anything", async () => {
    mocks.a.previewDeliveryAction.mockResolvedValue(ok(preview()));
    panel();
    const dialog = await confirmSend();
    fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mocks.a.sendDeliveryAction).not.toHaveBeenCalled();
  });

  it("says queued is not sent, in a status region the focus moves to, and reads the offer again", async () => {
    mocks.a.previewDeliveryAction.mockResolvedValue(ok(preview()));
    mocks.a.sendDeliveryAction.mockResolvedValue(ok({ status: "queued", waitingUntil: null, delivery: view() }));
    panel();
    const dialog = await confirmSend();
    fireEvent.click(dialog.getByRole("button", { name: "Send this message" }));
    const said = await screen.findByText(/Queued to go by email to m\*\*\*@example\.test\. It has not been sent yet/);
    expect(said.closest("[role=status]")).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(said.closest("[role=status]")));
    expect(mocks.refresh).toHaveBeenCalled();
    expect(said.textContent).not.toMatch(/\b(delivered|received|read)\b/i);
  });

  it("says when a message waits for sending hours", async () => {
    mocks.a.previewDeliveryAction.mockResolvedValue(ok(preview({ verdict: { kind: "waiting", reason: "quiet_hours", text: "Sending hours are closed.", waitingUntil: "2026-10-23T14:00:00.000Z" } })));
    mocks.a.sendDeliveryAction.mockResolvedValue(ok({ status: "queued", waitingUntil: "2026-10-23T14:00:00.000Z", delivery: view({ state: "waiting", label: "Waiting for sending hours" }) }));
    panel();
    const dialog = await confirmSend();
    fireEvent.click(dialog.getByRole("button", { name: "Queue this message" }));
    expect(await screen.findByText(/when sending hours open \(Oct 23, 2026, 2:00 PM\)\. It has not been sent yet/)).toBeTruthy();
  });

  it("says nothing new was sent when the server returns the first message, and shows a refusal as an alert", async () => {
    mocks.a.previewDeliveryAction.mockResolvedValue(ok(preview()));
    mocks.a.sendDeliveryAction.mockResolvedValueOnce(ok({ status: "already", delivery: view({ label: "Queued", explain: "Queued to go by email." }) }));
    panel();
    let dialog = await confirmSend();
    fireEvent.click(dialog.getByRole("button", { name: "Send this message" }));
    expect(await screen.findByText(/^Nothing new was sent\. Email: Queued\./)).toBeTruthy();
    cleanup();
    mocks.a.sendDeliveryAction.mockResolvedValueOnce(ok({ status: "refused", reason: "no_consent", text: "There is no consent on record for this customer on this channel, so it can't be sent." }));
    panel();
    dialog = await confirmSend();
    fireEvent.click(dialog.getByRole("button", { name: "Send this message" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("There is no consent on record");
  });

  it("shows a server error in the page, in an alert, reads the message again, and leaves the choice open", async () => {
    mocks.a.previewDeliveryAction.mockResolvedValueOnce(ok(preview())).mockResolvedValue(ok(preview({ body: "The message as it reads now [the customer's own link to the proposal]", wordingHash: "c".repeat(64) })));
    mocks.a.sendDeliveryAction.mockResolvedValue({ ok: false, error: "The message changed since you read it. Read it again before you send it.", code: "conflict" });
    panel();
    const dialog = await confirmSend();
    fireEvent.click(dialog.getByRole("button", { name: "Send this message" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("The message changed since you read it. Read it again before you send it.");
    expect(mocks.toastError).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.a.previewDeliveryAction).toHaveBeenCalledTimes(2));
    // The new reading replaces the old one, with the new fingerprint, so the next confirmation can be the right one.
    expect(await screen.findByText(/The message as it reads now/)).toBeTruthy();
    fireEvent.click(button("Send this message"));
    mocks.a.sendDeliveryAction.mockResolvedValue(ok({ status: "queued", waitingUntil: null, delivery: view() }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Send this message" }));
    await waitFor(() => expect(mocks.a.sendDeliveryAction).toHaveBeenLastCalledWith(PID, { channel: "email", version: 1, wordingHash: "c".repeat(64) }));
  });

  it("says so in an alert when the request itself fails, and reads the message again", async () => {
    mocks.a.previewDeliveryAction.mockResolvedValue(ok(preview()));
    mocks.a.sendDeliveryAction.mockRejectedValue(new Error("offline"));
    panel();
    const dialog = await confirmSend();
    fireEvent.click(dialog.getByRole("button", { name: "Send this message" }));
    expect((await screen.findByRole("alert")).textContent).toBe("That didn't go through. Check your connection and try again.");
    await waitFor(() => expect(mocks.a.previewDeliveryAction).toHaveBeenCalledTimes(2));
  });
});

describe("the list of messages", () => {
  it("says nothing was sent from here when nothing was, and that the product has no record of a link given by hand", () => {
    render(<DeliveryList deliveries={[]} tz="UTC" />);
    expect(screen.getByText(/No message has been sent from here\. If you gave the customer the link yourself, iAcquire has no record of that/)).toBeTruthy();
  });

  it("shows each message with its state in words, channel, version, who asked and when, and the due time of a waiting one", () => {
    const list: DeliveryView[] = [
      view({ id: "d-3", state: "waiting", label: "Waiting for sending hours", sendAfter: "2026-10-23T14:00:00.000Z", explain: "Queued to go by email when sending hours open. It has not been sent yet." }),
      view({ id: "d-2", channel: "sms", channelLabel: "Text message", state: "sent", label: "Sent by text message", tone: "success", addressMask: "***4567", explain: "Handed to the text message provider to ***4567. That only means the provider accepted it: iAcquire cannot tell you it arrived or that the customer saw it." }),
      view({ id: "d-1", state: "blocked", label: "Not sent", tone: "warning", ended: true, explain: "There is no consent on record for this customer on this channel, so the message was not sent." }),
    ];
    render(<DeliveryList deliveries={list} tz="UTC" />);
    const items = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toContain("Waiting for sending hours");
    expect(items[0].textContent).toContain("Due Oct 23, 2026, 2:00 PM.");
    expect(items[1].textContent).toContain("Sent by text message");
    expect(items[1].textContent).toContain("Text message");
    expect(items[1].textContent).toContain("Sam Sales");
    expect(items[1].textContent).toContain("version 1");
    expect(items[2].textContent).toContain("Not sent");
    const all = screen.getByRole("region", { name: "Messages to the customer" }).textContent ?? "";
    expect(all).not.toMatch(/\b(delivered|received|read by|has read|opened)\b/i);
  });

  it("is on the tab for a proposal that has had messages even when the viewer cannot send, and not for one that never had any", () => {
    panel(sent({ deliveries: [view()] }), { canSend: false });
    expect(screen.getByRole("region", { name: "Messages to the customer" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Send it to the customer" })).toBeNull();
    cleanup();
    panel(sent({ status: "accepted", deliveries: [] }), { canSend: false });
    expect(screen.queryByRole("region", { name: "Messages to the customer" })).toBeNull();
  });
});

describe("in the proposal's workspace", () => {
  const can = { create: true, approve: true, send: true, record: true, discount: true };
  const workspace = (d: ProposalDetail, initialTab?: string) =>
    render(<ProposalWorkspace detail={d} catalog={[]} taxRates={[]} can={can} twoPerson={false} tz="UTC" initialTab={initialTab} />);

  it("reads the message only once the Delivery tab is opened, because every tab stays mounted", async () => {
    mocks.a.previewDeliveryAction.mockResolvedValue(ok(preview()));
    workspace(sent());
    await new Promise((r) => setTimeout(r, 20));
    expect(mocks.a.previewDeliveryAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "Delivery" }));
    await waitFor(() => expect(mocks.a.previewDeliveryAction).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("The message the customer will read")).toBeTruthy();
  });

  it("reads it straight away when the page opens on the Delivery tab", async () => {
    mocks.a.previewDeliveryAction.mockResolvedValue(ok(preview()));
    workspace(sent(), "delivery");
    await waitFor(() => expect(mocks.a.previewDeliveryAction).toHaveBeenCalledWith(PID, "email"));
  });

  it("does not read it for a proposal nobody can send to the customer", async () => {
    workspace(sent({ status: "withdrawn", share: share({ active: false, revokedAt: "2026-10-23T10:00:00.000Z" }) }), "delivery");
    await new Promise((r) => setTimeout(r, 20));
    expect(mocks.a.previewDeliveryAction).not.toHaveBeenCalled();
  });
});

describe("the standalone piece", () => {
  it("renders the section on its own with a labelled group, and without a browser-only dependency", async () => {
    mocks.a.previewDeliveryAction.mockResolvedValue(ok(preview()));
    render(<SendToCustomer detail={sent()} tz="UTC" />);
    expect(screen.getByRole("group", { name: "Send by" })).toBeTruthy();
    expect(await screen.findByText("The message the customer will read")).toBeTruthy();
    expect(React.isValidElement(<SendToCustomer detail={sent()} tz="UTC" />)).toBe(true);
  });
});
