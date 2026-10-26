import { describe, expect, it } from "vitest";
import { toDecimalString, type CurrencyCode } from "@/lib/money";
import {
  INVOICE_STATUSES, balanceMinor, canEditDraft, canTransition, daysOverdue, derivePaymentStatus, dueFromTerms, invoiceProblems, isDay, isOverdue, issueBlockedReason, overpaidMinor, todayIn,
  voidBlockedReason, type InvoicePaymentStatus, type InvoiceStatus,
} from "@/lib/invoices/state";
import { formatInvoiceNumber, prefixProblem } from "@/lib/invoices/number";
import { canonicalJson, invoiceContentHash, type HashedInvoice } from "@/lib/invoices/hash";
import { INVOICE_TOKEN_RE, hashInvoiceToken, invoiceKeyFrom, invoiceTokenWith, looksLikeInvoiceToken, tokenMatches } from "@/lib/invoices/token";
import { DEFAULT_REMINDER_OFFSETS, offsetsProblem, reminderSchedule, stepKeyFor, stepLabel } from "@/lib/invoices/reminders";
import { containsCardNumber, freeTextProblem, luhnValid } from "@/lib/invoices/guards";
import { formatBps, lineToForm, parseLine, parseLines, parsePercentToBps } from "@/lib/invoices/lines";
import { InvoiceInputError } from "@/lib/invoices/errors";
import { decideCloseRule, type CloseRuleFacts } from "@/lib/invoices/close-rule";
import { draftInputSchema, manualPaymentSchema, settingsPatchSchema } from "@/lib/invoices/schemas";

// A small deterministic generator so the property checks are repeatable.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
const int = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

describe("invoice and payment status", () => {
  it("moves only along the table the database trigger enforces", () => {
    const allowed: Array<[InvoiceStatus, InvoiceStatus]> = [["draft", "pending_approval"], ["draft", "issued"], ["pending_approval", "draft"], ["pending_approval", "issued"], ["issued", "void"]];
    for (const from of INVOICE_STATUSES) for (const to of INVOICE_STATUSES) expect(canTransition(from, to), `${from} -> ${to}`).toBe(allowed.some(([a, b]) => a === from && b === to));
  });

  it("derives paid, partly paid, unpaid and disputed from the amounts alone", () => {
    const cases: Array<[number, number, boolean, InvoicePaymentStatus]> = [
      [1000, 0, false, "unpaid"], [1000, 1, false, "partially_paid"], [1000, 999, false, "partially_paid"], [1000, 1000, false, "paid"], [1000, 5000, false, "paid"],
      [1000, 0, true, "disputed"], [1000, 1000, true, "disputed"],
    ];
    for (const [total, paid, dispute, want] of cases) expect(derivePaymentStatus({ totalMinor: total, paidMinor: paid, hasDispute: dispute }), `${paid}/${total}`).toBe(want);
    expect(balanceMinor(1000, 400)).toBe(600);
    expect(balanceMinor(1000, 1400)).toBe(0);
    expect(overpaidMinor(1000, 1400)).toBe(400);
    expect(overpaidMinor(1000, 400)).toBe(0);
  });

  it("is overdue only after the due day, in the workspace's own time zone, while still owing and not written off or disputed", () => {
    const base = { status: "issued" as const, paymentStatus: "unpaid" as const, dueOn: "2026-10-23", writtenOff: false };
    const utcDay = new Date("2026-10-23T16:30:00Z");
    expect(isOverdue(base, utcDay, "UTC")).toBe(false); // the due day itself is not overdue
    expect(isOverdue(base, utcDay, "Asia/Manila")).toBe(true); // already the 24th in Manila
    expect(isOverdue(base, new Date("2026-10-23T15:59:00Z"), "Asia/Manila")).toBe(false);
    expect(isOverdue(base, utcDay, "America/Los_Angeles")).toBe(false);
    expect(isOverdue(base, new Date("2026-10-24T00:00:00Z"), "UTC")).toBe(true);
    const later = new Date("2026-12-01T00:00:00Z");
    expect(isOverdue({ ...base, paymentStatus: "partially_paid" }, later, "UTC")).toBe(true);
    for (const off of [{ paymentStatus: "paid" }, { paymentStatus: "disputed" }, { writtenOff: true }, { status: "void" }, { status: "draft" }, { status: "pending_approval" }, { dueOn: null }]) {
      expect(isOverdue({ ...base, ...off } as never, later, "UTC"), JSON.stringify(off)).toBe(false);
    }
    expect(daysOverdue("2026-10-23", new Date("2026-10-30T12:00:00Z"), "UTC")).toBe(7);
    expect(daysOverdue("2026-10-23", new Date("2026-10-20T12:00:00Z"), "UTC")).toBe(0);
    expect(daysOverdue(null, later, "UTC")).toBe(0);
    expect(todayIn(new Date("2026-10-23T16:30:00Z"), "Not/AZone")).toBe("2026-10-23");
  });

  it("knows a real day from an impossible one", () => {
    expect(isDay("2026-02-28")).toBe(true);
    expect(isDay("2028-02-29")).toBe(true);
    expect(isDay("2026-02-29")).toBe(false);
    expect(isDay("2026-13-01")).toBe(false);
    expect(isDay("26-10-23")).toBe(false);
    expect(isDay(20261023)).toBe(false);
    expect(dueFromTerms("2026-12-20", 30)).toBe("2027-01-19");
    expect(dueFromTerms("2026-10-23", 0)).toBe("2026-10-23");
  });
});

describe("what stops an invoice and who may issue it", () => {
  it("names each problem in a sentence a person can act on", () => {
    const ok = { contactId: "c", lineCount: 1, totalMinor: 100, dueOn: null, issueOn: "2026-10-23" };
    expect(invoiceProblems(ok)).toEqual([]);
    expect(invoiceProblems({ ...ok, contactId: null }).map((p) => p.code)).toEqual(["no_customer"]);
    expect(invoiceProblems({ ...ok, lineCount: 0, totalMinor: 0 }).map((p) => p.code)).toEqual(["no_lines"]);
    expect(invoiceProblems({ ...ok, totalMinor: 0 }).map((p) => p.code)).toEqual(["zero_total"]);
    expect(invoiceProblems({ ...ok, dueOn: "2026-10-22" }).map((p) => p.code)).toEqual(["due_before_issue"]);
    expect(invoiceProblems({ ...ok, dueOn: "2026-10-23" })).toEqual([]);
    expect(invoiceProblems({ ...ok, contactId: null, lineCount: 0, totalMinor: 0, dueOn: "2020-01-01" }).map((p) => p.code)).toEqual(["no_customer", "no_lines", "due_before_issue"]);
  });

  it("lets approvers issue anything open, and a creator only their own manual draft when approval is off for creators", () => {
    const f = { status: "draft" as const, canApprove: false, canCreate: true, isAuthor: true, createdVia: "manual" as const, approvalRequiredForCreators: true };
    expect(issueBlockedReason(f)).toMatch(/needs the owner's or a manager's approval/);
    expect(issueBlockedReason({ ...f, approvalRequiredForCreators: false })).toBeNull();
    expect(issueBlockedReason({ ...f, approvalRequiredForCreators: false, isAuthor: false })).toMatch(/approval/);
    expect(issueBlockedReason({ ...f, approvalRequiredForCreators: false, createdVia: "workflow" })).toMatch(/approval/);
    expect(issueBlockedReason({ ...f, approvalRequiredForCreators: false, createdVia: "deal" })).toMatch(/approval/);
    expect(issueBlockedReason({ ...f, approvalRequiredForCreators: false, status: "pending_approval" })).toMatch(/approval/);
    expect(issueBlockedReason({ ...f, canApprove: true })).toBeNull();
    expect(issueBlockedReason({ ...f, canApprove: true, status: "pending_approval", isAuthor: false, createdVia: "workflow" })).toBeNull();
    expect(issueBlockedReason({ ...f, canApprove: false, canCreate: false })).toMatch(/Only the business owner or a manager/);
    expect(issueBlockedReason({ ...f, canApprove: true, status: "issued" })).toMatch(/already issued/);
    expect(issueBlockedReason({ ...f, canApprove: true, status: "void" })).toMatch(/void invoice cannot be issued/);
  });

  it("lets the writer or an approver edit a draft", () => {
    expect(canEditDraft({ canCreate: true, canApprove: false, isAuthor: true })).toBe(true);
    expect(canEditDraft({ canCreate: true, canApprove: false, isAuthor: false })).toBe(false);
    expect(canEditDraft({ canCreate: true, canApprove: true, isAuthor: false })).toBe(true);
    expect(canEditDraft({ canCreate: false, canApprove: true, isAuthor: true })).toBe(false);
  });

  it("blocks a void when money moved or may be moving", () => {
    const f = { status: "issued" as const, paidMinor: 0, hasOpenPayment: false };
    expect(voidBlockedReason(f)).toBeNull();
    expect(voidBlockedReason({ ...f, paidMinor: 1 })).toMatch(/payment recorded/);
    expect(voidBlockedReason({ ...f, hasOpenPayment: true })).toMatch(/may be paying/);
    expect(voidBlockedReason({ ...f, status: "void" })).toMatch(/already void/);
    expect(voidBlockedReason({ ...f, status: "draft" })).toMatch(/Only an issued/);
  });
});

describe("numbers", () => {
  it("writes the prefix and the counter padded to four digits and lets it grow", () => {
    expect(formatInvoiceNumber("INV-", 1)).toBe("INV-0001");
    expect(formatInvoiceNumber("INV-", 9999)).toBe("INV-9999");
    expect(formatInvoiceNumber("INV-", 10000)).toBe("INV-10000");
    expect(formatInvoiceNumber("", 7)).toBe("0007");
    expect(formatInvoiceNumber("2026/AT-", 12)).toBe("2026/AT-0012");
    expect(() => formatInvoiceNumber("INV-", 0)).toThrow();
    expect(() => formatInvoiceNumber("INV-", 1.5)).toThrow();
    expect(prefixProblem("INV-")).toBeNull();
    expect(prefixProblem("")).toBeNull();
    expect(prefixProblem("A".repeat(13))).toMatch(/12 characters/);
    expect(prefixProblem("INV #")).toMatch(/prefix/);
    expect(prefixProblem("INV\n")).toMatch(/prefix/);
  });
});

describe("the content hash", () => {
  const doc = (): HashedInvoice => ({
    number: "INV-0001", currency: "PHP", taxInclusive: false, issueOn: "2026-10-23", dueOn: "2026-11-06", billFrom: { name: "Atlas", addressLines: ["1 Harbor Road"] }, billTo: { name: "Maria Santos", email: "m@example.test" },
    lines: [{ position: 1, description: "Service call", quantityMilli: 1000, unitPriceMinor: 150000, discountBps: null, taxRateBps: 1200, grossMinor: 150000, discountMinor: 0, netMinor: 150000, taxMinor: 18000, totalMinor: 168000, exTaxMinor: 150000 }],
    subtotalMinor: 150000, taxMinor: 18000, totalMinor: 168000, paymentInstructions: "Bank transfer", notes: null, terms: null,
  });

  it("does not depend on key order and is a sha256", () => {
    const a = doc();
    const reordered = Object.fromEntries(Object.entries(a).reverse()) as unknown as HashedInvoice;
    reordered.billTo = { email: "m@example.test", name: "Maria Santos" };
    expect(invoiceContentHash(a)).toBe(invoiceContentHash(reordered));
    expect(invoiceContentHash(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalJson({ b: 1, a: [2, { d: null, c: undefined }] })).toBe('{"a":[2,{"c":null,"d":null}],"b":1}');
  });

  it("changes when anything a customer is shown changes", () => {
    const base = invoiceContentHash(doc());
    const edits: Array<(d: HashedInvoice) => void> = [
      (d) => { d.number = "INV-0002"; }, (d) => { d.currency = "USD"; }, (d) => { d.taxInclusive = true; }, (d) => { d.issueOn = "2026-10-24"; }, (d) => { d.dueOn = "2026-11-07"; },
      (d) => { d.billFrom = { name: "Other" }; }, (d) => { d.billTo = { name: "Someone Else" }; }, (d) => { d.lines[0].description = "Service call "; }, (d) => { d.lines[0].quantityMilli = 1001; },
      (d) => { d.lines[0].unitPriceMinor += 1; }, (d) => { d.lines[0].taxRateBps = 1201; }, (d) => { d.lines[0].totalMinor += 1; }, (d) => { d.subtotalMinor += 1; }, (d) => { d.taxMinor += 1; },
      (d) => { d.totalMinor += 1; }, (d) => { d.paymentInstructions = "Cash"; }, (d) => { d.notes = "Thanks"; }, (d) => { d.terms = "Net 14"; }, (d) => { d.lines.push({ ...d.lines[0], position: 2 }); },
    ];
    const seen = new Set([base]);
    for (const edit of edits) {
      const d = doc();
      edit(d);
      const h = invoiceContentHash(d);
      expect(h).not.toBe(base);
      seen.add(h);
    }
    expect(seen.size).toBe(edits.length + 1);
  });
});

describe("the customer's link token", () => {
  const key = invoiceKeyFrom("a-server-secret-for-tests-0123456789");
  const id = "6f1c2b9e-4d4b-4c8a-9f3e-0a1b2c3d4e5f";

  it("is derived, 43 characters, stable, and different for another invoice, version or key", () => {
    const t = invoiceTokenWith(key, id, 1);
    expect(t).toMatch(INVOICE_TOKEN_RE);
    expect(looksLikeInvoiceToken(t)).toBe(true);
    expect(invoiceTokenWith(key, id, 1)).toBe(t);
    expect(invoiceTokenWith(key, id, 2)).not.toBe(t);
    expect(invoiceTokenWith(key, id.replace("6f", "7f"), 1)).not.toBe(t);
    expect(invoiceTokenWith(invoiceKeyFrom("another-secret-another-secret-123456"), id, 1)).not.toBe(t);
  });

  it("is matched against its stored hash only, and only when it has the right shape", () => {
    const t = invoiceTokenWith(key, id, 1);
    const stored = hashInvoiceToken(t);
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).not.toContain(t);
    expect(tokenMatches(t, stored)).toBe(true);
    expect(tokenMatches(invoiceTokenWith(key, id, 2), stored)).toBe(false);
    expect(tokenMatches(t, null)).toBe(false);
    expect(tokenMatches("short", stored)).toBe(false);
    expect(tokenMatches(`${t}x`, stored)).toBe(false);
    expect(tokenMatches(t, `${stored[0] === "0" ? "1" : "0"}${stored.slice(1)}`)).toBe(false);
    expect(looksLikeInvoiceToken(undefined)).toBe(false);
    expect(looksLikeInvoiceToken("a b".repeat(15))).toBe(false);
  });
});

describe("reminder schedule", () => {
  it("lists the default steps at nine in the morning of the workspace's zone, in day order", () => {
    const steps = reminderSchedule({ dueOn: "2026-11-10", offsets: DEFAULT_REMINDER_OFFSETS, max: 4, tz: "Asia/Manila", now: new Date("2026-10-23T00:00:00Z") });
    expect(steps.map((s) => s.stepKey)).toEqual(["before_due:-3", "on_due:0", "after_due:3", "after_due:10"]);
    expect(steps.map((s) => s.dueAt.toISOString())).toEqual(["2026-11-07T01:00:00.000Z", "2026-11-10T01:00:00.000Z", "2026-11-13T01:00:00.000Z", "2026-11-20T01:00:00.000Z"]);
    expect(steps.every((s) => !s.past)).toBe(true);
  });

  it("marks steps that are already behind, caps the count, and ignores days out of range or repeated", () => {
    const now = new Date("2026-11-09T12:00:00Z");
    const steps = reminderSchedule({ dueOn: "2026-11-10", offsets: [10, -3, 0, 3, 3, 500, -500], max: 3, tz: "UTC", now });
    expect(steps.map((s) => [s.offsetDays, s.past])).toEqual([[-3, true], [0, false], [3, false]]);
    expect(reminderSchedule({ dueOn: "2026-11-10", offsets: [0], max: 0, tz: "UTC", now })).toEqual([]);
    expect(reminderSchedule({ dueOn: "2026-11-10", offsets: [0], max: 1, tz: "Not/AZone", now })[0].dueAt.toISOString()).toBe("2026-11-10T09:00:00.000Z");
  });

  it("explains each step and rejects a bad choice of days", () => {
    expect(stepKeyFor(-3)).toBe("before_due:-3");
    expect(stepKeyFor(0)).toBe("on_due:0");
    expect(stepKeyFor(10)).toBe("after_due:10");
    expect(stepLabel(-1)).toBe("1 day before the due date");
    expect(stepLabel(-3)).toBe("3 days before the due date");
    expect(stepLabel(0)).toBe("On the due date");
    expect(stepLabel(1)).toBe("1 day after the due date");
    expect(offsetsProblem([-3, 0, 3, 10], 4)).toBeNull();
    expect(offsetsProblem([-3, 0, 3, 10], 3)).toMatch(/at most 3/);
    expect(offsetsProblem([1, 1], 4)).toMatch(/once/);
    expect(offsetsProblem([61], 4)).toMatch(/after/);
    expect(offsetsProblem([-31], 4)).toMatch(/before/);
    expect(offsetsProblem([1.5], 4)).toMatch(/days/);
    expect(offsetsProblem([1, 2, 3, 4, 5, 6, 7, 8, 9], 9)).toMatch(/at most eight/);
  });
});

describe("what must never be typed into an invoice", () => {
  it("recognises the card numbers cards really carry, with or without separators, and not other long numbers", () => {
    for (const card of ["4242424242424242", "4242 4242 4242 4242", "5555-5555-5555-4444", "2223 0031 2200 3222", "378282246310005", "6011111111111117", "3530111333300000", "30569309025904", "6200000000000005", "4012888888881881"]) {
      expect(luhnValid(card.replace(/[ -]/g, "")), card).toBe(true);
      expect(containsCardNumber(`Please charge ${card} today`), card).toBe(true);
    }
    for (const fine of ["Order 2026-1023-0007", "BDO account 0012 3456 7890", "Call +63 917 123 4567", "Invoice 1234567890123456", "Ref 4242 4242 4242 4243", "Total 1,500.00", "", "No digits here"]) {
      expect(containsCardNumber(fine), fine).toBe(false);
    }
    expect(containsCardNumber(null)).toBe(false);
    expect(luhnValid("4242424242424241")).toBe(false);
    expect(luhnValid("not digits")).toBe(false);
  });

  it("says what is wrong with a piece of text and names the field", () => {
    expect(freeTextProblem("The notes", "Visa 4242 4242 4242 4242")).toMatch(/^The notes looks like it holds a card number/);
    expect(freeTextProblem("The notes", "key sk_live_abcdefghijklmnop1234")).toMatch(/^The notes looks like it holds/);
    expect(freeTextProblem("The notes", "Thank you for your business.")).toBeNull();
    expect(freeTextProblem("The notes", undefined)).toBeNull();
  });
});

describe("lines from what a person typed", () => {
  const price = (text: string, currency: CurrencyCode = "PHP") => parseLine({ description: "Item", quantity: "1", unitPrice: text }, 0, currency, false).amounts.total;

  it("reads exact amounts with the currency's own decimals and refuses what is not an amount", () => {
    expect(price("1,500.50")).toBe(150050);
    expect(price("0.07")).toBe(7);
    expect(price("1500", "JPY")).toBe(1500);
    for (const bad of ["", "abc", "1.234", "-5", "1e3", "1 500", "$10", "1,50"]) expect(() => price(bad), bad).toThrow(InvoiceInputError);
    expect(() => price("1500.5", "JPY")).toThrow(/Line 1/);
    expect(() => parseLine({ description: "Item", quantity: "0", unitPrice: "1" }, 2, "PHP", false)).toThrow(/Line 3/);
    expect(() => parseLine({ description: "  ", quantity: "1", unitPrice: "1" }, 0, "PHP", false)).toThrow(/needs a description/);
    expect(() => parseLine({ description: "x".repeat(301), quantity: "1", unitPrice: "1" }, 0, "PHP", false)).toThrow(/longer than 300/);
    expect(() => parseLine({ description: "Item", quantity: "1", unitPrice: "1", discountPercent: "10", discountAmount: "1" }, 0, "PHP", false)).toThrow(/percentage or as an amount, not both/);
    expect(() => parseLine({ description: "Item", quantity: "1", unitPrice: "1", discountAmount: "5" }, 0, "PHP", false)).toThrow(/more than the line/);
  });

  it("reads percentages as basis points, strictly", () => {
    expect(parsePercentToBps("12", "x")).toBe(1200);
    expect(parsePercentToBps("7.25", "x")).toBe(725);
    expect(parsePercentToBps("0.5%", "x")).toBe(50);
    expect(parsePercentToBps("100", "x")).toBe(10000);
    for (const bad of ["100.01", "101", "-1", "1.234", "abc", "", "1,5"]) expect(() => parsePercentToBps(bad, "The rate"), bad).toThrow(InvoiceInputError);
    expect(formatBps(1200)).toBe("12");
    expect(formatBps(725)).toBe("7.25");
    expect(formatBps(50)).toBe("0.5");
  });

  it("makes the invoice total exactly the sum of the lines, whatever the amounts, with tax inside or outside and any currency", () => {
    const r = rng(20261023);
    const currencies: CurrencyCode[] = ["PHP", "USD", "JPY", "EUR"];
    for (let i = 0; i < 400; i += 1) {
      const currency = currencies[int(r, 0, currencies.length - 1)];
      const inclusive = r() < 0.5;
      const lines = Array.from({ length: int(r, 1, 6) }, (_, k) => ({
        description: `Line ${k}`, quantity: `${int(r, 1, 50)}.${String(int(r, 0, 999)).padStart(3, "0")}`.replace(/\.000$/, ""),
        unitPrice: currency === "JPY" ? String(int(r, 0, 999_999)) : `${int(r, 0, 99_999)}.${String(int(r, 0, 99)).padStart(2, "0")}`,
        discountPercent: r() < 0.3 ? String(int(r, 0, 100)) : null, taxPercent: r() < 0.7 ? `${int(r, 0, 25)}.${r() < 0.5 ? "00" : String(int(r, 1, 99))}` : null,
      }));
      const { lines: parsed, totals } = parseLines(lines, currency, inclusive);
      expect(parsed.reduce((a, l) => a + l.amounts.total, 0)).toBe(totals.total);
      expect(parsed.reduce((a, l) => a + l.amounts.tax, 0)).toBe(totals.tax);
      expect(parsed.reduce((a, l) => a + l.amounts.exTax, 0)).toBe(totals.subtotal);
      expect(totals.subtotal + totals.tax).toBe(totals.total);
      for (const l of parsed) {
        expect(Number.isSafeInteger(l.amounts.total)).toBe(true);
        expect(l.amounts.net).toBe(l.amounts.gross - l.amounts.discount);
        expect(l.amounts.total).toBe(l.amounts.exTax + l.amounts.tax);
      }
    }
  });

  it("round-trips a stored line back to the form and to the same amounts", () => {
    const r = rng(7);
    for (let i = 0; i < 100; i += 1) {
      const percent = r() < 0.5;
      const input = {
        description: "Round trip", quantity: `${int(r, 1, 20)}.${int(r, 1, 999)}`, unitPrice: `${int(r, 1, 9999)}.${String(int(r, 0, 99)).padStart(2, "0")}`,
        discountPercent: percent ? String(int(r, 1, 50)) : null, discountAmount: percent ? null : "0.10", taxPercent: r() < 0.5 ? "12" : null,
      };
      const first = parseLine(input, 0, "USD", false);
      const back = lineToForm({ description: first.description, quantityMilli: first.quantityMilli, unitPriceMinor: first.unitPriceMinor, discountBps: first.discountBps, discountMinor: first.amounts.discount, taxRateBps: first.taxRateBps }, "USD", toDecimalString);
      const second = parseLine(back, 0, "USD", false);
      expect(second.amounts).toEqual(first.amounts);
      expect(second).toMatchObject({ quantityMilli: first.quantityMilli, unitPriceMinor: first.unitPriceMinor, discountBps: first.discountBps, taxRateBps: first.taxRateBps });
    }
  });

  it("limits the number of lines and refuses an amount no integer can hold", () => {
    const one = { description: "x", quantity: "1", unitPrice: "1" };
    expect(parseLines(Array.from({ length: 100 }, () => one), "PHP", false).lines).toHaveLength(100);
    expect(() => parseLines(Array.from({ length: 101 }, () => one), "PHP", false)).toThrow(/at most 100 lines/);
    expect(() => parseLines([{ description: "x", quantity: "999999", unitPrice: "99999999999999.99" }], "PHP", false)).toThrow(InvoiceInputError);
    // Two lines that are each fine but cannot be added in an integer a database column holds.
    const huge = { description: "x", quantity: "1", unitPrice: "40000000000000.00" };
    expect(() => parseLines([huge, huge, huge], "PHP", false)).toThrow(/too large/);
  });
});

describe("what happens to the deal when an invoice is paid", () => {
  const base: CloseRuleFacts = {
    rule: "task", closesDeal: true, invoiceStatus: "issued", paymentStatus: "paid", hasDispute: false, dealStatus: "open", allProviderConfirmed: true, countManualAsVerified: false, alreadyApplied: false,
  };

  it("does nothing under the default rule, and nothing when there is no open deal", () => {
    expect(decideCloseRule({ ...base, rule: "none" })).toEqual({ action: "none", reason: "rule_none" });
    expect(decideCloseRule({ ...base, dealStatus: null })).toEqual({ action: "none", reason: "no_deal" });
    expect(decideCloseRule({ ...base, dealStatus: "won" })).toEqual({ action: "none", reason: "deal_not_open" });
    expect(decideCloseRule({ ...base, dealStatus: "lost" })).toEqual({ action: "none", reason: "deal_not_open" });
    expect(decideCloseRule({ ...base, alreadyApplied: true })).toEqual({ action: "none", reason: "already_applied" });
  });

  it("never acts on a partial payment, a deposit, a dispute or an invoice that is not issued", () => {
    for (const rule of ["task", "auto_won"] as const) {
      for (const paymentStatus of ["unpaid", "partially_paid"] as const) expect(decideCloseRule({ ...base, rule, paymentStatus }), `${rule} ${paymentStatus}`).toEqual({ action: "none", reason: "not_fully_paid" });
      expect(decideCloseRule({ ...base, rule, paymentStatus: "disputed" })).toEqual({ action: "none", reason: "dispute" });
      expect(decideCloseRule({ ...base, rule, hasDispute: true })).toEqual({ action: "none", reason: "dispute" });
      for (const invoiceStatus of ["draft", "pending_approval", "void"] as const) expect(decideCloseRule({ ...base, rule, invoiceStatus }).action).toBe("none");
    }
  });

  it("asks a person under the task rule, and marks won only for a marked invoice paid in full by the provider (or by hand when the owner counts those)", () => {
    expect(decideCloseRule(base)).toEqual({ action: "task" });
    expect(decideCloseRule({ ...base, rule: "task", closesDeal: false })).toEqual({ action: "task" });
    const won = { ...base, rule: "auto_won" as const };
    expect(decideCloseRule(won)).toEqual({ action: "won" });
    expect(decideCloseRule({ ...won, closesDeal: false })).toEqual({ action: "none", reason: "not_marked" });
    expect(decideCloseRule({ ...won, allProviderConfirmed: false })).toEqual({ action: "task" });
    expect(decideCloseRule({ ...won, allProviderConfirmed: false, countManualAsVerified: true })).toEqual({ action: "won" });
  });
});

describe("the input shapes", () => {
  it("accepts a draft as a form sends it and refuses the shapes that cannot be right", () => {
    const ok = draftInputSchema.parse({ contactId: "6f1c2b9e-4d4b-4c8a-9f3e-0a1b2c3d4e5f", currency: "USD", lines: [{ description: "x", quantity: "1", unitPrice: "10" }], dueOn: "2026-12-01" });
    expect(ok.currency).toBe("USD");
    expect(() => draftInputSchema.parse({ currency: "BTC" })).toThrow();
    expect(() => draftInputSchema.parse({ contactId: "not-a-uuid" })).toThrow();
    expect(() => draftInputSchema.parse({ dueOn: "2026-02-30" })).toThrow();
    expect(() => draftInputSchema.parse({ lines: Array.from({ length: 101 }, () => ({ description: "x", quantity: "1", unitPrice: "1" })) })).toThrow();
    expect(() => draftInputSchema.parse({ idempotencyKey: "short" })).toThrow();
    // A browser cannot send a total, a number, a status or an organization: unknown keys are dropped.
    const parsed = draftInputSchema.parse({ lines: [], totalMinor: 1, number: "INV-1", status: "issued", orgId: "x" }) as Record<string, unknown>;
    expect(parsed.totalMinor).toBeUndefined();
    expect(parsed.status).toBeUndefined();
    expect(parsed.orgId).toBeUndefined();
  });

  it("needs evidence and a real method for a manual payment, and a sensible settings patch", () => {
    const pay = { amount: "100", receivedOn: "2026-10-23", method: "bank_transfer", evidence: "Ref 12345" };
    expect(manualPaymentSchema.parse(pay).method).toBe("bank_transfer");
    expect(() => manualPaymentSchema.parse({ ...pay, evidence: "ok" })).toThrow();
    expect(() => manualPaymentSchema.parse({ ...pay, method: "magic" })).toThrow();
    expect(() => manualPaymentSchema.parse({ ...pay, receivedOn: "yesterday" })).toThrow();
    expect(settingsPatchSchema.parse({ closeRule: "auto_won", nextNumber: 5 })).toMatchObject({ closeRule: "auto_won", nextNumber: 5 });
    expect(() => settingsPatchSchema.parse({ closeRule: "always" })).toThrow();
    expect(() => settingsPatchSchema.parse({ nextNumber: 0 })).toThrow();
    expect(() => settingsPatchSchema.parse({ paymentTermsDays: 366 })).toThrow();
    expect(() => settingsPatchSchema.parse({ numberPrefix: "bad prefix" })).toThrow();
    expect((settingsPatchSchema.parse({ remindersEnabled: true }) as Record<string, unknown>).remindersEnabled).toBeUndefined();
  });
});
