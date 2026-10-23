import "server-only";
import crypto from "node:crypto";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { parseDoc, type Billing, type DocDiscount, type DocLine, type ProposalDoc, type TemplateDoc } from "@/lib/proposals/doc";

// Turns what a browser (or a template) sends into a stored document. The server decides the facts that matter: a line's price-book price, its tax name and rate, and whether
// a catalog item exists in THIS workspace are looked up here, so nothing a browser claims about them is trusted.

export interface LineInput {
  /** Keeps the line's identity across saves. A line without one is new. */
  id?: string;
  catalogItemId?: string | null;
  name?: string;
  description?: string;
  unitLabel?: string;
  quantityMilli: number;
  unitPriceMinor?: number;
  billing?: Billing;
  /** Undefined keeps the line's tax (or takes the item's, for a new line); null means none. */
  taxRateId?: string | null;
  discount?: DocDiscount | null;
  note?: string;
}

export interface SectionInput {
  id?: string;
  heading: string;
  body?: string;
}

export interface DocInput {
  sections?: SectionInput[];
  lines?: LineInput[];
  terms?: string;
}

export const newPartId = (): string => crypto.randomUUID().replace(/-/g, "").slice(0, 12);

interface ItemRow { id: string; name: string; description: string; unit_label: string; unit_price_minor: string; currency: string; billing: Billing; tax_rate_id: string | null; archived_at: Date | null }
interface TaxRow { id: string; name: string; rate_bps: number; archived_at: Date | null }

async function loadItems(db: Queryable, orgId: string, ids: string[]): Promise<Map<string, ItemRow>> {
  if (!ids.length) return new Map();
  const { rows } = await db.query<ItemRow>(
    "select id, name, description, unit_label, unit_price_minor::text as unit_price_minor, currency, billing, tax_rate_id, archived_at from proposal_catalog_items where org_id = $1 and id = any($2::uuid[])", [orgId, ids],
  );
  return new Map(rows.map((r) => [r.id, r]));
}

async function loadRates(db: Queryable, orgId: string, ids: string[]): Promise<Map<string, TaxRow>> {
  if (!ids.length) return new Map();
  const { rows } = await db.query<TaxRow>("select id, name, rate_bps, archived_at from proposal_tax_rates where org_id = $1 and id = any($2::uuid[])", [orgId, ids]);
  return new Map(rows.map((r) => [r.id, r]));
}

const unique = (xs: Array<string | null | undefined>): string[] => [...new Set(xs.filter((x): x is string => Boolean(x)))];

function invalid(doc: ReturnType<typeof parseDoc>): never {
  throw new AppError("invalid_input", doc.ok ? "That document isn't valid." : doc.errors[0]);
}

/**
 * The stored document for what a person submitted, given the document as it was. A catalog item of another workspace is "not found", exactly like one that does not exist.
 * An archived item or tax rate cannot be added, but a line that already uses one keeps it. The price-book price on a line is the price when the line was added.
 */
export async function buildDoc(db: Queryable, orgId: string, input: DocInput, existing: ProposalDoc, currency: string): Promise<ProposalDoc> {
  const inLines = input.lines ?? existing.lines.map((l): LineInput => ({ ...l }));
  const prior = new Map(existing.lines.map((l) => [l.id, l]));
  const items = await loadItems(db, orgId, unique(inLines.map((l) => l.catalogItemId)));
  const rateIds = unique(inLines.flatMap((l) => [l.taxRateId, ...(l.taxRateId === undefined && l.catalogItemId ? [items.get(l.catalogItemId)?.tax_rate_id] : [])]));
  const rates = await loadRates(db, orgId, rateIds);

  const lines = inLines.map((l): DocLine => {
    const was = l.id ? prior.get(l.id) : undefined;
    const item = l.catalogItemId ? items.get(l.catalogItemId) : undefined;
    if (l.catalogItemId && !item) throw new AppError("not_found", "A price book item you chose was not found.");
    const keepsItem = Boolean(was && item && was.catalogItemId === item.id);
    if (item) {
      if (item.archived_at && !keepsItem) throw new AppError("invalid_input", `${item.name} is archived. Choose another item or restore it in the price book.`);
      if (item.currency !== currency) throw new AppError("invalid_input", `${item.name} is priced in ${item.currency}, and this proposal is in ${currency}.`);
    }
    // The tax: what was chosen; else what the line already had; else the item's own. A rate kept from before keeps its saved name and figure even if the rate has changed since.
    const wantedRate = l.taxRateId !== undefined ? l.taxRateId : was ? was.taxRateId : item?.tax_rate_id ?? null;
    let taxName: string | null = null;
    let taxBps = 0;
    if (wantedRate) {
      if (was && was.taxRateId === wantedRate) {
        taxName = was.taxName;
        taxBps = was.taxBps;
      } else {
        const rate = rates.get(wantedRate);
        if (!rate) throw new AppError("not_found", "A tax rate you chose was not found.");
        if (rate.archived_at && !(item && item.tax_rate_id === rate.id && l.taxRateId === undefined)) throw new AppError("invalid_input", `The tax rate ${rate.name} is archived. Choose another.`);
        taxName = rate.name;
        taxBps = rate.rate_bps;
      }
    }
    const catalogPrice = item ? (keepsItem && was ? was.catalogPriceMinor : Number(item.unit_price_minor)) : null;
    if (l.unitPriceMinor === undefined && !item) throw new AppError("invalid_input", "Give every line a price.");
    return {
      id: l.id ?? newPartId(),
      catalogItemId: item?.id ?? null,
      name: l.name ?? item?.name ?? "",
      description: l.description ?? (item ? item.description : was?.description ?? ""),
      unitLabel: l.unitLabel ?? (item ? item.unit_label : was?.unitLabel ?? "each"),
      quantityMilli: l.quantityMilli,
      unitPriceMinor: l.unitPriceMinor ?? Number(item?.unit_price_minor),
      catalogPriceMinor: catalogPrice,
      billing: l.billing ?? item?.billing ?? was?.billing ?? "one_time",
      taxRateId: wantedRate ?? null,
      taxName,
      taxBps,
      discount: l.discount !== undefined ? l.discount : was?.discount ?? null,
      note: l.note ?? was?.note ?? "",
    };
  });

  const sections = (input.sections ?? existing.sections).map((s) => ({ id: ("id" in s && s.id) || newPartId(), heading: s.heading, body: s.body ?? "" }));
  const parsed = parseDoc({ v: 1, sections, lines, terms: input.terms ?? existing.terms });
  return parsed.ok ? parsed.value : invalid(parsed);
}

/** A template's lines read from the price book as it is now. A template that points at an item that is gone, archived or priced in another currency cannot be used until it is fixed. */
export async function docFromTemplate(db: Queryable, orgId: string, template: TemplateDoc, currency: string): Promise<ProposalDoc> {
  const items = await loadItems(db, orgId, unique(template.lines.map((l) => l.catalogItemId)));
  const rates = await loadRates(db, orgId, unique([...items.values()].map((i) => i.tax_rate_id)));
  const lines = template.lines.map((l): DocLine => {
    const item = items.get(l.catalogItemId);
    if (!item || item.archived_at) throw new AppError("invalid_input", "This template uses a price book item that is no longer available. Update the template first.");
    if (item.currency !== currency) throw new AppError("invalid_input", `This template uses ${item.name}, which is priced in ${item.currency}. This proposal is in ${currency}.`);
    const rate = item.tax_rate_id ? rates.get(item.tax_rate_id) : undefined;
    return {
      id: l.id, catalogItemId: item.id, name: item.name, description: item.description, unitLabel: item.unit_label, quantityMilli: l.quantityMilli, unitPriceMinor: Number(item.unit_price_minor),
      catalogPriceMinor: Number(item.unit_price_minor), billing: item.billing, taxRateId: rate?.id ?? null, taxName: rate?.name ?? null, taxBps: rate?.rate_bps ?? 0, discount: null, note: l.note,
    };
  });
  const parsed = parseDoc({ v: 1, sections: template.sections, lines, terms: template.terms });
  return parsed.ok ? parsed.value : invalid(parsed);
}
