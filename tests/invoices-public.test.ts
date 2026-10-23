// What a customer may do with the link to an invoice and with the reference of a checkout they started, on embedded Postgres. There is no session: the link (or the
// reference) is all the caller holds, and the workspace, the invoice and the amount are read from our own rows. Nothing here contacts a payment provider.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { tokenForStoredHash } from "@/server/invoices/links";
import { rotateInvoiceLink } from "@/server/invoices/share";
import { voidInvoice, writeOffInvoice } from "@/server/invoices/invoices";
import { setInvoicesEnabled } from "@/server/invoices/feature";
import { applyDisputeInTx } from "@/server/invoices/apply";
import { checkoutTarget, loadPublicInvoice, loadReturn, paymentStatusByReference, paymentStatusByToken, startPublicPayment } from "@/server/invoices/public";
import { createPaymongoProvider } from "@/server/customer-payments/providers/paymongo";
import { ProviderCallError } from "@/server/customer-payments/providers/types";
import { setAdapterForTests } from "@/server/customer-payments/providers";
import { simulatedPlatform } from "@/server/customer-payments/providers/simulated";
import { newReference } from "@/server/customer-payments/ids";
import { contactIn, draftBy, freshIp, invoiceOrg, issuedInvoice, linkTokenOf, providerPayment, rows } from "./support/invoices";
import { attempt, connect, fakePaymongo, q } from "./support/customer-payments";

const CUSTOMER_EMAIL = "maria.santos.private@example.test";
const CUSTOMER_PHONE = "+639171234567";

/** A workspace with an issued invoice for a customer whose private details we can look for, and a connection a customer may pay through. */
async function setup(over: { connect?: boolean; email?: string } = {}) {
  const io = await invoiceOrg();
  const contactId = await contactIn(io, { firstName: "Maria", lastName: "Santos", email: over.email ?? CUSTOMER_EMAIL, phone: CUSTOMER_PHONE });
  const inv = (await issuedInvoice(io, { contactId })).invoice;
  const conn = over.connect === false ? null : await connect(io, { provider: "simulated" });
  const token = await linkTokenOf(io, inv.id);
  return { io, inv, conn, token, contactId };
}
type S = Awaited<ReturnType<typeof setup>>;
const ctx = () => ({ ip: freshIp() });
const view = async (token: string) => {
  const r = await loadPublicInvoice(token, ctx());
  if (r.state !== "ok") throw new Error(`expected an invoice, got ${r.state}`);
  return r.invoice;
};
const pay = (token: string, ip = freshIp()) => startPublicPayment(token, { ip });

describe("the invoice a link opens", () => {
  it("shows the customer their invoice as issued: the business, the lines, the amounts and the way to pay, and nothing that is only the business's", async () => {
    const s = await setup();
    const r = await loadPublicInvoice(s.token, ctx());
    expect(r.state).toBe("ok");
    const i = await view(s.token);
    expect(i).toMatchObject({
      number: "INV-0001", currency: "PHP", subtotalMinor: 150000, taxMinor: 0, totalMinor: 150000, paidMinor: 0, balanceMinor: 150000, paymentStatus: "unpaid", overdue: false, hasPendingPayment: false, canPayOnline: true,
      banner: { kind: "pay_online", tone: "info" }, billTo: { name: "Maria Santos" },
    });
    expect(i.lines).toEqual([expect.objectContaining({ position: 1, description: "Service call", quantity: "1", unitPriceMinor: 150000, amountMinor: 150000 })]);
    expect(i.business.name).toBeTruthy();
    // Only what the customer needs to recognise their own invoice: their email and phone number stay with the business.
    const text = JSON.stringify(r);
    for (const secret of [CUSTOMER_EMAIL, CUSTOMER_PHONE, "maria.santos.private", s.io.orgId, s.inv.id, s.contactId, s.token]) expect(text, secret).not.toContain(secret);
  });

  it("records, once and as 'opened', the first time anybody opens a valid link, and not when a link is only guessed", async () => {
    const s = await setup();
    const before = await rows("select 1 from customer_invoice_events where invoice_id = $1 and kind = 'viewed'", [s.inv.id]);
    expect(before).toHaveLength(0);
    await view(s.token);
    await view(s.token);
    await loadPublicInvoice("A".repeat(43), ctx());
    expect(await rows("select 1 from customer_invoice_events where invoice_id = $1 and kind = 'viewed'", [s.inv.id])).toHaveLength(1);
    expect((await rows<{ first_viewed_at: Date | null }>("select first_viewed_at from customer_invoices where id = $1", [s.inv.id]))[0].first_viewed_at).not.toBeNull();
    const event = await rows<{ actor_kind: string }>("select actor_kind from customer_invoice_events where invoice_id = $1 and kind = 'viewed'", [s.inv.id]);
    expect(event[0].actor_kind).toBe("customer");
  });

  it("answers a link that is made up, cut short, replaced, for an invoice that was never issued or is void, and for a stranger's invoice, with the very same 'invalid'", async () => {
    const s = await setup();
    const other = await setup();
    const draft = await draftBy(s.io);
    const voided = (await issuedInvoice(s.io)).invoice;
    const voidedToken = await linkTokenOf(s.io, voided.id);
    await voidInvoice(s.io.ctx("owner"), voided.id, { reason: "Raised for the wrong job" });
    await rotateInvoiceLink(s.io.ctx("owner"), s.inv.id);
    const tries = [
      "A".repeat(43), "not a token", "", s.token.slice(0, 42), `${s.token}x`, s.token.toLowerCase() === s.token ? s.token.toUpperCase() : s.token.toLowerCase(),
      s.token, voidedToken,
    ];
    const answers = await Promise.all(tries.map((t) => loadPublicInvoice(t, ctx())));
    expect(answers.map((a) => a.state), "after rotating, void and made up").toEqual(Array(tries.length).fill("invalid"));
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    // The new link works, the old one does not, and one workspace's link never opens another's invoice.
    const fresh = await linkTokenOf(s.io, s.inv.id);
    expect(fresh).not.toBe(s.token);
    expect((await view(fresh)).number).toBe("INV-0001");
    expect(draft.invoice.number).toBeNull();
    const theirs = await view(other.token);
    expect(theirs.number).toBe("INV-0001");
    expect(JSON.stringify(theirs)).not.toContain(s.io.orgId);
  });

  it("is limited by the caller's address before any link is looked up, and another address is not affected", async () => {
    const ip = freshIp();
    const seen = new Set<string>();
    for (let i = 0; i < 200 && !seen.has("rate_limited"); i += 1) seen.add((await loadPublicInvoice("A".repeat(43), { ip })).state);
    expect([...seen].sort()).toEqual(["invalid", "rate_limited"]);
    expect((await loadPublicInvoice("A".repeat(43), { ip: freshIp() })).state).toBe("invalid");
  });

  it("shows the customer a customer's erased copy without their details", async () => {
    const s = await setup();
    await withSystem((db) => db.query("update customer_invoices set bill_to = '{\"erased\": true}'::jsonb where id = $1", [s.inv.id]));
    const i = await view(s.token);
    expect(i.billTo).toEqual({ name: null, company: null, addressLines: [] });
  });
});

describe("whether the page may offer to pay, and what its banner says", () => {
  it("offers to pay only while the invoice owes something and an account may take it, and says paid only when the invoice is paid", async () => {
    const s = await setup();
    expect((await view(s.token)).canPayOnline).toBe(true);
    // Part paid: still payable, for the rest.
    await providerPayment(s.io, s.inv.id, s.conn!.id, 50000, { provider: "simulated", livemode: true });
    const part = await view(s.token);
    expect(part).toMatchObject({ paymentStatus: "partially_paid", paidMinor: 50000, balanceMinor: 100000, canPayOnline: true, banner: { kind: "partly_paid" } });
    await providerPayment(s.io, s.inv.id, s.conn!.id, 100000, { provider: "simulated", livemode: true });
    const done = await view(s.token);
    expect(done).toMatchObject({ paymentStatus: "paid", balanceMinor: 0, canPayOnline: false, banner: { kind: "paid", tone: "ok" } });
  });

  it("does not offer to pay without a connected account, with a paused one, with a test-mode account, or when the invoice was written off", async () => {
    const none = await setup({ connect: false });
    expect(await view(none.token)).toMatchObject({ canPayOnline: false, banner: { kind: "pay_other_way" } });
    const paused = await setup();
    await withSystem((db) => db.query("update customer_payment_connections set status = 'disabled' where id = $1", [paused.conn!.id]));
    expect((await view(paused.token)).canPayOnline).toBe(false);
    // A real provider's test mode moves no money, so a customer is never sent there.
    const test = await setup({ connect: false });
    await connect(test.io, { provider: "paymongo", mode: "test" });
    expect((await view(test.token)).canPayOnline).toBe(false);
    const off = await setup();
    await writeOffInvoice(off.io.ctx("owner"), off.inv.id, { reason: "Customer closed their business" });
    expect(await view(off.token)).toMatchObject({ canPayOnline: false });
    const disabled = await setup();
    await setInvoicesEnabled(disabled.io.superAdmin, disabled.io.orgId, false);
    expect((await view(disabled.token)).canPayOnline).toBe(false);
  });

  it("shows a payment in progress, and a dispute, as exactly that: neither is paid, and neither lets the customer pay again", async () => {
    const s = await setup();
    const a = await attempt(s.inv.id, s.conn!);
    await providerPayment(s.io, s.inv.id, s.conn!.id, 150000, { provider: "simulated", livemode: true, status: "pending", attemptId: a.id });
    expect(await view(s.token)).toMatchObject({ hasPendingPayment: true, paymentStatus: "unpaid", banner: { kind: "pending", tone: "wait" } });

    const d = await setup();
    const paid = await providerPayment(d.io, d.inv.id, d.conn!.id, 150000, { provider: "simulated", livemode: true });
    await withSystem((db) => applyDisputeInTx(db, { orgId: d.io.orgId, paymentId: paid.paymentId, open: true, actor: { id: null, kind: "provider" } }));
    const disputed = await view(d.token);
    expect(disputed).toMatchObject({ paymentStatus: "disputed", canPayOnline: false, banner: { kind: "under_review" } });
  });

  it("says overdue only past the due day in the workspace's own time zone, and the business's name comes from the invoice as it was issued", async () => {
    const s = await setup();
    const now = new Date("2030-01-01T00:00:00Z");
    const r = await loadPublicInvoice(s.token, { ip: freshIp(), now });
    // Overdue is said first, and the customer can still pay.
    expect(r.state === "ok" && r.invoice).toMatchObject({ overdue: true, canPayOnline: true, banner: { kind: "overdue", tone: "problem" } });
    const early = await loadPublicInvoice(s.token, { ip: freshIp(), now: new Date("2020-01-01T00:00:00Z") });
    expect(early.state === "ok" && early.invoice).toMatchObject({ overdue: false, banner: { kind: "pay_online" } });
    await withSystem((db) => db.query("update customer_invoice_settings set legal_name = 'Changed Name Ltd' where org_id = $1", [s.io.orgId]));
    expect((await view(s.token)).business.name).not.toBe("Changed Name Ltd");
  });
});

describe("paying", () => {
  it("starts one checkout for the balance the SERVER works out, sends the customer to the testing checkout of this product, and finds the same one again", async () => {
    const s = await setup();
    const first = await pay(s.token);
    expect(first).toMatchObject({ ok: true, reused: false, url: expect.stringMatching(/^\/dev\/simulated-checkout\/[0-9a-f-]{36}$/) });
    const again = await pay(s.token);
    expect(again).toMatchObject({ ok: true, reused: true });
    expect(again.ok && first.ok && again.url).toBe(first.ok && first.url);
    const attempts = await q<{ amount_minor: string; currency: string; status: string }>("select amount_minor::text, currency, status from customer_payment_attempts where invoice_id = $1", [s.inv.id]);
    expect(attempts).toEqual([{ amount_minor: "150000", currency: "PHP", status: "redirected" }]);
    simulatedPlatform.reset();
  });

  it("asks for the new balance, and closes the old checkout, after part of the invoice is paid some other way", async () => {
    const s = await setup();
    const first = await pay(s.token);
    await providerPayment(s.io, s.inv.id, s.conn!.id, 50000, { provider: "simulated", livemode: true });
    const second = await pay(s.token);
    expect(second).toMatchObject({ ok: true, reused: false });
    expect(first.ok && second.ok && first.url !== second.url).toBe(true);
    expect(await q("select amount_minor::text, status from customer_payment_attempts where invoice_id = $1 order by created_at", [s.inv.id])).toEqual([
      { amount_minor: "150000", status: "cancelled" }, { amount_minor: "100000", status: "redirected" },
    ]);
    simulatedPlatform.reset();
  });

  it("refuses a link that is not valid, an invoice that is paid, one that is void, and a workspace with nothing to take the payment, each with its own plain sentence", async () => {
    const s = await setup();
    expect(await pay("A".repeat(43))).toMatchObject({ ok: false, reason: "invalid", message: expect.stringMatching(/This link is not valid/) });
    const none = await setup({ connect: false });
    expect(await pay(none.token)).toMatchObject({ ok: false, reason: "unavailable", message: expect.stringMatching(/Online payment is not available for this invoice right now/) });
    await providerPayment(s.io, s.inv.id, s.conn!.id, 150000, { provider: "simulated", livemode: true });
    expect(await pay(s.token)).toMatchObject({ ok: false, reason: "paid", message: "This invoice has already been paid." });
    const v = await setup();
    await voidInvoice(v.io.ctx("owner"), v.inv.id, { reason: "Raised for the wrong job" });
    expect(await pay(v.token)).toMatchObject({ ok: false, reason: "invalid" });
    const off = await setup();
    await setInvoicesEnabled(off.io.superAdmin, off.io.orgId, false);
    expect(await pay(off.token)).toMatchObject({ ok: false, reason: "unavailable" });
    expect(await q("select 1 from customer_payment_attempts where invoice_id = any($1::uuid[])", [[none.inv.id, v.inv.id, off.inv.id]])).toEqual([]);
  });

  it("limits how often one link, and one address, may start a checkout, so a link cannot be used to flood a provider", async () => {
    const s = await setup();
    const results = new Set<string>();
    for (let i = 0; i < 16 && !results.has("rate_limited"); i += 1) {
      const r = await pay(s.token, freshIp());
      results.add(r.ok ? "ok" : r.reason);
    }
    expect([...results].sort()).toEqual(["ok", "rate_limited"]);
    // One address hammering gets stopped too, whatever links it holds.
    const ip = freshIp();
    const byAddress = new Set<string>();
    for (let i = 0; i < 40 && !byAddress.has("rate_limited"); i += 1) {
      const r = await pay("A".repeat(43), ip);
      byAddress.add(r.ok ? "ok" : r.reason);
    }
    expect([...byAddress].sort()).toEqual(["invalid", "rate_limited"]);
    simulatedPlatform.reset();
  });

  it("tells the customer only that the page could not be opened when a provider fails, and sends a real provider's own address only after live is open", async () => {
    const io = await invoiceOrg();
    const inv = (await issuedInvoice(io)).invoice;
    const token = await linkTokenOf(io, inv.id);
    const conn = await connect(io, { provider: "paymongo", mode: "live", liveConfirmed: true });
    const f = fakePaymongo();
    setAdapterForTests("paymongo", createPaymongoProvider({ http: f.http }));
    process.env.CUSTOMER_PAYMENTS_WRITES_ENABLED = "true";
    resetEnvCache();
    try {
      // Live is closed for the whole service until the founder's switch is on: no provider is asked.
      expect(await pay(token)).toMatchObject({ ok: false, reason: "unavailable" });
      expect(f.calls).toHaveLength(0);
      process.env.CUSTOMER_PAYMENTS_LIVE_ENABLED = "true";
      resetEnvCache();
      f.throwNext(new ProviderCallError("unreachable", "PayMongo could not be reached, or took too long to answer."));
      const down = await pay(token);
      expect(down).toMatchObject({ ok: false, reason: "try_again", message: expect.stringMatching(/Nothing was charged/) });
      expect(JSON.stringify(down)).not.toMatch(/PayMongo|sk_live|https?:\/\//);
      f.on((r) => r.method === "POST", { status: 200, json: { data: { id: "cs_live_1", attributes: { checkout_url: "https://checkout.paymongo.com/cs_live_1_client_abc" } } } });
      // The attempt whose answer was lost stays open until the scheduled check closes it, so nobody starts a second one meanwhile.
      const wait = await pay(token);
      expect(wait).toMatchObject({ ok: false, reason: "try_again" });
      await withSystem((db) => db.query("update customer_payment_attempts set status = 'failed' where connection_id = $1", [conn.id]));
      const ok = await pay(token);
      expect(ok).toEqual({ ok: true, reused: false, url: "https://checkout.paymongo.com/cs_live_1_client_abc" });
      expect(f.calls.filter((c) => c.method === "POST").every((c) => c.apiKey === conn.apiKey)).toBe(true);
    } finally {
      setAdapterForTests("paymongo", null);
      delete process.env.CUSTOMER_PAYMENTS_WRITES_ENABLED;
      delete process.env.CUSTOMER_PAYMENTS_LIVE_ENABLED;
      resetEnvCache();
    }
  });

  it("goes only where it is safe to send a customer: a provider's own https page, or this product's testing checkout outside production", () => {
    expect(checkoutTarget("paymongo", "a1", "https://checkout.paymongo.com/cs_1")).toBe("https://checkout.paymongo.com/cs_1");
    expect(checkoutTarget("paypal", "a1", "https://www.paypal.com/checkoutnow?token=X")).toBe("https://www.paypal.com/checkoutnow?token=X");
    expect(checkoutTarget("paymongo", "a1", "http://checkout.paymongo.com/cs_1")).toBeNull();
    expect(checkoutTarget("paymongo", "a1", "javascript:alert(1)")).toBeNull();
    expect(checkoutTarget("paymongo", "a1", "not a url")).toBeNull();
    expect(checkoutTarget("simulated", "att-1", "https://anything.invalid/x")).toBe("/dev/simulated-checkout/att-1");
  });
});

describe("coming back from the provider", () => {
  async function started(s: S, over: Parameters<typeof attempt>[2] = {}) {
    return attempt(s.inv.id, s.conn!, over);
  }
  const returned = async (reference: string, extra: { saidCancelled?: boolean; now?: Date } = {}) => {
    const r = await loadReturn(reference, { ip: freshIp(), ...extra });
    if (r.state !== "ok") throw new Error(`expected a view, got ${r.state}`);
    return r.view;
  };

  it("says 'we are confirming your payment' until the database holds a payment for the checkout, however the customer arrived", async () => {
    const s = await setup();
    const a = await started(s);
    const before = await returned(a.reference);
    expect(before.description).toMatchObject({ state: "confirming", headline: "We are confirming your payment", polling: true });
    expect(before).toMatchObject({ invoiceNumber: "INV-0001", amountMinor: 150000, currency: "PHP", reference: a.reference });
    // The attempt is marked succeeded by something other than a payment row: still not a payment.
    await withSystem((db) => db.query("update customer_payment_attempts set status = 'succeeded' where id = $1", [a.id]));
    expect((await returned(a.reference)).description.state).toBe("confirming");
    await providerPayment(s.io, s.inv.id, s.conn!.id, 150000, { provider: "simulated", livemode: true, attemptId: a.id });
    const after = await returned(a.reference);
    expect(after.description).toMatchObject({ state: "received", headline: "We have received your payment", polling: false, tone: "ok" });
  });

  it("tells what became of a checkout that did not complete: cancelled, expired, failed, held for review, the invoice void, or no word from the provider in time", async () => {
    const s = await setup();
    const cancelled = await started(s, { status: "cancelled" });
    expect((await returned(cancelled.reference, { saidCancelled: true })).description).toMatchObject({ state: "not_completed" });
    const old = await attempt(s.inv.id, s.conn!, { ageMinutes: 45 });
    expect((await returned(old.reference)).description.state).toBe("taking_longer");
    await withSystem((db) => db.query("update customer_payment_attempts set status = 'failed' where id = $1", [old.id]));
    expect((await returned(old.reference)).description.state).toBe("failed");
    const review = await attempt(s.inv.id, s.conn!, { status: "needs_review" });
    await providerPayment(s.io, s.inv.id, s.conn!.id, 150000, { provider: "simulated", livemode: true, status: "needs_review", attemptId: review.id });
    expect((await returned(review.reference)).description).toMatchObject({ state: "review", polling: false });
    expect((await invoiceStatus(s.inv.id)).payment_status).toBe("unpaid");
    // An invoice with a checkout still open cannot be voided; once the checkout is closed it can, and the page a customer returns to then says so.
    const v = await setup();
    const closed = await started(v, { status: "expired" });
    await voidInvoice(v.io.ctx("owner"), v.inv.id, { reason: "Raised for the wrong job" });
    expect((await returned(closed.reference)).description.state).toBe("unavailable");
  });

  it("answers a reference that is made up, malformed or from nowhere with 'invalid', and gives away only the business's name and colour, the invoice number, the amount and the reference", async () => {
    const s = await setup();
    const a = await started(s);
    for (const bad of [newReference(), "CP-short", "", "nope", `${a.reference}x`, a.reference.toLowerCase(), `CP-${"z".repeat(40)}`]) {
      expect((await loadReturn(bad, { ip: freshIp() })).state, bad).toBe("invalid");
    }
    const r = await loadReturn(a.reference, { ip: freshIp() });
    expect(r.state).toBe("ok");
    const text = JSON.stringify(r);
    for (const secret of [s.token, s.io.orgId, s.inv.id, s.conn!.id, a.id, a.checkoutId!, CUSTOMER_EMAIL, CUSTOMER_PHONE, "Maria", "Santos"]) expect(text, secret).not.toContain(secret);
    expect(Object.keys(r.state === "ok" ? r.view : {}).sort()).toEqual(["amountMinor", "business", "currency", "description", "invoiceNumber", "reference"]);
  });

  it("reads the same recomputed answer for the page that polls", async () => {
    const s = await setup();
    const a = await started(s);
    const ip = freshIp();
    const polled = await paymentStatusByReference(a.reference, { ip });
    const loaded = await loadReturn(a.reference, { ip: freshIp() });
    expect(polled.state === "ok" && loaded.state === "ok" && polled.view.description).toEqual(loaded.state === "ok" ? loaded.view.description : null);
    expect((await paymentStatusByReference("CP-nothingnothingnothingnothing", { ip })).state).toBe("invalid");
  });

  it("is limited by the caller's address, and one workspace's reference never shows another's invoice", async () => {
    const a = await setup();
    const b = await setup();
    const ra = await started(a);
    const rb = await started(b);
    const viewA = await returned(ra.reference);
    const viewB = await returned(rb.reference);
    expect(viewA.reference).toBe(ra.reference);
    expect(viewB.reference).toBe(rb.reference);
    expect(JSON.stringify(viewA)).not.toContain(rb.reference);
    const ip = freshIp();
    const seen = new Set<string>();
    for (let i = 0; i < 400 && !seen.has("rate_limited"); i += 1) seen.add((await loadReturn("CP-nothingnothingnothingnothing", { ip })).state);
    expect([...seen].sort()).toEqual(["invalid", "rate_limited"]);
  });
});

describe("where an invoice stands, by its link", () => {
  it("reports the payment status the database holds and says paid only when the invoice is paid", async () => {
    const s = await setup();
    const status = async () => {
      const r = await paymentStatusByToken(s.token, { ip: freshIp() });
      if (r.state !== "ok") throw new Error(r.state);
      return r.status;
    };
    expect(await status()).toMatchObject({ paymentStatus: "unpaid", balanceMinor: 150000, currency: "PHP", hasPendingPayment: false, banner: { kind: "pay_online" } });
    await providerPayment(s.io, s.inv.id, s.conn!.id, 50000, { provider: "simulated", livemode: true, status: "pending" });
    expect(await status()).toMatchObject({ paymentStatus: "unpaid", hasPendingPayment: true, banner: { kind: "pending" } });
    await providerPayment(s.io, s.inv.id, s.conn!.id, 150000, { provider: "simulated", livemode: true });
    expect(await status()).toMatchObject({ paymentStatus: "paid", balanceMinor: 0, banner: { kind: "paid" } });
    expect((await paymentStatusByToken("A".repeat(43), { ip: freshIp() })).state).toBe("invalid");
    expect((await paymentStatusByToken(s.token.slice(1), { ip: freshIp() })).state).toBe("invalid");
  });

  it("derives a link again from the stored hash only with a key it knows, and never holds the link itself", async () => {
    const s = await setup();
    const row = (await rows<{ public_token_hash: string; public_token_version: number }>("select public_token_hash, public_token_version from customer_invoices where id = $1", [s.inv.id]))[0];
    expect(tokenForStoredHash(s.inv.id, row.public_token_version, row.public_token_hash)).toBe(s.token);
    expect(tokenForStoredHash(s.inv.id, row.public_token_version + 1, row.public_token_hash)).toBeNull();
    expect(row.public_token_hash).not.toContain(s.token);
    for (const table of ["customer_invoices", "customer_invoice_events", "audit_logs", "notifications"]) expect(JSON.stringify(await q(`select * from ${table} where org_id = $1`, [s.io.orgId])), table).not.toContain(s.token);
  });
});

const invoiceStatus = async (id: string) => (await q<{ payment_status: string; paid_minor: string }>("select payment_status, paid_minor::text from customer_invoices where id = $1", [id]))[0];

// The simulated platform and the two environment switches are process-wide: leave them as they were found.
beforeAll(() => simulatedPlatform.reset());
afterAll(() => {
  simulatedPlatform.reset();
  delete process.env.CUSTOMER_PAYMENTS_WRITES_ENABLED;
  delete process.env.CUSTOMER_PAYMENTS_LIVE_ENABLED;
  resetEnvCache();
});
