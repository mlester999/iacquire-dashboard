// Text coming from GoHighLevel, made safe for a Blueprint: HTML becomes plain text, names lose markup and anything that looks like a record
// ID, and message tokens are rewritten into iAcquire's own tokens. Pure.
//
// The result is always checked with the Blueprint contract's own scanner (validate.ts → scanText), so whatever this file lets through is
// held to exactly the rules a saved Blueprint is.
import { scanText, type ContentFinding } from "@/lib/crm/blueprints/validate";
import type { TokenKey } from "@/lib/messaging/tokens";

// ---------------------------------------------------------------------------
// HTML → plain text
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
  copy: "©", reg: "®", trade: "™", bull: "•", middot: "·", euro: "€", pound: "£", cent: "¢", deg: "°",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return "";
      return String.fromCodePoint(n);
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? whole;
  });
}

const BLOCK_CLOSE = /<\/(p|div|h[1-6]|li|tr|table|tbody|thead|section|article|header|footer|blockquote|ul|ol|center|td|th)\s*>/gi;
const BLOCK_OPEN = /<(p|div|h[1-6]|tr|table|section|article|header|footer|blockquote|ul|ol|center)(\s[^>]*)?>/gi;
const TAG = /<\/?[a-z][a-z0-9:-]*(\s[^<>]*)?\/?>/gi;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * Plain text from email HTML: scripts, styles and the document head are removed with their content, block elements become line breaks,
 * list items bullets, links "text (https://…)" (only http/https links are kept), every other tag disappears, entities are decoded, and
 * markup that was hidden in entities ("&lt;script&gt;") is removed after decoding too. Whitespace is tidied.
 */
export function htmlToText(html: string): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(script|style|head|title|noscript|template|svg|iframe|object|embed|xml)\b[\s\S]*?<\/\1\s*>/gi, " ");
  s = s.replace(/<(script|style|head|title|noscript|template|svg|iframe|object|embed|xml)\b[^>]*>/gi, " ");
  s = s.replace(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi, (_w, d: string, q: string, b: string, inner: string) => {
    const url = decodeEntities((d ?? q ?? b ?? "").trim());
    const label = decodeEntities(inner.replace(TAG, " ")).replace(/\s+/g, " ").trim();
    if (!/^https?:\/\/[^\s<>"']+$/i.test(url)) return label;
    if (!label || label === url) return ` ${url} `;
    return `${label} (${url})`;
  });
  s = s.replace(/<br\s*\/?>/gi, "\n").replace(/<li(\s[^>]*)?>/gi, "\n• ").replace(BLOCK_CLOSE, "\n").replace(BLOCK_OPEN, "\n").replace(/<hr\b[^>]*>/gi, "\n");
  s = s.replace(TAG, "");
  s = decodeEntities(s);
  // Markup that was written as entities is still markup once decoded: remove it as well.
  s = s.replace(TAG, "").replace(/<\s*\/?\s*(script|style|iframe|object|embed)\b[^>]*>?/gi, "");
  s = s.replace(CONTROL, "").replace(/\r\n?/g, "\n").replace(/[ \t\f\v ]+/g, " ");
  s = s.split("\n").map((l) => l.trim()).join("\n").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

// ---------------------------------------------------------------------------
// Names and short texts
// ---------------------------------------------------------------------------

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
/** The same shapes validate.ts treats as GoHighLevel IDs (20 mixed letters and digits, or 24 hex characters). */
const GHL_ID = /\b(?=[A-Za-z0-9]{20}\b)(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[a-z])(?=[A-Za-z0-9]*[A-Z])[A-Za-z0-9]{20}\b|\b[0-9a-f]{24}\b/g;
/** Links into GoHighLevel itself (booking widgets, trigger links, hosted pages) only work in that account and usually carry its IDs. */
const GHL_LINK = /\bhttps?:\/\/[^\s<>"')]*(?:leadconnectorhq\.com|msgsndr\.com|gohighlevel\.com|highlevel\.com|leadconnector\.com|clickfunnels-free\.com)[^\s<>"')]*/gi;

export interface CleanText {
  /** Null when nothing safe was left. */
  text: string | null;
  /** What was changed, in plain words (for the import report). */
  notes: string[];
  /** Findings that made the text unusable (code, a credential). */
  blocked: ContentFinding[];
}

/**
 * A short text (a name, a description, a message) made safe: HTML stripped, IDs and GoHighLevel links removed, control characters gone,
 * whitespace collapsed (to one line when `singleLine`), then cut to `max`. If the contract's scanner still finds code or a credential, the
 * text is refused (null). Personal details are left for the validator to warn about.
 */
export function cleanText(raw: string | null | undefined, max: number, opts: { singleLine?: boolean; what?: string } = {}): CleanText {
  const notes: string[] = [];
  if (!raw || !raw.trim()) return { text: null, notes, blocked: [] };
  let s = /<[a-z!/]/i.test(raw) ? htmlToText(raw) : raw.replace(CONTROL, "");
  const what = opts.what ?? "text";
  const before = s;
  s = s.replace(GHL_LINK, "[GoHighLevel link]");
  if (s !== before) notes.push(`A link into GoHighLevel in the ${what} was replaced with “[GoHighLevel link]”: it only works inside that GoHighLevel account.`);
  const beforeIds = s;
  s = s.replace(UUID, "").replace(GHL_ID, "");
  if (s !== beforeIds) notes.push(`A record ID in the ${what} was removed.`);
  s = opts.singleLine ? s.replace(/\s+/g, " ") : s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
  s = s.trim();
  if (s.length > max) {
    s = s.slice(0, max).trimEnd();
    notes.push(`The ${what} was shortened to ${max} characters.`);
  }
  if (!s) return { text: null, notes, blocked: [] };
  const blocked = scanText(s).filter((f) => f.kind === "unsafe" || f.kind === "secret" || f.kind === "ghl_id" || f.kind === "database_id");
  if (blocked.length) return { text: null, notes, blocked };
  return { text: s, notes, blocked: [] };
}

/** A one-line name, or `fallback` when nothing safe is left. */
export function cleanName(raw: string | null | undefined, max: number, fallback: string): { name: string; notes: string[] } {
  const c = cleanText(raw, max, { singleLine: true, what: "name" });
  if (c.text) return { name: c.text, notes: c.notes };
  return { name: fallback.slice(0, max), notes: [...c.notes, `Its name couldn't be used as it was, so it was named “${fallback.slice(0, max)}”.`] };
}

// ---------------------------------------------------------------------------
// Message tokens
// ---------------------------------------------------------------------------

/**
 * GoHighLevel merge fields with an exact iAcquire equivalent. These come from GoHighLevel's own merge-field naming ({{contact.first_name}},
 * {{location.name}}, {{appointment.start_time}} …); the OpenAPI specs don't list merge fields, so anything not here is reported, never guessed.
 */
export const GHL_TOKEN_MAP: Readonly<Record<string, TokenKey>> = {
  "contact.first_name": "contact.first_name",
  "contact.last_name": "contact.last_name",
  "contact.name": "contact.full_name",
  "contact.full_name": "contact.full_name",
  "contact.email": "contact.email",
  "contact.phone": "contact.phone",
  "location.name": "business.name",
  "location.phone": "business.phone",
  "location.email": "business.email",
  "location.website": "business.website",
  "user.first_name": "user.first_name",
  "appointment.start_date": "appointment.date",
  "appointment.only_start_date": "appointment.date",
  "appointment.start_time": "appointment.time",
  "appointment.only_start_time": "appointment.time",
  "appointment.meeting_location": "appointment.location",
  "appointment.reschedule_link": "appointment.manage_link",
  "appointment.cancellation_link": "appointment.manage_link",
  "calendar.name": "appointment.type",
};

export interface TokenContext {
  /** GoHighLevel custom value key (lower-case, as written after "custom_values.") → the imported value's logical ID and iAcquire key. */
  values: ReadonlyMap<string, { id: string; key: string }>;
  /** GoHighLevel custom field key ("contact.budget", lower-case) → the imported field's logical ID and label. */
  fields: ReadonlyMap<string, { id: string; label: string }>;
}

export interface TokenConversion {
  text: string;
  /** Tokens rewritten to an iAcquire token. */
  mapped: string[];
  /** Configuration values the text now uses (logical IDs). */
  values: string[];
  /** Custom fields the text used (logical IDs). iAcquire templates have no custom field tokens, so each became a marker to review. */
  fields: Array<{ id: string; token: string; marker: string }>;
  /** Tokens with no iAcquire equivalent, as written. Each became a visible marker. */
  unknown: string[];
  /** Template logic iAcquire doesn't run ({% … %}) was removed. */
  removedLogic: boolean;
}

/** A GoHighLevel custom value key as written in a token or a fieldKey, normalized for lookup. */
export const ghlValueKey = (raw: string) => raw.trim().toLowerCase();
/** The key inside "{{ custom_values.booking_link }}" (or a bare "custom_values.booking_link"). */
export function ghlValueKeyOf(fieldKey: string): string | null {
  const m = /custom_values\.([A-Za-z0-9_-]{1,80})/.exec(fieldKey ?? "");
  return m ? ghlValueKey(m[1]) : null;
}

// The capture is trimmed in code: a \s* beside [^{}]* made a long run of spaces take minutes to scan.
const TOKEN = /\{\{([^{}]*)\}\}/g;
const markerFor = (inner: string) => `[${inner.replace(/[^A-Za-z0-9 ._-]/g, "").trim().slice(0, 60) || "merge field"}]`;

/**
 * Rewrites GoHighLevel merge fields into iAcquire tokens. Custom value tokens point at the imported configuration value (by its iAcquire
 * key). Custom field tokens and anything without an exact equivalent become a visible "[…]" marker, so nothing is ever sent as a raw
 * placeholder and a person sees exactly what to fix. Template logic ({% … %}) and stray braces are removed.
 */
export function convertGhlTokens(text: string, ctx: TokenContext): TokenConversion {
  const out: TokenConversion = { text: "", mapped: [], values: [], fields: [], unknown: [], removedLogic: false };
  let s = text;
  if (/\{%[\s\S]*?%\}/.test(s)) {
    s = s.replace(/\{%[\s\S]*?%\}/g, "");
    out.removedLogic = true;
  }
  // iAcquire tokens written here are held aside while stray braces are removed, then put back.
  const written: string[] = [];
  const keep = (token: string) => `\u0001${written.push(token) - 1}\u0002`;
  s = s.replace(TOKEN, (raw, innerRaw: string) => {
    const inner = innerRaw.trim();
    const lower = inner.toLowerCase();
    const builtIn = GHL_TOKEN_MAP[lower];
    if (builtIn) {
      if (!out.mapped.includes(lower)) out.mapped.push(lower);
      return keep(`{{${builtIn}}}`);
    }
    const valueKey = /^custom_values\.[a-z0-9_-]+$/i.test(inner) ? ghlValueKey(inner.slice("custom_values.".length)) : null;
    if (valueKey !== null) {
      const v = ctx.values.get(valueKey);
      if (v) {
        if (!out.values.includes(v.id)) out.values.push(v.id);
        return keep(`{{custom_values.${v.key}}}`);
      }
    }
    const field = /^(contact|opportunity)\.[a-z0-9_]+$/i.test(inner) ? ctx.fields.get(lower) : undefined;
    if (field) {
      const marker = `[${field.label}]`;
      if (!out.fields.some((f) => f.token === raw)) out.fields.push({ id: field.id, token: raw, marker });
      return marker;
    }
    if (!out.unknown.includes(raw)) out.unknown.push(raw);
    return markerFor(inner);
  });
  // Anything brace-like that is left is not a token iAcquire can fill.
  if (/\{\{|\}\}/.test(s)) {
    s = s.replace(/\{\{|\}\}/g, "");
    if (!out.unknown.includes("{{ }}")) out.unknown.push("{{ }}");
  }
  out.text = s.replace(/\u0001(\d+)\u0002/g, (_m, i: string) => written[Number(i)] ?? "");
  return out;
}
