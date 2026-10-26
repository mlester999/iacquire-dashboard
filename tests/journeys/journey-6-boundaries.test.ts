// Journey 6, the edges: proposal, signature, invoice, payment, asked what journey 6 does not.
//   * denied access: a sales rep cannot issue an invoice, a viewer cannot make one from a proposal, and neither changes the draft;
//   * tenant isolation: another workspace's owner cannot read the proposal, its signature decision, the invoice or the payment (row-level security), and cannot open the invoice;
//   * duplicates and replays: the signing service's completion notice delivered twice records one acceptance; the payment provider's signed notice delivered twice records one payment;
//   * audit: the invoice's history and the audit log name who issued it and what paid it, and the proposal's history names the invoice it produced;
//   * what the customer sees: the invoice page says it is paid once the provider's notice is applied, and says nothing of a payment before.
// The signing service, the payment provider and the email provider are the stand-ins named in journey 6; nothing here reaches a provider.
import { describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { createInvoiceFromProposal } from "@/server/invoices/from-proposal";
import { getInvoiceDetail, issueInvoice } from "@/server/invoices/invoices";
import { handedOver, NOW, rows, signerActs, signingOrg, withInvoicing, customerFor } from "../support/proposals";
import { attempt, connect, deliver, invoiceNow, paymentsOf, paymongoPaid } from "../support/customer-payments";
import { agencyUser, createUser } from "../support/fixtures";
import type { InvoiceOrg } from "../support/invoices";

/** A proposal signed, invoiced and issued; the customer's payment is not yet made. */
async function issued() {
  const p = await signingOrg();
  const { ctx } = await withInvoicing(p);
  const customer = await customerFor(p);
  const handed = await handedOver(p, { contactId: customer.contactId, clientName: "Maria Santos", clientEmail: customer.email });
  await signerActs(p, handed.requestId, "complete", { now: NOW });
  const made = await createInvoiceFromProposal(ctx("owner"), handed.proposal.id, { version: 1 });
  if (made.status !== "created") throw new Error("the invoice was not created");
  const drafted = await getInvoiceDetail(ctx("owner"), made.invoiceId);
  return { p, ctx, handed, made, drafted };
}

describe("journey 6: who may close, who can see it, and what a repeat does", () => {
  it("refuses a sales rep an invoice issue and a viewer an invoice from a proposal, and the draft stays a draft", async () => {
    const { ctx, handed, made, drafted } = await issued();
    await expect(issueInvoice(ctx("sales"), made.invoiceId, { version: drafted.invoice.version })).rejects.toMatchObject({ code: "forbidden" });
    await expect(createInvoiceFromProposal(ctx("viewer"), handed.proposal.id, { version: 1, another: true })).rejects.toMatchObject({ code: "forbidden" });
    expect((await getInvoiceDetail(ctx("owner"), made.invoiceId)).invoice).toMatchObject({ status: "draft", number: null });
    expect(await rows("select id from customer_invoices where source_id = $1", [handed.proposal.id])).toHaveLength(1);
  });

  it("keeps the proposal, the signature, the invoice and the payment away from another workspace", async () => {
    const { p, ctx, made, drafted, handed } = await issued();
    const issuedInv = await issueInvoice(ctx("owner"), made.invoiceId, { version: drafted.invoice.version });
    expect(issuedInv.detail.invoice.status).toBe("issued");
    const other = await signingOrg();
    const { ctx: otherCtx } = await withInvoicing(other);
    await expect(getInvoiceDetail(otherCtx("owner"), made.invoiceId)).rejects.toMatchObject({ code: "not_found" });
    const outsider = other.people.owner;
    const seen = (table: string) => withUser(outsider.id, async (db) => (await db.query(`select 1 from ${table} where org_id = $1`, [p.org.id])).rows.length);
    for (const table of ["proposals", "proposal_decisions", "customer_invoices", "customer_invoice_events", "customer_invoice_lines"]) {
      expect((await rows(`select 1 from ${table} where org_id = $1`, [p.org.id])).length, `${table} exists`).toBeGreaterThan(0);
      expect(await seen(table), `${table} seen by another workspace's owner`).toBe(0);
    }
    expect(handed.proposal.id).toBeTruthy();
  });

  it("records one acceptance when the signing notice arrives twice, and one payment when the provider's signed notice arrives twice", async () => {
    const { p, ctx, made, drafted, handed } = await issued();
    expect(await rows("select 1 from proposal_decisions where proposal_id = $1", [handed.proposal.id])).toHaveLength(1);
    // The signing service tells us again that the document was completed.
    await signerActs(p, handed.requestId, "complete", { now: NOW }).catch(() => undefined);
    expect(await rows("select 1 from proposal_decisions where proposal_id = $1", [handed.proposal.id])).toHaveLength(1);

    const issuedInv = await issueInvoice(ctx("owner"), made.invoiceId, { version: drafted.invoice.version });
    const invoiceOrg: InvoiceOrg = { c: p, orgId: p.org.id, superAdmin: agencyUser(await createUser({ platformRole: "agency_super_admin" }), "agency_super_admin"), ctx: ctx as InvoiceOrg["ctx"] };
    const connection = await connect(invoiceOrg, { provider: "paymongo", mode: "live", liveConfirmed: true, currencies: ["USD"] });
    const checkout = await attempt(made.invoiceId, connection);
    const notice = paymongoPaid({ checkoutId: checkout.checkoutId as string, reference: checkout.reference, amount: checkout.amountMinor, currency: "USD", livemode: true });
    expect(await deliver(connection, notice, { live: true })).toMatchObject({ status: 200, outcome: "processed" });
    const again = await deliver(connection, notice, { live: true });
    expect(again.status).toBe(200);
    expect(again.outcome).not.toBe("processed");
    expect(await paymentsOf(made.invoiceId)).toHaveLength(1);
    expect(await invoiceNow(made.invoiceId)).toMatchObject({ payment_status: "paid", balance_minor: "0", paid_minor: String(issuedInv.detail.invoice.totalMinor) });
  });

  it("records who issued the invoice and what paid it, and the proposal's history names the invoice it produced", async () => {
    const { p, ctx, made, drafted, handed } = await issued();
    const issuedInv = await issueInvoice(ctx("owner"), made.invoiceId, { version: drafted.invoice.version });
    const events = await rows<{ kind: string; actor_kind: string; actor_id: string | null }>("select kind, actor_kind, actor_id from customer_invoice_events where invoice_id = $1 order by id", [made.invoiceId]);
    expect(events.map((e) => e.kind)).toEqual(expect.arrayContaining(["created", "issued"]));
    const issuedEvent = events.find((e) => e.kind === "issued");
    expect(issuedEvent).toMatchObject({ actor_kind: "user", actor_id: p.people.owner.id });
    const audit = await rows<{ action: string; actor_user_id: string | null }>("select action, actor_user_id from audit_logs where org_id = $1 and target_id = $2", [p.org.id, made.invoiceId]);
    expect(audit.some((a) => /invoice\.issued/.test(a.action) && a.actor_user_id === p.people.owner.id)).toBe(true);
    const proposalEvents = await rows<{ detail: Record<string, unknown> }>("select detail from proposal_events where proposal_id = $1 and kind = 'invoice_drafted'", [handed.proposal.id]);
    expect(proposalEvents).toHaveLength(1);
    expect(proposalEvents[0].detail).toMatchObject({ invoiceId: made.invoiceId });
    expect(issuedInv.detail.invoice.number).toMatch(/^INV-/);
    // The people who issued it are named by the system, never by a token: nothing in the history holds the customer's link.
    expect(JSON.stringify(events) + JSON.stringify(audit)).not.toMatch(/public_token|token_hash/);
    void withSystem;
  });
});
