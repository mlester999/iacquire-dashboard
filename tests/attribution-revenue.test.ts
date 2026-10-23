// Verified revenue in the Lead Sources report, as scenarios a business would recognise: what counts, what is left out and why, who is shown it, and when return on spend may be
// shown. The rules in isolation and against random data are in invoices-revenue.test.ts; the report's older figures are in attribution-service.test.ts.
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { mergeCrmContacts } from "@/server/crm/contacts";
import { redactContact } from "@/server/messaging/contacts";
import { addCost } from "@/server/attribution/costs";
import { attributionReport, NO_TOUCH, type AttributionReport } from "@/server/attribution/report";
import { recordTouch } from "@/server/attribution/touches";
import { setInvoicesEnabled } from "@/server/invoices/feature";
import { applyDisputeInTx } from "@/server/invoices/apply";
import { recordManualPayment, recordRefund } from "@/server/invoices/payments";
import { saveInvoiceSettings } from "@/server/invoices/settings";
import { line, connectionFor, contactIn, invoiceOrg, issuedInvoice, providerPayment, rows, type InvoiceOrg } from "./support/invoices";

let io: InvoiceOrg;
let paymongo: string;
let paypal: string;
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
const today = () => new Date().toISOString().slice(0, 10);

const lead = async (name: string, source: string | null) => {
  const id = await contactIn(io, { firstName: name, lastName: "Lead" });
  if (source) await withSystem((db) => recordTouch(db, { orgId: io.orgId, contactId: id, facts: { kind: "website_form", attribution: { utm_source: source } } }));
  return id;
};
const invoice = async (contactId: string | null, over: { currency?: "PHP" | "USD"; unit?: string; tax?: string } = {}) =>
  (await issuedInvoice(io, { contactId, currency: over.currency ?? "PHP", lines: [line({ unitPrice: over.unit ?? "1500.00", ...(over.tax ? { taxPercent: over.tax } : {}) })] })).invoice;
/** A payment a live provider confirmed, a few hours ago unless said otherwise. */
const paid = (invoiceId: string, minor: number, over: Parameters<typeof providerPayment>[4] = {}) =>
  providerPayment(io, invoiceId, paymongo, minor, { provider: "paymongo", livemode: true, receivedAt: hoursAgo(2), ...over });

const run = (who: Parameters<InvoiceOrg["c"]["actor"]>[0] = "owner", extra: { asOf?: Date } = {}) =>
  attributionReport(io.c.actor(who), { startsAt: new Date(Date.now() - 86_400_000), endsAt: new Date(Date.now() + 86_400_000), ...extra });
const rowOf = (r: AttributionReport, source: string) => r.rows.find((x) => x.source === source)!;
const text = (m: Array<{ currency: string; amount: number }>) => m.map((l) => `${l.currency} ${l.amount}`);

beforeAll(async () => {
  io = await invoiceOrg({ name: "Revenue Co" });
  paymongo = await connectionFor(io, { provider: "paymongo", mode: "live" });
  paypal = await connectionFor(io, { provider: "paypal", mode: "live" });
});

describe("verified revenue", () => {
  it("is money a live payment provider confirmed, without tax, per currency, credited to the source of the lead whose invoice it paid", async () => {
    const g = await lead("Gina", "google");
    const a = await invoice(g);
    await paid(a.id, 150000);
    // 1,000.00 plus 12% tax: the customer paid 1,120.00, of which 120.00 is the owner's tax and not revenue.
    const b = await invoice(g, { unit: "1000.00", tax: "12" });
    await paid(b.id, 112000);
    const g2 = await lead("Gus", "google");
    const c = await invoice(g2, { currency: "USD", unit: "200.00" });
    await providerPayment(io, c.id, paypal, 20000, { provider: "paypal", livemode: true, currency: "USD", receivedAt: hoursAgo(1) });
    const r = await run();
    const google = rowOf(r, "google");
    expect(text(google.verifiedRevenue)).toEqual(["PHP 2500", "USD 200"]);
    expect(google.refunded).toEqual([]);
    expect(google.recordedByHand).toEqual([]);
    expect(r.revenue).toMatchObject({ state: "shown", manualCounted: false, workspaceHasPayments: true });
    expect(text(r.revenue.total)).toEqual(["PHP 2500", "USD 200"]);
    expect(r.notes.join(" ")).toMatch(/Verified revenue is money your payment provider confirmed in live mode/);
    expect(r.notes.join(" ")).toMatch(/net of refunds and leaves out tax/);
    expect(r.notes.join(" ")).toMatch(/Currencies are never added together or converted/);
    expect(r.notes.join(" ")).toMatch(/up to \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
  });

  it("is net of refunds and of the tax in them, and the refund is shown", async () => {
    const f = await lead("Fay", "facebook");
    const inv = await invoice(f, { unit: "1000.00" });
    const p = await paid(inv.id, 60000);
    await recordRefund(io.ctx("owner"), p.paymentId, { amount: "100.00", reason: "Customer returned an item" });
    const row = rowOf(await run(), "facebook");
    expect(text(row.verifiedRevenue)).toEqual(["PHP 500"]);
    expect(text(row.refunded)).toEqual(["PHP 100"]);
  });

  it("leaves out a provider's test mode and says how many were left out, so a test payment is never revenue", async () => {
    const before = text(rowOf(await run(), "google").verifiedRevenue);
    const t = await lead("Tess", "google");
    const inv = await invoice(t, { unit: "500.00" });
    await paid(inv.id, 50000, { livemode: false });
    const sim = await invoice(t, { unit: "400.00" });
    await providerPayment(io, sim.id, await connectionFor(io, { provider: "simulated", mode: "test" }), 40000, { provider: "simulated", livemode: false, receivedAt: hoursAgo(1) });
    const r = await run();
    expect(text(rowOf(r, "google").verifiedRevenue)).toEqual(before);
    expect(r.revenue.testPaymentsExcluded).toBeGreaterThanOrEqual(2);
    expect(r.notes.join(" ")).toMatch(/payments? made in a payment provider's test mode (is|are) left out: no real money moved/);
  });

  it("holds a disputed payment out until the dispute is settled, and says so", async () => {
    const d = await lead("Dee", "linkedin");
    const inv = await invoice(d, { unit: "900.00" });
    const p = await paid(inv.id, 90000);
    expect(text(rowOf(await run(), "linkedin").verifiedRevenue)).toEqual(["PHP 900"]);
    await withSystem((db) => applyDisputeInTx(db, { orgId: io.orgId, paymentId: p.paymentId, open: true, actor: { id: null, kind: "provider" } }));
    const open = await run();
    expect(rowOf(open, "linkedin").verifiedRevenue).toEqual([]);
    expect(open.revenue.disputedHeldOut).toBeGreaterThanOrEqual(1);
    expect(open.notes.join(" ")).toMatch(/under an open dispute and held out/);
    await withSystem((db) => applyDisputeInTx(db, { orgId: io.orgId, paymentId: p.paymentId, open: false, actor: { id: null, kind: "provider" } }));
    expect(text(rowOf(await run(), "linkedin").verifiedRevenue)).toEqual(["PHP 900"]);
  });

  it("counts only leads created in the period, but counts what they paid at any time up to now, and nothing dated after the report", async () => {
    const early = await lead("Early", "bing");
    const inv = await invoice(early, { unit: "300.00" });
    // The lead was created before the period the report covers: its money is not in this cohort.
    await withSystem((db) => db.query("update contacts set created_at = now() - interval '10 days' where id = $1", [early]));
    await paid(inv.id, 30000);
    expect((await run()).rows.find((x) => x.source === "bing")).toBeUndefined();

    const late = await lead("Late", "tiktok");
    const a = await invoice(late, { unit: "600.00" });
    const b = await invoice(late, { unit: "700.00" });
    // Paid a week after the period (relative to the lead), yet before the report is made: counted. Dated after the report: not.
    await paid(a.id, 60000, { receivedAt: hoursAgo(1) });
    await paid(b.id, 70000, { receivedAt: new Date(Date.now() + 10 * 3_600_000) });
    const r = await run();
    expect(text(rowOf(r, "tiktok").verifiedRevenue)).toEqual(["PHP 600"]);
    const later = await run("owner", { asOf: new Date(Date.now() + 20 * 3_600_000) });
    expect(text(rowOf(later, "tiktok").verifiedRevenue)).toEqual(["PHP 1300"]);
    expect(later.revenue.asOf).not.toBe(r.revenue.asOf);
  });

  it("follows a contact that was merged into another: the invoice is credited to the record that stays", async () => {
    const kept = await lead("Kept", "pinterest");
    const merged = await lead("Merged", "reddit");
    const inv = await invoice(merged, { unit: "250.00" });
    await paid(inv.id, 25000);
    expect(text(rowOf(await run(), "reddit").verifiedRevenue)).toEqual(["PHP 250"]);
    await mergeCrmContacts(io.c.actor("owner"), { keptId: kept, mergedId: merged, reason: "Same person, two records" });
    const r = await run();
    expect(text(rowOf(r, "pinterest").verifiedRevenue)).toEqual(["PHP 250"]);
    expect(r.rows.find((x) => x.source === "reddit")?.verifiedRevenue ?? []).toEqual([]);
  });

  it("shows revenue of a lead with no touch on the 'No touch recorded' row, with no return claimed for it", async () => {
    const n = await lead("Nobody", null);
    const inv = await invoice(n, { unit: "120.00" });
    await paid(inv.id, 12000);
    const row = rowOf(await run(), NO_TOUCH);
    expect(text(row.verifiedRevenue)).toEqual(["PHP 120"]);
    expect(row.returnOnSpend).toBeNull();
    expect(row.missing).toBe("Cost and return are not shown for leads with no known source.");
  });

  it("keeps revenue of an invoice whose customer was erased apart: it belongs to no source and is in no total", async () => {
    const e = await lead("Erased", "yelp");
    const inv = await invoice(e, { unit: "300.00" });
    await paid(inv.id, 30000);
    const before = await run();
    expect(text(rowOf(before, "yelp").verifiedRevenue)).toEqual(["PHP 300"]);
    const php = (m: Array<{ currency: string; amount: number }>) => m.find((l) => l.currency === "PHP")?.amount ?? 0;
    await redactContact(io.ctx("owner"), e, "Privacy request received by email");
    const after = await run();
    expect(after.rows.find((x) => x.source === "yelp")).toBeUndefined();
    // It moved from the source to the line of its own, and the total of the sources no longer holds it.
    expect(php(after.revenue.unattributed.verifiedRevenue) - php(before.revenue.unattributed.verifiedRevenue)).toBe(300);
    expect(php(before.revenue.total) - php(after.revenue.total)).toBe(300);
  });
});

describe("a payment somebody recorded by hand", () => {
  it("is shown on its own line and is not revenue, until the owner chooses to count it, and the report says which", async () => {
    const h = await lead("Hand", "yahoo");
    const inv = await invoice(h, { unit: "700.00" });
    await recordManualPayment(io.ctx("owner"), inv.id, { amount: "700.00", receivedOn: today(), method: "bank_transfer", evidence: "Bank transfer ref 4410" });
    const apart = await run();
    const row = rowOf(apart, "yahoo");
    expect(row.verifiedRevenue).toEqual([]);
    expect(text(row.recordedByHand)).toEqual(["PHP 700"]);
    expect(apart.revenue.manualCounted).toBe(false);
    expect(apart.notes.join(" ")).toMatch(/shown on their own line and are not counted as verified revenue/);

    await saveInvoiceSettings(io.ctx("owner"), { countManualAsVerified: true }, (await rows<{ version: number }>("select coalesce(max(version), 0) as version from customer_invoice_settings where org_id = $1", [io.orgId]))[0].version);
    const counted = await run();
    expect(text(rowOf(counted, "yahoo").verifiedRevenue)).toEqual(["PHP 700"]);
    expect(text(rowOf(counted, "yahoo").recordedByHand)).toEqual(["PHP 700"]);
    expect(counted.revenue.manualCounted).toBe(true);
    expect(counted.notes.join(" ")).toMatch(/counted as verified revenue, because you chose that in your invoice settings/);
    await saveInvoiceSettings(io.ctx("owner"), { countManualAsVerified: false }, (await rows<{ version: number }>("select version from customer_invoice_settings where org_id = $1", [io.orgId]))[0].version);
    expect(rowOf(await run(), "yahoo").verifiedRevenue).toEqual([]);
  });
});

describe("return on spend", () => {
  const cost = (owner: ReturnType<InvoiceOrg["c"]["actor"]>, source: string, amount: number, currency: string) =>
    addCost(owner, { source, periodStart: today(), periodEnd: today(), amount, currency });

  it("is worked out only for a source with one cost currency that is also a verified revenue currency, and says what was left out", async () => {
    const owner = io.c.actor("owner");
    const gold = await lead("Goldie", "gold-source");
    const inv = await invoice(gold, { unit: "3000.00" });
    await paid(inv.id, 300000);
    const usd = await invoice(gold, { currency: "USD", unit: "50.00" });
    await providerPayment(io, usd.id, paypal, 5000, { provider: "paypal", livemode: true, currency: "USD", receivedAt: hoursAgo(1) });
    await cost(owner, "gold-source", 1000, "PHP");
    const row = rowOf(await run(), "gold-source");
    // (3,000 - 1,000) / 1,000 = 200%, in pesos. The dollars are not converted and not included, and that is said.
    expect(row).toMatchObject({ returnOnSpend: 2, returnCurrency: "PHP" });
    expect(row.missing).toBe("Revenue in USD is not included: it is not converted.");
    expect(row.costPerLead).toEqual({ currency: "PHP", amount: 1000 });
  });

  it("is not shown when the cost and the revenue are in different currencies, and says so without converting anything", async () => {
    const owner = io.c.actor("owner");
    const s = await lead("Silvia", "silver-source");
    const inv = await invoice(s, { unit: "800.00" });
    await paid(inv.id, 80000);
    await cost(owner, "silver-source", 100, "USD");
    const row = rowOf(await run(), "silver-source");
    expect(row.returnOnSpend).toBeNull();
    expect(row.missing).toBe("Revenue (PHP) and cost (USD) are in different currencies, which are not converted, so no return is shown.");
  });

  it("is not shown when the cost was entered in several currencies, and not as minus one hundred percent when a source simply has no verified payments yet", async () => {
    const owner = io.c.actor("owner");
    await lead("Bronte", "bronze-source");
    await cost(owner, "bronze-source", 100, "USD");
    await cost(owner, "bronze-source", 5000, "PHP");
    const several = rowOf(await run(), "bronze-source");
    expect(several.returnOnSpend).toBeNull();
    expect(several.missing).toBe("Cost was entered in several currencies, which are not converted, so no return is shown.");

    await lead("Copper", "copper-source");
    await cost(owner, "copper-source", 100, "PHP");
    const none = rowOf(await run(), "copper-source");
    expect(none.returnOnSpend).toBeNull();
    expect(none.verifiedRevenue).toEqual([]);
    expect(none.missing).toBe("No verified payments from these leads yet.");
    await lead("Nickel", "nickel-source");
    expect(rowOf(await run(), "nickel-source").missing).toBe("Needs an entered campaign cost.");
  });
});

describe("who is shown it, and when", () => {
  it("shows revenue to people who may see invoices, and to nobody else: others see everything else in the report and are told why revenue is missing", async () => {
    const g = rowOf(await run("owner"), "google");
    expect(g.verifiedRevenue.length).toBeGreaterThan(0);
    for (const who of ["manager", "sales"] as const) {
      const r = await run(who);
      expect(r.revenue.state, who).toBe("shown");
      expect(text(rowOf(r, "google").verifiedRevenue), who).toEqual(text(g.verifiedRevenue));
    }
    for (const who of ["setter", "support", "viewer"] as const) {
      const r = await run(who);
      expect(r.revenue.state, who).toBe("hidden");
      expect(rowOf(r, "google")).toMatchObject({ verifiedRevenue: [], refunded: [], recordedByHand: [], returnOnSpend: null, missing: "Verified revenue is shown to people who can see invoices." });
      expect(rowOf(r, "google").leads).toBe(g.leads);
      expect(r.revenue.total).toEqual([]);
      expect(r.revenue.unattributed).toEqual({ verifiedRevenue: [], refunded: [], recordedByHand: [] });
      expect(r.notes).toContain("Verified revenue is shown to people who can see invoices.");
      expect(JSON.stringify(r)).not.toMatch(/"minor":"[1-9]/);
    }
  });

  it("reads nothing, and says the module is not switched on, for a workspace that has no invoicing, and never mixes in another workspace's money", async () => {
    const plain = await invoiceOrg({ enabled: false });
    const l = await contactIn(plain, { firstName: "Plain", lastName: "Lead" });
    await withSystem((db) => recordTouch(db, { orgId: plain.orgId, contactId: l, facts: { kind: "website_form", attribution: { utm_source: "google" } } }));
    const r = await attributionReport(plain.c.actor("owner"), { startsAt: new Date(Date.now() - 86_400_000), endsAt: new Date(Date.now() + 86_400_000) });
    expect(r.revenue).toMatchObject({ state: "off", total: [], workspaceHasPayments: false });
    expect(rowOf(r, "google")).toMatchObject({ verifiedRevenue: [], missing: "Needs an entered campaign cost and verified payments." });
    expect(r.notes.join(" ")).toMatch(/not switched on for this workspace/);
    // Switching it off later hides the revenue again; the records stay.
    const before = (await rows<{ n: number }>("select count(*)::int as n from customer_payments where org_id = $1", [io.orgId]))[0].n;
    await setInvoicesEnabled(io.superAdmin, io.orgId, false);
    expect((await run()).revenue.state).toBe("off");
    await setInvoicesEnabled(io.superAdmin, io.orgId, true);
    expect((await run()).revenue.state).toBe("shown");
    expect((await rows<{ n: number }>("select count(*)::int as n from customer_payments where org_id = $1", [io.orgId]))[0].n).toBe(before);
    // The first workspace's report holds none of the second's rows, and never any figure of iAcquire's own billing.
    expect(JSON.stringify(await run())).not.toContain(plain.orgId);
  });

  it("says 'needs verified payments' for a workspace with invoicing but no customer payment at all", async () => {
    const fresh = await invoiceOrg();
    const l = await contactIn(fresh, { firstName: "Fresh", lastName: "Lead" });
    await withSystem((db) => recordTouch(db, { orgId: fresh.orgId, contactId: l, facts: { kind: "website_form", attribution: { utm_source: "google" } } }));
    const r = await attributionReport(fresh.c.actor("owner"), { startsAt: new Date(Date.now() - 86_400_000), endsAt: new Date(Date.now() + 86_400_000) });
    expect(r.revenue).toMatchObject({ state: "shown", workspaceHasPayments: false, total: [] });
    expect(rowOf(r, "google").missing).toBe("Needs an entered campaign cost and verified payments.");
    expect(r.notes.join(" ")).toMatch(/No customer payment has been recorded yet/);
  });
});
