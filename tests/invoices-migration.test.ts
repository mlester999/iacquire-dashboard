import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { CURRENCY_CODES } from "@/lib/money";
import { ORG_ROLES, PERMISSION_MATRIX } from "@/lib/permissions";
import { recordManualPayment, recordRefund } from "@/server/invoices/payments";
import { connectionFor, draftBy, invoiceOrg, issuedInvoice, providerPayment, rows, submittedInvoice } from "./support/invoices";
import { uid } from "./support/fixtures";

// Migration 0093 on embedded Postgres: what the database refuses whatever the code does (frozen invoices, payments that must add up, tenant-bound foreign keys), who can
// read what, and that the rollback puts back exactly what it replaced and refuses while a financial record exists. Every probe that changes anything runs in a transaction
// that is always rolled back.

class Done extends Error {}
const down = readFileSync("supabase/rollbacks/0093_customer_invoices_payments.down.sql", "utf8");

/** Splits a script into statements, keeping `$$ ... $$` bodies whole (the test driver runs one statement per call). */
function statements(sql: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let inside = false;
  for (const raw of sql.split("\n")) {
    const line = raw.replace("\r", "");
    if (!inside && (line.trim() === "" || line.trim().startsWith("--"))) continue;
    cur.push(line);
    if (line.split("$$").length % 2 === 0) inside = !inside;
    if (!inside && line.trimEnd().endsWith(";")) {
      out.push(cur.join("\n"));
      cur = [];
    }
  }
  return out;
}

type Db = { query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[]; rowCount: number }> };

/** Runs a statement that may fail inside a savepoint and returns the error text, or null when it worked. */
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

/** Runs `fn` and always rolls everything back. */
async function rolledBack(fn: (db: Db) => Promise<void>) {
  await expect(
    withSystem(async (db) => {
      await fn(db as Db);
      throw new Done();
    }),
  ).rejects.toBeInstanceOf(Done);
}

const quoted = (def: string) => [...def.matchAll(/'([A-Za-z0-9_]+)'::text/g)].map((m) => m[1]);
const TABLES = ["customer_invoice_settings", "customer_payment_connections", "customer_invoices", "customer_invoice_lines", "customer_invoice_events", "customer_invoice_reminders", "customer_payment_attempts", "customer_payments", "customer_refunds", "customer_payment_events"];
/** Children before parents, so everything but the settings can be deleted. */
const CLEAR_ORDER = ["customer_payment_events", "customer_refunds", "customer_payments", "customer_payment_attempts", "customer_invoice_reminders", "customer_invoice_events", "customer_invoice_lines", "customer_invoices", "customer_payment_connections"];

describe("permissions, scope and kinds", () => {
  it("seeds the invoices permissions for exactly the roles the matrix names, and for no agency role", async () => {
    const seeded = (await rows<{ role: string; permission: string }>("select role, permission from role_permissions where permission like 'invoices.%'")).map((r) => `${r.role}:${r.permission}`).sort();
    const expected = (Object.keys(PERMISSION_MATRIX) as Array<keyof typeof PERMISSION_MATRIX>)
      .filter((p) => p.startsWith("invoices."))
      .flatMap((p) => PERMISSION_MATRIX[p].map((role) => `${role}:${p}`))
      .sort();
    expect(expected.length).toBeGreaterThan(15);
    expect(seeded).toEqual(expected);
    expect(seeded.every((s) => (ORG_ROLES as readonly string[]).includes(s.split(":")[0]))).toBe(true);
  });

  it("allows only the owner to refund, change settings and connect a payment account, and gives agency roles no invoice permission", () => {
    for (const p of ["invoices.refund", "invoices.settings", "invoices.connect_payments"] as const) expect([...PERMISSION_MATRIX[p]]).toEqual(["owner"]);
    for (const p of Object.keys(PERMISSION_MATRIX).filter((x) => x.startsWith("invoices."))) {
      expect([...PERMISSION_MATRIX[p as keyof typeof PERMISSION_MATRIX]].filter((r) => r.startsWith("agency_"))).toEqual([]);
    }
  });

  it("keeps the database currency lists in step with the money module's table", async () => {
    const defs = await rows<{ t: string; d: string }>(
      `select conrelid::regclass::text as t, pg_get_constraintdef(oid) as d from pg_constraint where contype = 'c' and conrelid::regclass::text = any($1::text[]) and pg_get_constraintdef(oid) like '%currency%'`,
      [["customer_invoices", "customer_payments", "customer_refunds", "customer_payment_attempts", "customer_invoice_settings"]],
    );
    expect(defs.length).toBe(5);
    for (const d of defs) expect(quoted(d.d).sort(), d.t).toEqual([...CURRENCY_CODES].sort());
  });

  it("accepts the billing message scope, keeps the earlier ones and refuses an unknown one", async () => {
    const io = await invoiceOrg();
    const contact = (await rows<{ id: string }>("insert into contacts (org_id, display_name) values ($1, 'Scope Probe') returning id", [io.orgId]))[0].id;
    await rolledBack(async (db) => {
      const conv = (await db.query<{ id: string }>("insert into conversations (org_id, contact_id, channel, status, owner_kind) values ($1, $2, 'sms', 'open', 'unassigned') returning id", [io.orgId, contact])).rows[0].id;
      const insert = (scope: string) =>
        tries(db, "insert into conversation_messages (org_id, conversation_id, direction, author_kind, body, status, failed_at, failure_kind, scope) values ($1, $2, 'outbound', 'human', 'x', 'failed', now(), 'rejected', $3)", [io.orgId, conv, scope]);
      for (const ok of ["billing", "reply", "followup", "human", "reminder", "retention"]) expect(await insert(ok), ok).toBeNull();
      expect(await insert("nonsense")).toMatch(/scope_check/);
    });
  });

  it("adds the eight notification kinds and keeps every other one", async () => {
    const def = (await rows<{ d: string }>("select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'notifications_kind_check'"))[0].d;
    const kinds = new Set(quoted(def));
    for (const k of ["invoice_approval_requested", "invoice_approval_decided", "invoice_paid", "invoice_payment_failed", "invoice_overdue", "invoice_refund_recorded", "payment_connection_attention", "payment_review_needed"]) expect(kinds.has(k), k).toBe(true);
    for (const k of ["social_post_failed", "web_chat_lead", "billing_payment_received", "support_sla"]) expect(kinds.has(k), k).toBe(true);
  });
});

describe("who can read and write what", () => {
  it("has row-level security on all ten tables and gives the application role select only, with the secrets withheld", async () => {
    const meta = await rows<{ relname: string; rls: boolean; ins: boolean; upd: boolean; del: boolean; anon: boolean; auth: boolean; site: boolean }>(
      `select c.relname, c.relrowsecurity as rls, has_table_privilege('iaq_app_user', c.oid, 'insert') as ins, has_table_privilege('iaq_app_user', c.oid, 'update') as upd,
         has_table_privilege('iaq_app_user', c.oid, 'delete') as del, has_any_column_privilege('anon', c.oid, 'select, insert, update') as anon,
         has_any_column_privilege('authenticated', c.oid, 'select, insert, update') as auth, has_any_column_privilege('iaq_site_runtime', c.oid, 'select, insert, update') as site
       from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname = any($1::text[])`, [TABLES],
    );
    expect(meta.map((m) => m.relname).sort()).toEqual([...TABLES].sort());
    for (const m of meta) expect(m, m.relname).toMatchObject({ rls: true, ins: false, upd: false, del: false, anon: false, auth: false, site: false });
    const can = async (table: string, col: string) => (await rows<{ ok: boolean }>("select has_column_privilege('iaq_app_user', $1, $2, 'select') as ok", [`public.${table}`, col]))[0].ok;
    expect(await can("customer_payment_connections", "credentials")).toBe(false);
    expect(await can("customer_payment_connections", "public_key")).toBe(true);
    expect(await can("customer_invoices", "public_token_hash")).toBe(false);
    expect(await can("customer_invoices", "total_minor")).toBe(true);
    expect(await can("customer_payment_attempts", "checkout_url")).toBe(false);
    expect(await can("customer_payment_attempts", "reference")).toBe(true);
    // The webhook receipts are server-only: no column at all.
    const receipts = await rows<{ ok: boolean }>("select has_any_column_privilege('iaq_app_user', 'public.customer_payment_events', 'select') as ok");
    expect(receipts[0].ok).toBe(false);
  });

  it("holds no card data and no raw provider message: no column is named for either", async () => {
    const cols = await rows<{ table_name: string; column_name: string }>("select table_name, column_name from information_schema.columns where table_schema = 'public' and table_name = any($1::text[])", [TABLES]);
    expect(cols.length).toBeGreaterThan(150);
    const bad = cols.filter((c) => /(^|_)(card|pan|cvv|cvc|cvn|expiry|exp_month|exp_year|iban|account_number|routing)(_|$)|^(payload|body|request_body|response_body)$|^raw_/.test(c.column_name));
    expect(bad).toEqual([]);
    // Only the fingerprint of a webhook body is kept, never the body.
    expect(cols.filter((c) => c.table_name === "customer_payment_events").map((c) => c.column_name)).toContain("payload_sha256");
  });

  it("lets the owner, manager and sales rep read their workspace's invoices, withholds the payment connection from all but the owner, and shows nothing to a viewer or another workspace", async () => {
    const a = await invoiceOrg();
    const b = await invoiceOrg();
    const inv = await issuedInvoice(a);
    await connectionFor(a);
    const count = (who: Parameters<typeof a.ctx>[0], org: typeof a, table: string) => withUser(org.ctx(who).user.id, async (db) => Number((await db.query<{ n: string }>(`select count(*)::text as n from ${table}`)).rows[0].n));
    for (const who of ["owner", "manager", "sales"] as const) expect(await count(who, a, "customer_invoices"), who).toBeGreaterThan(0);
    expect(await count("owner", a, "customer_payment_connections")).toBe(1);
    expect(await count("manager", a, "customer_payment_connections")).toBe(0);
    expect(await count("sales", a, "customer_payment_connections")).toBe(0);
    for (const who of ["viewer", "support", "setter"] as const) expect(await count(who, a, "customer_invoices"), who).toBe(0);
    // Another workspace's owner sees none of it, and cannot name its rows.
    expect(await count("owner", b, "customer_invoices")).toBe(0);
    const peek = await withUser(b.ctx("owner").user.id, async (db) => (await db.query("select id from customer_invoices where id = $1", [inv.invoice.id])).rows.length);
    expect(peek).toBe(0);
    // A person of A who is not a member of B reads nothing of B's either.
    const cross = await withUser(a.ctx("owner").user.id, async (db) => (await db.query("select id from customer_invoices where org_id = $1", [b.orgId])).rows.length);
    expect(cross).toBe(0);
  });
});

describe("an invoice is frozen once it leaves draft", () => {
  it("refuses totals that are not the sum of the lines when an invoice is submitted or issued, and an invoice with no lines", async () => {
    const io = await invoiceOrg();
    const d = await draftBy(io);
    await rolledBack(async (db) => {
      await db.query("update customer_invoices set total_minor = 9999, subtotal_minor = 9999 where id = $1", [d.invoice.id]);
      expect(await tries(db, "update customer_invoices set status = 'pending_approval' where id = $1", [d.invoice.id])).toMatch(/sum of its lines/);
      expect(await tries(db, "update customer_invoices set status = 'issued', number = 'X-1', content_hash = repeat('a', 64), issue_on = current_date, due_on = current_date, approved_version = 1, issued_at = now() where id = $1", [d.invoice.id])).toMatch(/sum of its lines/);
    });
    const empty = await draftBy(io, "owner", { lines: [] });
    await rolledBack(async (db) => {
      expect(await tries(db, "update customer_invoices set status = 'pending_approval' where id = $1", [empty.invoice.id])).toMatch(/sum of its lines/);
    });
  });

  it("refuses any change to the amounts, dates, wording, number and frozen details of an issued invoice, and every illegal status change", async () => {
    const io = await invoiceOrg();
    const inv = (await issuedInvoice(io)).invoice;
    await rolledBack(async (db) => {
      for (const set of ["total_minor = total_minor + 1", "subtotal_minor = subtotal_minor + 1", "tax_minor = 1", "due_on = due_on + 1", "issue_on = issue_on - 1", "notes = 'changed'", "terms = 'changed'", "payment_instructions = 'changed'",
        "number = 'HACK-1'", "content_hash = repeat('b', 64)", "currency = 'USD'", "tax_inclusive = true", "bill_from = '{}'::jsonb", "version = version + 1", "closes_deal = true", "approved_version = null"]) {
        expect(await tries(db, `update customer_invoices set ${set} where id = $1`, [inv.id]), set).toMatch(/left draft|cannot|check|violates/);
      }
      // The customer's details may be erased, not rewritten.
      expect(await tries(db, `update customer_invoices set bill_to = '{"name": "Someone else"}'::jsonb where id = $1`, [inv.id])).toMatch(/only be erased/);
      expect(await tries(db, `update customer_invoices set bill_to = '{"erased": true}'::jsonb where id = $1`, [inv.id])).toBeNull();
      // Back to draft, sideways to pending, or forward to anything but void: no.
      expect(await tries(db, "update customer_invoices set status = 'draft' where id = $1", [inv.id])).toMatch(/cannot go from issued to draft/);
      expect(await tries(db, "update customer_invoices set status = 'pending_approval' where id = $1", [inv.id])).toMatch(/cannot go from issued/);
      expect(await tries(db, "update customer_invoices set status = 'void', voided_at = now() where id = $1", [inv.id])).toBeNull();
      expect(await tries(db, "update customer_invoices set status = 'issued' where id = $1", [inv.id])).toMatch(/cannot go from void/);
    });
  });

  it("freezes the lines with the invoice, lets a draft's lines change, and lets a draft be deleted with its lines and history but not an issued invoice", async () => {
    const io = await invoiceOrg();
    const issued = (await issuedInvoice(io)).invoice;
    const draft = (await draftBy(io)).invoice;
    await rolledBack(async (db) => {
      const insert = `insert into customer_invoice_lines (org_id, invoice_id, position, description, quantity_milli, unit_price_minor, gross_minor, discount_minor, net_minor, tax_minor, total_minor, ex_tax_minor)
        values ($1, $2, 9, 'x', 1000, 100, 100, 0, 100, 0, 100, 100)`;
      expect(await tries(db, insert, [io.orgId, issued.id])).toMatch(/only while it is a draft/);
      expect(await tries(db, "update customer_invoice_lines set description = 'x' where invoice_id = $1", [issued.id])).toMatch(/only while it is a draft/);
      expect(await tries(db, "delete from customer_invoice_lines where invoice_id = $1", [issued.id])).toMatch(/only while it is a draft/);
      expect(await tries(db, insert, [io.orgId, draft.id])).toBeNull();
      expect(await tries(db, "delete from customer_invoices where id = $1", [issued.id])).toMatch(/cannot be deleted/);
      // A draft goes with its lines and its history (the append-only history allows the cascade of a deleted draft).
      expect(await tries(db, "delete from customer_invoices where id = $1", [draft.id])).toBeNull();
      expect((await db.query("select 1 from customer_invoice_lines where invoice_id = $1", [draft.id])).rows).toHaveLength(0);
      expect((await db.query("select 1 from customer_invoice_events where invoice_id = $1", [draft.id])).rows).toHaveLength(0);
      // A purge of a departed client's data is the one thing that can delete an issued invoice.
      await db.query("select set_config('iaq.purge', 'on', true)");
      expect(await tries(db, "delete from customer_invoices where id = $1", [issued.id])).toBeNull();
    });
  });

  it("keeps the history append-only", async () => {
    const io = await invoiceOrg();
    const inv = (await issuedInvoice(io)).invoice;
    await rolledBack(async (db) => {
      expect(await tries(db, "update customer_invoice_events set kind = 'edited' where invoice_id = $1", [inv.id])).toMatch(/append-only/);
      expect(await tries(db, "delete from customer_invoice_events where invoice_id = $1", [inv.id])).toMatch(/append-only/);
    });
  });

  it("finds an invoice by the hash of its link through an index, and lets no two invoices share a link", async () => {
    const io = await invoiceOrg();
    const a = (await issuedInvoice(io)).invoice;
    const b = (await issuedInvoice(io)).invoice;
    const idx = await rows<{ indexdef: string }>("select indexdef from pg_indexes where indexname = 'customer_invoices_token_idx'");
    expect(idx[0].indexdef).toMatch(/UNIQUE.*\(public_token_hash\)/);
    const hashA = (await rows<{ public_token_hash: string }>("select public_token_hash from customer_invoices where id = $1", [a.id]))[0].public_token_hash;
    await rolledBack(async (db) => {
      expect(await tries(db, "update customer_invoices set public_token_hash = $2 where id = $1", [b.id, hashA])).toMatch(/unique|duplicate/);
    });
    expect((await rows("select 1 from pg_indexes where indexname = 'customer_payment_attempts_checkout_idx'"))).toHaveLength(1);
  });

  it("gives an issued invoice its number once, per workspace, and refuses an issued invoice without one", async () => {
    const io = await invoiceOrg();
    const other = await invoiceOrg();
    const first = (await issuedInvoice(io)).invoice;
    const second = await draftBy(io);
    const foreign = (await issuedInvoice(other)).invoice;
    expect(foreign.number).toBe(first.number);
    await rolledBack(async (db) => {
      expect(await tries(db, "update customer_invoices set status = 'issued', number = $2, content_hash = repeat('a', 64), issue_on = current_date, due_on = current_date, approved_version = 1, issued_at = now() where id = $1", [second.invoice.id, first.number])).toMatch(/unique|duplicate/);
      expect(await tries(db, "update customer_invoices set status = 'issued', number = 'INV-0777', content_hash = repeat('a', 64), issue_on = current_date, due_on = current_date, approved_version = 1, issued_at = now() where id = $1", [second.invoice.id])).toBeNull();
    });
    await rolledBack(async (db) => {
      expect(await tries(db, "update customer_invoices set status = 'issued', content_hash = repeat('a', 64), issue_on = current_date, due_on = current_date, approved_version = 1, issued_at = now() where id = $1", [second.invoice.id])).toMatch(/check|violates/);
    });
  });
});

describe("an invoice starts unpaid", () => {
  const issue = (extra: string) => `update customer_invoices set status = 'issued', number = $2, content_hash = repeat('a', 64), issue_on = current_date, due_on = current_date, approved_version = 1, issued_at = now()${extra ? `, ${extra}` : ""} where id = $1`;
  const WITH_MONEY: Array<[string, string]> = [
    ["a paid amount and the status paid", "paid_minor = total_minor, payment_status = 'paid'"],
    ["part of the total paid", "paid_minor = 100, payment_status = 'partially_paid'"],
    ["a paid amount that was refunded", "paid_minor = 100, refunded_minor = 100, payment_status = 'partially_paid'"],
    ["the status disputed", "payment_status = 'disputed'"],
    ["a write-off", "written_off_at = now()"],
  ];

  it("refuses to issue a draft, or a submitted invoice, that already says it was paid, refunded, disputed or written off, whatever the code does, and lets the plain issue through", async () => {
    const io = await invoiceOrg();
    for (const [label, make] of [["a draft", () => draftBy(io)], ["a submitted invoice", () => submittedInvoice(io, "sales")]] as const) {
      const inv = (await make()).invoice;
      await rolledBack(async (db) => {
        for (const [what, extra] of WITH_MONEY) {
          expect(await tries(db, issue(extra), [inv.id, `INV-${uid()}`.slice(0, 12)]), `${label} issued with ${what}`).toMatch(/An invoice starts unpaid when it is issued/);
        }
        // Nothing of it stuck, and the plain issue is fine: an invoice that was issued with nothing paid is the only kind that exists.
        expect((await db.query<{ status: string }>("select status from customer_invoices where id = $1", [inv.id])).rows[0].status).not.toBe("issued");
        expect(await tries(db, issue(""), [inv.id, "INV-0901"])).toBeNull();
        expect((await db.query<{ paid_minor: string; payment_status: string }>("select paid_minor::text, payment_status from customer_invoices where id = $1", [inv.id])).rows[0]).toEqual({ paid_minor: "0", payment_status: "unpaid" });
      });
    }
  });

  it("is only ever inserted as a draft with nothing paid: an issued, void or submitted invoice, or one with a payment already on it, is refused at the door", async () => {
    const io = await invoiceOrg();
    const row = (extra: string, values: string) => `insert into customer_invoices (org_id, currency${extra}) values ($1, 'PHP'${values})`;
    await rolledBack(async (db) => {
      expect(await tries(db, row("", ""), [io.orgId])).toBeNull();
      expect(await tries(db, row(", status", ", 'pending_approval'"), [io.orgId])).toMatch(/An invoice is created as a draft/);
      expect(await tries(db, row(", status", ", 'void'"), [io.orgId])).toMatch(/An invoice is created as a draft/);
      expect(await tries(db, row(", status, number, content_hash, issue_on, due_on, subtotal_minor, total_minor, approved_version, issued_at, paid_minor, payment_status", ", 'issued', 'INV-0902', repeat('a', 64), current_date, current_date, 100, 100, 1, now(), 100, 'paid'"), [io.orgId])).toMatch(/An invoice is created as a draft/);
      expect(await tries(db, row(", paid_minor, payment_status", ", 100, 'partially_paid'"), [io.orgId])).toMatch(/An invoice is created as a draft/);
      expect(await tries(db, row(", written_off_at", ", now()"), [io.orgId])).toMatch(/An invoice is created as a draft/);
      // A draft's own edits and its deletion are untouched by the door.
      const made = (await db.query<{ id: string }>(row("", "") + " returning id", [io.orgId])).rows[0].id;
      expect(await tries(db, "update customer_invoices set notes = 'edited' where id = $1", [made])).toBeNull();
      expect(await tries(db, "delete from customer_invoices where id = $1", [made])).toBeNull();
    });
  });
});

describe("payments must add up", () => {
  it("refuses a paid amount or status on an invoice that its payment rows do not add up to, and lets the right values through", async () => {
    const io = await invoiceOrg();
    // A test invoice, so the payment row below can be a provider's test-mode one (a real invoice takes live payments only: tests/invoices-test-invoices-db.test.ts).
    const inv = (await issuedInvoice(io, { isTest: true })).invoice;
    const conn = await connectionFor(io);
    await rolledBack(async (db) => {
      expect(await tries(db, "update customer_invoices set paid_minor = 100000, payment_status = 'paid' where id = $1", [inv.id])).toMatch(/must equal what its payments/);
      expect(await tries(db, "update customer_invoices set paid_minor = 1, payment_status = 'partially_paid' where id = $1", [inv.id])).toMatch(/must equal what its payments/);
      expect(await tries(db, "update customer_invoices set payment_status = 'paid' where id = $1", [inv.id])).toMatch(/must equal what its payments/);
      await db.query(
        `insert into customer_payments (org_id, invoice_id, connection_id, provider, provider_payment_id, amount_minor, currency, livemode, verification, status, received_at)
         values ($1, $2, $3, 'simulated', 'pay_1', 50000, 'PHP', false, 'provider_confirmed', 'succeeded', now())`, [io.orgId, inv.id, conn],
      );
      // The payment row alone changes nothing on the invoice; the invoice may then be set to exactly its sum, and not to anything else.
      expect(await tries(db, "update customer_invoices set paid_minor = 60000, payment_status = 'partially_paid' where id = $1", [inv.id])).toMatch(/must equal what its payments/);
      expect(await tries(db, "update customer_invoices set paid_minor = 50000, payment_status = 'paid' where id = $1", [inv.id])).toMatch(/must equal what its payments|check|violates/);
      expect(await tries(db, "update customer_invoices set paid_minor = 50000, payment_status = 'partially_paid' where id = $1", [inv.id])).toBeNull();
      // A payment arriving for a draft, a submitted or a void invoice cannot be counted either.
      expect((await db.query<{ balance_minor: string; overpaid_minor: string }>("select balance_minor::text, overpaid_minor::text from customer_invoices where id = $1", [inv.id])).rows[0]).toMatchObject({ balance_minor: "100000", overpaid_minor: "0" });
    });
  });

  it("will not let a payment name another workspace's invoice, another currency, a duplicate provider id, or a manual record without evidence", async () => {
    const a = await invoiceOrg();
    const b = await invoiceOrg();
    // The provider rows are test-mode ones, so they sit on a test invoice; the rows recorded by hand are real-world money, so they sit on a real one.
    const inv = (await issuedInvoice(a, { isTest: true })).invoice;
    const real = (await issuedInvoice(a)).invoice;
    const connA = await connectionFor(a);
    const connB = await connectionFor(b);
    const base = `insert into customer_payments (org_id, invoice_id, connection_id, provider, provider_payment_id, amount_minor, currency, livemode, verification, status, received_at)`;
    await rolledBack(async (db) => {
      // The invoice and the workspace and the currency are one composite foreign key.
      expect(await tries(db, `${base} values ($1, $2, $3, 'simulated', 'p1', 100, 'PHP', false, 'provider_confirmed', 'succeeded', now())`, [b.orgId, inv.id, connB])).toMatch(/foreign key|violates/);
      expect(await tries(db, `${base} values ($1, $2, $3, 'simulated', 'p2', 100, 'USD', false, 'provider_confirmed', 'succeeded', now())`, [a.orgId, inv.id, connA])).toMatch(/foreign key|violates/);
      expect(await tries(db, `${base} values ($1, $2, $3, 'simulated', 'p3', 100, 'PHP', false, 'provider_confirmed', 'succeeded', now())`, [a.orgId, inv.id, connB])).toMatch(/foreign key|violates/);
      expect(await tries(db, `${base} values ($1, $2, $3, 'simulated', 'p4', 100, 'PHP', false, 'provider_confirmed', 'succeeded', now())`, [a.orgId, inv.id, connA])).toBeNull();
      expect(await tries(db, `${base} values ($1, $2, $3, 'simulated', 'p4', 100, 'PHP', false, 'provider_confirmed', 'succeeded', now())`, [a.orgId, inv.id, connA])).toMatch(/unique|duplicate/);
      // A provider payment needs its provider's id and a connection; a manual one needs neither but must say how it is known.
      expect(await tries(db, `${base} values ($1, $2, null, 'manual', null, 100, 'PHP', true, 'manual', 'succeeded', now())`, [a.orgId, real.id])).toMatch(/check|violates/);
      expect(await tries(db, `${base} values ($1, $2, null, 'manual', null, 100, 'PHP', true, 'provider_confirmed', 'succeeded', now())`, [a.orgId, real.id])).toMatch(/check|violates/);
      expect(await tries(db, `${base.replace(")", ", evidence)")} values ($1, $2, null, 'manual', null, 100, 'PHP', true, 'manual', 'succeeded', now(), 'bank ref 123')`, [a.orgId, real.id])).toBeNull();
      expect(await tries(db, `${base} values ($1, $2, $3, 'simulated', null, 100, 'PHP', false, 'provider_confirmed', 'succeeded', now())`, [a.orgId, inv.id, connA])).toMatch(/check|violates/);
      expect(await tries(db, `${base} values ($1, $2, $3, 'simulated', 'p5', 0, 'PHP', false, 'provider_confirmed', 'succeeded', now())`, [a.orgId, inv.id, connA])).toMatch(/check|violates/);
    });
  });

  it("never changes a recorded payment's amount or source, never deletes it, and lets only the allowed status moves through", async () => {
    const io = await invoiceOrg();
    const inv = (await issuedInvoice(io)).invoice;
    const conn = await connectionFor(io);
    const paid = await providerPayment(io, inv.id, conn, 40000);
    const failed = await providerPayment(io, inv.id, conn, 1000, { status: "failed" });
    await rolledBack(async (db) => {
      for (const set of ["amount_minor = 1", "currency = 'USD'", "livemode = false", "verification = 'manual'", "tax_portion_minor = 5", "received_at = now() + interval '1 day'", "provider_payment_id = 'other'"]) {
        expect(await tries(db, `update customer_payments set ${set} where id = $1`, [paid.paymentId]), set).toMatch(/cannot be changed|check|violates|foreign key|unique/);
      }
      expect(await tries(db, "delete from customer_payments where id = $1", [paid.paymentId])).toMatch(/never deleted/);
      expect(await tries(db, "update customer_payments set status = 'pending' where id = $1", [paid.paymentId])).toMatch(/cannot become/);
      expect(await tries(db, "update customer_payments set status = 'succeeded' where id = $1", [failed.paymentId])).toMatch(/cannot become/);
      expect(await tries(db, "update customer_payments set status = 'disputed' where id = $1", [paid.paymentId])).toBeNull();
    });
  });

  it("keeps the refunds of a payment within the payment, and refuses a refund of money that was never received", async () => {
    const io = await invoiceOrg();
    const inv = (await issuedInvoice(io)).invoice;
    const conn = await connectionFor(io);
    const paid = await providerPayment(io, inv.id, conn, 40000);
    const pending = await providerPayment(io, inv.id, conn, 5000, { status: "pending" });
    const refund = (amount: number, status = "succeeded") =>
      `insert into customer_refunds (org_id, payment_id, invoice_id, currency, amount_minor, status, source, reason) values ('${io.orgId}', '${paid.paymentId}', '${inv.id}', 'PHP', ${amount}, '${status}', 'manual_record', 'test refund')`;
    await rolledBack(async (db) => {
      // A refund names the payment's own invoice and currency.
      expect(await tries(db, `insert into customer_refunds (org_id, payment_id, invoice_id, currency, amount_minor, status, source, reason) values ($1, $2, $3, 'USD', 100, 'succeeded', 'manual_record', 'x y z')`, [io.orgId, paid.paymentId, inv.id])).toMatch(/foreign key|violates/);
      expect(await tries(db, refund(25000))).toBeNull();
      expect(await tries(db, refund(15001))).toMatch(/cannot add up to more than the payment/);
      expect(await tries(db, refund(15000))).toBeNull();
      expect(await tries(db, refund(1))).toMatch(/cannot add up to more than the payment/);
      // A refund that is only pending counts for nothing yet.
      expect(await tries(db, refund(10, "pending"))).toBeNull();
      expect(await tries(db, `insert into customer_refunds (org_id, payment_id, invoice_id, currency, amount_minor, status, source, reason) values ($1, $2, $3, 'PHP', 100, 'succeeded', 'manual_record', 'x y z')`, [io.orgId, pending.paymentId, inv.id])).toMatch(/only a payment that was received/i);
    });
  });

  it("allows one open checkout per invoice", async () => {
    const io = await invoiceOrg();
    const inv = (await issuedInvoice(io)).invoice;
    const conn = await connectionFor(io);
    const attempt = (ref: string, status: string) =>
      `insert into customer_payment_attempts (org_id, invoice_id, connection_id, currency, amount_minor, reference, status) values ('${io.orgId}', '${inv.id}', '${conn}', 'PHP', 100000, '${ref}', '${status}')`;
    await rolledBack(async (db) => {
      expect(await tries(db, attempt(`CP-${uid()}${uid()}${uid()}`, "created"))).toBeNull();
      expect(await tries(db, attempt(`CP-${uid()}${uid()}${uid()}`, "redirected"))).toMatch(/unique|duplicate/);
      expect(await tries(db, attempt(`CP-${uid()}${uid()}${uid()}`, "expired"))).toBeNull();
      expect(await tries(db, attempt("CP-short", "expired"))).toMatch(/check|violates/);
    });
  });

  it("keeps a checkout attempt to what it asked for, a finished attempt finished, and a webhook receipt to what it received", async () => {
    const io = await invoiceOrg();
    const inv = (await issuedInvoice(io)).invoice;
    const conn = await connectionFor(io);
    await rolledBack(async (db) => {
      const attempt = (await db.query<{ id: string }>(
        "insert into customer_payment_attempts (org_id, invoice_id, connection_id, currency, amount_minor, reference, status) values ($1, $2, $3, 'PHP', 150000, 'CP-' || substr(md5(random()::text), 1, 24), 'created') returning id", [io.orgId, inv.id, conn],
      )).rows[0].id;
      for (const set of ["amount_minor = 1", "reference = 'CP-' || repeat('a', 24)", "created_at = now() + interval '1 day'"]) {
        expect(await tries(db, `update customer_payment_attempts set ${set} where id = $1`, [attempt]), set).toMatch(/cannot be changed/);
      }
      expect(await tries(db, "update customer_payment_attempts set checkout_url = 'https://pay.example.test/c/1', provider_checkout_id = 'cs_1', status = 'redirected' where id = $1", [attempt])).toBeNull();
      expect(await tries(db, "update customer_payment_attempts set status = 'created' where id = $1", [attempt])).toMatch(/cannot become/);
      expect(await tries(db, "update customer_payment_attempts set status = 'expired' where id = $1", [attempt])).toBeNull();
      expect(await tries(db, "update customer_payment_attempts set status = 'succeeded' where id = $1", [attempt])).toMatch(/cannot become/);
      expect(await tries(db, "delete from customer_payment_attempts where id = $1", [attempt])).toMatch(/never deleted/);
      const receipt = (await db.query<{ id: string }>(
        "insert into customer_payment_events (org_id, connection_id, provider_event_id, event_type, payload_sha256) values ($1, $2, 'evt_1', 'payment.paid', repeat('a', 64)) returning id", [io.orgId, conn],
      )).rows[0].id;
      for (const set of ["provider_event_id = 'evt_2'", "event_type = 'payment.failed'", "payload_sha256 = repeat('b', 64)", "received_at = now() + interval '1 day'"]) {
        expect(await tries(db, `update customer_payment_events set ${set} where id = $1`, [receipt]), set).toMatch(/cannot be changed/);
      }
      expect(await tries(db, "update customer_payment_events set outcome = 'processed', processed_at = now(), attempts = attempts + 1 where id = $1", [receipt])).toBeNull();
      expect(await tries(db, "delete from customer_payment_events where id = $1", [receipt])).toMatch(/never deleted/);
      // The same provider event twice for one connection is one receipt.
      expect(await tries(db, "insert into customer_payment_events (org_id, connection_id, provider_event_id, event_type) values ($1, $2, 'evt_1', 'payment.paid')", [io.orgId, conn])).toMatch(/unique|duplicate/);
    });
  });

  it("will not switch reminders on without a recorded authorization, and keeps a simulated connection in test mode", async () => {
    const io = await invoiceOrg();
    await rolledBack(async (db) => {
      await db.query("insert into customer_invoice_settings (org_id, version) values ($1, 0)", [io.orgId]);
      expect(await tries(db, "update customer_invoice_settings set reminders_enabled = true where org_id = $1", [io.orgId])).toMatch(/check|violates/);
      expect(await tries(db, "update customer_invoice_settings set reminders_enabled = true, reminders_authorized_at = now(), reminders_body_hash = repeat('a', 64) where org_id = $1", [io.orgId])).toBeNull();
      expect(await tries(db, "insert into customer_payment_connections (org_id, provider, mode, public_key) values ($1, 'simulated', 'live', 'cpk_aaaaaaaaaaaaaaaaaaaa')", [io.orgId])).toMatch(/check|violates/);
    });
  });
});

describe("a departed client's data", () => {
  it("is removed by a purge in whatever order it meets the tables (the way executeDeletion works), and only for that client", async () => {
    const io = await invoiceOrg();
    const other = await invoiceOrg();
    const conn = await connectionFor(io);
    const inv = (await issuedInvoice(io)).invoice;
    await issuedInvoice(other);
    await draftBy(io);
    const paid = await providerPayment(io, inv.id, conn, 100000);
    await recordManualPayment(io.ctx("owner"), inv.id, { amount: "100", receivedOn: "2026-10-23", method: "cash", evidence: "Cash, receipt 5" }, { now: new Date("2026-10-23T12:00:00Z") });
    await recordRefund(io.ctx("owner"), paid.paymentId, { amount: "50", reason: "Goodwill gesture" });
    await rolledBack(async (db) => {
      await db.query("insert into customer_payment_attempts (org_id, invoice_id, connection_id, currency, amount_minor, reference, status) values ($1, $2, $3, 'PHP', 1000, 'CP-' || substr(md5(random()::text), 1, 24), 'expired')", [io.orgId, inv.id, conn]);
      await db.query("insert into customer_payment_events (org_id, connection_id, provider_event_id, event_type) values ($1, $2, 'evt_purge', 'payment.paid')", [io.orgId, conn]);
      await db.query("insert into customer_invoice_reminders (org_id, invoice_id, step_key, due_at) values ($1, $2, 'on_due:0', now() + interval '3 days')", [io.orgId, inv.id]);
      await db.query("select set_config('iaq.purge', 'on', true)");
      // Deliberately the worst order for the foreign keys: parents first. The purge meets tables in whatever order the catalog lists them and retries the ones still referenced.
      let remaining = [...TABLES];
      for (let pass = 0; pass < 12 && remaining.length; pass += 1) {
        const next: string[] = [];
        for (const t of remaining) {
          await db.query("savepoint purge_step");
          try {
            await db.query(`delete from "${t}" where org_id = $1`, [io.orgId]);
            await db.query("release savepoint purge_step");
          } catch {
            await db.query("rollback to savepoint purge_step");
            next.push(t);
          }
        }
        expect(next.length).toBeLessThan(remaining.length);
        remaining = next;
      }
      expect(remaining).toEqual([]);
      for (const t of TABLES) expect((await db.query(`select 1 from ${t} where org_id = $1`, [io.orgId])).rows, t).toHaveLength(0);
      // Another client's invoice was not touched.
      expect((await db.query("select 1 from customer_invoices where org_id = $1", [other.orgId])).rows).toHaveLength(1);
    });
    // Without the purge declaration nothing could be deleted, whatever the order.
    await expect(withSystem((db) => db.query("delete from customer_invoices where org_id = $1", [io.orgId]))).rejects.toThrow();
    expect((await rows("select 1 from customer_invoices where org_id = $1", [io.orgId])).length).toBeGreaterThan(0);
  });
});

describe("the rollback", () => {
  it("refuses while an invoice exists and changes nothing", async () => {
    const io = await invoiceOrg();
    await draftBy(io);
    await expect(
      withSystem(async (db) => {
        for (const stmt of statements(down)) await db.query(stmt);
        throw new Done();
      }),
    ).rejects.toThrow(/Rollback refused/);
  });

  it("refuses while a billing message or an invoice notification exists", async () => {
    const io = await invoiceOrg();
    const contact = (await rows<{ id: string }>("insert into contacts (org_id, display_name) values ($1, 'Rollback Probe') returning id", [io.orgId]))[0].id;
    await expect(
      withSystem(async (db) => {
        await db.query("select set_config('iaq.purge', 'on', true)");
        for (const t of CLEAR_ORDER) await db.query(`delete from ${t}`);
        const conv = (await db.query<{ id: string }>("insert into conversations (org_id, contact_id, channel, status, owner_kind) values ($1, $2, 'sms', 'open', 'unassigned') returning id", [io.orgId, contact])).rows[0].id;
        await db.query("insert into conversation_messages (org_id, conversation_id, direction, author_kind, body, status, failed_at, failure_kind, scope) values ($1, $2, 'outbound', 'human', 'x', 'failed', now(), 'rejected', 'billing')", [io.orgId, conv]);
        for (const stmt of statements(down)) await db.query(stmt);
        throw new Done();
      }),
    ).rejects.toThrow(/billing scope/);
  });

  it("puts the message scopes and notification kinds back exactly, when nothing was used", async () => {
    const io = await invoiceOrg();
    const def = async (db: Db, name: string, table: string) => (await db.query<{ d: string }>("select pg_get_constraintdef(oid) as d from pg_constraint where conname = $1 and conrelid = $2::regclass", [name, table])).rows[0].d;
    let scopesBefore: string[] = [];
    let scopesAfter: string[] = [];
    let kindsBefore: string[] = [];
    let kindsAfter: string[] = [];
    let tablesLeft = -1;
    let permissionsLeft = -1;
    await rolledBack(async (db) => {
      scopesBefore = quoted(await def(db, "conversation_messages_scope_check", "conversation_messages"));
      kindsBefore = quoted(await def(db, "notifications_kind_check", "notifications"));
      await db.query("select set_config('iaq.purge', 'on', true)");
      for (const t of CLEAR_ORDER) await db.query(`delete from ${t}`);
      await db.query("delete from notifications where kind like 'invoice_%' or kind in ('payment_connection_attention', 'payment_review_needed')");
      for (const stmt of statements(down)) await db.query(stmt);
      scopesAfter = quoted(await def(db, "conversation_messages_scope_check", "conversation_messages"));
      kindsAfter = quoted(await def(db, "notifications_kind_check", "notifications"));
      tablesLeft = (await db.query("select 1 from pg_class where relnamespace = 'public'::regnamespace and relname = any($1::text[])", [TABLES])).rows.length;
      permissionsLeft = (await db.query("select 1 from role_permissions where permission like 'invoices.%'")).rows.length;
      void io;
    });
    expect(scopesBefore.at(-1)).toBe("billing");
    expect(scopesAfter).toEqual(scopesBefore.filter((s) => s !== "billing"));
    expect(scopesAfter).toEqual(expect.arrayContaining(["reply", "followup", "human", "reminder", "retention"]));
    expect(new Set(kindsAfter)).toEqual(new Set(kindsBefore.filter((k) => !/^(invoice_|payment_connection|payment_review)/.test(k))));
    expect(kindsAfter.length).toBe(kindsBefore.length - 8);
    expect(tablesLeft).toBe(0);
    expect(permissionsLeft).toBe(0);
  });
});
