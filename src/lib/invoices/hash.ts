import crypto from "node:crypto";

// The fingerprint of an invoice as it was issued: everything a customer is shown that carries meaning, in a canonical form, so any later difference is visible.
// Pure. The hash is taken after the number is assigned, and it is stored; the database refuses to change the fields it covers once an invoice is issued.

export interface HashedLine {
  position: number;
  description: string;
  quantityMilli: number;
  unitPriceMinor: number;
  discountBps: number | null;
  taxRateBps: number | null;
  grossMinor: number;
  discountMinor: number;
  netMinor: number;
  taxMinor: number;
  totalMinor: number;
  exTaxMinor: number;
}

export interface HashedInvoice {
  number: string;
  currency: string;
  taxInclusive: boolean;
  issueOn: string;
  dueOn: string;
  billFrom: Record<string, unknown>;
  billTo: Record<string, unknown>;
  lines: HashedLine[];
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  paymentInstructions: string | null;
  notes: string | null;
  terms: string | null;
}

/** JSON with every object's keys in sorted order and no whitespace; an absent value reads as null. */
export function canonicalJson(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function invoiceContentHash(doc: HashedInvoice): string {
  return crypto.createHash("sha256").update(canonicalJson({ v: 1, ...doc }), "utf8").digest("hex");
}
