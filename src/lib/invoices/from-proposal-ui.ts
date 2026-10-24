// What the proposal's Invoice tab offers and says, as plain functions. Pure: the server decides every one of these again and refuses what it should; this only keeps the screen
// from offering what will be refused and from saying more than was done.

export interface MakeOfferFacts {
  /** The person may make invoices (invoices.create). */
  canCreate: boolean;
  /** The person may ask for a further invoice from a version that already has one (invoices.approve). */
  canMakeAnother: boolean;
  /** Why nothing can be made from this proposal now. Null when something can. */
  problem: { text: string } | null;
  /** How many invoices were already made from this saved version. */
  alreadyForThisVersion: number;
}

export type MakeOfferKind = "make" | "another" | "none";

export interface MakeOffer {
  kind: MakeOfferKind;
  /** The sentence that says why there is no button, or what the button will not do. Null when there is nothing to add. */
  note: string | null;
}

export function makeOfferFor(f: MakeOfferFacts): MakeOffer {
  if (!f.canCreate) return { kind: "none", note: "Your role can't make invoices. Ask the business owner or a manager." };
  if (f.problem) return { kind: "none", note: f.problem.text };
  if (f.alreadyForThisVersion === 0) return { kind: "make", note: null };
  const n = f.alreadyForThisVersion;
  const had = `${n === 1 ? "A draft invoice was" : `${n} invoices were`} already made from this version of the proposal.`;
  return f.canMakeAnother
    ? { kind: "another", note: `${had} Make a further one only if the customer is really to be invoiced again, for a deposit and a balance, say.` }
    : { kind: "none", note: `${had} Only the business owner or a manager can make a further one.` };
}

/** The confirmation's sentence: what is copied, what is left, and what is not done. */
export function confirmText(f: { lines: number; recurring: number; customerName: string | null; another: boolean }): string {
  const copied = `${f.lines} ${f.lines === 1 ? "line" : "lines"} the customer pays once ${f.lines === 1 ? "is" : "are"} copied, as the accepted version has ${f.lines === 1 ? "it" : "them"}.`;
  const left = f.recurring > 0 ? ` ${f.recurring} monthly or yearly ${f.recurring === 1 ? "line is" : "lines are"} left off for you to decide.` : "";
  const who = f.customerName ? ` The draft is for ${f.customerName}.` : " The proposal is not linked to a customer record, so you choose the customer on the draft.";
  const another = f.another ? " This is a further invoice for a version that already has one." : "";
  return `${copied}${left}${who}${another} It is only a draft: nothing is issued, sent or charged, and the deal is not changed. An owner or manager approves it before it is issued.`;
}

/** What the server answered, in words. */
export type MadeResult =
  | { status: "created"; invoiceId: string; lines: number; recurringLines: number }
  | { status: "already"; invoiceId: string; count: number }
  | { status: "error"; text: string };

export function madeText(r: MadeResult): { tone: "ok" | "info" | "error"; text: string } {
  switch (r.status) {
    case "created": {
      const left = r.recurringLines > 0 ? ` ${r.recurringLines} monthly or yearly ${r.recurringLines === 1 ? "line was" : "lines were"} left off.` : "";
      return { tone: "ok", text: `A draft invoice was made with ${r.lines} ${r.lines === 1 ? "line" : "lines"}.${left} Nothing was issued or sent.` };
    }
    case "already": return { tone: "info", text: `A draft invoice was already made from this version, so nothing new was made${r.count > 1 ? ` (${r.count} exist)` : ""}.` };
    default: return { tone: "error", text: r.text };
  }
}
