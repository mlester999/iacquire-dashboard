// The proposal editor's model: what a person types, turned into what the server stores, and back. Pure: the same figures and limits the server enforces are used here, so a
// problem is shown beside the field before anything is sent, and the totals on screen are worked out by the same code that works them out on the server.
//
// The server decides everything that matters (prices from the price book, tax names, who may discount, whether the version is still the one being edited). Whatever this model
// sends for those is a request, not a fact.
import { formatQuantity, isCurrency, MoneyError, parseAmount, parseQuantity, sumLines, toDecimalString, type CurrencyCode, type LineAmounts } from "@/lib/money";
import { BILLINGS, DOC_LIMITS, markdownProblem, type Billing, type DocDiscount, type ProposalDoc } from "@/lib/proposals/doc";
import { lineFigures, zeroGroups, type GroupTotals } from "@/lib/proposals/money";
import { isEditable, type ProposalStatus } from "@/lib/proposals/state";
import { isDay } from "@/lib/proposals/validity";

/** Why a proposal cannot be edited right now, in words, or null when it can. The server refuses the same edits with the same reasons. */
export function lockedReason(status: ProposalStatus, canEdit: boolean): string | null {
  if (!isEditable(status)) {
    const why: Partial<Record<ProposalStatus, string>> = {
      sent: "This proposal has been sent, so its wording is fixed. Revise it to change it: that starts a new version and closes the old link.",
      accepted: "An accepted proposal can't be changed. Duplicate it to start a new one.",
      declined: "This proposal was declined. Revise it to change it.",
      expired: "This proposal expired. Revise it to change it.",
      withdrawn: "This proposal was withdrawn. Revise it to change it.",
      rejected: "This proposal was rejected. Duplicate it to start again.",
    };
    return why[status] ?? "This proposal can't be edited right now.";
  }
  return canEdit ? null : "Only the person who wrote this proposal, or a manager, can change it.";
}

export interface EditorLine {
  /** Identifies the row on screen. A saved line keeps its id; a new line gets a key of its own. */
  key: string;
  /** The saved line's id; undefined for a line that has not been saved. */
  id: string | undefined;
  catalogItemId: string | null;
  name: string;
  description: string;
  unitLabel: string;
  /** As typed: "2.5". */
  quantity: string;
  /** As typed, in the currency's major unit: "1500.00". */
  price: string;
  billing: Billing;
  taxRateId: string | null;
  taxName: string | null;
  taxBps: number;
  discount: "none" | "percent" | "fixed";
  /** As typed: "10" for ten percent, or an amount for a fixed discount. */
  discountValue: string;
  note: string;
  /** The price book's price when the line was added; null for a line typed by hand. A price that differs from it is an override. */
  catalogPriceMinor: number | null;
}

export interface EditorSection {
  key: string;
  id: string | undefined;
  heading: string;
  body: string;
}

export interface EditorState {
  title: string;
  clientName: string;
  clientCompany: string;
  clientEmail: string;
  validUntil: string;
  requiresSignature: boolean;
  currency: string;
  sections: EditorSection[];
  lines: EditorLine[];
  terms: string;
  internalNotes: string;
}

/** What the editor needs from a saved proposal. A ProposalDetail satisfies it. */
export interface SavedProposal {
  title: string;
  clientName: string;
  clientCompany: string;
  clientEmail: string | null;
  validUntil: string | null;
  requiresSignature: boolean;
  currency: string;
  internalNotes: string | null;
  doc: ProposalDoc;
}

/** A price book item as the editor offers it. */
export interface CatalogChoice {
  id: string;
  name: string;
  description: string;
  unitLabel: string;
  unitPriceMinor: number;
  currency: string;
  billing: Billing;
  taxRateId: string | null;
  taxBps: number | null;
}

// ---------------------------------------------------------------------------
// Typed text <-> stored numbers
// ---------------------------------------------------------------------------

const code = (currency: string): CurrencyCode => (isCurrency(currency) ? currency : "USD");

/** A percentage typed by a person ("10", "12.5", "0.05") as basis points, or null when it is not between 0.01 and 100 with at most two decimals. */
export function percentToBps(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return null;
  const [whole, fraction = ""] = t.split(".");
  const bps = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return bps >= 1 && bps <= 10_000 ? bps : null;
}

/** Basis points as the percentage a person types: 1250 is "12.5". */
export const bpsToPercent = (bps: number): string => {
  const whole = Math.floor(bps / 100);
  const frac = String(bps % 100).padStart(2, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
};

/** What a person typed as a price, in minor units, or the reason it cannot be used. */
export function parsePrice(text: string, currency: string): { ok: true; minor: number } | { ok: false; message: string } {
  try {
    const minor = parseAmount(text, code(currency));
    if (minor > DOC_LIMITS.maxMinor) return { ok: false, message: "That price is too large." };
    return { ok: true, minor };
  } catch (e) {
    return { ok: false, message: e instanceof MoneyError ? e.message : "Enter an amount such as 1500 or 1500.00." };
  }
}

export function parseQty(text: string): { ok: true; milli: number } | { ok: false; message: string } {
  try {
    const milli = parseQuantity(text);
    if (milli > DOC_LIMITS.maxQuantityMilli) return { ok: false, message: "That quantity is too large." };
    return { ok: true, milli };
  } catch (e) {
    return { ok: false, message: e instanceof MoneyError ? e.message : "Enter a quantity such as 1, 2.5 or 0.25." };
  }
}

// ---------------------------------------------------------------------------
// From a saved proposal, and new rows
// ---------------------------------------------------------------------------

export function stateFromSaved(p: SavedProposal): EditorState {
  const c = code(p.currency);
  return {
    title: p.title,
    clientName: p.clientName,
    clientCompany: p.clientCompany,
    clientEmail: p.clientEmail ?? "",
    validUntil: p.validUntil ?? "",
    requiresSignature: p.requiresSignature,
    currency: p.currency,
    sections: p.doc.sections.map((s) => ({ key: s.id, id: s.id, heading: s.heading, body: s.body })),
    lines: p.doc.lines.map((l): EditorLine => ({
      key: l.id, id: l.id, catalogItemId: l.catalogItemId, name: l.name, description: l.description, unitLabel: l.unitLabel, quantity: formatQuantity(l.quantityMilli),
      price: toDecimalString(l.unitPriceMinor, c), billing: l.billing, taxRateId: l.taxRateId, taxName: l.taxName, taxBps: l.taxBps,
      discount: l.discount ? l.discount.kind : "none", discountValue: l.discount ? (l.discount.kind === "percent" ? bpsToPercent(l.discount.bps) : toDecimalString(l.discount.minor, c)) : "",
      note: l.note, catalogPriceMinor: l.catalogPriceMinor,
    })),
    terms: p.doc.terms,
    internalNotes: p.internalNotes ?? "",
  };
}

let seq = 0;
/** A key for a row that has no id yet. Only ever called from an event handler, never while rendering, so it cannot differ between the server and the browser. */
export const newKey = (): string => `new-${(seq += 1)}-${Math.random().toString(36).slice(2, 7)}`;

export function lineFromCatalog(item: CatalogChoice): EditorLine {
  const c = code(item.currency);
  return {
    key: newKey(), id: undefined, catalogItemId: item.id, name: item.name, description: item.description, unitLabel: item.unitLabel, quantity: "1", price: toDecimalString(item.unitPriceMinor, c),
    billing: item.billing, taxRateId: item.taxRateId, taxName: null, taxBps: item.taxBps ?? 0, discount: "none", discountValue: "", note: "", catalogPriceMinor: item.unitPriceMinor,
  };
}

export const blankLine = (): EditorLine => ({
  key: newKey(), id: undefined, catalogItemId: null, name: "", description: "", unitLabel: "each", quantity: "1", price: "", billing: "one_time", taxRateId: null, taxName: null, taxBps: 0,
  discount: "none", discountValue: "", note: "", catalogPriceMinor: null,
});

export const blankSection = (): EditorSection => ({ key: newKey(), id: undefined, heading: "", body: "" });

// ---------------------------------------------------------------------------
// Checking what was typed
// ---------------------------------------------------------------------------

export interface FieldIssue {
  /** "title", "clientEmail", "line:<key>:price", "section:<key>:heading", ... */
  path: string;
  message: string;
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const lineField = (key: string, field: string) => `line:${key}:${field}`;
export const sectionField = (key: string, field: string) => `section:${key}:${field}`;

/** The discount a line's fields describe, or why it cannot be one. "none" is a discount of null. */
export function discountOf(l: Pick<EditorLine, "discount" | "discountValue">, currency: string): { ok: true; discount: DocDiscount | null } | { ok: false; message: string } {
  if (l.discount === "none") return { ok: true, discount: null };
  if (l.discount === "percent") {
    const bps = percentToBps(l.discountValue);
    return bps === null ? { ok: false, message: "Enter a percentage from 0.01 to 100, such as 10 or 12.5." } : { ok: true, discount: { kind: "percent", bps } };
  }
  const p = parsePrice(l.discountValue, currency);
  if (!p.ok) return p;
  return p.minor < 1 ? { ok: false, message: "A fixed discount must be more than zero." } : { ok: true, discount: { kind: "fixed", minor: p.minor } };
}

export function editorIssues(s: EditorState): FieldIssue[] {
  const out: FieldIssue[] = [];
  const add = (path: string, message: string) => out.push({ path, message });
  const title = s.title.replace(/\s+/g, " ").trim();
  if (!title) add("title", "Give the proposal a title.");
  else if (title.length > 160) add("title", "The title can be at most 160 characters.");
  if (s.clientName.trim().length > 160) add("clientName", "The name can be at most 160 characters.");
  if (s.clientCompany.trim().length > 160) add("clientCompany", "The company can be at most 160 characters.");
  const email = s.clientEmail.trim();
  if (email && (email.length > 254 || !EMAIL.test(email))) add("clientEmail", "That email address doesn't look right.");
  if (s.validUntil && !isDay(s.validUntil)) add("validUntil", "Choose a real date.");
  if (!isCurrency(s.currency)) add("currency", `${s.currency || "That currency"} isn't one iAcquire can total.`);
  if (s.internalNotes.length > 4000) add("internalNotes", "Internal notes can be at most 4,000 characters.");
  if (s.sections.length > DOC_LIMITS.sections) add("sections", `A proposal can have at most ${DOC_LIMITS.sections} sections.`);
  for (const sec of s.sections) {
    if (!sec.heading.trim()) add(sectionField(sec.key, "heading"), "A section needs a heading.");
    else if (sec.heading.trim().length > DOC_LIMITS.heading) add(sectionField(sec.key, "heading"), `A heading can be at most ${DOC_LIMITS.heading} characters.`);
    if (sec.body.length > DOC_LIMITS.body) add(sectionField(sec.key, "body"), `A section can be at most ${DOC_LIMITS.body.toLocaleString("en-US")} characters.`);
    const why = markdownProblem(sec.body);
    if (why) add(sectionField(sec.key, "body"), why);
  }
  if (s.lines.length > DOC_LIMITS.lines) add("lines", `A proposal can have at most ${DOC_LIMITS.lines} lines.`);
  for (const l of s.lines) {
    if (!l.name.trim()) add(lineField(l.key, "name"), "Give the line a name.");
    else if (l.name.trim().length > DOC_LIMITS.lineName) add(lineField(l.key, "name"), `A name can be at most ${DOC_LIMITS.lineName} characters.`);
    if (!l.unitLabel.trim()) add(lineField(l.key, "unitLabel"), "Say what one unit is (each, hour, month).");
    else if (l.unitLabel.trim().length > DOC_LIMITS.unitLabel) add(lineField(l.key, "unitLabel"), `A unit label can be at most ${DOC_LIMITS.unitLabel} characters.`);
    const q = parseQty(l.quantity);
    if (!q.ok) add(lineField(l.key, "quantity"), q.message);
    const p = parsePrice(l.price, s.currency);
    if (!p.ok) add(lineField(l.key, "price"), p.message);
    const d = discountOf(l, s.currency);
    if (!d.ok) add(lineField(l.key, "discountValue"), d.message);
    if (q.ok && p.ok && d.ok) {
      try {
        lineFigures({ quantityMilli: q.milli, unitPriceMinor: p.minor, discount: d.discount, taxBps: l.taxBps });
      } catch (e) {
        add(lineField(l.key, d.discount ? "discountValue" : "price"), e instanceof MoneyError ? e.message : "The figures for this line can't be worked out.");
      }
    }
    if (l.description.length > DOC_LIMITS.lineDescription) add(lineField(l.key, "description"), `A description can be at most ${DOC_LIMITS.lineDescription.toLocaleString("en-US")} characters.`);
    if (l.note.length > DOC_LIMITS.lineNote) add(lineField(l.key, "note"), `A note can be at most ${DOC_LIMITS.lineNote} characters.`);
    const why = markdownProblem(l.description) ?? markdownProblem(l.note);
    if (why) add(lineField(l.key, markdownProblem(l.description) ? "description" : "note"), why);
  }
  if (s.terms.length > DOC_LIMITS.terms) add("terms", `The terms can be at most ${DOC_LIMITS.terms.toLocaleString("en-US")} characters.`);
  const termsWhy = markdownProblem(s.terms);
  if (termsWhy) add("terms", termsWhy);
  return out;
}

export const issueFor = (issues: readonly FieldIssue[], path: string): string | null => issues.find((i) => i.path === path)?.message ?? null;

// ---------------------------------------------------------------------------
// What is sent to the server
// ---------------------------------------------------------------------------

export interface LinePatch {
  id?: string;
  catalogItemId: string | null;
  name: string;
  description: string;
  unitLabel: string;
  quantityMilli: number;
  unitPriceMinor: number;
  billing: Billing;
  taxRateId: string | null;
  discount: DocDiscount | null;
  note: string;
}

export interface EditorPatch {
  title: string;
  clientName: string;
  clientCompany: string;
  clientEmail: string | null;
  validUntil: string | null;
  requiresSignature: boolean;
  currency: string;
  internalNotes: string | null;
  doc: { sections: Array<{ id?: string; heading: string; body: string }>; lines: LinePatch[]; terms: string };
}

/** The save request for what is on screen, or the issues that stop it. */
export function patchFromState(s: EditorState): { ok: true; patch: EditorPatch } | { ok: false; issues: FieldIssue[] } {
  const issues = editorIssues(s);
  if (issues.length) return { ok: false, issues };
  const lines: LinePatch[] = s.lines.map((l) => {
    const q = parseQty(l.quantity) as { ok: true; milli: number };
    const p = parsePrice(l.price, s.currency) as { ok: true; minor: number };
    const d = discountOf(l, s.currency) as { ok: true; discount: DocDiscount | null };
    return {
      ...(l.id ? { id: l.id } : {}), catalogItemId: l.catalogItemId, name: l.name.trim(), description: l.description, unitLabel: l.unitLabel.trim(), quantityMilli: q.milli, unitPriceMinor: p.minor,
      billing: l.billing, taxRateId: l.taxRateId, discount: d.discount, note: l.note,
    };
  });
  return {
    ok: true,
    patch: {
      title: s.title, clientName: s.clientName, clientCompany: s.clientCompany, clientEmail: s.clientEmail.trim() || null, validUntil: s.validUntil || null, requiresSignature: s.requiresSignature,
      currency: s.currency, internalNotes: s.internalNotes.trim() || null,
      doc: { sections: s.sections.map((sec) => ({ ...(sec.id ? { id: sec.id } : {}), heading: sec.heading.trim(), body: sec.body })), lines, terms: s.terms },
    },
  };
}

// ---------------------------------------------------------------------------
// Has anything changed
// ---------------------------------------------------------------------------

// The server collapses white space in single-line fields, turns Windows line breaks into plain ones and trims, so a field is compared the way it is stored.
const one = (v: string) => v.replace(/\s+/g, " ").trim();
const block = (v: string) => v.replace(/\r\n?/g, "\n").trim();

/** The fields that make a proposal what it is, in the form the server would store them. Two states with the same key save the same thing. */
export function stateKey(s: EditorState): string {
  return JSON.stringify([
    one(s.title), one(s.clientName), one(s.clientCompany), s.clientEmail.trim().toLowerCase(), s.validUntil, s.requiresSignature, s.currency, block(s.internalNotes),
    s.sections.map((x) => [x.id ?? null, one(x.heading), block(x.body)]),
    s.lines.map((l) => [l.id ?? null, l.catalogItemId, one(l.name), block(l.description), one(l.unitLabel), l.quantity.trim(), l.price.trim(), l.billing, l.taxRateId, l.discount, l.discount === "none" ? "" : l.discountValue.trim(), block(l.note)]),
    block(s.terms),
  ]);
}

export const sameState = (a: EditorState, b: EditorState): boolean => stateKey(a) === stateKey(b);

// ---------------------------------------------------------------------------
// Totals as typed
// ---------------------------------------------------------------------------

export interface LiveTotals {
  groups: GroupTotals;
  /** Per line, in order; null for a line whose figures cannot be worked out yet. */
  lines: Array<LineAmounts | null>;
  /** At least one line is not complete, so the totals leave it out. */
  incomplete: boolean;
}

/** The totals of the lines as typed, worked out by the same code the server uses. A line that is not complete yet (no price, a bad quantity) is left out and flagged. */
export function liveTotals(s: EditorState): LiveTotals {
  const amounts: Array<LineAmounts | null> = s.lines.map((l) => {
    const q = parseQty(l.quantity);
    const p = parsePrice(l.price, s.currency);
    const d = discountOf(l, s.currency);
    if (!q.ok || !p.ok || !d.ok) return null;
    try {
      return lineFigures({ quantityMilli: q.milli, unitPriceMinor: p.minor, discount: d.discount, taxBps: l.taxBps });
    } catch {
      return null;
    }
  });
  const groups = zeroGroups();
  for (const b of BILLINGS) groups[b] = sumLines(amounts.filter((a, i): a is LineAmounts => a !== null && s.lines[i].billing === b));
  return { groups, lines: amounts, incomplete: amounts.some((a) => a === null) };
}
