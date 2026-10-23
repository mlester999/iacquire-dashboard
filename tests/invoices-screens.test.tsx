// The invoice screens as a person reads them, rendered to static markup from the REAL records the application keeps (the QA world is the fixture), so a change to a record's
// shape or to the words a screen uses is caught here. No browser: layout, focus and touch targets are for the browser run; what is said, what is offered and what is withheld is here.
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }), usePathname: () => mocks.pathname }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/actions/invoices", () => Object.fromEntries([
  "createInvoiceDraftAction", "updateInvoiceDraftAction", "discardInvoiceDraftAction", "searchInvoiceDealsAction", "submitInvoiceAction", "withdrawInvoiceAction", "requestInvoiceChangesAction",
  "issueInvoiceAction", "voidInvoiceAction", "writeOffInvoiceAction", "recordPaymentAction", "recordRefundAction", "getInvoiceLinkAction", "rotateInvoiceLinkAction", "saveInvoiceSettingsAction",
  "authorizeRemindersAction", "switchOffRemindersAction", "connectProviderAction", "saveWebhookSecretAction", "replaceKeysAction", "recheckConnectionAction", "confirmLiveAction",
  "pauseConnectionAction", "disconnectConnectionAction", "recentDeliveriesAction", "startTestPaymentAction",
].map((name) => [name, vi.fn()])));
vi.mock("@/app/actions/crm", () => ({ searchContactsAction: vi.fn() }));
const mocks = vi.hoisted(() => ({ pathname: "/invoices" }));

import { seedInvoiceWorld, type InvoiceWorldRow } from "../scripts/invoices-qa-world";
import { getInvoiceDetail, listInvoices, receivablesSummary, type InvoiceFullDetail } from "@/server/invoices/invoices";
import { paymentsNeedingLook } from "@/server/invoices/search";
import { getInvoiceSettings } from "@/server/invoices/settings";
import { getReminderOverview } from "@/server/invoices/reminders";
import type { ConnectionView } from "@/server/customer-payments/connections";
import { listConnections } from "@/server/customer-payments/connections";
import { invoiceActions, type ActionFacts } from "@/lib/invoices/screens";
import { InvoiceFilters, InvoiceList, NeedsLookList, ReceivablesCards } from "@/components/invoices/invoice-list";
import { InvoicesPanel } from "@/components/invoices/crm-panel";
import { InvoicesClientOnly, InvoicesNotEnabled } from "@/components/invoices/notices";
import { InvoicesSubnav } from "@/components/invoices/subnav";
import { InvoiceSummary, LinesTable, RemindersList, Timeline } from "@/components/invoices/invoice-sections";
import { PaymentsPanel } from "@/components/invoices/payments-panel";
import { InvoiceActions } from "@/components/invoices/invoice-actions";
import { InvoiceSettingsPanel, RemindersPanel } from "@/components/invoices/settings-panel";
import { ConnectionsPanel } from "@/components/invoices/connections-panel";
import { InvoiceForm, emptyFormState } from "@/components/invoices/invoice-form";
import { invoiceOrg, type InvoiceOrg } from "./support/invoices";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const text = (el: React.ReactElement) => html(el).replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");

let io: InvoiceOrg;
let world: InvoiceWorldRow[];
const detailOf = (title: string) => getInvoiceDetail(io.ctx("owner"), world.find((r) => r.title === title)!.invoiceId);

beforeAll(async () => {
  io = await invoiceOrg({ timezone: "Asia/Manila" });
  world = await seedInvoiceWorld({ owner: io.ctx("owner"), ownerActor: io.c.actor("owner"), sales: io.ctx("sales") });
}, 120_000);

const connectionView = (over: Partial<ConnectionView> = {}): ConnectionView => ({
  id: "c1", provider: "paymongo", providerLabel: "PayMongo", providerNote: "Built from PayMongo's documentation and tested against recorded fixtures. It has not run against a PayMongo account yet.", mode: "test", status: "connected",
  statusLabel: "Connected", statusExplain: "The key was accepted by the provider and the webhook signing secret is saved.", accountLabel: null, supportedCurrencies: ["PHP"],
  webhookUrl: "https://app.example/api/webhooks/customer-payments/paymongo/cpk_abcdefghij0123456789", environment: null, webhookSecretSaved: true, credentialsReadable: true, authorizedAt: "2026-10-20T01:00:00.000Z",
  authorizationVersion: "draft-2026-10-23", liveConfirmedAt: null, lastEventAt: null, lastCheckedAt: "2026-10-23T01:00:00.000Z", lastError: null, createdAt: "2026-10-20T01:00:00.000Z",
  hasConfirmedTestPayment: false, teamCheckoutBlock: null, customerCheckoutBlock: { code: "test_mode_public", message: "This account is in test mode, so customers are not sent to it." }, liveConfirmBlock: "This connection uses test keys. Replace them with your live keys first.", ...over,
});

describe("the list", () => {
  it("shows what is owed per currency, each on its own and never converted, with test-mode payments labelled and the scheduler caveat said", async () => {
    const summary = await receivablesSummary(io.ctx("owner"));
    const out = text(<ReceivablesCards summary={summary} />);
    expect(summary.byCurrency.map((r) => r.currency).sort()).toEqual(["PHP", "USD"]);
    for (const code of ["PHP", "USD"]) expect(out).toContain(code);
    expect(out).toContain("Overdue");
    expect(out).toContain("Received, net of refunds");
    expect(out).toContain("Paid in test mode");
    expect(out).toContain("Each currency is shown on its own and is never converted");
    expect(out).toContain("only while the scheduler runs");
    expect(html(<ReceivablesCards summary={{ byCurrency: [], drafts: 0, pendingApproval: 0 }} />)).toBe("");
  });

  it("lists every invoice with its number, customer, due date, status and what is left, marks the overdue one, and is empty with a reason", async () => {
    const rows = await listInvoices(io.ctx("owner"), { limit: 200 });
    expect(rows).toHaveLength(14);
    const out = text(<InvoiceList rows={rows} empty={{ title: "x", description: "y" }} />);
    expect(out).toContain("INV-0001");
    expect(out).toContain("Draft");
    expect(out).toContain("Mara Villanueva");
    expect(out).toMatch(/\d+ days? overdue/);
    expect(out).toContain("₱1,500.00");
    expect(out).toContain("Paid");
    expect(out).toContain("Disputed");
    expect(out).toContain("left");
    expect(html(<InvoiceList rows={rows} empty={{ title: "x", description: "y" }} />)).toContain('aria-label="Invoices"');
    const empty = text(<InvoiceList rows={[]} empty={{ title: "Nothing is owed right now", description: "Start an invoice for a customer or a deal." }} />);
    expect(empty).toContain("Nothing is owed right now");
    expect(empty).toContain("Start an invoice for a customer or a deal.");
  });

  it("offers the filters and a labelled search, keeping the filter and the search in the addresses", () => {
    const out = html(<InvoiceFilters active="overdue" search="mara" />);
    expect(out).toContain('aria-current="page"');
    expect(out).toContain("/invoices?filter=paid&amp;q=mara");
    expect(out).toContain('for="invoice-search"');
    expect(out).toContain('value="overdue"');
    for (const label of ["Owed", "Overdue", "Drafts", "Waiting for approval", "Paid", "Void", "Everything"]) expect(out).toContain(label);
  });

  it("puts payments that need a look in plain words above the list, and nothing when there are none", async () => {
    const look = await paymentsNeedingLook(io.ctx("owner"));
    const out = text(<NeedsLookList rows={look} tz="Asia/Manila" />);
    expect(out).toContain("Payments that need a look");
    expect(out).toContain("Reported by the provider but not counted. Compare it with the provider's dashboard.");
    expect(out).toContain("The customer disputed it with their bank.");
    expect(html(<NeedsLookList rows={[]} tz="UTC" />)).toBe("");
  });

  it("shows the customer's and the deal's invoices on their own pages, with a way to start one only for a person who may", async () => {
    const rows = (await listInvoices(io.ctx("owner"), { limit: 5 }));
    expect(text(<InvoicesPanel rows={rows} newHref="/invoices/new?contact=1" canCreate />)).toContain("New invoice");
    expect(text(<InvoicesPanel rows={rows} newHref="/invoices/new?contact=1" canCreate={false} />)).not.toContain("New invoice");
    const none = text(<InvoicesPanel rows={[]} newHref="/invoices/new" canCreate />);
    expect(none).toContain("No invoices yet");
    expect(none).toContain("New invoice");
    expect(text(<InvoicesPanel rows={[]} newHref="/invoices/new" canCreate={false} />)).not.toContain("New invoice");
  });
});

describe("the areas that are not available", () => {
  it("tells a workspace without invoices that it is not switched on, who to ask, and does not claim a payment feature exists", () => {
    const owner = text(<InvoicesNotEnabled isOwner />);
    expect(owner).toContain("Customer invoices aren't switched on for your workspace yet");
    expect(owner).toContain("Ask your iAcquire contact to switch it on for your workspace.");
    expect(text(<InvoicesNotEnabled isOwner={false} />)).toContain("Ask your workspace owner to ask iAcquire");
  });

  it("tells an agency workspace that invoices live inside each client, and that iAcquire's own billing is separate", () => {
    const out = text(<InvoicesClientOnly canOpenClients />);
    expect(out).toContain("Customer invoices live inside each client's workspace");
    expect(out).toContain("iAcquire's own billing is under Billing, and is separate");
    expect(out).toContain("Go to clients");
    expect(text(<InvoicesClientOnly canOpenClients={false} />)).not.toContain("Go to clients");
  });

  it("marks the section the person is in, counts what waits for approval for those who hear it, and links the payment account only to the owner", () => {
    mocks.pathname = "/invoices/settings";
    const settings = html(<InvoicesSubnav waiting={2} canConnect />);
    expect(settings).toMatch(/aria-current="page"[^>]*href="\/invoices\/settings"/);
    expect(settings).not.toMatch(/aria-current="page"[^>]*href="\/invoices"/);
    expect(settings).toContain("2 waiting for approval");
    expect(settings).toContain('href="/settings/payments"');
    mocks.pathname = "/invoices/0b5f1f0e-8f4c-4d2a-9d1e-0123456789ab";
    expect(html(<InvoicesSubnav waiting={0} canConnect={false} />)).toMatch(/aria-current="page"[^>]*href="\/invoices"/);
    expect(html(<InvoicesSubnav waiting={0} canConnect={false} />)).not.toContain("/settings/payments");
    expect(html(<InvoicesSubnav waiting={0} canConnect={false} />)).not.toContain("waiting for approval");
    mocks.pathname = "/invoices";
  });
});

describe("one invoice", () => {
  it("summarises an issued invoice with its status, customer, dates, version, amounts and, when overdue, how late it is", async () => {
    const d = await detailOf("Water heater inspection");
    const out = text(<InvoiceSummary detail={d} tz="Asia/Manila" />);
    expect(out).toContain("Issued");
    expect(out).toMatch(/\d+ days? overdue/);
    expect(out).toContain("Noel Tan");
    for (const label of ["Total", "Paid", "Refunded", "Balance"]) expect(out).toContain(label);
    expect(out).toContain("₱2,450.00");
    expect(out).toContain("Version 1");
  });

  it("says a draft has no number and no dates yet, a written-off invoice was written off and why, and a deal-linked one links the deal", async () => {
    const draft = text(<InvoiceSummary detail={await detailOf("Bathroom faucet replacement")} tz="UTC" />);
    expect(draft).toContain("Draft");
    expect(draft).toContain("Not issued yet");
    expect(draft).toContain("Set when it is issued");
    const off = text(<InvoiceSummary detail={await detailOf("Seasonal tune-up")} tz="UTC" />);
    expect(off).toContain("Written off");
    expect(off).toContain("The customer closed their business (QA)");
    const deal = html(<InvoiceSummary detail={await detailOf("Kitchen repipe")} tz="UTC" />);
    expect(deal).toContain("/crm/opportunities/");
    expect(deal).toContain("Kitchen repipe (QA)");
  });

  it("lays out the lines with quantity, price, tax and amount, and a tax-inclusive invoice says its prices include tax", async () => {
    const usd = text(<LinesTable detail={await detailOf("Remote monitoring set-up")} />);
    expect(usd).toContain("Subtotal (before tax)");
    expect(usd).toContain("Tax (included)");
    expect(usd).toContain("12%");
    expect(usd).toContain("$560.00");
    const php = text(<LinesTable detail={await detailOf("Bathroom faucet replacement")} />);
    expect(php).toContain("Bathroom faucet replacement");
    expect(php).toContain("Parts: faucet and fittings");
    expect(php).toContain("Tax");
    expect(php).not.toContain("(included)");
  });

  it("says plainly that reminders go out only after the owner authorized them and are checked when the scheduler runs, and shows a reminder's outcome when there is one", async () => {
    const d = await detailOf("Water heater inspection");
    const none = text(<RemindersList detail={{ ...d, reminders: [] }} tz="UTC" />);
    expect(none).toContain("No reminders are planned for this invoice");
    expect(none).toContain("only after the owner has authorized their exact wording");
    expect(none).toContain("checked when the scheduler runs, not live");
    const blocked: InvoiceFullDetail = { ...d, reminders: [{ stepKey: "after_due:3", dueAt: "2026-11-09T01:00:00.000Z", status: "blocked", reason: "no_consent", reasonText: "The customer has not agreed to receive service messages.", messageStatus: null, channel: "email" }] };
    const out = text(<RemindersList detail={blocked} tz="UTC" />);
    expect(out).toContain("Blocked");
    expect(out).toContain("The customer has not agreed to receive service messages.");
    expect(html(<RemindersList detail={{ ...(await detailOf("Bathroom faucet replacement")), reminders: [] }} tz="UTC" />)).toBe("");
  });

  it("tells the history oldest last, in words, says who or what did each step, and carries no customer detail", async () => {
    const d = await detailOf("Sump pump installation");
    const out = text(<Timeline detail={d} tz="Asia/Manila" />);
    expect(out).toContain("History");
    expect(out).toContain("A test payment was confirmed by the payment provider");
    expect(out).toContain("Test mode: no real money moved.");
    expect(out).toContain("A refund was recorded");
    expect(out).toContain("Payment provider ·");
    expect(out.indexOf("A refund was recorded")).toBeLessThan(out.indexOf("Draft created."));
    expect(out).not.toMatch(/customer\.example\.test|petra\.soriano/i);
  });

  it("lists payments with who vouched for each, marks a test one as test, shows refunds, and offers a refund only to the owner", async () => {
    const d = await detailOf("Sump pump installation");
    const owner = text(<PaymentsPanel payments={d.payments} refunds={d.refunds} currency="PHP" canRefund tz="UTC" />);
    expect(owner).toContain("Payments and refunds");
    expect(owner).toContain("Test mode");
    expect(owner).toContain("Confirmed by the payment provider in test mode. No real money moved.");
    expect(owner).toContain("₱500.00 refunded");
    expect(owner).toContain("Goodwill credit for a late arrival (QA)");
    expect(owner).toContain("Recorded by hand");
    expect(owner).toContain("Record a refund");
    expect(text(<PaymentsPanel payments={d.payments} refunds={d.refunds} currency="PHP" canRefund={false} tz="UTC" />)).not.toContain("Record a refund");
    const manual = await detailOf("Drain clearing");
    const hand = text(<PaymentsPanel payments={manual.payments} refunds={manual.refunds} currency="PHP" canRefund tz="UTC" />);
    expect(hand).toMatch(/Recorded by .* from their own word: Cash, receipt book page 12/);
    expect(hand).not.toContain("Test mode");
    const none = text(<PaymentsPanel payments={[]} refunds={[]} currency="PHP" canRefund tz="UTC" />);
    expect(none).toContain("A payment appears here only when your payment provider confirms it or you record it yourself.");
  });
});

describe("what can be done", () => {
  const facts = (d: InvoiceFullDetail, over: Partial<ActionFacts> = {}): ActionFacts => ({
    status: d.invoice.status, paymentStatus: d.invoice.paymentStatus, writtenOff: d.invoice.writtenOffAt !== null, balanceMinor: d.invoice.balanceMinor, paidMinor: d.invoice.paidMinor, createdVia: d.invoice.createdVia,
    isAuthor: true, approvalRequiredForCreators: true, hasTestConnection: true, can: { create: true, approve: true, send: true, recordPayment: true, void: true, refund: true, connect: true }, ...over,
  });
  const actions = (d: InvoiceFullDetail, over: Partial<ActionFacts> = {}, hasCustomer = true) => {
    const i = d.invoice;
    return <InvoiceActions invoiceId={i.id} version={i.version} number={i.number} status={i.status} currency={i.currency} balanceMinor={i.balanceMinor} totalMinor={i.totalMinor} facts={facts(d, over)} tz="UTC" hasCustomer={hasCustomer} closeRuleNote={null} />;
  };

  it("offers the owner what an issued invoice that is owed allows, and nothing for a void one", async () => {
    const out = text(actions(await detailOf("Water heater inspection")));
    for (const label of ["Get the customer's link", "Record a payment", "Pay as a test", "Write off", "Void"]) expect(out).toContain(label);
    expect(text(actions(await detailOf("Gas line check")))).not.toMatch(/Get the customer's link|Record a payment|Void/);
  });

  it("offers a draft its edit, send for approval and discard, asks for a customer first when there is none, and offers a waiting invoice its approval", async () => {
    const draft = await detailOf("Bathroom faucet replacement");
    const out = text(actions(draft, {}, false));
    expect(out).toContain("Edit draft");
    expect(out).toContain("Send for approval");
    expect(out).toContain("Discard draft");
    expect(out).toContain("Choose the customer on the draft before it can be sent for approval or issued.");
    const waiting = text(actions(await detailOf("Leak detection survey"), { isAuthor: false }));
    expect(waiting).toContain("Approve and issue");
    expect(waiting).toContain("Ask for changes");
  });

  it("explains, instead of offering, what a salesperson cannot do", async () => {
    const out = text(actions(await detailOf("Leak detection survey"), { isAuthor: true, can: { create: true, approve: false, send: false, recordPayment: false, void: false, refund: false, connect: false } }));
    expect(out).toContain("The owner or a manager has to approve this invoice before it can be issued.");
    expect(out).toContain("Take back to draft");
    expect(out).not.toContain("Approve and issue");
    const partlyPaid = await detailOf("Kitchen repipe");
    expect(text(actions(partlyPaid))).toContain("An invoice with a payment cannot be voided. Record a refund instead.");
    expect(invoiceActions(facts(partlyPaid)).offered).not.toContain("void");
  });
});

describe("the form", () => {
  it("previews the totals with the server's money rules and says it is a preview, says nothing is sent, and asks for a customer before approval", () => {
    const initial = emptyFormState({ currency: "PHP", lines: [{ description: "Service call", quantity: "2", unitPrice: "1500.00", discountPercent: "", discountAmount: "", taxPercent: "12" }] });
    const out = text(<InvoiceForm mode={{ kind: "new" }} initial={initial} termsDays={14} />);
    expect(out).toContain("₱3,000.00");
    expect(out).toContain("₱360.00");
    expect(out).toContain("₱3,360.00");
    expect(out).toContain("A preview. The server works out the real totals when you save.");
    expect(out).toContain("An invoice needs a customer before it can be sent for approval.");
    expect(out).toContain("Tax is only what you enter on a line: nothing is worked out for you, and this is not tax advice.");
    expect(out).toContain("it is due 14 days after the day you issue it");
    expect(out).toContain("Never type a card number.");
    expect(html(<InvoiceForm mode={{ kind: "new" }} initial={initial} termsDays={14} />)).toContain('aria-label="New invoice"');
  });

  it("keeps Save closed until a line can be read, and says which", () => {
    const blank = html(<InvoiceForm mode={{ kind: "new" }} initial={emptyFormState({ currency: "PHP" })} termsDays={14} />);
    expect(blank).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*Save draft/);
    expect(blank).toContain("Add at least one line to save.");
    const bad = text(<InvoiceForm mode={{ kind: "edit", id: "x", version: 3 }} initial={emptyFormState({ currency: "PHP", lines: [{ description: "Thing", quantity: "1", unitPrice: "12.345", discountPercent: "", discountAmount: "", taxPercent: "" }] })} termsDays={0} />);
    expect(bad).toContain("Line 1");
    expect(bad).toContain("Fix the lines marked above to save.");
    expect(bad).toContain("Save changes");
    expect(bad).toContain("due 0 days after");
  });
});

describe("the settings", () => {
  it("shows the owner every field filled from what was saved, with the verified-revenue choice off by default and explained", async () => {
    const settings = await getInvoiceSettings(io.ctx("owner"));
    const owner = html(<InvoiceSettingsPanel settings={settings} canEdit />);
    expect(owner).toContain('value="Harbor Home Services (QA)"');
    expect(owner).toContain("14 Quay Road");
    expect(owner).toContain('value="INV-"');
    expect(owner).toContain("Save settings");
    expect(owner).toContain("Count payments I record by hand as verified revenue in the Lead Sources report.");
    expect(owner).toMatch(/<input[^>]*type="checkbox"[^>]*class="[^"]*"[^>]*\/><span>Count payments I record by hand/);
    expect(text(<InvoiceSettingsPanel settings={settings} canEdit />)).toContain("nothing here claims a tax registration, and the document is called an Invoice");
  });

  it("is read-only for everyone but the owner, and says so", async () => {
    const settings = await getInvoiceSettings(io.ctx("owner"));
    const out = html(<InvoiceSettingsPanel settings={settings} canEdit={false} />);
    expect(out).toContain("Only the business owner changes these settings. You can read them.");
    expect(out).toContain("<fieldset disabled");
    expect(out).not.toContain("Save settings");
  });

  it("keeps reminders off until the owner has read the exact messages, shows them as a customer would read them, calls the wording proposed, and says reminders are not live", async () => {
    const settings = await getInvoiceSettings(io.ctx("owner"));
    const overview = await getReminderOverview(io.ctx("owner"));
    expect(overview.enabled).toBe(false);
    const out = text(<RemindersPanel settings={settings} overview={overview} canEdit canSwitchOff tz="Asia/Manila" />);
    expect(out).toContain("Payment reminders");
    expect(out).toContain("Off");
    expect(out).toContain("They are off until you have read the exact messages below and authorized them");
    expect(out).toContain("This wording is proposed. It has not been reviewed by a lawyer or an accountant.");
    expect(out).toContain("Reminders are planned and sent only while the scheduler runs, so they are checked on a schedule, not live.");
    expect(out).toContain("Authorize reminders");
    expect(out).toContain("Each text message uses your prepaid service credits.");
    expect(out).not.toContain("Switch reminders off");
    expect(overview.previews.length).toBeGreaterThan(0);
    for (const p of overview.previews) expect(out).toContain(p.subject);
    // The customer's link is never in a preview, only a word for it.
    expect(out).not.toMatch(/\/pay\/[A-Za-z0-9_-]{43}/);
    const html1 = html(<RemindersPanel settings={settings} overview={overview} canEdit canSwitchOff tz="UTC" />);
    expect(html1).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*Authorize reminders/);
  });

  it("shows what a person who may only read sees, an authorization that is on, and one on hold with the reason", async () => {
    const settings = await getInvoiceSettings(io.ctx("owner"));
    const base = await getReminderOverview(io.ctx("owner"));
    const readOnly = text(<RemindersPanel settings={settings} overview={base} canEdit={false} canSwitchOff={false} tz="UTC" />);
    expect(readOnly).not.toContain("Authorize reminders");
    expect(readOnly).not.toContain("Save reminder days and channels");
    const on = text(<RemindersPanel settings={settings} overview={{ ...base, enabled: true, active: true, authorizedByName: "Olive Owner", authorizedAt: "2026-10-23T01:00:00.000Z", expiresAt: "2027-01-21T01:00:00.000Z" }} canEdit canSwitchOff tz="UTC" />);
    expect(on).toContain("On");
    expect(on).toContain("Authorized by Olive Owner");
    expect(on).toContain("Switch reminders off");
    const hold = text(<RemindersPanel settings={settings} overview={{ ...base, enabled: true, active: false, problemText: "The authorization has run out." }} canEdit canSwitchOff tz="UTC" />);
    expect(hold).toContain("On hold");
    expect(hold).toContain("The authorization has run out.");
    expect(hold).toContain("Authorize again");
  });
});

describe("the payment account", () => {
  it("says calls to real providers are off, still lets the invoices work, and offers the providers that can be connected with their honest notes", async () => {
    const out = text(<ConnectionsPanel connections={[]} providers={["paymongo", "paypal", "simulated"]} callsEnabled={false} liveEnabled={false} tz="UTC" />);
    expect(out).toContain("Calls to real payment providers are switched off in this environment.");
    expect(out).toContain("Invoices, recording payments by hand, and the customer's invoice page all work now.");
    expect(out).toContain("Customers pay your own payment provider account");
    expect(out).toContain("iAcquire does not hold your customers' money, takes no cut of it");
    expect(out).toContain("PayMongo takes Philippine pesos only.");
    expect(out).toContain("This wording is proposed and has not been reviewed by a lawyer.");
    expect(out).toContain("I am the owner of this business, or I am authorized by it to connect its payment account.");
    expect(out).toContain("Check the keys and connect");
    // The key is asked for in a field that hides it; nothing is pre-filled.
    const form = html(<ConnectionsPanel connections={[]} providers={["paymongo"]} callsEnabled liveEnabled={false} tz="UTC" />);
    expect(form).toMatch(/id="cn-key"[^>]*type="password"|type="password"[^>]*id="cn-key"/);
    expect(form).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*Check the keys and connect/);
    expect(text(<ConnectionsPanel connections={[]} providers={["paymongo"]} callsEnabled liveEnabled={false} tz="UTC" />)).not.toContain("switched off in this environment");
  });

  it("shows a connection's state without ever showing a key, the webhook address to copy, what is unverified, and the checks that are missing before going live", () => {
    const test = connectionView();
    const out = text(<ConnectionsPanel connections={[test]} providers={["paymongo", "paypal"]} callsEnabled liveEnabled={false} tz="UTC" />);
    expect(out).toContain("PayMongo");
    expect(out).toContain("Test mode");
    expect(out).toContain("Connected");
    expect(out).toContain("It has not run against a PayMongo account yet.");
    expect(out).toContain("Event names are from PayMongo's documentation and have not been checked against a live account.");
    expect(out).toContain("Webhook signing secret saved. It is not shown again.");
    expect(out).toContain("This account is in test mode, so customers are not sent to it.");
    expect(out).toContain("A test payment confirmed by the provider: not yet");
    expect(html(<ConnectionsPanel connections={[test]} providers={["paymongo"]} callsEnabled liveEnabled={false} tz="UTC" />)).toContain(test.webhookUrl);
    const live = text(<ConnectionsPanel connections={[connectionView({ mode: "live", id: "c2" })]} providers={[]} callsEnabled liveEnabled={false} tz="UTC" />);
    expect(live).toContain("Going live");
    expect(live).toContain("This connection uses test keys. Replace them with your live keys first.");
    expect(live).toContain("Live payments are switched off for the whole service until iAcquire turns them on.");
    expect(live).toContain("Confirm going live");
  });

  it("asks for the PayPal webhook's ID, not a signing secret, names the app kind, and says the PayPal contract is unchecked", () => {
    const paypal = connectionView({
      id: "c3", provider: "paypal", providerLabel: "PayPal", providerNote: "Built from PayPal's documentation and tested against hand-written examples. It has not run against a PayPal app yet.", environment: "sandbox",
      supportedCurrencies: ["PHP", "USD"], webhookSecretSaved: false, status: "pending_verification", statusLabel: "Almost there", webhookUrl: "https://app.example/api/webhooks/customer-payments/paypal/cpk_abcdefghij0123456789",
    });
    const out = text(<ConnectionsPanel connections={[paypal]} providers={["paymongo"]} callsEnabled liveEnabled={false} tz="UTC" />);
    expect(out).toContain("It has not run against a PayPal app yet.");
    expect(out).toContain("PayPal app: sandbox (testing)");
    expect(out).toContain("Webhook ID");
    expect(out).toContain("Event names are from PayPal's documentation and have not been checked against a live app.");
    expect(out).toContain("Until this is saved, messages from the provider are refused and payments cannot be confirmed.");
    const add = text(<ConnectionsPanel connections={[]} providers={["paypal"]} callsEnabled liveEnabled={false} tz="UTC" />);
    expect(add).toContain("Client ID");
    expect(add).toContain("Client secret");
    expect(add).toContain("Sandbox (testing)");
    expect(add).toContain("PayPal can take the currencies your account is set up for.");
  });

  it("raises keys that can no longer be read and a problem the provider reported, and offers pausing, resuming and disconnecting", () => {
    const broken = text(<ConnectionsPanel connections={[connectionView({ credentialsReadable: false, lastError: "PayMongo did not accept this key.", status: "needs_attention", statusLabel: "Needs attention" })]} providers={[]} callsEnabled liveEnabled={false} tz="UTC" />);
    expect(broken).toContain("The saved keys can no longer be read. Replace them to use this account.");
    expect(broken).toContain("PayMongo did not accept this key.");
    expect(broken).toContain("Pause online payments");
    expect(broken).toContain("Disconnect");
    const paused = text(<ConnectionsPanel connections={[connectionView({ status: "disabled", statusLabel: "Paused" })]} providers={[]} callsEnabled liveEnabled={false} tz="UTC" />);
    expect(paused).toContain("Resume online payments");
    expect(paused).not.toContain("Pause online payments");
  });

  it("shows the testing provider without keys or a webhook, and the connected world connection as exactly that", async () => {
    const all = await listConnections(io.ctx("owner"));
    // (The QA world also holds a paused placeholder PayMongo connection with no keys, for the Lead Sources report.)
    expect(all.map((c) => c.provider).sort()).toEqual(["paymongo", "simulated"]);
    expect(all.find((c) => c.provider === "paymongo")).toMatchObject({ status: "disabled", webhookSecretSaved: false });
    const real = all.filter((c) => c.provider === "simulated");
    const out = text(<ConnectionsPanel connections={real} providers={["paymongo", "paypal", "simulated"]} callsEnabled={false} liveEnabled={false} tz="UTC" />);
    expect(out).toContain("Simulated provider (testing only)");
    expect(out).toContain("The simulated provider makes its own secret and needs nothing to be set up.");
    expect(out).not.toContain("Webhook address (give this to the provider)");
    expect(out).not.toContain("Check the keys now");
    expect(JSON.stringify(all)).not.toMatch(/sim_[A-Za-z0-9]{8,}/);
  });
});
