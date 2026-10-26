/**
 * Deterministic detector for a Lead Hunter research assignment typed into chat.
 *
 * This is deliberately not an LLM call: the portal must decide whether it can create a real,
 * persisted research job before it contacts a provider. When the request is ambiguous, the parser
 * returns the missing fields so the employee can ask for them instead of guessing.
 */

export interface ResearchAssignment {
  quantity: number | null;
  target: string;
  location: string;
  campaignType: "business";
  prompt: string;
  missing: Array<"quantity" | "target" | "location">;
}

const RESEARCH_VERB = /\b(find|research|discover|source|identify|hunt|build(?:\s+me)?(?:\s+a)?\s+list\s+of)\b/i;
const NEGATED_RESEARCH_ACTION = /\b(?:(?:do\s+not|don't|never|without|not)\s+(?:(?:do|perform|conduct|start|run|schedule)\s+)?(?:any\s+)?(?:new\s+)?research(?:ing)?|no\s+(?:lead\s+)?research)\b/gi;
const TARGET_NOUN = /\b(business(?:es)?|compan(?:y|ies)|agenc(?:y|ies)|leads?|prospects?|clients?|firms?|practices?|stores?|restaurants?|clinics?|contractors?|studios?|shops?|dealers?|brokers?|realtors?|startups?|organi[sz]ations?|schools?|hotels?|salons?|dentists?|lawyers?|accountants?|developers?|builders?|agents?)\b/i;
const LOCATION_PREP = /\b(?:in|near|around|across|within)\b/i;
const STOP = /\b(?:that|which|who|whom|with|and|to|for|from|because|so)\b|[,.;!?]/i;

const LEADING_QUALIFIERS = /^(?:me\s+)?(?:up to\s+)?(?:\d{1,3}\s+)?(?:qualified\s+|potential\s+|new\s+|local\s+|independent\s+|top\s+|good\s+)*/i;
const GENERIC_TARGET = /^(?:leads?|prospects?|clients?|business(?:es)?|compan(?:y|ies)|people|contacts?)$/i;
const LOCATION_STOP = /\b(?:that|which|who|whom|with|and|to|for|from|because|so)\b|[.;!?]/i;

function clean(value: string | undefined | null, max = 120): string {
  return (value ?? "")
    .replace(/\s+/g, " ")
    .replace(/^[\s"'“”‘’\-–—]+|[\s"'“”‘’\-–—]+$/g, "")
    .trim()
    .slice(0, max);
}

function quantityOf(text: string): number | null {
  const nearVerb = text.match(/\b(?:find|research|discover|source|identify|hunt|get)\s+(?:me\s+)?(?:up to\s+)?(\d{1,3})\b/i);
  const nearNoun = text.match(/\b(\d{1,3})\s+(?:qualified\s+)?(?:new\s+|potential\s+|local\s+)?(?:business(?:es)?|compan(?:y|ies)|agenc(?:y|ies)|leads?|prospects?|clients?|firms?|practices?|stores?|restaurants?|clinics?|contractors?|studios?|shops?|dealers?|brokers?|realtors?|startups?|organi[sz]ations?|schools?|hotels?|salons?|dentists?|lawyers?|accountants?|developers?|builders?|agents?)\b/i);
  const raw = nearVerb?.[1] ?? nearNoun?.[1] ?? null;
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return null;
  return Math.min(50, Math.floor(value));
}

function cutAtStop(value: string): string {
  const match = value.match(STOP);
  return clean(match ? value.slice(0, match.index) : value);
}

function cutLocation(value: string): string {
  const match = value.match(LOCATION_STOP);
  return clean(match ? value.slice(0, match.index) : value);
}

function stripVerbAndQuantity(value: string): string {
  return clean(value.replace(LEADING_QUALIFIERS, ""));
}

/**
 * Parses a natural-language assignment. Returns null when the message is ordinary conversation.
 * A non-null result with `missing` fields means the employee should ask a focused question.
 */
export function parseResearchAssignment(input: string): ResearchAssignment | null {
  const text = input.replace(/\s+/g, " ").trim().slice(0, 2000);
  const intentText = text.replace(NEGATED_RESEARCH_ACTION, " ");
  const reviewExistingResearch = /^\s*(?:please\s+)?(?:review|check|audit|summari[sz]e|analy[sz]e|explain)\b/i.test(intentText)
    && /\b(?:recent|saved|existing|previous|prior|completed|recorded)\s+(?:lead\s+)?research\b/i.test(intentText);
  const explicitNewResearch = /\b(?:find|research|discover|source|identify|hunt|get)\s+(?:(?:me|us)\s+)?(?:up to\s+)?\d{1,3}\b/i.test(intentText);
  if (reviewExistingResearch && !explicitNewResearch) return null;
  if (!intentText || !RESEARCH_VERB.test(intentText)) return null;
  if (!TARGET_NOUN.test(intentText) && !/\b\d{1,3}\b/.test(intentText)) return null;

  const quantity = quantityOf(intentText);

  // Preferred shape: "<verb> [N] <target> in|near|around <location> [that …]".
  const pattern = /\b(?:find|research|discover|source|identify|hunt|get|build(?:\s+me)?(?:\s+a)?\s+list\s+of)\s+(?:me\s+)?(?:up to\s+)?(?:\d{1,3}\s+)?(.*?)\s+(?:in|near|around|across|within)\s+(.+)/i;
  const matched = intentText.match(pattern);
  let target = "";
  let location = "";
  if (matched) {
    target = stripVerbAndQuantity(cutAtStop(matched[1]));
    location = cutLocation(matched[2]);
  } else {
    const prep = intentText.match(LOCATION_PREP);
    if (prep && prep.index !== undefined) {
      target = stripVerbAndQuantity(cutAtStop(intentText.slice(0, prep.index)));
      location = cutLocation(intentText.slice(prep.index + prep[0].length));
    } else {
      target = stripVerbAndQuantity(cutAtStop(intentText.replace(RESEARCH_VERB, "")));
    }
  }

  // "Find 20 leads" names the record type but not a useful business category. Treat the category
  // as missing rather than silently researching unnamed businesses.
  if (GENERIC_TARGET.test(target)) target = "";
  if (target.length < 2) target = "";
  if (/^(?:me|us|here|there|nearby|my area|my city|our area)$/i.test(location)) location = "";
  if (location.length < 2) location = "";
  // A bare prepositional phrase like "in Miami" is enough for location, but the target must still
  // describe what to find.
  if (!target && !quantity) return null;

  const missing: ResearchAssignment["missing"] = [];
  if (quantity === null) missing.push("quantity");
  if (!target) missing.push("target");
  if (!location) missing.push("location");

  return {
    quantity,
    target,
    location,
    campaignType: "business",
    prompt: text,
    missing,
  };
}

/** Plain-language clarification that names only the fields that are genuinely missing. */
export function researchClarification(assignment: ResearchAssignment): string {
  const parts: string[] = [];
  if (assignment.missing.includes("target")) parts.push("the kind of businesses to look for");
  if (assignment.missing.includes("location")) parts.push("the city or area to cover");
  if (assignment.missing.includes("quantity")) parts.push("the number of qualified leads you want");
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0];
  return `I can research that, but I need ${list}. Send those details and I'll create the research job.`;
}
