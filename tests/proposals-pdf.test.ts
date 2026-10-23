// The PDF writer and the proposal layout, tested without a database: fonts and widths, wrapping, the file's structure (parsed back byte by byte), determinism (the stored hash
// must stay true), and the text read back out of the file by the platform's own PDF reader (src/server/knowledge/extract.ts), which is what proves a customer can select it.
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { formatMinor } from "@/lib/money";
import { charWidth, isSettable, pdfLiteral, textWidth, winAnsiByte } from "@/lib/pdf/fonts";
import { Flow, LINE_SAFETY, MAX_PAGES, MAX_PDF_BYTES, parseInline, PdfDocument, PdfLimitError, wrapRuns, type Run } from "@/lib/pdf/writer";
import { emptyDoc, unsupportedCharacters, type DocLine, type ProposalDoc } from "@/lib/proposals/doc";
import { contentHash } from "@/lib/proposals/hash";
import { bpsLabel } from "@/lib/proposals/money";
import { pageSizeFor, renderProposalPdfBytes } from "@/lib/proposals/pdf";
import { freeze } from "@/lib/proposals/snapshot";
import { wordingBlocks } from "@/lib/proposals/wording";
import { extractPdf } from "@/server/knowledge/extract";

const CREATED = new Date("2026-10-23T09:30:00Z");

function line(i: number, over: Partial<DocLine> = {}): DocLine {
  return {
    id: `line-${String(i).padStart(6, "0")}`, catalogItemId: null, name: `Website build ${i}`, description: "Design and build of a five page website.", unitLabel: "project", quantityMilli: 1000,
    unitPriceMinor: 150_000, catalogPriceMinor: null, billing: "one_time", taxRateId: null, taxName: null, taxBps: 0, discount: null, note: "", ...over,
  };
}

function doc(over: Partial<ProposalDoc> = {}): ProposalDoc {
  return { ...emptyDoc(), ...over };
}

function snapshotOf(d: ProposalDoc, over: { currency?: "USD" | "PHP" | "EUR" | "JPY"; validUntil?: string | null; requiresSignature?: boolean; client?: { name: string; company: string; email: string | null } } = {}) {
  const f = freeze({
    number: "P-0007", title: "Website proposal", currency: over.currency ?? "PHP", validUntil: over.validUntil === undefined ? "2026-11-30" : over.validUntil, requiresSignature: over.requiresSignature ?? false,
    client: over.client ?? { name: "Maria Santos", company: "Santos Bakery", email: "maria@example.test" }, business: { name: "Acme Web Studio", website: "https://acme.example" }, sender: { name: "Pat Rivera" }, dealName: null, doc: d,
  });
  expect(f.missing).toEqual([]);
  expect(f.unknown).toEqual([]);
  return f.snapshot;
}

const render = (d: ProposalDoc, over: Parameters<typeof snapshotOf>[1] = {}, version = 2) => {
  const snapshot = snapshotOf(d, over);
  return { snapshot, bytes: renderProposalPdfBytes({ snapshot, version, contentHash: contentHash(snapshot), createdAt: CREATED }) };
};
const text = (bytes: Buffer) => {
  const r = extractPdf(bytes);
  if (!r.ok) throw new Error(`could not read the PDF back: ${r.code} ${r.detail}`);
  return r.text;
};

describe("the standard fonts", () => {
  it("know a width for every printable character, and an accented letter is as wide as its base", () => {
    for (let c = 0x20; c <= 0x7e; c++) {
      const ch = String.fromCharCode(c);
      expect(charWidth(ch, "regular"), ch).toBeGreaterThan(0);
      expect(charWidth(ch, "bold"), ch).toBeGreaterThan(0);
    }
    // The published Helvetica widths for a few well-known characters (checked against the metric-compatible Arial when this was written).
    expect([charWidth("i", "regular"), charWidth("W", "regular"), charWidth(" ", "regular"), charWidth("0", "regular"), charWidth("@", "regular")]).toEqual([222, 944, 278, 556, 1015]);
    expect([charWidth("i", "bold"), charWidth("W", "bold"), charWidth("b", "bold"), charWidth("0", "bold")]).toEqual([278, 944, 611, 556]);
    for (const [accented, base] of [["é", "e"], ["Ñ", "N"], ["ü", "u"], ["Ç", "C"], ["ÿ", "y"]]) expect(charWidth(accented, "regular"), accented).toBe(charWidth(base, "regular"));
    // Italic faces share their upright face's widths.
    expect(charWidth("g", "italic")).toBe(charWidth("g", "regular"));
    expect(charWidth("g", "boldItalic")).toBe(charWidth("g", "bold"));
    // Something the fonts cannot show is measured as the question mark it is printed as.
    expect(charWidth("中", "regular")).toBe(charWidth("?", "regular"));
    expect(textWidth("Hello", "regular", 10)).toBeCloseTo(((722 + 556 + 222 + 222 + 556) * 10) / 1000, 6);
  });

  it("encode text as WinAnsi and write it as plain ASCII", () => {
    expect(winAnsiByte("A")).toBe(0x41);
    expect(winAnsiByte("é")).toBe(0xe9);
    expect(winAnsiByte("€")).toBe(0x80);
    expect(winAnsiByte("—")).toBe(0x97);
    expect(winAnsiByte("中")).toBeNull();
    expect(isSettable("😀")).toBe(false);
    expect(pdfLiteral("a(b)c\\d")).toBe("(a\\(b\\)c\\\\d)");
    expect(pdfLiteral("café €")).toBe("(caf\\351 \\200)");
    expect(pdfLiteral("中")).toBe("(?)");
    // Everything doc.ts allows in a proposal can be set; everything it does not allow, cannot.
    expect(unsupportedCharacters("Café €1,200 — ok")).toEqual([]);
    for (const ch of unsupportedCharacters("a中b😀c")) expect(isSettable(ch)).toBe(false);
  });
});

describe("inline styles and wording", () => {
  it("reads **bold** and *italic*, and leaves a marker with no partner as the text it is", () => {
    expect(parseInline("plain **strong** and *slanted* end")).toEqual([
      { text: "plain ", font: "regular" }, { text: "strong", font: "bold" }, { text: " and ", font: "regular" }, { text: "slanted", font: "italic" }, { text: " end", font: "regular" },
    ]);
    expect(parseInline("5 * 3 = 15")).toEqual([{ text: "5 * 3 = 15", font: "regular" }]);
    expect(parseInline("a ** b")).toEqual([{ text: "a ** b", font: "regular" }]);
    expect(parseInline("**bold *and italic***")).toEqual([{ text: "bold ", font: "bold" }, { text: "and italic", font: "boldItalic" }]);
    expect(parseInline("**x**", "bold")).toEqual([{ text: "**x**", font: "bold" }]);
    expect(parseInline("")).toEqual([]);
  });

  it("breaks wording into paragraphs and lists, joins consecutive lines, and never makes markup", () => {
    const blocks = wordingBlocks("First line\nsecond line\n\n- one\n- two with **bold**\n1. step\n2) next\n\nLast");
    expect(blocks.map((b) => b.kind)).toEqual(["p", "ul", "ol", "p"]);
    expect(blocks[0]).toMatchObject({ kind: "p", runs: [{ text: "First line second line", font: "regular" }] });
    expect(blocks[1].kind === "ul" && blocks[1].items).toHaveLength(2);
    expect(blocks[2].kind === "ol" && blocks[2].items).toHaveLength(2);
    // Text that looks like a tag is just text in a run.
    expect(wordingBlocks("<b>x</b>")[0]).toEqual({ kind: "p", runs: [{ text: "<b>x</b>", font: "regular" }] });
  });

  it("writes basis points as the percentage a person writes", () => {
    expect([bpsLabel(1200), bpsLabel(1250), bpsLabel(5), bpsLabel(10_000), bpsLabel(100), bpsLabel(1)]).toEqual(["12%", "12.5%", "0.05%", "100%", "1%", "0.01%"]);
  });
});

describe("wrapping", () => {
  const words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa", "lambda", "mu", "Wide-WWWWWW", "iiiiiiii", "Mr.", "price:", "PHP 1,500.00", "café"];

  it("never makes a line wider than the box, for any text and any width (seeded)", () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let n = 0; n < 300; n++) {
      const size = 7 + Math.floor(rnd() * 8);
      const width = 40 + Math.floor(rnd() * 400);
      const count = 1 + Math.floor(rnd() * 60);
      const parts: string[] = [];
      for (let i = 0; i < count; i++) parts.push(rnd() < 0.05 ? "x".repeat(10 + Math.floor(rnd() * 80)) : words[Math.floor(rnd() * words.length)]);
      const runs: Run[] = parseInline(parts.map((w) => (rnd() < 0.15 ? `**${w}**` : w)).join(" "));
      const lines = wrapRuns(runs, size, width);
      for (const l of lines) {
        const measured = l.runs.reduce((s, r) => s + textWidth(r.text, r.font, size), 0);
        expect(measured, `${n}: ${JSON.stringify(l.runs)}`).toBeLessThanOrEqual(width * LINE_SAFETY + 0.001);
        expect(l.width).toBeCloseTo(measured, 3);
      }
      // Nothing is lost or invented: the words come back in order.
      const flat = (rs: readonly Run[]) => rs.map((r) => r.text).join("").replace(/\s+/g, "");
      expect(lines.map((l) => flat(l.runs)).join("")).toBe(flat(runs));
    }
  });

  it("keeps a word that changes style inside it as one word", () => {
    const lines = wrapRuns(parseInline("**bo**ld word"), 10, 500);
    expect(lines).toHaveLength(1);
    expect(lines[0].runs.map((r) => r.text).join("")).toBe("bold word");
  });

  it("cuts a word wider than a whole line instead of running off the page", () => {
    const lines = wrapRuns([{ text: "W".repeat(60), font: "regular" }], 10, 100);
    expect(lines.length).toBeGreaterThan(3);
    for (const l of lines) expect(l.width).toBeLessThanOrEqual(100 * LINE_SAFETY + 0.001);
  });
});

describe("the file", () => {
  function sample() {
    const d = doc({ sections: [{ id: "sec-000001", heading: "Hello {{client.first_name}}", body: "Thanks for talking with us, **{{client.name}}**.\n\n- Design a five page site\n- Build it" }], lines: [line(1), line(2, { discount: { kind: "percent", bps: 1000 } })], terms: "Payment is due within 14 days." });
    return render(d);
  }

  it("is a well-formed PDF: the header, a cross-reference table whose offsets point at their objects, and a trailer that points at the table", () => {
    const { bytes } = sample();
    const raw = bytes.toString("latin1");
    expect(raw.startsWith("%PDF-1.4\n")).toBe(true);
    expect(raw.endsWith("%%EOF\n")).toBe(true);
    const start = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(raw)?.[1]);
    expect(raw.slice(start, start + 4)).toBe("xref");
    const size = Number(/\/Size (\d+)/.exec(raw)?.[1]);
    const entries = raw.slice(start).split("\n").slice(3, 3 + size - 1);
    expect(entries).toHaveLength(size - 1);
    entries.forEach((e, i) => {
      expect(e).toMatch(/^\d{10} 00000 n $/);
      expect(raw.startsWith(`${i + 1} 0 obj\n`, Number(e.slice(0, 10))), `object ${i + 1}`).toBe(true);
    });
    // Every content stream is exactly as long as it says.
    for (const m of raw.matchAll(/<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g)) expect(m[2].length).toBe(Number(m[1]));
    // The pages the tree counts are the pages there are.
    expect(Number(/\/Count (\d+)/.exec(raw)?.[1])).toBe(raw.match(/\/Type \/Page /g)?.length);
    // Plain ASCII apart from the binary-marker comment on the second line.
    expect(/[^\x20-\x7e\n]/.test(raw.slice(raw.indexOf("\n", 10)))).toBe(false);
    expect(raw).not.toMatch(/\/Encrypt|\/JavaScript|\/JS |\/OpenAction|\/Launch|\/URI|\/EmbeddedFile/);
  });

  it("is the same bytes every time for the same version, and different bytes when anything it is built from differs", () => {
    const a = sample().bytes;
    const b = sample().bytes;
    expect(a.equals(b)).toBe(true);
    expect(crypto.createHash("sha256").update(a).digest("hex")).toBe(crypto.createHash("sha256").update(b).digest("hex"));
    const snapshot = sample().snapshot;
    const base = { snapshot, version: 2, contentHash: contentHash(snapshot), createdAt: CREATED };
    expect(renderProposalPdfBytes({ ...base, version: 3 }).equals(a)).toBe(false);
    expect(renderProposalPdfBytes({ ...base, createdAt: new Date("2026-10-24T09:30:00Z") }).equals(a)).toBe(false);
    expect(renderProposalPdfBytes({ ...base, snapshot: { ...snapshot, title: "Another title" }, contentHash: "0".repeat(64) }).equals(a)).toBe(false);
    // The creation date written is the frozen one, not the time of rendering.
    expect(a.toString("latin1")).toContain("/CreationDate (D:20261023093000Z)");
    expect(a.toString("latin1")).toContain(`/ID [<${contentHash(snapshot).slice(0, 32)}>`);
  });

  it("reads back through the platform's own PDF reader with everything the customer needs: number, title, people, wording, every figure and the terms", () => {
    const { bytes, snapshot } = sample();
    const t = text(bytes);
    for (const needle of ["Acme Web Studio", "Website proposal", "Proposal P-0007", "Version 2", "Maria Santos", "Santos Bakery", "maria@example.test", "Pat Rivera", "November 30, 2026", "Hello Maria",
      "Thanks for talking with us, Maria Santos.", "Design a five page site", "Build it", "Investment", "Website build 1", "Website build 2", "Payment is due within 14 days.", "Terms", "Document ID"]) {
      expect(t, needle).toContain(needle);
    }
    // Every amount the page shows is in the file, formatted with the currency code.
    const g = snapshot.groups.one_time;
    for (const minor of [150_000, 135_000, g.subtotal, g.discount > 0 ? -g.discount : 0]) if (minor !== 0) expect(t, String(minor)).toContain(formatMinor(minor, "PHP"));
    expect(t).toContain(`Total`);
    expect(t).toContain(formatMinor(g.total, "PHP"));
    // No placeholder and no markup marker survives.
    expect(t).not.toMatch(/\{\{|\*\*/);
    expect(t).not.toMatch(/undefined|NaN|\[object Object\]/);
  });

  it("totals each billing group on its own and never adds them together", () => {
    const d = doc({ lines: [line(1), line(2, { billing: "monthly", unitPriceMinor: 9_900, name: "Care plan" }), line(3, { billing: "yearly", unitPriceMinor: 120_000, name: "Domain and hosting" })] });
    const { bytes, snapshot } = render(d);
    const t = text(bytes);
    for (const label of ["One-time", "Per month", "Per year", "Total one-time", "Total per month", "Total per year"]) expect(t, label).toContain(label);
    for (const g of ["one_time", "monthly", "yearly"] as const) expect(t).toContain(formatMinor(snapshot.groups[g].total, "PHP"));
    const all = snapshot.groups.one_time.total + snapshot.groups.monthly.total + snapshot.groups.yearly.total;
    expect(t).not.toContain(formatMinor(all, "PHP"));
    expect(t).toContain("not added together");
  });

  it("shows tax and discounts so the lines add up to the total", () => {
    const d = doc({ lines: [line(1, { taxName: "VAT", taxBps: 1200, discount: { kind: "fixed", minor: 5_000 } }), line(2, { taxName: "VAT", taxBps: 1200, quantityMilli: 2500 })] });
    const { bytes, snapshot } = render(d);
    const t = text(bytes);
    const g = snapshot.groups.one_time;
    expect(g.tax).toBeGreaterThan(0);
    expect(g.subtotal + g.tax).toBe(g.total);
    for (const row of ["Before discounts", "Discounts", "Subtotal", "Tax"]) expect(t, row).toContain(row);
    for (const minor of [g.gross, g.subtotal, g.tax, g.total]) expect(t).toContain(formatMinor(minor, "PHP"));
    expect(t).toContain("VAT 12% added to the total");
    expect(snapshot.lines.reduce((s, l) => s + l.amounts.net, 0)).toBe(g.subtotal);
  });

  it("starts a new page when the content runs on, repeats the table header on each, and numbers the pages", () => {
    const lines = Array.from({ length: 40 }, (_, i) => line(i + 1, { description: "A long description that is set in small type under the name. ".repeat(3) }));
    const { bytes } = render(doc({ lines, terms: "Term sentence number one is here. ".repeat(120) }));
    const t = text(bytes);
    const pages = Number(/\/Count (\d+)/.exec(bytes.toString("latin1"))?.[1]);
    expect(pages).toBeGreaterThanOrEqual(4);
    for (let i = 1; i <= pages; i++) expect(t, `page ${i}`).toContain(`Page ${i} of ${pages}`);
    // The header row is drawn again on every page the table continues onto.
    expect((t.match(/Unit price/g) ?? []).length).toBeGreaterThanOrEqual(3);
    // All forty lines are somewhere in the file, once each.
    for (let i = 1; i <= 40; i++) expect((t.match(new RegExp(`Website build ${i}\\b`, "g")) ?? []).length, `line ${i}`).toBe(1);
  });

  it("splits a row taller than a page between lines instead of looping or dropping text", () => {
    const d = new PdfDocument({ title: "Tall", createdAt: CREATED, idSeed: "a".repeat(64) }, { size: "A4" });
    const flow = new Flow(d);
    const long = "word ".repeat(3000).trim();
    flow.table([{ weight: 1, header: "Only" }], [[{ paragraphs: [{ text: long }] }], [{ paragraphs: [{ text: "after the tall row" }] }]]);
    const t = text(d.build());
    expect(d.pageCount).toBeGreaterThan(2);
    expect((t.match(/word/g) ?? []).length).toBe(3000);
    expect(t).toContain("after the tall row");
  });

  it("never leaves a table's header alone at the foot of a page, wherever the table happens to start", () => {
    const pagesOf = (bytes: Buffer) => [...bytes.toString("latin1").matchAll(/<< \/Length \d+ >>\nstream\n([\s\S]*?)\nendstream/g)].map((m) => m[1]);
    for (let filler = 0; filler < 70; filler++) {
      const d = new PdfDocument({ title: "Header", createdAt: CREATED, idSeed: "c".repeat(64) }, { size: "LETTER" });
      const flow = new Flow(d);
      for (let i = 0; i < filler; i++) flow.paragraph(`Filler line ${i}`, { size: 10 });
      flow.table(
        [{ weight: 3, header: "Item" }, { weight: 1, header: "Amount", align: "right" }],
        Array.from({ length: 6 }, (_, r) => [{ paragraphs: [{ text: `row ${r}`, font: "bold" as const }, { text: "A line of description that sits under the name of the row in smaller type. ".repeat(3), size: 8.5 }] }, { paragraphs: [{ text: "USD 1.00" }] }]),
      );
      for (const [n, page] of pagesOf(d.build()).entries()) if (page.includes("(Item) Tj")) expect(page, `filler ${filler}, page ${n + 1}`).toMatch(/\(row \d\) Tj/);
    }
  });

  it("prints what the fonts can show, in the right letters, and a question mark for what they cannot", () => {
    const { bytes } = render(doc({ lines: [line(1, { name: "Café Ñoño ü" })], terms: "Price — fixed. 中" }));
    const t = text(bytes);
    expect(t).toContain("Café Ñoño ü");
    expect(t).toContain("Price \u0097 fixed. ?"); // the dash is a WinAnsi byte; the reader returns it as that byte's Latin-1 character
  });

  it("uses Letter paper for the dollar currencies and the peso, A4 elsewhere", () => {
    expect([pageSizeFor("USD"), pageSizeFor("CAD"), pageSizeFor("PHP"), pageSizeFor("EUR"), pageSizeFor("GBP"), pageSizeFor("JPY")]).toEqual(["LETTER", "LETTER", "LETTER", "A4", "A4", "A4"]);
    expect(render(doc({ lines: [line(1)] }), { currency: "USD" }).bytes.toString("latin1")).toContain("/MediaBox [0 0 612 792]");
    expect(render(doc({ lines: [line(1)] }), { currency: "EUR" }).bytes.toString("latin1")).toContain("/MediaBox [0 0 595 842]");
  });

  it("handles a currency with no minor unit, a proposal with no lines and one that needs a signature", () => {
    const yen = render(doc({ lines: [line(1, { unitPriceMinor: 150_000 })] }), { currency: "JPY" });
    expect(text(yen.bytes)).toContain("JPY 150,000");
    const none = text(render(doc({ sections: [{ id: "sec-000001", heading: "Scope", body: "Just words." }] })).bytes);
    expect(none).not.toContain("Investment");
    expect(none).toContain("Just words.");
    const signed = text(render(doc({ lines: [line(1)] }), { requiresSignature: true }).bytes);
    expect(signed).toContain("This proposal needs a signature");
    expect(signed).toContain("this copy is not signed");
    // No signature block is ever drawn, and nothing in the file claims a signature was given.
    expect(text(sample().bytes)).not.toMatch(/signed by|signature:|electronically signed|legally binding/i);
  });

  it("refuses a document that is far too long rather than spending a function's time on it", () => {
    const d = new PdfDocument({ title: "Long", createdAt: CREATED, idSeed: "b".repeat(64) });
    for (let i = 1; i < MAX_PAGES; i++) d.addPage();
    expect(d.pageCount).toBe(MAX_PAGES);
    expect(() => d.addPage()).toThrow(PdfLimitError);
    expect(MAX_PDF_BYTES).toBeGreaterThan(1_000_000);
  });
});
