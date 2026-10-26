import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { createCreditNoteDraft, issueCreditNote, cancelCreditNote } from "@/server/invoices/credit-notes";
import { recordManualPayment } from "@/server/invoices/payments";
import { splitStatements } from "./support/staff-messages";
import { invoiceOrg, issuedInvoice } from "./support/invoices";

// Migration 0111: credit notes. The rollback refuses while a credit note has been issued (it is a commercial record), and otherwise puts the invoices back on the 0093 arithmetic, the
// 0093 checks and the 0093 guard, takes the table, the permission and the numbering columns away, and leaves every payment and every invoice as it was. Each run is rolled back.

class Done extends Error {}
const down = readFileSync("supabase/rollbacks/0111_customer_credit_notes.down.sql", "utf8");
type Db = { query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[]; rowCount: number }> };
const runDown = async (db: Db) => {
  for (const stmt of splitStatements(down)) await db.query(stmt);
};
const rolledBack = (fn: (db: Db) => Promise<void>) =>
  withSystem(async (db) => {
    await fn(db);
    throw new Done();
  }).catch((e) => {
    if (!(e instanceof Done)) throw e;
  });

const NOW = new Date("2026-10-26T12:00:00Z");
const pay = { receivedOn: "2026-10-26", method: "bank_transfer" as const, evidence: "Bank transfer ref 7731" };

describe("the rollback of 0111", () => {
  it("runs when only drafts and cancelled notes exist, and restores the 0093 invoice arithmetic, checks, guard and numbering", async () => {
    const io = await invoiceOrg();
    const unpaid = (await issuedInvoice(io, {}, NOW)).invoice;
    const paid = (await issuedInvoice(io, {}, NOW)).invoice;
    await recordManualPayment(io.ctx("owner"), paid.id, { ...pay, amount: "1500.00" }, { now: NOW });
    await createCreditNoteDraft(io.ctx("owner"), { invoiceId: unpaid.id, amount: "100.00", reason: "A draft that stays a draft" });
    const gone = await createCreditNoteDraft(io.ctx("owner"), { invoiceId: unpaid.id, amount: "100.00", reason: "A note that will be cancelled" });
    await cancelCreditNote(io.ctx("owner"), gone.id, "Raised twice by mistake");
    await rolledBack(async (db) => {
      await runDown(db);
      expect((await db.query<{ t: string | null }>("select to_regclass('customer_credit_notes')::text as t")).rows[0].t).toBeNull();
      expect((await db.query("select 1 from information_schema.columns where table_name = 'customer_invoices' and column_name = 'credited_minor'")).rows).toHaveLength(0);
      for (const c of ["next_credit_number", "credit_number_prefix"]) expect((await db.query("select 1 from information_schema.columns where table_name = 'customer_invoice_settings' and column_name = $1", [c])).rows, c).toHaveLength(0);
      expect((await db.query("select 1 from role_permissions where permission = 'invoices.credit'")).rows).toHaveLength(0);
      // The generated columns are the 0093 ones again, and nothing about the invoices themselves changed.
      const rows = (await db.query<{ id: string; balance_minor: string; overpaid_minor: string; paid_minor: string; payment_status: string }>(
        "select id, balance_minor::text, overpaid_minor::text, paid_minor::text, payment_status from customer_invoices where id = any($1::uuid[]) order by id", [[unpaid.id, paid.id].sort()],
      )).rows;
      const byId = new Map(rows.map((r) => [r.id, r]));
      expect(byId.get(unpaid.id)).toMatchObject({ balance_minor: "150000", overpaid_minor: "0", paid_minor: "0", payment_status: "unpaid" });
      expect(byId.get(paid.id)).toMatchObject({ balance_minor: "0", overpaid_minor: "0", paid_minor: "150000", payment_status: "paid" });
      // The old status list is back: 'credited' is not a status any more.
      await db.query("savepoint probe");
      await expect(db.query("update customer_invoices set payment_status = 'credited' where id = $1", [unpaid.id])).rejects.toThrow();
      await db.query("rollback to savepoint probe");
      // The guard no longer mentions credit notes.
      const src = (await db.query<{ prosrc: string }>("select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = 'customer_invoice_guard'")).rows[0].prosrc;
      expect(src).not.toMatch(/credit/i);
      expect((await db.query("select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname like 'customer_credit_note%'")).rows).toHaveLength(0);
    });
  });

  // Last: it issues a credit note, which the database keeps, and the rollback above needs a database with none.
  it("refuses while a credit note has been issued, and says why", async () => {
    const io = await invoiceOrg();
    const inv = (await issuedInvoice(io, {}, NOW)).invoice;
    const note = await createCreditNoteDraft(io.ctx("owner"), { invoiceId: inv.id, amount: "100.00", reason: "Goodwill for a delay" });
    await issueCreditNote(io.ctx("owner"), note.id, { version: 1 }, { now: NOW });
    await expect(rolledBack(runDown)).rejects.toThrow(/Rollback refused: credit notes have been issued/);
  });
});

describe("the schema 0111 leaves", () => {
  it("grants the credit columns and the notes to the application role for reading only, and nothing to anyone else", async () => {
    const [t] = (await withSystem((db) => db.query<{ s: boolean; i: boolean; u: boolean; d: boolean }>(
      `select has_table_privilege('iaq_app_user', 'customer_credit_notes', 'select') as s, has_table_privilege('iaq_app_user', 'customer_credit_notes', 'insert') as i,
              has_table_privilege('iaq_app_user', 'customer_credit_notes', 'update') as u, has_table_privilege('iaq_app_user', 'customer_credit_notes', 'delete') as d`,
    ))).rows;
    expect(t).toEqual({ s: true, i: false, u: false, d: false });
    for (const role of ["anon", "authenticated"]) {
      const exists = (await withSystem((db) => db.query<{ ok: boolean }>("select exists (select 1 from pg_roles where rolname = $1) as ok", [role]))).rows[0].ok;
      if (!exists) continue;
      expect((await withSystem((db) => db.query<{ ok: boolean }>("select has_table_privilege($1, 'customer_credit_notes', 'select') as ok", [role]))).rows[0].ok, role).toBe(false);
    }
    const cols = (await withSystem((db) => db.query<{ c: string; ok: boolean }>(
      "select c as c, has_column_privilege('iaq_app_user', 'customer_invoices', c, 'select') as ok from unnest(array['credited_minor', 'balance_minor', 'overpaid_minor']) as c",
    ))).rows;
    expect(cols.map((r) => [r.c, r.ok])).toEqual([["credited_minor", true], ["balance_minor", true], ["overpaid_minor", true]]);
  });
});
