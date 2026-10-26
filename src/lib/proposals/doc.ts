// The document a proposal holds: sections of wording, priced lines and terms. Pure: the server validates every save with these rules and the editor reads the same limits.
//
// What a document can never hold: HTML, links or images (a sent document is plain wording), a price the workspace did not type (a line's price comes from the price book or
// is typed by a person who may), a signature section (signing is done by a signing service, or recorded by a person, never drawn into the text), and any character the PDF
// writer cannot set in a standard font.
import { z } from "zod";
import { CURRENCY_CODES, isCurrency, type CurrencyCode } from "@/lib/money";

export const DOC_LIMITS = {
  sections: 30,
  lines: 100,
  heading: 120,
  body: 6000,
  terms: 12000,
  lineName: 120,
  lineDescription: 1000,
  lineNote: 300,
  unitLabel: 30,
  /** A single price or fixed discount, in minor units: far above any real proposal, far below where a sum could leave safe integers. */
  maxMinor: 100_000_000_000,
  /** Thousandths of a unit: 999,999.999. */
  maxQuantityMilli: 999_999_999,
} as const;

export const BILLINGS = ["one_time", "monthly", "yearly"] as const;
export type Billing = (typeof BILLINGS)[number];
export const BILLING_LABELS: Record<Billing, string> = { one_time: "One-time", monthly: "Per month", yearly: "Per year" };
export const isBilling = (v: unknown): v is Billing => typeof v === "string" && (BILLINGS as readonly string[]).includes(v);

export const SUPPORTED_CURRENCIES: readonly CurrencyCode[] = CURRENCY_CODES;
export { isCurrency };

/** Control characters out (a tab and a line break stay), line endings made plain, accents in one form so a hash does not depend on how they were typed. */
export function cleanText(text: string): string {
  return text.normalize("NFC").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

/** Why this wording cannot be used, or null. Plain text with **bold**, *italic*, "- " bullets and "1. " numbers is all there is. */
export function markdownProblem(text: string): string | null {
  if (/<\/?[A-Za-z!]/.test(text)) return "HTML isn't allowed. Write plain text, with **bold**, *italic* and lists if you need them.";
  if (/!\[|\]\(/.test(text)) return "Links and images aren't supported in a proposal. Write a web address out as plain text.";
  return null;
}

const text = (max: number, what: string) =>
  z.string().transform(cleanText).pipe(z.string().max(max, `${what} can be at most ${max.toLocaleString("en-US")} characters.`));
const wording = (max: number, what: string) => text(max, what).refine((s) => markdownProblem(s) === null, { message: `${what}: HTML, links and images aren't allowed in a proposal.` });
const name = (max: number, what: string) => text(max, what).refine((s) => s.trim().length > 0, { message: `${what} can't be empty.` });

export const lineId = z.string().regex(/^[A-Za-z0-9_-]{6,40}$/, "A line needs an id of 6 to 40 letters, digits, dashes or underscores.");
const minor = (what: string) => z.number().int(`${what} must be a whole number of minor units.`).min(0, `${what} can't be negative.`).max(DOC_LIMITS.maxMinor, `${what} is too large.`);

export const discountSchema = z.union([
  z.object({ kind: z.literal("percent"), bps: z.number().int().min(1, "A percentage discount is at least 0.01%.").max(10_000, "A discount can't be more than 100%.") }).strict(),
  z.object({ kind: z.literal("fixed"), minor: minor("A fixed discount").min(1, "A fixed discount must be more than zero.") }).strict(),
]);
export type DocDiscount = z.infer<typeof discountSchema>;

/** A priced line as stored in a proposal. The server fills catalogPriceMinor, taxName and taxBps; whatever a browser sends for those is ignored. */
export const lineSchema = z.object({
  id: lineId,
  catalogItemId: z.uuid().nullable(),
  name: name(DOC_LIMITS.lineName, "A line's name"),
  description: wording(DOC_LIMITS.lineDescription, "A line's description"),
  unitLabel: name(DOC_LIMITS.unitLabel, "A unit label"),
  quantityMilli: z.number().int("The quantity must be a whole number of thousandths.").min(1, "The quantity must be more than zero.").max(DOC_LIMITS.maxQuantityMilli, "That quantity is too large."),
  unitPriceMinor: minor("A price"),
  /** The price book's price when the line was added; null for a line typed by hand. A line priced differently from this is a price override. */
  catalogPriceMinor: minor("A catalog price").nullable(),
  billing: z.enum(BILLINGS),
  taxRateId: z.uuid().nullable(),
  taxName: text(60, "A tax name").nullable(),
  taxBps: z.number().int().min(0, "A tax rate can't be negative.").max(10_000, "A tax rate can't be more than 100%."),
  discount: discountSchema.nullable(),
  note: wording(DOC_LIMITS.lineNote, "A line's note"),
}).strict();
export type DocLine = z.infer<typeof lineSchema>;

export const sectionSchema = z.object({
  id: lineId,
  heading: name(DOC_LIMITS.heading, "A section heading"),
  body: wording(DOC_LIMITS.body, "A section"),
}).strict();
export type DocSection = z.infer<typeof sectionSchema>;

export const docSchema = z.object({
  v: z.literal(1),
  sections: z.array(sectionSchema).max(DOC_LIMITS.sections, `A proposal can have at most ${DOC_LIMITS.sections} sections.`),
  lines: z.array(lineSchema).max(DOC_LIMITS.lines, `A proposal can have at most ${DOC_LIMITS.lines} lines.`),
  terms: wording(DOC_LIMITS.terms, "The terms"),
}).strict().superRefine((doc, ctx) => {
  const ids = [...doc.sections.map((s) => s.id), ...doc.lines.map((l) => l.id)];
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "Two sections or lines share an id." });
});
export type ProposalDoc = z.infer<typeof docSchema>;

/** A template line points at the price book; the price is read from it when a proposal is made, so a template never holds a stale price. */
export const templateLineSchema = z.object({
  id: lineId,
  catalogItemId: z.uuid(),
  quantityMilli: z.number().int().min(1, "The quantity must be more than zero.").max(DOC_LIMITS.maxQuantityMilli, "That quantity is too large."),
  note: wording(DOC_LIMITS.lineNote, "A line's note"),
}).strict();
export type TemplateLine = z.infer<typeof templateLineSchema>;

export const templateDocSchema = z.object({
  v: z.literal(1),
  sections: z.array(sectionSchema).max(DOC_LIMITS.sections, `A template can have at most ${DOC_LIMITS.sections} sections.`),
  lines: z.array(templateLineSchema).max(DOC_LIMITS.lines, `A template can have at most ${DOC_LIMITS.lines} lines.`),
  terms: wording(DOC_LIMITS.terms, "The terms"),
}).strict().superRefine((doc, ctx) => {
  const ids = [...doc.sections.map((s) => s.id), ...doc.lines.map((l) => l.id)];
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "Two sections or lines share an id." });
});
export type TemplateDoc = z.infer<typeof templateDocSchema>;

export const emptyDoc = (): ProposalDoc => ({ v: 1, sections: [], lines: [], terms: "" });
export const emptyTemplateDoc = (): TemplateDoc => ({ v: 1, sections: [], lines: [], terms: "" });

export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: string[] };

function failure(error: z.ZodError): { ok: false; errors: string[] } {
  const seen = new Set<string>();
  for (const issue of error.issues) {
    const where = issue.path.length ? ` (${issue.path.map((p) => (typeof p === "number" ? `#${p + 1}` : String(p))).join(" ")})` : "";
    seen.add(`${issue.message}${where}`);
    if (seen.size >= 5) break;
  }
  return { ok: false, errors: [...seen] };
}

export function parseDoc(raw: unknown): Parsed<ProposalDoc> {
  const r = docSchema.safeParse(raw);
  return r.success ? { ok: true, value: r.data } : failure(r.error);
}

export function parseTemplateDoc(raw: unknown): Parsed<TemplateDoc> {
  const r = templateDocSchema.safeParse(raw);
  return r.success ? { ok: true, value: r.data } : failure(r.error);
}

// ---------------------------------------------------------------------------
// Canonical form
// ---------------------------------------------------------------------------

/** JSON with every object's keys in sorted order and nothing undefined, so equal content always has the same text (and the same hash). */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new Error("A document cannot hold a number that is not finite.");
      return v;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x === undefined ? null : x));
    if (typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        const x = (v as Record<string, unknown>)[k];
        if (x !== undefined) out[k] = walk(x);
      }
      return out;
    }
    throw new Error("A document can only hold text, numbers, true or false, lists and objects.");
  };
  return JSON.stringify(walk(value));
}

// ---------------------------------------------------------------------------
// What a PDF set in a standard font can show
// ---------------------------------------------------------------------------

// Windows-1252 ("WinAnsi"), the encoding the standard PDF fonts use: printable ASCII, Latin-1, and these 27 extras. Anything else (emoji, CJK, Greek, Cyrillic) cannot be set.
const WIN_ANSI_EXTRAS = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");

/** Characters in the text that a PDF in a standard font cannot show, each once, in order. A tab and a line break are fine. */
export function unsupportedCharacters(value: string): string[] {
  const bad: string[] = [];
  for (const ch of value) {
    const c = ch.codePointAt(0) as number;
    const ok = c === 0x09 || c === 0x0a || (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WIN_ANSI_EXTRAS.has(ch);
    if (!ok && !bad.includes(ch)) bad.push(ch);
  }
  return bad;
}

/** Every string inside a value, however deep. */
export function collectStrings(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, into);
  else if (value && typeof value === "object") for (const v of Object.values(value)) collectStrings(v, into);
  return into;
}
