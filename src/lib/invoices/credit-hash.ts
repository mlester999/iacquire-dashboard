import crypto from "node:crypto";
import { canonicalJson } from "@/lib/invoices/hash";

// Kept out of credit-notes.ts because the credit note screen (a client component) imports that file for its labels and rules, and a browser bundle cannot read node:crypto: only server code and tests import this one.

export interface HashedCreditNote {
  number: string;
  invoiceNumber: string;
  currency: string;
  amountMinor: number;
  taxPortionMinor: number;
  reason: string;
  issuedOn: string;
  billFrom: Record<string, unknown>;
  billTo: Record<string, unknown>;
}

/** The fingerprint of a credit note as it was issued: everything the document says, in a canonical form, so any later difference is visible. */
export function creditNoteContentHash(doc: HashedCreditNote): string {
  return crypto.createHash("sha256").update(canonicalJson({ v: 1, kind: "credit_note", ...doc }), "utf8").digest("hex");
}
