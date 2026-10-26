// @vitest-environment jsdom
// The proposal's Invoice tab as a person meets it: what would be copied and what would be left off, how the proposal was accepted, the confirmation, and what is said afterwards. The
// server action is a spy; the server's own rules are in invoices-from-proposal.test.ts. The browser-only things (layout at 375 and 1280 pixels, the table's own scrolling, focus rings,
// the dialog, light and dark) are for the lead's check.
import * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { InvoicePanel } from "@/components/proposals/invoice-panel";
import { ProposalWorkspace } from "@/components/proposals/workspace";
import { confirmText, madeText, makeOfferFor } from "@/lib/invoices/from-proposal-ui";
import type { InvoiceFromProposalPreview, ProposalInvoicing } from "@/server/invoices/from-proposal";
import { detailFixture, PID } from "./support/esign-screens";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  a: { createInvoiceFromProposalAction: vi.fn() },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: mocks.refresh, replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  usePathname: () => "/proposals",
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/actions/invoices", () => mocks.a);
// The other tabs of the workspace read from their own actions; none of them is called here.
vi.mock("@/app/actions/proposals", () => ({ previewDeliveryAction: vi.fn(), sendDeliveryAction: vi.fn(), getShareUrlAction: vi.fn(), renewShareLinkAction: vi.fn() }));
vi.mock("@/app/actions/crm", () => ({ searchContactsAction: async () => ({ ok: true, data: [] }) }));

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
});
beforeEach(() => {
  mocks.refresh.mockReset();
  mocks.a.createInvoiceFromProposalAction.mockReset();
});
afterEach(cleanup);

const INV = "88888888-8888-4888-8888-888888888888";
const ok = <T,>(data: T) => ({ ok: true as const, data });
const button = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;

const preview = (over: Partial<InvoiceFromProposalPreview> = {}): InvoiceFromProposalPreview => ({
  proposalId: PID, proposalNumber: "P-0001", proposalVersion: 1, currency: "USD", problem: null,
  basis: { code: "acknowledged_online", text: "The customer accepted online with a verified email address." },
  lines: [
    { description: "Website build - Design and build of a five page website.", quantity: "1", unitPriceMinor: 150_000, discountMinor: 0, taxRateBps: 1200, totalMinor: 168_000 },
    { description: "Photography day", quantity: "3", unitPriceMinor: 33_333, discountMinor: 10_000, taxRateBps: null, totalMinor: 89_999 },
  ],
  totals: { subtotalMinor: 239_999, taxMinor: 18_000, totalMinor: 257_999 }, recurring: [], notes: [], customerName: "Maria Santos", alreadyForThisVersion: 0, ...over,
});

const invoicing = (over: Partial<ProposalInvoicing> = {}): ProposalInvoicing => ({ available: true, canCreate: true, canMakeAnother: true, preview: preview(), existing: [], ...over });
const accepted = () => detailFixture({ status: "accepted", requiresSignature: false });
function panel(inv: ProposalInvoicing = invoicing()) {
  return render(<InvoicePanel detail={accepted()} invoicing={inv} tz="UTC" />);
}

describe("what would be made", () => {
  it("shows the lines that would be copied at their exact figures, the totals, the customer and how the proposal was accepted, and makes nothing yet", () => {
    panel();
    const table = screen.getByRole("table", { name: /Lines that would be copied onto the invoice, amounts in USD/ });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(rows[1].textContent).toContain("Website build - Design and build of a five page website.");
    expect(rows[1].textContent).toContain("USD 1,500.00");
    expect(rows[1].textContent).toContain("12%");
    expect(rows[1].textContent).toContain("USD 1,680.00");
    expect(rows[2].textContent).toContain("Discount USD 100.00");
    expect(rows[2].textContent).toContain("None");
    const totals = screen.getByText("Subtotal").closest("dl") as HTMLElement;
    expect(totals.textContent).toContain("USD 2,399.99");
    expect(totals.textContent).toContain("USD 180.00");
    expect(totals.textContent).toContain("USD 2,579.99");
    expect(screen.getByText("The draft is for Maria Santos.")).toBeTruthy();
    expect(screen.getByText(/The customer accepted online with a verified email address\./)).toBeTruthy();
    expect(screen.getByText(/Making it issues nothing, sends nothing, charges no one and does not change the deal/)).toBeTruthy();
    expect(mocks.a.createInvoiceFromProposalAction).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toMatch(/undefined|NaN|\[object Object\]|\{\{/);
  });

  it("says plainly that a person recorded the acceptance when a person did, and that a signature was not verified when it was recorded offline", () => {
    panel(invoicing({ preview: preview({ basis: { code: "signing_recorded_offline", text: "A person on your team recorded that the customer signed outside the product. A signing service did not verify it." } }) }));
    expect(screen.getByText(/A signing service did not verify it\./)).toBeTruthy();
  });

  it("lists the monthly and yearly lines that are left off, and says it is the owner's to decide", () => {
    panel(invoicing({
      preview: preview({
        recurring: [
          { name: "Hosting", billing: "monthly", billingLabel: "every month", quantityMilli: 1000, totalMinor: 11_088 },
          { name: "Domain", billing: "yearly", billingLabel: "every year", quantityMilli: 1000, totalMinor: 2_000 },
        ],
        notes: ["2 lines are billed every month or every year and were not copied. Decide whether and when to invoice them yourself."],
      }),
    }));
    const list = screen.getByRole("list", { name: "Lines that would be left off" });
    expect(within(list).getAllByRole("listitem").map((i) => i.textContent)).toEqual(["Hosting, every month, USD 110.88 each time", "Domain, every year, USD 20.00 each time"]);
    expect(screen.getByText(/Not on the invoice, because the customer pays them every month or every year/)).toBeTruthy();
    expect(screen.getByText(/Nothing here bills on a schedule, so these are for you to invoice when you choose/)).toBeTruthy();
    expect(screen.getByText(/Decide whether and when to invoice them yourself/)).toBeTruthy();
  });

  it("says when the proposal is not linked to a customer record, so the customer is chosen on the draft", () => {
    panel(invoicing({ preview: preview({ customerName: null }) }));
    expect(screen.getByText(/not linked to a customer record, so you choose the customer on the draft/)).toBeTruthy();
  });

  it("says why nothing can be made, and offers no button", () => {
    panel(invoicing({ preview: preview({ lines: [], totals: null, basis: null, problem: { code: "no_one_time_lines", text: "This proposal has only monthly or yearly lines, so there is nothing the customer pays once to put on an invoice. Whether and when to bill those lines is yours to decide." } }) }));
    expect(screen.getByText(/only monthly or yearly lines/).getAttribute("role")).toBe("status");
    expect(screen.queryByRole("button", { name: /draft invoice/ })).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("says only an accepted proposal can be invoiced when it is not accepted, and the person's role when they cannot make one", () => {
    render(<InvoicePanel detail={detailFixture({ status: "sent" })} invoicing={invoicing({ preview: null })} tz="UTC" />);
    expect(screen.getByText(/Only an accepted proposal can be invoiced/)).toBeTruthy();
    cleanup();
    panel(invoicing({ canCreate: false, canMakeAnother: false, preview: null }));
    expect(screen.getByText(/Your role can't make invoices/)).toBeTruthy();
    cleanup();
    // An accepted proposal whose saved version could not be read says that, not "only an accepted proposal".
    panel(invoicing({ preview: null }));
    expect(screen.getByText(/saved version could not be read/)).toBeTruthy();
    expect(screen.queryByText(/Only an accepted proposal can be invoiced/)).toBeNull();
  });
});

describe("making the draft", () => {
  it("asks first, with what is copied and what is left, then makes it for the version that was looked at and says nothing was issued or sent", async () => {
    mocks.a.createInvoiceFromProposalAction.mockResolvedValue(ok({ status: "created", invoiceId: INV, lines: 2, recurringLines: 1 }));
    panel(invoicing({ preview: preview({ recurring: [{ name: "Hosting", billing: "monthly", billingLabel: "every month", quantityMilli: 1000, totalMinor: 11_088 }] }) }));
    fireEvent.click(button("Make a draft invoice"));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText(/2 lines the customer pays once are copied, as the accepted version has them\. 1 monthly or yearly line is left off for you to decide\. The draft is for Maria Santos\./)).toBeTruthy();
    expect(dialog.getByText(/nothing is issued, sent or charged, and the deal is not changed\. An owner or manager approves it before it is issued/)).toBeTruthy();
    expect(mocks.a.createInvoiceFromProposalAction).not.toHaveBeenCalled();
    fireEvent.click(dialog.getByRole("button", { name: "Make the draft" }));
    await waitFor(() => expect(mocks.a.createInvoiceFromProposalAction).toHaveBeenCalledWith(PID, { version: 1, another: false }));
    const said = await screen.findByText(/A draft invoice was made with 2 lines\. 1 monthly or yearly line was left off\. Nothing was issued or sent\./);
    expect(said.closest("[role=status]")).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(said.closest("[role=status]")));
    expect((await screen.findByRole("link", { name: "Open the draft invoice" })).getAttribute("href")).toBe(`/invoices/${INV}`);
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it("can be cancelled without making anything", async () => {
    panel();
    fireEvent.click(button("Make a draft invoice"));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mocks.a.createInvoiceFromProposalAction).not.toHaveBeenCalled();
  });

  it("says nothing new was made when the server returns the draft that exists", async () => {
    mocks.a.createInvoiceFromProposalAction.mockResolvedValue(ok({ status: "already", invoiceId: INV, count: 1 }));
    panel();
    fireEvent.click(button("Make a draft invoice"));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Make the draft" }));
    expect(await screen.findByText(/A draft invoice was already made from this version, so nothing new was made\./)).toBeTruthy();
    expect(await screen.findByRole("link", { name: "Open the draft invoice" })).toBeTruthy();
  });

  it("shows a refusal in the page, in an alert, with no link to a draft that was not made", async () => {
    mocks.a.createInvoiceFromProposalAction.mockResolvedValue({ ok: false, error: "The proposal changed. Look at the new version before you make an invoice.", code: "conflict" });
    panel();
    fireEvent.click(button("Make a draft invoice"));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Make the draft" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("The proposal changed. Look at the new version before you make an invoice.");
    expect(screen.queryByRole("link", { name: "Open the draft invoice" })).toBeNull();
    cleanup();
    mocks.a.createInvoiceFromProposalAction.mockRejectedValue(new Error("offline"));
    panel();
    fireEvent.click(button("Make a draft invoice"));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Make the draft" }));
    expect((await screen.findByRole("alert")).textContent).toBe("That didn't go through. Check your connection and try again.");
  });
});

describe("a version that already has a draft", () => {
  it("lets the owner or a manager make a further one only by saying so, and asks again", async () => {
    mocks.a.createInvoiceFromProposalAction.mockResolvedValue(ok({ status: "created", invoiceId: INV, lines: 2, recurringLines: 0 }));
    panel(invoicing({ preview: preview({ alreadyForThisVersion: 1 }) }));
    expect(screen.getByText(/A draft invoice was already made from this version of the proposal\. Make a further one only if the customer is really to be invoiced again/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Make a draft invoice" })).toBeNull();
    fireEvent.click(button("Make a further draft invoice"));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText(/This is a further invoice for a version that already has one\./)).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: "Make the draft" }));
    await waitFor(() => expect(mocks.a.createInvoiceFromProposalAction).toHaveBeenCalledWith(PID, { version: 1, another: true }));
  });

  it("offers nobody else a further one, and says who can", () => {
    panel(invoicing({ canMakeAnother: false, preview: preview({ alreadyForThisVersion: 2 }) }));
    expect(screen.getByText(/2 invoices were already made from this version of the proposal\. Only the business owner or a manager can make a further one\./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /draft invoice/ })).toBeNull();
  });
});

describe("the invoices already made from the proposal", () => {
  it("lists each one with its number or 'Draft invoice', its status, its total, the version it copied and a link, without calling a draft paid", () => {
    panel(invoicing({
      existing: [
        { id: INV, number: null, status: "draft", paymentStatus: "unpaid", currency: "USD", totalMinor: 257_999, proposalVersion: 1, createdAt: "2026-10-23T12:00:00.000Z" },
        { id: "99999999-9999-4999-8999-999999999999", number: "INV-0004", status: "issued", paymentStatus: "partially_paid", currency: "USD", totalMinor: 100_000, proposalVersion: 1, createdAt: "2026-10-22T12:00:00.000Z" },
      ],
    }));
    const region = screen.getByRole("region", { name: "Invoices made from this proposal" });
    const links = within(region).getAllByRole("link");
    expect(links).toHaveLength(2);
    expect(links[0].getAttribute("href")).toBe(`/invoices/${INV}`);
    expect(links[0].textContent).toContain("Draft invoice");
    expect(links[0].textContent).toContain("USD 2,579.99");
    expect(links[0].textContent).toContain("from version 1");
    expect(links[0].textContent).not.toMatch(/Paid|Unpaid/);
    expect(links[1].textContent).toContain("INV-0004");
    expect(links[1].textContent).toContain("Partly paid");
  });

  it("is not there when none was made", () => {
    panel();
    expect(screen.queryByRole("region", { name: "Invoices made from this proposal" })).toBeNull();
  });
});

describe("in the proposal's workspace", () => {
  const can = { create: true, approve: true, send: true, record: true, discount: true };
  const workspace = (inv: ProposalInvoicing | null | undefined, initialTab?: string) =>
    render(<ProposalWorkspace detail={accepted()} catalog={[]} taxRates={[]} can={can} twoPerson={false} tz="UTC" initialTab={initialTab} invoicing={inv} />);

  it("has an Invoice tab, with the count of invoices made, when invoicing is available", () => {
    workspace(invoicing({ existing: [{ id: INV, number: null, status: "draft", paymentStatus: "unpaid", currency: "USD", totalMinor: 1, proposalVersion: 1, createdAt: "2026-10-23T12:00:00.000Z" }] }));
    const tab = screen.getByRole("tab", { name: /Invoice/ });
    expect(tab.textContent).toContain("1");
    fireEvent.click(tab);
    expect(screen.getByRole("heading", { name: "Invoice this proposal" })).toBeTruthy();
  });

  it("opens on the Invoice tab when the address names it", () => {
    workspace(invoicing(), "invoice");
    expect(screen.getByRole("tab", { name: /Invoice/ }).getAttribute("aria-selected")).toBe("true");
  });

  it("has no Invoice tab when invoicing is off, not available to the person, or not given", () => {
    workspace(invoicing({ available: false, canCreate: false, canMakeAnother: false, preview: null }));
    expect(screen.queryByRole("tab", { name: /Invoice/ })).toBeNull();
    cleanup();
    workspace(null);
    expect(screen.queryByRole("tab", { name: /Invoice/ })).toBeNull();
    cleanup();
    workspace(undefined, "invoice");
    expect(screen.queryByRole("tab", { name: /Invoice/ })).toBeNull();
    expect(screen.getByRole("tab", { name: "Details" }).getAttribute("aria-selected")).toBe("true");
  });
});

describe("the rules the screen follows", () => {
  const base = { canCreate: true, canMakeAnother: true, problem: null, alreadyForThisVersion: 0 };

  it("offers the first draft to a person who can write invoices, a further one to the owner or a manager, and nothing to anyone else", () => {
    expect(makeOfferFor(base)).toEqual({ kind: "make", note: null });
    expect(makeOfferFor({ ...base, alreadyForThisVersion: 1 }).kind).toBe("another");
    expect(makeOfferFor({ ...base, alreadyForThisVersion: 1, canMakeAnother: false })).toMatchObject({ kind: "none", note: expect.stringContaining("Only the business owner or a manager") });
    expect(makeOfferFor({ ...base, canCreate: false })).toMatchObject({ kind: "none", note: expect.stringContaining("Your role can't make invoices") });
    expect(makeOfferFor({ ...base, problem: { text: "Only an accepted proposal can be invoiced." }, alreadyForThisVersion: 3 })).toEqual({ kind: "none", note: "Only an accepted proposal can be invoiced." });
  });

  it("words the confirmation for one line, several lines, no customer and a further invoice", () => {
    expect(confirmText({ lines: 1, recurring: 0, customerName: null, another: false })).toMatch(/^1 line the customer pays once is copied, as the accepted version has it\. The proposal is not linked to a customer record/);
    expect(confirmText({ lines: 3, recurring: 2, customerName: "Maria Santos", another: true })).toMatch(/3 lines the customer pays once are copied.*2 monthly or yearly lines are left off.*The draft is for Maria Santos\. This is a further invoice/);
  });

  it("says what was done in words that never go past it", () => {
    expect(madeText({ status: "created", invoiceId: INV, lines: 1, recurringLines: 0 })).toEqual({ tone: "ok", text: "A draft invoice was made with 1 line. Nothing was issued or sent." });
    expect(madeText({ status: "already", invoiceId: INV, count: 3 })).toMatchObject({ tone: "info", text: expect.stringContaining("(3 exist)") });
    expect(madeText({ status: "error", text: "No." })).toEqual({ tone: "error", text: "No." });
    for (const r of [{ status: "created" as const, invoiceId: INV, lines: 2, recurringLines: 2 }, { status: "already" as const, invoiceId: INV, count: 1 }]) {
      expect(madeText(r).text).not.toMatch(/\b(issued to|sent to|paid|charged)\b/i);
    }
  });
});
