// What the owner's close rule does about the deal linked to an invoice, on embedded Postgres: nothing by default, a question for the deal's owner, or a deal marked
// won only when a marked invoice is paid in full by a payment the provider confirmed. Money arriving never silently changes a deal otherwise.
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { getInvoiceSettings, saveInvoiceSettings } from "@/server/invoices/settings";
import { createDraft, getInvoiceDetail, issueInvoice } from "@/server/invoices/invoices";
import { recordManualPayment, recordRefund } from "@/server/invoices/payments";
import { recordDisputeOpened, recordDisputeResult } from "@/server/invoices/disputes";
import { applyDisputeInTx } from "@/server/invoices/apply";
import { runCloseRule, runRefundReview } from "@/server/invoices/close-rules";
import { connectionFor, contactIn, dealFor, invoiceOrg, line, providerPayment, rows, type InvoiceOrg } from "./support/invoices";

const NOW = new Date("2026-10-23T12:00:00Z");
const pay = { receivedOn: "2026-10-23", method: "bank_transfer" as const, evidence: "Bank transfer ref 9001" };

async function setRule(io: InvoiceOrg, closeRule: "none" | "task" | "auto_won", countManualAsVerified = false) {
  const cur = await getInvoiceSettings(io.ctx("owner"));
  await saveInvoiceSettings(io.ctx("owner"), { closeRule, countManualAsVerified }, cur.version);
}

/** An issued invoice for a deal whose owner is the sales rep. */
async function dealInvoice(io: InvoiceOrg, over: { closesDeal?: boolean; unit?: string } = {}) {
  const contactId = await contactIn(io);
  const dealId = await dealFor(io, contactId, { ownerId: io.c.people.sales.id });
  const d = await createDraft(io.ctx("owner"), { opportunityId: dealId, currency: "PHP", lines: [line({ unitPrice: over.unit ?? "1500" })], closesDeal: over.closesDeal });
  const issued = await issueInvoice(io.ctx("owner"), d.invoice.id, { version: d.invoice.version }, { now: NOW });
  return { invoice: issued.detail.invoice, dealId, contactId };
}

const dealStatus = async (id: string) => (await rows<{ status: string }>("select status from crm_opportunities where id = $1", [id]))[0].status;
const tasksFor = (dealId: string) => rows<{ title: string; assigned_user_id: string | null; source: string }>("select title, assigned_user_id, source from tasks where opportunity_id = $1 order by created_at", [dealId]);
const applied = (invoiceId: string) => rows<{ detail: { action: string } }>("select detail from customer_invoice_events where invoice_id = $1 and kind = 'close_rule_applied'", [invoiceId]);

describe("the default rule", () => {
  it("does nothing to the deal when its invoice is paid", async () => {
    const io = await invoiceOrg();
    const { invoice, dealId } = await dealInvoice(io, { closesDeal: true });
    const out = await recordManualPayment(io.ctx("owner"), invoice.id, { ...pay, amount: "1500" }, { now: NOW });
    expect(out.justPaid).toBe(true);
    expect(out.closeRule).toMatchObject({ decision: { action: "none", reason: "rule_none" } });
    expect(await dealStatus(dealId)).toBe("open");
    expect(await tasksFor(dealId)).toEqual([]);
    expect(await applied(invoice.id)).toEqual([]);
  });
});

describe("the task rule", () => {
  it("asks the deal's owner once, when the invoice is paid in full, and changes nothing about the deal", async () => {
    const io = await invoiceOrg();
    await setRule(io, "task");
    const { invoice, dealId } = await dealInvoice(io);
    const part = await recordManualPayment(io.ctx("owner"), invoice.id, { ...pay, amount: "500" }, { now: NOW });
    expect(part.closeRule).toMatchObject({ decision: { action: "none", reason: "not_fully_paid" } });
    expect(await tasksFor(dealId)).toEqual([]);
    const full = await recordManualPayment(io.ctx("owner"), invoice.id, { ...pay, amount: "1000" }, { now: NOW });
    expect(full.closeRule?.decision.action).toBe("task");
    const tasks = await tasksFor(dealId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: "Invoice INV-0001 is paid: mark the deal won?", assigned_user_id: io.c.people.sales.id, source: "system" });
    expect(await dealStatus(dealId)).toBe("open");
    expect(await applied(invoice.id)).toEqual([{ detail: expect.objectContaining({ action: "task" }) }]);
    // Running it again (a retry, a sweep) asks nobody twice.
    expect(await runCloseRule(io.orgId, invoice.id)).toMatchObject({ decision: { action: "none", reason: "already_applied" } });
    expect(await tasksFor(dealId)).toHaveLength(1);
  });

  it("puts the task with nobody rather than losing it when the deal's owner has left the team", async () => {
    const io = await invoiceOrg();
    await setRule(io, "task");
    const { invoice, dealId } = await dealInvoice(io);
    await withSystem((db) => db.query("update organization_memberships set status = 'revoked' where org_id = $1 and user_id = $2", [io.orgId, io.c.people.sales.id]));
    await recordManualPayment(io.ctx("owner"), invoice.id, { ...pay, amount: "1500" }, { now: NOW });
    const tasks = await tasksFor(dealId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].assigned_user_id).toBeNull();
  });

  it("does nothing for an invoice with no deal, a deal that is already closed, or while a dispute is open", async () => {
    const io = await invoiceOrg();
    await setRule(io, "task");
    const conn = await connectionFor(io);
    const lone = await createDraft(io.ctx("owner"), { contactId: await contactIn(io), lines: [line()] });
    const loneIssued = (await issueInvoice(io.ctx("owner"), lone.invoice.id, { version: 1 }, { now: NOW })).detail.invoice;
    expect((await recordManualPayment(io.ctx("owner"), loneIssued.id, { ...pay, amount: "1500" }, { now: NOW })).closeRule).toMatchObject({ decision: { reason: "no_deal" } });
    const closed = await dealInvoice(io);
    await withSystem((db) => db.query("update crm_opportunities set status = 'lost', closed_at = now(), lost_reason = 'Chose another firm' where id = $1", [closed.dealId]));
    expect((await recordManualPayment(io.ctx("owner"), closed.invoice.id, { ...pay, amount: "1500" }, { now: NOW })).closeRule).toMatchObject({ decision: { reason: "deal_not_open" } });
    expect(await dealStatus(closed.dealId)).toBe("lost");
    const disputed = await dealInvoice(io);
    const p = await providerPayment(io, disputed.invoice.id, conn, 150000, { livemode: true });
    await withSystem((db) => applyDisputeInTx(db, { orgId: io.orgId, paymentId: p.paymentId, open: true, actor: { id: null, kind: "provider" } }));
    expect(await runCloseRule(io.orgId, disputed.invoice.id)).toMatchObject({ decision: { action: "none", reason: "dispute" } });
    expect(await tasksFor(disputed.dealId)).toEqual([]);
  });
});

describe("the automatic rule", () => {
  it("marks the deal won only for an invoice a person marked, paid in full by the provider, with the deal open", async () => {
    const io = await invoiceOrg();
    await setRule(io, "auto_won");
    const conn = await connectionFor(io);
    const marked = await dealInvoice(io, { closesDeal: true });
    await providerPayment(io, marked.invoice.id, conn, 100000, { livemode: true });
    expect(await runCloseRule(io.orgId, marked.invoice.id)).toMatchObject({ decision: { reason: "not_fully_paid" } });
    expect(await dealStatus(marked.dealId)).toBe("open");
    await providerPayment(io, marked.invoice.id, conn, 50000, { livemode: true });
    const out = await runCloseRule(io.orgId, marked.invoice.id);
    expect(out.decision.action).toBe("won");
    expect(await dealStatus(marked.dealId)).toBe("won");
    expect(await applied(marked.invoice.id)).toEqual([{ detail: expect.objectContaining({ action: "won", dealId: marked.dealId }) }]);
    const audit = await rows("select 1 from audit_logs where target_id = $1 and action = 'invoice.deal_closed_won' and actor_kind = 'system'", [marked.invoice.id]);
    expect(audit).toHaveLength(1);
    expect(await runCloseRule(io.orgId, marked.invoice.id)).toMatchObject({ decision: { reason: "already_applied" } });
    // The deal's own history says it was won, once.
    expect(await rows("select 1 from crm_opportunity_history where opportunity_id = $1 and to_status = 'won'", [marked.dealId])).toHaveLength(1);
    // An invoice nobody marked is left alone, however completely it is paid.
    const unmarked = await dealInvoice(io, { closesDeal: false });
    await providerPayment(io, unmarked.invoice.id, conn, 150000, { livemode: true });
    expect(await runCloseRule(io.orgId, unmarked.invoice.id)).toMatchObject({ decision: { action: "none", reason: "not_marked" } });
    expect(await dealStatus(unmarked.dealId)).toBe("open");
    expect(await tasksFor(unmarked.dealId)).toEqual([]);
  });

  it("asks a person instead when the payment was recorded by hand and the owner does not count those, and marks it won when the owner does", async () => {
    const io = await invoiceOrg();
    await setRule(io, "auto_won");
    const byHand = await dealInvoice(io, { closesDeal: true });
    const out = await recordManualPayment(io.ctx("owner"), byHand.invoice.id, { ...pay, amount: "1500" }, { now: NOW });
    expect(out.closeRule?.decision.action).toBe("task");
    expect(await dealStatus(byHand.dealId)).toBe("open");
    expect(await tasksFor(byHand.dealId)).toHaveLength(1);
    await setRule(io, "auto_won", true);
    const counted = await dealInvoice(io, { closesDeal: true });
    const again = await recordManualPayment(io.ctx("owner"), counted.invoice.id, { ...pay, amount: "1500" }, { now: NOW });
    expect(again.closeRule?.decision.action).toBe("won");
    expect(await dealStatus(counted.dealId)).toBe("won");
  });

  it("asks a person when the deal cannot be closed after all, instead of losing the payment's effect", async () => {
    const io = await invoiceOrg();
    await setRule(io, "auto_won");
    const conn = await connectionFor(io);
    const inv = await dealInvoice(io, { closesDeal: true });
    // The CRM can no longer close deals here (the workspace's deals now belong to another provider).
    await providerPayment(io, inv.invoice.id, conn, 150000, { livemode: true });
    await withSystem((db) => db.query("update crm_workspaces set mode = 'ghl' where org_id = $1", [io.orgId]));
    const out = await runCloseRule(io.orgId, inv.invoice.id);
    expect(out.decision.action).toBe("won");
    expect(out.note).toBeTruthy();
    expect(out.taskId).toBeTruthy();
    expect((await tasksFor(inv.dealId))[0].title).toMatch(/could not be marked won/);
    expect(await dealStatus(inv.dealId)).toBe("open");
    expect(await applied(inv.invoice.id)).toEqual([{ detail: expect.objectContaining({ action: "task", note: "deal_not_closable" }) }]);
  });
});

describe("a refund after the deal was won", () => {
  it("never reopens the deal: a task asks its owner to look again, once per refund", async () => {
    const io = await invoiceOrg();
    await setRule(io, "auto_won");
    const conn = await connectionFor(io);
    const inv = await dealInvoice(io, { closesDeal: true });
    const p = await providerPayment(io, inv.invoice.id, conn, 150000, { livemode: true });
    await runCloseRule(io.orgId, inv.invoice.id);
    expect(await dealStatus(inv.dealId)).toBe("won");
    const refund = await recordRefund(io.ctx("owner"), p.paymentId, { amount: "300", reason: "Part of the job was dropped" });
    expect(refund.reviewTaskId).toBeTruthy();
    expect(await dealStatus(inv.dealId)).toBe("won");
    const tasks = await tasksFor(inv.dealId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: "A refund was recorded on invoice INV-0001: review the deal", assigned_user_id: io.c.people.sales.id });
    const refundId = refund.refundId;
    expect((await runRefundReview(io.orgId, inv.invoice.id, refundId)).taskId).toBeNull();
    const second = await recordRefund(io.ctx("owner"), p.paymentId, { amount: "100", reason: "A little more goodwill" });
    expect(second.reviewTaskId).toBeTruthy();
    expect(await tasksFor(inv.dealId)).toHaveLength(2);
    expect((await getInvoiceDetail(io.ctx("owner"), inv.invoice.id)).invoice.paymentStatus).toBe("paid");
  });

  it("treats a lost dispute the same: the chargeback never reopens the deal, and a task asks its owner to look again", async () => {
    const io = await invoiceOrg();
    await setRule(io, "auto_won");
    const conn = await connectionFor(io);
    const inv = await dealInvoice(io, { closesDeal: true });
    const p = await providerPayment(io, inv.invoice.id, conn, 150000, { livemode: true });
    await runCloseRule(io.orgId, inv.invoice.id);
    expect(await dealStatus(inv.dealId)).toBe("won");
    await recordDisputeOpened(io.ctx("owner"), p.paymentId, {});
    // While it is open nothing about the deal changes, and no task is asked for.
    expect(await dealStatus(inv.dealId)).toBe("won");
    expect(await tasksFor(inv.dealId)).toEqual([]);
    const lost = await recordDisputeResult(io.ctx("owner"), p.paymentId, { outcome: "lost", amount: "1500.00" });
    expect(lost.reviewTaskId).toBeTruthy();
    expect(await dealStatus(inv.dealId)).toBe("won");
    expect(await tasksFor(inv.dealId)).toEqual([expect.objectContaining({ title: "A refund was recorded on invoice INV-0001: review the deal", assigned_user_id: io.c.people.sales.id })]);
    // A dispute that was won is not a refund and asks for nothing.
    const other = await dealInvoice(io, { closesDeal: true });
    const q = await providerPayment(io, other.invoice.id, conn, 150000, { livemode: true });
    await runCloseRule(io.orgId, other.invoice.id);
    await recordDisputeOpened(io.ctx("owner"), q.paymentId, {});
    expect((await recordDisputeResult(io.ctx("owner"), q.paymentId, { outcome: "won" })).reviewTaskId).toBeNull();
    expect(await tasksFor(other.dealId)).toEqual([]);
  });

  it("does not ask when the rule never marked the deal won", async () => {
    const io = await invoiceOrg();
    await setRule(io, "task");
    const conn = await connectionFor(io);
    const inv = await dealInvoice(io);
    const p = await providerPayment(io, inv.invoice.id, conn, 150000, { livemode: true });
    const refund = await recordRefund(io.ctx("owner"), p.paymentId, { amount: "300", reason: "Part of the job was dropped" });
    expect(refund.reviewTaskId).toBeNull();
    expect(await tasksFor(inv.dealId)).toEqual([]);
  });
});
