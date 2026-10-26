// Making a draft invoice from an accepted proposal, on embedded Postgres: what is copied (the one-time lines of the version that was accepted, at its exact figures), what is left
// for the owner (the monthly and yearly lines), how the two records point at each other, that nothing is issued, sent or closed, that a repeat or a double click makes one draft, who may
// do it, and that one workspace can never reach another's proposal. No provider is involved.
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { createContact } from "@/server/crm/contacts";
import { createOpportunity } from "@/server/crm/opportunities";
import { redactContact } from "@/server/messaging/contacts";
import { describeEvent } from "@/lib/proposals/activity";
import { eventSentence } from "@/lib/invoices/labels";
import { createInvoiceFromProposal, invoicingForProposal, MAX_INVOICES_PER_PROPOSAL_VERSION } from "@/server/invoices/from-proposal";
import { discardDraft, getInvoiceDetail, issueInvoice } from "@/server/invoices/invoices";
import { getInvoiceSettings, saveInvoiceSettings } from "@/server/invoices/settings";
import { createCatalogItem, createTaxRate } from "@/server/proposals/catalog";
import { decideProposal, recordOfflineDecision, sendProposal, submitForApproval } from "@/server/proposals/proposals";
import { acceptedProposal, approvedProposal, draftBy, handedOver, lineOf, NOW, proposalOrg, rows, sentWithLink, setFeature, signerActs, signingOrg, withInvoicing, type ProposalOrg } from "./support/proposals";
import { uniqueEmail } from "./support/invoices";

interface World {
  p: ProposalOrg;
  ctx: Awaited<ReturnType<typeof withInvoicing>>["ctx"];
}

async function world(opts: { timezone?: string } = {}): Promise<World> {
  const p = await proposalOrg({ timezone: opts.timezone });
  const { ctx } = await withInvoicing(p, { timezone: opts.timezone });
  return { p, ctx };
}

const priceBookItem = (p: ProposalOrg, over: { name: string; unitPriceMinor: number; billing?: "one_time" | "monthly" | "yearly"; currency?: string; taxRateId?: string | null; description?: string }) =>
  createCatalogItem(p.actor("owner"), { unitLabel: "each", currency: "USD", taxRateId: null, ...over });

const invoiceRows = (orgId: string, proposalId: string) =>
  rows<{ id: string; status: string; created_via: string; source_type: string | null; source_id: string | null; source_version: number | null; total_minor: string; subtotal_minor: string; tax_minor: string; number: string | null; closes_deal: boolean; idempotency_key: string | null; currency: string; opportunity_id: string | null; contact_id: string | null }>(
    "select id, status, created_via, source_type, source_id, source_version, total_minor::text, subtotal_minor::text, tax_minor::text, number, closes_deal, idempotency_key, currency, opportunity_id, contact_id from customer_invoices where org_id = $1 and source_id = $2 order by created_at, id",
    [orgId, proposalId],
  );
const proposalEvents = (id: string) => rows<{ kind: string; version: number | null; detail: Record<string, unknown>; actor_kind: string }>("select kind, version, detail, actor_kind from proposal_events where proposal_id = $1 order by id", [id]);
const oneTimeTotal = async (id: string) => Number((await rows<{ t: string }>("select one_time_total_minor::text as t from proposals where id = $1", [id]))[0].t);
const messageCount = async (orgId: string) => Number((await rows<{ n: string }>("select count(*)::text as n from conversation_messages where org_id = $1", [orgId]))[0].n);

/** A proposal with a one-time line taxed at 12%, a discounted one-time line, a monthly line and a yearly line, accepted by the customer online. */
async function mixedProposal(w: World, how: "online" | "recorded" = "online", over: Parameters<typeof acceptedProposal>[1] = {}) {
  const build = await priceBookItem(w.p, { name: "Website build", unitPriceMinor: 150_000, taxRateId: w.p.tax.id, description: "Design and build of a five page website." });
  const photos = await priceBookItem(w.p, { name: "Photography day", unitPriceMinor: 33_333 });
  const hosting = await priceBookItem(w.p, { name: "Hosting", unitPriceMinor: 9_900, billing: "monthly", taxRateId: w.p.tax.id });
  const domain = await priceBookItem(w.p, { name: "Domain", unitPriceMinor: 2_000, billing: "yearly" });
  const doc = { lines: [lineOf(build), lineOf(photos, 3000, { discount: { kind: "percent" as const, bps: 1000 } }), lineOf(hosting), lineOf(domain)], terms: "Payment is due within 14 days." };
  // The owner writes it: a team member may not give a discount.
  const accepted = await acceptedProposal(w.p, { doc, ...over }, how, { author: "owner" });
  return { ...accepted, id: accepted.proposal.id };
}

describe("making a draft invoice from an accepted proposal", () => {
  it("copies the lines the customer pays once at the accepted version's exact figures, and leaves the monthly and yearly lines for the owner", async () => {
    const w = await world();
    const a = await mixedProposal(w);
    const total = await oneTimeTotal(a.id);
    expect(total).toBeGreaterThan(0);

    const made = await createInvoiceFromProposal(w.ctx("owner"), a.id, { version: 1 });
    expect(made).toMatchObject({ status: "created", lines: 2, recurringLines: 2 });
    if (made.status !== "created") throw new Error("not created");

    const detail = await getInvoiceDetail(w.ctx("owner"), made.invoiceId);
    const i = detail.invoice;
    expect(i).toMatchObject({ status: "draft", number: null, currency: "USD", createdVia: "proposal", sourceProposalId: a.id, sourceProposalVersion: 1, closesDeal: false, taxInclusive: false });
    // Exactly the proposal's one-time total, down to the minor unit; 3 x 333.33 less 10% and 12% tax on the first line, each rounded once.
    expect(i.totalMinor).toBe(total);
    expect(i.subtotalMinor + i.taxMinor).toBe(i.totalMinor);
    expect(i.taxMinor).toBe(18_000);
    expect(detail.lines.map((l) => ({ d: l.description, q: l.quantity, u: l.unitPriceMinor, t: l.taxRateBps }))).toEqual([
      { d: "Website build - Design and build of a five page website.", q: "1", u: 150_000, t: 1200 },
      { d: "Photography day", q: "3", u: 33_333, t: null },
    ]);
    expect(detail.lines[1].discountBps).toBe(1000);
    expect(detail.lines[1].totalMinor).toBe(89_999);
    expect(detail.source).toMatchObject({ proposalId: a.id, proposalVersion: 1, proposalNumber: expect.stringMatching(/^P-/) });
    expect(detail.source?.recurring).toEqual([{ name: "Hosting", billing: "monthly", totalMinor: 11_088 }, { name: "Domain", billing: "yearly", totalMinor: 2_000 }]);
    expect(detail.source?.recurringCount).toBe(2);

    // Both records point at each other.
    const [row] = await invoiceRows(w.p.org.id, a.id);
    expect(row).toMatchObject({ id: made.invoiceId, source_type: "proposal", source_id: a.id, source_version: 1, created_via: "proposal", idempotency_key: `proposal-invoice:${a.id}:1` });
    const events = await proposalEvents(a.id);
    const line = events.find((e) => e.kind === "invoice_drafted");
    expect(line).toMatchObject({ version: 1, actor_kind: "user", detail: { invoiceId: made.invoiceId, lines: 2, recurringLines: 2, basis: "acknowledged_online" } });
    expect(describeEvent({ kind: "invoice_drafted", detail: line?.detail ?? {}, actorName: "Owner Person", actorKind: "user", version: 1 }).text).toMatch(/made a draft invoice from this proposal.*2 lines the customer pays once were copied, and 2 monthly or yearly lines were left for them to decide.*nothing was issued or sent/);
    expect(eventSentence("created", detail.events[0].detail)).toMatch(/^Draft made from proposal P-\d+ \(version 1\): 2 lines the customer pays once were copied\. 2 monthly or yearly lines were not copied\.$/);
  });

  it("is only a draft: nothing is issued, sent, reminded about, charged or closed, and the proposal and its deal are left as they were", async () => {
    const w = await world();
    const customer = await createContact(w.p.actor("owner"), { firstName: "Maria", lastName: "Santos", email: uniqueEmail(), phone: null });
    const deal = await createOpportunity(w.p.actor("owner"), { name: "Website for Maria", contactId: customer.id, value: 1500 });
    const a = await mixedProposal(w, "online", { contactId: customer.id, opportunityId: deal.id, clientName: "Maria Santos" });
    const before = await rows<{ status: string; closed_at: Date | null }>("select status, closed_at from crm_opportunities where id = $1", [deal.id]);
    const proposalBefore = await rows<{ status: string; version: number; sent_version: number; closed_at: Date | null }>("select status, version, sent_version, closed_at from proposals where id = $1", [a.id]);
    const messagesBefore = await messageCount(w.p.org.id);

    const made = await createInvoiceFromProposal(w.ctx("owner"), a.id, { version: 1 });
    if (made.status !== "created") throw new Error("not created");

    const [inv] = await invoiceRows(w.p.org.id, a.id);
    // The customer and the deal are the proposal's; the invoice never closes the deal by itself.
    expect(inv).toMatchObject({ status: "draft", number: null, closes_deal: false, contact_id: customer.id, opportunity_id: deal.id });
    expect(await rows("select status, closed_at from crm_opportunities where id = $1", [deal.id])).toEqual(before);
    expect(await rows("select status, version, sent_version, closed_at from proposals where id = $1", [a.id])).toEqual(proposalBefore);
    expect(await messageCount(w.p.org.id)).toBe(messagesBefore);
    for (const t of ["customer_invoice_deliveries", "customer_invoice_reminders", "customer_payments", "customer_payment_attempts", "customer_refunds"]) {
      expect(Number((await rows<{ n: string }>(`select count(*)::text as n from ${t} where org_id = $1`, [w.p.org.id]))[0].n)).toBe(0);
    }
    const kinds = (await rows<{ kind: string }>("select kind from customer_invoice_events where invoice_id = $1 order by id", [made.invoiceId])).map((e) => e.kind);
    expect(kinds).toEqual(["created"]);
  });

  it("keeps the figures exact in every currency, including one with no minor unit, whatever the rounding does", async () => {
    for (const [currency, unit, qty] of [["JPY", 1_333, 3000], ["PHP", 33_333, 3000], ["USD", 33_333, 7000], ["EUR", 1, 1000]] as const) {
      const w = await world();
      const tax = await createTaxRate(w.p.actor("owner"), { name: "Local tax", rateBps: 1250 });
      const item = await priceBookItem(w.p, { name: `Work in ${currency}`, unitPriceMinor: unit, currency, taxRateId: tax.id });
      const a = await acceptedProposal(w.p, { currency, doc: { lines: [lineOf(item, qty), lineOf(item, 1500)] } }, "recorded");
      const made = await createInvoiceFromProposal(w.ctx("owner"), a.proposal.id, { version: 1 });
      if (made.status !== "created") throw new Error(`not created in ${currency}`);
      const [inv] = await invoiceRows(w.p.org.id, a.proposal.id);
      expect(inv.currency).toBe(currency);
      expect(Number(inv.total_minor)).toBe(await oneTimeTotal(a.proposal.id));
      expect(Number(inv.subtotal_minor) + Number(inv.tax_minor)).toBe(Number(inv.total_minor));
    }
  });

  it("says how the proposal was accepted, in the person's own words when a person recorded it, and refuses a signature that was never recorded", async () => {
    const w = await world();
    const online = await mixedProposal(w, "online");
    const recorded = await mixedProposal(w, "recorded");
    const o = await invoicingForProposal(w.ctx("owner"), online.id);
    const r = await invoicingForProposal(w.ctx("owner"), recorded.id);
    expect(o.preview?.basis).toMatchObject({ code: "acknowledged_online", text: "The customer accepted online with a verified email address." });
    expect(r.preview?.basis).toMatchObject({ code: "answer_recorded_by_person" });
    expect(r.preview?.basis?.text).toMatch(/A person on your team recorded that the customer accepted\. The customer did not verify it\./);
    // A proposal that asked for a signature and was recorded as signed outside the product counts only because its record says so, and says it was not verified.
    // (No signing service is connected here, so the paper copy is recorded as signed straight from approval.)
    const sig = await approvedProposal(w.p, { requiresSignature: true, doc: { lines: [lineOf(w.p.item)] } });
    await recordOfflineDecision(w.p.actor("owner"), sig.id, { decision: "accepted", version: 1 }, { now: NOW });
    const s = await invoicingForProposal(w.ctx("owner"), sig.id);
    expect(s.preview?.basis).toMatchObject({ code: "signing_recorded_offline" });
    expect(s.preview?.basis?.text).toMatch(/A signing service did not verify it/);
    expect(await createInvoiceFromProposal(w.ctx("owner"), sig.id, { version: 1 })).toMatchObject({ status: "created" });
    const events = await proposalEvents(sig.id);
    expect(events.find((e) => e.kind === "invoice_drafted")?.detail).toMatchObject({ basis: "signing_recorded_offline" });
  });

  it("counts a signature a signing service reported, and nothing else, as signed", async () => {
    const p = await signingOrg();
    const { ctx } = await withInvoicing(p);
    const h = await handedOver(p, { doc: { lines: [lineOf(p.item)] } });
    // Out for signing is not accepted.
    await expect(createInvoiceFromProposal(ctx("owner"), h.proposal.id, { version: 1 })).rejects.toMatchObject({ code: "conflict", message: "Only an accepted proposal can be invoiced." });
    const answered = await signerActs(p, h.requestId, "complete");
    expect(answered.status).toBeLessThan(300);
    const made = await invoicingForProposal(ctx("owner"), h.proposal.id);
    expect(made.preview?.basis).toMatchObject({ code: "signed_through_service" });
    expect(await createInvoiceFromProposal(ctx("owner"), h.proposal.id, { version: 1 })).toMatchObject({ status: "created", lines: 1 });
  });

  it("leaves a long list of monthly lines on the invoice's first line of history in full as far as it fits, and counts all of them", async () => {
    const w = await world();
    const once = await priceBookItem(w.p, { name: "Set-up", unitPriceMinor: 50_000 });
    const lines = [lineOf(once)];
    for (let n = 0; n < 12; n += 1) lines.push(lineOf(await priceBookItem(w.p, { name: `Monthly service number ${n} ${"x".repeat(80)}`, unitPriceMinor: 1_000 + n, billing: "monthly" })));
    const a = await acceptedProposal(w.p, { doc: { lines } }, "recorded");
    const made = await createInvoiceFromProposal(w.ctx("owner"), a.proposal.id, { version: 1 });
    if (made.status !== "created") throw new Error("not created");
    expect(made.recurringLines).toBe(12);
    const detail = await getInvoiceDetail(w.ctx("owner"), made.invoiceId);
    expect(detail.source?.recurringCount).toBe(12);
    expect(detail.source?.recurring.length).toBe(8);
    expect(detail.source?.recurring[0].name.length).toBeLessThanOrEqual(50);
  });
});

describe("what is refused, and that nothing is left behind", () => {
  const refusals = async (w: World, id: string, version = 1) => {
    await expect(createInvoiceFromProposal(w.ctx("owner"), id, { version })).rejects.toMatchObject({ code: "conflict" });
    expect(await invoiceRows(w.p.org.id, id)).toEqual([]);
    expect((await proposalEvents(id)).some((e) => e.kind === "invoice_drafted")).toBe(false);
  };

  it("refuses a proposal that is a draft, waiting for approval, approved, sent, declined or withdrawn", async () => {
    const w = await world();
    const draft = await draftBy(w.p, "member");
    await refusals(w, draft.id);
    const pending = await submitForApproval(w.p.member, draft.id, {});
    await refusals(w, pending.id);
    const approved = await decideProposal(w.p.actor("manager"), pending.id, { decision: "approve", version: pending.version }, {});
    await refusals(w, approved.id);
    const sent = await sendProposal(w.p.actor("sales"), approved.id, {}, { now: NOW });
    await refusals(w, sent.id);
    // Another proposal, answered "declined" by a person.
    const other = await sentWithLink(w.p, {}, { now: NOW });
    await recordOfflineDecision(w.p.actor("owner"), other.proposal.id, { decision: "declined", version: 1 }, { now: NOW });
    await refusals(w, other.proposal.id);
    // Only a proposal that was accepted is invoiced.
    const accepted = await acceptedProposal(w.p, {}, "recorded");
    expect(await createInvoiceFromProposal(w.ctx("owner"), accepted.proposal.id, { version: 1 })).toMatchObject({ status: "created" });
  });

  it("refuses a proposal marked accepted with no recorded answer for the version that went out, and one the person was looking at an older version of", async () => {
    const w = await world();
    const a = await acceptedProposal(w.p, {}, "recorded");
    await expect(createInvoiceFromProposal(w.ctx("owner"), a.proposal.id, { version: 2 })).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("The proposal changed") });
    await expect(createInvoiceFromProposal(w.ctx("owner"), a.proposal.id, { version: 0 })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(createInvoiceFromProposal(w.ctx("owner"), a.proposal.id, { version: 1.5 })).rejects.toMatchObject({ code: "invalid_input" });
    // The answer is taken away behind the product's back (the database allows it only for a purge): the proposal still says accepted, but nothing backs it, so nothing is made.
    await withSystem(async (db) => {
      await db.query("select set_config('iaq.purge', 'on', true)");
      await db.query("delete from proposal_decisions where proposal_id = $1", [a.proposal.id]);
    });
    await expect(createInvoiceFromProposal(w.ctx("owner"), a.proposal.id, { version: 1 })).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("no recorded answer") });
    expect(await invoiceRows(w.p.org.id, a.proposal.id)).toEqual([]);
  });

  it("makes nothing from a proposal with only monthly or yearly lines, and says it is the owner's decision", async () => {
    const w = await world();
    const hosting = await priceBookItem(w.p, { name: "Hosting", unitPriceMinor: 9_900, billing: "monthly" });
    const a = await acceptedProposal(w.p, { doc: { lines: [lineOf(hosting)] } }, "recorded");
    await expect(createInvoiceFromProposal(w.ctx("owner"), a.proposal.id, { version: 1 })).rejects.toMatchObject({ code: "invalid_input", message: expect.stringContaining("Whether and when to bill those lines is yours to decide") });
    expect(await invoiceRows(w.p.org.id, a.proposal.id)).toEqual([]);
    const shown = await invoicingForProposal(w.ctx("owner"), a.proposal.id);
    expect(shown.preview?.problem?.code).toBe("no_one_time_lines");
    expect(shown.preview?.lines).toEqual([]);
  });

  it("does nothing while proposals or invoicing is switched off for the workspace, and says which", async () => {
    const w = await world();
    const a = await acceptedProposal(w.p, {}, "recorded");
    await setFeature(w.p.org.id, false);
    await expect(createInvoiceFromProposal(w.ctx("owner"), a.proposal.id, { version: 1 })).rejects.toMatchObject({ code: "not_enabled", message: expect.stringContaining("Proposals aren't switched on") });
    expect(await invoicingForProposal(w.ctx("owner"), a.proposal.id)).toMatchObject({ available: false, preview: null, existing: [] });
    await setFeature(w.p.org.id, true);
    await setFeature(w.p.org.id, false, "invoices");
    await expect(createInvoiceFromProposal(w.ctx("owner"), a.proposal.id, { version: 1 })).rejects.toMatchObject({ code: "not_enabled" });
    expect(await invoicingForProposal(w.ctx("owner"), a.proposal.id)).toMatchObject({ available: false });
    expect(await invoiceRows(w.p.org.id, a.proposal.id)).toEqual([]);
  });
});

describe("once per saved version", () => {
  it("returns the first draft for a repeat, and makes exactly one for two requests at once", async () => {
    const w = await world();
    const a = await acceptedProposal(w.p, {}, "recorded");
    const [x, y] = await Promise.all([createInvoiceFromProposal(w.ctx("owner"), a.proposal.id, { version: 1 }), createInvoiceFromProposal(w.ctx("manager"), a.proposal.id, { version: 1 })]);
    expect([x.status, y.status].sort()).toEqual(["already", "created"]);
    expect(x.invoiceId).toBe(y.invoiceId);
    expect(await invoiceRows(w.p.org.id, a.proposal.id)).toHaveLength(1);
    const again = await createInvoiceFromProposal(w.ctx("sales"), a.proposal.id, { version: 1 });
    expect(again).toEqual({ status: "already", invoiceId: x.invoiceId, count: 1 });
    expect((await proposalEvents(a.proposal.id)).filter((e) => e.kind === "invoice_drafted")).toHaveLength(1);
  });

  it("lets only the owner or a manager ask for a further invoice, which takes the next key, and never exceeds the sanity limit", async () => {
    const w = await world();
    const a = await acceptedProposal(w.p, {}, "recorded");
    const first = await createInvoiceFromProposal(w.ctx("owner"), a.proposal.id, { version: 1 });
    await expect(createInvoiceFromProposal(w.ctx("sales"), a.proposal.id, { version: 1, another: true })).rejects.toMatchObject({ code: "forbidden", message: expect.stringContaining("Only the business owner or a manager") });
    expect(await invoiceRows(w.p.org.id, a.proposal.id)).toHaveLength(1);
    const second = await createInvoiceFromProposal(w.ctx("manager"), a.proposal.id, { version: 1, another: true });
    expect(second).toMatchObject({ status: "created" });
    expect(second.invoiceId).not.toBe(first.invoiceId);
    const keys = (await invoiceRows(w.p.org.id, a.proposal.id)).map((r) => r.idempotency_key);
    expect(keys).toEqual([`proposal-invoice:${a.proposal.id}:1`, `proposal-invoice:${a.proposal.id}:1:1`]);
    expect((await proposalEvents(a.proposal.id)).filter((e) => e.kind === "invoice_drafted").map((e) => e.detail.invoiceId)).toEqual([first.invoiceId, second.invoiceId]);
    // A plain request still finds the first one.
    expect(await createInvoiceFromProposal(w.ctx("owner"), a.proposal.id, { version: 1 })).toMatchObject({ status: "already", count: 2 });
    expect(MAX_INVOICES_PER_PROPOSAL_VERSION).toBe(20);
  });

  it("frees the key when a draft is discarded, and keeps counting a voided or issued invoice", async () => {
    const w = await world();
    const a = await acceptedProposal(w.p, {}, "recorded");
    const first = await createInvoiceFromProposal(w.ctx("owner"), a.proposal.id, { version: 1 });
    await discardDraft(w.ctx("owner"), first.invoiceId);
    expect(await invoiceRows(w.p.org.id, a.proposal.id)).toEqual([]);
    const next = await createInvoiceFromProposal(w.ctx("owner"), a.proposal.id, { version: 1 });
    expect(next).toMatchObject({ status: "created" });
    expect(next.invoiceId).not.toBe(first.invoiceId);
    expect((await invoiceRows(w.p.org.id, a.proposal.id))[0].idempotency_key).toBe(`proposal-invoice:${a.proposal.id}:1`);
  });
});

describe("who may do it", () => {
  it("is offered to people who can write invoices and read proposals, and to the owner or a manager for a further one, and to no one else", async () => {
    const w = await world();
    const a = await acceptedProposal(w.p, {}, "recorded");
    const seen = async (who: "owner" | "manager" | "sales" | "setter" | "support" | "viewer") => invoicingForProposal(w.ctx(who), a.proposal.id);
    expect(await seen("owner")).toMatchObject({ available: true, canCreate: true, canMakeAnother: true });
    expect(await seen("manager")).toMatchObject({ available: true, canCreate: true, canMakeAnother: true });
    expect(await seen("sales")).toMatchObject({ available: true, canCreate: true, canMakeAnother: false });
    for (const who of ["setter", "support", "viewer"] as const) expect(await seen(who)).toMatchObject({ available: false, canCreate: false, canMakeAnother: false, preview: null, existing: [] });
    for (const who of ["setter", "support", "viewer"] as const) {
      await expect(createInvoiceFromProposal(w.ctx(who), a.proposal.id, { version: 1 })).rejects.toMatchObject({ code: "forbidden" });
    }
    expect(await invoiceRows(w.p.org.id, a.proposal.id)).toEqual([]);
    await createInvoiceFromProposal(w.ctx("sales"), a.proposal.id, { version: 1 });
    const after = await seen("sales");
    expect(after.existing).toHaveLength(1);
    expect(after.existing[0]).toMatchObject({ status: "draft", number: null, proposalVersion: 1, currency: "USD" });
    expect(after.preview?.alreadyForThisVersion).toBe(1);
  });

  it("is never offered for a proposal that is not accepted, though the list of its invoices is", async () => {
    const w = await world();
    const draft = await draftBy(w.p, "member");
    expect(await invoicingForProposal(w.ctx("owner"), draft.id)).toMatchObject({ available: true, canCreate: true, preview: null, existing: [] });
  });

  it("needs the draft to be approved by an owner or manager before it is issued, even by its own author when approval is switched off for creators", async () => {
    const w = await world();
    const customer = await createContact(w.p.actor("owner"), { firstName: "Maria", lastName: "Santos", email: uniqueEmail(), phone: null });
    const a = await acceptedProposal(w.p, { contactId: customer.id, clientName: "Maria Santos" }, "recorded");
    const made = await createInvoiceFromProposal(w.ctx("sales"), a.proposal.id, { version: 1 });
    if (made.status !== "created") throw new Error("not created");
    const settings = await getInvoiceSettings(w.ctx("owner"));
    await saveInvoiceSettings(w.ctx("owner"), { approvalRequiredForCreators: false }, settings.version);
    const detail = await getInvoiceDetail(w.ctx("sales"), made.invoiceId);
    await expect(issueInvoice(w.ctx("sales"), made.invoiceId, { version: detail.invoice.version })).rejects.toMatchObject({ code: "forbidden" });
    const issued = await issueInvoice(w.ctx("manager"), made.invoiceId, { version: detail.invoice.version });
    // The issued invoice has the proposal's figures and keeps its source for good.
    expect(issued.detail.invoice).toMatchObject({ status: "issued", totalMinor: await oneTimeTotal(a.proposal.id), sourceProposalId: a.proposal.id, createdVia: "proposal" });
    expect(issued.detail.invoice.number).toMatch(/^INV-/);
  });
});

describe("tenant isolation", () => {
  it("lets another workspace neither see nor invoice a proposal, nor name one in an invoice of its own", async () => {
    const a = await world();
    const b = await world();
    const accepted = await acceptedProposal(a.p, {}, "recorded");
    expect(await invoicingForProposal(b.ctx("owner"), accepted.proposal.id)).toMatchObject({ available: false, preview: null, existing: [] });
    await expect(createInvoiceFromProposal(b.ctx("owner"), accepted.proposal.id, { version: 1 })).rejects.toMatchObject({ code: "not_found" });
    expect(await invoiceRows(a.p.org.id, accepted.proposal.id)).toEqual([]);
    // The database refuses an invoice of workspace b that names workspace a's proposal.
    await expect(withSystem((db) => db.query(
      "insert into customer_invoices (org_id, currency, subtotal_minor, tax_minor, total_minor, created_via, source_type, source_id, source_version) values ($1, 'USD', 0, 0, 0, 'proposal', 'proposal', $2, 1)",
      [b.p.org.id, accepted.proposal.id],
    ))).rejects.toThrow();
    // And a member of workspace b cannot read a's invoice made from it.
    const made = await createInvoiceFromProposal(a.ctx("owner"), accepted.proposal.id, { version: 1 });
    await expect(getInvoiceDetail(b.ctx("owner"), made.invoiceId)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("history and privacy", () => {
  it("keeps the customer's details out of both histories and the audit line", async () => {
    const w = await world();
    const email = uniqueEmail();
    const customer = await createContact(w.p.actor("owner"), { firstName: "Mariana", lastName: "Quezon-Delacruz", email, phone: null });
    const a = await acceptedProposal(w.p, { contactId: customer.id, clientName: "Mariana Quezon-Delacruz", clientEmail: email }, "recorded");
    const made = await createInvoiceFromProposal(w.ctx("owner"), a.proposal.id, { version: 1 });
    const text = JSON.stringify([
      await rows("select kind, detail from customer_invoice_events where invoice_id = $1", [made.invoiceId]),
      (await proposalEvents(a.proposal.id)).filter((e) => e.kind === "invoice_drafted"),
      await rows("select metadata from audit_logs where target_id = $1 and action = 'invoice.drafted_from_proposal'", [made.invoiceId]),
    ]);
    expect(text).toContain("proposalNumber");
    expect(text).not.toContain(email);
    expect(text).not.toContain("Mariana");
    expect(text).not.toContain("Quezon");
    const audit = await rows<{ metadata: Record<string, unknown> }>("select metadata from audit_logs where target_id = $1 and action = 'invoice.drafted_from_proposal'", [made.invoiceId]);
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({ proposalId: a.proposal.id, proposalVersion: 1, lines: 1, recurringLines: 0, currency: "USD", basis: "answer_recorded_by_person", another: false });
  });

  it("deletes a draft made for a customer who asks for erasure, as it does every unissued invoice, and the proposal and its history stay", async () => {
    const w = await world();
    const customer = await createContact(w.p.actor("owner"), { firstName: "Maria", lastName: "Santos", email: uniqueEmail(), phone: null });
    const a = await acceptedProposal(w.p, { contactId: customer.id, clientName: "Maria Santos" }, "recorded");
    const made = await createInvoiceFromProposal(w.ctx("owner"), a.proposal.id, { version: 1 });
    expect(await invoiceRows(w.p.org.id, a.proposal.id)).toHaveLength(1);
    await redactContact(w.p.actor("owner"), customer.id, "Customer asked for erasure by email, 22 Oct");
    expect(await invoiceRows(w.p.org.id, a.proposal.id)).toEqual([]);
    expect(await rows("select status from proposals where id = $1", [a.proposal.id])).toEqual([{ status: "accepted" }]);
    expect((await proposalEvents(a.proposal.id)).filter((e) => e.kind === "invoice_drafted")).toHaveLength(1);
    expect((await invoicingForProposal(w.ctx("owner"), a.proposal.id)).existing).toEqual([]);
    expect(made.status).toBe("created");
  });
});
