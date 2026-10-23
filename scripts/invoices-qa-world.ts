/**
 * The fictional customer invoices used for isolated local browser QA and for the test that proves this script works: a business's invoice settings, a testing payment
 * connection, six customers and fourteen invoices in every state a customer or the team can meet. It writes through the application's own services and contacts NO ONE: no
 * payment provider exists (the connection is the simulated one, and the only "payments" through it are test-mode ones made on its testing checkout page), no message is sent, and
 * every name, address, account number and price is made up. The prices are not a price list: they exist so the totals have something to add up.
 *
 * One thing in it is fiction on purpose and says so: so that the Lead Sources report's verified-revenue column can be looked at, one invoice is paid by a "live" PayMongo payment
 * that was inserted through the application's own payment function against a placeholder connection (paused, with no keys). No PayMongo account exists behind it. It is in the
 * throwaway QA database only, and `revenueFiction: false` leaves it out.
 *
 * It is a plain module (no vitest, no database setup) so that both scripts/ui-qa-invoices-seed.qa.ts and tests/invoices-qa-seed.test.ts can run it.
 */
import { withSystem } from "../src/server/db/index";
import type { CrmActor } from "../src/server/crm/actor";
import { createContact } from "../src/server/crm/contacts";
import { createOpportunity } from "../src/server/crm/opportunities";
import { addCost } from "../src/server/attribution/costs";
import { recordTouch } from "../src/server/attribution/touches";
import type { OrgContext } from "../src/server/tenancy/context";
import { CURRENT_AUTHORIZATION_VERSION } from "../src/lib/invoices/connection-rules";
import { applyDisputeInTx, applyPaymentInTx } from "../src/server/invoices/apply";
import { createDraft, issueInvoice, submitForApproval, voidInvoice, writeOffInvoice } from "../src/server/invoices/invoices";
import { recordManualPayment, recordRefund } from "../src/server/invoices/payments";
import { getInvoiceLink } from "../src/server/invoices/share";
import { getInvoiceSettings, saveInvoiceSettings } from "../src/server/invoices/settings";
import { startCheckout } from "../src/server/customer-payments/attempts";
import { connectProvider, listConnections } from "../src/server/customer-payments/connections";
import { completeSimulatedCheckout } from "../src/server/customer-payments/dev-checkout";
import { newPublicKey } from "../src/server/customer-payments/ids";
import type { LineFormInput } from "../src/lib/invoices/lines";

export interface InvoiceWorldPeople {
  /** The business owner: sets the settings and the payment connection up, records payments and refunds. */
  owner: OrgContext;
  /** The owner as the CRM sees them: creates the customers and deals. */
  ownerActor: CrmActor;
  /** A salesperson: writes drafts, which wait for an approver. */
  sales: OrgContext;
}

export interface InvoiceWorldRow {
  /** Null while it is still a draft. */
  number: string | null;
  title: string;
  /** What state the story leaves it in, in a few words. */
  state: string;
  invoiceId: string;
  /** The team's screen for it. */
  portalPath: string;
  /** The customer's page, while the invoice is issued. */
  customerPath: string | null;
}

const DAY = 86_400_000;
const AUTHORIZATION = { accepted: true as const, version: CURRENT_AUTHORIZATION_VERSION };
const TESTING_ORIGIN = "http://localhost:3280";

const line = (description: string, unitPrice: string, over: Partial<LineFormInput> = {}): LineFormInput => ({ description, quantity: "1", unitPrice, ...over });

export async function seedInvoiceWorld(a: InvoiceWorldPeople, opts: { now?: Date; revenueFiction?: boolean } = {}): Promise<InvoiceWorldRow[]> {
  const now = opts.now ?? new Date();
  const ago = (days: number) => new Date(now.getTime() - days * DAY);
  const day = (offset: number) => new Date(now.getTime() + offset * DAY).toISOString().slice(0, 10);
  const orgId = a.owner.org.orgId;
  const rows: InvoiceWorldRow[] = [];

  const settings = await getInvoiceSettings(a.owner);
  await saveInvoiceSettings(a.owner, {
    legalName: "Harbor Home Services (QA)", addressLines: ["14 Quay Road", "Cebu City 6000", "Philippines"], taxLabel: "Sales tax", taxId: "QA-000-111-222 (made up)", replyToEmail: "billing@harbor.example.test",
    paymentTermsDays: 14, defaultPaymentInstructions: "Bank transfer to QA Bank, account 000-111-222 (not a real account). Quote the invoice number.", footerNote: "Thank you for your business. This is a QA copy.",
    closeRule: "task", countManualAsVerified: false,
  }, settings.version);

  // The testing payment connection: the simulated provider, which moves no money and reaches nothing.
  const existing = await listConnections(a.owner);
  const connection = existing.find((c) => c.provider === "simulated") ?? (await connectProvider(a.owner, { provider: "simulated", accountLabel: "Testing till (QA)", authorization: AUTHORIZATION }));

  const customer = async (first: string, last: string, source: string | null) => {
    const id = (await createContact(a.ownerActor, { firstName: first, lastName: last, email: `${first}.${last}@customer.example.test`.toLowerCase(), phone: null })).id;
    if (source) await withSystem((db) => recordTouch(db, { orgId, contactId: id, facts: { kind: "website_form", attribution: { utm_source: source } } }));
    return id;
  };
  const mara = await customer("Mara", "Villanueva", "google");
  const noel = await customer("Noel", "Tan", "facebook");
  const ines = await customer("Ines", "Ocampo", "google");
  const dario = await customer("Dario", "Lim", null);
  const petra = await customer("Petra", "Soriano", "facebook");
  const tomas = await customer("Tomas", "Reyes", "google");
  const deal = (await createOpportunity(a.ownerActor, { name: "Kitchen repipe (QA)", contactId: ines, value: 4200 })).id;

  const draft = (who: OrgContext, contactId: string, lines: LineFormInput[], over: Record<string, unknown> = {}) => createDraft(who, { contactId, currency: "PHP", lines, ...over });
  const issue = async (id: string, version: number, at: Date = now) => (await issueInvoice(a.owner, id, { version }, { now: at })).detail;
  const record = async (title: string, state: string, id: string, number: string | null, issued: boolean) => {
    const customerPath = issued ? new URL((await getInvoiceLink(a.owner, id)).url).pathname : null;
    rows.push({ number, title, state, invoiceId: id, portalPath: `/invoices/${id}`, customerPath });
  };

  // 1. A draft the owner is still writing.
  const d1 = await draft(a.owner, mara, [line("Bathroom faucet replacement", "2500.00"), line("Parts: faucet and fittings", "1850.50", { quantity: "2" })]);
  await record("Bathroom faucet replacement", "a draft", d1.invoice.id, null, false);

  // 2. A salesperson's invoice, waiting for an approver.
  const d2 = await draft(a.sales, noel, [line("Leak detection survey", "3200.00")]);
  const submitted = await submitForApproval(a.sales, d2.invoice.id, d2.invoice.version);
  await record("Leak detection survey", "waiting for approval", submitted.invoice.id, null, false);

  // 3. Issued, not yet due: the customer can open it and pay at the testing checkout.
  const d3 = await draft(a.owner, mara, [line("Annual boiler service", "4800.00", { taxPercent: "12" })]);
  const i3 = await issue(d3.invoice.id, d3.invoice.version);
  await record("Annual boiler service", "issued, due soon, with tax", i3.invoice.id, i3.invoice.number, true);

  // 4. Issued a month ago and overdue.
  const d4 = await draft(a.owner, noel, [line("Water heater inspection", "1800.00"), line("Anode rod", "650.00")]);
  const i4 = await issue(d4.invoice.id, d4.invoice.version, ago(30));
  await record("Water heater inspection", "overdue", i4.invoice.id, i4.invoice.number, true);

  // 5. Part paid by hand, with the evidence the person gave.
  const d5 = await draft(a.owner, ines, [line("Kitchen repipe: labour", "9000.00"), line("Kitchen repipe: materials", "3000.00")], { opportunityId: deal, closesDeal: false });
  const i5 = await issue(d5.invoice.id, d5.invoice.version, ago(5));
  await recordManualPayment(a.owner, i5.invoice.id, { amount: "4000.00", receivedOn: day(-3), method: "bank_transfer", evidence: "Deposit, bank transfer ref QA-4410 (made up)" }, { now: ago(3) });
  await record("Kitchen repipe", "part paid by hand, linked to a deal", i5.invoice.id, i5.invoice.number, true);

  // 6. Paid in full by hand.
  const d6 = await draft(a.owner, dario, [line("Drain clearing", "950.00")]);
  const i6 = await issue(d6.invoice.id, d6.invoice.version, ago(12));
  await recordManualPayment(a.owner, i6.invoice.id, { amount: "950.00", receivedOn: day(-9), method: "cash", evidence: "Cash, receipt book page 12 (made up)" }, { now: ago(9) });
  await record("Drain clearing", "paid by hand", i6.invoice.id, i6.invoice.number, true);

  // 7. Paid at the testing checkout (test mode: a provider-confirmed test payment, never revenue), then partly refunded.
  const d7 = await draft(a.owner, petra, [line("Sump pump installation", "6400.00", { taxPercent: "12" })]);
  const i7 = await issue(d7.invoice.id, d7.invoice.version, ago(6));
  const started7 = await startCheckout({ orgId, invoiceId: i7.invoice.id, audience: "member", actorUserId: a.owner.user.id, onlyMode: "test" });
  await completeSimulatedCheckout(started7.attemptId, "pay", { origin: TESTING_ORIGIN });
  const paid7 = (await withSystem((db) => db.query<{ id: string }>("select id from customer_payments where invoice_id = $1", [i7.invoice.id]))).rows[0];
  await recordRefund(a.owner, paid7.id, { amount: "500.00", reason: "Goodwill credit for a late arrival (QA)" });
  await record("Sump pump installation", "paid at the testing checkout, partly refunded", i7.invoice.id, i7.invoice.number, true);

  // 8. Voided.
  const d8 = await draft(a.owner, tomas, [line("Gas line check", "2100.00")]);
  const i8 = await issue(d8.invoice.id, d8.invoice.version, ago(20));
  await voidInvoice(a.owner, i8.invoice.id, { reason: "Raised for the wrong address (QA)" });
  await record("Gas line check", "void", i8.invoice.id, i8.invoice.number, false);

  // 9. A US dollar invoice with tax included in the price.
  const d9 = await createDraft(a.owner, { contactId: tomas, currency: "USD", taxInclusive: true, lines: [line("Remote monitoring set-up", "560.00", { taxPercent: "12" })] });
  const i9 = await issue(d9.invoice.id, d9.invoice.version, ago(2));
  await record("Remote monitoring set-up", "issued in US dollars, tax included", i9.invoice.id, i9.invoice.number, true);

  // 10. Written off.
  const d10 = await draft(a.owner, dario, [line("Seasonal tune-up", "1200.00")]);
  const i10 = await issue(d10.invoice.id, d10.invoice.version, ago(90));
  await writeOffInvoice(a.owner, i10.invoice.id, { reason: "The customer closed their business (QA)" });
  await record("Seasonal tune-up", "written off", i10.invoice.id, i10.invoice.number, true);

  // 11. Paid at the testing checkout, then disputed by the customer's bank.
  const d11 = await draft(a.owner, noel, [line("Pressure valve replacement", "3300.00")]);
  const i11 = await issue(d11.invoice.id, d11.invoice.version, ago(8));
  const started11 = await startCheckout({ orgId, invoiceId: i11.invoice.id, audience: "member", actorUserId: a.owner.user.id, onlyMode: "test" });
  await completeSimulatedCheckout(started11.attemptId, "pay", { origin: TESTING_ORIGIN });
  const paid11 = (await withSystem((db) => db.query<{ id: string }>("select id from customer_payments where invoice_id = $1", [i11.invoice.id]))).rows[0];
  await withSystem((db) => applyDisputeInTx(db, { orgId, paymentId: paid11.id, open: true, actor: { id: null, kind: "provider" } }));
  await record("Pressure valve replacement", "paid, then disputed", i11.invoice.id, i11.invoice.number, true);

  // 12. A payment the provider reported that does not match, kept for a person to look at: counted for nothing.
  const d12 = await draft(a.owner, petra, [line("Radiator bleed", "800.00")]);
  const i12 = await issue(d12.invoice.id, d12.invoice.version, ago(4));
  await withSystem((db) => applyPaymentInTx(db, {
    orgId, invoiceId: i12.invoice.id, amountMinor: 70_000, currency: "PHP", provider: "simulated", verification: "provider_confirmed", connectionId: connection.id, providerPaymentId: "qa-review-1",
    livemode: false, receivedAt: ago(1), status: "needs_review", actor: { id: null, kind: "provider" },
  }));
  await record("Radiator bleed", "a payment kept for review", i12.invoice.id, i12.invoice.number, true);

  // 13 and 14. The Lead Sources report: a fictional live payment (see the top of this file) and a hand-recorded one, with a cost, so verified revenue and a return can be looked at.
  if (opts.revenueFiction !== false) {
    const placeholder = (await withSystem((db) => db.query<{ id: string }>(
      `insert into customer_payment_connections (org_id, provider, mode, public_key, account_label, credentials, supported_currencies, status)
       values ($1, 'paymongo', 'live', $2, 'QA placeholder: no real account', null, '{PHP}', 'disabled') returning id`, [orgId, newPublicKey()],
    ))).rows[0];
    const d13 = await draft(a.owner, mara, [line("Whole-house water filter", "7000.00", { taxPercent: "12" })]);
    const i13 = await issue(d13.invoice.id, d13.invoice.version, ago(3));
    await withSystem((db) => applyPaymentInTx(db, {
      orgId, invoiceId: i13.invoice.id, amountMinor: 784_000, currency: "PHP", provider: "paymongo", verification: "provider_confirmed", connectionId: placeholder.id, providerPaymentId: "qa-fiction-live-1",
      livemode: true, method: "card", receivedAt: ago(2), actor: { id: null, kind: "provider" },
    }));
    await record("Whole-house water filter", "paid by a FICTIONAL live payment (counts as verified revenue in the QA report)", i13.invoice.id, i13.invoice.number, true);
    const d14 = await draft(a.owner, tomas, [line("Sprinkler repair", "1500.00")]);
    const i14 = await issue(d14.invoice.id, d14.invoice.version, ago(3));
    await recordManualPayment(a.owner, i14.invoice.id, { amount: "1500.00", receivedOn: day(-2), method: "e_wallet", evidence: "E-wallet screenshot QA-2210 (made up)" }, { now: ago(2) });
    await record("Sprinkler repair", "paid by hand (shown apart in the report)", i14.invoice.id, i14.invoice.number, true);
    await addCost(a.ownerActor, { source: "google", periodStart: day(-1), periodEnd: day(-1), amount: 1500, currency: "PHP", note: "Search ads (QA)" });
  }
  return rows;
}
