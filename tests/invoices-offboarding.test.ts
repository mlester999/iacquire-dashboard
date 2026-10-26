// Customer invoices and payments through a client's departure: the data export carries what the client owns (without anything that signs in as their payment account or
// opens a customer's invoice), shutdown disconnects the payment account as its owner would, and the final deletion removes it all, financial rows included, and nothing of
// another workspace. Embedded Postgres; no payment provider is contacted.
import { afterAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { buildExport } from "@/server/offboarding/export";
import { readZip } from "@/server/offboarding/zip";
import { closeBilling, executeDeletion, getOffboarding, requestOffboardingAsAgency, shutdownClient } from "@/server/offboarding/service";
import { recordRefund } from "@/server/invoices/payments";
import { credentialVault } from "@/server/customer-payments/credentials";
import { contactIn, invoiceOrg, issuedInvoice, linkTokenOf, rows, type InvoiceOrg } from "./support/invoices";
import { attempt, connect, deliver, paymentsOf, paymongoPaid, q } from "./support/customer-payments";

async function seeded(name: string, marker: string) {
  const io = await invoiceOrg({ name });
  await withSystem((db) => db.query(
    "insert into maintenance_subscriptions (org_id, status, monthly_price_cents, monthly_request_allowance, terms_version, accepted_by, activated_at, billing_start_on) values ($1, 'active', 29900, 4, 'test', $2, now() - interval '30 days', current_date - 30)",
    [io.orgId, io.c.people.owner.id],
  ));
  const contactId = await contactIn(io, { firstName: marker, lastName: "Customer", email: `${marker.toLowerCase()}.customer@example.test` });
  const inv = (await issuedInvoice(io, { contactId })).invoice;
  const token = await linkTokenOf(io, inv.id);
  const conn = await connect(io, { provider: "paymongo", mode: "live", liveConfirmed: true });
  const a = await attempt(inv.id, conn);
  const body = paymongoPaid({ checkoutId: a.checkoutId!, reference: a.reference, amount: a.amountMinor, livemode: true, paymentId: `${marker}-payment` });
  expect((await deliver(conn, body)).outcome).toBe("processed");
  const [payment] = await paymentsOf(inv.id);
  await recordRefund(io.ctx("owner"), payment.id, { amount: "100.00", reason: `${marker}-REFUND-REASON` });
  await withSystem((db) => db.query("insert into customer_invoice_reminders (org_id, invoice_id, step_key, due_at, status) values ($1, $2, 'on_due:0', now() + interval '1 day', 'cancelled')", [io.orgId, inv.id]));
  // A message that carried the customer's link to them: the invoice stays issued once paid, so the database still takes the row. It holds the placeholder, never the link.
  const conversation = (await rows<{ id: string }>("insert into conversations (org_id, contact_id, channel, thread_key, status, owner_kind) values ($1, $2, 'email', $3, 'open', 'unassigned') returning id", [io.orgId, contactId, `invoice:${inv.id}`]))[0].id;
  const message = (await rows<{ id: string }>("insert into conversation_messages (org_id, conversation_id, direction, author_kind, body, status, scope) values ($1, $2, 'outbound', 'system', 'Your invoice: {{invoice.link}}', 'queued', 'delivery') returning id", [io.orgId, conversation]))[0].id;
  await withSystem((db) => db.query("insert into customer_invoice_deliveries (org_id, invoice_id, link_version, channel, message_id, wording_version, wording_hash, address_mask) values ($1, $2, 1, 'email', $3, 'draft-test', repeat('d', 64), $4)", [io.orgId, inv.id, message, `${marker.toLowerCase().slice(0, 1)}***@example.test`]));
  const sealed = (await rows<{ credentials: string }>("select credentials from customer_payment_connections where id = $1", [conn.id]))[0].credentials;
  return { io, inv, token, conn, a, sealed, marker };
}
type Seeded = Awaited<ReturnType<typeof seeded>>;

async function close(io: InvoiceOrg) {
  const req = await requestOffboardingAsAgency(io.superAdmin, io.orgId, "Contract ended");
  return shutdownClient(io.superAdmin, req.id);
}

describe("shutting down a client with a payment account", () => {
  it("disconnects it as its owner would: keys deleted, live confirmation cleared, checkouts waiting to be paid cancelled, nothing the provider sends afterwards believed, and the step is on the record", async () => {
    const s = await seeded("Closing Invoices Co", "CLOSING");
    // A second customer is half way through paying when the workspace closes.
    const waiting = (await issuedInvoice(s.io)).invoice;
    const open = await attempt(waiting.id, s.conn, { status: "redirected" });
    const view = await close(s.io);
    expect(view.status).toBe("retention");
    const step = view.steps.find((x) => x.key === "payments")!;
    expect(step.ok).toBe(true);
    expect(step.text).toMatch(/^Disconnected 1 payment account and deleted the saved keys; 1 checkout waiting to be paid was cancelled\. Revoke the keys at the provider too\.$/);

    expect((await q<{ status: string; credentials: string | null; live_confirmed_at: string | null }>("select status, credentials, live_confirmed_at from customer_payment_connections where id = $1", [s.conn.id]))[0]).toEqual({ status: "revoked", credentials: null, live_confirmed_at: null });
    expect((await q<{ status: string }>("select status from customer_payment_attempts where id = $1", [open.id]))[0].status).toBe("cancelled");
    const audit = await rows<{ actor_kind: string; metadata: { reason: string } }>("select actor_kind, metadata from audit_logs where org_id = $1 and action = 'payments.connection_revoked'", [s.io.orgId]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_kind: "agency", metadata: { reason: "offboarding" } });
    // The money already recorded is the client's and stays for them to download; a payment the provider reports now is not believed.
    expect(await paymentsOf(s.inv.id)).toHaveLength(1);
    const late = paymongoPaid({ checkoutId: open.checkoutId!, reference: open.reference, amount: open.amountMinor, livemode: true });
    expect(await deliver(s.conn, late)).toMatchObject({ status: 403 });
    expect(await paymentsOf(waiting.id)).toEqual([]);
  });

  it("says plainly nothing when there was no payment account to disconnect", async () => {
    const io = await invoiceOrg({ name: "No Account Co" });
    await issuedInvoice(io);
    const view = await close(io);
    expect(view.status).toBe("retention");
    expect(view.steps.find((x) => x.key === "payments")).toBeUndefined();
  });
});

describe("taking invoices and payments with you", () => {
  it("carries the invoices, lines, history, reminders, payments, refunds, checkouts, provider notices, settings and the payment account's name and status, and nothing of another workspace", async () => {
    const mine = await seeded("Exporting Invoices Co", "MINE");
    await seeded("Other Invoices Co", "OTHER");
    const out = await buildExport(mine.io.orgId);
    const files = readZip(out.bytes);
    const names = files.map((f) => f.name);
    for (const must of ["invoices/invoices.json", "invoices/lines.json", "invoices/history.json", "invoices/reminders.json", "invoices/deliveries.json", "invoices/payments.json", "invoices/refunds.json", "invoices/checkouts.json", "invoices/provider-notices.json", "invoices/payment-account.json"]) expect(names, must).toContain(must);
    const text = (n: string) => files.find((f) => f.name === n)!.data.toString("utf8");
    const json = <T,>(n: string) => JSON.parse(text(n)) as T[];

    const invoices = json<Record<string, unknown>>("invoices/invoices.json");
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ number: "INV-0001", status: "issued", currency: "PHP" });
    // (A big integer column reads back as a number on the embedded database and as text on the hosted one: the amounts are compared as numbers.)
    expect([Number(invoices[0].total_minor), Number(invoices[0].paid_minor), Number(invoices[0].refunded_minor)]).toEqual([150000, 150000, 10000]);
    expect(JSON.stringify(invoices[0].bill_to)).toContain("mine.customer@example.test");
    // The hash of the customer's link opens the invoice and the customer's idempotency key is working state: neither leaves.
    for (const forbidden of ["public_token_hash", "idempotency_key"]) expect(Object.keys(invoices[0]), forbidden).not.toContain(forbidden);
    expect(json("invoices/lines.json")).toHaveLength(1);
    expect(json<{ kind: string }>("invoices/history.json").map((e) => e.kind)).toEqual(expect.arrayContaining(["created", "issued", "payment_verified", "paid", "refund_recorded"]));
    expect(json("invoices/reminders.json")).toHaveLength(1);
    // The messages sent to give the customer the link: who asked, the channel, the shortened address and the wording's fingerprint; never the link or the text.
    const deliveries = json<Record<string, unknown>>("invoices/deliveries.json");
    expect(deliveries).toEqual([expect.objectContaining({ channel: "email", link_version: 1, wording_version: "draft-test", address_mask: "m***@example.test" })]);
    expect(JSON.stringify(deliveries)).not.toMatch(/invoice\.link|https?:/);
    const payments = json<Record<string, unknown>>("invoices/payments.json");
    expect(payments).toEqual([expect.objectContaining({ provider: "paymongo", verification: "provider_confirmed", livemode: true, status: "partially_refunded", provider_payment_id: "MINE-payment" })]);
    expect(Number(payments[0].amount_minor)).toBe(150000);
    const refunds = json<Record<string, unknown>>("invoices/refunds.json");
    expect(refunds).toEqual([expect.objectContaining({ source: "manual_record", reason: "MINE-REFUND-REASON" })]);
    expect(Number(refunds[0].amount_minor)).toBe(10000);
    expect(json<Record<string, unknown>>("invoices/provider-notices.json")).toEqual([expect.objectContaining({ outcome: "processed" })]);

    // The checkout is exported without the provider's page address, and the payment account without anything that signs in as it.
    const checkouts = json<Record<string, unknown>>("invoices/checkouts.json");
    expect(checkouts).toHaveLength(1);
    expect(Object.keys(checkouts[0])).not.toContain("checkout_url");
    const account = json<Record<string, unknown>>("invoices/payment-account.json");
    expect(account).toEqual([expect.objectContaining({ provider: "paymongo", mode: "live", status: "connected" })]);
    for (const forbidden of ["credentials", "public_key", "webhook_ref", "created_by"]) expect(Object.keys(account[0]), forbidden).not.toContain(forbidden);

    // No secret appears anywhere in the archive: not the keys, the signing secret, the sealed text, the customer's link or the provider's page.
    const archive = files.filter((f) => /\.(json|md)$/.test(f.name)).map((f) => f.data.toString("utf8")).join("\n");
    const opened = credentialVault.open(mine.sealed)!;
    for (const secret of [opened.apiKey, opened.webhookSecret as string, mine.sealed, mine.token, mine.conn.publicKey, `checkout.paymongo.com/${mine.a.checkoutId}`]) expect(archive, secret.slice(0, 12)).not.toContain(secret);
    expect(archive).not.toMatch(/OTHER/);
    const readme = files.find((f) => f.name === "README.md")!.data.toString("utf8");
    expect(readme).toMatch(/\*\*invoices\/\*\*: the invoices you sent your customers/);
    expect(readme).toMatch(/never its keys or your customers' payment links/);
    const manifest = JSON.parse(text("manifest.json")) as { tables: Record<string, number> };
    expect(manifest.tables).toMatchObject({ customer_invoices: 1, customer_invoice_lines: 1, customer_payments: 1, customer_refunds: 1, customer_payment_attempts: 1, customer_payment_events: 1, customer_payment_connections: 1, customer_invoice_reminders: 1, customer_invoice_deliveries: 1 });
  });

  it("leaves nothing behind: every customer invoice and payment table is in the export", async () => {
    const mine = await seeded("Coverage Invoices Co", "COVER");
    const manifest = JSON.parse(readZip((await buildExport(mine.io.orgId)).bytes).find((f) => f.name === "manifest.json")!.data.toString("utf8")) as { tables: Record<string, number>; skippedTables: string[] };
    const tables = (await rows<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped
       where n.nspname = 'public' and c.relkind = 'r' and (c.relname like 'customer\\_invoice%' or c.relname like 'customer\\_payment%' or c.relname like 'customer\\_refund%') order by c.relname`,
    )).map((r) => r.relname);
    expect(tables).toEqual(["customer_invoice_deliveries", "customer_invoice_events", "customer_invoice_lines", "customer_invoice_reminders", "customer_invoice_settings", "customer_invoices", "customer_payment_attempts", "customer_payment_connections", "customer_payment_events", "customer_payments", "customer_refunds"].sort());
    for (const t of tables) expect(t in manifest.tables, `${t} is not in the export`).toBe(true);
    expect(manifest.skippedTables.filter((t) => t.startsWith("customer_invoice") || t.startsWith("customer_payment") || t === "customer_refunds")).toEqual([]);
  });

  describe("and the final deletion", () => {
    afterAll(() => {
      delete process.env.OFFBOARDING_PURGE_ENABLED;
      resetEnvCache();
    });

    it("removes it all, the financial rows too, and nothing of another workspace", async () => {
      const gone: Seeded = await seeded("Deleted Invoices Co", "GONE");
      const stays: Seeded = await seeded("Staying Invoices Co", "STAYS");
      await close(gone.io);
      const req = (await getOffboarding(gone.io.orgId))!;
      process.env.OFFBOARDING_PURGE_ENABLED = "true";
      resetEnvCache();
      await withSystem((db) => db.query("update offboarding_requests set delete_after = now() - interval '1 day' where id = $1", [req.id]));
      await closeBilling(gone.io.superAdmin, req.id, "Settled in full for this test.");
      await executeDeletion(gone.io.superAdmin, req.id, { confirmName: gone.io.c.org.name, waiveExportReason: "Test run without a download." });

      const count = async (table: string, orgId: string) => Number((await rows<{ n: string }>(`select count(*)::text as n from ${table} where org_id = $1`, [orgId]))[0].n);
      for (const t of ["customer_invoices", "customer_invoice_lines", "customer_invoice_events", "customer_invoice_reminders", "customer_invoice_deliveries", "customer_payments", "customer_refunds", "customer_payment_attempts", "customer_payment_events", "customer_payment_connections"]) {
        expect(await count(t, gone.io.orgId), t).toBe(0);
        expect(await count(t, stays.io.orgId), `${t} (the other workspace)`).toBeGreaterThan(0);
      }
    });
  });
});
