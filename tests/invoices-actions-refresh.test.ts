// A server action that only reads must not re-render the page it was called from. Next updates the current page at once after a server function calls revalidatePath, so a
// deal search on the invoice editor used to re-render the edit page with whatever version the server held at that moment, under the fields the person had typed (review #23).
// The proposals editor's search passes `refresh: false`; these pin the same for the invoice screens' reads.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ revalidatePath: vi.fn(), search: vi.fn(), deliveries: vi.fn(), discard: vi.fn(), link: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: m.revalidatePath }));
vi.mock("@/server/tenancy/context", () => ({ requireOrgContextOrThrow: vi.fn(async () => ({ can: () => true, user: { id: "u1" }, org: { orgId: "o1" } })) }));
vi.mock("@/server/invoices/search", () => ({ searchDealsForInvoice: m.search }));
vi.mock("@/server/invoices/invoices", () => ({
  createDraft: vi.fn(), discardDraft: m.discard, issueInvoice: vi.fn(), requestChanges: vi.fn(), submitForApproval: vi.fn(), updateDraft: vi.fn(), voidInvoice: vi.fn(), withdrawFromApproval: vi.fn(), writeOffInvoice: vi.fn(),
}));
vi.mock("@/server/invoices/payments", () => ({ recordManualPayment: vi.fn(), recordRefund: vi.fn() }));
vi.mock("@/server/invoices/disputes", () => ({ recordDisputeOpened: vi.fn(), recordDisputeResult: vi.fn() }));
vi.mock("@/server/invoices/share", () => ({ getInvoiceLink: m.link, rotateInvoiceLink: vi.fn() }));
vi.mock("@/server/invoices/settings", () => ({ saveInvoiceSettings: vi.fn() }));
vi.mock("@/server/invoices/reminders", () => ({ authorizeReminders: vi.fn(), switchOffReminders: vi.fn() }));
vi.mock("@/server/invoices/test-payment", () => ({ startTestPayment: vi.fn() }));
vi.mock("@/server/customer-payments/connections", () => ({
  confirmLive: vi.fn(), connectProvider: vi.fn(), listRecentDeliveries: m.deliveries, recheckConnection: vi.fn(), replaceCredentials: vi.fn(), revokeConnection: vi.fn(), saveWebhookSecret: vi.fn(), setConnectionPaused: vi.fn(),
}));

import { discardInvoiceDraftAction, recentDeliveriesAction, searchInvoiceDealsAction } from "@/app/actions/invoices";

const ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
});

describe("which invoice actions refresh the screen", () => {
  it("does not, for the deal search the editor runs while a person types", async () => {
    m.search.mockResolvedValue([{ id: ID, name: "Kitchen repipe" }]);
    const r = await searchInvoiceDealsAction("kit");
    expect(r).toEqual({ ok: true, data: [{ id: ID, name: "Kitchen repipe" }] });
    expect(m.revalidatePath).not.toHaveBeenCalled();
  });

  it("does not, for reading what the provider has sent", async () => {
    m.deliveries.mockResolvedValue([]);
    const r = await recentDeliveriesAction(ID);
    expect(r).toEqual({ ok: true, data: [] });
    expect(m.revalidatePath).not.toHaveBeenCalled();
  });

  it("still does for an action that changes something", async () => {
    m.discard.mockResolvedValue(undefined);
    const r = await discardInvoiceDraftAction(ID);
    expect(r).toEqual({ ok: true, data: true });
    expect(m.revalidatePath).toHaveBeenCalledWith("/invoices", "layout");
  });
});
