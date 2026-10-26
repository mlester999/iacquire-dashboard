// @vitest-environment jsdom
// The words and buttons of the automatic monthly payment. The owner is always told whether the plan is paid BY HAND or AUTOMATICALLY, an unapproved agreement is never called automatic,
// nothing says a payment arrived, stopping is confirmed and an error from the server is shown instead of "stopped", and the team's release of a hold needs a reason. The actions here
// are stand-ins; the rules behind them are tested against the real service in maintenance-agreement.test.ts.
import * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const projects = vi.hoisted(() => ({
  cancelMaintenanceAction: vi.fn(async () => ({ ok: true as const, data: undefined })),
  createMaintenanceRequestAction: vi.fn(async () => ({ ok: true as const, data: { ref: "MNT-1", id: "r1" } })),
  enrollMaintenanceAction: vi.fn(async () => ({ ok: true as const, data: undefined })),
  startMaintenancePaymentAction: vi.fn(async () => ({ ok: true as const, data: { checkoutUrl: "https://checkout.paymongo.com/x", reference: "IAQ-X" } })),
  startMaintenanceAgreementAction: vi.fn(async (): Promise<{ ok: true; data: { approvalUrl: string } } | { ok: false; error: string }> => ({ ok: true, data: { approvalUrl: "https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-1" } })),
  stopMaintenanceAgreementAction: vi.fn(async (): Promise<{ ok: true; data: undefined } | { ok: false; error: string }> => ({ ok: true, data: undefined })),
  completeAgreementReturnAction: vi.fn(async () => ({ ok: true as const, data: { status: "active" } })),
}));
const admin = vi.hoisted(() => ({
  releaseAgreementHoldAction: vi.fn(async (_id: string, _note: string) => ({ ok: true as const, data: { applied: 1, refused: 0 } })),
  stopAgreementAction: vi.fn(async (_id: string) => ({ ok: true as const, data: undefined })),
  setRecurringBillingAction: vi.fn(async (enabled: boolean) => ({ ok: true as const, data: { enabled, available: enabled, reason: enabled ? null : "Automatic payments are switched off in the billing settings.", livemode: false } })),
}));
vi.mock("@/app/actions/projects", () => projects);
vi.mock("@/app/actions/support", () => ({ createTicketAction: vi.fn(async () => ({ ok: true as const, data: { ref: "T-1", id: "t1" } })) }));
vi.mock("@/app/(admin)/admin/maintenance/actions", () => ({ ...admin, activateMaintenanceAction: vi.fn(), resolveMaintenanceAction: vi.fn(), updateMaintenanceRequestAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

import { MaintenancePanel } from "@/components/projects/maintenance-panel";
import { AgreementBlock } from "@/components/admin/agreement-block";
import { RecurringBillingSwitch } from "@/components/admin/recurring-billing-switch";
import { TooltipProvider } from "@/components/ui/overlays";
import type { AgreementView } from "@/server/maintenance/agreement-read";

const assign = vi.fn();
beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, assign } });
});
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

const agreement = (over: Partial<AgreementView> = {}): AgreementView => ({
  id: "ag-1", reference: "IAQ-AGREEMENT01", status: "active", provider: "paypal", livemode: false, amountMinor: 29_900, currency: "USD", nextBillingAt: "2026-11-26T00:00:00.000Z", failedPayments: 0,
  hold: null, holdSince: null, approvalUrl: null, heldCharges: 0, createdAt: "2026-10-26T00:00:00.000Z", ...over,
});

const overview = (over: Record<string, unknown> = {}) => ({
  eligible: true, eligibilityNote: null, plan: null, allowance: null, requests: [],
  subscription: {
    id: "sub-1", status: "active" as const, monthlyPriceCents: 29_900, currency: "USD", monthlyRequestAllowance: 4, termsVersion: "v1", acceptedAt: "2026-09-01T00:00:00Z", activatedAt: "2026-09-02T00:00:00Z",
    billingStartOn: "2026-09-02", renewalOn: null, paidThroughOn: "2026-11-05", cancelRequestedAt: null,
  },
  payOnline: { offered: true }, agreement: null, recurring: { offered: true }, ...over,
});
const panel = (o: ReturnType<typeof overview>, canManagePlan = true) => render(<TooltipProvider><MaintenancePanel overview={o as never} timeZone="UTC" canManagePlan={canManagePlan} canRequest /></TooltipProvider>);

describe("how the owner is told the plan is paid", () => {
  it("says a plan with no agreement is paid by hand, and offers PayPal only when it can be taken", () => {
    const { container } = panel(overview());
    const block = screen.getByLabelText("How this plan is paid");
    expect(block.textContent).toMatch(/Paid by hand each period/);
    expect(block.textContent).toMatch(/By hand/);
    expect(screen.getByRole("button", { name: "Pay monthly automatically with PayPal" })).toBeTruthy();
    expect(container.textContent).not.toMatch(/Automatic payments are on/);
    cleanup();
    panel(overview({ recurring: { offered: false } }));
    expect(screen.queryByRole("button", { name: "Pay monthly automatically with PayPal" })).toBeNull();
  });

  it("offers nothing to someone who may not manage the plan", () => {
    panel(overview(), false);
    expect(screen.queryByRole("button", { name: "Pay monthly automatically with PayPal" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop automatic payments" })).toBeNull();
  });

  it("explains before PayPal opens that nothing is charged here and a month counts only when PayPal confirms it, then sends the owner to PayPal's own page", async () => {
    panel(overview());
    fireEvent.click(screen.getByRole("button", { name: "Pay monthly automatically with PayPal" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch(/Nothing is charged here/);
    expect(dialog.textContent).toMatch(/only when PayPal confirms the charge/);
    expect(dialog.textContent).toMatch(/\$299\.00 each month/);
    expect(dialog.textContent).toMatch(/paid through .*first automatic charge comes after that day/);
    expect(dialog.textContent).toMatch(/never switched off/);
    fireEvent.click(screen.getByRole("button", { name: "Continue to PayPal" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-1"));
    expect(projects.startMaintenanceAgreementAction).toHaveBeenCalledTimes(1);
    expect(projects.startMaintenanceAgreementAction.mock.calls[0]).toEqual([]); // the browser sends nothing: the price is the plan's
  });

  it("shows a refusal and stays on the page when PayPal cannot be set up", async () => {
    projects.startMaintenanceAgreementAction.mockResolvedValueOnce({ ok: false, error: "PayPal couldn't set up automatic payments right now. Nothing was charged." });
    panel(overview());
    fireEvent.click(screen.getByRole("button", { name: "Pay monthly automatically with PayPal" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue to PayPal" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Nothing was charged/);
    expect(assign).not.toHaveBeenCalled();
  });

  it("does not call an unapproved agreement automatic, and gives only the owner the way back to PayPal", () => {
    const pending = agreement({ status: "approval_pending", approvalUrl: "https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-2", nextBillingAt: null });
    panel(overview({ agreement: pending, recurring: { offered: false } }));
    const block = screen.getByLabelText("How this plan is paid");
    expect(block.textContent).toMatch(/waiting for your approval/);
    expect(block.textContent).toMatch(/still paid by hand/);
    expect(block.textContent).not.toMatch(/Automatic payments are on/);
    const link = screen.getByRole("link", { name: /Continue to PayPal to approve/ });
    expect(link.getAttribute("href")).toBe(pending.approvalUrl);
    cleanup();
    panel(overview({ agreement: { ...pending, approvalUrl: null }, recurring: { offered: false } }), false);
    expect(screen.queryByRole("link", { name: /Continue to PayPal to approve/ })).toBeNull();
  });

  it("says automatic payments are on only for an active agreement, with the next charge, and that a charge counts only once confirmed", () => {
    panel(overview({ agreement: agreement(), recurring: { offered: false } }));
    const block = screen.getByLabelText("How this plan is paid");
    expect(block.textContent).toMatch(/Automatic/);
    expect(block.textContent).toMatch(/Automatic payments are on/);
    expect(block.textContent).toMatch(/2026-11-26/);
    expect(block.textContent).toMatch(/only when PayPal confirms the charge/);
    expect(screen.getByRole("button", { name: "Stop automatic payments" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pay monthly automatically with PayPal" })).toBeNull();
  });

  it("says when automatic payments are paused or on hold, and what a hold means", () => {
    panel(overview({ agreement: agreement({ status: "suspended", failedPayments: 3 }), recurring: { offered: false } }));
    expect(screen.getByLabelText("How this plan is paid").textContent).toMatch(/paused.*after 3 failed charges/s);
    cleanup();
    panel(overview({ agreement: agreement({ hold: "disputed", holdSince: "2026-10-30T00:00:00.000Z" }), recurring: { offered: false } }));
    const held = screen.getByLabelText("How this plan is paid").textContent ?? "";
    expect(held).toMatch(/on hold/);
    expect(held).toMatch(/recorded but a person at iAcquire reviews them before the plan is extended/);
  });

  it("an ended agreement reads as paid by hand again, and offers a new one", () => {
    panel(overview({ agreement: agreement({ status: "cancelled", nextBillingAt: null }), recurring: { offered: true } }));
    const block = screen.getByLabelText("How this plan is paid");
    expect(block.textContent).toMatch(/Paid by hand each period/);
    expect(block.textContent).toMatch(/stopped/);
    expect(screen.queryByRole("button", { name: "Stop automatic payments" })).toBeNull();
    expect(screen.getByRole("button", { name: "Pay monthly automatically with PayPal" })).toBeTruthy();
  });

  it("confirms before stopping, says the plan is unchanged, and shows the error rather than 'stopped' when PayPal could not be reached", async () => {
    projects.stopMaintenanceAgreementAction.mockResolvedValueOnce({ ok: false, error: "PayPal couldn't be reached to stop the automatic payment, so it is still on." });
    panel(overview({ agreement: agreement(), recurring: { offered: false } }));
    fireEvent.click(screen.getByRole("button", { name: "Stop automatic payments" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch(/Your plan stays exactly as it is/);
    expect(dialog.textContent).toMatch(/never shown as stopped when it is not/);
    expect(projects.stopMaintenanceAgreementAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: "Stop automatic payments" }).at(-1)!);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/still on/);
    // And when it works, the owner is told the plan is unchanged.
    fireEvent.click(screen.getAllByRole("button", { name: "Stop automatic payments" }).at(-1)!);
    await waitFor(() => expect(projects.stopMaintenanceAgreementAction).toHaveBeenCalledTimes(2));
  });
});

describe("the team's view of an agreement", () => {
  it("reads like the client's, with the failed charges and any charge recorded but not yet added", () => {
    render(<AgreementBlock agreement={agreement({ failedPayments: 2, heldCharges: 1, hold: "refunded", holdSince: "2026-10-30T00:00:00.000Z" })} />);
    const block = screen.getByLabelText("How this plan is paid");
    expect(block.textContent).toMatch(/Automatic · PayPal/);
    expect(block.textContent).toMatch(/on hold/);
    expect(block.textContent).toMatch(/2 failed charges/);
    expect(block.textContent).toMatch(/1 charge recorded and not yet added to the plan/);
  });

  it("says by hand when there is no agreement, and offers nothing to stop or release", () => {
    render(<AgreementBlock agreement={null} />);
    expect(screen.getByLabelText("How this plan is paid").textContent).toMatch(/Paid by hand each period/);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("releases a hold only with a reason, and sends exactly that reason", async () => {
    render(<AgreementBlock agreement={agreement({ hold: "disputed", holdSince: "2026-10-30T00:00:00.000Z", heldCharges: 1 })} />);
    const release = screen.getByRole("button", { name: "Release hold" }) as HTMLButtonElement;
    expect(release.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Why the hold can be released"), { target: { value: "Dispute won" } });
    expect(release.disabled).toBe(false);
    fireEvent.click(release);
    await waitFor(() => expect(admin.releaseAgreementHoldAction).toHaveBeenCalledWith("ag-1", "Dispute won"));
  });

  it("stops an agreement from the team's side", async () => {
    render(<AgreementBlock agreement={agreement()} />);
    expect(screen.queryByRole("button", { name: "Release hold" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop automatic payments" }));
    await waitFor(() => expect(admin.stopAgreementAction).toHaveBeenCalledWith("ag-1"));
  });
});

describe("the Super Admin's switch", () => {
  it("is off to start with, says why when nothing can be offered, and only a Super Admin can change it", async () => {
    const off = { enabled: false, available: false, reason: "Automatic payments are switched off in the billing settings.", livemode: false };
    render(<RecurringBillingSwitch initial={off} canManage />);
    expect(screen.getByLabelText("Automatic payments").textContent).toMatch(/Off/);
    expect(screen.getByLabelText("Automatic payments").textContent).toMatch(/switched off in the billing settings/);
    fireEvent.click(screen.getByRole("switch", { name: /pay the maintenance plan automatically/ }));
    await waitFor(() => expect(admin.setRecurringBillingAction).toHaveBeenCalledWith(true));
    cleanup();
    render(<RecurringBillingSwitch initial={off} canManage={false} />);
    expect((screen.getByRole("switch", { name: /pay the maintenance plan automatically/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByLabelText("Automatic payments").textContent).toMatch(/Only a Super Admin can change this/);
  });
});
