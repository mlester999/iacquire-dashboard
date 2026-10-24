// @vitest-environment jsdom
// The invoice screens' moments of decision, clicked through: what the dialogs say before money is recorded, what they refuse to send, that a retry reuses its key so a double click
// cannot record a payment twice, and that a key typed into the payment connection form does not stay on the page once it is saved. The server checks everything again; this proves
// what the person is told and what is sent. Server actions are replaced by recorders.
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const mocks = vi.hoisted(() => {
  const names = [
    "createInvoiceDraftAction", "updateInvoiceDraftAction", "discardInvoiceDraftAction", "searchInvoiceDealsAction", "submitInvoiceAction", "withdrawInvoiceAction", "requestInvoiceChangesAction",
    "issueInvoiceAction", "voidInvoiceAction", "writeOffInvoiceAction", "recordPaymentAction", "recordRefundAction", "recordDisputeOpenedAction", "recordDisputeResultAction", "getInvoiceLinkAction", "rotateInvoiceLinkAction", "saveInvoiceSettingsAction",
    "authorizeRemindersAction", "switchOffRemindersAction", "connectProviderAction", "saveWebhookSecretAction", "replaceKeysAction", "recheckConnectionAction", "confirmLiveAction",
    "pauseConnectionAction", "disconnectConnectionAction", "recentDeliveriesAction", "startTestPaymentAction",
  ] as const;
  return { actions: Object.fromEntries(names.map((n) => [n, vi.fn()])) as Record<(typeof names)[number], ReturnType<typeof vi.fn>>, refresh: vi.fn(), push: vi.fn() };
});

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push, refresh: mocks.refresh, back: vi.fn() }), usePathname: () => "/invoices" }));
vi.mock("next/link", async () => {
  const React = await import("react");
  const Link = React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }>(function Link({ href, ...props }, ref) { return <a {...props} href={href} ref={ref} />; });
  return { default: Link };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/actions/invoices", () => mocks.actions);
vi.mock("@/app/actions/crm", () => ({ searchContactsAction: vi.fn() }));
vi.mock("motion/react", async () => {
  const React = await import("react");
  const Div = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & { initial?: unknown; animate?: unknown; transition?: unknown }>(function Div({ initial: _i, animate: _a, transition: _t, ...props }, ref) { return <div {...props} ref={ref} />; });
  return { motion: { div: Div } };
});
vi.mock("@/components/ui/overlays", async () => {
  const React = await import("react");
  function Dialog({ open, title, description, children, footer }: { open: boolean; title: React.ReactNode; description?: React.ReactNode; children?: React.ReactNode; footer?: React.ReactNode }) {
    if (!open) return null;
    return <section role="dialog" aria-label={typeof title === "string" ? title : undefined}><h2>{title}</h2>{description && <div>{description}</div>}{children}<footer>{footer}</footer></section>;
  }
  return { Dialog };
});

import { InvoiceActions } from "@/components/invoices/invoice-actions";
import { PaymentsPanel } from "@/components/invoices/payments-panel";
import { ConnectionsPanel } from "@/components/invoices/connections-panel";
import { RemindersPanel } from "@/components/invoices/settings-panel";
import type { ActionFacts } from "@/lib/invoices/screens";
import type { PaymentView } from "@/server/invoices/invoices";
import type { ReminderOverview } from "@/server/invoices/reminders";
import type { InvoiceSettings } from "@/server/invoices/settings";
import { CURRENT_AUTHORIZATION_VERSION } from "@/lib/invoices/connection-rules";

const ok = (data: unknown = true) => ({ ok: true, data });
const fail = (error: string) => ({ ok: false, error, code: "invalid_input" });

beforeEach(() => {
  for (const fn of Object.values(mocks.actions)) fn.mockReset();
  mocks.refresh.mockReset();
  mocks.push.mockReset();
});
afterEach(cleanup);

const ownerFacts: ActionFacts = {
  status: "issued", paymentStatus: "unpaid", writtenOff: false, balanceMinor: 150000, paidMinor: 0, createdVia: "manual", isAuthor: true, approvalRequiredForCreators: true, hasTestConnection: true,
  isTest: false, can: { create: true, approve: true, send: true, recordPayment: true, void: true, refund: true, connect: true },
};
const actions = (over: Partial<ActionFacts> = {}) => (
  <InvoiceActions invoiceId="11111111-1111-4111-8111-111111111111" version={1} number="INV-0007" status="issued" currency="PHP" balanceMinor={150000} totalMinor={150000} facts={{ ...ownerFacts, ...over }} tz="UTC" hasCustomer closeRuleNote={null} />
);
const dialog = (name: string | RegExp) => screen.getByRole("dialog", { name });
const type = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("recording a payment by hand", () => {
  it("says it is the person's own word and not revenue, and stays closed until there is an amount and evidence", () => {
    render(actions());
    fireEvent.click(screen.getByRole("button", { name: "Record a payment" }));
    const d = dialog("Record a payment you received");
    expect(within(d).getByText(/It is not confirmed by a payment provider, and ₱1,500\.00 is still owed\./)).toBeTruthy();
    expect(within(d).getByText(/shown apart and does not count as verified revenue unless the owner chose that/)).toBeTruthy();
    const confirm = within(d).getByRole("button", { name: "Record payment" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    type(/Amount received/, "500.00");
    expect(confirm.disabled).toBe(true);
    type(/How do you know/, "ab");
    expect(confirm.disabled).toBe(true);
    type(/How do you know/, "Bank transfer ref 4410");
    expect(confirm.disabled).toBe(false);
  });

  it("sends the text exactly as typed with one key, sends the same key again when the first try failed, and starts afresh after it worked", async () => {
    mocks.actions.recordPaymentAction.mockResolvedValueOnce(fail("Another payment may be in progress.")).mockResolvedValueOnce(ok({ duplicate: false, justPaid: false, closeRule: null })).mockResolvedValue(ok({ duplicate: false, justPaid: false, closeRule: null }));
    render(actions());
    const open = () => fireEvent.click(screen.getByRole("button", { name: "Record a payment" }));
    open();
    type(/Amount received/, "500.00");
    type(/How do you know/, "Bank transfer ref 4410");
    fireEvent.click(within(dialog("Record a payment you received")).getByRole("button", { name: "Record payment" }));
    await waitFor(() => expect(mocks.actions.recordPaymentAction).toHaveBeenCalledTimes(1));
    const first = mocks.actions.recordPaymentAction.mock.calls[0];
    expect(first[0]).toBe("11111111-1111-4111-8111-111111111111");
    expect(first[1]).toMatchObject({ amount: "500.00", method: "bank_transfer", evidence: "Bank transfer ref 4410", allowOverpayment: false, overrideOpenAttempt: false });
    expect(first[1].idempotencyKey).toMatch(/^[0-9a-f-]{36}$|^k-/);
    // It failed, so the dialog is still open with what was typed, and trying again is the same request.
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    fireEvent.click(within(dialog("Record a payment you received")).getByRole("button", { name: "Record payment" }));
    await waitFor(() => expect(mocks.actions.recordPaymentAction).toHaveBeenCalledTimes(2));
    expect(mocks.actions.recordPaymentAction.mock.calls[1][1].idempotencyKey).toBe(first[1].idempotencyKey);
    // It worked: the dialog closes, and the next payment is a different request.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    open();
    type(/Amount received/, "100.00");
    type(/How do you know/, "Receipt 77");
    fireEvent.click(within(dialog("Record a payment you received")).getByRole("button", { name: "Record payment" }));
    await waitFor(() => expect(mocks.actions.recordPaymentAction).toHaveBeenCalledTimes(3));
    expect(mocks.actions.recordPaymentAction.mock.calls[2][1].idempotencyKey).not.toBe(first[1].idempotencyKey);
  });
});

describe("a test payment", () => {
  it("says the test is recorded against this test invoice, marked as a test, and that a real invoice is never marked paid by one", () => {
    render(actions({ isTest: true }));
    fireEvent.click(screen.getByRole("button", { name: /Pay as a test/ }));
    const d = dialog("Pay this invoice as a test?");
    expect(within(d).getByText(/no real money moves/)).toBeTruthy();
    expect(within(d).getByText(/recorded against this test invoice, marked as a test/)).toBeTruthy();
    expect(within(d).getByText("Only a test invoice can be paid as a test: a real invoice is never marked paid by one.")).toBeTruthy();
  });

  it("is not offered to anyone who is not the owner, when there is no test account, or on a real invoice", () => {
    render(actions({ isTest: true, can: { ...ownerFacts.can, connect: false } }));
    expect(screen.queryByRole("button", { name: /Pay as a test/ })).toBeNull();
    cleanup();
    render(actions({ isTest: true, hasTestConnection: false }));
    expect(screen.queryByRole("button", { name: /Pay as a test/ })).toBeNull();
    cleanup();
    render(actions({ isTest: false }));
    expect(screen.queryByRole("button", { name: /Pay as a test/ })).toBeNull();
  });
});

describe("voiding and writing off", () => {
  it("asks why, in words long enough to mean something, before it will send", async () => {
    mocks.actions.voidInvoiceAction.mockResolvedValue(ok({ status: "void" }));
    render(actions());
    fireEvent.click(screen.getByRole("button", { name: "Void" }));
    const d = dialog("Void INV-0007?");
    const confirm = within(d).getByRole("button", { name: "Void invoice" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    type("Why is it being voided?", "oops");
    expect(confirm.disabled).toBe(true);
    type("Why is it being voided?", "Raised for the wrong job");
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(mocks.actions.voidInvoiceAction).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", { reason: "Raised for the wrong job" }));
  });

  it("says a write-off is a loss and never revenue, and final", () => {
    render(actions());
    fireEvent.click(screen.getByRole("button", { name: "Write off" }));
    expect(within(dialog("Write off ₱1,500.00?")).getByText(/It is a loss, never revenue, and it is final\./)).toBeTruthy();
  });
});

describe("the customer's link", () => {
  it("is shown only when asked for, with a warning that whoever holds it can see the invoice and start a payment, and that nothing was sent", async () => {
    mocks.actions.getInvoiceLinkAction.mockResolvedValue(ok({ url: "https://app.example/pay/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }));
    render(actions());
    expect(screen.queryByLabelText("The customer's link")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Get the customer's link" }));
    const input = (await screen.findByDisplayValue("https://app.example/pay/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")) as HTMLInputElement;
    expect(input.readOnly).toBe(true);
    expect(screen.getByText(/Anyone who has this link can see this invoice and start a payment\./)).toBeTruthy();
    expect(screen.getByText(/Nothing was sent to anyone\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Replace the link" })).toBeTruthy();
  });
});

describe("a refund", () => {
  const payment: PaymentView = {
    id: "22222222-2222-4222-8222-222222222222", amountMinor: 150000, currency: "PHP", provider: "paymongo", verification: "provider_confirmed", method: "card", status: "succeeded", livemode: true,
    receivedAt: "2026-10-23T01:00:00.000Z", evidence: null, taxPortionMinor: 0, refundedMinor: 50000, recordedByName: null,
  };

  it("is recorded after the money was handed back elsewhere, starts from what is left to refund, needs a reason, and says this product sends nothing", async () => {
    mocks.actions.recordRefundAction.mockResolvedValue(ok({ duplicate: false, reviewTaskCreated: false }));
    render(<PaymentsPanel payments={[payment]} refunds={[]} currency="PHP" canRefund tz="UTC" />);
    fireEvent.click(screen.getByRole("button", { name: /Record a refund/ }));
    const d = dialog("Record a refund");
    expect(within(d).getByText(/This product does not send the refund\. The invoice stays paid; the refund reduces what you kept\./)).toBeTruthy();
    expect((screen.getByLabelText(/Amount refunded/) as HTMLInputElement).value).toBe("1000.00");
    expect(within(d).getByText(/Most you can refund on this payment: 1000\.00/)).toBeTruthy();
    const confirm = within(d).getByRole("button", { name: "Record refund" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    type("Why?", "Customer returned an item");
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(mocks.actions.recordRefundAction).toHaveBeenCalledTimes(1));
    expect(mocks.actions.recordRefundAction.mock.calls[0][0]).toBe(payment.id);
    expect(mocks.actions.recordRefundAction.mock.calls[0][1]).toMatchObject({ amount: "1000.00", reason: "Customer returned an item" });
  });

  it("warns when the provider already reported the same refund, keeps the button closed until the owner says it is a different one, and sends that", async () => {
    mocks.actions.recordRefundAction.mockResolvedValue(ok({ duplicate: false, reviewTaskCreated: false }));
    const theirs = { id: "r1", paymentId: payment.id, amountMinor: 100000, status: "succeeded", source: "provider_event", reason: "Refunded at the provider", createdAt: new Date().toISOString(), recordedByName: null };
    render(<PaymentsPanel payments={[payment]} refunds={[theirs]} currency="PHP" canRefund tz="UTC" />);
    fireEvent.click(screen.getByRole("button", { name: /Record a refund/ }));
    const d = dialog("Record a refund");
    type("Why?", "Refunded in the dashboard");
    // The amount offered is what is left (1000.00), which is exactly what the provider reported: counted twice if recorded again.
    expect(within(d).getByRole("note").textContent).toMatch(/already reported a refund of ₱1,000\.00 on this payment/);
    const confirm = within(d).getByRole("button", { name: "Record refund" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    // Another amount is another refund: no warning.
    type(/Amount refunded/, "250");
    expect(within(d).queryByRole("note")).toBeNull();
    expect(confirm.disabled).toBe(false);
    type(/Amount refunded/, "1000.00");
    expect(confirm.disabled).toBe(true);
    fireEvent.click(within(d).getByRole("checkbox", { name: /This is a different refund/ }));
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(mocks.actions.recordRefundAction).toHaveBeenCalledTimes(1));
    expect(mocks.actions.recordRefundAction.mock.calls[0][1]).toMatchObject({ amount: "1000.00", separateFromProvider: true });
  });

  it("offers no refund on a payment that was refunded in full, or to anyone but the owner", () => {
    const { rerender } = render(<PaymentsPanel payments={[{ ...payment, status: "refunded", refundedMinor: 150000 }]} refunds={[]} currency="PHP" canRefund tz="UTC" />);
    expect(screen.queryByRole("button", { name: /Record a refund/ })).toBeNull();
    rerender(<PaymentsPanel payments={[payment]} refunds={[]} currency="PHP" canRefund={false} tz="UTC" />);
    expect(screen.queryByRole("button", { name: /Record a refund/ })).toBeNull();
  });
});

describe("a dispute the owner records", () => {
  const received: PaymentView = {
    id: "33333333-3333-4333-8333-333333333333", amountMinor: 150000, currency: "PHP", provider: "paypal", verification: "provider_confirmed", method: "paypal", status: "succeeded", livemode: true,
    receivedAt: "2026-10-23T01:00:00.000Z", evidence: null, taxPortionMinor: 0, refundedMinor: 0, recordedByName: null,
  };
  const panel = (p: PaymentView, canRefund = true) => <PaymentsPanel payments={[p]} refunds={[]} currency="PHP" canRefund={canRefund} tz="UTC" />;

  it("can be opened on a payment the provider confirmed, and says what it does to reminders and revenue", async () => {
    mocks.actions.recordDisputeOpenedAction.mockResolvedValue(ok({ status: "disputed" }));
    render(panel(received));
    fireEvent.click(screen.getByRole("button", { name: /Record a dispute/ }));
    const d = dialog("Record a dispute");
    expect(within(d).getByText(/Reminders for the invoice stop, and the payment is held out of your revenue until you record how the dispute ended/)).toBeTruthy();
    type("Note (optional)", "The bank phoned");
    fireEvent.click(within(d).getByRole("button", { name: "Record dispute" }));
    await waitFor(() => expect(mocks.actions.recordDisputeOpenedAction).toHaveBeenCalledTimes(1));
    expect(mocks.actions.recordDisputeOpenedAction.mock.calls[0]).toEqual([received.id, { note: "The bank phoned" }]);
  });

  it("is offered to the owner only, and never on a payment recorded by hand, one still waiting, or one already refunded in full", () => {
    const { rerender } = render(panel(received, false));
    expect(screen.queryByRole("button", { name: /Record a dispute/ })).toBeNull();
    rerender(panel({ ...received, provider: "manual", verification: "manual", livemode: true, evidence: "Cash" }));
    expect(screen.queryByRole("button", { name: /Record a dispute/ })).toBeNull();
    rerender(panel({ ...received, status: "pending" }));
    expect(screen.queryByRole("button", { name: /Record a dispute/ })).toBeNull();
    rerender(panel({ ...received, status: "refunded", refundedMinor: 150000 }));
    expect(screen.queryByRole("button", { name: /Record a dispute/ })).toBeNull();
  });

  it("is closed with how it ended: nothing can be sent until the owner says, and a loss needs how much the buyer got back", async () => {
    mocks.actions.recordDisputeResultAction.mockResolvedValue(ok({ status: "refunded", reviewTaskCreated: false }));
    render(panel({ ...received, status: "disputed", refundedMinor: 50000 }));
    expect(screen.getByText(/Under dispute: held out of your revenue until the result is recorded/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Record how the dispute ended/ }));
    const d = dialog("Record how the dispute ended");
    expect(within(d).getByText(/Nothing is put back as received until you do/)).toBeTruthy();
    const confirm = within(d).getByRole("button", { name: "Record result" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(within(d).getByRole("radio", { name: /We lost/ }));
    // It starts from what is left of the payment, and never offers more.
    expect((screen.getByLabelText(/How much the buyer got back/) as HTMLInputElement).value).toBe("1000.00");
    expect(within(d).getByText(/Most it can be: 1000\.00/)).toBeTruthy();
    type(/How much the buyer got back/, "");
    expect(confirm.disabled).toBe(true);
    type(/How much the buyer got back/, "400");
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(mocks.actions.recordDisputeResultAction).toHaveBeenCalledTimes(1));
    expect(mocks.actions.recordDisputeResultAction.mock.calls[0]).toEqual([received.id, { outcome: "lost", amount: "400", note: null }]);
  });

  it("sends a win without an amount", async () => {
    mocks.actions.recordDisputeResultAction.mockResolvedValue(ok({ status: "succeeded", reviewTaskCreated: false }));
    render(panel({ ...received, status: "disputed" }));
    fireEvent.click(screen.getByRole("button", { name: /Record how the dispute ended/ }));
    const d = dialog("Record how the dispute ended");
    fireEvent.click(within(d).getByRole("radio", { name: /We won/ }));
    expect(screen.queryByLabelText(/How much the buyer got back/)).toBeNull();
    fireEvent.click(within(d).getByRole("button", { name: "Record result" }));
    await waitFor(() => expect(mocks.actions.recordDisputeResultAction).toHaveBeenCalledTimes(1));
    expect(mocks.actions.recordDisputeResultAction.mock.calls[0]).toEqual([received.id, { outcome: "won", note: null }]);
  });
});

describe("connecting a payment account", () => {
  const panel = (providers: Array<"paymongo" | "paypal" | "simulated"> = ["paymongo", "paypal"]) => <ConnectionsPanel connections={[]} providers={providers} callsEnabled liveEnabled={false} tz="UTC" />;

  it("keeps the connect button closed until the key is typed and the wording is accepted, hides the key as it is typed, and sends exactly what was typed with the current wording", async () => {
    mocks.actions.connectProviderAction.mockResolvedValue(ok({ id: "c1", status: "pending_verification" }));
    render(panel());
    const key = screen.getByLabelText(/Secret key/) as HTMLInputElement;
    expect(key.type).toBe("password");
    const connect = screen.getByRole("button", { name: "Check the keys and connect" }) as HTMLButtonElement;
    expect(connect.disabled).toBe(true);
    fireEvent.change(key, { target: { value: "sk_test_AbCdEfGh90abcdef" } });
    expect(connect.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /I am the owner of this business/ }));
    expect(connect.disabled).toBe(false);
    fireEvent.click(connect);
    await waitFor(() => expect(mocks.actions.connectProviderAction).toHaveBeenCalledTimes(1));
    expect(mocks.actions.connectProviderAction.mock.calls[0][0]).toEqual({
      provider: "paymongo", apiKey: "sk_test_AbCdEfGh90abcdef", webhookSecret: null, accountLabel: null, authorization: { accepted: true, version: CURRENT_AUTHORIZATION_VERSION },
    });
    // Saved: what was typed does not stay on the page.
    await waitFor(() => expect((screen.getByLabelText(/Secret key/) as HTMLInputElement).value).toBe(""));
    expect((screen.getByRole("checkbox", { name: /I am the owner of this business/ }) as HTMLInputElement).checked).toBe(false);
  });

  it("keeps what was typed when the provider refused the key, so it can be corrected, and sends PayPal's secret and kind of app", async () => {
    mocks.actions.connectProviderAction.mockResolvedValueOnce(fail("PayPal did not accept this client ID and secret. Nothing was saved.")).mockResolvedValue(ok({ id: "c2", status: "pending_verification" }));
    render(panel(["paypal"]));
    fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: "AbCdEfGhIjKlMnOpQrStUvWx" } });
    fireEvent.change(screen.getByLabelText("Client secret"), { target: { value: "ZyXwVuTsRqPoNmLkJiHgFeDcBa12" } });
    fireEvent.change(screen.getByLabelText("PayPal app"), { target: { value: "live" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /I am the owner of this business/ }));
    fireEvent.click(screen.getByRole("button", { name: "Check the keys and connect" }));
    await waitFor(() => expect(mocks.actions.connectProviderAction).toHaveBeenCalledTimes(1));
    expect(mocks.actions.connectProviderAction.mock.calls[0][0]).toMatchObject({ provider: "paypal", apiKey: "AbCdEfGhIjKlMnOpQrStUvWx", apiSecret: "ZyXwVuTsRqPoNmLkJiHgFeDcBa12", environment: "live", webhookSecret: null });
    expect((screen.getByLabelText("Client ID") as HTMLInputElement).value).toBe("AbCdEfGhIjKlMnOpQrStUvWx");
    expect((screen.getByLabelText("Client secret") as HTMLInputElement).type).toBe("password");
  });

  it("needs only the accepted wording for the testing provider, which has no keys to type", async () => {
    mocks.actions.connectProviderAction.mockResolvedValue(ok({ id: "c3", status: "connected" }));
    render(panel(["simulated"]));
    expect(screen.queryByLabelText(/Secret key/)).toBeNull();
    const connect = screen.getByRole("button", { name: "Check the keys and connect" }) as HTMLButtonElement;
    expect(connect.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /I am the owner of this business/ }));
    expect(connect.disabled).toBe(false);
    fireEvent.click(connect);
    await waitFor(() => expect(mocks.actions.connectProviderAction).toHaveBeenCalledWith({ provider: "simulated", accountLabel: null, authorization: { accepted: true, version: CURRENT_AUTHORIZATION_VERSION } }));
  });
});

describe("authorizing reminders", () => {
  const settings = { version: 4, reminderOffsetsDays: [-3, 0, 3, 10], reminderMax: 4, reminderChannels: ["email"] } as unknown as InvoiceSettings;
  const overview: ReminderOverview = {
    enabled: false, active: false, problem: null, problemText: null, authorizedAt: null, authorizedByName: null, expiresAt: null, wordingVersion: "draft-2026-10-23", wordingIsDraft: true,
    wordingHash: "a".repeat(64), settingsVersion: 4, offsetsDays: [-3, 0, 3, 10], max: 4, channels: ["email"], channelLabels: ["Email"], usesCredits: false,
    previews: [{ stepKey: "before_due:-3", label: "3 days before the due date", subject: "Invoice INV-0001 is due soon", body: "Hello Maria, a reminder that invoice INV-0001 is due. Open it here: the link" }],
    counts: { scheduled: 0, queued: 0, blocked: 0, skipped: 0, cancelled: 0 },
  };
  const panel = (o: ReminderOverview = overview) => <RemindersPanel settings={settings} overview={o} canEdit canSwitchOff tz="UTC" />;

  it("sends the authorization only after the person says they read the messages, with the fingerprint of exactly what was shown", async () => {
    mocks.actions.authorizeRemindersAction.mockResolvedValue(ok({ active: true }));
    render(panel());
    const go = screen.getByRole("button", { name: "Authorize reminders" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /I have read these messages/ }));
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    await waitFor(() => expect(mocks.actions.authorizeRemindersAction).toHaveBeenCalledWith({ wordingHash: "a".repeat(64), settingsVersion: 4 }));
  });

  it("will not authorize what has been edited but not saved, and warns that saving different days switches the authorization off", async () => {
    render(panel({ ...overview, enabled: true, active: true, authorizedByName: "Olive Owner", authorizedAt: "2026-10-23T01:00:00.000Z", expiresAt: "2027-01-21T01:00:00.000Z" }));
    fireEvent.change(screen.getByLabelText("Reminder days"), { target: { value: "-1, 0, 5" } });
    expect(screen.getByText(/switches your authorization off\. You will need to authorize again\./)).toBeTruthy();
    const save = screen.getByRole("button", { name: "Save reminder days and channels" }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.change(screen.getByLabelText("Reminder days"), { target: { value: "soon" } });
    expect(save.disabled).toBe(true);
    expect(screen.getAllByRole("alert").some((a) => /"soon" is not a whole number of days/.test(a.textContent ?? ""))).toBe(true);
  });

  it("hides the switch-off button when reminders are not on, and shows it when they are", () => {
    render(panel());
    expect(screen.queryByRole("button", { name: "Switch reminders off" })).toBeNull();
    cleanup();
    render(panel({ ...overview, enabled: true, active: true }));
    expect(screen.getByRole("button", { name: "Switch reminders off" })).toBeTruthy();
  });
});
