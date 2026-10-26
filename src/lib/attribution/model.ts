// How a lead's origin is read. Pure: nothing here touches a database or the network.
//
// The rule that shapes everything below: a touch says what it carried and HOW SURE that is.
//   known    explicit campaign tags (UTM), a paid click id, or a person's own choice
//   inferred from the referring site, or from the channel itself (a phone call is a phone call, which says nothing about which campaign rang)
//   unknown  the touch carried nothing, and the source is "unknown", never "direct" or a guess

export const TOUCH_KINDS = ["website_form", "crm_form", "website_chat", "call", "booking", "manual", "import", "api"] as const;
export type TouchKind = (typeof TOUCH_KINDS)[number];

export const TOUCH_KIND_LABELS: Record<TouchKind, string> = {
  website_form: "Website form",
  crm_form: "Hosted form",
  website_chat: "Website chat",
  call: "Phone call",
  booking: "Booking page",
  manual: "Chosen by a person",
  import: "Import",
  api: "API",
};

export type Confidence = "known" | "inferred" | "unknown";
export type Evidence = "utm" | "click_id" | "referrer" | "channel" | "manual" | "none";

export const CONFIDENCE_LABELS: Record<Confidence, string> = { known: "Recorded", inferred: "Inferred", unknown: "Not recorded" };

export interface TouchFacts {
  kind: TouchKind;
  /** What the visit carried: utm_source, utm_medium, utm_campaign, utm_term, utm_content, gclid, fbclid, msclkid, landing_page, referrer. */
  attribution?: Record<string, string | undefined> | null;
  /** A person's own choice (manual touches). */
  manual?: { source: string; medium?: string | null; campaign?: string | null } | null;
}

export interface ClassifiedTouch {
  source: string;
  medium: string | null;
  campaign: string | null;
  content: string | null;
  term: string | null;
  clickIds: Record<string, string>;
  landingPath: string | null;
  referrer: string | null;
  confidence: Confidence;
  evidence: Evidence;
}

export const UNKNOWN_SOURCE = "unknown";

/** A source name as stored: lower case, spaces and punctuation collapsed to single hyphens, 60 characters at most. "" when nothing usable is left. */
export function normalizeSourceName(raw: unknown, max = 60): string {
  if (typeof raw !== "string") return "";
  return raw.normalize("NFKC").toLowerCase().replace(/[\u0000-\u001F\u007F]/g, " ").trim().replace(/[^a-z0-9._:/+-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "").slice(0, max);
}

const cleanText = (raw: unknown, max: number): string | null => {
  if (typeof raw !== "string") return null;
  const t = raw.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  return t || null;
};

const SEARCH_HOSTS = [/(^|\.)google\.[a-z.]+$/, /(^|\.)bing\.com$/, /(^|\.)duckduckgo\.com$/, /(^|\.)yahoo\.[a-z.]+$/, /(^|\.)ecosia\.org$/, /(^|\.)baidu\.com$/, /(^|\.)yandex\.[a-z.]+$/];
const SOCIAL_HOSTS: Array<[RegExp, string]> = [
  [/(^|\.)(facebook|fb)\.com$|(^|\.)l\.facebook\.com$|^fb\.me$/, "facebook"],
  [/(^|\.)instagram\.com$|^l\.instagram\.com$/, "instagram"],
  [/(^|\.)linkedin\.com$|^lnkd\.in$/, "linkedin"],
  [/(^|\.)(twitter|x)\.com$|^t\.co$/, "x"],
  [/(^|\.)tiktok\.com$/, "tiktok"],
  [/(^|\.)youtube\.com$|^youtu\.be$/, "youtube"],
  [/(^|\.)pinterest\.[a-z.]+$/, "pinterest"],
  [/(^|\.)reddit\.com$/, "reddit"],
];

/** The source and medium a referring page implies. Always an inference: a visitor on a search page might have come from a paid or an organic result. */
export function sourceFromReferrer(referrer: string | null | undefined): { source: string; medium: string } | null {
  if (!referrer) return null;
  let host: string;
  try {
    host = new URL(referrer).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
  if (!host) return null;
  for (const [re, name] of SOCIAL_HOSTS) if (re.test(host)) return { source: name, medium: "social" };
  for (const re of SEARCH_HOSTS) {
    if (re.test(host)) {
      const name = host.startsWith("google.") || host.includes(".google.") ? "google" : host.includes("bing.") ? "bing" : host.split(".").slice(-2, -1)[0] ?? host;
      return { source: normalizeSourceName(name) || host, medium: "organic" };
    }
  }
  return { source: normalizeSourceName(host) || UNKNOWN_SOURCE, medium: "referral" };
}

/**
 * Reads a touch. Precedence: a person's choice, then explicit UTM tags, then a paid click id, then the referring site (inferred), then the channel
 * (a phone call), then nothing. A paid click id says which platform sent the click, not which campaign, so it never invents a campaign name.
 */
export function classifyTouch(facts: TouchFacts): ClassifiedTouch {
  const a = facts.attribution ?? {};
  const landingPath = cleanText(a.landing_page, 300);
  const referrer = cleanText(a.referrer, 300);
  const clickIds: Record<string, string> = {};
  for (const k of ["gclid", "fbclid", "msclkid"] as const) {
    const v = cleanText(a[k], 120);
    if (v) clickIds[k] = v;
  }
  const base = { content: cleanText(a.utm_content, 120), term: cleanText(a.utm_term, 120), clickIds, landingPath, referrer };

  if (facts.manual) {
    const source = normalizeSourceName(facts.manual.source);
    if (source) {
      return { ...base, source, medium: normalizeSourceName(facts.manual.medium ?? "", 80) || null, campaign: cleanText(facts.manual.campaign, 120), content: null, term: null, confidence: "known", evidence: "manual" };
    }
  }
  const utmSource = normalizeSourceName(a.utm_source);
  if (utmSource) {
    return { ...base, source: utmSource, medium: normalizeSourceName(a.utm_medium, 80) || null, campaign: cleanText(a.utm_campaign, 120), confidence: "known", evidence: "utm" };
  }
  if (clickIds.gclid) return { ...base, source: "google", medium: "cpc", campaign: cleanText(a.utm_campaign, 120), confidence: "known", evidence: "click_id" };
  if (clickIds.msclkid) return { ...base, source: "bing", medium: "cpc", campaign: cleanText(a.utm_campaign, 120), confidence: "known", evidence: "click_id" };
  if (clickIds.fbclid) return { ...base, source: "facebook", medium: null, campaign: cleanText(a.utm_campaign, 120), confidence: "known", evidence: "click_id" };

  const ref = sourceFromReferrer(referrer);
  if (ref) return { ...base, source: ref.source, medium: ref.medium, campaign: null, confidence: "inferred", evidence: "referrer" };
  if (facts.kind === "call") return { ...base, source: "phone", medium: "call", campaign: null, confidence: "inferred", evidence: "channel" };
  return { ...base, source: UNKNOWN_SOURCE, medium: null, campaign: null, confidence: "unknown", evidence: "none" };
}

const DISPLAY: Record<string, string> = {
  google: "Google", bing: "Bing", facebook: "Facebook", instagram: "Instagram", linkedin: "LinkedIn", x: "X", tiktok: "TikTok", youtube: "YouTube", pinterest: "Pinterest", reddit: "Reddit",
  email: "Email", newsletter: "Newsletter", phone: "Phone call", [UNKNOWN_SOURCE]: "Not recorded",
};

/**
 * A source for people to read. Known platforms get their proper name; any other name is shown as stored with only its first letter raised and hyphens or
 * underscores read as spaces ("trade-show" shows as "Trade show"). Typing that text back into a source field stores the same name again, so a label
 * and its stored name never drift apart.
 */
export function sourceLabel(source: string): string {
  const known = DISPLAY[source];
  if (known) return known;
  const text = source.replace(/[-_]+/g, " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : source;
}

// ---------------------------------------------------------------------------
// Money: what may be shown
// ---------------------------------------------------------------------------

/** Cost per lead needs a cost somebody entered and at least one lead. Otherwise it is not computed. */
export function costPerLead(cost: number | null, leads: number): number | null {
  if (cost === null || !Number.isFinite(cost) || cost < 0 || leads <= 0) return null;
  return Math.round((cost / leads) * 100) / 100;
}

/**
 * Return on spend needs BOTH a verified revenue figure (money that really arrived) and an entered cost above zero, in the same currency. Without either
 * it is not computed: the screen says what is missing instead of a number. The result is (revenue - cost) / cost.
 */
export function returnOnSpend(input: { verifiedRevenue: number | null; cost: number | null }): number | null {
  const { verifiedRevenue, cost } = input;
  if (verifiedRevenue === null || cost === null || !Number.isFinite(verifiedRevenue) || !Number.isFinite(cost) || cost <= 0) return null;
  return Math.round(((verifiedRevenue - cost) / cost) * 10_000) / 10_000;
}

/** Why a figure is not shown, in words, for the report. */
export function missingInputs(input: { verifiedRevenue: number | null; cost: number | null }): string | null {
  const needs: string[] = [];
  if (input.cost === null) needs.push("an entered campaign cost");
  if (input.verifiedRevenue === null) needs.push("verified payments");
  return needs.length ? `Needs ${needs.join(" and ")}.` : null;
}

interface MoneyOf {
  currency: string;
  amount: number;
}

export interface ReturnOnSpendResult {
  /** (revenue - cost) / cost, in the one currency both were in. Null when it cannot be worked out. */
  returnOnSpend: number | null;
  /** The currency the return was worked out in, or null. */
  currency: string | null;
  /** Why a return is not shown, or what was left out of one that is. Null when there is nothing to say. */
  missing: string | null;
}

/**
 * Return on spend for a source, per currency. It is worked out only when the source has exactly ONE cost currency and verified revenue in that same currency; amounts in
 * different currencies are never added, converted or compared, and nothing is estimated. Otherwise the result says in words why not. `workspaceHasPayments` is whether
 * the workspace has recorded any customer payment at all: until it has, "needs verified payments" is the honest answer; after, a source with no revenue yet is said so, and
 * not shown as a return of minus one hundred percent that depends on money nobody records.
 */
export function returnOnSpendFor(input: { cost: MoneyOf[]; verifiedRevenue: MoneyOf[]; workspaceHasPayments: boolean }): ReturnOnSpendResult {
  const none = (missing: string | null): ReturnOnSpendResult => ({ returnOnSpend: null, currency: null, missing });
  const { cost, verifiedRevenue, workspaceHasPayments } = input;
  if (cost.length === 0) return none(missingInputs({ verifiedRevenue: workspaceHasPayments ? 0 : null, cost: null }));
  if (cost.length > 1) return none("Cost was entered in several currencies, which are not converted, so no return is shown.");
  const single = cost[0];
  const revenue = verifiedRevenue.find((r) => r.currency === single.currency);
  if (!revenue) {
    if (verifiedRevenue.length > 0) return none(`Revenue (${verifiedRevenue.map((r) => r.currency).join(", ")}) and cost (${single.currency}) are in different currencies, which are not converted, so no return is shown.`);
    return none(workspaceHasPayments ? "No verified payments from these leads yet." : missingInputs({ verifiedRevenue: null, cost: single.amount }));
  }
  const value = returnOnSpend({ verifiedRevenue: revenue.amount, cost: single.amount });
  if (value === null) return none("A return cannot be worked out from this cost.");
  const others = verifiedRevenue.filter((r) => r.currency !== single.currency).map((r) => r.currency);
  return { returnOnSpend: value, currency: single.currency, missing: others.length ? `Revenue in ${others.join(", ")} is not included: it is not converted.` : null };
}
