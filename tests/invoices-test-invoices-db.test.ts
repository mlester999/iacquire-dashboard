// Test invoices (decision D2) as the database keeps them, whatever the code does. A test invoice is made on purpose to try a payment account in test mode: nothing is owed on
// it and no money moves. So a payment a provider ran in test mode (livemode false) can sit only on a test invoice, a live payment never sits on one, the mark is fixed when the
// invoice leaves draft, a test invoice is never reminded about, and a test invoice (unlike a real one) can be voided or deleted with its test payments. Every probe that changes
// anything runs in a transaction that is always rolled back.
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { connectionFor, draftBy, invoiceOrg, issuedInvoice, issuedTestInvoice, providerPayment, rows, submittedInvoice, type InvoiceOrg } from "./support/invoices";
import { applyRefundInTx } from "@/server/invoices/apply";

class Done extends Error {}
type Db = { query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[]; rowCount: number }> };

async function tries(db: Db, sql: string, params: unknown[] = []): Promise<string | null> {
  await db.query("savepoint probe");
  try {
    await db.query(sql, params);
    await db.query("release savepoint probe");
    return null;
  } catch (e) {
    await db.query("rollback to savepoint probe");
    return String((e as Error).message);
  }
}

async function rolledBack(fn: (db: Db) => Promise<void>) {
  await expect(withSystem(async (db) => { await fn(db as Db); throw new Done(); })).rejects.toBeInstanceOf(Done);
}

const PAYMENT = `insert into customer_payments (org_id, invoice_id, connection_id, provider, provider_payment_id, amount_minor, currency, livemode, verification, status, received_at)
  values ($1, $2, $3, 'simulated', $4, 1000, 'PHP', $5, 'provider_confirmed', 'succeeded', now())`;
let n = 0;
const payId = () => `dbpay_${Date.now()}_${(n += 1)}`;

async function world(): Promise<{ io: InvoiceOrg; real: string; test: string; conn: string }> {
  const io = await invoiceOrg();
  const real = (await issuedInvoice(io)).invoice.id;
  const test = (await issuedTestInvoice(io)).invoice.id;
  return { io, real, test, conn: await connectionFor(io) };
}

describe("the test-invoice mark", () => {
  it("is a column that is off by default and can never be empty, and a test invoice has its own number counter that starts at one", async () => {
    const col = await rows<{ column_default: string; is_nullable: string }>("select column_default, is_nullable from information_schema.columns where table_name = 'customer_invoices' and column_name = 'is_test'");
    expect(col).toEqual([{ column_default: "false", is_nullable: "NO" }]);
    const counter = await rows<{ column_default: string; is_nullable: string }>("select column_default, is_nullable from information_schema.columns where table_name = 'customer_invoice_settings' and column_name = 'next_test_number'");
    expect(counter).toEqual([{ column_default: "1", is_nullable: "NO" }]);
    const w = await world();
    expect(await rows("select is_test from customer_invoices where id = any($1::uuid[]) order by is_test", [[w.real, w.test]])).toEqual([{ is_test: false }, { is_test: true }]);
  });

  it("is fixed when the invoice leaves draft: it can be changed while it is a draft, and never after it was submitted or issued", async () => {
    const io = await invoiceOrg();
    const draft = (await draftBy(io)).invoice.id;
    const pending = (await submittedInvoice(io, "owner")).invoice.id;
    const issued = (await issuedInvoice(io)).invoice.id;
    await rolledBack(async (db) => {
      expect(await tries(db, "update customer_invoices set is_test = true where id = $1", [draft])).toBeNull();
      expect(await tries(db, "update customer_invoices set is_test = false where id = $1", [draft])).toBeNull();
      // Submitting is the moment it leaves draft: the mark cannot change with it, and cannot change on the way back either.
      expect(await tries(db, "update customer_invoices set is_test = true where id = $1", [pending])).toMatch(/test invoice|left draft/i);
      expect(await tries(db, "update customer_invoices set status = 'draft', is_test = true where id = $1", [pending])).toMatch(/test invoice|left draft/i);
      expect(await tries(db, "update customer_invoices set is_test = true where id = $1", [issued])).toMatch(/test invoice|left draft/i);
    });
    // Issuing with the mark flipped in the same statement is refused too (the service never does it; a direct write must not be able to).
    const second = (await draftBy(io)).invoice.id;
    await rolledBack(async (db) => {
      const flip = await tries(
        db,
        `update customer_invoices set status = 'issued', is_test = true, number = 'FLIP-1', issue_on = current_date, due_on = current_date, content_hash = repeat('a', 64), approved_version = version,
           approved_by = created_by, approved_at = now(), issued_at = now(), issued_by = created_by where id = $1`, [second],
      );
      expect(flip).toMatch(/test invoice|left draft/i);
    });
  });

  it("never lets a test invoice be marked as the one that closes a deal", async () => {
    const io = await invoiceOrg();
    const draft = (await draftBy(io, "owner", { isTest: true })).invoice.id;
    await rolledBack(async (db) => {
      expect(await tries(db, "update customer_invoices set closes_deal = true where id = $1", [draft])).toMatch(/closes_deal|check/i);
    });
  });
});

describe("which payments each kind of invoice takes", () => {
  it("refuses a payment made in test mode on a real invoice, and a live payment on a test invoice, and takes the matching pairs", async () => {
    const w = await world();
    await rolledBack(async (db) => {
      expect(await tries(db, PAYMENT, [w.io.orgId, w.real, w.conn, payId(), false]), "test-mode payment, real invoice").toMatch(/test invoice/i);
      expect(await tries(db, PAYMENT, [w.io.orgId, w.test, w.conn, payId(), true]), "live payment, test invoice").toMatch(/test invoice/i);
      expect(await tries(db, PAYMENT, [w.io.orgId, w.test, w.conn, payId(), false]), "test-mode payment, test invoice").toBeNull();
      expect(await tries(db, PAYMENT, [w.io.orgId, w.real, w.conn, payId(), true]), "live payment, real invoice").toBeNull();
    });
  });

  it("refuses every status, not only a counted one: a payment kept for review or a failed try is a row too", async () => {
    const w = await world();
    await rolledBack(async (db) => {
      for (const status of ["pending", "failed", "needs_review"]) {
        const sql = PAYMENT.replace("'succeeded'", `'${status}'`);
        expect(await tries(db, sql, [w.io.orgId, w.real, w.conn, payId(), false]), status).toMatch(/test invoice/i);
      }
    });
  });

  it("refuses a payment recorded by hand on a test invoice (a person's word is real-world money, and nothing is owed on a test)", async () => {
    const w = await world();
    await rolledBack(async (db) => {
      const manual = await tries(
        db,
        `insert into customer_payments (org_id, invoice_id, provider, amount_minor, currency, livemode, verification, status, received_at, evidence)
         values ($1, $2, 'manual', 1000, 'PHP', true, 'manual', 'succeeded', now(), 'Cash, receipt 1')`, [w.io.orgId, w.test],
      );
      expect(manual).toMatch(/test invoice/i);
    });
  });
});

describe("a test invoice is never reminded about", () => {
  it("drops a reminder row for a test invoice without an error and keeps the one for a real invoice", async () => {
    const w = await world();
    await rolledBack(async (db) => {
      const insert = (invoiceId: string, step: string) =>
        db.query("insert into customer_invoice_reminders (org_id, invoice_id, step_key, due_at, status) values ($1, $2, $3, now() + interval '1 day', 'scheduled')", [w.io.orgId, invoiceId, step]);
      expect((await insert(w.test, "on_due:0")).rowCount).toBe(0);
      expect((await insert(w.real, "on_due:0")).rowCount).toBe(1);
      expect(await db.query("select 1 from customer_invoice_reminders where invoice_id = $1", [w.test])).toMatchObject({ rows: [] });
      expect((await db.query("select 1 from customer_invoice_reminders where invoice_id = $1", [w.real])).rows).toHaveLength(1);
    });
  });
});

describe("voiding and deleting", () => {
  it("lets a test invoice be voided with a test payment on it, and still refuses a real invoice that took money", async () => {
    const w = await world();
    await providerPayment(w.io, w.test, w.conn, 150000);
    await providerPayment(w.io, w.real, w.conn, 150000);
    await rolledBack(async (db) => {
      const void_ = (id: string) => tries(db, "update customer_invoices set status = 'void', voided_at = now(), public_token_hash = null where id = $1", [id]);
      expect(await void_(w.test)).toBeNull();
      expect(await void_(w.real)).toMatch(/check|void/i);
    });
  });

  it("lets a test invoice be deleted with its test payments, refunds and checkouts, and refuses to delete anything of a real invoice", async () => {
    const w = await world();
    const paid = await providerPayment(w.io, w.test, w.conn, 50000);
    await withSystem((db) => applyRefundInTx(db, { orgId: w.io.orgId, paymentId: paid.paymentId, amountMinor: 10000, source: "provider_event", providerRefundId: "dbref_1", reason: "A test refund", actor: { id: null, kind: "provider" } }));
    const realPaid = await providerPayment(w.io, w.real, w.conn, 50000);
    await rolledBack(async (db) => {
      await db.query(
        "insert into customer_payment_attempts (org_id, invoice_id, connection_id, currency, amount_minor, reference, status) values ($1, $2, $3, 'PHP', 100000, 'CP-' || substr(md5(random()::text), 1, 24), 'expired')", [w.io.orgId, w.test, w.conn],
      );
      // Children first, as the service does; each is allowed because the invoice is a test.
      expect(await tries(db, "delete from customer_refunds where invoice_id = $1", [w.test])).toBeNull();
      expect(await tries(db, "delete from customer_payments where invoice_id = $1", [w.test])).toBeNull();
      expect(await tries(db, "delete from customer_payment_attempts where invoice_id = $1", [w.test])).toBeNull();
      expect(await tries(db, "delete from customer_invoices where id = $1", [w.test])).toBeNull();
      expect((await db.query("select 1 from customer_invoice_lines where invoice_id = $1", [w.test])).rows).toHaveLength(0);
      // A real invoice and its money are never deleted.
      expect(await tries(db, "delete from customer_payments where id = $1", [realPaid.paymentId])).toMatch(/never deleted/);
      expect(await tries(db, "delete from customer_invoices where id = $1", [w.real])).toMatch(/cannot be deleted|foreign key/);
    });
  });
});
