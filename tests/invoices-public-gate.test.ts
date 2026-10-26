// A workspace that takes no customers (suspended, archived, paused by iAcquire) shows no invoice and starts no payment through the customer's link, while money that is already
// on its way is still recorded: a provider's report of a payment never asks the workspace's state. Embedded Postgres; no provider.
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { startCheckout } from "@/server/customer-payments/attempts";
import { loadPublicInvoice, loadReturn, paymentStatusByReference, paymentStatusByToken, startPublicPayment } from "@/server/invoices/public";
import { workspaceTakesNoCustomers } from "@/server/invoices/workspace-gate";
import { orgTakesNoAnswers } from "@/server/esign/core";
import { handlePay, handleStatus } from "@/server/invoices/public-http";
import { PAY_ENDPOINT, STATUS_ENDPOINT, TOKEN_HEADER } from "@/lib/invoices/public-http";
import { invoiceOrg, issuedInvoice, freshIp, linkTokenOf, rows } from "./support/invoices";
import { connect, deliver, invoiceNow, paymentsOf, simulatedSetup } from "./support/customer-payments";
import { simulatedPlatform } from "@/server/customer-payments/providers/simulated";

const ctx = () => ({ ip: freshIp() });
const UNAVAILABLE = "Online payment is not available for this invoice right now. Please contact the business to arrange payment.";

async function shop() {
  const io = await invoiceOrg();
  // The testing checkout (the simulated connection) takes a test invoice only.
  const inv = (await issuedInvoice(io, { isTest: true })).invoice;
  const conn = await connect(io, { provider: "simulated" });
  const token = await linkTokenOf(io, inv.id);
  return { io, inv, conn, token };
}
const attemptsOf = (invoiceId: string) => rows("select id from customer_payment_attempts where invoice_id = $1", [invoiceId]);

/** The states in which a workspace takes no customers, each made and undone the way the product makes it. */
const STOPPED: Array<[string, (orgId: string) => Promise<void>, (orgId: string) => Promise<void>]> = [
  ["suspended", (o) => withSystem((db) => db.query("update organizations set status = 'suspended' where id = $1", [o])).then(() => undefined), (o) => withSystem((db) => db.query("update organizations set status = 'active' where id = $1", [o])).then(() => undefined)],
  ["archived", (o) => withSystem((db) => db.query("update organizations set status = 'archived' where id = $1", [o])).then(() => undefined), (o) => withSystem((db) => db.query("update organizations set status = 'active' where id = $1", [o])).then(() => undefined)],
  ["paused by iAcquire", (o) => withSystem((db) => db.query("insert into automation_pauses (org_id, scope, active) values ($1, 'agency', true) on conflict (org_id, scope) do update set active = true", [o])).then(() => undefined), (o) => withSystem((db) => db.query("update automation_pauses set active = false where org_id = $1 and scope = 'agency'", [o])).then(() => undefined)],
];

describe("a workspace that takes no customers", () => {
  for (const [name, stop, resume] of STOPPED) {
    it(`shows no invoice and records no 'opened', starts no payment and answers no status check when it is ${name}, and goes on as before when it is not`, async () => {
      const s = await shop();
      await stop(s.io.orgId);
      expect(await loadPublicInvoice(s.token, ctx())).toEqual({ state: "unavailable" });
      expect(await rows("select 1 from customer_invoice_events where invoice_id = $1 and kind = 'viewed'", [s.inv.id])).toEqual([]);
      expect((await rows<{ first_viewed_at: Date | null }>("select first_viewed_at from customer_invoices where id = $1", [s.inv.id]))[0].first_viewed_at).toBeNull();
      expect(await startPublicPayment(s.token, ctx())).toEqual({ ok: false, reason: "unavailable", message: UNAVAILABLE });
      expect(await paymentStatusByToken(s.token, ctx())).toEqual({ state: "unavailable" });
      expect(await attemptsOf(s.inv.id)).toEqual([]);
      // The door every customer payment goes through says no by itself, whoever asks it.
      await expect(startCheckout({ orgId: s.io.orgId, invoiceId: s.inv.id, audience: "public" })).rejects.toMatchObject({ code: "unavailable", message: UNAVAILABLE });
      expect(await attemptsOf(s.inv.id)).toEqual([]);
      // And the HTTP layer: the same 503 for the pay button and the status check, with a time to come back, naming nothing.
      const pay = await handlePay(new Request(`http://localhost${PAY_ENDPOINT}`, { method: "POST", headers: { [TOKEN_HEADER]: s.token, "x-forwarded-for": freshIp(), "x-forwarded-host": "localhost" } }));
      expect(pay.status).toBe(503);
      expect(await pay.json()).toEqual({ error: "unavailable", message: UNAVAILABLE });
      const status = await handleStatus(new Request(`http://localhost${STATUS_ENDPOINT}`, { headers: { [TOKEN_HEADER]: s.token, "x-forwarded-for": freshIp(), "x-forwarded-host": "localhost" } }));
      expect(status.status).toBe(503);
      expect(status.headers.get("retry-after")).toBe("300");
      expect(await status.json()).toEqual({ error: "unavailable" });

      await resume(s.io.orgId);
      expect((await loadPublicInvoice(s.token, ctx())).state).toBe("ok");
      expect((await startPublicPayment(s.token, ctx())).ok).toBe(true);
      expect((await paymentStatusByToken(s.token, ctx())).state).toBe("ok");
    });
  }

  it("is the same reading as the customer's proposal page and the signing requests", async () => {
    const s = await shop();
    const same = async () => expect(await withSystem((db) => workspaceTakesNoCustomers(db, s.io.orgId))).toBe(await withSystem((db) => orgTakesNoAnswers(db, s.io.orgId)));
    await same();
    for (const [, stop, resume] of STOPPED) {
      await stop(s.io.orgId);
      await same();
      expect(await withSystem((db) => workspaceTakesNoCustomers(db, s.io.orgId))).toBe(true);
      await resume(s.io.orgId);
    }
    expect(await withSystem((db) => workspaceTakesNoCustomers(db, s.io.orgId))).toBe(false);
    // A workspace that does not exist takes none.
    expect(await withSystem((db) => workspaceTakesNoCustomers(db, "00000000-0000-4000-8000-000000000000"))).toBe(true);
    // The workspace's own outbound pause is about messages, not customers paying a bill they already have.
    await withSystem((db) => db.query("insert into automation_pauses (org_id, scope, active) values ($1, 'outbound', true)", [s.io.orgId]));
    expect(await withSystem((db) => workspaceTakesNoCustomers(db, s.io.orgId))).toBe(false);
    expect((await loadPublicInvoice(s.token, ctx())).state).toBe("ok");
  });

  it("still records a payment the provider reports for a checkout started before, and shows the customer where it stands", async () => {
    const s = await simulatedSetup();
    const paid = simulatedPlatform.pay(s.a.checkoutId!, s.conn.webhookSecret);
    await withSystem((db) => db.query("update organizations set status = 'suspended' where id = $1", [s.io.orgId]));
    expect((await deliver(s.conn, paid.rawBody, { signature: paid.signature })).outcome).toBe("processed");
    expect(await paymentsOf(s.inv.id)).toMatchObject([{ status: "succeeded", provider_payment_id: paid.paymentId }]);
    expect((await invoiceNow(s.inv.id)).payment_status).toBe("paid");
    // The page the provider sends the customer back to still says what the database holds, and so does the check of that checkout.
    const back = await loadReturn(s.a.reference, ctx());
    expect(back.state).toBe("ok");
    if (back.state === "ok") expect(back.view.description.state).toBe("received");
    expect((await paymentStatusByReference(s.a.reference, ctx())).state).toBe("ok");
    const token = await linkTokenOf(s.io, s.inv.id);
    expect((await loadPublicInvoice(token, ctx())).state).toBe("unavailable");
  });

  it("leaves another workspace's invoices alone", async () => {
    const stopped = await shop();
    const open = await shop();
    await withSystem((db) => db.query("update organizations set status = 'suspended' where id = $1", [stopped.io.orgId]));
    expect((await loadPublicInvoice(open.token, ctx())).state).toBe("ok");
    expect((await startPublicPayment(open.token, ctx())).ok).toBe(true);
    expect(await loadPublicInvoice(stopped.token, ctx())).toEqual({ state: "unavailable" });
  });
});
