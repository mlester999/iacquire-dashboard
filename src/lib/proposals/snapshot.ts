// The frozen copy of a version: the working document with its placeholders filled in, its figures worked out, and nothing internal in it (no catalog link, no price book
// price, no note for the team). This is what a reviewer approves, what the customer's page and PDF show, and what a decision or a signature is bound to (its hash).
import type { CurrencyCode } from "@/lib/money";
import type { LineAmounts } from "@/lib/money";
import type { Billing, DocDiscount, ProposalDoc } from "@/lib/proposals/doc";
import { computeDocTotals, type GroupTotals } from "@/lib/proposals/money";
import { firstNameOf, renderProposalText, type ProposalTokenKey, type ProposalTokenValues } from "@/lib/proposals/tokens";
import { formatDay } from "@/lib/proposals/validity";

export interface SnapshotLine {
  name: string;
  description: string;
  unitLabel: string;
  quantityMilli: number;
  unitPriceMinor: number;
  billing: Billing;
  taxName: string | null;
  taxBps: number;
  discount: DocDiscount | null;
  note: string;
  amounts: LineAmounts;
}

export interface ProposalSnapshot {
  v: 1;
  number: string;
  title: string;
  currency: CurrencyCode;
  validUntil: string | null;
  requiresSignature: boolean;
  business: { name: string; website: string | null };
  sender: { name: string | null };
  client: { name: string; company: string; email: string | null };
  sections: Array<{ heading: string; body: string }>;
  lines: SnapshotLine[];
  groups: GroupTotals;
  terms: string;
}

export interface FreezeInput {
  number: string;
  title: string;
  currency: CurrencyCode;
  validUntil: string | null;
  requiresSignature: boolean;
  client: { name: string; company: string; email: string | null };
  business: { name: string; website: string | null };
  sender: { name: string | null };
  dealName: string | null;
  doc: ProposalDoc;
}

export interface Frozen {
  snapshot: ProposalSnapshot;
  /** Placeholders that had no value; a version with any is not frozen. */
  missing: ProposalTokenKey[];
  /** Placeholders that are not tokens. */
  unknown: string[];
}

export function tokenValuesFor(i: FreezeInput): ProposalTokenValues {
  return {
    "client.name": i.client.name, "client.first_name": firstNameOf(i.client.name), "client.company": i.client.company, "client.email": i.client.email,
    "deal.name": i.dealName, "proposal.number": i.number, "proposal.title": i.title, "proposal.valid_until": i.validUntil ? formatDay(i.validUntil) : null,
    "business.name": i.business.name, "business.website": i.business.website, "sender.name": i.sender.name,
  };
}

export function freeze(i: FreezeInput): Frozen {
  const values = tokenValuesFor(i);
  const missing = new Set<ProposalTokenKey>();
  const unknown = new Set<string>();
  const fill = (text: string): string => {
    const r = renderProposalText(text, values);
    for (const m of r.missing) missing.add(m);
    for (const u of r.unknown) unknown.add(u);
    return r.text;
  };
  const { lines: figures, groups } = computeDocTotals(i.doc.lines);
  const snapshot: ProposalSnapshot = {
    v: 1,
    number: i.number,
    title: i.title,
    currency: i.currency,
    validUntil: i.validUntil,
    requiresSignature: i.requiresSignature,
    business: i.business,
    sender: i.sender,
    client: i.client,
    sections: i.doc.sections.map((s) => ({ heading: fill(s.heading), body: fill(s.body) })),
    lines: i.doc.lines.map((l, n) => ({
      name: fill(l.name), description: fill(l.description), unitLabel: l.unitLabel, quantityMilli: l.quantityMilli, unitPriceMinor: l.unitPriceMinor, billing: l.billing,
      taxName: l.taxBps > 0 ? l.taxName : null, taxBps: l.taxBps, discount: l.discount, note: fill(l.note), amounts: figures[n],
    })),
    groups,
    terms: fill(i.doc.terms),
  };
  return { snapshot, missing: [...missing], unknown: [...unknown] };
}

/**
 * The working fields a version was made from, exactly as stored (placeholders not filled in). Its hash is the version's source_hash: sending recomputes it from the row and
 * refuses when it differs, so a change made around the approval is caught even if the version number was not moved.
 */
export function sourceOf(row: { title: string; currency: string; validUntil: string | null; requiresSignature: boolean; clientName: string; clientCompany: string; clientEmail: string | null; doc: ProposalDoc }) {
  return {
    v: 1,
    title: row.title,
    currency: row.currency,
    validUntil: row.validUntil,
    requiresSignature: row.requiresSignature,
    client: { name: row.clientName, company: row.clientCompany, email: row.clientEmail },
    doc: row.doc,
  };
}
