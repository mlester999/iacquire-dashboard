// What invoices and payments announce to the CRM and Automation Studio: the eight triggers, each announcement once, ids and amounts only, nothing for a provider's test mode,
// the timeline lines, a workflow started by a payment, and a test payment that never closes a deal. Embedded Postgres; no payment provider or customer is contacted.
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { EVENT_TRIGGER_TYPES, STEP_KIND_LIST, TRIGGERS, validateDefinition, validationContextFrom, type WorkflowDefinition, type WorkflowStep } from "@/lib/crm/workflow/spec";
import { INVOICE_EVENT_TYPES, PAYLOAD_KEYS } from "@/lib/invoices/crm-events";
import { crmEventDispatch } from "@/server/crm/dispatch";
import { createWorkflow, publishWorkflow, setWorkflowStatus } from "@/server/crm/workflows/definitions";
import { processWorkflowRuns } from "@/server/crm/workflows/runner";
import { applyPaymentInTx, applyRefundInTx } from "@/server/invoices/apply";
import { getInvoiceDetail, voidInvoice } from "@/server/invoices/invoices";
import { recordManualPayment, recordRefund } from "@/server/invoices/payments";
import { saveInvoiceSettings } from "@/server/invoices/settings";
import { eventsFor } from "./support/crm";
import { contactIn, connectionFor, dealFor, draftBy, invoiceOrg, issuedInvoice, providerPayment, rows, type InvoiceOrg } from "./support/invoices";

const NOW = new Date("2026-10-23T12:00:00Z");
const step = (key: string, kind: WorkflowStep["kind"], config: Record<string, unknown>, next: string | null = null) => ({ key, kind, config, next }) as WorkflowStep;
const EMPTY_CTX = { tags: [], users: [], pipelines: [], fields: [], templates: [], n8nMappings: [], webhookSubscriptions: [], assignmentRules: [], agents: [], calendars: [], appointmentTypes: [] };
const cash = (amount: string) => ({ amount, receivedOn: "2026-10-23", method: "cash" as const, evidence: "Cash, receipt 12" });

async function liveWorkflow(io: InvoiceOrg, name: string, definition: WorkflowDefinition) {
  const owner = io.c.actor("owner");
  const { id } = await createWorkflow(owner, { name, definition });
  expect((await publishWorkflow(owner, id)).needsApproval).toBe(false);
  await setWorkflowStatus(owner, id, "active");
  return id;
}
async function settle() {
  for (let i = 0; i < 12; i += 1) {
    const d = await crmEventDispatch({ now: new Date() });
    const r = await processWorkflowRuns({ now: new Date() });
    if (!d.claimed && !r.claimed && !r.scheduled) break;
  }
}
/** The invoice and payment announcements of a workspace, in the order they were made (the workspace's other events are not these). */
const invoiceEvents = async (orgId: string) => (await eventsFor(orgId)).filter((e) => (INVOICE_EVENT_TYPES as readonly string[]).includes(e.type));
const types = async (orgId: string) => (await invoiceEvents(orgId)).map((e) => e.type);
const timeline = (orgId: string, contactId: string) =>
  rows<{ kind: string; summary: string }>("select kind, summary from crm_activities where org_id = $1 and contact_id = $2 and ref_type = 'invoice' order by id", [orgId, contactId]);

describe("the triggers", () => {
  it("are the eight the audit lists, described honestly, carrying a deal and a customer only when the invoice has them", () => {
    for (const t of INVOICE_EVENT_TYPES) {
      expect(EVENT_TRIGGER_TYPES, t).toContain(t);
      expect(TRIGGERS[t], t).toMatchObject({ group: "Deals", entity: "none", carries: { contact: "maybe", opportunity: "maybe" }, filters: [] });
      expect(TRIGGERS[t].label.length).toBeGreaterThan(5);
      expect(TRIGGERS[t].description.length).toBeGreaterThan(40);
    }
    expect(TRIGGERS["invoice.issued"].description).toMatch(/does not mean the customer has received or seen it/i);
    expect(TRIGGERS["invoice.paid"].description).toMatch(/test payment does not start it/i);
    expect(TRIGGERS["invoice.overdue"].description).toMatch(/when the scheduler runs \(not live\)/i);
    expect(TRIGGERS["payment.verified"].description).toMatch(/not a payment a person recorded by hand/i);
    expect(TRIGGERS["payment.refunded"].description).toMatch(/moves no money/i);
  });

  it("can start a workflow, and there is no step that issues, sends, takes a payment or marks anything paid", () => {
    expect(STEP_KIND_LIST.filter((k) => /invoice|payment|refund/i.test(k))).toEqual([]);
    const codes = (d: unknown) => validateDefinition(d, validationContextFrom(EMPTY_CTX)).map((i) => i.code);
    expect(codes({ trigger: { type: "invoice.paid" }, steps: [step("end", "end", {})] })).toEqual([]);
    expect(codes({ trigger: { type: "payment.verified" }, steps: [step("end", "end", {})] })).toEqual([]);
    expect(codes({ trigger: { type: "invoice.overdue", filters: { tagIds: [crypto.randomUUID()] } }, steps: [step("end", "end", {})] })).toContain("invalid_trigger");
  });
});

describe("what is announced, and when", () => {
  it("announces a draft, an issue and a void once each, with the customer on the event and the deal in it, and ids and amounts only", async () => {
    const io = await invoiceOrg();
    const contactId = await contactIn(io, { firstName: "Zelda", lastName: "Quimby" });
    const dealId = await dealFor(io, contactId);
    const inv = await issuedInvoice(io, { contactId, opportunityId: dealId }, NOW);
    expect(await types(io.orgId)).toEqual(["invoice.created", "invoice.issued"]);
    const [created, issued] = await invoiceEvents(io.orgId);
    expect(created).toMatchObject({ type: "invoice.created", entity_id: inv.invoice.id, contact_id: contactId });
    expect(issued).toMatchObject({ type: "invoice.issued", entity_id: inv.invoice.id, contact_id: contactId, payload: { invoiceId: inv.invoice.id, number: "INV-0001", currency: "PHP", total: "1500.00", opportunityId: dealId } });
    await voidInvoice(io.ctx("owner"), inv.invoice.id, { reason: "Raised for the wrong job" });
    await voidInvoice(io.ctx("owner"), inv.invoice.id, { reason: "Raised for the wrong job" }).catch(() => undefined);
    expect(await types(io.orgId)).toEqual(["invoice.created", "invoice.issued", "invoice.voided"]);
    // Whatever was announced holds no name, email, phone or address, no provider detail, and only keys the contract allows.
    for (const e of await invoiceEvents(io.orgId)) {
      for (const k of Object.keys(e.payload)) expect(PAYLOAD_KEYS as readonly string[], k).toContain(k);
    }
    const all = JSON.stringify(await rows("select payload from crm_events where org_id = $1 and type = any($2::text[])", [io.orgId, [...INVOICE_EVENT_TYPES]]))
      + JSON.stringify(await rows("select summary, metadata from crm_activities where org_id = $1 and ref_type = 'invoice'", [io.orgId]));
    expect(all).not.toMatch(/Zelda|Quimby|Mango|Cebu|@example\.test|\+1555/);
    expect((await timeline(io.orgId, contactId)).map((a) => a.kind)).toEqual(["invoice.created", "invoice.issued", "invoice.voided"]);
  });

  it("puts the same lines on the deal's timeline as on the customer's", async () => {
    const io = await invoiceOrg();
    const contactId = await contactIn(io);
    const dealId = await dealFor(io, contactId);
    await issuedInvoice(io, { contactId, opportunityId: dealId }, NOW);
    const onDeal = await rows<{ kind: string }>("select kind from crm_activities where org_id = $1 and opportunity_id = $2 and ref_type = 'invoice' order by id", [io.orgId, dealId]);
    expect(onDeal.map((a) => a.kind)).toEqual(["invoice.created", "invoice.issued"]);
  });

  it("leaves a payment a person recorded by hand as a timeline line only, and announces the invoice as paid when it is", async () => {
    const io = await invoiceOrg();
    const contactId = await contactIn(io);
    const inv = await issuedInvoice(io, { contactId }, NOW);
    await recordManualPayment(io.ctx("owner"), inv.invoice.id, cash("500"), { now: NOW });
    expect(await types(io.orgId)).toEqual(["invoice.created", "invoice.issued"]);
    await recordManualPayment(io.ctx("owner"), inv.invoice.id, cash("1000"), { now: NOW });
    expect(await types(io.orgId)).toEqual(["invoice.created", "invoice.issued", "invoice.paid"]);
    const paid = (await eventsFor(io.orgId, "invoice.paid"))[0];
    expect(paid.payload).toMatchObject({ verification: "manual", livemode: true, total: "1500.00" });
    const lines = (await timeline(io.orgId, contactId)).map((a) => a.kind);
    expect(lines).toEqual(["invoice.created", "invoice.issued", "payment.recorded", "payment.recorded", "invoice.paid"]);
    expect((await timeline(io.orgId, contactId)).find((a) => a.kind === "payment.recorded")?.summary).toContain("recorded by hand (not confirmed by a provider)");
    // Nothing a person typed is called verified.
    expect(await types(io.orgId)).not.toContain("payment.verified");
  });

  it("announces a payment the provider confirmed (payment.verified, then invoice.paid when it settles the invoice), each once, however often the delivery is applied", async () => {
    const io = await invoiceOrg();
    const contactId = await contactIn(io);
    const conn = await connectionFor(io);
    const inv = await issuedInvoice(io, { contactId }, NOW);
    const input = { orgId: io.orgId, invoiceId: inv.invoice.id, amountMinor: 150_000, currency: "PHP" as const, provider: "simulated" as const, verification: "provider_confirmed" as const, connectionId: conn, providerPaymentId: "pay_fixed_1", livemode: true, receivedAt: NOW, actor: { id: null, kind: "provider" as const } };
    const first = await withSystem((db) => applyPaymentInTx(db, input));
    const again = await withSystem((db) => applyPaymentInTx(db, input));
    expect(first.duplicate).toBe(false);
    expect(again.duplicate).toBe(true);
    expect(await types(io.orgId)).toEqual(["invoice.created", "invoice.issued", "payment.verified", "invoice.paid"]);
    const verified = (await eventsFor(io.orgId, "payment.verified"))[0];
    expect(verified).toMatchObject({ entity_id: inv.invoice.id, contact_id: contactId, payload: { paymentId: first.paymentId, amount: "1500.00", verification: "provider_confirmed", livemode: true } });
    expect(JSON.stringify(verified.payload)).not.toMatch(/pay_fixed_1|simulated/);
    expect((await timeline(io.orgId, contactId)).map((a) => a.kind)).toEqual(["invoice.created", "invoice.issued", "payment.verified", "invoice.paid"]);
  });

  it("announces a failed attempt once, and a refund once however often it is recorded", async () => {
    const io = await invoiceOrg();
    const contactId = await contactIn(io);
    const conn = await connectionFor(io);
    const inv = await issuedInvoice(io, { contactId }, NOW);
    const failed = await providerPayment(io, inv.invoice.id, conn, 150_000, { status: "failed", livemode: true });
    expect(failed.status).toBe("failed");
    expect(await types(io.orgId)).toEqual(["invoice.created", "invoice.issued", "payment.failed"]);
    expect((await eventsFor(io.orgId, "payment.failed"))[0].payload).toMatchObject({ paymentId: failed.paymentId, amount: "1500.00", livemode: true });

    const paid = await providerPayment(io, inv.invoice.id, conn, 150_000, { livemode: true });
    const refund = { orgId: io.orgId, paymentId: paid.paymentId, amountMinor: 40_000, source: "manual_record" as const, reason: "Part of the job was cancelled", idempotencyKey: "refund-key-0001", actor: { id: null, kind: "system" as const } };
    await withSystem((db) => applyRefundInTx(db, refund));
    await withSystem((db) => applyRefundInTx(db, refund));
    const refunds = await eventsFor(io.orgId, "payment.refunded");
    expect(refunds).toHaveLength(1);
    expect(refunds[0].payload).toMatchObject({ paymentId: paid.paymentId, amount: "400.00", livemode: true });
    // A person recording a refund goes through the same door.
    const second = await recordRefund(io.ctx("owner"), paid.paymentId, { amount: "100", reason: "Goodwill gesture" });
    expect(second.duplicate).toBe(false);
    expect(await eventsFor(io.orgId, "payment.refunded")).toHaveLength(2);
  });

  it("starts nothing for money that moved in a provider's test mode, but says so on the timeline", async () => {
    const io = await invoiceOrg();
    const contactId = await contactIn(io);
    const conn = await connectionFor(io);
    const inv = await issuedInvoice(io, { contactId }, NOW);
    const test = await providerPayment(io, inv.invoice.id, conn, 150_000, { livemode: false });
    expect(test.counted).toBe(true);
    expect((await providerPayment(io, inv.invoice.id, conn, 100, { livemode: false, status: "failed" })).status).toBe("failed");
    expect(await types(io.orgId)).toEqual(["invoice.created", "invoice.issued"]);
    const lines = await timeline(io.orgId, contactId);
    expect(lines.map((a) => a.kind)).toEqual(["invoice.created", "invoice.issued", "payment.verified", "invoice.paid", "payment.failed"]);
    for (const kind of ["payment.verified", "invoice.paid", "payment.failed"]) expect(lines.find((a) => a.kind === kind)?.summary, kind).toContain("test mode: no real money moved");
  });

  it("keeps one workspace's announcements out of another's", async () => {
    const a = await invoiceOrg();
    const b = await invoiceOrg();
    await issuedInvoice(a, {}, NOW);
    expect(await types(b.orgId)).toEqual([]);
    expect(await rows("select 1 from crm_activities where org_id = $1 and ref_type = 'invoice'", [b.orgId])).toHaveLength(0);
  });
});

describe("a workflow started by an invoice", () => {
  it("starts once for an invoice paid in full, carrying the deal and the customer, and never for a test payment", async () => {
    const io = await invoiceOrg();
    const contactId = await contactIn(io, { firstName: "Maria" });
    const dealId = await dealFor(io, contactId);
    const wf = await liveWorkflow(io, "When an invoice is paid", {
      trigger: { type: "invoice.paid" },
      steps: [step("task", "create_task", { title: "Say thanks to {{contact.first_name}}", priority: "normal", assignee: "none", linkOpportunity: true })],
    });
    const verifiedWf = await liveWorkflow(io, "When the provider confirms a payment", { trigger: { type: "payment.verified" }, steps: [step("n", "notify_team", { roles: ["owner"], title: "A payment arrived" })] });
    const conn = await connectionFor(io);

    const test = await issuedInvoice(io, { contactId, opportunityId: dealId }, NOW);
    await providerPayment(io, test.invoice.id, conn, 150_000, { livemode: false });
    await settle();
    expect(await rows("select 1 from crm_workflow_runs where workflow_id = any($1::uuid[])", [[wf, verifiedWf]])).toHaveLength(0);

    const real = await issuedInvoice(io, { contactId, opportunityId: dealId }, NOW);
    await providerPayment(io, real.invoice.id, conn, 150_000, { livemode: true });
    await settle();
    const runs = await rows<{ contact_id: string | null; opportunity_id: string | null; status: string; workflow_id: string }>("select contact_id, opportunity_id, status, workflow_id from crm_workflow_runs where workflow_id = any($1::uuid[]) order by created_at", [[wf, verifiedWf]]);
    expect(runs.map((r) => [r.workflow_id, r.status]).sort()).toEqual([[wf, "completed"], [verifiedWf, "completed"]].sort());
    expect(runs.every((r) => r.contact_id === contactId && r.opportunity_id === dealId)).toBe(true);
    expect(await rows("select 1 from tasks where org_id = $1 and title = 'Say thanks to Maria' and opportunity_id = $2", [io.orgId, dealId])).toHaveLength(1);
    await settle();
    expect(await rows("select 1 from crm_workflow_runs where workflow_id = $1", [wf])).toHaveLength(1);
  });

  it("starts for an invoice with no customer and no deal, with neither attached", async () => {
    const io = await invoiceOrg();
    const wf = await liveWorkflow(io, "When an invoice is issued", { trigger: { type: "invoice.created" }, steps: [step("n", "notify_team", { roles: ["owner"], title: "A draft was started" })] });
    const d = await draftBy(io, "owner", { contactId: null });
    await settle();
    const runs = await rows<{ contact_id: string | null; opportunity_id: string | null; status: string }>("select contact_id, opportunity_id, status from crm_workflow_runs where workflow_id = $1", [wf]);
    expect(runs).toEqual([{ contact_id: null, opportunity_id: null, status: "completed" }]);
    expect((await getInvoiceDetail(io.ctx("owner"), d.invoice.id)).invoice.id).toBe(d.invoice.id);
    // No customer and no deal means no line on anyone's timeline either.
    expect(await rows("select 1 from crm_activities where org_id = $1 and ref_type = 'invoice'", [io.orgId])).toHaveLength(0);
  });
});

describe("a test payment and the deal", () => {
  it("never marks a deal won or asks to, whatever the owner's close rule", async () => {
    const io = await invoiceOrg();
    const conn = await connectionFor(io);
    await saveInvoiceSettings(io.ctx("owner"), { closeRule: "auto_won" }, 0);
    const contactId = await contactIn(io);
    const dealId = await dealFor(io, contactId);
    const inv = await issuedInvoice(io, { contactId, opportunityId: dealId, closesDeal: true }, NOW);
    await providerPayment(io, inv.invoice.id, conn, 150_000, { livemode: false });
    const { runCloseRule } = await import("@/server/invoices/close-rules");
    const out = await runCloseRule(io.orgId, inv.invoice.id);
    expect(out.decision).toEqual({ action: "none", reason: "test_payment" });
    expect((await rows<{ status: string }>("select status from crm_opportunities where id = $1", [dealId]))[0].status).toBe("open");
    expect(await rows("select 1 from tasks where org_id = $1 and opportunity_id = $2", [io.orgId, dealId])).toHaveLength(0);
    expect(await rows("select 1 from customer_invoice_events where invoice_id = $1 and kind = 'close_rule_applied'", [inv.invoice.id])).toHaveLength(0);
  });

  it("still closes the deal for a payment that moved real money", async () => {
    const io = await invoiceOrg();
    const conn = await connectionFor(io);
    await saveInvoiceSettings(io.ctx("owner"), { closeRule: "auto_won" }, 0);
    const contactId = await contactIn(io);
    const dealId = await dealFor(io, contactId);
    const inv = await issuedInvoice(io, { contactId, opportunityId: dealId, closesDeal: true }, NOW);
    await providerPayment(io, inv.invoice.id, conn, 150_000, { livemode: true });
    const { runCloseRule } = await import("@/server/invoices/close-rules");
    expect((await runCloseRule(io.orgId, inv.invoice.id)).decision).toEqual({ action: "won" });
    expect((await rows<{ status: string }>("select status from crm_opportunities where id = $1", [dealId]))[0].status).toBe("won");
  });
});
