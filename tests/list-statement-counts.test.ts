// An N+1 is a list screen that asks the database one more question for every row it shows. It does not show up as a wrong answer, only as a page that gets slower the more a
// business uses it. These tests count the statements a list sends with a few rows and again with many, and require the same number. They cover the Phase 5 lists that had no
// scale check: customer invoices (the list and the receivables summary) and proposals.
import { beforeAll, describe, expect, it } from "vitest";
import { listInvoices, receivablesSummary } from "@/server/invoices/invoices";
import { listProposals } from "@/server/proposals/proposals";
import { capture } from "./perf/harness";
import { invoiceOrg, issuedInvoice, type InvoiceOrg } from "./support/invoices";
import { approvedProposal, proposalOrg, type ProposalOrg } from "./support/proposals";

const FEW = 3;
const MANY = 24;

describe("customer invoice lists send the same statements however many invoices there are", () => {
  let io: InvoiceOrg;
  beforeAll(async () => {
    io = await invoiceOrg({ name: "Statement count invoices" });
  }, 120_000);

  it("listInvoices and receivablesSummary", async () => {
    for (let i = 0; i < FEW; i++) await issuedInvoice(io);
    const ctx = io.ctx("owner");
    const few = {
      list: await capture(() => listInvoices(ctx)),
      summary: await capture(() => receivablesSummary(ctx)),
    };
    expect(few.list.result.length).toBe(FEW);
    for (let i = FEW; i < MANY; i++) await issuedInvoice(io);
    const many = {
      list: await capture(() => listInvoices(ctx)),
      summary: await capture(() => receivablesSummary(ctx)),
    };
    expect(many.list.result.length).toBeGreaterThanOrEqual(MANY);
    expect(many.list.queries.length, "listInvoices statements").toBe(few.list.queries.length);
    expect(many.summary.queries.length, "receivablesSummary statements").toBe(few.summary.queries.length);
    // A list is bounded by a LIMIT whatever the data: no statement may ask for more than a page of invoice rows.
    expect(Math.max(...many.list.queries.map((q) => q.rows))).toBeLessThanOrEqual(500);
  }, 180_000);
});

describe("the proposal list sends the same statements however many proposals there are", () => {
  let p: ProposalOrg;
  beforeAll(async () => {
    p = await proposalOrg();
  }, 120_000);

  it("listProposals", async () => {
    for (let i = 0; i < FEW; i++) await approvedProposal(p);
    const few = await capture(() => listProposals(p.actor("owner")));
    for (let i = FEW; i < MANY; i++) await approvedProposal(p);
    const many = await capture(() => listProposals(p.actor("owner")));
    expect(many.result.length).toBeGreaterThan(few.result.length);
    expect(many.queries.length, "listProposals statements").toBe(few.queries.length);
  }, 180_000);
});
