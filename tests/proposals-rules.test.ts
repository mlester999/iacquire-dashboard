// The pure rules of proposals: the document, the figures, placeholders, the state machine, who must approve, the workspace calendar, and what is wrong with a proposal.
import { describe, expect, it } from "vitest";
import { MoneyError } from "@/lib/money";
import { acknowledgementText, PROPOSAL_ACKNOWLEDGEMENT_VERSION, recordedByLabel } from "@/lib/proposals/ack";
import { canonicalJson, cleanText, collectStrings, emptyDoc, parseDoc, parseTemplateDoc, unsupportedCharacters, type DocLine, type ProposalDoc } from "@/lib/proposals/doc";
import { contentHash } from "@/lib/proposals/hash";
import { needsDiscountPermission, priceChanges, sameDiscount } from "@/lib/proposals/lines";
import { computeDocTotals, groupGrandTotals, lowersPrice, usedGroups } from "@/lib/proposals/money";
import { blockingFor, proposalProblems, type ProblemFacts } from "@/lib/proposals/problems";
import { freeze, sourceOf, type FreezeInput } from "@/lib/proposals/snapshot";
import { describeTokenProblems, findTokens, hasStrayBraces, renderProposalText } from "@/lib/proposals/tokens";
import {
  approvalReasons, approvalRequired, approveBlockedReason, canTransition, isClosed, isEditable, isLive, isRevisable, parseStatusFilter, PROPOSAL_STATUSES, selfApprovalAllowed,
  type ApprovalFacts, type ProposalStatus,
} from "@/lib/proposals/state";
import { addDays, daysBetween, isDay, isExpired, todayIn, validityOn } from "@/lib/proposals/validity";

const CATALOG_ID = "11111111-1111-4111-8111-111111111111";
const TAX_ID = "22222222-2222-4222-8222-222222222222";

const line = (over: Partial<DocLine> = {}): DocLine => ({
  id: "line-aaaa01", catalogItemId: CATALOG_ID, name: "Website build", description: "Five pages.", unitLabel: "project", quantityMilli: 1000, unitPriceMinor: 150_000, catalogPriceMinor: 150_000,
  billing: "one_time", taxRateId: null, taxName: null, taxBps: 0, discount: null, note: "", ...over,
});
const docOf = (lines: DocLine[], over: Partial<ProposalDoc> = {}): ProposalDoc => ({ v: 1, sections: [], lines, terms: "", ...over });

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
const int = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

describe("the document", () => {
  it("accepts a plain document and fills nothing in by itself", () => {
    const r = parseDoc(docOf([line()], { sections: [{ id: "intro-01", heading: "About this proposal", body: "We will **build** the site.\n\n- Design\n- Build" }], terms: "Net 14." }));
    expect(r.ok).toBe(true);
    expect(parseDoc(emptyDoc()).ok).toBe(true);
  });

  it("refuses HTML, links and images in wording, in a section, a line and the terms", () => {
    for (const bad of ["<script>alert(1)</script>", "Hello <b>there</b>", "see [here](https://x.example)", "![logo](https://x.example/a.png)"]) {
      expect(parseDoc(docOf([line()], { terms: bad })).ok, bad).toBe(false);
      expect(parseDoc(docOf([line({ description: bad })])).ok, bad).toBe(false);
      expect(parseDoc(docOf([line()], { sections: [{ id: "s-000001", heading: "Scope", body: bad }] })).ok, bad).toBe(false);
    }
    // A comparison is not HTML.
    expect(parseDoc(docOf([line()], { terms: "Delivery in under 5 days if a < b." })).ok).toBe(true);
  });

  it("holds the limits: lines, sections, ids, unknown keys, bad figures", () => {
    expect(parseDoc(docOf(Array.from({ length: 101 }, (_, i) => line({ id: `line-${String(i).padStart(6, "0")}` })))).ok).toBe(false);
    expect(parseDoc(docOf(Array.from({ length: 100 }, (_, i) => line({ id: `line-${String(i).padStart(6, "0")}` })))).ok).toBe(true);
    expect(parseDoc(docOf([line(), line()])).ok, "two lines with one id").toBe(false);
    expect(parseDoc({ ...docOf([line()]), signature: "x" }).ok, "a signature section does not exist").toBe(false);
    expect(parseDoc(docOf([line({ unitPriceMinor: -1 })])).ok).toBe(false);
    expect(parseDoc(docOf([line({ unitPriceMinor: 1.5 })])).ok).toBe(false);
    expect(parseDoc(docOf([line({ quantityMilli: 0 })])).ok).toBe(false);
    expect(parseDoc(docOf([line({ taxBps: 10_001 })])).ok).toBe(false);
    expect(parseDoc(docOf([line({ discount: { kind: "percent", bps: 10_001 } })])).ok).toBe(false);
    expect(parseDoc(docOf([line({ name: "   " })])).ok).toBe(false);
    expect(parseDoc(docOf([line({ billing: "weekly" as never })])).ok).toBe(false);
    const tooLong = parseDoc(docOf([line()], { terms: "x".repeat(12_001) }));
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.errors[0]).toMatch(/at most 12,000 characters/);
  });

  it("cleans text: control characters out, line endings plain, accents in one form", () => {
    expect(cleanText("a\u0000b\r\nc\rd\u0007")).toBe("ab\nc\nd");
    expect(cleanText("é")).toBe("é");
    const parsed = parseDoc(docOf([line({ name: "Café build" })]));
    expect(parsed.ok && parsed.value.lines[0].name).toBe("Café build");
  });

  it("writes canonical JSON: key order never matters, so equal content has one hash", () => {
    const a = { b: 1, a: { d: [1, { z: 1, y: 2 }], c: "x" } };
    const b = { a: { c: "x", d: [1, { y: 2, z: 1 }] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(contentHash(a)).toBe(contentHash(b));
    expect(contentHash(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(contentHash({ ...a, b: 2 })).not.toBe(contentHash(a));
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
    expect(() => canonicalJson({ a: () => 1 })).toThrow();
  });

  it("knows what a PDF in a standard font can show", () => {
    expect(unsupportedCharacters("Café €1,500 – “quoted” • niño\n\tok")).toEqual([]);
    expect(unsupportedCharacters("Launch 🚀 Ω 中")).toEqual(["🚀", "Ω", "中"]);
    expect(unsupportedCharacters("\u0007")).toEqual(["\u0007"]);
    expect(collectStrings({ a: ["x", { b: "y" }], c: 3 })).toEqual(["x", "y"]);
  });

  it("parses a template, whose lines name price book items and never carry a price", () => {
    const ok = parseTemplateDoc({ v: 1, sections: [], lines: [{ id: "tl-000001", catalogItemId: CATALOG_ID, quantityMilli: 1000, note: "" }], terms: "" });
    expect(ok.ok).toBe(true);
    expect(parseTemplateDoc({ v: 1, sections: [], lines: [{ id: "tl-000001", catalogItemId: CATALOG_ID, quantityMilli: 1000, note: "", unitPriceMinor: 1 }], terms: "" }).ok, "a price on a template line").toBe(false);
  });
});

describe("the figures", () => {
  it("adds up exactly: a group's total is the sum of its rounded lines, for random documents", () => {
    const r = rng(20261023);
    for (let n = 0; n < 300; n += 1) {
      const lines = Array.from({ length: int(r, 1, 12) }, (_, i) => line({
        id: `line-${String(i).padStart(6, "0")}`, quantityMilli: int(r, 1, 50_000), unitPriceMinor: int(r, 0, 5_000_000), billing: (["one_time", "monthly", "yearly"] as const)[int(r, 0, 2)],
        taxBps: [0, 500, 1200, 1275, 2000][int(r, 0, 4)], discount: [null, { kind: "percent" as const, bps: int(r, 1, 10_000) }][int(r, 0, 1)],
      }));
      const { lines: figures, groups } = computeDocTotals(lines);
      for (const b of ["one_time", "monthly", "yearly"] as const) {
        const own = figures.filter((_, i) => lines[i].billing === b);
        expect(groups[b].total).toBe(own.reduce((s, l) => s + l.total, 0));
        expect(groups[b].tax).toBe(own.reduce((s, l) => s + l.tax, 0));
        expect(groups[b].discount).toBe(own.reduce((s, l) => s + l.discount, 0));
        expect(groups[b].total).toBe(groups[b].subtotal + groups[b].tax);
      }
      for (const f of figures) {
        expect(f.total).toBe(f.net + f.tax);
        expect(f.net).toBe(f.gross - f.discount);
        expect(f.discount).toBeLessThanOrEqual(f.gross);
        expect(Number.isSafeInteger(f.total)).toBe(true);
      }
    }
  });

  it("keeps one-time, monthly and yearly apart", () => {
    const { groups } = computeDocTotals([line({ id: "line-000001" }), line({ id: "line-000002", billing: "monthly", unitPriceMinor: 9_900 }), line({ id: "line-000003", billing: "yearly", unitPriceMinor: 99_000 })]);
    expect(groupGrandTotals(groups)).toEqual({ one_time: 150_000, monthly: 9_900, yearly: 99_000 });
    expect(usedGroups([{ billing: "monthly" }, { billing: "one_time" }])).toEqual(["one_time", "monthly"]);
  });

  it("rounds half up per line, and tax is added on top of the discounted amount", () => {
    // 1,000.00 less 12.5% = 875.00; 12% tax on that is 105.00.
    const { lines, groups } = computeDocTotals([line({ unitPriceMinor: 100_000, taxBps: 1200, discount: { kind: "percent", bps: 1250 } })]);
    expect(lines[0]).toMatchObject({ gross: 100_000, discount: 12_500, net: 87_500, tax: 10_500, total: 98_000 });
    expect(groups.one_time.total).toBe(98_000);
    // Half a minor unit rounds up, not down: 1.5 x 67 = 100.5 comes to 101.
    expect(computeDocTotals([line({ quantityMilli: 3000, unitPriceMinor: 1, taxBps: 0 })]).groups.one_time.total).toBe(3);
    expect(computeDocTotals([line({ quantityMilli: 1500, unitPriceMinor: 67, taxBps: 0 })]).groups.one_time.total).toBe(101);
  });

  it("refuses figures that cannot be right", () => {
    expect(() => computeDocTotals([line({ discount: { kind: "fixed", minor: 150_001 } })])).toThrow(MoneyError);
    expect(() => computeDocTotals([line({ quantityMilli: 999_999_999, unitPriceMinor: 100_000_000_000 })])).toThrow(MoneyError);
    expect(computeDocTotals([line({ discount: { kind: "fixed", minor: 150_000 } })]).groups.one_time.total).toBe(0);
  });

  it("calls a discount, and a price below the price book's, lowering the price", () => {
    expect(lowersPrice(line())).toBe(false);
    expect(lowersPrice(line({ discount: { kind: "percent", bps: 100 } }))).toBe(true);
    expect(lowersPrice(line({ unitPriceMinor: 149_999 }))).toBe(true);
    expect(lowersPrice(line({ unitPriceMinor: 160_000 }))).toBe(false);
    expect(lowersPrice(line({ catalogItemId: null, catalogPriceMinor: null, unitPriceMinor: 1 }))).toBe(false);
  });

  it("tells a discount or a price override apart from a line left as it was", () => {
    const before = [line({ id: "line-000001", discount: { kind: "percent", bps: 500 } }), line({ id: "line-000002", unitPriceMinor: 140_000 })];
    expect(needsDiscountPermission(priceChanges(before, before))).toBe(false);
    // The price book has moved since: an untouched line keeps its price without anyone needing the permission.
    expect(needsDiscountPermission(priceChanges(before, before.map((l) => ({ ...l, name: "Renamed" }))))).toBe(false);
    expect(priceChanges(before, [{ ...before[0], discount: { kind: "percent", bps: 600 } }, before[1]]).discounts).toEqual(["line-000001"]);
    expect(priceChanges(before, [{ ...before[0], discount: null }, before[1]]).discounts).toEqual(["line-000001"]);
    expect(priceChanges(before, [...before, line({ id: "line-000003", unitPriceMinor: 1 })]).overrides).toEqual(["line-000003"]);
    expect(priceChanges(before, [before[0], { ...before[1], unitPriceMinor: 100_000 }]).overrides).toEqual(["line-000002"]);
    // A line typed by hand has no price book price to depart from.
    expect(needsDiscountPermission(priceChanges([], [line({ id: "line-000009", catalogItemId: null, catalogPriceMinor: null, unitPriceMinor: 5 })]))).toBe(false);
    expect(sameDiscount({ kind: "percent", bps: 5 }, { kind: "fixed", minor: 5 })).toBe(false);
    expect(sameDiscount(null, null)).toBe(true);
  });
});

describe("placeholders", () => {
  const values = { "client.name": "Maria Santos", "client.first_name": "Maria", "proposal.number": "P-0007", "business.name": "Harbor Home" };

  it("fills known tokens and nothing else", () => {
    const r = renderProposalText("Dear {{client.first_name}}, proposal {{ proposal.number }} from {{business.name}}.", values);
    expect(r).toEqual({ text: "Dear Maria, proposal P-0007 from Harbor Home.", missing: [], unknown: [] });
  });

  it("reports an unknown token and a missing value, and leaves no raw braces", () => {
    const r = renderProposalText("{{client.company}} and {{client.nmae}} and {{business.name}}", values);
    expect(r.missing).toEqual(["client.company"]);
    expect(r.unknown).toEqual(["client.nmae"]);
    expect(r.text).not.toMatch(/\{\{|\}\}/);
    expect(describeTokenProblems(r.missing, r.unknown)).toMatch(/customer's company.*doesn't recognise/s);
    expect(describeTokenProblems([], [])).toBeNull();
  });

  it("never expands a value, so a customer named like a token stays text", () => {
    const r = renderProposalText("For {{client.name}}", { ...values, "client.name": "{{business.name}} }}{{" });
    expect(r.text).not.toMatch(/\{\{|\}\}/);
    expect(r.text).not.toContain("Harbor Home");
  });

  it("finds tokens and unfinished braces", () => {
    expect(findTokens("{{client.name}} {{ nope }}").map((t) => [t.key, t.known])).toEqual([["client.name", true], ["nope", false]]);
    expect(hasStrayBraces("hello {{client.name")).toBe(true);
    expect(hasStrayBraces("hello {{client.name}}")).toBe(false);
  });
});

describe("the life of a proposal", () => {
  const ALL = PROPOSAL_STATUSES;
  const edges = (from: ProposalStatus) => ALL.filter((to) => canTransition(from, to));

  it("moves forward only the ways the product allows", () => {
    expect(edges("draft")).toEqual(["pending_approval", "sent", "withdrawn"]);
    expect(canTransition("pending_approval", "approved")).toBe(true);
    expect(canTransition("approved", "sent")).toBe(true);
    expect(canTransition("sent", "accepted")).toBe(true);
  });

  it("keeps every final state final, and reaches accepted only from sent", () => {
    expect(edges("accepted")).toEqual([]);
    expect(edges("rejected")).toEqual([]);
    for (const from of ALL) if (from !== "sent") expect(canTransition(from, "accepted"), from).toBe(false);
    for (const to of ["accepted", "declined", "expired"] as const) for (const from of ALL) if (from !== "sent") expect(canTransition(from, to), `${from} -> ${to}`).toBe(false);
    // Nothing reaches sent without having been approved or being a draft the author may send.
    for (const from of ALL) if (canTransition(from, "sent")) expect(["draft", "changes_requested", "approved"]).toContain(from);
  });

  it("lets a sent, declined, expired or withdrawn proposal be revised, and nothing else", () => {
    for (const s of ALL) expect(isRevisable(s), s).toBe(["sent", "declined", "expired", "withdrawn"].includes(s));
    for (const s of ["sent", "declined", "expired", "withdrawn"] as const) expect(canTransition(s, "draft"), s).toBe(true);
    expect(canTransition("accepted", "draft")).toBe(false);
  });

  it("allows editing only before it goes out", () => {
    expect(ALL.filter(isEditable)).toEqual(["draft", "pending_approval", "changes_requested", "approved"]);
    expect(isLive("sent")).toBe(true);
    expect(ALL.filter(isLive)).toEqual(["sent"]);
    expect(ALL.filter(isClosed)).toEqual(["rejected", "accepted", "declined", "expired", "withdrawn"]);
  });

  it("reads a status filter from an address", () => {
    expect(parseStatusFilter("sent, draft,nonsense,sent")).toEqual(["sent", "draft"]);
    expect(parseStatusFilter(null)).toEqual([]);
  });
});

describe("who must approve", () => {
  const base: ApprovalFacts = { origin: "human", authorCanSend: true, mode: "ai_and_discounts", discountNeedsApproval: true, lowersPrice: false, overMinor: null, groupTotals: [100_000, 0, 0] };

  it("needs nothing for an ordinary proposal by someone who can send", () => {
    expect(approvalRequired(base)).toBe(false);
    expect(approvalReasons(base)).toEqual([]);
  });

  it("always needs a person for an AI draft, whatever any setting says", () => {
    for (const mode of ["ai_and_discounts", "all"] as const) for (const discountNeedsApproval of [true, false]) for (const authorCanSend of [true, false]) for (const lowersPriceFlag of [true, false]) {
      const facts: ApprovalFacts = { ...base, origin: "ai", mode, discountNeedsApproval, authorCanSend, lowersPrice: lowersPriceFlag, overMinor: null };
      expect(approvalRequired(facts), JSON.stringify(facts)).toBe(true);
      expect(approvalReasons(facts)).toContain("ai_draft");
    }
  });

  it("is a truth table: each rule on its own, and the rules together", () => {
    for (const authorCanSend of [true, false]) for (const mode of ["ai_and_discounts", "all"] as const) for (const discountNeedsApproval of [true, false]) for (const lowers of [true, false]) for (const over of [null, 50_000, 100_000, 200_000]) {
      const facts: ApprovalFacts = { ...base, authorCanSend, mode, discountNeedsApproval, lowersPrice: lowers, overMinor: over };
      const expected = [
        ...(!authorCanSend ? ["cannot_send"] : []), ...(mode === "all" ? ["all_proposals"] : []), ...(discountNeedsApproval && lowers ? ["discount"] : []), ...(over !== null && 100_000 > over ? ["over_threshold"] : []),
      ];
      expect(approvalReasons(facts).sort(), JSON.stringify(facts)).toEqual(expected.sort());
    }
  });

  it("compares each billing group with the threshold, never their sum", () => {
    const facts: ApprovalFacts = { ...base, overMinor: 100_000, groupTotals: [60_000, 60_000, 60_000] };
    expect(approvalRequired(facts)).toBe(false);
    expect(approvalRequired({ ...facts, groupTotals: [60_000, 100_001, 0] })).toBe(true);
    expect(approvalRequired({ ...facts, groupTotals: [100_000, 0, 0] }), "equal is not over").toBe(false);
  });

  it("keeps the author from approving their own work only when the workspace asked for two people", () => {
    expect(selfApprovalAllowed(false)).toBe(true);
    expect(selfApprovalAllowed(true)).toBe(false);
    expect(approveBlockedReason({ canApprove: false, isAuthor: false, twoPerson: false })).toMatch(/owner or a manager/);
    expect(approveBlockedReason({ canApprove: true, isAuthor: true, twoPerson: true })).toMatch(/second person/);
    expect(approveBlockedReason({ canApprove: true, isAuthor: true, twoPerson: false })).toBeNull();
    expect(approveBlockedReason({ canApprove: true, isAuthor: false, twoPerson: true })).toBeNull();
  });
});

describe("the workspace calendar", () => {
  it("reads today where the business is, not where the server is", () => {
    const instant = new Date("2026-11-30T20:00:00Z");
    expect(todayIn("UTC", instant)).toBe("2026-11-30");
    expect(todayIn("Asia/Manila", instant)).toBe("2026-12-01");
    expect(todayIn("America/Los_Angeles", instant)).toBe("2026-11-30");
    expect(todayIn("Pacific/Auckland", new Date("2026-11-30T12:30:00Z"))).toBe("2026-12-01");
    expect(todayIn("Not/AZone", instant)).toBe("2026-11-30");
  });

  it("accepts a proposal through the whole of its last day where the business is", () => {
    // Valid until the 30th. In Manila it is already December 1st at 20:00 UTC on the 30th; in Los Angeles it is still the 30th.
    const instant = new Date("2026-11-30T20:00:00Z");
    expect(validityOn("2026-11-30", instant, "Asia/Manila")).toBe("expired");
    expect(validityOn("2026-11-30", instant, "America/Los_Angeles")).toBe("last_day");
    expect(validityOn("2026-11-30", new Date("2026-11-30T08:00:00Z"), "Asia/Manila")).toBe("last_day");
    expect(validityOn("2026-12-01", instant, "Asia/Manila")).toBe("last_day");
    expect(validityOn("2026-12-05", instant, "UTC")).toBe("valid");
    expect(validityOn(null, instant, "UTC")).toBe("none");
    expect(isExpired(null, instant, "UTC")).toBe(false);
    expect(isExpired("2026-11-29", instant, "UTC")).toBe(true);
  });

  it("does calendar arithmetic on real dates", () => {
    expect(addDays("2026-02-27", 2)).toBe("2026-03-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(daysBetween("2026-10-23", "2026-11-30")).toBe(38);
    expect(daysBetween("2026-11-30", "2026-10-23")).toBe(-38);
    expect(isDay("2026-02-30")).toBe(false);
    expect(isDay("2026-2-3")).toBe(false);
    expect(isDay("2028-02-29")).toBe(true);
    expect(isDay(20261123)).toBe(false);
  });
});

describe("what is wrong with a proposal", () => {
  const facts = (over: Partial<ProblemFacts> = {}): ProblemFacts => ({
    doc: docOf([line()]), currency: "USD", validUntil: "2026-12-31", clientName: "Maria Santos", clientEmail: "maria@example.test", requiresSignature: false, origin: "human", today: "2026-10-23",
    signingAvailable: false, archivedTaxRateIds: new Set(), snapshot: null, missingTokens: [], unknownTokens: [], ...over,
  });
  const codes = (f: ProblemFacts) => proposalProblems(f).map((p) => p.code);

  it("has nothing to say about a sound proposal", () => {
    expect(proposalProblems(facts())).toEqual([]);
  });

  it("blocks a proposal with no lines, no customer, a past date, an unusable currency or unfilled placeholders", () => {
    expect(codes(facts({ doc: docOf([]) }))).toContain("no_lines");
    expect(codes(facts({ clientName: "  " }))).toContain("client_name_missing");
    expect(codes(facts({ validUntil: "2026-10-22" }))).toContain("valid_until_past");
    expect(codes(facts({ validUntil: "2026-10-23" })), "the last day is still fine").not.toContain("valid_until_past");
    expect(codes(facts({ currency: "XXX" }))).toContain("currency_unsupported");
    expect(codes(facts({ missingTokens: ["client.company"], unknownTokens: ["oops"] }))).toContain("tokens");
    for (const p of proposalProblems(facts({ doc: docOf([]), clientName: "" }))) expect(p.level).toBe("blocking");
  });

  it("only warns about a missing email, a missing date, a free proposal, hand-typed lines, price overrides and archived tax rates", () => {
    const f = facts({
      clientEmail: null, validUntil: null, doc: docOf([line({ id: "line-000001", unitPriceMinor: 0, catalogPriceMinor: 0 }), line({ id: "line-000002", catalogItemId: null, catalogPriceMinor: null, unitPriceMinor: 0 }), line({ id: "line-000003", unitPriceMinor: 1, taxRateId: TAX_ID, taxName: "Tax", taxBps: 100 })]),
      archivedTaxRateIds: new Set([TAX_ID]),
    });
    const got = proposalProblems(f);
    expect(got.map((p) => p.code).sort()).toEqual(["client_email_missing", "custom_line", "price_override", "tax_rate_archived", "valid_until_missing"].sort());
    expect(got.every((p) => p.level === "warning")).toBe(true);
    expect(blockingFor(got, "send")).toEqual([]);
    expect(codes(facts({ doc: docOf([line({ unitPriceMinor: 0, catalogPriceMinor: 0 })]) }))).toContain("zero_total");
  });

  it("allows only price book lines in an AI draft", () => {
    const hand = docOf([line({ catalogItemId: null, catalogPriceMinor: null })]);
    expect(codes(facts({ doc: hand, origin: "ai" }))).toContain("ai_line_without_catalog");
    expect(codes(facts({ doc: hand, origin: "human" }))).not.toContain("ai_line_without_catalog");
  });

  it("stops a signature requirement at the send, not at the approval, and says what to do", () => {
    const p = proposalProblems(facts({ requiresSignature: true })).find((x) => x.code === "signature_unavailable");
    expect(p).toMatchObject({ level: "blocking", stopsAt: "send" });
    expect(p?.message).toMatch(/record the signing as done offline/);
    expect(blockingFor(proposalProblems(facts({ requiresSignature: true })), "submit")).toEqual([]);
    expect(blockingFor(proposalProblems(facts({ requiresSignature: true })), "send")).toHaveLength(1);
    expect(codes(facts({ requiresSignature: true, signingAvailable: true }))).not.toContain("signature_unavailable");
  });

  it("blocks figures that cannot be worked out, and characters a PDF cannot show", () => {
    expect(codes(facts({ doc: docOf([line({ discount: { kind: "fixed", minor: 150_001 } })]) }))).toContain("figures");
    const input: FreezeInput = { number: "P-0001", title: "Launch 🚀", currency: "USD", validUntil: null, requiresSignature: false, client: { name: "Maria", company: "", email: null }, business: { name: "Harbor", website: null }, sender: { name: null }, dealName: null, doc: docOf([line()]) };
    const f = freeze(input);
    const p = proposalProblems(facts({ snapshot: f.snapshot })).find((x) => x.code === "unsupported_characters");
    expect(p?.message).toMatch(/PDF can't show/);
  });
});

describe("the frozen copy", () => {
  const input = (over: Partial<FreezeInput> = {}): FreezeInput => ({
    number: "P-0007", title: "Website proposal", currency: "USD", validUntil: "2026-11-30", requiresSignature: false, client: { name: "Maria Santos", company: "Santos Dental", email: "maria@example.test" },
    business: { name: "Harbor Home", website: "https://harbor.example.test" }, sender: { name: "Sam Sales" }, dealName: "Clinic website",
    doc: docOf([line({ taxRateId: TAX_ID, taxName: "Sales tax", taxBps: 1200 })], { sections: [{ id: "intro-01", heading: "For {{client.company}}", body: "Dear {{client.first_name}}, {{business.name}} proposes {{deal.name}} (valid until {{proposal.valid_until}})." }], terms: "From {{sender.name}}." }),
    ...over,
  });

  it("fills the placeholders and works the figures out", () => {
    const { snapshot, missing, unknown } = freeze(input());
    expect(missing).toEqual([]);
    expect(unknown).toEqual([]);
    expect(snapshot.sections[0]).toEqual({ heading: "For Santos Dental", body: "Dear Maria, Harbor Home proposes Clinic website (valid until November 30, 2026)." });
    expect(snapshot.terms).toBe("From Sam Sales.");
    expect(snapshot.lines[0].amounts).toMatchObject({ gross: 150_000, tax: 18_000, total: 168_000 });
    expect(snapshot.groups.one_time.total).toBe(168_000);
  });

  it("holds nothing internal: no catalog link, no price book price, no note for the team", () => {
    const text = JSON.stringify(freeze(input()).snapshot);
    expect(text).not.toContain(CATALOG_ID);
    expect(text).not.toContain("catalogPriceMinor");
    expect(text).not.toContain("catalogItemId");
    expect(text).not.toContain("internal");
  });

  it("reports what could not be filled in instead of guessing", () => {
    const f = freeze(input({ client: { name: "Maria", company: "", email: null }, dealName: null }));
    expect(f.missing.sort()).toEqual(["client.company", "deal.name"]);
    expect(freeze(input({ doc: docOf([line()], { terms: "{{typo.here}}" }) })).unknown).toEqual(["typo.here"]);
  });

  it("hashes the same content to the same value and a changed word to another", () => {
    const a = contentHash(freeze(input()).snapshot);
    expect(contentHash(freeze(input()).snapshot)).toBe(a);
    expect(contentHash(freeze(input({ title: "Website proposal 2" })).snapshot)).not.toBe(a);
    const changedTerms = input();
    changedTerms.doc = { ...changedTerms.doc, terms: "From {{sender.name}}. Net 30." };
    expect(contentHash(freeze(changedTerms).snapshot)).not.toBe(a);
  });

  it("makes the source hash from the working fields only, so a business renaming itself does not unsettle an approval", () => {
    const row = { title: "T", currency: "USD", validUntil: null, requiresSignature: false, clientName: "Maria", clientCompany: "", clientEmail: null, doc: docOf([line()]) };
    const h = contentHash(sourceOf(row));
    expect(contentHash(sourceOf({ ...row }))).toBe(h);
    expect(contentHash(sourceOf({ ...row, clientName: "Maria S." }))).not.toBe(h);
    expect(contentHash(sourceOf({ ...row, doc: docOf([line({ unitPriceMinor: 149_999 })]) }))).not.toBe(h);
  });
});

describe("the acknowledgement", () => {
  it("names the proposal and the version, and says what it is not", () => {
    const t = acknowledgementText("P-0007", 2);
    expect(t).toContain("P-0007 (version 2)");
    expect(t).toMatch(/not an electronic signature/);
    expect(t).toMatch(/not been verified by a signing service/);
    expect(PROPOSAL_ACKNOWLEDGEMENT_VERSION).toBeGreaterThanOrEqual(1);
    expect(recordedByLabel("Olivia Owner")).toBe("Recorded by Olivia Owner; not verified by the client.");
  });
});
