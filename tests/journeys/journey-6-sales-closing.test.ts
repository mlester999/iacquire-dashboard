// Journey 6: a proposal is closed, signed, invoiced and paid, across the proposals, signing, invoicing and customer-payment services.
//
// A proposal is written, approved and sent. The customer accepts it by signing through the signing service. An invoice is drafted from the accepted version and
// issued. The customer pays it online, the payment provider's signed notice arrives at the webhook, the invoice is settled, and the Lead Sources report counts the
// money as verified revenue. Asking for an invoice from the same proposal version again returns the one that exists instead of making a second one.
//
// Three external boundaries are simulated and only here:
//   * the e-signature provider: src/server/esign/providers/simulated.ts, wired by tests/support/proposals.ts (signingOrg, handedOver, signerActs). The signature is
//     labelled simulated everywhere it is stored, and no signing service is contacted;
//   * the payment provider: a PayMongo delivery written by hand in tests/support/customer-payments.ts (paymongoPaid) and signed with the connection's made-up
//     webhook secret, handed to the real webhook handler. The checkout attempt is the row startCheckout would have left once the provider answered, not a call to
//     PayMongo (the module also replaces fetch, so an accidental provider call fails the test);
//   * the email provider: the proposal's own email (the message carrying the customer's link) goes through the capture provider (tests never configure Resend),
//     which stores it in email_outbox and marks it captured. Nothing here sends an email or a text message to a real address.
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { attributionReport } from "@/server/attribution/report";
import { recordTouch } from "@/server/attribution/touches";
import { createInvoiceFromProposal } from "@/server/invoices/from-proposal";
import { getInvoiceDetail, issueInvoice } from "@/server/invoices/invoices";
import { handedOver, NOW, rows, signerActs, signingOrg, withInvoicing } from "../support/proposals";
import { customerFor } from "../support/proposals";
import { attempt, connect, deliver, invoiceNow, paymentsOf, paymongoPaid } from "../support/customer-payments";
import { agencyUser, createUser } from "../support/fixtures";
import type { InvoiceOrg } from "../support/invoices";

const DAY = 86_400_000;
/** The report period the lead and its revenue are read in. The lead is created on the real clock, so the period is too; the payment's own date is what keeps
 *  "received on or before the report was made" deterministic. */
const REPORT = () => ({ startsAt: new Date(Date.now() - DAY), endsAt: new Date(Date.now() + DAY), asOf: new Date(Date.now() + 3_600_000) });

const proposalRow = async (id: string) => (await rows<{ status: string; version: number; signature_state: string; closed_at: Date | null }>(
  "select status, version, signature_state, closed_at from proposals where id = $1", [id],
))[0];

describe("a signed proposal becomes verified revenue", () => {
  it("goes from an accepted signature, through one issued invoice, to a live payment counted as verified revenue, and cannot be invoiced twice", async () => {
    // 1. The workspace has proposals, invoicing and signing switched on, with the stand-in signing service connected. The customer is on the proposal, because an
    // invoice made from it belongs to that customer in the CRM.
    const p = await signingOrg();
    const { ctx } = await withInvoicing(p);
    const customer = await customerFor(p);

    // 2. The proposal asks for a signature; it is written, approved, sent, and handed to the signing service, which holds a document for the signer.
    const handed = await handedOver(p, { contactId: customer.contactId, clientName: "Maria Santos", clientEmail: customer.email });
    expect(handed.documentId).toBeTruthy();
    expect((await proposalRow(handed.proposal.id)).status).toBe("sent");

    // 3. The customer signs. The service's notice is verified and applied by the product's own webhook path, which records the answer as the customer's acceptance
    // of version 1 and labels it as coming from a signing service.
    expect((await signerActs(p, handed.requestId, "complete", { now: NOW })).status).toBe(200);
    expect(await proposalRow(handed.proposal.id)).toMatchObject({ status: "accepted", signature_state: "completed", version: 1 });
    const [decision] = await rows<{ decision: string; method: string; version: number; signature_request_id: string }>(
      "select decision, method, version, signature_request_id from proposal_decisions where proposal_id = $1", [handed.proposal.id],
    );
    expect(decision).toMatchObject({ decision: "accepted", method: "provider_signature", version: 1, signature_request_id: handed.requestId });

    // 4. The invoice is drafted from the accepted version and issued. It copies only the one-time lines the customer pays once; it is issued by the owner before
    // money can be taken for it.
    const made = await createInvoiceFromProposal(ctx("owner"), handed.proposal.id, { version: 1 });
    expect(made.status).toBe("created");
    if (made.status !== "created") throw new Error("the invoice was not created");
    const drafted = await getInvoiceDetail(ctx("owner"), made.invoiceId);
    expect(drafted.invoice).toMatchObject({ status: "draft", createdVia: "proposal", sourceProposalId: handed.proposal.id, sourceProposalVersion: 1 });
    expect(drafted.invoice.currency).toBe("USD");
    const issued = await issueInvoice(ctx("owner"), made.invoiceId, { version: drafted.invoice.version });
    expect(issued.detail.invoice).toMatchObject({ status: "issued", number: expect.stringMatching(/^INV-/) });
    expect(issued.detail.invoice.paymentStatus).toBe("unpaid");

    // 5. The customer pays online. The connection is a live PayMongo account (this is a real invoice, not a test one), the attempt is what the checkout left behind,
    // and the provider's notice is signed the way PayMongo signs one. It goes through the real webhook handler.
    // The customer payment fixtures take an invoice world; this journey's own context helper has the same shape but a narrower `who` union (it does not offer "member"),
    // which is all the fixtures ask of it, so it is handed over as-is.
    const invoiceOrg: InvoiceOrg = { c: p, orgId: p.org.id, superAdmin: agencyUser(await createUser({ platformRole: "agency_super_admin" }), "agency_super_admin"), ctx: ctx as InvoiceOrg["ctx"] };
    const connection = await connect(invoiceOrg, { provider: "paymongo", mode: "live", liveConfirmed: true, currencies: ["USD"] });
    const checkout = await attempt(made.invoiceId, connection);
    expect(checkout.amountMinor).toBe(issued.detail.invoice.totalMinor);
    const paid = await deliver(
      connection,
      paymongoPaid({ checkoutId: checkout.checkoutId as string, reference: checkout.reference, amount: checkout.amountMinor, currency: "USD", livemode: true }),
      { live: true },
    );
    expect(paid).toMatchObject({ status: 200, outcome: "processed" });

    // 6. The invoice is settled for its exact balance, and the payment says who vouched for it: the provider, in live mode. A payment recorded by hand would say
    // "manual" and would never count as revenue by itself.
    expect(await invoiceNow(made.invoiceId)).toMatchObject({ payment_status: "paid", paid_minor: String(checkout.amountMinor), balance_minor: "0" });
    expect(await paymentsOf(made.invoiceId)).toEqual([
      expect.objectContaining({ status: "succeeded", amount_minor: String(checkout.amountMinor), livemode: true, verification: "provider_confirmed" }),
    ]);

    // 7. The money is verified revenue on the Lead Sources report: the customer is a lead of one source, and the invoice on their record paid in live mode. Revenue
    // is what was kept without the owner's tax, so the figure is the total less the tax, in the invoice's own currency.
    await withSystem((db) => recordTouch(db, { orgId: p.org.id, contactId: customer.contactId, facts: { kind: "website_form", attribution: { utm_source: "referral" } } }));
    const report = await attributionReport(p.actor("owner"), REPORT());
    const source = report.rows.find((r) => r.source === "referral");
    expect(source).toBeTruthy();
    expect(source?.verifiedRevenue).toEqual([{ currency: "USD", amount: (issued.detail.invoice.totalMinor - issued.detail.invoice.taxMinor) / 100, minor: String(issued.detail.invoice.totalMinor - issued.detail.invoice.taxMinor) }]);
    expect(report.revenue).toMatchObject({ state: "shown", workspaceHasPayments: true, manualCounted: false });
    expect(report.notes.join(" ")).toMatch(/Verified revenue is money your payment provider confirmed in live mode/);

    // 8. The proposal cannot be turned into a second invoice by asking again: the plain repeat returns the invoice that exists, and only one row is ever made for
    // this version. A sales rep asking for a further one is refused, because a further invoice from the same version is an approver's deliberate act.
    const again = await createInvoiceFromProposal(ctx("owner"), handed.proposal.id, { version: 1 });
    expect(again).toEqual({ status: "already", invoiceId: made.invoiceId, count: 1 });
    await expect(createInvoiceFromProposal(ctx("sales"), handed.proposal.id, { version: 1, another: true })).rejects.toMatchObject({ code: "forbidden" });
    expect(await rows("select id from customer_invoices where org_id = $1 and source_type = 'proposal' and source_id = $2", [p.org.id, handed.proposal.id])).toHaveLength(1);
    // The proposal's own history names the one invoice, so the two records still point at each other.
    const draftedEvents = await rows<{ detail: Record<string, unknown> }>("select detail from proposal_events where proposal_id = $1 and kind = 'invoice_drafted'", [handed.proposal.id]);
    expect(draftedEvents).toHaveLength(1);
    expect(draftedEvents[0].detail).toMatchObject({ invoiceId: made.invoiceId });
  });

  it("makes no invoice until the customer's signature is applied", async () => {
    // A sent proposal is not an accepted one. The signature is the acceptance, so nothing can be invoiced while it waits at the signing service; once the notice is
    // applied the same request succeeds. This keeps "invoice from the accepted version" from becoming "invoice from whatever was sent".
    const p = await signingOrg();
    const { ctx } = await withInvoicing(p);
    const customer = await customerFor(p);
    const handed = await handedOver(p, { contactId: customer.contactId, clientName: "Maria Santos", clientEmail: customer.email });

    await expect(createInvoiceFromProposal(ctx("owner"), handed.proposal.id, { version: 1 })).rejects.toMatchObject({ code: "conflict" });
    expect(await rows("select id from customer_invoices where org_id = $1 and source_id = $2", [p.org.id, handed.proposal.id])).toHaveLength(0);

    await signerActs(p, handed.requestId, "complete", { now: NOW });
    const made = await createInvoiceFromProposal(ctx("owner"), handed.proposal.id, { version: 1 });
    expect(made.status).toBe("created");
    expect(await rows("select id from customer_invoices where org_id = $1 and source_id = $2", [p.org.id, handed.proposal.id])).toHaveLength(1);
  });
});
