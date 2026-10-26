import { describe, expect, it } from "vitest";
import {
  CURRENCY_CODES,
  MoneyError,
  computeTotals,
  formatMinor,
  formatQuantity,
  isCurrency,
  lineAmounts,
  parseAmount,
  parseQuantity,
  roundDiv,
  sameCurrency,
  sumLines,
  taxPortion,
  toDecimalString,
  type LineInput,
} from "@/lib/money";

// A small deterministic generator so the property checks are repeatable.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
const int = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

const fails = (fn: () => unknown, code?: string) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(MoneyError);
    if (code) expect((e as MoneyError).code).toBe(code);
    return true;
  }
  return false;
};

describe("currencies", () => {
  it("knows its list and nothing else", () => {
    expect(CURRENCY_CODES).toContain("USD");
    expect(isCurrency("PHP")).toBe(true);
    expect(isCurrency("BTC")).toBe(false);
    expect(isCurrency("toString")).toBe(false);
    expect(isCurrency(undefined)).toBe(false);
  });
});

describe("parsing and printing amounts", () => {
  it("parses strict decimals with the currency's own exponent", () => {
    expect(parseAmount("1500", "USD")).toBe(150000);
    expect(parseAmount("1500.5", "USD")).toBe(150050);
    expect(parseAmount("1,234.50", "USD")).toBe(123450);
    expect(parseAmount(" 0.07 ", "PHP")).toBe(7);
    expect(parseAmount("1500", "JPY")).toBe(1500);
    expect(parseAmount("1,500", "JPY")).toBe(1500);
  });
  it("refuses anything that is not a plain amount", () => {
    for (const bad of ["", "-5", "+5", "1.234", "1,23", "12,3456", "abc", "1e3", "1 000", ".5", "5.", "0x10", "1,234,56"]) expect(fails(() => parseAmount(bad, "USD"), "invalid_amount"), bad).toBe(true);
    expect(fails(() => parseAmount("15.5", "JPY"), "invalid_amount")).toBe(true);
    expect(fails(() => parseAmount("99999999999999999", "USD"), "overflow")).toBe(true);
  });
  it("prints decimals, groups thousands and keeps the sign", () => {
    expect(toDecimalString(123450, "USD")).toBe("1234.50");
    expect(toDecimalString(5, "USD")).toBe("0.05");
    expect(toDecimalString(0, "USD")).toBe("0.00");
    expect(toDecimalString(1500, "JPY")).toBe("1500");
    expect(toDecimalString(-250, "USD")).toBe("-2.50");
    expect(formatMinor(123450, "USD", "code")).toBe("USD 1,234.50");
    expect(formatMinor(123450, "USD", "symbol")).toBe("$1,234.50");
    expect(formatMinor(1234567, "JPY", "code")).toBe("JPY 1,234,567");
    expect(formatMinor(-5, "PHP", "code")).toBe("PHP -0.05");
    expect(formatMinor(-5, "PHP", "symbol")).toBe("-₱0.05");
  });
  it("round-trips ten thousand amounts in every currency", () => {
    const r = rng(7);
    for (let i = 0; i < 10_000; i++) {
      const code = CURRENCY_CODES[int(r, 0, CURRENCY_CODES.length - 1)];
      const n = int(r, 0, 2 ** 40);
      expect(parseAmount(toDecimalString(n, code), code)).toBe(n);
    }
  });
  it("parses quantities in thousandths", () => {
    expect(parseQuantity("1")).toBe(1000);
    expect(parseQuantity("2.5")).toBe(2500);
    expect(parseQuantity("0.001")).toBe(1);
    expect(parseQuantity(3)).toBe(3000);
    expect(formatQuantity(2500)).toBe("2.5");
    expect(formatQuantity(1000)).toBe("1");
    expect(formatQuantity(125)).toBe("0.125");
    for (const bad of ["0", "0.000", "-1", "1.2345", "abc", "", "1e3", "1234567"]) expect(fails(() => parseQuantity(bad), "invalid_quantity"), bad).toBe(true);
  });
});

describe("rounding", () => {
  it("rounds half away from zero in integers", () => {
    expect(roundDiv(5n, 2n)).toBe(3n);
    expect(roundDiv(4n, 3n)).toBe(1n);
    expect(roundDiv(1n, 2n)).toBe(1n);
    expect(roundDiv(1n, 3n)).toBe(0n);
    expect(roundDiv(-5n, 2n)).toBe(-3n);
    expect(roundDiv(-1n, 3n)).toBe(0n);
    expect(roundDiv(0n, 7n)).toBe(0n);
    expect(() => roundDiv(1n, 0n)).toThrow(MoneyError);
  });
});

describe("a line", () => {
  it("rounds the gross, discounts it, and adds tax on the net", () => {
    // 2.5 x 19.99 = 49.975 -> 49.98; 10% = 4.998 -> 5.00; net 44.98; 12% tax = 5.3976 -> 5.40; total 50.38
    const a = lineAmounts({ quantityMilli: 2500, unitPriceMinor: 1999, discount: { kind: "percent", bps: 1000 }, taxBps: 1200 });
    expect(a).toEqual({ gross: 4998, discount: 500, net: 4498, tax: 540, total: 5038, exTax: 4498 });
  });
  it("takes a fixed discount and refuses one larger than the line", () => {
    expect(lineAmounts({ quantityMilli: 1000, unitPriceMinor: 10_000, discount: { kind: "fixed", minor: 2_500 } })).toMatchObject({ gross: 10_000, discount: 2_500, net: 7_500, tax: 0, total: 7_500 });
    expect(fails(() => lineAmounts({ quantityMilli: 1000, unitPriceMinor: 1000, discount: { kind: "fixed", minor: 1001 } }), "invalid_discount")).toBe(true);
    expect(fails(() => lineAmounts({ quantityMilli: 1000, unitPriceMinor: 1000, discount: { kind: "percent", bps: 10_001 } }), "invalid_rate")).toBe(true);
  });
  it("finds the tax inside a tax-inclusive line", () => {
    const a = lineAmounts({ quantityMilli: 1000, unitPriceMinor: 11_200, taxBps: 1200 }, true);
    expect(a).toEqual({ gross: 11_200, discount: 0, net: 11_200, tax: 1_200, total: 11_200, exTax: 10_000 });
  });
  it("refuses nonsense instead of guessing", () => {
    expect(fails(() => lineAmounts({ quantityMilli: 0, unitPriceMinor: 100 }), "invalid_quantity")).toBe(true);
    expect(fails(() => lineAmounts({ quantityMilli: 1.5, unitPriceMinor: 100 }), "invalid_quantity")).toBe(true);
    expect(fails(() => lineAmounts({ quantityMilli: 1000, unitPriceMinor: -1 }), "invalid_amount")).toBe(true);
    expect(fails(() => lineAmounts({ quantityMilli: 1000, unitPriceMinor: 1.5 }), "invalid_amount")).toBe(true);
    expect(fails(() => lineAmounts({ quantityMilli: 1000, unitPriceMinor: 100, taxBps: 0.5 }), "invalid_rate")).toBe(true);
    expect(fails(() => lineAmounts({ quantityMilli: 1000, unitPriceMinor: 100, taxBps: 10_001 }), "invalid_rate")).toBe(true);
  });
  it("does not lose precision when quantity x price passes 2^53", () => {
    // 999,999.999 units x 9,000,000,000 minor units each is far past 2^53 before the division by 1000: computed exactly, then refused if it will not fit.
    expect(fails(() => lineAmounts({ quantityMilli: 999_999_999, unitPriceMinor: 9_000_000_000_000 }), "overflow")).toBe(true);
    // The same quantity at a price that fits is exact: 999,999,999 x 9,000,000 / 1000.
    expect(lineAmounts({ quantityMilli: 999_999_999, unitPriceMinor: 9_000_000 }).gross).toBe(8_999_999_991_000);
  });
});

describe("totals", () => {
  it("always equal the sum of the rounded lines, for either tax style", () => {
    const r = rng(42);
    for (let round = 0; round < 3_000; round++) {
      const lines: LineInput[] = Array.from({ length: int(r, 1, 8) }, () => ({
        quantityMilli: int(r, 1, 50_000),
        unitPriceMinor: int(r, 0, 5_000_000),
        discount: r() < 0.4 ? { kind: "percent" as const, bps: int(r, 0, 10_000) } : r() < 0.2 ? { kind: "fixed" as const, minor: 0 } : null,
        taxBps: r() < 0.7 ? int(r, 0, 2_500) : null,
      }));
      for (const inclusive of [false, true]) {
        const { lines: amounts, totals } = computeTotals(lines, inclusive);
        expect(totals.total).toBe(amounts.reduce((s, l) => s + l.total, 0));
        expect(totals.tax).toBe(amounts.reduce((s, l) => s + l.tax, 0));
        expect(totals.subtotal).toBe(amounts.reduce((s, l) => s + l.exTax, 0));
        // What a reader adds up from the document is exactly the total: ex-tax amounts plus tax.
        expect(totals.subtotal + totals.tax).toBe(totals.total);
        expect(totals.gross - totals.discount).toBe(amounts.reduce((s, l) => s + l.net, 0));
        for (const l of amounts) expect(l.net).toBeGreaterThanOrEqual(0);
      }
    }
  });
  it("is zero for no lines", () => {
    expect(sumLines([])).toEqual({ gross: 0, discount: 0, subtotal: 0, tax: 0, total: 0 });
  });
});

describe("tax inside a payment", () => {
  it("splits a payment in proportion to the invoice, rounded", () => {
    expect(taxPortion(5038, 540, 5038)).toBe(540);
    expect(taxPortion(2519, 540, 5038)).toBe(270);
    expect(taxPortion(1000, 0, 5038)).toBe(0);
    expect(taxPortion(100, 540, 0)).toBe(0);
    expect(fails(() => taxPortion(-1, 1, 1), "invalid_amount")).toBe(true);
  });
  it("never exceeds the payment when the invoice's tax is part of its total", () => {
    const r = rng(9);
    for (let i = 0; i < 2_000; i++) {
      const total = int(r, 1, 10_000_000);
      const tax = int(r, 0, total);
      const pay = int(r, 0, total);
      const part = taxPortion(pay, tax, total);
      expect(part).toBeGreaterThanOrEqual(0);
      expect(part).toBeLessThanOrEqual(pay);
    }
  });
});

describe("currencies never mix", () => {
  it("accepts one currency and refuses two", () => {
    expect(sameCurrency(["USD", "USD"])).toBe("USD");
    expect(fails(() => sameCurrency(["USD", "PHP"]), "currency_mismatch")).toBe(true);
    expect(fails(() => sameCurrency(["USD", "XXX"]), "currency_mismatch")).toBe(true);
    expect(fails(() => sameCurrency([]), "currency_mismatch")).toBe(true);
  });
});
