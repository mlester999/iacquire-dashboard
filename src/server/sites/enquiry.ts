import "server-only";
import crypto from "node:crypto";
import { normalizeEmail } from "@/lib/messaging";
import { eachElement } from "@/lib/website/doc";
import { checkFormToken, hashClient } from "@/server/sites/form-token";
import { resolveSite, siteRateLimit, submitSiteForm } from "@/server/sites/runtime";
import { collectFields } from "@/lib/crm/forms/logic";
import { NATIVE_FORM_MARKER } from "@/lib/crm/forms/website";
import { handleSiteCrmForm } from "@/server/crm/forms/site";

// The public enquiry endpoint's decisions, separated from the HTTP wiring so they can be tested directly.

export interface EnquiryRequest {
  host: string;
  origin: string | null;
  secFetchSite: string | null;
  forwardedFor: string | null;
  referer: string | null;
  fields: Record<string, string>;
  /** Every posted value in order, repeated names kept (a native form's multiple-choice answers). The built-in form reads `fields`. */
  entries?: Array<[string, string]>;
  now?: number;
}

/** The form key a published form element names, or "" for the built-in enquiry form. Read from the published site only. */
function nativeFormKey(content: Parameters<typeof eachElement>[0], elementId: string): string {
  let key = "";
  eachElement(content, (e) => {
    if (e.type === "form" && e.id === elementId && typeof e.props.formKey === "string") key = e.props.formKey.trim();
  });
  return key;
}
export type EnquiryResult = { kind: "redirect"; to: string } | { kind: "error"; status: number; message: string };

const fail = (status: number, message: string): EnquiryResult => ({ kind: "error", status, message });
const clip = (s: string | undefined, n: number) => (s ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, n);

function sameSite(host: string, origin: string | null, secFetchSite: string | null): boolean {
  if (origin) {
    try {
      return new URL(origin).hostname.toLowerCase() === host;
    } catch {
      return false;
    }
  }
  return secFetchSite === "same-origin";
}

function utmFrom(referer: string | null): Record<string, string> {
  if (!referer) return {};
  try {
    const out: Record<string, string> = {};
    for (const [k, v] of new URL(referer).searchParams) if (/^utm_[a-z]{3,12}$/.test(k) && Object.keys(out).length < 5) out[k] = v.slice(0, 80);
    return out;
  } catch {
    return {};
  }
}

export async function handleEnquiry(req: EnquiryRequest): Promise<EnquiryResult> {
  const site = await resolveSite(req.host);
  if (!site) return fail(404, "This site isn't available.");
  if (!sameSite(req.host, req.origin, req.secFetchSite)) return fail(403, "This form can only be sent from the website itself.");
  const f = req.fields;

  // A real visitor never sees this field. A bot that fills every field gets a success page and nothing is stored.
  if (clip(f.company_website, 200)) return { kind: "redirect", to: "/thanks" };

  const token = checkFormToken(req.host, f.t, req.now);
  if (!token.ok) {
    return token.reason === "too_fast" ? fail(429, "That was quick. Please wait a couple of seconds and send it again.") : fail(400, "This form has expired. Go back, reload the page and try again.");
  }

  const ip = clip((req.forwardedFor ?? "").split(",")[0], 64) || "unknown";
  const client = hashClient(ip);
  if (!(await siteRateLimit(`form:ip:${client}`, 8, 600)) || !(await siteRateLimit(`form:host:${req.host}`, 150, 3600))) {
    return fail(429, "We've received a lot of messages from here. Please try again later.");
  }

  // A native CRM form: the published element names it by key, and the page drew it (its marker carries that same key). Its answers are
  // checked against the form's published version (src/server/crm/forms/site.ts); the built-in form's rules below don't apply to it.
  const nativeKey = nativeFormKey(site.content, clip(f.e, 40));
  if (nativeKey && clip(f[NATIVE_FORM_MARKER], 60) === nativeKey) {
    const raw = req.entries ? collectFields(req.entries) : new Map(Object.entries(f).map(([k, v]) => [k, [v]]));
    return handleSiteCrmForm({ site, host: req.host, formKey: nativeKey, pageSlug: clip(f.p, 200) || "home", raw, referer: req.referer, clientHash: client, now: req.now });
  }

  const cfg = site.content.form;
  if (!cfg.enabled) return fail(400, "This site isn't taking enquiries right now.");
  // The form's own settings come from the published site, found by the id the form carried; nothing the browser says about them is trusted.
  let formProps: Record<string, unknown> | null = null;
  eachElement(site.content, (e) => {
    if (e.type === "form" && e.id === clip(f.e, 40)) formProps = e.props;
  });
  const props = formProps as Record<string, unknown> | null;
  const modeOf = (k: "phone" | "message" | "service") => {
    const v = props?.[k];
    return (v === "required" || v === "optional" || v === "hidden" ? v : cfg.fields[k]) as "required" | "optional" | "hidden";
  };
  const own = Array.isArray(props?.services) && (props!.services as unknown[]).length ? (props!.services as string[]) : cfg.services;
  const purposeRaw = String(props?.purpose ?? "contact");
  const purpose = (["contact", "consultation", "lead", "appointment"].includes(purposeRaw) ? purposeRaw : "contact") as "contact" | "consultation" | "lead" | "appointment";
  const name = clip(f.name, 120);
  const email = clip(f.email, 320).toLowerCase();
  const phone = clip(f.phone, 30);
  const message = clip(f.message, 2000);
  const service = clip(f.service, 60);
  if (name.length < 2) return fail(400, "Please enter your name.");
  if (!normalizeEmail(email)) return fail(400, "Please enter a valid email address.");
  if (modeOf("phone") === "required" && phone.replace(/\D/g, "").length < 7) return fail(400, "Please enter a phone number.");
  if (phone && !/^[0-9+()\-.\s]{7,30}$/.test(phone)) return fail(400, "That phone number doesn't look right.");
  if (modeOf("message") === "required" && message.length < 2) return fail(400, "Please tell us how we can help.");
  if (modeOf("service") === "required" && !service) return fail(400, "Please choose what you need.");
  if (service && !own.includes(service)) return fail(400, "Please choose one of the options.");
  if (f.consent !== "yes") return fail(400, "Please tick the box to agree to be contacted.");

  const day = new Date(req.now ?? Date.now()).toISOString().slice(0, 10);
  const dedupe = crypto.createHash("sha256").update(`${req.host}|${email}|${phone.replace(/\D/g, "")}|${message}|${day}`).digest("hex").slice(0, 40);
  const result = await submitSiteForm({
    host: req.host, page: clip(f.p, 40) || "home", name, email, phone, service, message, consent: true, marketing: cfg.marketingOptIn && f.marketing === "yes",
    consentText: cfg.consentText, ipHash: client, utm: utmFrom(req.referer), referrer: "", dedupe, purpose, formId: clip(f.e, 40) || undefined,
  });
  switch (result.status) {
    case "ok":
    case "duplicate":
      return { kind: "redirect", to: "/thanks" };
    case "consent_required":
      return fail(400, "Please tick the box to agree to be contacted.");
    case "disabled":
      return fail(400, "This site isn't taking enquiries right now.");
    default:
      return fail(404, "This site isn't available.");
  }
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const errorPage = (message: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Message not sent</title></head>` +
  `<body style="font-family:ui-sans-serif,system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f8f9fb;color:#101828;padding:1.5rem"><main style="max-width:28rem;text-align:center">` +
  `<h1 style="font-size:1.4rem;margin:0 0 .75rem">We couldn't send that</h1><p style="margin:0 0 1.25rem;color:#475467">${esc(message)}</p><a href="/" style="color:#1d3fd0;font-weight:600">Back to the website</a></main></body></html>`;
