import "server-only";
import crypto from "node:crypto";
import { withSiteRuntime } from "@/server/db";
import type { SiteContent } from "@/lib/website/doc";
import { formKeysIn } from "@/lib/crm/forms/website";
import { firstValue, validateSubmission, type RawFields } from "@/lib/crm/forms/logic";
import type { PublicFormDef } from "@/lib/crm/forms/spec";
import { submissionDedupeKey } from "@/server/crm/forms/public";
import { siteLiveForms } from "@/server/crm/forms/site-trusted";
import { toPublicDef } from "@/server/crm/forms/store";
import { isVerifiedSite, type LiveSite } from "@/server/sites/runtime";

// Native forms on a client's iAcquire website. The form element names a form by key; a live page draws that form's published questions
// (or the built-in enquiry form when the key isn't a live form of the site's workspace), and the post goes to the site's own /__iaq/form
// like the built-in form. The enquiry handler (src/server/sites/enquiry.ts) does the same-site check, honeypot, signed time token and
// rate limits first, then hands a native form's post here: the answers are checked against the exact published version and stored
// through app.submit_crm_form, as iaq_site_runtime, which resolves the workspace from the host itself.

const CACHE_MS = 10_000;
const cache = new Map<string, { at: number; value: Record<string, PublicFormDef> }>();
export function clearSiteFormCache() {
  cache.clear();
}

/** The live native forms a site's form elements name, as visitors see them. Null when the content names none. Cached for a few seconds. */
export async function siteFormDefinitions(site: LiveSite, content: SiteContent = site.content): Promise<Record<string, PublicFormDef> | null> {
  // Checked before the cache, so a cached answer is only ever given for a site resolveSite really returned.
  if (!isVerifiedSite(site)) throw new Error("Website forms need the site resolved from the request's verified host.");
  const keys = formKeysIn(content);
  if (!keys.length) return null;
  const cacheKey = `${site.orgId}|${keys.join(",")}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const live = await siteLiveForms(site, keys);
  const value: Record<string, PublicFormDef> = {};
  for (const [key, f] of live) value[key] = toPublicDef(f.form, f.version);
  if (cache.size > 2000) cache.clear();
  cache.set(cacheKey, { at: Date.now(), value });
  return value;
}

export type SiteFormResult = { kind: "redirect"; to: string } | { kind: "error"; status: number; message: string };

export interface SiteFormRequest {
  site: LiveSite;
  host: string;
  /** The key the published form element names (never what the browser says). */
  formKey: string;
  /** The page the form was on. */
  pageSlug: string;
  raw: RawFields;
  /** The post's Referer header: the page (and its query) the form was sent from. */
  referer: string | null;
  /** The keyed hash of the visitor's address the enquiry handler worked out. */
  clientHash: string;
  now?: number;
}

/** The page the visitor was on, from the browser's own note (`_l`) or else the post's Referer, only when it is a page of this host. */
function landingFrom(raw: RawFields, referer: string | null, host: string): string | null {
  const own = firstValue(raw, "_l");
  if (own.startsWith("/") && !own.startsWith("//")) return own.slice(0, 1000);
  if (!referer) return null;
  try {
    const u = new URL(referer);
    return u.hostname.toLowerCase() === host ? `${u.pathname}${u.search}`.slice(0, 1000) : null;
  } catch {
    return null;
  }
}

export async function handleSiteCrmForm(req: SiteFormRequest): Promise<SiteFormResult> {
  const live = (await siteLiveForms(req.site, [req.formKey])).get(req.formKey);
  if (!live) return { kind: "error", status: 404, message: "This form isn't taking answers right now. Please get in touch another way." };
  const v = live.version;
  const check = validateSubmission({ questions: v.fields, consent: v.consent, kind: live.form.kind }, req.raw, {
    callingCode: live.callingCode,
    visit: { landing: landingFrom(req.raw, req.referer, req.host), referrer: firstValue(req.raw, "_r") || null },
    selfHost: req.host,
  });
  if (!check.ok) return { kind: "error", status: 400, message: check.message };
  const ipHash = crypto.createHash("sha256").update(`crm-form-site:${req.clientHash}`).digest("hex");
  // One attempt per page load and visitor (the signed token the page was drawn with, and their keyed address hash): a double click is one
  // submission, two visitors giving the same answers are two.
  const dedupe = submissionDedupeKey(`site:${req.host}:${live.form.key}`, check.answers, check.consentGiven, check.marketing, { token: firstValue(req.raw, "t"), client: ipHash });
  const { rows } = await withSiteRuntime((db) =>
    db.query<{ result: { ok: boolean; duplicate?: boolean; reason?: string } }>(
      "select app.submit_crm_form($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) as result",
      [
        req.host, live.form.key, req.pageSlug.slice(0, 200) || "home", JSON.stringify(check.answers), JSON.stringify(check.attribution),
        check.consentGiven ? v.consent.text : null, check.marketing, check.marketing ? v.consent.marketing.text : null, ipHash, dedupe,
        // The version these answers were checked against, so a republish in between can't pair them with other questions.
        v.id,
      ],
    ),
  );
  const r = rows[0]?.result;
  if (!r?.ok) return { kind: "error", status: 404, message: "This form isn't taking answers right now. Please get in touch another way." };
  // Post, then redirect, so refreshing the thank-you page never sends the answers again.
  return { kind: "redirect", to: "/thanks" };
}
