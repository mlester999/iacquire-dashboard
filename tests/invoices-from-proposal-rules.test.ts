// The pure rules for making a draft invoice from an accepted proposal: which proposals count as accepted, what is copied (the lines the customer pays once, with the same figures),
// what is left for the owner to decide (the monthly and yearly lines), and every case where nothing is made. No database.
import { describe, expect, it } from "vitest";
import { CURRENCY_CODES, lineAmounts, type CurrencyCode } from "@/lib/money";
import type { DocLine, ProposalDoc } from "@/lib/proposals/doc";
import { freeze, type ProposalSnapshot } from "@/lib/proposals/snapshot";
import { parseLines, MAX_DESCRIPTION } from "@/lib/invoices/lines";
import {
  ACCEPTANCE_BASIS_TEXT, acceptedForInvoicing, invoiceDescription, invoiceKeyFor, planInvoiceFromSnapshot, type AcceptanceFacts,
} from "@/lib/invoices/from-proposal";

const line = (over: Partial<DocLine> = {}): DocLine => ({
  id: "line-aaaaaa", catalogItemId: null, name: "Website build", description: "Design and build of a five page website.", unitLabel: "project", quantityMilli: 1000, unitPriceMinor: 150_000,
  catalogPriceMinor: null, billing: "one_time", taxRateId: null, taxName: null, taxBps: 0, discount: null, note: "", ...over,
});

function snapshotOf(lines: DocLine[], currency: CurrencyCode | string = "USD"): ProposalSnapshot {
  const doc: ProposalDoc = { v: 1, sections: [], lines, terms: "" };
  const frozen = freeze({
    number: "P-0001", title: "Website proposal", currency: currency as CurrencyCode, validUntil: null, requiresSignature: false, client: { name: "Maria Santos", company: "", email: null },
    business: { name: "Acme", website: null }, sender: { name: null }, dealName: null, doc,
  });
  expect(frozen.missing).toEqual([]);
  return frozen.snapshot;
}

describe("which proposals count as accepted for an invoice", () => {
  const HASH = "a".repeat(64);
  const accepted = (over: Partial<AcceptanceFacts> = {}): AcceptanceFacts => ({
    status: "accepted", version: 2, sentVersion: 2, requiresSignature: false, signatureState: "none",
    decision: { decision: "accepted", method: "verified_acknowledgement", version: 2, contentHash: HASH }, versionContentHash: HASH, ...over,
  });
  const withDecision = (method: "verified_acknowledgement" | "provider_signature" | "recorded_by_staff", over: Partial<AcceptanceFacts> = {}) =>
    accepted({ decision: { decision: "accepted", method, version: 2, contentHash: HASH }, ...over });

  it("accepts a customer's verified acknowledgement, and says it was that", () => {
    expect(acceptedForInvoicing(accepted())).toEqual({ ok: true, basis: "acknowledged_online", text: ACCEPTANCE_BASIS_TEXT.acknowledged_online });
  });

  it("accepts an answer a person recorded, and says it was the person's word and not the customer's", () => {
    const r = acceptedForInvoicing(withDecision("recorded_by_staff"));
    expect(r).toMatchObject({ ok: true, basis: "answer_recorded_by_person" });
    expect(ACCEPTANCE_BASIS_TEXT.answer_recorded_by_person).toMatch(/did not verify/);
  });

  it("accepts a proposal that asked for a signature only when its record says it was signed through a service, or that a person recorded the signing as done offline", () => {
    expect(acceptedForInvoicing(withDecision("provider_signature", { requiresSignature: true, signatureState: "completed" }))).toMatchObject({ ok: true, basis: "signed_through_service" });
    const offline = acceptedForInvoicing(withDecision("recorded_by_staff", { requiresSignature: true, signatureState: "recorded_offline" }));
    expect(offline).toMatchObject({ ok: true, basis: "signing_recorded_offline" });
    expect(ACCEPTANCE_BASIS_TEXT.signing_recorded_offline).toMatch(/signing service did not verify/);
  });

  it("refuses a proposal that asked for a signature whose record does not say so, whatever else it says", () => {
    for (const signatureState of ["none", "requested", "failed"] as const) {
      for (const method of ["verified_acknowledgement", "provider_signature", "recorded_by_staff"] as const) {
        expect(acceptedForInvoicing(withDecision(method, { requiresSignature: true, signatureState })), `${signatureState}/${method}`).toMatchObject({ ok: false, reason: "signature_not_recorded" });
      }
    }
    // An acknowledgement by email is never a signature; a signing service's word needs the proposal to say it was completed, and a person's record needs it to say recorded offline.
    expect(acceptedForInvoicing(withDecision("verified_acknowledgement", { requiresSignature: true, signatureState: "completed" }))).toMatchObject({ ok: false, reason: "signature_not_recorded" });
    expect(acceptedForInvoicing(withDecision("verified_acknowledgement", { requiresSignature: true, signatureState: "recorded_offline" }))).toMatchObject({ ok: false, reason: "signature_not_recorded" });
    expect(acceptedForInvoicing(withDecision("recorded_by_staff", { requiresSignature: true, signatureState: "completed" }))).toMatchObject({ ok: false, reason: "signature_not_recorded" });
    expect(acceptedForInvoicing(withDecision("provider_signature", { requiresSignature: true, signatureState: "recorded_offline" }))).toMatchObject({ ok: false, reason: "signature_not_recorded" });
    // A signing service's word on a proposal that never asked for a signature still needs the proposal to say it was completed.
    expect(acceptedForInvoicing(withDecision("provider_signature", { signatureState: "none" }))).toMatchObject({ ok: false, reason: "signature_not_recorded" });
    expect(acceptedForInvoicing(withDecision("provider_signature", { signatureState: "completed" }))).toMatchObject({ ok: true, basis: "signed_through_service" });
  });

  it("refuses every proposal that is not accepted, whatever its record holds", () => {
    for (const status of ["draft", "pending_approval", "changes_requested", "rejected", "approved", "sent", "declined", "expired", "withdrawn"]) {
      expect(acceptedForInvoicing(accepted({ status })), status).toMatchObject({ ok: false, reason: "not_accepted" });
    }
  });

  it("refuses an accepted proposal with no recorded acceptance for the version that went out: none at all, a decline, another version, another fingerprint, or no saved version", () => {
    const no = { ok: false, reason: "no_answer_on_record" };
    expect(acceptedForInvoicing(accepted({ decision: null }))).toMatchObject(no);
    expect(acceptedForInvoicing(accepted({ decision: { decision: "declined", method: "verified_acknowledgement", version: 2, contentHash: HASH } }))).toMatchObject(no);
    expect(acceptedForInvoicing(accepted({ decision: { decision: "changes_requested", method: "verified_acknowledgement", version: 2, contentHash: HASH } }))).toMatchObject(no);
    expect(acceptedForInvoicing(accepted({ decision: { decision: "accepted", method: "verified_acknowledgement", version: 1, contentHash: HASH } }))).toMatchObject(no);
    expect(acceptedForInvoicing(accepted({ decision: { decision: "accepted", method: "verified_acknowledgement", version: 2, contentHash: "b".repeat(64) } }))).toMatchObject(no);
    expect(acceptedForInvoicing(accepted({ versionContentHash: null }))).toMatchObject(no);
    expect(acceptedForInvoicing(accepted({ sentVersion: null }))).toMatchObject(no);
    expect(acceptedForInvoicing(accepted({ sentVersion: 1 }))).toMatchObject(no);
    expect(acceptedForInvoicing(accepted({ version: 3 }))).toMatchObject(no);
  });
});

describe("what the invoice would hold", () => {
  it("copies the lines the customer pays once, with the same figures, and nothing else", () => {
    const r = planInvoiceFromSnapshot(snapshotOf([line({ name: "Website build", unitPriceMinor: 150_000 }), line({ id: "line-bbbbbb", name: "Logo", description: "", unitPriceMinor: 40_000, quantityMilli: 2000, taxBps: 1200 })]));
    if (!r.ok) throw new Error(r.problem.text);
    expect(r.plan.currency).toBe("USD");
    expect(r.plan.lines.map((l) => [l.description, l.quantityMilli, l.unitPriceMinor, l.taxRateBps, l.totalMinor])).toEqual([
      ["Website build - Design and build of a five page website.", 1000, 150_000, null, 150_000],
      ["Logo", 2000, 40_000, 1200, 89_600],
    ]);
    expect(r.plan.totals).toEqual({ gross: 230_000, discount: 0, subtotal: 230_000, tax: 9_600, total: 239_600 });
    expect(r.plan.recurring).toEqual([]);
    expect(r.plan.notes).toEqual([]);
  });

  it("lists the monthly and yearly lines for the owner to decide, leaves them off, and says so", () => {
    const r = planInvoiceFromSnapshot(snapshotOf([
      line(), line({ id: "line-cccccc", name: "Hosting", billing: "monthly", unitPriceMinor: 9_900, taxBps: 1200 }), line({ id: "line-dddddd", name: "Domain", billing: "yearly", unitPriceMinor: 2_000 }),
    ]));
    if (!r.ok) throw new Error(r.problem.text);
    expect(r.plan.lines).toHaveLength(1);
    expect(r.plan.totals.total).toBe(150_000);
    expect(r.plan.recurring).toEqual([
      { name: "Hosting", billing: "monthly", billingLabel: "every month", quantityMilli: 1000, totalMinor: 11_088 },
      { name: "Domain", billing: "yearly", billingLabel: "every year", quantityMilli: 1000, totalMinor: 2_000 },
    ]);
    expect(r.plan.notes).toEqual(["2 lines are billed every month or every year and were not copied. Decide whether and when to invoice them yourself."]);
    // The proposal's line numbers are kept for messages, counting the lines that were left off.
    expect(r.plan.lines[0].proposalLine).toBe(1);
  });

  it("gives a percentage discount as a percentage and a fixed discount as an amount, and the same figures come out", () => {
    const r = planInvoiceFromSnapshot(snapshotOf([
      line({ discount: { kind: "percent", bps: 1250 }, taxBps: 825 }), line({ id: "line-eeeeee", name: "Support", unitPriceMinor: 20_000, discount: { kind: "fixed", minor: 1_500 } }),
    ]));
    if (!r.ok) throw new Error(r.problem.text);
    expect(r.plan.lines[0].form).toMatchObject({ discountPercent: "12.5", discountAmount: null, taxPercent: "8.25", unitPrice: "1500.00", quantity: "1" });
    expect(r.plan.lines[1].form).toMatchObject({ discountPercent: null, discountAmount: "15.00", taxPercent: null });
    expect(r.plan.lines[0].discountMinor).toBe(18_750);
    expect(r.plan.lines[1].discountMinor).toBe(1_500);
    // Read back by the invoice form's own rules, the lines come to what the plan says.
    expect(parseLines(r.plan.lines.map((l) => l.form), "USD", false).totals).toEqual(r.plan.totals);
  });

  it("works in every currency the invoices support, including one with no minor unit", () => {
    for (const currency of CURRENCY_CODES) {
      const r = planInvoiceFromSnapshot(snapshotOf([line({ unitPriceMinor: 123_457, quantityMilli: 1500, taxBps: 725, discount: { kind: "percent", bps: 333 } })], currency));
      if (!r.ok) throw new Error(`${currency}: ${r.problem.text}`);
      expect(parseLines(r.plan.lines.map((l) => l.form), currency, false).totals, currency).toEqual(r.plan.totals);
    }
  });

  it("agrees with the figures of any random lines, line by line and in total, and reads back through the invoice form to the same totals", () => {
    let seed = 20_261_024;
    const next = () => {
      seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;
      return seed / 4_294_967_296;
    };
    const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
    let made = 0;
    for (let round = 0; round < 150; round += 1) {
      const currency = CURRENCY_CODES[int(0, CURRENCY_CODES.length - 1)];
      const lines = Array.from({ length: int(1, 9) }, (_, i): DocLine => {
        const quantityMilli = int(1, 25_000);
        const unitPriceMinor = int(0, 900_000);
        const gross = lineAmounts({ quantityMilli, unitPriceMinor }).gross;
        const kind = int(0, 2);
        // A fixed discount is never more than its line.
        const discount: DocLine["discount"] = kind === 1 ? { kind: "percent", bps: int(1, 10_000) } : kind === 2 && gross >= 1 ? { kind: "fixed", minor: int(1, gross) } : null;
        return line({
          id: `line-${String(i).padStart(6, "0")}`, name: `Item ${i + 1}`, description: next() < 0.5 ? "" : "Some words about it.", quantityMilli, unitPriceMinor,
          billing: next() < 0.2 ? "monthly" : "one_time", taxBps: next() < 0.5 ? 0 : int(1, 2500), discount,
        });
      });
      const snapshot = snapshotOf(lines, currency);
      const r = planInvoiceFromSnapshot(snapshot);
      if (!r.ok) {
        expect(["no_one_time_lines", "zero_total"], r.problem.text).toContain(r.problem.code);
        continue;
      }
      made += 1;
      expect(r.plan.totals).toEqual(snapshot.groups.one_time);
      expect(r.plan.lines.map((l) => l.amounts)).toEqual(snapshot.lines.filter((l) => l.billing === "one_time").map((l) => l.amounts));
      expect(parseLines(r.plan.lines.map((l) => l.form), currency, false).totals).toEqual(r.plan.totals);
      expect(r.plan.recurring).toHaveLength(snapshot.lines.filter((l) => l.billing !== "one_time").length);
    }
    // Most rounds make an invoice: the loop is not passing because it skipped everything.
    expect(made).toBeGreaterThan(100);
  });

  it("shortens nothing silently: a description too long for an invoice line falls back to the name and says so", () => {
    const longDetail = "word ".repeat(100).trim();
    expect(invoiceDescription({ name: "Build", description: longDetail })).toEqual({ text: "Build", shortened: true });
    expect(invoiceDescription({ name: "Build", description: "short" })).toEqual({ text: "Build - short", shortened: false });
    expect(invoiceDescription({ name: "  Build  ", description: "" })).toEqual({ text: "Build", shortened: false });
    expect(invoiceDescription({ name: "B".repeat(400), description: "" }).text).toHaveLength(MAX_DESCRIPTION);
    expect(invoiceDescription({ name: "Build", description: "x".repeat(MAX_DESCRIPTION - 8) }).shortened).toBe(false);
    expect(invoiceDescription({ name: "Build", description: "x".repeat(MAX_DESCRIPTION - 7) }).shortened).toBe(true);
    const r = planInvoiceFromSnapshot(snapshotOf([line({ description: longDetail })]));
    if (!r.ok) throw new Error(r.problem.text);
    expect(r.plan.lines[0].description).toBe("Website build");
    expect(r.plan.notes[0]).toMatch(/Line 1 of the proposal \("Website build"\) has a longer description than an invoice line holds, so only the name was copied\./);
  });
});

describe("when nothing is made", () => {
  const problem = (snapshot: ProposalSnapshot) => {
    const r = planInvoiceFromSnapshot(snapshot);
    if (r.ok) throw new Error("a plan was made");
    return r.problem;
  };

  it("says so for a proposal with only monthly or yearly lines, and for one with no lines", () => {
    expect(problem(snapshotOf([line({ billing: "monthly" })]))).toMatchObject({ code: "no_one_time_lines", text: expect.stringMatching(/only monthly or yearly lines.*yours to decide/) });
    expect(problem(snapshotOf([]))).toMatchObject({ code: "no_one_time_lines", text: expect.stringMatching(/no lines/) });
  });

  it("says so for lines that come to nothing", () => {
    expect(problem(snapshotOf([line({ unitPriceMinor: 0 })]))).toMatchObject({ code: "zero_total" });
  });

  it("says so for a currency the invoices do not support", () => {
    expect(problem(snapshotOf([line()], "XYZ"))).toMatchObject({ code: "currency_unsupported", text: expect.stringContaining("XYZ") });
  });

  it("says so, and names the line, when the words of a line hold a card number", () => {
    expect(problem(snapshotOf([line(), line({ id: "line-ffffff", name: "Pay with 4111 1111 1111 1111" })]))).toMatchObject({ code: "line_text", text: expect.stringMatching(/Line 2 of the proposal.*card number/) });
  });

  it("refuses a saved version whose figures are not what its lines come to", () => {
    const good = snapshotOf([line({ taxBps: 1200 }), line({ id: "line-gggggg", name: "Logo", unitPriceMinor: 40_000 })]);
    const tamperedLine = structuredClone(good);
    tamperedLine.lines[0].amounts.total += 1;
    expect(problem(tamperedLine)).toMatchObject({ code: "figures_differ", text: expect.stringMatching(/line 1/) });
    const tamperedGroup = structuredClone(good);
    tamperedGroup.groups.one_time.total += 1;
    expect(problem(tamperedGroup)).toMatchObject({ code: "figures_differ", text: expect.stringMatching(/one-time total/) });
    const tamperedPrice = structuredClone(good);
    tamperedPrice.lines[1].unitPriceMinor += 1;
    expect(problem(tamperedPrice)).toMatchObject({ code: "figures_differ" });
    expect(planInvoiceFromSnapshot(good).ok).toBe(true);
  });

  it("refuses more one-time lines than an invoice holds, and a fixed discount larger than its line", () => {
    const many = snapshotOf(Array.from({ length: 101 }, (_, i) => line({ id: `line-${String(i).padStart(6, "0")}`, name: `Item ${i}`, unitPriceMinor: 100 })));
    expect(problem(many)).toMatchObject({ code: "too_many_lines" });
    const bad = snapshotOf([line()]);
    bad.lines[0].discount = { kind: "fixed", minor: 999_999_999 };
    expect(problem(bad)).toMatchObject({ code: "figures_differ" });
  });
});

describe("the key an invoice made from a proposal version carries", () => {
  it("names the proposal and the version, and a further invoice the owner asks for takes the next number", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(invoiceKeyFor(id, 2, 0)).toBe(`proposal-invoice:${id}:2`);
    expect(invoiceKeyFor(id, 2, 1)).toBe(`proposal-invoice:${id}:2:1`);
    expect(invoiceKeyFor(id, 3, 0)).not.toBe(invoiceKeyFor(id, 2, 0));
    expect(invoiceKeyFor(id, 2, 12).length).toBeLessThanOrEqual(120);
  });
});
