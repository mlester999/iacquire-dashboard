// Verified revenue: what counts, as pure rules, and the same rules applied by the database over random payments. The report's SQL and the rules in src/lib/invoices/revenue.ts
// are written twice on purpose; the second half of this file runs both over the same randomly generated payments, refunds, taxes, modes and dates and refuses any difference.
import { describe, expect, it } from "vitest";
import { taxPortion } from "@/lib/money";
import {
  COUNTED_PAYMENT_STATUSES, classifyPayment, emptyFigures, figuresFromRows, minorTextToMoney, paymentRevenue, sumMoney,
  type MoneyLine, type PaymentFacts, type PaymentStatus, type RevenueClass,
} from "@/lib/invoices/revenue";
import { withSystem } from "@/server/db";
import { attributionReport } from "@/server/attribution/report";
import { recordTouch } from "@/server/attribution/touches";
import { saveInvoiceSettings } from "@/server/invoices/settings";
import { connectionFor, contactIn, invoiceOrg, issuedInvoice, rows, type InvoiceOrg } from "./support/invoices";

// A small deterministic generator so the property checks are repeatable.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
const int = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];

const ASOF = new Date("2026-10-24T12:00:00Z");
const BEFORE = new Date("2026-10-23T12:00:00Z");
const AFTER = new Date("2026-10-25T12:00:00Z");
const STATUSES: PaymentStatus[] = ["succeeded", "pending", "failed", "needs_review", "partially_refunded", "refunded", "disputed"];

describe("what counts as verified revenue", () => {
  const expected = (p: PaymentFacts): RevenueClass => {
    if (p.receivedAt > ASOF) return "not_money";
    if (p.status === "disputed") return "held";
    if (!["succeeded", "partially_refunded", "refunded"].includes(p.status)) return "not_money";
    if (p.verification === "manual") return "by_hand";
    return p.livemode && (p.provider === "paymongo" || p.provider === "paypal") ? "verified" : "test";
  };

  it("classifies every combination of provider, who vouched for it, mode, status and date, and only a live provider-confirmed payment already received is verified", () => {
    let verified = 0;
    let total = 0;
    for (const provider of ["paymongo", "paypal", "simulated", "manual"] as const) for (const verification of ["provider_confirmed", "manual"] as const) for (const livemode of [false, true]) for (const status of STATUSES) for (const receivedAt of [BEFORE, ASOF, AFTER]) {
      const p: PaymentFacts = { provider, verification, livemode, status, receivedAt };
      const c = classifyPayment(p, ASOF);
      expect(c, JSON.stringify(p)).toBe(expected(p));
      total += 1;
      if (c === "verified") {
        verified += 1;
        expect(verification).toBe("provider_confirmed");
        expect(livemode).toBe(true);
        expect(["paymongo", "paypal"]).toContain(provider);
        expect(["succeeded", "partially_refunded", "refunded"]).toContain(status);
        expect(receivedAt.getTime()).toBeLessThanOrEqual(ASOF.getTime());
      }
    }
    expect(total).toBe(4 * 2 * 2 * 7 * 3);
    expect(verified).toBeGreaterThan(0);
    expect(COUNTED_PAYMENT_STATUSES).toEqual(["succeeded", "partially_refunded", "refunded"]);
  });

  it("never lets the simulated provider, a provider's test mode, a payment kept for review, a pending or failed one, or one under dispute into revenue", () => {
    const base: PaymentFacts = { provider: "paymongo", verification: "provider_confirmed", livemode: true, status: "succeeded", receivedAt: BEFORE };
    expect(classifyPayment(base, ASOF)).toBe("verified");
    expect(classifyPayment({ ...base, provider: "simulated" }, ASOF)).toBe("test");
    expect(classifyPayment({ ...base, livemode: false }, ASOF)).toBe("test");
    for (const status of ["pending", "failed", "needs_review"] as const) expect(classifyPayment({ ...base, status }, ASOF)).toBe("not_money");
    expect(classifyPayment({ ...base, status: "disputed" }, ASOF)).toBe("held");
    expect(classifyPayment({ ...base, receivedAt: AFTER }, ASOF)).toBe("not_money");
    expect(classifyPayment({ ...base, provider: "manual", verification: "manual" }, ASOF)).toBe("by_hand");
  });
});

describe("the revenue in one payment", () => {
  it("is the payment less its tax, less what was refunded of it less the tax in the refunds", () => {
    expect(paymentRevenue({ amountMinor: 112000, taxPortionMinor: 12000, refunds: [] })).toEqual({ paidExTaxMinor: 100000, refundedExTaxMinor: 0, netMinor: 100000 });
    expect(paymentRevenue({ amountMinor: 112000, taxPortionMinor: 12000, refunds: [{ amountMinor: 11200, taxPortionMinor: 1200 }] })).toEqual({ paidExTaxMinor: 100000, refundedExTaxMinor: 10000, netMinor: 90000 });
    expect(paymentRevenue({ amountMinor: 112000, taxPortionMinor: 12000, refunds: [{ amountMinor: 112000, taxPortionMinor: 12000 }] })).toEqual({ paidExTaxMinor: 100000, refundedExTaxMinor: 100000, netMinor: 0 });
  });

  it("is exactly nothing when a payment is refunded in full, even when the rounded tax of several refunds adds up to more or less than the payment's tax", () => {
    // 2 with 1 of tax, refunded as 1 + 1, each carrying a rounded 1 of tax: more tax than the payment held.
    expect(paymentRevenue({ amountMinor: 2, taxPortionMinor: 1, refunds: [{ amountMinor: 1, taxPortionMinor: 1 }, { amountMinor: 1, taxPortionMinor: 1 }] }).netMinor).toBe(0);
    // 3 with 1 of tax, refunded as 1 + 1 + 1, each carrying a rounded 0: less tax than the payment held.
    expect(paymentRevenue({ amountMinor: 3, taxPortionMinor: 1, refunds: [{ amountMinor: 1, taxPortionMinor: 0 }, { amountMinor: 1, taxPortionMinor: 0 }, { amountMinor: 1, taxPortionMinor: 0 }] })).toEqual({ paidExTaxMinor: 2, refundedExTaxMinor: 2, netMinor: 0 });
  });

  it("holds for any payment: never negative, never more than was paid, the parts add up, and another refund never raises it", () => {
    const r = rng(20261024);
    for (let i = 0; i < 4000; i += 1) {
      const amount = int(r, 1, 900_000_000);
      const tax = int(r, 0, Math.floor(amount / 4));
      const refunds: Array<{ amountMinor: number; taxPortionMinor: number }> = [];
      let left = amount;
      for (let k = int(r, 0, 4); k > 0 && left > 0; k -= 1) {
        const a = int(r, 1, left);
        left -= a;
        refunds.push({ amountMinor: a, taxPortionMinor: taxPortion(a, tax, amount) });
      }
      const v = paymentRevenue({ amountMinor: amount, taxPortionMinor: tax, refunds });
      const label = JSON.stringify({ amount, tax, refunds });
      expect(v.paidExTaxMinor, label).toBe(amount - tax);
      expect(v.netMinor, label).toBeGreaterThanOrEqual(0);
      expect(v.refundedExTaxMinor, label).toBeGreaterThanOrEqual(0);
      expect(v.refundedExTaxMinor, label).toBeLessThanOrEqual(v.paidExTaxMinor);
      expect(v.netMinor + v.refundedExTaxMinor, label).toBe(v.paidExTaxMinor);
      if (refunds.length === 0) expect(v.netMinor, label).toBe(amount - tax);
      if (left === 0 && refunds.length > 0) expect(v.netMinor, label).toBe(0);
      if (left > 0) {
        const more = paymentRevenue({ amountMinor: amount, taxPortionMinor: tax, refunds: [...refunds, { amountMinor: left, taxPortionMinor: taxPortion(left, tax, amount) }] });
        expect(more.netMinor, label).toBeLessThanOrEqual(v.netMinor);
      }
    }
  });
});

describe("money in the report's figures", () => {
  it("makes exact decimal amounts from the minor units, in each currency's own decimals, with the exact digits kept alongside", () => {
    expect(minorTextToMoney("150000", "PHP")).toEqual({ currency: "PHP", amount: 1500, minor: "150000" });
    expect(minorTextToMoney("5", "USD")).toEqual({ currency: "USD", amount: 0.05, minor: "5" });
    expect(minorTextToMoney("1500", "JPY")).toEqual({ currency: "JPY", amount: 1500, minor: "1500" });
    expect(minorTextToMoney("0", "EUR")).toEqual({ currency: "EUR", amount: 0, minor: "0" });
    expect(minorTextToMoney("-250", "GBP")).toEqual({ currency: "GBP", amount: -2.5, minor: "-250" });
    expect(minorTextToMoney("12345678901234567890", "USD")?.minor).toBe("12345678901234567890");
    for (const [text, currency] of [["12.5", "PHP"], ["abc", "PHP"], ["", "PHP"], ["100", "XYZ"], ["100", "php"]] as const) expect(minorTextToMoney(text, currency), `${text} ${currency}`).toBeNull();
  });

  it("adds up per currency without ever mixing two, and the sum of many small amounts is exact where floating point is not", () => {
    const tenths: MoneyLine[] = Array.from({ length: 10 }, () => minorTextToMoney("10", "USD")!);
    expect(sumMoney([tenths])).toEqual([{ currency: "USD", amount: 1, minor: "100" }]);
    expect(0.1 * 3).not.toBe(0.3);
    expect(sumMoney([[minorTextToMoney("10", "USD")!], [minorTextToMoney("20", "USD")!], [minorTextToMoney("30", "PHP")!]])).toEqual([{ currency: "PHP", amount: 0.3, minor: "30" }, { currency: "USD", amount: 0.3, minor: "30" }]);
    expect(sumMoney([])).toEqual([]);
  });

  it("builds a source's figures: provider money is verified, hand-recorded money is shown apart unless the owner counts it, refunds come off, and no currency meets another", () => {
    const rowsIn = [
      { currency: "PHP", verification: "provider_confirmed" as const, paidExTax: "250000", refundedExTax: "50000" },
      { currency: "USD", verification: "provider_confirmed" as const, paidExTax: "20000", refundedExTax: "0" },
      { currency: "PHP", verification: "manual" as const, paidExTax: "70000", refundedExTax: "10000" },
      { currency: "XYZ", verification: "provider_confirmed" as const, paidExTax: "999", refundedExTax: "0" },
    ];
    const apart = figuresFromRows(rowsIn, false);
    expect(apart.verifiedRevenue.map((l) => `${l.currency}:${l.minor}`)).toEqual(["PHP:200000", "USD:20000"]);
    expect(apart.refunded.map((l) => `${l.currency}:${l.minor}`)).toEqual(["PHP:50000"]);
    expect(apart.recordedByHand.map((l) => `${l.currency}:${l.minor}`)).toEqual(["PHP:60000"]);
    const counted = figuresFromRows(rowsIn, true);
    expect(counted.verifiedRevenue.map((l) => `${l.currency}:${l.minor}`)).toEqual(["PHP:260000", "USD:20000"]);
    expect(counted.refunded.map((l) => `${l.currency}:${l.minor}`)).toEqual(["PHP:60000"]);
    expect(counted.recordedByHand).toEqual(apart.recordedByHand);
    expect(figuresFromRows([], true)).toEqual(emptyFigures());
  });
});

// ---------------------------------------------------------------------------
// The same rules, applied by the database
// ---------------------------------------------------------------------------

interface Seeded {
  currency: "PHP" | "USD";
  facts: PaymentFacts;
  amount: number;
  tax: number;
  refunds: Array<{ amountMinor: number; taxPortionMinor: number; status: "succeeded" | "pending" | "failed" }>;
}

async function seed(io: InvoiceOrg, contactId: string, asOf: Date, r: () => number, count: number): Promise<Seeded[]> {
  const invoices = { PHP: [] as string[], USD: [] as string[] };
  for (const currency of ["PHP", "USD"] as const) for (let i = 0; i < 3; i += 1) invoices[currency].push((await issuedInvoice(io, { contactId, currency })).invoice.id);
  const connections = { paymongo: await connectionFor(io, { provider: "paymongo", mode: "live" }), paypal: await connectionFor(io, { provider: "paypal", mode: "live" }), simulated: await connectionFor(io, { provider: "simulated", mode: "test" }) };
  const out: Seeded[] = [];
  for (let n = 0; n < count; n += 1) {
    const currency = pick(r, ["PHP", "USD"] as const);
    const provider = pick(r, ["paymongo", "paymongo", "paypal", "simulated", "manual", "manual"] as const);
    const manual = provider === "manual";
    const amount = int(r, 100, 500_000);
    const tax = int(r, 0, Math.floor(amount / 5));
    const status = pick(r, STATUSES);
    // Some payments are dated after the report, which must leave them out.
    const receivedAt = new Date(asOf.getTime() + (r() < 0.12 ? int(r, 1, 20) * 3_600_000 : -int(r, 1, 240) * 3_600_000));
    const facts: PaymentFacts = { provider, verification: manual ? "manual" : "provider_confirmed", livemode: manual ? true : r() < 0.7, status, receivedAt };
    const invoiceId = pick(r, invoices[currency]);
    const id = (await withSystem((db) => db.query<{ id: string }>(
      `insert into customer_payments (org_id, invoice_id, connection_id, provider, provider_payment_id, amount_minor, tax_portion_minor, currency, livemode, verification, status, received_at, evidence)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
      [io.orgId, invoiceId, manual ? null : connections[provider as "paymongo" | "paypal" | "simulated"], provider, manual ? null : `pay_${n}_${Math.floor(r() * 1e9)}`, amount, tax, currency, facts.livemode, facts.verification, status, receivedAt,
        manual ? "A receipt the owner kept" : null],
    ))).rows[0].id;
    const refunds: Seeded["refunds"] = [];
    if (["succeeded", "partially_refunded", "refunded", "disputed"].includes(status)) {
      let left = amount;
      for (let k = int(r, 0, 3); k > 0 && left > 0; k -= 1) {
        const a = int(r, 1, left);
        const kind = pick(r, ["succeeded", "succeeded", "pending", "failed"] as const);
        if (kind === "succeeded") left -= a;
        const t = taxPortion(a, tax, amount);
        await withSystem((db) => db.query("insert into customer_refunds (org_id, payment_id, invoice_id, currency, amount_minor, tax_portion_minor, status, source, reason) values ($1, $2, $3, $4, $5, $6, $7, 'manual_record', 'Refund for the test')", [io.orgId, id, invoiceId, currency, a, t, kind]));
        refunds.push({ amountMinor: a, taxPortionMinor: t, status: kind });
      }
    }
    out.push({ currency, facts, amount, tax, refunds });
  }
  return out;
}

/** What the rules say, worked out in JavaScript with BigInt, apart from the SQL. */
function expectedFor(payments: Seeded[], asOf: Date, manualCounted: boolean) {
  const verified: Record<string, bigint> = {};
  const refunded: Record<string, bigint> = {};
  const byHand: Record<string, bigint> = {};
  let test = 0;
  let held = 0;
  const add = (m: Record<string, bigint>, c: string, by: number) => void (m[c] = (m[c] ?? 0n) + BigInt(by));
  for (const p of payments) {
    const cls = classifyPayment(p.facts, asOf);
    const v = paymentRevenue({ amountMinor: p.amount, taxPortionMinor: p.tax, refunds: p.refunds.filter((x) => x.status === "succeeded") });
    if (cls === "verified") {
      add(verified, p.currency, v.netMinor);
      add(refunded, p.currency, v.refundedExTaxMinor);
    } else if (cls === "by_hand") {
      add(byHand, p.currency, v.netMinor);
      if (manualCounted) {
        add(verified, p.currency, v.netMinor);
        add(refunded, p.currency, v.refundedExTaxMinor);
      }
    } else if (cls === "test") test += 1;
    else if (cls === "held") held += 1;
  }
  const show = (m: Record<string, bigint>, dropZero = false) => Object.entries(m).filter(([, v]) => !dropZero || v !== 0n).map(([c, v]) => `${c}:${v}`).sort();
  return { verified: show(verified), refunded: show(refunded, true), byHand: show(byHand), test, held };
}

describe("the database and the rules agree", () => {
  it("over random payments, refunds, taxes, modes, providers, statuses and dates: verified revenue, refunds, hand-recorded money, test payments and held-out disputes, with and without counting hand-recorded money", async () => {
    const io = await invoiceOrg();
    const asOf = new Date();
    const contactId = await contactIn(io, { firstName: "Random", lastName: "Lead" });
    await withSystem((db) => recordTouch(db, { orgId: io.orgId, contactId, facts: { kind: "website_form", attribution: { utm_source: "alpha" } } }));
    const payments = await seed(io, contactId, asOf, rng(1031), 90);
    // A second workspace with its own money, which must never reach the first one's report.
    const other = await invoiceOrg();
    const stranger = await contactIn(other, { firstName: "Stranger", lastName: "Lead" });
    await withSystem((db) => recordTouch(db, { orgId: other.orgId, contactId: stranger, facts: { kind: "website_form", attribution: { utm_source: "alpha" } } }));
    await seed(other, stranger, asOf, rng(77), 20);

    const period = { startsAt: new Date(asOf.getTime() - 86_400_000), endsAt: new Date(asOf.getTime() + 86_400_000), asOf };
    const lines = (m: Array<{ currency: string; minor?: string }>) => m.map((l) => `${l.currency}:${l.minor}`).sort();
    for (const manualCounted of [false, true]) {
      if (manualCounted) await saveInvoiceSettings(io.ctx("owner"), { countManualAsVerified: true }, 0);
      const report = await attributionReport(io.c.actor("owner"), period);
      const row = report.rows.find((x) => x.source === "alpha")!;
      const want = expectedFor(payments, asOf, manualCounted);
      expect(report.revenue.state).toBe("shown");
      expect(report.revenue.manualCounted).toBe(manualCounted);
      expect(lines(row.verifiedRevenue), `verified, manual counted: ${manualCounted}`).toEqual(want.verified);
      expect(lines(row.refunded), "refunded").toEqual(want.refunded);
      expect(lines(row.recordedByHand), "by hand").toEqual(want.byHand);
      expect(report.revenue.testPaymentsExcluded, "test payments").toBe(want.test);
      expect(report.revenue.disputedHeldOut, "held out").toBe(want.held);
      expect(lines(report.revenue.total)).toEqual(want.verified);
      // Every amount shown is the exact decimal of the exact digits.
      for (const l of row.verifiedRevenue) expect(l.amount).toBe(Number(minorTextToMoney(l.minor!, l.currency)!.amount));
    }
    expect(payments.some((p) => classifyPayment(p.facts, asOf) === "verified")).toBe(true);
    expect(payments.some((p) => classifyPayment(p.facts, asOf) === "test")).toBe(true);
    expect(payments.some((p) => classifyPayment(p.facts, asOf) === "held")).toBe(true);
    expect(payments.some((p) => p.refunds.some((x) => x.status !== "succeeded"))).toBe(true);
    expect((await rows("select count(*)::int as n from customer_payments where org_id = $1", [io.orgId]))[0]).toMatchObject({ n: 90 });
  }, 120_000);
});
