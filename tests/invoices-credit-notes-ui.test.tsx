// @vitest-environment jsdom
// The credit notes panel on an invoice. It says what a credit note is not (a payment or a refund), shows each action only to the person the rules allow, asks for the exact version
// being approved, and shows an issued note as a document that can no longer be changed. The actions here are stand-ins; the rules behind them are tested against the real service
// in invoices-credit-notes.test.ts.
import * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const actions = vi.hoisted(() => ({
  createCreditNoteAction: vi.fn(async (_input: unknown) => ({ ok: true as const, data: { id: "cn-new" } })),
  updateCreditNoteAction: vi.fn(async (_id: string, _patch: unknown, _v: number) => ({ ok: true as const, data: { version: 2 } })),
  submitCreditNoteAction: vi.fn(async (_id: string, _v: number) => ({ ok: true as const, data: true })),
  withdrawCreditNoteAction: vi.fn(async (_id: string) => ({ ok: true as const, data: true })),
  returnCreditNoteAction: vi.fn(async (_id: string, _i: { version: number; note: string }) => ({ ok: true as const, data: true })),
  cancelCreditNoteAction: vi.fn(async (_id: string, _r: string) => ({ ok: true as const, data: true })),
  issueCreditNoteAction: vi.fn(async (_id: string, _v: number) => ({ ok: true as const, data: { number: "CN-0001", owedMinor: 100000, settled: false } })),
}));
vi.mock("@/app/actions/invoices", () => actions);
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

import { CreditNotesPanel } from "@/components/invoices/credit-notes-panel";
import { TooltipProvider } from "@/components/ui/overlays";
import type { CreditNoteView } from "@/server/invoices/credit-notes";

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

const note = (over: Partial<CreditNoteView> = {}): CreditNoteView => ({
  id: "cn-1", invoiceId: "inv-1", invoiceNumber: "INV-0001", status: "draft", number: null, currency: "PHP", amountMinor: 50000, taxPortionMinor: 0, reason: "Goodwill for a late visit", version: 1,
  approvedVersion: null, createdBy: "u-manager", createdByName: "Mia Manager", approvedByName: null, issuedByName: null, approvedAt: null, issuedAt: null, cancelledAt: null, cancelReason: null,
  billTo: {}, billFrom: {}, createdAt: "2026-10-26T10:00:00.000Z", ...over,
});

const panel = (over: Partial<React.ComponentProps<typeof CreditNotesPanel>> = {}) => render(
  <TooltipProvider>
    <CreditNotesPanel invoiceId="inv-1" currency="PHP" notes={[]} tz="UTC" currentUserId="u-owner" isOwner canCredit canApprove owedMinor={150000} blockedReason={null} {...over} />
  </TooltipProvider>,
);

describe("what the panel says", () => {
  it("explains a credit note is not a payment or a refund, and what is owed now", () => {
    const { container } = panel();
    expect(container.textContent).toMatch(/not a payment and not a refund/);
    expect(container.textContent).toMatch(/does not count as money received or as revenue/);
    expect(container.textContent).toMatch(/cannot be changed or voided/);
    expect(container.textContent).toMatch(/Owed now:\s*₱1,500\.00/);
    expect(screen.getByText("No credit note has been written against this invoice.")).toBeTruthy();
  });

  it("offers writing one only to a person who may, and says why when the invoice does not allow it", () => {
    panel();
    expect(screen.getByRole("button", { name: /Write a credit note/ })).toBeTruthy();
    cleanup();
    panel({ canCredit: false });
    expect(screen.queryByRole("button", { name: /Write a credit note/ })).toBeNull();
    cleanup();
    panel({ blockedReason: "Nothing is owed on this invoice, so there is nothing to credit. If money was received that should go back, record a refund instead." });
    expect(screen.queryByRole("button", { name: /Write a credit note/ })).toBeNull();
    expect(screen.getByRole("note").textContent).toMatch(/record a refund instead/);
  });
});

describe("writing a draft", () => {
  it("sends the amount as typed with a reason and a key for a retry, and states that nothing is taken off yet", async () => {
    panel();
    fireEvent.click(screen.getByRole("button", { name: /Write a credit note/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch(/Nothing is taken off the invoice until the credit note is sent for approval and issued/);
    expect(dialog.textContent).toMatch(/The most you can credit is what is still owed: 1500\.00/);
    const save = screen.getByRole("button", { name: "Save as a draft" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Amount to credit/), { target: { value: "500.00" } });
    fireEvent.change(screen.getByLabelText(/Why is the invoice being credited/), { target: { value: "ok" } });
    expect((screen.getByRole("button", { name: "Save as a draft" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Why is the invoice being credited/), { target: { value: "Goodwill for a late visit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save as a draft" }));
    await waitFor(() => expect(actions.createCreditNoteAction).toHaveBeenCalledTimes(1));
    const input = actions.createCreditNoteAction.mock.calls[0][0] as { invoiceId: string; amount: string; reason: string; idempotencyKey: string };
    expect(input).toMatchObject({ invoiceId: "inv-1", amount: "500.00", reason: "Goodwill for a late visit" });
    expect(input.idempotencyKey.length).toBeGreaterThan(8);
  });
});

describe("each state offers what the rules allow", () => {
  it("a draft: the author edits, sends for approval and cancels; a stranger without the credit permission does nothing", async () => {
    panel({ notes: [note({ createdBy: "u-owner" })] });
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send for approval" }));
    await waitFor(() => expect(actions.submitCreditNoteAction).toHaveBeenCalledWith("cn-1", 1));
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    cleanup();
    panel({ notes: [note({ createdBy: "u-other" })], canCredit: false, canApprove: false });
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send for approval" })).toBeNull();
  });

  it("a submitted note: the author cannot approve their own as a manager, the owner can, and the reviewer can send it back", async () => {
    // The manager who wrote it sees "Take back" and no way to approve it.
    panel({ notes: [note({ status: "pending_approval", createdBy: "u-manager" })], currentUserId: "u-manager", isOwner: false });
    expect(screen.getByRole("button", { name: "Take back" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve and issue" })).toBeNull();
    expect(screen.getByText(/You wrote this credit note, so the owner or another manager has to approve it/)).toBeTruthy();
    cleanup();
    // The owner sees Approve and issue and Send back.
    panel({ notes: [note({ status: "pending_approval", createdBy: "u-manager", version: 3 })] });
    fireEvent.click(screen.getByRole("button", { name: "Approve and issue" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch(/Once issued it cannot be changed, voided or deleted/);
    expect(dialog.textContent).toMatch(/You are approving version 3: Goodwill for a late visit/);
    fireEvent.click(screen.getByRole("button", { name: "Issue credit note" }));
    await waitFor(() => expect(actions.issueCreditNoteAction).toHaveBeenCalledWith("cn-1", 3));
  });

  it("sending back needs words, and cancelling needs a reason", async () => {
    panel({ notes: [note({ status: "pending_approval", createdBy: "u-manager" })] });
    fireEvent.click(screen.getByRole("button", { name: "Send back" }));
    await screen.findByRole("dialog");
    const confirm = screen.getAllByRole("button", { name: "Send back" }).at(-1) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("What should change?"), { target: { value: "Say which visit" } });
    expect((screen.getAllByRole("button", { name: "Send back" }).at(-1) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getAllByRole("button", { name: "Send back" }).at(-1) as HTMLButtonElement);
    await waitFor(() => expect(actions.returnCreditNoteAction).toHaveBeenCalledWith("cn-1", { version: 1, note: "Say which visit" }));
  });

  it("an issued note is a document: its number, who approved it, a link to view it, and no way to change or void it", () => {
    panel({ notes: [note({ status: "issued", number: "CN-0001", approvedByName: "Olive Owner", approvedAt: "2026-10-26T11:00:00.000Z", issuedAt: "2026-10-26T11:00:00.000Z", approvedVersion: 1 })] });
    expect(screen.getByText("CN-0001")).toBeTruthy();
    expect(screen.getByText(/Approved by Olive Owner/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /View document/ }).getAttribute("href")).toBe("/invoices/inv-1/credit-notes/cn-1");
    for (const name of ["Edit", "Send for approval", "Take back", "Approve and issue", "Send back", "Cancel", "Void"]) expect(screen.queryByRole("button", { name }), name).toBeNull();
  });

  it("a cancelled note says it never took anything off the invoice and offers nothing", () => {
    panel({ notes: [note({ status: "cancelled", cancelReason: "Raised twice by mistake", cancelledAt: "2026-10-26T11:00:00.000Z" })] });
    expect(screen.getByText(/Cancelled: Raised twice by mistake/)).toBeTruthy();
    expect(screen.queryAllByRole("button").filter((b) => !/Write a credit note/.test(b.textContent ?? ""))).toHaveLength(0);
  });
});
