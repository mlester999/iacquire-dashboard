// Placeholders in a proposal's wording: {{client.name}}, {{proposal.number}} and the few others below. They are filled when a version is frozen, so what a reviewer approves
// and what the customer reads is the finished text. This is a separate catalog from the message templates' tokens (src/lib/messaging/tokens.ts), which feed the inbox.
//
// Rules: only the tokens listed exist; an unknown token is an error (so a typo never reaches a customer); a token without a value is reported and the document is not frozen;
// a filled value is never expanded again, and the result never contains a raw {{ }}.

export const PROPOSAL_TOKENS = [
  { key: "client.name", label: "Customer's name", phrase: "the customer's name", sample: "Maria Santos" },
  { key: "client.first_name", label: "Customer's first name", phrase: "the customer's first name", sample: "Maria" },
  { key: "client.company", label: "Customer's company", phrase: "the customer's company", sample: "Santos Dental" },
  { key: "client.email", label: "Customer's email", phrase: "the customer's email address", sample: "maria@example.com" },
  { key: "deal.name", label: "Deal name", phrase: "the deal's name", sample: "Clinic website" },
  { key: "proposal.number", label: "Proposal number", phrase: "the proposal number", sample: "P-0001" },
  { key: "proposal.title", label: "Proposal title", phrase: "the proposal title", sample: "Website proposal" },
  { key: "proposal.valid_until", label: "Valid until", phrase: "the valid-until date", sample: "November 30, 2026" },
  { key: "business.name", label: "Your business name", phrase: "your business name", sample: "Your Business" },
  { key: "business.website", label: "Your website", phrase: "your website address", sample: "https://www.example.com" },
  { key: "sender.name", label: "Sender's name", phrase: "the sender's name", sample: "Alex Rivera" },
] as const;

export type ProposalTokenKey = (typeof PROPOSAL_TOKENS)[number]["key"];
export type ProposalTokenValues = Partial<Record<ProposalTokenKey, string | null | undefined>>;
const BY_KEY = new Map<string, (typeof PROPOSAL_TOKENS)[number]>(PROPOSAL_TOKENS.map((t) => [t.key, t]));
export const isProposalToken = (key: string): key is ProposalTokenKey => BY_KEY.has(key);
export const tokenPhrase = (key: string): string => BY_KEY.get(key)?.phrase ?? key;

const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

export interface TokenUse {
  raw: string;
  key: string;
  known: boolean;
}

/** Every {{ }} in the text, known or not, in order. */
export function findTokens(text: string): TokenUse[] {
  return [...(text ?? "").matchAll(PLACEHOLDER)].map((m) => ({ raw: m[0], key: m[1].trim(), known: isProposalToken(m[1].trim()) }));
}

/** Unfinished braces ("{{client.name" or a lone "}}") that would be sent as written. */
export function hasStrayBraces(text: string): boolean {
  const rest = (text ?? "").replace(PLACEHOLDER, "");
  return rest.includes("{{") || rest.includes("}}");
}

const noPlaceholders = (s: string): string => {
  let out = s;
  while (out.includes("{{") || out.includes("}}")) out = out.replaceAll("{{", "{").replaceAll("}}", "}");
  return out;
};
const cleanValue = (v: string): string => noPlaceholders(v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\s*[\r\n]+\s*/g, " ").trim());

export interface RenderedText {
  text: string;
  /** Known tokens that had no value, once each, in order. */
  missing: ProposalTokenKey[];
  /** Placeholders that are not tokens at all, once each. */
  unknown: string[];
}

export function renderProposalText(text: string, values: ProposalTokenValues): RenderedText {
  const missing = new Set<ProposalTokenKey>();
  const unknown = new Set<string>();
  const filled = (text ?? "").replace(PLACEHOLDER, (_raw, inner: string) => {
    const key = inner.trim();
    if (!isProposalToken(key)) {
      unknown.add(key);
      return "";
    }
    const v = values[key];
    const value = typeof v === "string" ? cleanValue(v) : "";
    if (value) return value;
    missing.add(key);
    return "";
  });
  return { text: noPlaceholders(filled), missing: [...missing], unknown: [...unknown] };
}

/** The first name of a full name: the first word. A one-word name is its own first name. */
export const firstNameOf = (full: string): string => full.trim().split(/\s+/)[0] ?? "";

/** A plain sentence for what is wrong with the placeholders, or null when all is well. */
export function describeTokenProblems(missing: readonly string[], unknown: readonly string[]): string | null {
  const parts: string[] = [];
  if (missing.length) parts.push(`This proposal uses ${missing.map(tokenPhrase).join(", ")}, which ${missing.length === 1 ? "isn't" : "aren't"} filled in. Fill ${missing.length === 1 ? "it" : "them"} in or take the placeholder out.`);
  if (unknown.length) parts.push(`It also contains ${unknown.length === 1 ? "a placeholder" : "placeholders"} iAcquire doesn't recognise (${unknown.map((u) => `{{${u}}}`).join(", ")}).`);
  return parts.length ? parts.join(" ") : null;
}
