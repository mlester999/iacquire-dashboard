// Pure rules for the embeddable website chat. No I/O: the same code decides on the server and is easy to test.
import { normalizeEmail, normalizePhone } from "@/lib/messaging";

// ---------------------------------------------------------------------------
// Where the widget may run
// ---------------------------------------------------------------------------

export const MAX_ALLOWED_ORIGINS = 20;

/** A host name label: letters, digits and hyphens, not starting or ending with a hyphen. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const isIpv4 = (h: string) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(h);

/**
 * One allowed site as the owner typed it: "www.example.com", "https://www.Example.com/contact", or "*.example.com" (any one-level subdomain).
 * Reduced to a lower-case host. Anything that is not a public host name is refused: IP addresses, ports, paths with meaning, and wildcards that
 * would cover a whole top-level domain ("*.com").
 */
export function normalizeAllowedHost(raw: string): { ok: true; host: string } | { ok: false; error: string } {
  let s = raw.trim().toLowerCase();
  if (!s) return { ok: false, error: "Enter a website address." };
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) {
    try {
      const u = new URL(s);
      if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, error: "Use the website's https address." };
      s = u.hostname;
    } catch {
      return { ok: false, error: "That is not a valid website address." };
    }
  } else {
    s = s.replace(/\/.*$/, "").replace(/:\d{1,5}$/, "");
  }
  s = s.replace(/\.$/, "");
  if (s.length > 253) return { ok: false, error: "That address is too long." };
  if (s === "localhost" || s.endsWith(".localhost")) return { ok: true, host: s };
  if (isIpv4(s) || s.includes(":")) return { ok: false, error: "Use a website name, not an IP address." };
  const wildcard = s.startsWith("*.");
  const body = wildcard ? s.slice(2) : s;
  const labels = body.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return { ok: false, error: "That is not a valid website address." };
  // A wildcard needs a registrable name behind it ("*.example.com"), never a bare top-level domain.
  if (wildcard && labels.length < 2) return { ok: false, error: "A wildcard needs a full domain, such as *.example.com." };
  return { ok: true, host: s };
}

export function normalizeAllowedHosts(list: string[]): { ok: true; hosts: string[] } | { ok: false; error: string } {
  const out: string[] = [];
  for (const raw of list) {
    if (!raw.trim()) continue;
    const r = normalizeAllowedHost(raw);
    if (!r.ok) return { ok: false, error: `${raw.trim()}: ${r.error}` };
    if (!out.includes(r.host)) out.push(r.host);
  }
  if (out.length > MAX_ALLOWED_ORIGINS) return { ok: false, error: `At most ${MAX_ALLOWED_ORIGINS} websites can be allowed.` };
  return { ok: true, hosts: out };
}

/** The host of an Origin header ("https://www.example.com"), or null when it is absent, "null" or not an http(s) origin. */
export function hostFromOrigin(origin: string | null | undefined): string | null {
  if (!origin) return null;
  try {
    const u = new URL(origin);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.hostname.toLowerCase().replace(/\.$/, "") || null;
  } catch {
    return null;
  }
}

/**
 * Whether a browser page on `host` may use the widget. `patterns` are the owner's allowed sites; `siteHosts` are the workspace's own Website Studio
 * hosts, which are allowed when the widget installs itself on them. A wildcard "*.example.com" matches "a.example.com" but neither "example.com"
 * nor "a.b.example.com": the owner lists what they own.
 */
export function isHostAllowed(host: string | null, patterns: readonly string[], siteHosts: readonly string[] = []): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  if (siteHosts.some((s) => s.toLowerCase() === h)) return true;
  for (const p of patterns) {
    if (p === h) return true;
    if (p.startsWith("*.") && h.endsWith(p.slice(1)) && !h.slice(0, h.length - (p.length - 1)).includes(".") && h.length > p.length - 1) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Widget settings
// ---------------------------------------------------------------------------

export const WIDGET_KEY_PATTERN = /^wk_[A-Za-z0-9]{24}$/;

export const KNOWLEDGE_SECTION_KEYS = ["business_description", "products_services", "faq", "approved_pricing", "business_hours", "policies", "customer_service", "brand_voice", "escalation"] as const;
export type KnowledgeSectionKey = (typeof KNOWLEDGE_SECTION_KEYS)[number];
/** What an anonymous visitor's assistant may use unless the owner adds more. Prices are a deliberate opt-in. */
export const DEFAULT_WIDGET_KNOWLEDGE: readonly KnowledgeSectionKey[] = ["business_description", "products_services", "faq", "business_hours", "policies", "brand_voice"];

export const WIDGET_POSITIONS = ["bottom-right", "bottom-left"] as const;
export const LEAD_FORM_MODES = ["never", "offer", "required"] as const;
export const OFFLINE_BEHAVIORS = ["ai_answers", "leave_message"] as const;
export const WIDGET_AI_ROLES = ["sales_assistant", "appointment_setter"] as const;

export interface QualificationQuestion {
  key: string;
  label: string;
  kind: "text" | "choice";
  choices?: string[];
  required: boolean;
}

export const MAX_QUALIFICATION_QUESTIONS = 3;

/** Reads the questions the owner configured. Anything malformed is an error (never silently dropped), so what is saved is what visitors see. */
export function validateQualificationQuestions(raw: unknown): { ok: true; questions: QualificationQuestion[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: "Questions must be a list." };
  if (raw.length > MAX_QUALIFICATION_QUESTIONS) return { ok: false, error: `At most ${MAX_QUALIFICATION_QUESTIONS} questions.` };
  const keys = new Set<string>();
  const out: QualificationQuestion[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return { ok: false, error: "A question is not valid." };
    const q = item as Record<string, unknown>;
    const label = typeof q.label === "string" ? q.label.replace(/[\u0000-\u001F\u007F]/g, " ").trim() : "";
    if (label.length < 2 || label.length > 120) return { ok: false, error: "Each question needs a label of 2 to 120 characters." };
    const key = typeof q.key === "string" && /^[a-z][a-z0-9_]{1,30}$/.test(q.key) ? q.key : label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^[^a-z]+/, "q").slice(0, 31) || "question";
    if (keys.has(key)) return { ok: false, error: "Two questions have the same key." };
    keys.add(key);
    const kind = q.kind === "choice" ? "choice" : "text";
    let choices: string[] | undefined;
    if (kind === "choice") {
      const list = Array.isArray(q.choices) ? q.choices.filter((c): c is string => typeof c === "string").map((c) => c.replace(/[\u0000-\u001F\u007F]/g, " ").trim()).filter(Boolean) : [];
      if (list.length < 2 || list.length > 8 || list.some((c) => c.length > 60)) return { ok: false, error: "A choice question needs 2 to 8 choices of up to 60 characters." };
      choices = [...new Set(list)];
    }
    out.push({ key, label, kind, ...(choices ? { choices } : {}), required: q.required === true });
  }
  return { ok: true, questions: out };
}

/** The answers a visitor gave, kept only for questions that exist, with choices checked against the list. Unknown keys and bad choices are dropped. */
export function cleanQualificationAnswers(questions: readonly QualificationQuestion[], raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof raw !== "object" || raw === null) return out;
  for (const q of questions) {
    const v = (raw as Record<string, unknown>)[q.key];
    if (typeof v !== "string") continue;
    const text = visitorText(v, 300);
    if (!text) continue;
    if (q.kind === "choice" && !q.choices?.includes(text)) continue;
    out[q.key] = text;
  }
  return out;
}

/** Every required question has an answer, and at least one question exists. */
export function qualificationComplete(questions: readonly QualificationQuestion[], answers: Record<string, string>): boolean {
  if (!questions.length) return false;
  return questions.filter((q) => q.required).every((q) => Boolean(answers[q.key])) && questions.some((q) => Boolean(answers[q.key]));
}

// ---------------------------------------------------------------------------
// What a visitor sends
// ---------------------------------------------------------------------------

export const VISITOR_LIMITS = { message: 1000, name: 120, email: 254, phone: 32, answer: 300 } as const;

/**
 * A visitor's text: control characters removed, runs of blank lines collapsed, trimmed, capped. Returns null for nothing left. Markup is not
 * interpreted anywhere (the widget and the Inbox render text), so it is kept as typed.
 */
export function visitorText(raw: unknown, max: number = VISITOR_LIMITS.message): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/g, "").replace(/\n{3,}/g, "\n\n").trim();
  return t ? t.slice(0, max) : null;
}

export interface VisitorDetails {
  name: string | null;
  email: string | null;
  phone: string | null;
}

/** Details typed into the lead form, normalized. At least a usable email or phone is required for a lead. */
export function readVisitorDetails(raw: { name?: unknown; email?: unknown; phone?: unknown }, defaultCallingCode?: string): { ok: true; details: VisitorDetails } | { ok: false; error: string } {
  // A name is one line: runs of spaces and any line breaks collapse to single spaces.
  const name = visitorText(raw.name, VISITOR_LIMITS.name)?.replace(/\s+/g, " ") ?? null;
  const emailIn = typeof raw.email === "string" ? raw.email.trim() : "";
  const phoneIn = typeof raw.phone === "string" ? raw.phone.trim() : "";
  const email = emailIn ? normalizeEmail(emailIn) : null;
  const phone = phoneIn ? normalizePhone(phoneIn, defaultCallingCode) : null;
  if (emailIn && !email) return { ok: false, error: "That email address does not look right." };
  if (phoneIn && !phone) return { ok: false, error: "That phone number does not look right. Include the country code." };
  if (!email && !phone) return { ok: false, error: "Add an email address or a phone number so the team can reach you." };
  return { ok: true, details: { name, email, phone } };
}

// ---------------------------------------------------------------------------
// What the visit carried (attribution), kept as the visit reported it
// ---------------------------------------------------------------------------

/** The page path and query the visitor is on, as the widget reports it. Only the path and the known marketing parameters are kept. */
export function readLandingVisit(landing: unknown, referrer: unknown, selfHost: string | null): { landingPath: string | null; referrer: string | null; attribution: Record<string, string> } {
  const attribution: Record<string, string> = {};
  let landingPath: string | null = null;
  if (typeof landing === "string" && landing.startsWith("/") && !landing.startsWith("//")) {
    try {
      const u = new URL(landing.slice(0, 1000), "https://visit.invalid");
      landingPath = (u.pathname.replace(/[\u0000-\u001F\u007F]/g, "").slice(0, 300)) || "/";
      attribution.landing_page = landingPath;
      for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid", "msclkid"]) {
        const v = (u.searchParams.get(k) ?? "").replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, 200);
        if (v) attribution[k] = v;
      }
    } catch {
      /* an unreadable address records nothing */
    }
  }
  let ref: string | null = null;
  if (typeof referrer === "string" && referrer) {
    try {
      const u = new URL(referrer.slice(0, 1000));
      if ((u.protocol === "https:" || u.protocol === "http:") && u.hostname && u.hostname.toLowerCase() !== (selfHost ?? "").toLowerCase()) {
        ref = `${u.protocol}//${u.host}${u.pathname}`.slice(0, 300);
        attribution.referrer = ref;
      }
    } catch {
      /* not a web address: nothing is recorded */
    }
  }
  return { landingPath, referrer: ref, attribution };
}

// ---------------------------------------------------------------------------
// Opaque identifiers
// ---------------------------------------------------------------------------

/** The widget key is public: it names a widget, it opens nothing by itself. */
export const isWidgetKey = (v: unknown): v is string => typeof v === "string" && WIDGET_KEY_PATTERN.test(v);
/** A visitor's session token: 43 base64url characters (32 random bytes). */
export const isSessionToken = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v);
/** A client-chosen id that makes a visitor's send safe to retry. */
export const isClientMessageId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(v);

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

/** The snippet an owner pastes before </body>. It carries the public key only; nothing secret is ever in it. */
export function embedSnippet(input: { appOrigin: string; key: string }): string {
  const origin = input.appOrigin.replace(/\/+$/, "");
  return `<script src="${origin}/widget/chat.js" data-key="${input.key}" async></script>`;
}

export type InstallState = "disabled" | "no_sites" | "waiting" | "installed";

/** Where installation stands, from evidence only: the widget has loaded from an allowed site, or it has not. */
export function installState(input: { enabled: boolean; allowedHostCount: number; autoInstalledSites: number; lastSeenAt: Date | null }): InstallState {
  if (!input.enabled) return "disabled";
  if (input.allowedHostCount === 0 && input.autoInstalledSites === 0) return "no_sites";
  return input.lastSeenAt ? "installed" : "waiting";
}

export const INSTALL_STATE_LABELS: Record<InstallState, string> = {
  disabled: "Switched off",
  no_sites: "No website added yet",
  waiting: "Waiting for the first visit",
  installed: "Seen on your website",
};
