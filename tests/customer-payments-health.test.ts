// The health check for customers' payments ("customer-payments:" in the operations collectors) and a client's departure with payment accounts connected. Recorded
// evidence only: nothing here asks a provider anything. Embedded Postgres.
import { afterAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { sha256 } from "@/server/security/crypto";
import { runAllCollectors } from "@/server/ops/collectors";
import { listIncidentsForClient } from "@/server/ops/incidents";
import { markReceiptError, storeReceipt } from "@/server/customer-payments/events";
import { emptyEvent } from "@/lib/invoices/payment-events";
import { closeBilling, executeDeletion, getOffboarding, requestOffboardingAsAgency, shutdownClient } from "@/server/offboarding/service";
import { invoiceOrg, issuedInvoice, rows, type InvoiceOrg } from "./support/invoices";
import { attempt, connect, deliver, paymentsOf, paymongoPaid, paymongoRefundUpdated, q } from "./support/customer-payments";

const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);
const check = (now: Date) => runAllCollectors(now, ["customer-payments:"]);
const incidents = (orgId: string) => q<{ dedupe_key: string; severity: string; status: string; client_visible: boolean; title: string; detail: string | null; evidence: Record<string, unknown>; org_id: string }>(
  "select dedupe_key, severity, status, client_visible, title, detail, evidence, org_id from incidents where starts_with(dedupe_key, 'customer-payments:') and org_id = $1 order by dedupe_key", [orgId]);
const facts = (id: string) => ({ ...emptyEvent("payment.succeeded", { eventId: id, type: "t", livemode: false }), paymentId: `pay_${id}`, amountMinor: 1000, currency: "PHP" });

describe("what the health check sees of customers' payments", () => {
  it("raises, for the workspace that has them and in plain words for its owner, deliveries that failed or were never finished, payments waiting for a person, and an account in trouble; and resolves each when it is put right", async () => {
    const a = await invoiceOrg();
    const b = await invoiceOrg();
    const invA = (await issuedInvoice(a, { isTest: true })).invoice;
    const conn = await connect(a);
    // Two deliveries: one that failed, one that arrived and was never applied.
    const failed = await storeReceipt({ id: conn.id, orgId: a.orgId }, facts("evt_failed_one"), sha256("1"));
    await markReceiptError(failed.receiptId, "Error: boom");
    const stuck = await storeReceipt({ id: conn.id, orgId: a.orgId }, facts("evt_stuck_one"), sha256("2"));
    // A payment of another amount than was asked for, waiting for a person.
    const at = await attempt(invA.id, conn);
    await deliver(conn, paymongoPaid({ checkoutId: at.checkoutId!, reference: at.reference, amount: 1000, paymentId: "pay_review" }));
    expect(await paymentsOf(invA.id)).toMatchObject([{ status: "needs_review" }]);
    // It has waited two days for someone (the payment's own clock is stopped while it is aged, so the aging is the only change).
    await withSystem(async (db) => {
      await db.query("alter table customer_payments disable trigger customer_payments_touch");
      await db.query("update customer_payments set updated_at = now() - interval '2 days' where invoice_id = $1", [invA.id]);
      await db.query("alter table customer_payments enable trigger customer_payments_touch");
    });
    // And an account the provider refused.
    const bad = await connect(b, { status: "needs_attention" });

    const out = await check(later(30));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ prefix: "customer-payments:" });
    const mine = await incidents(a.orgId);
    expect(mine.map((i) => i.dedupe_key)).toEqual([`customer-payments:needs-review:${a.orgId}`, `customer-payments:webhook-errors:${a.orgId}`, `customer-payments:webhook-stuck:${a.orgId}`]);
    expect(mine.map((i) => [i.severity, i.status, i.client_visible])).toEqual([["warning", "open", true], ["critical", "open", true], ["critical", "open", true]]);
    expect(mine[0].title).toBe("1 customer payment is waiting for someone to look at it");
    expect(mine[1].title).toBe("1 payment notification from your payment provider could not be applied in the last 24 hours");
    expect(mine[2].title).toBe("1 payment notification was received from your payment provider and not applied");
    // Counts and nothing else: no amount, no name, no key, no address.
    const text = JSON.stringify(mine);
    for (const secret of [conn.webhookSecret, conn.apiKey, "evt_failed_one", "pay_review", "1000", "Maria", conn.publicKey]) expect(text, secret).not.toContain(secret);
    expect(mine[1].evidence).toEqual({ failed: 1 });
    expect(mine[2].evidence).toEqual({ stuck: 1 });
    expect(mine[0].evidence).toEqual({ waiting: 1 });

    // Another workspace's account in trouble is that workspace's alone.
    const theirs = await incidents(b.orgId);
    expect(theirs.map((i) => i.dedupe_key)).toEqual([`customer-payments:connection:${bad.id}`]);
    expect(theirs[0]).toMatchObject({ severity: "warning", client_visible: true, title: "Your payment account needs attention" });
    const ownerSees = async (io: InvoiceOrg) => (await listIncidentsForClient(io.ctx("owner"))).filter((i) => i.sourceLabel === "Payments");
    expect((await ownerSees(a)).map((i) => i.orgId)).toEqual([a.orgId, a.orgId, a.orgId]);
    expect((await ownerSees(b)).map((i) => i.orgId)).toEqual([b.orgId]);
    expect(await listIncidentsForClient(a.ctx("viewer"))).toEqual([]);

    // Put right: the delivery is applied, the other is finished, the payment is settled, the account is accepted again.
    await withSystem(async (db) => {
      await db.query("update customer_payment_events set outcome = 'processed', processed_at = now() where id = any($1::uuid[])", [[failed.receiptId, stuck.receiptId]]);
      await db.query("update customer_payments set status = 'failed' where invoice_id = $1", [invA.id]);
      await db.query("update customer_payment_connections set status = 'connected' where id = $1", [bad.id]);
    });
    const after = await check(later(30));
    expect(after[0]).toMatchObject({ recovered: 4 });
    expect((await incidents(a.orgId)).map((i) => i.status)).toEqual(["resolved", "resolved", "resolved"]);
    expect((await incidents(b.orgId)).map((i) => i.status)).toEqual(["resolved"]);
  });

  it("says nothing when nothing is wrong, and waits before it calls a fresh delivery stuck or a fresh payment neglected", async () => {
    const io = await invoiceOrg();
    const conn = await connect(io);
    await storeReceipt({ id: conn.id, orgId: io.orgId }, facts("evt_fresh_one"), sha256("3"));
    await check(new Date());
    expect(await incidents(io.orgId)).toEqual([]);
    await check(later(5));
    expect(await incidents(io.orgId)).toEqual([]);
    await check(later(20));
    expect((await incidents(io.orgId)).map((i) => i.dedupe_key)).toEqual([`customer-payments:webhook-stuck:${io.orgId}`]);
  });
});

describe("a client with payment accounts closing down", () => {
  const close = async (io: InvoiceOrg) => shutdownClient(io.superAdmin, (await requestOffboardingAsAgency(io.superAdmin, io.orgId, "Contract ended")).id);

  it("has every account disconnected as its owner would have, the keys deleted, the waiting checkouts cancelled, and the step on the record", async () => {
    const io = await invoiceOrg();
    const inv = (await issuedInvoice(io)).invoice;
    const pm = await connect(io, { provider: "paymongo" });
    const sim = await connect(io, { provider: "simulated" });
    const open = await attempt(inv.id, pm);
    const view = await close(io);
    expect(view.status).toBe("retention");
    expect(view.steps.map((s) => s.key)).toEqual(["automation", "messaging", "integrations", "social", "payments", "access", "website"]);
    expect(view.steps.find((s) => s.key === "payments")).toMatchObject({ ok: true, text: "Disconnected 2 payment accounts and deleted the saved keys; 1 checkout waiting to be paid was cancelled. Revoke the keys at the provider too." });
    for (const c of [pm, sim]) expect(await q("select status, credentials from customer_payment_connections where id = $1", [c.id])).toEqual([{ status: "revoked", credentials: null }]);
    expect((await q<{ status: string }>("select status from customer_payment_attempts where id = $1", [open.id]))[0].status).toBe("cancelled");
    // A delivery after the shutdown is not believed; the invoices and payments already recorded stay (they are the client's data).
    expect(await deliver(pm, paymongoPaid({ checkoutId: open.checkoutId!, reference: open.reference, amount: open.amountMinor }))).toMatchObject({ status: 403 });
    expect(await q("select id from customer_invoices where id = $1", [inv.id])).toHaveLength(1);
    const audit = await rows<{ result: string; metadata: { failedPaymentDisconnects: string[] } }>("select result, metadata from audit_logs where org_id = $1 and action = 'offboarding.shutdown'", [io.orgId]);
    expect(audit).toMatchObject([{ result: "success", metadata: { failedPaymentDisconnects: [] } }]);
  });

  it("adds no step for a workspace that had nothing to disconnect", async () => {
    const io = await invoiceOrg();
    const view = await close(io);
    expect(view.steps.map((s) => s.key)).toEqual(["automation", "messaging", "integrations", "social", "access", "website"]);
  });

  it("reports an account it could not disconnect by name, carries on, and still closes the workspace", async () => {
    const io = await invoiceOrg();
    const sim = await connect(io, { provider: "simulated" });
    const pm = await connect(io, { provider: "paymongo" });
    await withSystem(async (db) => {
      await db.query("create or replace function zz_block_revoke() returns trigger language plpgsql as $$ begin raise exception 'blocked for the test'; end $$");
      await db.query("create trigger zz_block_revoke before update on customer_payment_connections for each row when (new.provider = 'paymongo' and new.status = 'revoked') execute function zz_block_revoke()");
    });
    try {
      const view = await close(io);
      expect(view.status).toBe("retention");
      expect(view.steps.find((s) => s.key === "payments")).toMatchObject({ ok: false, text: expect.stringMatching(/^Could not disconnect payment accounts: PayMongo\. Remove the saved keys by hand/) });
    } finally {
      await withSystem(async (db) => {
        await db.query("drop trigger zz_block_revoke on customer_payment_connections");
        await db.query("drop function zz_block_revoke()");
      });
    }
    expect((await q<{ status: string }>("select status from customer_payment_connections where id = $1", [sim.id]))[0].status).toBe("revoked");
    expect((await q<{ status: string }>("select status from customer_payment_connections where id = $1", [pm.id]))[0].status).toBe("connected");
    const [audit] = await rows<{ result: string; metadata: { failedPaymentDisconnects: string[] } }>("select result, metadata from audit_logs where org_id = $1 and action = 'offboarding.shutdown'", [io.orgId]);
    expect(audit).toMatchObject({ result: "failure", metadata: { failedPaymentDisconnects: ["PayMongo"] } });
  });

  describe("and the final deletion", () => {
    afterAll(() => {
      delete process.env.OFFBOARDING_PURGE_ENABLED;
      resetEnvCache();
    });

    async function seeded() {
      const io = await invoiceOrg();
      // A test invoice carries the test-mode payment and its refund (an account in test mode takes only a test invoice); a real one carries a checkout nobody paid.
      const inv = (await issuedInvoice(io, { isTest: true })).invoice;
      const conn = await connect(io);
      const at = await attempt(inv.id, conn);
      await deliver(conn, paymongoPaid({ checkoutId: at.checkoutId!, reference: at.reference, amount: at.amountMinor, paymentId: "pay_seed" }));
      await deliver(conn, paymongoRefundUpdated({ paymentId: "pay_seed", refundId: "ref_seed", amount: 5000 }));
      await deliver(conn, paymongoRefundUpdated({ paymentId: "pay_waiting", refundId: "ref_waiting", amount: 100 }));
      await attempt((await issuedInvoice(io)).invoice.id, conn, { status: "expired" });
      return { io, inv, conn };
    }
    const TABLES = ["customer_invoice_settings", "customer_payment_connections", "customer_invoices", "customer_invoice_lines", "customer_invoice_events", "customer_payment_attempts", "customer_payments", "customer_refunds", "customer_payment_events"];
    const count = async (table: string, orgId: string) => Number((await q<{ n: string }>(`select count(*)::text as n from ${table} where org_id = $1`, [orgId]))[0].n);

    it("removes every customer invoice and payment row of the departed workspace, whatever order they hang together in, and none of another workspace's", async () => {
      const gone = await seeded();
      const stays = await seeded();
      for (const t of TABLES) expect(await count(t, gone.io.orgId), `${t} before`).toBeGreaterThan(0);
      const req = await requestOffboardingAsAgency(gone.io.superAdmin, gone.io.orgId, "Contract ended");
      await shutdownClient(gone.io.superAdmin, req.id);
      process.env.OFFBOARDING_PURGE_ENABLED = "true";
      resetEnvCache();
      await withSystem((db) => db.query("update offboarding_requests set delete_after = now() - interval '1 day' where id = $1", [req.id]));
      await closeBilling(gone.io.superAdmin, req.id, "Settled in full for this test.");
      await executeDeletion(gone.io.superAdmin, req.id, { confirmName: gone.io.c.org.name, waiveExportReason: "Test run without a download." });
      for (const t of TABLES) {
        expect(await count(t, gone.io.orgId), t).toBe(0);
        expect(await count(t, stays.io.orgId), `${t} (the other workspace)`).toBeGreaterThan(0);
      }
      expect((await getOffboarding(gone.io.orgId))?.status).not.toBe("requested");
    });
  });
});
