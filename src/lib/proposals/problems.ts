// What is wrong with a proposal, in words a person can act on. Blocking problems stop it being sent for approval or sent, so a reviewer is never asked to look at something
// that could not go out; warnings are shown and never stop anything. Pure: the server runs this on every submit and send, the editor runs it live.
import { isCurrency, MoneyError } from "@/lib/money";
import { collectStrings, unsupportedCharacters, type ProposalDoc } from "@/lib/proposals/doc";
import { computeDocTotals } from "@/lib/proposals/money";
import type { ProposalSnapshot } from "@/lib/proposals/snapshot";
import { describeTokenProblems, type ProposalTokenKey } from "@/lib/proposals/tokens";
import { formatDay } from "@/lib/proposals/validity";

export type ProblemLevel = "blocking" | "warning";
export type ProblemCode =
  | "no_lines" | "client_name_missing" | "client_email_missing" | "valid_until_missing" | "valid_until_past" | "tokens" | "unsupported_characters" | "currency_unsupported"
  | "figures" | "ai_line_without_catalog" | "custom_line" | "price_override" | "tax_rate_archived" | "zero_total" | "signature_unavailable";

export interface Problem {
  level: ProblemLevel;
  code: ProblemCode;
  message: string;
  /** Which action it stops. "send" problems do not stop a proposal being sent for approval: they can be solved before the send, or by recording the signing offline. */
  stopsAt: "submit" | "send";
}

export interface ProblemFacts {
  doc: ProposalDoc;
  currency: string;
  validUntil: string | null;
  clientName: string;
  clientEmail: string | null;
  requiresSignature: boolean;
  origin: "human" | "ai";
  /** Today's date where the workspace is. */
  today: string;
  /** A signing service is connected and ready to send a request. */
  signingAvailable: boolean;
  /** When it is not: no connection (the default), a connection that needs attention, or a real service whose write switch is off in this environment. */
  signingWhy?: "none" | "needs_attention" | "writes_off";
  /** Tax rates the workspace has archived. A line that uses one keeps its rate, but the person should know. */
  archivedTaxRateIds: ReadonlySet<string>;
  /** The frozen copy this was checked against (placeholders filled in); null when it could not be made. */
  snapshot: ProposalSnapshot | null;
  missingTokens: readonly ProposalTokenKey[];
  unknownTokens: readonly string[];
}

const SIGNING_UNAVAILABLE_TEXT = {
  none: "This proposal needs a signature but no signing service is connected. Connect one, record the signing as done offline, or turn off the signature requirement.",
  needs_attention: "This proposal needs a signature, but the connected signing service needs attention (its key was refused). Connect it again, record the signing as done offline, or turn off the signature requirement.",
  writes_off: "This proposal needs a signature, but sending signing requests to a real signing service is switched off in this environment. Record the signing as done offline, or turn off the signature requirement.",
} as const;

const block = (code: ProblemCode, message: string, stopsAt: Problem["stopsAt"] = "submit"): Problem => ({ level: "blocking", code, message, stopsAt });
const warn = (code: ProblemCode, message: string): Problem => ({ level: "warning", code, message, stopsAt: "submit" });

export function proposalProblems(f: ProblemFacts): Problem[] {
  const out: Problem[] = [];
  if (!isCurrency(f.currency)) out.push(block("currency_unsupported", `${f.currency || "That currency"} isn't one iAcquire can total. Choose another.`));
  if (!f.doc.lines.length) out.push(block("no_lines", "Add at least one priced line."));
  if (!f.clientName.trim()) out.push(block("client_name_missing", "Say who the proposal is for."));
  if (!f.clientEmail) out.push(warn("client_email_missing", "There is no email address for the customer, so they cannot accept online. You can record their answer yourself."));
  if (!f.validUntil) out.push(warn("valid_until_missing", "No valid-until date: the proposal never expires on its own."));
  else if (f.validUntil < f.today) out.push(block("valid_until_past", `The valid-until date (${formatDay(f.validUntil)}) has already passed. Choose a later one.`));
  const tokens = describeTokenProblems(f.missingTokens, f.unknownTokens);
  if (tokens) out.push(block("tokens", tokens));
  if (f.snapshot) {
    const bad = unsupportedCharacters(collectStrings(f.snapshot).join("\n"));
    if (bad.length) out.push(block("unsupported_characters", `The PDF can't show ${bad.slice(0, 5).map((c) => `"${c}"`).join(" ")}${bad.length > 5 ? " and others" : ""}. Use plain Latin letters, or take ${bad.length === 1 ? "it" : "them"} out.`));
  }
  try {
    const { groups } = computeDocTotals(f.doc.lines);
    if (f.doc.lines.length && Object.values(groups).every((g) => g.total === 0)) out.push(warn("zero_total", "Every line is free, so the total is zero."));
  } catch (e) {
    out.push(block("figures", e instanceof MoneyError ? e.message : "The figures can't be worked out. Check the prices, quantities and discounts."));
  }
  const custom = f.doc.lines.filter((l) => l.catalogItemId === null);
  if (custom.length) {
    if (f.origin === "ai") out.push(block("ai_line_without_catalog", "An AI draft may only use items from your price book. Replace the lines that aren't."));
    else out.push(warn("custom_line", `${custom.length === 1 ? "A line isn't" : `${custom.length} lines aren't`} from your price book: ${custom.slice(0, 3).map((l) => l.name).join(", ")}.`));
  }
  const overridden = f.doc.lines.filter((l) => l.catalogPriceMinor !== null && l.unitPriceMinor !== l.catalogPriceMinor);
  if (overridden.length) out.push(warn("price_override", `${overridden.length === 1 ? "A line is" : `${overridden.length} lines are`} priced differently from the price book: ${overridden.slice(0, 3).map((l) => l.name).join(", ")}.`));
  const archived = f.doc.lines.filter((l) => l.taxRateId !== null && f.archivedTaxRateIds.has(l.taxRateId));
  if (archived.length) out.push(warn("tax_rate_archived", `${archived.length === 1 ? "A line uses" : `${archived.length} lines use`} a tax rate you have archived. It still applies to this proposal.`));
  if (f.requiresSignature && !f.signingAvailable) out.push(block("signature_unavailable", SIGNING_UNAVAILABLE_TEXT[f.signingWhy ?? "none"], "send"));
  return out;
}

/** The blocking problems that stop this action. */
export const blockingFor = (problems: readonly Problem[], action: "submit" | "send"): Problem[] =>
  problems.filter((p) => p.level === "blocking" && (action === "send" || p.stopsAt === "submit"));
