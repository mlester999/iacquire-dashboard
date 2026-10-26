// What the invoice screens decide for themselves, as pure rules: which list a filter means, what the form's lines come to as the person types, the reminder days a person
// writes, which buttons an invoice offers, and the words the history and the amounts use. The server decides every one of these again; this proves what is offered and said.
import { describe, expect, it } from "vitest";
import {
  LIST_FILTERS, LIST_FILTER_LABELS, blankLine, describeOffsets, filledLines, filterQuery, invoiceActions, offsetsToText, parseListFilter, parseOffsetsText, previewLines,
  type ActionFacts, type InvoiceActionId,
} from "@/lib/invoices/screens";
import { amountText, eventSentence, formatDay, formatInstant, methodLabel, money, moneyCode } from "@/lib/invoices/labels";

const line = (over: Partial<Parameters<typeof previewLines>[0][number]> = {}) => ({ description: "Service", quantity: "1", unitPrice: "100.00", ...over });

describe("the list a filter means", () => {
  it("falls back to what is owed for anything it does not know, and reads the first of several", () => {
    expect(parseListFilter(undefined)).toBe("open");
    expect(parseListFilter("")).toBe("open");
    expect(parseListFilter("nonsense")).toBe("open");
    expect(parseListFilter("paid")).toBe("paid");
    expect(parseListFilter(["void", "paid"])).toBe("void");
    expect(parseListFilter(["bad", "paid"])).toBe("open");
    for (const f of LIST_FILTERS) {
      expect(parseListFilter(f)).toBe(f);
      expect(LIST_FILTER_LABELS[f]).toBeTruthy();
    }
  });

  it("asks each list for exactly its own invoices, and 'owed' includes a disputed one but never a void or a draft", () => {
    // Nothing is owed on a test invoice, so the lists of what is owed, overdue and paid leave test invoices out, and they have a list of their own.
    expect(filterQuery("open")).toEqual({ status: ["issued"], paymentStatus: ["unpaid", "partially_paid", "disputed"], tests: "exclude" });
    expect(filterQuery("paid")).toEqual({ status: ["issued"], paymentStatus: ["paid"], tests: "exclude" });
    expect(filterQuery("overdue")).toEqual({ overdueOnly: true, tests: "exclude" });
    expect(filterQuery("test")).toEqual({ tests: "only" });
    expect(filterQuery("draft")).toEqual({ status: ["draft"] });
    expect(filterQuery("waiting")).toEqual({ status: ["pending_approval"] });
    expect(filterQuery("void")).toEqual({ status: ["void"] });
    expect(filterQuery("all")).toEqual({});
  });
});

describe("what the lines come to while a person types", () => {
  it("adds up with the same rules as the server: per line, in the currency's own decimals, with tax on top or included", () => {
    expect(previewLines([line({ unitPrice: "1000.00", taxPercent: "12" })], "PHP", false)).toMatchObject({ ok: true, subtotalMinor: 100000, taxMinor: 12000, totalMinor: 112000, problem: null });
    expect(previewLines([line({ unitPrice: "1120.00", taxPercent: "12" })], "PHP", true)).toMatchObject({ ok: true, taxMinor: 12000, totalMinor: 112000 });
    expect(previewLines([line({ quantity: "2.5", unitPrice: "19.99" })], "USD", false)).toMatchObject({ ok: true, totalMinor: 4998 });
    expect(previewLines([line({ unitPrice: "1500" })], "JPY", false)).toMatchObject({ ok: true, totalMinor: 1500 });
    // Three lines of 0.10 add up to exactly 0.30, never 0.30000000000000004.
    expect(previewLines([line({ unitPrice: "0.10" }), line({ unitPrice: "0.10" }), line({ unitPrice: "0.10" })], "USD", false).totalMinor).toBe(30);
  });

  it("reports a line that cannot be read on its own and still adds up the rest", () => {
    const p = previewLines([line({ unitPrice: "100.00" }), line({ unitPrice: "12.345" }), line({ description: "", unitPrice: "" })], "PHP", false);
    expect(p.ok).toBe(false);
    expect(p.errors[0]).toBeNull();
    expect(p.errors[1]).toMatch(/Line 2/);
    expect(p.errors[2]).toBeNull();
    expect(p.totalMinor).toBe(10000);
  });

  it("asks for a line when there is none, and refuses a total of nothing", () => {
    expect(previewLines([blankLine()], "PHP", false)).toMatchObject({ ok: false, totalMinor: 0, problem: "Add at least one line." });
    expect(previewLines([line({ unitPrice: "0" })], "PHP", false)).toMatchObject({ problem: "The invoice total must be more than zero." });
    expect(filledLines([blankLine(), line(), blankLine()])).toEqual([line()]);
  });
});

describe("the reminder days a person writes", () => {
  it("reads whole numbers of days separated by commas or spaces, once each, in order", () => {
    expect(parseOffsetsText("-3, 0, 3, 10")).toEqual({ ok: true, offsets: [-3, 0, 3, 10] });
    expect(parseOffsetsText("10 3 0 -3 3")).toEqual({ ok: true, offsets: [-3, 0, 3, 10] });
    expect(parseOffsetsText(" 7 ")).toEqual({ ok: true, offsets: [7] });
    expect(offsetsToText([-3, 0, 3])).toBe("-3, 0, 3");
  });

  it("refuses an empty list and anything that is not a whole number of days, naming the part that is wrong", () => {
    expect(parseOffsetsText("")).toMatchObject({ ok: false, error: expect.stringMatching(/at least one day/) });
    expect(parseOffsetsText("   ")).toMatchObject({ ok: false });
    for (const bad of ["3.5", "three", "1,,x", "1000", "--3", "+3"]) {
      const r = parseOffsetsText(bad);
      expect(r.ok, bad).toBe(false);
    }
    expect(parseOffsetsText("1, abc")).toMatchObject({ ok: false, error: expect.stringContaining('"abc"') });
  });

  it("says in a sentence what the days mean", () => {
    expect(describeOffsets([])).toBe("No reminder days are set.");
    expect(describeOffsets([0])).toBe("One reminder, on the due date.");
    expect(describeOffsets([-1])).toBe("One reminder, 1 day before the due date.");
    expect(describeOffsets([10, -3, 0, 3])).toBe("Reminders 3 days before the due date, on the due date, 3 days after the due date and 10 days after the due date.");
  });
});

describe("what an invoice offers the person looking at it", () => {
  const base: ActionFacts = {
    status: "issued", paymentStatus: "unpaid", writtenOff: false, balanceMinor: 150000, paidMinor: 0, createdVia: "manual", isAuthor: false, approvalRequiredForCreators: true, hasTestConnection: false, isTest: false,
    can: { create: false, approve: false, send: false, recordPayment: false, void: false, refund: false, connect: false },
  };
  const owner = { create: true, approve: true, send: true, recordPayment: true, void: true, refund: true, connect: true };
  const sales = { create: true, approve: false, send: false, recordPayment: false, void: false, refund: false, connect: false };
  const offered = (over: Partial<ActionFacts>) => invoiceActions({ ...base, ...over }).offered;

  it("lets the owner do everything on an issued invoice that still owes something, and never offers a real invoice a test payment, whatever account is connected", () => {
    const all = offered({ can: owner });
    expect([...all].sort()).toEqual(["link", "record_payment", "void", "write_off"].sort());
    expect(offered({ can: owner, hasTestConnection: true })).not.toContain("test_payment");
  });

  it("offers a test invoice the test payment, only when a test account is connected, and the delete, and nothing about money owed", () => {
    const test = { isTest: true, can: owner };
    expect([...offered({ ...test, hasTestConnection: true })].sort()).toEqual(["delete_test", "link", "test_payment", "void"].sort());
    expect([...offered({ ...test, hasTestConnection: false })].sort()).toEqual(["delete_test", "link", "void"].sort());
    expect(offered({ ...test, hasTestConnection: true, writtenOff: true })).not.toContain("test_payment");
    expect(offered({ ...test, hasTestConnection: true, paymentStatus: "disputed" })).not.toContain("test_payment");
  });

  it("does not offer to void an invoice with a payment, says why, and never offers to record a payment on one that owes nothing or to test-pay a written-off or disputed one", () => {
    const part = invoiceActions({ ...base, can: owner, paidMinor: 50000, balanceMinor: 100000 });
    expect(part.offered).not.toContain("void");
    expect(part.notes).toContain("An invoice with a payment cannot be voided. Record a refund instead.");
    const paid = offered({ can: owner, paidMinor: 150000, balanceMinor: 0, paymentStatus: "paid" });
    expect(paid).not.toContain("record_payment");
    expect(paid).not.toContain("write_off");
  });

  it("offers a salesperson the draft they wrote, to send for approval, and not to issue while approval is required", () => {
    expect([...offered({ status: "draft", can: sales, isAuthor: true })].sort()).toEqual(["discard", "edit", "submit"].sort());
    expect(offered({ status: "draft", can: sales, isAuthor: true, approvalRequiredForCreators: false })).toContain("issue");
    const someoneElses = invoiceActions({ ...base, status: "draft", can: sales, isAuthor: false });
    expect(someoneElses.offered).toEqual([]);
    expect(someoneElses.notes[0]).toMatch(/Only the person who wrote this draft/);
  });

  it("offers an approver to approve or send back what is waiting, and a salesperson only to take it back, with the reason they cannot approve", () => {
    expect([...offered({ status: "pending_approval", can: owner })].sort()).toEqual(["approve_issue", "request_changes", "withdraw"]);
    const waiting = invoiceActions({ ...base, status: "pending_approval", can: sales, isAuthor: true });
    expect(waiting.offered).toEqual(["withdraw"]);
    expect(waiting.notes[0]).toMatch(/owner or a manager has to approve/);
  });

  it("offers nothing on a void invoice, and nothing at all to a person with no rights", () => {
    expect(offered({ status: "void", can: owner })).toEqual([]);
    for (const status of ["draft", "pending_approval", "issued", "void"] as const) expect(offered({ status, can: base.can }), status).toEqual([]);
  });

  it("never offers an action that needs a right the person does not have", () => {
    const needs: Record<InvoiceActionId, keyof ActionFacts["can"] | null> = {
      edit: "create", submit: "create", withdraw: "create", approve_issue: "approve", request_changes: "approve", issue: null, discard: "create", link: "send", record_payment: "recordPayment", void: "void", write_off: "refund", test_payment: "connect", delete_test: "connect",
    };
    const rights = Object.keys(owner) as Array<keyof ActionFacts["can"]>;
    for (const status of ["draft", "pending_approval", "issued"] as const) for (const mask of Array.from({ length: 1 << rights.length }, (_, i) => i)) {
      const can = Object.fromEntries(rights.map((r, i) => [r, Boolean(mask & (1 << i))])) as ActionFacts["can"];
      for (const isAuthor of [false, true]) for (const hasTestConnection of [false, true]) for (const isTest of [false, true]) {
        const { offered: o } = invoiceActions({ ...base, status, can, isAuthor, hasTestConnection, isTest });
        for (const a of o) {
          const right = needs[a];
          if (right) expect(can[right], `${status} ${a} offered without ${right}`).toBe(true);
        }
      }
    }
  });
});

describe("the words the screens use", () => {
  it("shows a plain day as that day, never shifted by a time zone, and an instant in the workspace's zone", () => {
    expect(formatDay("2026-11-06")).toBe("Nov 6, 2026");
    expect(formatDay("2026-01-01")).toBe("Jan 1, 2026");
    for (const bad of [null, undefined, "", "2026-1-1", "yesterday", "2026-11-06T00:00:00Z"]) expect(formatDay(bad as string | null | undefined)).toBe("");
    expect(formatInstant("2026-11-06T01:30:00Z", "Asia/Manila")).toBe("Nov 6, 2026, 9:30 AM");
    expect(formatInstant("2026-11-06T01:30:00Z", "America/Los_Angeles")).toBe("Nov 5, 2026, 5:30 PM");
    expect(formatInstant("2026-11-06T01:30:00Z", "Not/AZone")).toBe("Nov 6, 2026, 1:30 AM");
    expect(formatInstant(null, "UTC")).toBe("");
    expect(formatInstant("garbage", "UTC")).toBe("");
  });

  it("writes amounts in the currency's own decimals, with a symbol or a code, and as a field value that reads back", () => {
    expect(money(150000, "PHP")).toBe("₱1,500.00");
    expect(money(1500, "JPY")).toBe("¥1,500");
    expect(moneyCode(150000, "USD")).toMatch(/USD/);
    expect(amountText(150000, "PHP")).toBe("1500.00");
    expect(amountText(1500, "JPY")).toBe("1500");
    expect(amountText(5, "USD")).toBe("0.05");
  });

  it("gives every kind of history entry a sentence, an unknown kind readable words, and never prints a customer's details because it was asked to", () => {
    expect(eventSentence("issued", { number: "INV-0007", amount: "1500.00", currency: "PHP" })).toBe("Issued as INV-0007 for PHP 1500.00.");
    expect(eventSentence("payment_verified", { amount: "100.00", currency: "PHP", provider: "simulated", livemode: false })).toBe("A test payment was confirmed by the payment provider: PHP 100.00. Test mode: no real money moved.");
    expect(eventSentence("payment_verified", { amount: "100.00", currency: "PHP", provider: "paymongo", livemode: true })).toBe("A payment was confirmed by the payment provider: PHP 100.00.");
    expect(eventSentence("manual_payment_recorded", { amount: "5.00", currency: "USD" })).toBe("A payment was recorded by hand: USD 5.00.");
    expect(eventSentence("voided", { reason: "Wrong address" })).toBe("Voided: Wrong address");
    expect(eventSentence("paid", {})).toBe("Paid in full.");
    expect(eventSentence("some_future_kind", {})).toBe("Some future kind.");
    // The detail is read for named fields only: an email in the detail does not reach the sentence.
    expect(eventSentence("viewed", { email: "maria@example.test" })).toBe("The customer opened the invoice.");
    expect(methodLabel("e_wallet")).toBe("E-wallet");
    expect(methodLabel("card_terminal")).toBe("Card, on your own terminal");
    expect(methodLabel("odd_method")).toBe("Odd method");
    expect(methodLabel(null)).toBe("");
  });
});
