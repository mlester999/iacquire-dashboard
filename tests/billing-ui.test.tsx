// @vitest-environment jsdom
// The Super Admin's payment controls, rendered in a test DOM (not a real browser): the Payments tab, the record-a-payment dialog, the waiver dialog and the refund dialog.
// They say what a recorded payment is (a person's record), label every field, keep the action disabled until the required fields are filled, and show an error where the
// person is looking. The actions themselves are replaced; the services behind them are tested in tests/billing-manual.test.ts.
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PaymentsWorkspace, RefundDialog, WaiveFeeDialog } from "@/components/admin/payments-workspace";
import { OnboardedBanner } from "@/components/setup/onboarded-banner";
import { AGENT_BY_KEY, AGENT_ROLE_KEYS } from "@/lib/agents";
import { PAYMENT_REQUIRED_SENTENCE } from "@/lib/billing-clearance";
import type { AgencyPaymentView, PaymentClientOption } from "@/server/billing/payments-view";

const mocks = vi.hoisted(() => ({
  record: vi.fn(async (..._a: unknown[]) => ({ ok: true as const, data: { duplicate: false, clearedSetup: true } }) as { ok: true; data: { duplicate: boolean; clearedSetup: boolean } } | { ok: false; error: string }),
  waive: vi.fn(async (..._a: unknown[]) => ({ ok: true as const, data: { changed: true } }) as { ok: true; data: { changed: boolean } } | { ok: false; error: string }),
  refund: vi.fn(async (..._a: unknown[]) => ({ ok: true as const, data: { setupRefunded: true } }) as { ok: true; data: { setupRefunded: boolean } } | { ok: false; error: string }),
  refresh: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: mocks.refresh, back: vi.fn() }) }));
vi.mock("next/link", async () => {
  const React = await import("react");
  const Link = React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }>(function Link({ href, ...props }, ref) {
    return <a {...props} href={href} ref={ref} />;
  });
  return { default: Link };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/app/(admin)/admin/billing/actions", () => ({ recordManualPaymentAction: mocks.record, waiveSetupFeeAction: mocks.waive, recordRefundForPaymentAction: mocks.refund }));

const payment = (over: Partial<AgencyPaymentView> = {}): AgencyPaymentView => ({
  id: "p1", orgId: "o1", orgName: "Harbor Roofing", kind: "setup_fee", status: "paid", provider: "manual", method: "bank_transfer", description: "Setup fee (recorded by iAcquire)", usdMicros: 1_499_000_000, refundedMicros: 0,
  referenceNumber: "IAQ-ABCDEFGHJKMN", externalReference: "BDO-0042", verificationNote: "Seen on the October statement", verifiedByName: "Avery Admin", paidOn: "2026-10-23", paidAt: "2026-10-23T04:00:00.000Z",
  createdAt: "2026-10-23T04:00:00.000Z", clearedSetup: true, providerNotices: [], ...over,
});
const clients: PaymentClientOption[] = [
  { orgId: "o1", name: "Harbor Roofing", setupStatus: "paid", setupFeeCents: 149900, cleared: true },
  { orgId: "o2", name: "Pine Plumbing", setupStatus: "not_invoiced", setupFeeCents: 149900, cleared: false },
];
const ui = (over: Partial<React.ComponentProps<typeof PaymentsWorkspace>> = {}) =>
  render(<PaymentsWorkspace payments={[payment(), payment({ id: "p2", provider: "paymongo", method: null, externalReference: null, verificationNote: null, verifiedByName: null, kind: "credit_topup", usdMicros: 50_000_000, clearedSetup: false, orgName: "Pine Plumbing" })]} clients={clients} canManage timeZone="America/Chicago" {...over} />);

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("the Payments tab", () => {
  it("says who proved each payment, never that one was detected, and lists the clients still waiting", () => {
    ui();
    const text = document.body.textContent ?? "";
    expect(text).toContain("Recorded by hand: Bank transfer");
    expect(text).toContain("PayMongo, confirmed by its signed notice");
    expect(text).toContain("Cleared the setup fee");
    expect(text).toContain("Checked by Avery Admin: Seen on the October statement");
    expect(text).not.toMatch(/detected/i);
    expect(screen.getByText("Setup fee not confirmed (1)")).toBeTruthy();
    const waiting = screen.getByRole("link", { name: "Pine Plumbing" });
    expect(waiting.getAttribute("href")).toBe("/admin/clients/o2?tab=billing");
  });

  it("attributes a refund, a dispute or a reversal to the provider that reported it, never to another one", () => {
    const at = "2026-10-26T04:00:00.000Z";
    ui({
      payments: [
        payment({ id: "pp", provider: "paypal", method: "paypal", kind: "setup_fee", providerNotices: [{ type: "PAYMENT.CAPTURE.REFUNDED", detail: null, receivedAt: at }] }),
        payment({ id: "pm", provider: "paymongo", method: "card", kind: "credit_topup", providerNotices: [{ type: "payment.dispute.created", detail: null, receivedAt: at }] }),
        payment({ id: "pr", provider: "paypal", method: "paypal", kind: "setup_fee", providerNotices: [{ type: "PAYMENT.SALE.REVERSED", detail: null, receivedAt: at }] }),
        payment({ id: "px", provider: "stripe", method: null, kind: "setup_fee", providerNotices: [{ type: "charge.refunded", detail: null, receivedAt: at }] }),
      ],
    });
    const text = document.body.textContent ?? "";
    expect(text).toContain("PayPal reported a refund");
    expect(text).toContain("PayMongo reported a dispute");
    expect(text).toContain("PayPal reported a reversal");
    expect(text).toContain("The payment provider reported a refund");
    expect(text).not.toContain("PayMongo reported a refund");
    expect(screen.getAllByLabelText("Reported by PayPal")).toHaveLength(2);
    expect(screen.getAllByLabelText("Reported by PayMongo")).toHaveLength(1);
    expect(screen.getAllByLabelText("Reported by the payment provider")).toHaveLength(1);
  });

  it("offers a Super Admin the controls, and only the controls that apply", () => {
    ui();
    expect(screen.getByRole("button", { name: /Record a payment/ })).toBeTruthy();
    // Only the paid setup fee can be refunded here; the service-credit row is a provider payment that is refunded the same way, so it has the button too.
    expect(screen.getAllByRole("button", { name: /Record a refund/ })).toHaveLength(2);
    cleanup();
    ui({ payments: [payment({ status: "refunded", refundedMicros: 1_499_000_000 }), payment({ id: "p3", status: "mismatch", provider: "paymongo" })] });
    expect(screen.queryByRole("button", { name: /Record a refund/ })).toBeNull();
    expect(screen.getByText("Did not match the checkout")).toBeTruthy();
    cleanup();
    ui({ canManage: false });
    expect(screen.queryByRole("button", { name: /Record a payment/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Record a refund/ })).toBeNull();
  });

  it("shows an honest empty state", () => {
    ui({ payments: [], clients: [] });
    expect(screen.getByText("No payments yet")).toBeTruthy();
  });
});

describe("recording a payment", () => {
  const open = () => { ui(); fireEvent.click(screen.getByRole("button", { name: /Record a payment/ })); return within(screen.getByRole("dialog")); };

  it("labels every field, offers the agreed fee without assuming it, and keeps the button off until the form is complete", async () => {
    const dialog = open();
    expect(dialog.getByText(/It is your record, not something the portal detected/)).toBeTruthy();
    for (const label of ["Client", "What it paid for", "Amount (US dollars)", "How it arrived", "Day the money arrived", "Bank reference, receipt number or transaction id", "What you checked"]) expect(dialog.getByLabelText(label), label).toBeTruthy();
    const submit = dialog.getByRole("button", { name: "Record payment" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(dialog.getByLabelText("Client"), { target: { value: "o2" } });
    await waitFor(() => expect((dialog.getByLabelText("Amount (US dollars)") as HTMLInputElement).value).toBe("1499.00"));
    fireEvent.change(dialog.getByLabelText("Bank reference, receipt number or transaction id"), { target: { value: "BDO-0099" } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(dialog.getByLabelText("What you checked"), { target: { value: "October statement, line 14" } });
    await waitFor(() => expect(submit.disabled).toBe(false));
  });

  it("sends exactly what was typed, then refreshes", async () => {
    const dialog = open();
    fireEvent.change(dialog.getByLabelText("Client"), { target: { value: "o2" } });
    fireEvent.change(dialog.getByLabelText("How it arrived"), { target: { value: "cash" } });
    fireEvent.change(dialog.getByLabelText("Bank reference, receipt number or transaction id"), { target: { value: "BDO-0099" } });
    fireEvent.change(dialog.getByLabelText("What you checked"), { target: { value: "Receipt book page 4" } });
    await waitFor(() => expect((dialog.getByLabelText("Amount (US dollars)") as HTMLInputElement).value).toBe("1499.00"));
    fireEvent.click(dialog.getByRole("button", { name: "Record payment" }));
    await waitFor(() => expect(mocks.record).toHaveBeenCalledTimes(1));
    const [orgId, input] = mocks.record.mock.calls[0] as [string, Record<string, unknown>];
    expect(orgId).toBe("o2");
    expect(input).toMatchObject({ kind: "setup_fee", amount: "1499.00", method: "cash", externalReference: "BDO-0099", note: "Receipt book page 4", paidThroughOn: null });
    expect(String(input.paidOn)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
  });

  it("asks for the period a maintenance payment covers, and for nothing else extra", () => {
    const dialog = open();
    expect(dialog.queryByLabelText("Last day this payment covers")).toBeNull();
    fireEvent.change(dialog.getByLabelText("What it paid for"), { target: { value: "maintenance" } });
    expect(dialog.getByLabelText("Last day this payment covers")).toBeTruthy();
  });

  it("shows the server's refusal in an alert and keeps the dialog open", async () => {
    mocks.record.mockResolvedValueOnce({ ok: false, error: "That reference is already recorded for a different payment." });
    const dialog = open();
    fireEvent.change(dialog.getByLabelText("Client"), { target: { value: "o2" } });
    fireEvent.change(dialog.getByLabelText("Bank reference, receipt number or transaction id"), { target: { value: "BDO-0042" } });
    fireEvent.change(dialog.getByLabelText("What you checked"), { target: { value: "October statement, line 14" } });
    await waitFor(() => expect((dialog.getByRole("button", { name: "Record payment" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(dialog.getByRole("button", { name: "Record payment" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("already recorded for a different payment");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});

describe("what the client sees while the setup payment is unconfirmed", () => {
  const agents = AGENT_ROLE_KEYS.map((role) => ({
    role_key: role, display_name: AGENT_BY_KEY[role].shortName, enabled: true, status: "provisioning", config_version: 1, last_health_check_at: null, last_health_ok: null, last_health_detail: null,
    tool_inventory_contract: null, tool_inventory_digest: null, tool_inventory_verified_at: null, tool_inventory_expires_at: null, tool_inventory_tool_count: null, credential_ready: true, hermes_profile: null,
  }));
  const banner = (paymentCleared: boolean | undefined, provisioning: Array<{ role: (typeof AGENT_ROLE_KEYS)[number]; status: string | null; detail: string | null }> = []) =>
    render(<OnboardedBanner nativeCrm crmGuide agents={agents as never} provisioning={provisioning} paymentCleared={paymentCleared} />);

  it("every employee card says it is waiting for the payment, in the plain sentence", () => {
    banner(false);
    expect(screen.getAllByText("Waiting for setup payment")).toHaveLength(6);
    expect(screen.getAllByText(`${PAYMENT_REQUIRED_SENTENCE}.`)).toHaveLength(6);
    expect(screen.getByText("0/6 ready")).toBeTruthy();
  });

  it("says nothing about payment once it is confirmed, or when the page did not ask", () => {
    banner(true);
    expect(document.body.textContent).not.toContain("setup payment");
    cleanup();
    banner(undefined);
    expect(document.body.textContent).not.toContain("setup payment");
  });

  it("never overwrites what a recorded provisioning request says", () => {
    banner(false, [{ role: "lead_hunter", status: "in_progress", detail: null }]);
    expect(screen.getAllByText("Waiting for setup payment")).toHaveLength(5);
    expect(screen.getAllByText("Provisioning")).toHaveLength(1);
  });
});

describe("waiving the fee and recording a refund", () => {
  it("a waiver needs a reason of at least ten characters and says the client will not see it", async () => {
    render(<WaiveFeeDialog open onOpenChange={() => undefined} orgId="o2" orgName="Pine Plumbing" />);
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText(/the client does not see it/)).toBeTruthy();
    const button = dialog.getByRole("button", { name: "Waive the fee" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(dialog.getByLabelText("Why is the fee waived?"), { target: { value: "too short" } });
    expect(button.disabled).toBe(true);
    fireEvent.change(dialog.getByLabelText("Why is the fee waived?"), { target: { value: "Founding client, agreed in writing" } });
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(mocks.waive).toHaveBeenCalledWith("o2", "Founding client, agreed in writing"));
  });

  it("a refund starts at what is left, says it only records, and warns about a full refund of the setup fee", async () => {
    const onClose = vi.fn();
    render(<RefundDialog payment={payment({ refundedMicros: 99_000_000 })} onClose={onClose} timeZone="UTC" />);
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText(/only records a refund you already made/)).toBeTruthy();
    expect(dialog.getByText(/Anything already running keeps running/)).toBeTruthy();
    expect((dialog.getByLabelText("Amount refunded (US dollars)") as HTMLInputElement).value).toBe("1400.00");
    fireEvent.change(dialog.getByLabelText("Why was it refunded?"), { target: { value: "Client cancelled before the work began" } });
    fireEvent.click(dialog.getByRole("button", { name: "Record refund" }));
    await waitFor(() => expect(mocks.refund).toHaveBeenCalledWith("p1", "1400.00", "Client cancelled before the work began"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
