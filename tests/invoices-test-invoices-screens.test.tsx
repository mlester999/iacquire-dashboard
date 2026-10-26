// @vitest-environment jsdom
// Test invoices (decision D2) on the screens: what an invoice offers the person, how the invoice form asks for the mark, and the TEST label wherever a test invoice appears (the list,
// the invoice page, the customer's page and the page they return to). No browser: class names, markup and jsdom clicks stand in; the lead's browser pass looks at layout.
// Server actions are replaced by recorders.
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const mocks = vi.hoisted(() => {
  const names = [
    "createInvoiceDraftAction", "updateInvoiceDraftAction", "discardInvoiceDraftAction", "searchInvoiceDealsAction", "submitInvoiceAction", "withdrawInvoiceAction", "requestInvoiceChangesAction",
    "issueInvoiceAction", "voidInvoiceAction", "writeOffInvoiceAction", "recordPaymentAction", "recordRefundAction", "recordDisputeOpenedAction", "recordDisputeResultAction", "getInvoiceLinkAction", "rotateInvoiceLinkAction", "saveInvoiceSettingsAction",
    "authorizeRemindersAction", "switchOffRemindersAction", "connectProviderAction", "saveWebhookSecretAction", "replaceKeysAction", "recheckConnectionAction", "confirmLiveAction",
    "pauseConnectionAction", "disconnectConnectionAction", "recentDeliveriesAction", "startTestPaymentAction", "deleteTestInvoiceAction",
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
import { InvoiceForm, formPayload } from "@/components/invoices/invoice-form";
import { InvoiceList, ReceivablesCards } from "@/components/invoices/invoice-list";
import { InvoicesPanel } from "@/components/invoices/crm-panel";
import { InvoiceSummary, RemindersList } from "@/components/invoices/invoice-sections";
import { PaymentsPanel } from "@/components/invoices/payments-panel";
import { ConnectionsPanel } from "@/components/invoices/connections-panel";
import { InvoiceDocument, bannerText } from "@/components/invoices/public/invoice-document";
import { PayPanel } from "@/components/invoices/public/pay-panel";
import { emptyFormState, sameFormState } from "@/lib/invoices/form-state";
import { filterQuery, invoiceActions, LIST_FILTER_LABELS, LIST_FILTERS, type ActionFacts } from "@/lib/invoices/screens";
import { describeReturn, invoiceBanner } from "@/lib/invoices/public-status";
import type { InvoiceFullDetail, PaymentView, ReceivablesSummary } from "@/server/invoices/invoices";
import type { InvoiceView } from "@/server/invoices/views";
import type { ConnectionView } from "@/server/customer-payments/connections";
import type { PublicInvoice } from "@/server/invoices/public";

const ok = (data: unknown = true) => ({ ok: true, data });

beforeEach(() => {
  for (const fn of Object.values(mocks.actions)) fn.mockReset();
  mocks.push.mockReset();
});
afterEach(cleanup);

const can = { create: true, approve: true, send: true, recordPayment: true, void: true, refund: true, connect: true };
const facts = (over: Partial<ActionFacts> = {}): ActionFacts => ({
  status: "issued", paymentStatus: "unpaid", writtenOff: false, balanceMinor: 150000, paidMinor: 0, createdVia: "manual", isAuthor: true, approvalRequiredForCreators: true, hasTestConnection: true, isTest: false,
  can, ...over,
});
const text = (el: React.ReactElement) => renderToStaticMarkup(el).replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");

describe("what an invoice offers", () => {
  it("offers a real invoice what it always did, and never Pay as a test or Delete", () => {
    const { offered } = invoiceActions(facts());
    expect(offered).toEqual(expect.arrayContaining(["link", "record_payment", "void", "write_off"]));
    expect(offered).not.toContain("test_payment");
    expect(offered).not.toContain("delete_test");
  });

  it("offers a test invoice Pay as a test, void and delete, and nothing about money owed: there is nothing to record, write off or refund", () => {
    const { offered, notes } = invoiceActions(facts({ isTest: true }));
    expect(offered).toEqual(expect.arrayContaining(["link", "void", "test_payment", "delete_test"]));
    expect(offered).not.toContain("record_payment");
    expect(offered).not.toContain("write_off");
    expect(notes).toContain("This is a test invoice: nothing is owed on it and no money moves.");
  });

  it("lets a test invoice be voided and deleted after its test payment, but not paid as a test again, and a real invoice with money still cannot be voided", () => {
    const paid = invoiceActions(facts({ isTest: true, paymentStatus: "paid", balanceMinor: 0, paidMinor: 150000 })).offered;
    expect(paid).toEqual(expect.arrayContaining(["void", "delete_test"]));
    expect(paid).not.toContain("test_payment");
    const real = invoiceActions(facts({ paymentStatus: "paid", balanceMinor: 0, paidMinor: 150000 }));
    expect(real.offered).not.toContain("void");
    expect(real.notes.join(" ")).toMatch(/cannot be voided/);
  });

  it("keeps test and delete for the owner: a manager can void a test invoice but not run or delete one", () => {
    const manager = invoiceActions(facts({ isTest: true, can: { ...can, connect: false, refund: false } })).offered;
    expect(manager).toContain("void");
    expect(manager).not.toContain("test_payment");
    expect(manager).not.toContain("delete_test");
    expect(invoiceActions(facts({ isTest: true, hasTestConnection: false })).offered).not.toContain("test_payment");
  });

  it("offers a voided test invoice for deleting, to the owner only, and a voided real invoice for nothing", () => {
    expect(invoiceActions(facts({ status: "void", isTest: true })).offered).toEqual(["delete_test"]);
    expect(invoiceActions(facts({ status: "void", isTest: true, can: { ...can, connect: false } })).offered).toEqual([]);
    expect(invoiceActions(facts({ status: "void" })).offered).toEqual([]);
  });

  it("keeps test invoices out of the lists of what is owed, overdue and paid, and has a list of its own", () => {
    expect(filterQuery("open")).toMatchObject({ tests: "exclude" });
    expect(filterQuery("overdue")).toMatchObject({ tests: "exclude" });
    expect(filterQuery("paid")).toMatchObject({ tests: "exclude" });
    expect(filterQuery("test")).toEqual({ tests: "only" });
    expect(filterQuery("all")).toEqual({});
    expect(LIST_FILTERS).toContain("test");
    expect(LIST_FILTER_LABELS.test).toBe("Test invoices");
  });
});

describe("the invoice page's buttons for a test invoice", () => {
  const actions = (over: Partial<ActionFacts> = {}) => (
    <InvoiceActions invoiceId="11111111-1111-4111-8111-111111111111" version={1} number="TEST-0001" status="issued" currency="PHP" balanceMinor={150000} totalMinor={150000} facts={facts({ isTest: true, ...over })} tz="UTC" hasCustomer closeRuleNote={null} />
  );

  it("shows Pay as a test, Void and Delete test invoice, and no button to record a payment", () => {
    render(actions());
    for (const name of [/Pay as a test/, "Void", "Delete test invoice"]) expect(screen.getByRole("button", { name })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Record a payment" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Write off" })).toBeNull();
    expect(screen.getByText("This is a test invoice: nothing is owed on it and no money moves.")).toBeTruthy();
  });

  it("says a test payment is recorded against this test invoice only, and that a real invoice is never marked paid by one", () => {
    render(actions());
    fireEvent.click(screen.getByRole("button", { name: /Pay as a test/ }));
    const d = screen.getByRole("dialog", { name: "Pay this invoice as a test?" });
    expect(within(d).getByText(/recorded against this test invoice, marked as a test/)).toBeTruthy();
    expect(within(d).getByText(/a real invoice is never marked paid by one/)).toBeTruthy();
    expect(within(d).queryByText(/Use an invoice you made only for testing/)).toBeNull();
  });

  it("deletes after a confirmation that says nothing real is lost, and goes back to the list", async () => {
    mocks.actions.deleteTestInvoiceAction.mockResolvedValue(ok({ number: "TEST-0001" }));
    render(actions());
    fireEvent.click(screen.getByRole("button", { name: "Delete test invoice" }));
    const d = screen.getByRole("dialog", { name: "Delete TEST-0001?" });
    expect(within(d).getByText(/Nothing on it was real, so nothing real is lost\. A real invoice can never be deleted: it is voided instead\./)).toBeTruthy();
    expect(within(d).getByText(/Deleting also deletes the proof of a test payment that lets you go live; to keep that proof, void the test invoice instead\./)).toBeTruthy();
    expect(mocks.actions.deleteTestInvoiceAction).not.toHaveBeenCalled();
    fireEvent.click(within(d).getByRole("button", { name: "Delete test invoice" }));
    await waitFor(() => expect(mocks.actions.deleteTestInvoiceAction).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111"));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/invoices"));
  });

  it("says a test invoice can be voided even after a test payment", () => {
    render(actions({ paymentStatus: "paid", balanceMinor: 0, paidMinor: 150000 }));
    fireEvent.click(screen.getByRole("button", { name: "Void" }));
    const d = screen.getByRole("dialog", { name: "Void TEST-0001?" });
    expect(within(d).getByText(/A test invoice can be voided even after a test payment, because no money moved\./)).toBeTruthy();
  });

  it("offers a real invoice neither the test button nor the delete button", () => {
    render(actions({ isTest: false }));
    expect(screen.queryByRole("button", { name: /Pay as a test/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete test invoice" })).toBeNull();
    expect(screen.getByRole("button", { name: "Record a payment" })).toBeTruthy();
  });
});

describe("the invoice form", () => {
  const initial = emptyFormState({ currency: "PHP" });
  const form = (props: { canMarkTest?: boolean; state?: Partial<typeof initial> } = {}) => (
    <InvoiceForm mode={{ kind: "new" }} initial={{ ...initial, ...props.state }} termsDays={14} canMarkTest={props.canMarkTest} />
  );

  it("offers the test mark as a full-size checkbox when the person may make a test invoice, and says what it does", () => {
    const out = renderToStaticMarkup(form({ canMarkTest: true }));
    expect(out).toContain("This is a test invoice.");
    expect(out).toContain("Nothing is owed on it and no money moves.");
    expect(out).toMatch(/own TEST- number/);
    expect(out).toMatch(/It cannot be changed back once it is issued/);
    const box = out.match(/<label class="[^"]*">(<input type="checkbox"[^>]*>)<span><span class="font-medium text-ink">This is a test invoice/);
    expect(box?.[1]).toMatch(/size-5 shrink-0/);
    expect(box?.[1]).not.toMatch(/checked/);
    expect(out).toMatch(/<label class="flex min-h-11 [^"]*"><input type="checkbox"[^>]*><span><span class="font-medium text-ink">This is a test invoice/);
  });

  it("does not offer it without a test account or to anyone but the owner, and shows it fixed on a draft that already is one", () => {
    expect(renderToStaticMarkup(form({ canMarkTest: false }))).not.toContain("This is a test invoice");
    const fixed = renderToStaticMarkup(form({ canMarkTest: false, state: { isTest: true } }));
    expect(fixed).toContain("This is a test invoice.");
    expect(fixed).toMatch(/<input type="checkbox"[^>]*checked=""[^>]*disabled=""|<input type="checkbox"[^>]*disabled=""[^>]*checked=""/);
    expect(fixed).toContain("Only the business owner can change this.");
  });

  it("sends the mark with the draft, and never lets a test invoice be marked as closing a deal", () => {
    const withDeal = { ...initial, deal: { id: "d1", name: "Boiler job" }, closesDeal: true };
    expect(formPayload({ ...withDeal, isTest: false })).toMatchObject({ isTest: false, closesDeal: true });
    expect(formPayload({ ...withDeal, isTest: true })).toMatchObject({ isTest: true, closesDeal: false });
    const out = renderToStaticMarkup(form({ canMarkTest: true, state: { deal: { id: "d1", name: "Boiler job" }, isTest: true } }));
    expect(out).not.toContain("may mark the deal");
    expect(renderToStaticMarkup(form({ canMarkTest: true, state: { deal: { id: "d1", name: "Boiler job" } } }))).toContain("may mark the deal");
  });

  it("counts the mark as part of what a teammate's newer version changes", () => {
    expect(sameFormState(initial, { ...initial, isTest: true })).toBe(false);
    expect(sameFormState({ ...initial, isTest: true }, { ...initial, isTest: true })).toBe(true);
  });

  it("starts with the box ticked when the connection card sent the owner here", () => {
    cleanup();
    render(form({ canMarkTest: true, state: { isTest: true } }));
    const box = screen.getByRole("checkbox", { name: /This is a test invoice/ }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(box.checked).toBe(false);
  });
});

const view = (over: Partial<InvoiceView> = {}): InvoiceView => ({
  id: "11111111-1111-4111-8111-111111111111", number: "TEST-0001", status: "issued", paymentStatus: "unpaid", currency: "PHP", taxInclusive: false, contactId: "c1", contactName: "Maria Santos", companyId: null, companyName: null,
  opportunityId: null, opportunityName: null, subtotalMinor: 150000, taxMinor: 0, totalMinor: 150000, paidMinor: 0, refundedMinor: 0, creditedMinor: 0, balanceMinor: 150000, overpaidMinor: 0, issueOn: "2026-10-23", dueOn: "2026-11-06",
  billTo: {}, billFrom: {}, paymentInstructions: null, notes: null, terms: null, version: 1, approvedVersion: 1, approvedByName: null, approvedAt: null, closesDeal: false, isTest: true, writtenOffAt: null, writeOffReason: null,
  issuedAt: "2026-10-23T12:00:00.000Z", voidedAt: null, voidReason: null, firstViewedAt: null, createdBy: "u1", createdByName: "Owner", createdVia: "manual", sourceProposalId: null, sourceProposalVersion: null, createdAt: "2026-10-23T12:00:00.000Z",
  updatedAt: "2026-10-23T12:00:00.000Z", overdue: false, daysOverdue: 0, ...over,
});

describe("the TEST label", () => {
  it("is on a test invoice in the list and on a customer's page, and a test invoice that was not paid is not called unpaid", () => {
    const rows = [view(), view({ id: "22222222-2222-4222-8222-222222222222", number: "INV-0001", isTest: false })];
    const list = renderToStaticMarkup(<InvoiceList rows={rows} empty={{ title: "x", description: "y" }} />);
    const [testRow, realRow] = list.split("</li>");
    expect(testRow).toContain("Test invoice");
    expect(testRow).not.toContain(">Unpaid<");
    expect(realRow).not.toContain("Test invoice");
    expect(realRow).toContain(">Unpaid<");
    expect(renderToStaticMarkup(<InvoiceList rows={[view({ paymentStatus: "paid", paidMinor: 150000, balanceMinor: 0 })]} empty={{ title: "x", description: "y" }} />)).toContain(">Paid<");
    const panel = renderToStaticMarkup(<InvoicesPanel rows={rows} newHref="/invoices/new" canCreate />);
    expect(panel.split("</li>")[0]).toContain("Test invoice");
  });

  it("is on the invoice page with a sentence that says what a test invoice is kept out of", () => {
    const detail: InvoiceFullDetail = { invoice: view(), lines: [], payments: [], refunds: [], events: [], reminders: [], deliveries: [], source: null, creditNotes: [], closeRule: "none" };
    const out = text(<InvoiceSummary detail={detail} tz="UTC" />);
    expect(out).toContain("Test invoice");
    expect(out).toContain("This is a test invoice: nothing is owed on it and no money moves.");
    expect(out).toMatch(/never reminded about, is left out of what is owed, overdue, your revenue and your deals/);
    expect(text(<InvoiceSummary detail={{ ...detail, invoice: view({ isTest: false }) }} tz="UTC" />)).not.toContain("test invoice");
  });

  it("says a test invoice is never reminded about, instead of describing reminders it will never have", () => {
    const detail: InvoiceFullDetail = { invoice: view(), lines: [], payments: [], refunds: [], events: [], reminders: [], deliveries: [], source: null, creditNotes: [], closeRule: "none" };
    const out = text(<RemindersList detail={detail} tz="UTC" />);
    expect(out).toContain("A test invoice is never reminded about: nothing is owed on it, so no customer is asked to pay it.");
    expect(out).not.toContain("Reminders go out only after the owner has authorized");
    expect(text(<RemindersList detail={{ ...detail, invoice: view({ isTest: false }) }} tz="UTC" />)).toContain("Reminders go out only after the owner has authorized");
  });

  it("is said on the list's totals without adding a test invoice to any figure", () => {
    const summary: ReceivablesSummary = { byCurrency: [{ currency: "PHP", outstandingMinor: 150000, overdueMinor: 0, openCount: 1, overdueCount: 0, netReceivedMinor: 0, creditedMinor: 0 }], drafts: 0, pendingApproval: 0, testInvoices: 2 };
    const out = text(<ReceivablesCards summary={summary} />);
    expect(out).toContain("2 test invoices are kept apart: nothing is owed on a test invoice, so it is never counted here.");
    expect(out).not.toContain("Paid in test mode");
    expect(text(<ReceivablesCards summary={{ ...summary, testInvoices: 1 }} />)).toContain("1 test invoice is kept apart");
    expect(text(<ReceivablesCards summary={{ ...summary, testInvoices: 0 }} />)).not.toContain("kept apart");
  });

  it("leaves nothing to refund or dispute on a test invoice's payments, and says how to try the account", () => {
    const pay: PaymentView = { id: "p1", amountMinor: 150000, currency: "PHP", provider: "simulated", verification: "provider_confirmed", method: null, status: "succeeded", livemode: false, receivedAt: "2026-10-23T12:00:00.000Z", evidence: null, taxPortionMinor: 0, refundedMinor: 0, recordedByName: null };
    const real = renderToStaticMarkup(<PaymentsPanel payments={[pay]} refunds={[]} currency="PHP" canRefund tz="UTC" />);
    expect(real).toContain("Record a refund");
    const test = renderToStaticMarkup(<PaymentsPanel payments={[pay]} refunds={[]} currency="PHP" canRefund isTest tz="UTC" />);
    expect(test).not.toContain("Record a refund");
    expect(test).not.toContain("Record a dispute");
    expect(test).toContain("in test mode. No real money moved.");
    expect(renderToStaticMarkup(<PaymentsPanel payments={[]} refunds={[]} currency="PHP" canRefund isTest tz="UTC" />)).toContain("No test payment has been made on this test invoice yet.");
  });
});

const publicInvoice = (over: Partial<PublicInvoice> = {}): PublicInvoice => ({
  business: { name: "Harbor Home Services", brandColor: null, addressLines: [], taxLabel: null, taxId: null, email: null, phone: null }, number: "TEST-0001", issueOn: "2026-10-23", dueOn: "2026-11-06", currency: "PHP",
  taxInclusive: false, billTo: { name: "Maria Santos", company: null, addressLines: [] }, lines: [{ position: 1, description: "Service call", quantity: "1", unitPriceMinor: 150000, discountMinor: 0, taxRateBps: null, amountMinor: 150000 }],
  subtotalMinor: 150000, taxMinor: 0, totalMinor: 150000, paidMinor: 0, creditedMinor: 0, credits: [], balanceMinor: 150000, paymentStatus: "unpaid", overdue: false, paymentInstructions: null, notes: null, terms: null, footerNote: null,
  hasPendingPayment: false, canPayOnline: false, isTest: true, banner: { kind: "test", tone: "info" }, ...over,
});

describe("the customer's page for a test invoice", () => {
  it("opens with the test banner, titles itself a test invoice and prints a label that stays on paper", () => {
    const out = renderToStaticMarkup(<InvoiceDocument invoice={publicInvoice()} />);
    expect(out).toContain("This is a test invoice: nothing is owed and no money moves.");
    expect(out).toMatch(/<h1[^>]*>Test invoice<\/h1>/);
    const label = out.match(/<p data-test-label[^>]*class="([^"]*)"[^>]*>|<p[^>]*class="([^"]*)"[^>]*data-test-label[^>]*>/);
    expect(label).toBeTruthy();
    expect(`${label?.[1] ?? label?.[2]}`).not.toMatch(/print:hidden/);
    expect(out).toContain("Test · nothing is owed");
  });

  it("is unchanged for a real invoice", () => {
    const out = renderToStaticMarkup(<InvoiceDocument invoice={publicInvoice({ isTest: false, banner: { kind: "pay_other_way", tone: "info" }, number: "INV-0001" })} />);
    expect(out).toMatch(/<h1[^>]*>Invoice<\/h1>/);
    expect(out).not.toContain("data-test-label");
    expect(out).not.toContain("test invoice");
  });

  it("chooses the test banner before any payment state, and the words name nothing owed", () => {
    for (const paymentStatus of ["unpaid", "partially_paid", "paid", "disputed"] as const) {
      expect(invoiceBanner({ paymentStatus, balanceMinor: 100, hasPendingPayment: true, canPayOnline: true, overdue: true, isTest: true }), paymentStatus).toEqual({ kind: "test", tone: "info" });
    }
    expect(invoiceBanner({ paymentStatus: "paid", balanceMinor: 0, hasPendingPayment: false, canPayOnline: false, overdue: false })).toEqual({ kind: "paid", tone: "ok" });
    expect(bannerText("test", publicInvoice())).toBe("This is a test invoice: nothing is owed and no money moves.");
  });

  it("labels the Pay button as a test and says no money moves", () => {
    const out = renderToStaticMarkup(<PayPanel token={"A".repeat(43)} canPay balanceMinor={150000} currency="PHP" isTest />);
    expect(out).toContain("as a test");
    expect(out).not.toMatch(/online<\/button>|online\s*<\/button>/);
    expect(out).toContain("no card is asked for and no money moves");
    expect(renderToStaticMarkup(<PayPanel token={"A".repeat(43)} canPay balanceMinor={150000} currency="PHP" />)).toMatch(/Pay[^<]*online/);
  });

  it("tells a customer returning from the testing checkout that it was a test and nothing is owed", () => {
    const paid = describeReturn({ attemptStatus: "succeeded", payment: { status: "succeeded" }, invoiceStatus: "issued", ageMinutes: 1, isTest: true });
    expect(paid).toMatchObject({ state: "received", headline: "The test payment went through", polling: false });
    expect(paid.detail).toMatch(/no money moved and nothing is owed/);
    expect(describeReturn({ attemptStatus: "succeeded", payment: { status: "succeeded" }, invoiceStatus: "issued", ageMinutes: 1 }).headline).toBe("We have received your payment");
  });
});

const connectionView = (over: Partial<ConnectionView> = {}): ConnectionView => ({
  id: "c1", provider: "paymongo", providerLabel: "PayMongo", providerNote: "Built from PayMongo's documentation.", mode: "test", status: "connected", statusLabel: "Connected", statusExplain: "The key was accepted.",
  accountLabel: null, supportedCurrencies: ["PHP"], webhookUrl: "https://app.example/api/webhooks/customer-payments/paymongo/cpk_abcdefghij0123456789", environment: null, webhookSecretSaved: true, credentialsReadable: true,
  authorizedAt: "2026-10-20T01:00:00.000Z", authorizationVersion: "draft-2026-10-23", liveConfirmedAt: null, lastEventAt: null, lastCheckedAt: "2026-10-23T01:00:00.000Z", lastError: null, createdAt: "2026-10-20T01:00:00.000Z",
  hasConfirmedTestPayment: false, teamCheckoutBlock: null, customerCheckoutBlock: { code: "test_mode_public", message: "x" }, liveConfirmBlock: "This connection uses test keys.", ...over,
});

describe("the payment account card", () => {
  const card = (c: ConnectionView) => renderToStaticMarkup(<ConnectionsPanel connections={[c]} providers={[]} callsEnabled liveEnabled tz="UTC" />);

  it("sends the owner to a new test invoice to run a test, in a full-height link, and says only a test invoice is paid that way", () => {
    const out = card(connectionView());
    expect(out).toMatch(/<a class="[^"]*min-h-11[^"]*" href="\/invoices\/new\?test=1">Start a test invoice<\/a>/);
    expect(out).toContain("Only a test invoice can be paid this way");
    expect(out).toContain("A real invoice is never marked paid by a test.");
    expect(out).toContain("it takes test invoices only");
  });

  it("offers no test invoice from a live account, which takes real invoices only", () => {
    const out = card(connectionView({ mode: "live" }));
    expect(out).not.toContain("Start a test invoice");
    expect(out).toContain("This account is live, so it takes real invoices only.");
  });
});
