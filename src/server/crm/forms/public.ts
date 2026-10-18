import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { hashIp, sha256 } from "@/server/security/crypto";
import { consumeRateLimit, type RateLimitRule } from "@/server/security/rate-limit";
import { checkFormToken, issueFormToken } from "@/server/sites/form-token";
import { canonicalJson, FORM_KEY_RE, type PublicFormDef } from "@/lib/crm/forms/spec";
import { firstValue, validateSubmission, type RawFields } from "@/lib/crm/forms/logic";
import { loadPublishedByKey, toPublicDef, type FormRow, type VersionRow } from "@/server/crm/forms/store";

// Hosted form pages (/f/<workspace>/<form>) and their submit route (/api/public/forms/submit). Everything here runs for people who are
// not signed in, so it shows only what the form is meant to show, answers every miss with the same not-found (an unknown workspace, a
// form that is a draft, archived, not offered as a page, or a workspace whose contacts live in GoHighLevel), and keeps the HTTP-facing
// decisions in one place: same origin, honeypot, signed time token, per-visitor and per-form rate limits, then the answers checked
// against the exact published version. A submission is stored for the scheduler to process (src/server/crm/forms/process.ts).

/** Limits for hosted pages. Keys are hashed addresses or form ids, never raw personal data. */
export const FORM_RATE_LIMITS = {
  pageByIp: { name: "crm-form:page:ip", limit: 120, windowSeconds: 60 },
  submitByIp: { name: "crm-form:submit:ip", limit: 8, windowSeconds: 600 },
  submitByForm: { name: "crm-form:submit:form", limit: 150, windowSeconds: 3600 },
} satisfies Record<string, RateLimitRule>;

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
/** The hidden field a person never sees; anything that fills it is treated as a bot. */
export const HONEYPOT_FIELD = "website";

export interface HostedBusiness {
  name: string;
  slug: string;
  brandColor: string | null;
}

/** What a hosted form page shows: the business's name and colour and the form as visitors see it. Never ids or settings. */
export interface HostedFormView {
  business: HostedBusiness;
  form: PublicFormDef;
}

interface Target {
  orgId: string;
  callingCode: string | null;
  business: HostedBusiness;
  form: FormRow;
  version: VersionRow;
}

async function loadTarget(db: Queryable, orgSlug: string, key: string): Promise<Target | null> {
  const o = orgSlug.toLowerCase();
  const k = key.toLowerCase();
  if (!SLUG.test(o) || !FORM_KEY_RE.test(k)) return null;
  const { rows } = await db.query<{ id: string; name: string; slug: string; brand_color: string | null; calling_code: string | null; mode: string | null; provider: string | null }>(
    `select o.id, o.name, o.slug, p.brand_color, w.default_calling_code as calling_code, w.mode, cp.provider
     from organizations o
     left join crm_workspaces w on w.org_id = o.id
     left join crm_capability_providers cp on cp.org_id = o.id and cp.capability = 'contacts'
     left join company_profiles p on p.org_id = o.id
     where o.slug = $1 and o.kind = 'client' and o.status not in ('suspended', 'archived')`,
    [o],
  );
  const org = rows[0];
  if (!org) return null;
  const owner = org.mode === null ? "native" : org.mode === "hybrid" ? (org.provider ?? "native") : org.mode;
  if (owner !== "native") return null;
  const live = await loadPublishedByKey(db, org.id, k);
  if (!live || !live.form.hosted) return null;
  return { orgId: org.id, callingCode: org.calling_code, business: { name: org.name, slug: org.slug, brandColor: org.brand_color }, form: live.form, version: live.version };
}

async function readTarget(orgSlug: string, key: string): Promise<Target | null> {
  return withSystem(async (db) => {
    await db.query("set transaction read only");
    return loadTarget(db, orgSlug, key);
  });
}

export async function resolveHostedForm(orgSlug: string, key: string): Promise<HostedFormView | null> {
  const t = await readTarget(orgSlug, key);
  return t ? { business: t.business, form: toPublicDef(t.form, t.version) } : null;
}

/** After sending: the thank-you message, or the https address the business chose (shown as a link; script-free pages refresh to it). */
export async function hostedFormAfter(orgSlug: string, key: string): Promise<{ business: HostedBusiness; title: string; message: string | null; redirect: string | null } | null> {
  const t = await readTarget(orgSlug, key);
  if (!t) return null;
  const after = t.version.actions.after;
  return {
    business: t.business,
    title: t.version.settings.title || t.form.name,
    message: after.kind === "message" ? after.message : null,
    redirect: after.kind === "redirect" ? after.url : null,
  };
}

const binding = (orgSlug: string, key: string) => `crm-form:${orgSlug.toLowerCase()}/${key.toLowerCase()}`;

/** The signed time token a hosted form carries, bound to that page. */
export function hostedFormToken(orgSlug: string, key: string, now = Date.now()): string {
  return issueFormToken(binding(orgSlug, key), now);
}

/** Whether to serve a hosted form page to this visitor, or ask them to slow down. */
export async function allowHostedFormView(ip: string | null): Promise<boolean> {
  return (await consumeRateLimit(FORM_RATE_LIMITS.pageByIp, hashIp(ip) ?? "unknown")).allowed;
}

export interface PublicRequestMeta {
  origin: string | null;
  /** The host the browser addressed (X-Forwarded-Host behind the proxy, else Host). */
  host: string | null;
  secFetchSite: string | null;
  ip: string | null;
  now?: Date;
}

export function requestMetaFrom(req: Request): PublicRequestMeta {
  const h = req.headers;
  let urlHost: string | null = null;
  try {
    urlHost = new URL(req.url).host;
  } catch {
    urlHost = null;
  }
  return {
    origin: h.get("origin"),
    host: h.get("x-forwarded-host") ?? h.get("host") ?? urlHost,
    secFetchSite: h.get("sec-fetch-site"),
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null,
  };
}

/** A form post must come from a page on this same host. Browsers send Origin on POST; Sec-Fetch-Site is the fallback. */
function sameOrigin(m: PublicRequestMeta): boolean {
  if (m.origin) {
    try {
      return Boolean(m.host) && new URL(m.origin).host.toLowerCase() === (m.host as string).toLowerCase();
    } catch {
      return false;
    }
  }
  return m.secFetchSite === "same-origin";
}

export type HostedSubmitResult =
  | { ok: true; status: 200 | 201; org: string; key: string; message: string | null; redirect: string | null; duplicate: boolean }
  | { ok: false; status: number; code: string; message: string; errors?: Record<string, string>; retryAfter?: number };

const NOT_AVAILABLE = "This form isn't available. Check the link with the business that shared it.";

/** A 64-character keyed hash of the visitor's address, kept to spot abuse without storing the address. */
export function submissionIpHash(ip: string | null): string | null {
  const h = hashIp(ip);
  return h ? sha256(`crm-form-ip:${h}`) : null;
}

/**
 * One attempt to send a form: the same answers sent again from the same page load by the same visitor (a double click, a resend after a
 * slow reply) are one submission. `visit` is what makes it that visitor's: the signed form token issued with that page load and the
 * keyed hash of their address. Two visitors who give the same answers (a survey's "Great") are always two submissions.
 */
export function submissionDedupeKey(scope: string, answers: unknown, consent: boolean, marketing: boolean, visit: { token: string; client: string | null }): string {
  return `${scope.slice(0, 120)}:${sha256(`${canonicalJson(answers)}|${consent}|${marketing}|${visit.token.slice(0, 200)}|${visit.client ?? ""}`).slice(0, 48)}`;
}

/**
 * A submission from a hosted form page. In order: same origin, honeypot, the signed time token, the per-visitor limit, the page
 * itself, the per-form limit, then the answers checked against the published version. Nothing the browser says about the form (its
 * questions, wording or actions) is trusted; only its answers are read.
 */
export async function handleHostedSubmit(meta: PublicRequestMeta, raw: RawFields): Promise<HostedSubmitResult> {
  const now = meta.now ?? new Date();
  const org = firstValue(raw, "org").trim().toLowerCase().slice(0, 64);
  const key = firstValue(raw, "key").trim().toLowerCase().slice(0, 48);
  if (!sameOrigin(meta)) return { ok: false, status: 403, code: "forbidden", message: "This form can only be sent from its own page." };
  // A person never sees this field. Whatever filled it gets an ordinary thank-you, and nothing is stored.
  if (firstValue(raw, HONEYPOT_FIELD)) return { ok: true, status: 200, org, key, message: "Thank you.", redirect: null, duplicate: false };
  if (!SLUG.test(org) || !FORM_KEY_RE.test(key)) return { ok: false, status: 404, code: "not_found", message: NOT_AVAILABLE };
  const token = checkFormToken(binding(org, key), firstValue(raw, "t"), now.getTime());
  if (!token.ok) {
    return token.reason === "too_fast"
      ? { ok: false, status: 429, code: "too_fast", message: "That was quick. Please wait a couple of seconds and send it again.", retryAfter: 3 }
      : { ok: false, status: 400, code: "expired", message: "This page has expired. Reload it, then send your answers again." };
  }
  const ipKey = hashIp(meta.ip) ?? "unknown";
  const byIp = await consumeRateLimit(FORM_RATE_LIMITS.submitByIp, ipKey);
  if (!byIp.allowed) return { ok: false, status: 429, code: "rate_limited", message: "We've received a lot of answers from here. Please try again later.", retryAfter: byIp.retryAfterSeconds };

  const target = await readTarget(org, key);
  if (!target) return { ok: false, status: 404, code: "not_found", message: NOT_AVAILABLE };
  const byForm = await consumeRateLimit(FORM_RATE_LIMITS.submitByForm, target.form.id);
  if (!byForm.allowed) return { ok: false, status: 429, code: "rate_limited", message: "This form is very busy right now. Please try again in a little while.", retryAfter: byForm.retryAfterSeconds };

  const v = target.version;
  const check = validateSubmission({ questions: v.fields, consent: v.consent, kind: target.form.kind }, raw, {
    callingCode: target.callingCode,
    visit: { landing: firstValue(raw, "_l") || null, referrer: firstValue(raw, "_r") || null },
    selfHost: meta.host?.replace(/:\d+$/, "") ?? null,
  });
  if (!check.ok) return { ok: false, status: 400, code: "invalid", message: check.message, errors: check.errors };

  const consentText = check.consentGiven ? v.consent.text : null;
  const marketingText = check.marketing ? v.consent.marketing.text : null;
  const ipHash = submissionIpHash(meta.ip);
  const dedupe = submissionDedupeKey(`hosted:${target.form.id}`, check.answers, check.consentGiven, check.marketing, { token: firstValue(raw, "t"), client: ipHash });
  const inserted = await withSystem((db) =>
    db.query<{ id: string }>(
      `insert into crm_form_submissions (org_id, form_id, version_id, source, answers, attribution, consent_text, marketing_opt_in, marketing_text, ip_hash, dedupe_key)
       values ($1, $2, $3, 'hosted', $4, $5, $6, $7, $8, $9, $10)
       on conflict (org_id, dedupe_key) do nothing returning id`,
      [target.orgId, target.form.id, v.id, JSON.stringify(check.answers), JSON.stringify(check.attribution), consentText, check.marketing, marketingText, ipHash, dedupe],
    ),
  );
  const after = v.actions.after;
  return {
    ok: true, status: inserted.rows[0] ? 201 : 200, org: target.business.slug, key: target.form.key, duplicate: !inserted.rows[0],
    message: after.kind === "message" ? after.message : null, redirect: after.kind === "redirect" ? after.url : null,
  };
}
