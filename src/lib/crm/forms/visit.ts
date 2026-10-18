// The visit a native form is sent from: the landing page, the attribution parameters it carried and the referring page, and the values
// hidden attribution fields take from it. Free of anything but types, so the small browser enhancement on hosted pages and websites works
// out hidden values (and so which questions show) exactly the way the server does when the answers arrive.
import type { Answers, HiddenSource } from "@/lib/crm/forms/spec";

/** The longest value a hidden field keeps (FORM_LIMITS.hidden). */
export const HIDDEN_VALUE_MAX = 300;

/** URL parameters kept as attribution when the landing page had them. */
export const ATTRIBUTION_PARAMS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid", "msclkid"] as const;
export type Attribution = Partial<Record<(typeof ATTRIBUTION_PARAMS)[number] | "landing_page" | "referrer", string>>;

const clean = (s: string, max: number) => s.replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, max);

export interface Visit {
  /** The page path and query the visitor landed on ("/f/acme/quote?utm_source=google"). */
  landing: string | null;
  /** The page that sent them, as the browser reported it. */
  referrer: string | null;
}

export interface ReadVisit {
  attribution: Attribution;
  params: URLSearchParams;
  landingPath: string | null;
}

/**
 * The visit as recorded: the landing page's path, the known attribution parameters it carried, and the referring page (scheme, host and
 * path only, never its query). Nothing is inferred; a value is recorded only when the visit had it. A referrer on `selfHost` is the page
 * itself (a reload), not where the visitor came from, and is dropped.
 */
export function readVisit(visit: Visit, opts: { selfHost?: string | null } = {}): ReadVisit {
  const attribution: Attribution = {};
  let params = new URLSearchParams();
  let landingPath: string | null = null;
  const landing = visit.landing ? clean(visit.landing, 1000) : "";
  if (landing.startsWith("/") && !landing.startsWith("//")) {
    try {
      const u = new URL(landing, "https://visit.invalid");
      landingPath = clean(u.pathname, 300) || "/";
      params = u.searchParams;
      attribution.landing_page = landingPath;
      for (const k of ATTRIBUTION_PARAMS) {
        const v = clean(u.searchParams.get(k) ?? "", 200);
        if (v) attribution[k] = v;
      }
    } catch {
      // An unreadable landing address records nothing.
    }
  }
  const ref = visit.referrer ? clean(visit.referrer, 1000) : "";
  if (ref) {
    try {
      const u = new URL(ref);
      if ((u.protocol === "https:" || u.protocol === "http:") && u.hostname && u.hostname.toLowerCase() !== (opts.selfHost ?? "").toLowerCase()) {
        attribution.referrer = `${u.protocol}//${u.host}${u.pathname}`.slice(0, 300);
      }
    } catch {
      // Not a web address: nothing is recorded.
    }
  }
  return { attribution, params, landingPath };
}

/** What a hidden field needs to take its value from the visit. */
export interface HiddenSubject {
  key: string;
  type: string;
  source?: HiddenSource;
}

/** A hidden field's value from the visit, or undefined when the visit didn't have one. */
export function hiddenValue(q: HiddenSubject, visit: ReadVisit): string | undefined {
  if (q.type !== "hidden" || !q.source) return undefined;
  let v: string | null | undefined;
  if (q.source.kind === "param") v = visit.params.get(q.source.param);
  else if (q.source.kind === "referrer") v = visit.attribution.referrer;
  else v = visit.landingPath;
  const out = v ? clean(v, HIDDEN_VALUE_MAX) : "";
  return out || undefined;
}

/** The hidden fields' values for a visit, by question key: only the ones the visit had. */
export function hiddenAnswers(fields: readonly HiddenSubject[], visit: Visit, opts: { selfHost?: string | null } = {}): Answers {
  const read = readVisit(visit, opts);
  const out: Answers = {};
  for (const f of fields) {
    const v = hiddenValue(f, read);
    if (v !== undefined) out[f.key] = v;
  }
  return out;
}
