// Message template tokens: the catalog, a validator for saving a template, and the renderer used before anything is sent.
// Pure (no I/O), so the server, the template editor and the inbox composer all apply exactly the same rules.
//
// Rules that hold everywhere:
//   * A token is written {{group.name}}, for example {{contact.first_name}}. Only the tokens in TEMPLATE_TOKENS exist.
//   * Saving a template with an unknown token is an error (validateTemplate), so a typo never reaches a customer.
//   * renderTemplate never leaves a raw {{…}} in its output. A token without a value is reported in `missing`, so the caller can refuse
//     to send and say exactly what is missing, instead of sending "Hi {{contact.first_name}}" or a silently blank greeting.
//
// Provider limits used here were checked against the providers' own published contracts (see docs/messaging-providers.md, package E):
//   * Twilio Messages API (twilio/twilio-oai, POST /2010-04-01/Accounts/{AccountSid}/Messages.json, `Body`): "Can be up to 1,600 characters
//     in length"; more than 160 GSM-7 characters (or 70 UCS-2) is segmented and charged per segment.
//   * Meta WhatsApp Cloud API text messages (`text.body`): maximum 4096 characters. Template BODY components: maximum 1024 characters.
//   * Resend POST /emails (resend/resend-openapi): `subject` is required.
import { smsSegments, type Channel } from "@/lib/messaging";
import { reviewIncentiveFindings } from "@/lib/reputation/incentives";

export type TokenGroup = "contact" | "business" | "user" | "appointment" | "review";

export interface TokenDef {
  key: string;
  group: TokenGroup;
  /** Short label for pickers ("First name"). */
  label: string;
  /** How the token reads in a sentence about what is missing ("the contact's first name"). */
  phrase: string;
  /** An obviously fictional value for previews and length estimates. */
  sample: string;
}

export const TEMPLATE_TOKENS = [
  { key: "contact.first_name", group: "contact", label: "First name", phrase: "the contact's first name", sample: "Maria" },
  { key: "contact.last_name", group: "contact", label: "Last name", phrase: "the contact's last name", sample: "Santos" },
  { key: "contact.full_name", group: "contact", label: "Full name", phrase: "the contact's full name", sample: "Maria Santos" },
  { key: "contact.email", group: "contact", label: "Email", phrase: "the contact's email address", sample: "maria.santos@example.com" },
  { key: "contact.phone", group: "contact", label: "Phone", phrase: "the contact's phone number", sample: "+15555550123" },
  { key: "business.name", group: "business", label: "Business name", phrase: "your business name", sample: "Your Business" },
  { key: "business.phone", group: "business", label: "Business phone", phrase: "your business phone number", sample: "+15555550100" },
  { key: "business.email", group: "business", label: "Business email", phrase: "your business email address", sample: "hello@example.com" },
  { key: "business.website", group: "business", label: "Website", phrase: "your website address", sample: "https://www.example.com" },
  { key: "user.first_name", group: "user", label: "Sender's first name", phrase: "the sender's first name", sample: "Alex" },
  { key: "appointment.date", group: "appointment", label: "Appointment date", phrase: "the appointment date", sample: "Tuesday, 21 October" },
  { key: "appointment.time", group: "appointment", label: "Appointment time", phrase: "the appointment time", sample: "10:30 AM" },
  { key: "appointment.type", group: "appointment", label: "Appointment type", phrase: "the appointment type", sample: "Consultation" },
  { key: "appointment.location", group: "appointment", label: "Appointment location", phrase: "the appointment location", sample: "123 Example Street" },
  { key: "appointment.manage_link", group: "appointment", label: "Reschedule or cancel link", phrase: "the link to manage the appointment", sample: "https://www.example.com/manage/sample" },
  // Only a review request has a value for it (its own private link, issued when the request is queued); anywhere else it is missing.
  { key: "review.link", group: "review", label: "Review request link", phrase: "the review request link", sample: "https://www.example.com/r/sample" },
] as const satisfies readonly TokenDef[];

export type TokenKey = (typeof TEMPLATE_TOKENS)[number]["key"];
export const TOKEN_KEYS: readonly TokenKey[] = TEMPLATE_TOKENS.map((t) => t.key);
const BY_KEY = new Map<string, TokenDef>(TEMPLATE_TOKENS.map((t) => [t.key, t]));

export const TOKEN_GROUP_LABELS: Record<TokenGroup, string> = { contact: "Contact", business: "Your business", user: "Sender", appointment: "Appointment", review: "Review request" };

/**
 * What previews show for {{review.link}} with a real contact: the customer's own private link is only created when a review request is
 * sent to them. Previews only; nothing is ever sent with it.
 */
export const REVIEW_LINK_PREVIEW = "[review link]";

export const isTokenKey = (v: unknown): v is TokenKey => typeof v === "string" && BY_KEY.has(v);
export const tokenDef = (key: string): TokenDef | undefined => BY_KEY.get(key);

// ---------------------------------------------------------------------------
// Configuration values: {{custom_values.<key>}}
// ---------------------------------------------------------------------------
//
// A workspace defines its own values (a booking link, an office address, a promo code) in CRM Settings → Configuration Values, and templates
// use them as {{custom_values.<key>}}. Which keys exist differs per workspace, so these tokens aren't in TEMPLATE_TOKENS: the validator is
// given the workspace's values and accepts only those keys, and the renderer fills them like any other token.
//
// Rendering rules: a value with text is filled; an empty optional value renders as nothing (it isn't missing); an empty REQUIRED value is
// reported in `missing`, so a send is refused with a clear reason. Values handed to the renderer follow the same rule when no definitions
// are given (see customValueTokenValues): required values that are empty are left out, so they count as missing.

/** The prefix of every configuration value token. */
export const CUSTOM_VALUE_PREFIX = "custom_values.";
/** A configuration value's key: the same rule as crm_custom_values.key. */
export const CUSTOM_VALUE_KEY_RE = /^[a-z][a-z0-9_]{0,47}$/;
export const CUSTOM_VALUES_GROUP_LABEL = "Configuration values";

export type CustomValueTokenKey = `custom_values.${string}`;
/** A built-in token or a configuration value token. */
export type AnyTokenKey = TokenKey | CustomValueTokenKey;

/** What templates need to know about one of the workspace's configuration values. */
export interface CustomValueTokenDef {
  /** The key without the prefix ("booking_link"). */
  key: string;
  label: string;
  /** The business must fill it in before messages that use it can be sent. */
  required: boolean;
  group?: string | null;
  /** The current value, for previews and length estimates. Never needed for validation. */
  value?: string | null;
}

/** The workspace's configuration values as given to the validator or renderer: definitions, or just the keys. */
export type CustomValueCatalog = ReadonlyArray<CustomValueTokenDef | string>;

/** The key inside a configuration value token, or null when the text isn't one. */
export function customValueKeyOf(token: string): string | null {
  if (typeof token !== "string" || !token.startsWith(CUSTOM_VALUE_PREFIX)) return null;
  const key = token.slice(CUSTOM_VALUE_PREFIX.length);
  return CUSTOM_VALUE_KEY_RE.test(key) ? key : null;
}
export const isCustomValueTokenKey = (v: unknown): v is CustomValueTokenKey => typeof v === "string" && customValueKeyOf(v) !== null;
export const customValueTokenKey = (key: string): CustomValueTokenKey => `${CUSTOM_VALUE_PREFIX}${key}` as CustomValueTokenKey;

/** Definitions by key. Keys given without a definition are treated as optional values labelled by their key. */
export function customValueMap(catalog: CustomValueCatalog | null | undefined): Map<string, CustomValueTokenDef> {
  const out = new Map<string, CustomValueTokenDef>();
  for (const c of catalog ?? []) {
    const def = typeof c === "string" ? { key: c, label: c, required: false } : c;
    if (def && CUSTOM_VALUE_KEY_RE.test(def.key)) out.set(def.key, def);
  }
  return out;
}

/** Picker entries for the workspace's configuration values, shaped like the built-in tokens. */
export function customValueTokenDefs(catalog: CustomValueCatalog | null | undefined): Array<{ key: CustomValueTokenKey; label: string; phrase: string; sample: string; required: boolean; group: string | null }> {
  return [...customValueMap(catalog).values()].map((d) => ({
    key: customValueTokenKey(d.key),
    label: d.label,
    phrase: `your “${d.label}” configuration value`,
    sample: (d.value ?? "").trim() || d.label,
    required: d.required,
    group: d.group ?? null,
  }));
}

/** The label of a token for a picker or a chip: built-in tokens by their label, configuration values by theirs. */
export function anyTokenLabel(key: string, catalog?: CustomValueCatalog | null): string | undefined {
  const builtIn = tokenDef(key);
  if (builtIn) return builtIn.label;
  const k = customValueKeyOf(key);
  return k ? customValueMap(catalog).get(k)?.label : undefined;
}

/**
 * The renderer's values for the workspace's configuration values: filled values as they are, empty optional values as "" (they render as
 * nothing), and empty required values left out, so a renderer given no definitions still reports them as missing.
 */
export function customValueTokenValues(defs: ReadonlyArray<CustomValueTokenDef>): Partial<Record<CustomValueTokenKey, string>> {
  const out: Partial<Record<CustomValueTokenKey, string>> = {};
  for (const d of defs) {
    if (!CUSTOM_VALUE_KEY_RE.test(d.key)) continue;
    const v = (d.value ?? "").trim();
    if (v) out[customValueTokenKey(d.key)] = v;
    else if (!d.required) out[customValueTokenKey(d.key)] = "";
  }
  return out;
}

/** The configuration value someone probably meant ({{booking_link}}, {{custom_value.Booking-Link}} …), when the workspace has it. */
export function suggestCustomValueToken(raw: string, catalog: CustomValueCatalog | null | undefined): CustomValueTokenKey | null {
  const map = customValueMap(catalog);
  if (!map.size) return null;
  const k = raw.trim().toLowerCase().replace(/^(?:custom_values|custom_value|customvalues|custom|values|value|cv)[.:]/, "").replace(/[\s-]+/g, "_");
  return map.has(k) ? customValueTokenKey(k) : null;
}

/** The text to insert for a token. */
export const tokenText = (key: AnyTokenKey) => `{{${key}}}`;

/**
 * The values a renderer receives. Blank strings count as missing for built-in tokens; for configuration values see the rules above.
 */
export type TokenValues = Partial<Record<TokenKey, string | null | undefined>> & { [key: CustomValueTokenKey]: string | null | undefined };

/** Every token's sample value, with optional real values (for example your business name) layered on top. */
export function sampleTokenValues(overrides: TokenValues = {}): Record<TokenKey, string> {
  const out = Object.fromEntries(TEMPLATE_TOKENS.map((t) => [t.key, t.sample])) as Record<TokenKey, string>;
  for (const [k, v] of Object.entries(overrides)) if (isTokenKey(k) && typeof v === "string" && v.trim()) out[k] = v.trim();
  return out;
}

// ---------------------------------------------------------------------------
// Finding tokens
// ---------------------------------------------------------------------------

/** A well-formed placeholder: two braces, anything but braces, two braces. Whitespace inside is allowed and ignored. */
const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

export interface TokenOccurrence {
  /** Exactly as written, braces included. */
  raw: string;
  /** What is between the braces, trimmed. */
  key: string;
  known: boolean;
  start: number;
  end: number;
}

/**
 * Every {{…}} in the text, in order, known or not. A configuration value token is known when the workspace has that key (`catalog`); when
 * no catalog is given, any well-formed {{custom_values.<key>}} counts as a token, so it is never mistaken for plain text.
 */
export function extractTokens(text: string, catalog?: CustomValueCatalog | null): TokenOccurrence[] {
  const out: TokenOccurrence[] = [];
  const custom = catalog ? customValueMap(catalog) : null;
  for (const m of (text ?? "").matchAll(PLACEHOLDER)) {
    const key = m[1].trim();
    const cv = customValueKeyOf(key);
    const known = isTokenKey(key) || (cv !== null && (custom ? custom.has(cv) : true));
    out.push({ raw: m[0], key, known, start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  return out;
}

/** The distinct configuration value keys a text uses (without the prefix), in order of first appearance. */
export function customValueKeysUsed(...texts: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const t of texts) for (const m of (t ?? "").matchAll(PLACEHOLDER)) {
    const k = customValueKeyOf(m[1].trim());
    if (k) seen.add(k);
  }
  return [...seen];
}

/**
 * The REQUIRED configuration values a text uses that are empty right now, in order of first appearance: every send of it is held until they
 * are filled in (approving the wording is still allowed, so screens warn instead of refusing).
 */
export function emptyRequiredValues(catalog: ReadonlyArray<CustomValueTokenDef> | null | undefined, ...texts: Array<string | null | undefined>): CustomValueTokenDef[] {
  const defs = new Map((catalog ?? []).map((d) => [d.key, d]));
  return customValueKeysUsed(...texts).flatMap((k) => {
    const d = defs.get(k);
    return d && d.required && !(d.value ?? "").trim() ? [d] : [];
  });
}

/** The distinct known built-in tokens a text uses, in order of first appearance (configuration values: customValueKeysUsed). */
export function tokensUsed(...texts: Array<string | null | undefined>): TokenKey[] {
  const seen = new Set<TokenKey>();
  for (const t of texts) for (const o of extractTokens(t ?? "")) if (isTokenKey(o.key)) seen.add(o.key);
  return [...seen];
}

/** Splits text into plain runs and placeholders, for highlighting tokens in an editor or a preview. */
export function splitTokens(text: string, catalog?: CustomValueCatalog | null): Array<{ text: string; token?: { key: string; known: boolean } }> {
  const parts: Array<{ text: string; token?: { key: string; known: boolean } }> = [];
  let at = 0;
  for (const o of extractTokens(text, catalog)) {
    if (o.start > at) parts.push({ text: text.slice(at, o.start) });
    parts.push({ text: o.raw, token: { key: o.key, known: o.known } });
    at = o.end;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}

/** Common ways people write a token that isn't quite right, mapped to the real one. */
const ALIASES: Record<string, TokenKey> = {
  first_name: "contact.first_name", firstname: "contact.first_name", "contact.firstname": "contact.first_name", name: "contact.full_name",
  last_name: "contact.last_name", lastname: "contact.last_name", full_name: "contact.full_name", "contact.name": "contact.full_name",
  email: "contact.email", phone: "contact.phone", "business": "business.name", business_name: "business.name", company: "business.name",
  "company.name": "business.name", website: "business.website", "user.name": "user.first_name", "sender.first_name": "user.first_name",
  date: "appointment.date", time: "appointment.time", "appointment.link": "appointment.manage_link", manage_link: "appointment.manage_link",
  review_link: "review.link", "review.url": "review.link", review: "review.link",
};

/** The token someone probably meant, if any. */
export function suggestToken(key: string): TokenKey | null {
  const k = key.trim().toLowerCase().replace(/\s+/g, "_").replace(/-/g, "_");
  if (isTokenKey(k)) return k;
  return ALIASES[k] ?? null;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface RenderOptions {
  /** What to put where a token has no value. Default: nothing. The token is reported in `missing` (or `unknown`) either way. */
  missingAs?: (key: string, def: TokenDef | undefined) => string;
  /** Values are flattened to one line (an email subject). */
  singleLine?: boolean;
  /**
   * The workspace's configuration values. When given, a {{custom_values.<key>}} the workspace doesn't have is `unknown`, an empty optional
   * one renders as nothing and an empty required one is `missing`. When not given, the values decide (see customValueTokenValues).
   */
  customValues?: ReadonlyArray<CustomValueTokenDef> | null;
}

export interface RenderResult {
  text: string;
  /** Known tokens that had no value (configuration values only when required), in order of first appearance. */
  missing: AnyTokenKey[];
  /** Placeholders that are not tokens at all (a template saved before validation, or text typed into a composer). */
  unknown: string[];
  /** True only when every placeholder had a value. */
  ok: boolean;
}

/** Collapses doubled braces so the result can never contain a placeholder, whatever the input or the values held. */
function noPlaceholders(s: string): string {
  let out = s;
  while (out.includes("{{") || out.includes("}}")) out = out.replaceAll("{{", "{").replaceAll("}}", "}");
  return out;
}

function cleanValue(v: string, singleLine: boolean): string {
  const stripped = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  return noPlaceholders(singleLine ? stripped.replace(/\s*[\r\n]+\s*/g, " ") : stripped);
}

/**
 * Fills a template's tokens with values in one pass (a value is never itself expanded, so a contact named "{{business.email}}" stays text).
 * Never returns a raw {{…}}: tokens without a value are replaced by `missingAs` (default nothing) and listed in `missing`, placeholders
 * that aren't tokens are listed in `unknown`. Callers that send must refuse when `ok` is false.
 */
export function renderTemplate(body: string, values: TokenValues, opts: RenderOptions = {}): RenderResult {
  const missing = new Set<AnyTokenKey>();
  const unknown = new Set<string>();
  const custom = opts.customValues ? customValueMap(opts.customValues) : null;
  const filled = (body ?? "").replace(PLACEHOLDER, (_raw, inner: string) => {
    const key = inner.trim();
    const cv = customValueKeyOf(key);
    if (cv !== null) {
      const token = key as CustomValueTokenKey;
      const def = custom?.get(cv);
      if (custom && !def) {
        unknown.add(key);
        return opts.missingAs ? noPlaceholders(opts.missingAs(key, undefined)) : "";
      }
      const v = values[token] ?? def?.value;
      const value = typeof v === "string" ? cleanValue(v, Boolean(opts.singleLine)) : "";
      if (value) return value;
      // An optional value left empty is simply not there. Without definitions, only values handed in (as "") count as optional.
      const optional = def ? !def.required : Object.prototype.hasOwnProperty.call(values, token) && typeof v === "string";
      if (optional) return "";
      missing.add(token);
      return opts.missingAs ? noPlaceholders(opts.missingAs(key, undefined)) : "";
    }
    if (!isTokenKey(key)) {
      unknown.add(key);
      return opts.missingAs ? noPlaceholders(opts.missingAs(key, undefined)) : "";
    }
    const v = values[key];
    const value = typeof v === "string" ? cleanValue(v, Boolean(opts.singleLine)) : "";
    if (value) return value;
    missing.add(key);
    return opts.missingAs ? noPlaceholders(opts.missingAs(key, tokenDef(key))) : "";
  });
  const text = noPlaceholders(filled);
  return { text: opts.singleLine ? text.replace(/\s*[\r\n]+\s*/g, " ").trim() : text, missing: [...missing], unknown: [...unknown], ok: missing.size === 0 && unknown.size === 0 };
}

/** Renders a subject and a body together, reporting what is missing from either. */
export function renderMessage(input: { subject?: string | null; body: string }, values: TokenValues, opts: Omit<RenderOptions, "singleLine"> = {}) {
  const subject = input.subject == null ? null : renderTemplate(input.subject, values, { ...opts, singleLine: true });
  const body = renderTemplate(input.body, values, opts);
  const missing = [...new Set([...(subject?.missing ?? []), ...body.missing])];
  const unknown = [...new Set([...(subject?.unknown ?? []), ...body.unknown])];
  return { subject: subject?.text ?? null, body: body.text, missing, unknown, ok: missing.length === 0 && unknown.length === 0 };
}

const listPhrase = (items: string[]) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

/**
 * A plain sentence for a send that was refused because of missing values: "This message needs the contact's first name, which isn't on file."
 * Configuration values are named by their label when the workspace's values are given, and the sentence says where to fill them in.
 */
export function describeMissing(missing: readonly string[], unknown: readonly string[] = [], customValues?: CustomValueCatalog | null): string {
  const parts: string[] = [];
  const custom = customValueMap(customValues);
  if (missing.length) {
    const phrases = missing.map((k) => {
      const cv = customValueKeyOf(k);
      if (cv === null) return tokenDef(k)?.phrase ?? k;
      const label = custom.get(cv)?.label;
      return label && label !== cv ? `your “${label}” configuration value` : `your configuration value {{${k}}}`;
    });
    parts.push(`This message needs ${listPhrase(phrases)}, which ${missing.length === 1 ? "isn't" : "aren't"} available.`);
    const emptyValues = missing.filter((k) => customValueKeyOf(k) !== null).length;
    if (emptyValues) parts.push(`${emptyValues === 1 ? "That value is required and empty" : "Those values are required and empty"}: fill ${emptyValues === 1 ? "it" : "them"} in under CRM Settings → Configuration Values.`);
  }
  if (unknown.length) parts.push(`It also contains ${unknown.length === 1 ? "a placeholder" : "placeholders"} iAcquire doesn't recognise (${unknown.map((u) => `{{${u}}}`).join(", ")}).`);
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// SMS length
// ---------------------------------------------------------------------------

export interface SmsEstimate {
  segments: number;
  encoding: "GSM-7" | "UCS-2";
  /** Characters as the carrier counts them (GSM-7 extension characters count twice; UCS-2 counts UTF-16 units). */
  units: number;
  /** Characters per segment at this length: 160/70 for one segment, 153/67 once it is split. */
  perSegment: number;
  /** Characters that force UCS-2 (emoji, curly quotes and so on), first few only. */
  nonGsm: string[];
}

const charClass = new Map<string, "gsm" | "ext" | "ucs">();
/**
 * Whether one character is basic GSM-7, a GSM-7 extension (counts twice) or outside GSM-7. Derived from smsSegments itself, so this estimate
 * and the segment count used for billing can never disagree: 71 of a non-GSM character no longer fit one 70-unit UCS-2 segment, and 81 of an
 * extension character (162 units) no longer fit one 160-unit GSM-7 segment.
 */
function classify(ch: string): "gsm" | "ext" | "ucs" {
  let c = charClass.get(ch);
  if (!c) {
    c = smsSegments(ch.repeat(71)) > 1 ? "ucs" : smsSegments(ch.repeat(81)) > 1 ? "ext" : "gsm";
    charClass.set(ch, c);
  }
  return c;
}

export function smsEstimate(text: string): SmsEstimate {
  const chars = [...(text ?? "")];
  const nonGsm = [...new Set(chars.filter((ch) => classify(ch) === "ucs"))];
  const segments = smsSegments(text ?? "");
  if (nonGsm.length) {
    const units = chars.reduce((n, ch) => n + (ch.codePointAt(0)! > 0xffff ? 2 : 1), 0);
    return { segments, encoding: "UCS-2", units, perSegment: segments > 1 ? 67 : 70, nonGsm: nonGsm.slice(0, 6) };
  }
  const units = chars.reduce((n, ch) => n + (classify(ch) === "ext" ? 2 : 1), 0);
  return { segments, encoding: "GSM-7", units, perSegment: segments > 1 ? 153 : 160, nonGsm: [] };
}

// ---------------------------------------------------------------------------
// Validation (when a template or canned reply is saved, and live in the editor)
// ---------------------------------------------------------------------------

/** Provider and storage limits, in characters. */
export const TEMPLATE_LIMITS = {
  /** conversation_messages.body and crm_message_template_versions.body. */
  body: 5000,
  /** crm_message_template_versions.subject. */
  subject: 200,
  /** Twilio Messages API: Body "can be up to 1,600 characters in length". */
  sms: 1600,
  /** Meta WhatsApp Cloud API: text.body maximum 4096 characters. */
  whatsappText: 4096,
  /** Meta WhatsApp template BODY component: maximum 1024 characters. */
  whatsappTemplateBody: 1024,
  /** crm_message_template_versions.tokens. */
  tokens: 40,
} as const;

/** Long texts still send, but cost more and read badly; above this many segments the editor warns. */
const SMS_SEGMENT_WARNING = 4;

export type IssueLevel = "error" | "warning" | "info";
export interface TemplateIssue {
  level: IssueLevel;
  code:
    | "body_required" | "body_too_long" | "subject_required" | "subject_too_long" | "subject_multiline" | "unknown_token" | "positional_token"
    | "stray_braces" | "single_braces" | "too_many_tokens" | "sms_too_long" | "sms_segments" | "sms_long" | "sms_unicode" | "sms_opt_out"
    | "whatsapp_too_long" | "whatsapp_window" | "whatsapp_marketing" | "email_unsubscribe" | "any_channel" | "unknown_custom_value" | "review_incentive" | "review_steering";
  message: string;
  /** Where the issue is: the subject line or the body. */
  field: "subject" | "body";
  /** The placeholder concerned, for token issues. */
  token?: string;
  /** The token the person probably meant. */
  suggestion?: AnyTokenKey;
}

export interface TemplateValidation {
  /** No errors: the template can be saved. Warnings and info never block. */
  ok: boolean;
  errors: TemplateIssue[];
  warnings: TemplateIssue[];
  info: TemplateIssue[];
  /** Known tokens used, subject first, in order of first appearance. */
  tokens: TokenKey[];
  /** Configuration value keys used (without the prefix), subject first, in order of first appearance. */
  customValues: string[];
  /** SMS only: the estimate with sample values in place of tokens. */
  sms: SmsEstimate | null;
  /** Characters after tokens are replaced by sample values. */
  renderedLength: number;
}

export interface ValidateOptions {
  purpose?: "service" | "marketing";
  /** Canned replies are inserted into the inbox composer and sent in the conversation's own thread, so they have no subject. */
  kind?: "template" | "canned_reply";
  /**
   * The workspace's configuration values (definitions or keys). {{custom_values.<key>}} is accepted only for keys listed here, so a template
   * can never be saved with a value the workspace doesn't have. Not given: no configuration value token is accepted.
   */
  customValues?: CustomValueCatalog | null;
}

function tokenIssues(text: string, field: "subject" | "body", catalog: CustomValueCatalog): TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  const seen = new Set<string>();
  const custom = customValueMap(catalog);
  for (const o of extractTokens(text, catalog)) {
    if (o.known || seen.has(o.key)) continue;
    seen.add(o.key);
    if (/^custom_values?\./i.test(o.key)) {
      const suggestion = suggestCustomValueToken(o.key, catalog) ?? undefined;
      issues.push({
        level: "error", code: "unknown_custom_value", field, token: o.raw, suggestion,
        message: suggestion
          ? `${o.raw} isn't one of this workspace's configuration values. Did you mean {{${suggestion}}}?`
          : custom.size
            ? `${o.raw} isn't one of this workspace's configuration values. Pick one from the token list, or add it in CRM Settings → Configuration Values.`
            : `${o.raw} isn't one of this workspace's configuration values: there are none yet. Add it in CRM Settings → Configuration Values first.`,
      });
      continue;
    }
    if (/^\d+$/.test(o.key)) {
      issues.push({ level: "error", code: "positional_token", field, token: o.raw, message: `${o.raw} is a WhatsApp Manager placeholder. In iAcquire templates use named tokens such as {{contact.first_name}}.` });
      continue;
    }
    const suggestion = suggestToken(o.key) ?? suggestCustomValueToken(o.key, catalog) ?? undefined;
    issues.push({
      level: "error", code: "unknown_token", field, token: o.raw, suggestion,
      message: o.key ? `${o.raw} isn't a token iAcquire knows${suggestion ? `. Did you mean {{${suggestion}}}?` : ". Pick one from the token list."}` : "There is an empty {{ }}. Remove it or pick a token from the list.",
    });
  }
  const rest = text.replace(PLACEHOLDER, "");
  if (rest.includes("{{") || rest.includes("}}")) {
    issues.push({ level: "error", code: "stray_braces", field, message: "There is an unfinished token: every {{ needs a matching }}." });
  }
  for (const m of rest.matchAll(/\{\s*([A-Za-z_]+\.[A-Za-z0-9_]+)\s*\}/g)) {
    const suggestion = suggestToken(m[1]) ?? suggestCustomValueToken(m[1], catalog);
    if (suggestion) {
      issues.push({ level: "warning", code: "single_braces", field, token: m[0], suggestion, message: `${m[0]} uses single braces, so it will be sent as written. Tokens use two: {{${suggestion}}}.` });
      break;
    }
  }
  return issues;
}

/**
 * Checks a template (or canned reply) before it is saved, and live while it is edited. Unknown tokens, unfinished braces, a missing email
 * subject and anything over a provider's limit are errors; long texts, missing opt-out wording and channel rules are warnings or notes.
 * Lengths are measured with sample values in place of tokens, since real names and dates change them.
 */
export function validateTemplate(body: string, subject: string | null | undefined, channel: Channel | null, opts: ValidateOptions = {}): TemplateValidation {
  const issues: TemplateIssue[] = [];
  const kind = opts.kind ?? "template";
  const purpose = opts.purpose ?? "service";
  const text = body ?? "";
  const catalog = opts.customValues ?? [];
  const known = customValueMap(catalog);
  const useSubject = channel === "email" && kind === "template";
  const subj = useSubject ? (subject ?? "") : "";

  if (!text.trim()) issues.push({ level: "error", code: "body_required", field: "body", message: "Write the message." });
  if (text.length > TEMPLATE_LIMITS.body) issues.push({ level: "error", code: "body_too_long", field: "body", message: `Messages are at most ${TEMPLATE_LIMITS.body.toLocaleString("en-US")} characters (this one is ${text.length.toLocaleString("en-US")}).` });
  if (useSubject) {
    if (!subj.trim()) issues.push({ level: "error", code: "subject_required", field: "subject", message: "Add a subject line. Email can't be sent without one." });
    if (subj.length > TEMPLATE_LIMITS.subject) issues.push({ level: "error", code: "subject_too_long", field: "subject", message: `Subject lines are at most ${TEMPLATE_LIMITS.subject} characters.` });
    if (/[\r\n]/.test(subj)) issues.push({ level: "error", code: "subject_multiline", field: "subject", message: "A subject line can't contain line breaks." });
    issues.push(...tokenIssues(subj, "subject", catalog));
  }
  issues.push(...tokenIssues(text, "body", catalog));
  // Rule R4: wording that carries the customer's own review link may not offer anything in return for feedback or a review, or ask for a particular rating. This is a block, not a
  // warning: the template can't be saved or approved until it is reworded (src/lib/reputation/incentives.ts).
  if (/\{\{\s*review\.link\s*\}\}/.test(text)) {
    for (const f of reviewIncentiveFindings(`${subj}\n${text}`).slice(0, 3)) issues.push({ level: "error", code: f.kind === "incentive" ? "review_incentive" : "review_steering", field: "body", message: f.message });
  }

  const tokens = tokensUsed(subj, text);
  const customValues = customValueKeysUsed(subj, text).filter((k) => known.has(k));
  const distinct = new Set([...extractTokens(subj), ...extractTokens(text)].map((o) => o.key));
  if (distinct.size > TEMPLATE_LIMITS.tokens) issues.push({ level: "error", code: "too_many_tokens", field: "body", message: `Use at most ${TEMPLATE_LIMITS.tokens} different tokens.` });

  // Configuration values are measured with their current value (or their label when empty), like built-in tokens with samples.
  const samples: TokenValues = { ...sampleTokenValues() };
  for (const d of customValueTokenDefs(catalog)) samples[d.key] = d.sample;
  const sample = renderTemplate(text, samples).text;
  let sms: SmsEstimate | null = null;
  if (channel === "sms") {
    sms = smsEstimate(sample);
    if (sample.length > TEMPLATE_LIMITS.sms) {
      issues.push({ level: "error", code: "sms_too_long", field: "body", message: `Text messages are at most ${TEMPLATE_LIMITS.sms.toLocaleString("en-US")} characters (about ${sample.length.toLocaleString("en-US")} with sample values).` });
    } else if (text.trim()) {
      issues.push({ level: "info", code: "sms_segments", field: "body", message: `About ${sms.segments} segment${sms.segments === 1 ? "" : "s"} (${sms.units} of ${sms.segments > 1 ? `${sms.perSegment} per segment` : sms.perSegment} ${sms.encoding} characters) with sample values. Each segment is billed, and real names and dates change the count.` });
      if (sms.segments >= SMS_SEGMENT_WARNING) issues.push({ level: "warning", code: "sms_long", field: "body", message: `This text is long: about ${sms.segments} segments. Shorter texts cost less and read better on a phone.` });
    }
    if (sms.encoding === "UCS-2" && text.trim()) {
      issues.push({ level: "warning", code: "sms_unicode", field: "body", message: `${sms.nonGsm.map((c) => `"${c}"`).join(" ")} ${sms.nonGsm.length === 1 ? "isn't" : "aren't"} in the standard SMS alphabet, so each segment holds 70 characters instead of 160. Plain quotes and no emoji keep texts cheaper.` });
    }
    if (purpose === "marketing" && !/\bstop\b/i.test(text)) {
      issues.push({ level: "warning", code: "sms_opt_out", field: "body", message: "Marketing texts should say how to opt out, for example \"Reply STOP to opt out.\"" });
    }
  } else if (channel === "whatsapp") {
    if (sample.length > TEMPLATE_LIMITS.whatsappText) {
      issues.push({ level: "error", code: "whatsapp_too_long", field: "body", message: `WhatsApp messages are at most ${TEMPLATE_LIMITS.whatsappText.toLocaleString("en-US")} characters (about ${sample.length.toLocaleString("en-US")} with sample values).` });
    }
    issues.push({ level: "info", code: "whatsapp_window", field: "body", message: "WhatsApp delivers your own wording only within 24 hours of the customer's last message. Outside that window only a template approved by Meta in WhatsApp Manager can be sent." });
    if (purpose === "marketing") issues.push({ level: "info", code: "whatsapp_marketing", field: "body", message: "Marketing on WhatsApp goes only to people who agreed to it, and outside the 24-hour window needs a Meta-approved marketing template." });
  } else if (channel === "email") {
    if (purpose === "marketing" && !/unsubscribe|opt[\s-]?out|stop receiving/i.test(text)) {
      issues.push({ level: "warning", code: "email_unsubscribe", field: "body", message: "Marketing emails should tell people how to stop receiving them (for example an unsubscribe line)." });
    }
  } else if (kind === "canned_reply") {
    issues.push({ level: "info", code: "any_channel", field: "body", message: "Usable on every channel. SMS and WhatsApp limits are checked when the reply is sent." });
  }

  const errors = issues.filter((i) => i.level === "error");
  return { ok: errors.length === 0, errors, warnings: issues.filter((i) => i.level === "warning"), info: issues.filter((i) => i.level === "info"), tokens, customValues, sms, renderedLength: sample.length };
}
