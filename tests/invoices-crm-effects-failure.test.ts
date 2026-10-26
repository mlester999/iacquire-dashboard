// A problem in what an invoice announces to the CRM never undoes the invoice or the money: the issue, the payment and the void stand, the failure is written on the invoice's
// history in words that carry no address or key, and the next announcement works again. Embedded Postgres; the CRM's outbox and timeline are made to fail on purpose.
import { describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";

const state = vi.hoisted(() => ({ events: false, activities: false }));
vi.mock("@/server/crm/events", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/crm/events")>();
  return {
    ...real,
    emitEvent: (...args: Parameters<typeof real.emitEvent>) => {
      if (state.events) throw new Error("The outbox is down: postgres://iaq:hunter2-hunter2-hunter2@db.internal.example/crm");
      return real.emitEvent(...args);
    },
    recordActivity: (...args: Parameters<typeof real.recordActivity>) => {
      if (state.activities) throw new Error("The timeline is down");
      return real.recordActivity(...args);
    },
  };
});

import { getInvoiceDetail, voidInvoice } from "@/server/invoices/invoices";
import { recordManualPayment } from "@/server/invoices/payments";
import { eventsFor } from "./support/crm";
import { connectionFor, contactIn, invoiceOrg, issuedInvoice, providerPayment, rows } from "./support/invoices";

const NOW = new Date("2026-10-23T12:00:00Z");
const cash = (amount: string) => ({ amount, receivedOn: "2026-10-23", method: "cash" as const, evidence: "Cash, receipt 12" });
const failures = (invoiceId: string) => rows<{ detail: { effect: string; message: string } }>("select detail from customer_invoice_events where invoice_id = $1 and kind = 'effect_failed' order by id", [invoiceId]);
const invoiceEventTypes = async (orgId: string) => (await eventsFor(orgId)).map((e) => e.type).filter((t) => t.startsWith("invoice.") || t.startsWith("payment."));

describe("when the CRM cannot take an announcement", () => {
  it("still issues the invoice with its number, and says on its history what could not be announced", async () => {
    const io = await invoiceOrg();
    const contactId = await contactIn(io);
    state.events = true;
    try {
      const inv = await issuedInvoice(io, { contactId }, NOW);
      expect(inv.invoice).toMatchObject({ status: "issued", number: "INV-0001" });
      const f = await failures(inv.invoice.id);
      expect(f.map((x) => x.detail.effect)).toEqual(["invoice.created", "invoice.issued"]);
      expect(f[0].detail.message).toContain("The outbox is down");
      expect(JSON.stringify(f)).not.toMatch(/postgres:|hunter2|db\.internal/);
    } finally {
      state.events = false;
    }
  });

  it("still records a payment, marks the invoice paid and tells the owner, though the announcement of it fails", async () => {
    const io = await invoiceOrg();
    const contactId = await contactIn(io);
    const inv = await issuedInvoice(io, { contactId }, NOW);
    state.events = true;
    try {
      const paid = await recordManualPayment(io.ctx("owner"), inv.invoice.id, cash("1500"), { now: NOW });
      expect(paid.invoice).toMatchObject({ paymentStatus: "paid", paidMinor: 150_000 });
    } finally {
      state.events = false;
    }
    expect((await getInvoiceDetail(io.ctx("owner"), inv.invoice.id)).invoice).toMatchObject({ paymentStatus: "paid", paidMinor: 150_000 });
    expect(await rows("select 1 from customer_payments where invoice_id = $1 and status = 'succeeded'", [inv.invoice.id])).toHaveLength(1);
    expect(await rows("select 1 from notifications where org_id = $1 and kind = 'invoice_paid'", [io.orgId])).not.toHaveLength(0);
    expect((await failures(inv.invoice.id)).map((x) => x.detail.effect)).toEqual(["invoice.paid"]);
    expect(await invoiceEventTypes(io.orgId)).toEqual(["invoice.created", "invoice.issued"]);
  });

  it("keeps a provider-confirmed payment, too, when the timeline line cannot be written; and the announcement is undone with the line, never half made", async () => {
    const io = await invoiceOrg();
    const conn = await connectionFor(io);
    const contactId = await contactIn(io);
    const inv = await issuedInvoice(io, { contactId }, NOW);
    state.activities = true;
    try {
      const p = await providerPayment(io, inv.invoice.id, conn, 150_000, { livemode: true });
      expect(p).toMatchObject({ counted: true, justPaid: true });
    } finally {
      state.activities = false;
    }
    expect(await rows("select 1 from customer_payments where invoice_id = $1 and status = 'succeeded'", [inv.invoice.id])).toHaveLength(1);
    expect(await invoiceEventTypes(io.orgId)).toEqual(["invoice.created", "invoice.issued"]);
    expect((await failures(inv.invoice.id)).map((x) => x.detail.effect).sort()).toEqual(["invoice.paid", "payment.verified"]);
  });

  it("voids an invoice whose announcement fails, and goes back to announcing normally afterwards", async () => {
    const io = await invoiceOrg();
    const contactId = await contactIn(io);
    const inv = await issuedInvoice(io, { contactId }, NOW);
    state.events = true;
    try {
      const voided = await voidInvoice(io.ctx("owner"), inv.invoice.id, { reason: "Raised for the wrong job" });
      expect(voided.invoice.status).toBe("void");
    } finally {
      state.events = false;
    }
    const next = await issuedInvoice(io, { contactId }, NOW);
    // The void was not announced; the next invoice's draft and issue are.
    expect(await invoiceEventTypes(io.orgId)).toEqual(["invoice.created", "invoice.issued", "invoice.created", "invoice.issued"]);
    expect((await failures(next.invoice.id))).toEqual([]);
    expect((await failures(inv.invoice.id)).map((x) => x.detail.effect)).toContain("invoice.voided");
    await withSystem(async (db) => expect((await db.query("select 1 from customer_invoices where id = $1 and status = 'void'", [inv.invoice.id])).rows).toHaveLength(1));
  });
});
