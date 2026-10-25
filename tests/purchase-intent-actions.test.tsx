// @vitest-environment jsdom
// What a Super Admin is offered on one purchase, in a browser-like document: a purchase on hold shows the hold's two honest ways out (release it after checking with the provider, or
// close it without a workspace), never "Create client workspace"; each needs words from the person; and the wording says what closing does. The service rules behind them are in
// purchase-checkout.test.ts and purchase-intents-rules.test.ts.
import * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ release: vi.fn(), cancel: vi.fn(), provision: vi.fn(), verify: vi.fn(), rotate: vi.fn(), refresh: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/app/actions/purchase-intents", () => ({
  releasePurchaseHoldAction: mocks.release, cancelPurchaseIntentAction: mocks.cancel, provisionPurchaseIntentAction: mocks.provision,
  verifyPurchasePaymentAction: mocks.verify, rotatePurchaseLinkAction: mocks.rotate,
}));

import { PurchaseIntentActions } from "@/components/purchase-intents/actions";
import type { PurchaseIntentView } from "@/server/purchase-intents/service";

const base: PurchaseIntentView = {
  id: "6f1f0d9e-0000-4000-8000-0000000000b1", reference: "PUR-TESTONLY01", buyerName: "Bailey Buyer", buyerEmail: "bailey@example.test", company: "Buyer Co", industry: "", website: "", timezone: "America/Chicago",
  maintenanceSelected: false, setupFeeCents: 149900, maintenanceMonthlyCents: 29900, currency: "USD", productVersion: "launch-2026-10", status: "payment_verified", storedStatus: "payment_verified",
  statusText: "Payment verified", statusTone: "warning", expiresAt: "2026-11-08T12:00:00.000Z", startedAt: "2026-10-25T12:00:00.000Z", paymentAt: "2026-10-25T12:05:00.000Z", provisionedAt: null,
  cancelledAt: null, expiredAt: null, paymentMethod: "paymongo", paymentReference: "pay_test", paymentPaidOn: "2026-10-25", paymentNote: "Confirmed by the provider.", paymentAmountCents: 149900,
  clientOrgId: null, autoProvision: false, paymentSource: "provider", paymentHold: "refunded", holdText: "The payment provider reported a refund for this payment.", provisionAttempts: 0,
  lastProvisionError: null, createdAt: "2026-10-25T12:00:00.000Z",
  can: { start: false, verify: false, provision: false, cancel: true, rotate: false, release: true },
};

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});
beforeEach(() => {
  // (Block bodies: a returned mock would be run by vitest as a cleanup.)
  for (const m of Object.values(mocks)) m.mockReset();
});
afterEach(cleanup);

describe("a purchase on hold", () => {
  it("offers to release the hold or close the purchase, and never to create the workspace", () => {
    render(<PurchaseIntentActions intent={base} />);
    expect(screen.getByRole("button", { name: /Release the hold/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Close without a workspace/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Create client workspace/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Cancel$/ })).toBeNull();
  });

  it("sends what the person checked when releasing, and refreshes the page", async () => {
    mocks.release.mockResolvedValue({ ok: true, data: {} });
    render(<PurchaseIntentActions intent={base} />);
    fireEvent.click(screen.getByRole("button", { name: /Release the hold/ }));
    expect(screen.getByText(/only after you checked with the payment provider that this payment stands/)).toBeTruthy();
    const note = screen.getByLabelText("What did you check with the provider?");
    fireEvent.change(note, { target: { value: "PayMongo shows this payment as paid in full." } });
    fireEvent.click(screen.getAllByRole("button", { name: "Release the hold" }).at(-1) as HTMLElement);
    await waitFor(() => expect(mocks.release).toHaveBeenCalledWith({ id: base.id, note: "PayMongo shows this payment as paid in full." }));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
  });

  it("explains what closing does, asks why, and keeps the form open when the server refuses", async () => {
    mocks.cancel.mockResolvedValue({ ok: false, error: "This purchase cannot be cancelled." });
    render(<PurchaseIntentActions intent={base} />);
    fireEvent.click(screen.getByRole("button", { name: /Close without a workspace/ }));
    expect(screen.getByText(/the payment record stays on this purchase/)).toBeTruthy();
    expect(screen.getByText(/cannot be undone/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Why is it being closed?"), { target: { value: "The cardholder won the dispute." } });
    fireEvent.click(screen.getByRole("button", { name: "Close the purchase" }));
    await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith({ id: base.id, reason: "The cardholder won the dispute." }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/cannot be cancelled/);
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Why is it being closed?")).toBeTruthy();
  });
});

describe("a purchase that is not on hold", () => {
  it("keeps the ordinary wording: cancel an unpaid purchase, and nothing to release", () => {
    const unpaid: PurchaseIntentView = { ...base, status: "started", storedStatus: "started", paymentHold: null, holdText: null, paymentReference: null, paymentSource: "manual", can: { ...base.can, release: false, verify: true } };
    render(<PurchaseIntentActions intent={unpaid} />);
    expect(screen.queryByRole("button", { name: /Release the hold/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));
    expect(screen.getByLabelText("Why is it being cancelled?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel the purchase" })).toBeTruthy();
  });

  it("offers the workspace once the payment is verified and nothing holds it", () => {
    const ready: PurchaseIntentView = { ...base, paymentHold: null, holdText: null, can: { ...base.can, release: false, provision: true, cancel: false } };
    render(<PurchaseIntentActions intent={ready} />);
    expect(screen.getByRole("button", { name: /Create client workspace/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Close without a workspace/ })).toBeNull();
  });
});
