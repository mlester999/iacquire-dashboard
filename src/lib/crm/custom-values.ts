// Workspace configuration values (crm_custom_values): the types, limits and per-type validation. Pure, so the settings form checks a value
// as it is typed with exactly the rule the server applies when it is saved.
//
// A configuration value is something a business states once and uses in many messages: a booking link, an office address, a promo code.
// Templates insert it as {{custom_values.<key>}}. Values are shown to customers, so a value that looks like a password, key or token is
// refused: credentials belong in Integrations, where they are encrypted.
import { normalizeEmail, normalizePhone } from "@/lib/messaging";
import { CUSTOM_VALUE_KEY_RE } from "@/lib/messaging/tokens";
import { detectSecret } from "@/lib/secrets";

export const CUSTOM_VALUE_TYPES = ["text", "url", "phone", "email", "number", "color"] as const;
export type CustomValueType = (typeof CUSTOM_VALUE_TYPES)[number];
export const isCustomValueType = (v: unknown): v is CustomValueType => typeof v === "string" && (CUSTOM_VALUE_TYPES as readonly string[]).includes(v);

export const CUSTOM_VALUE_TYPE_LABELS: Record<CustomValueType, string> = {
  text: "Text",
  url: "Web address",
  phone: "Phone number",
  email: "Email address",
  number: "Number",
  color: "Colour",
};

export const CUSTOM_VALUE_TYPE_HINTS: Record<CustomValueType, string> = {
  text: "Any text, such as an address or opening hours.",
  url: "A web address, such as your booking page. https:// is added if you leave it out.",
  phone: "A phone number with its country code, such as +63 917 123 4567.",
  email: "An email address, such as hello@yourbusiness.com.",
  number: "A number, such as 15 or 1,200.50.",
  color: "A hex colour, such as #1f6feb.",
};

/** The same limits as the crm_custom_values table, plus how many a workspace may have. */
export const CUSTOM_VALUE_LIMITS = { key: 48, label: 80, value: 2000, group: 60, perWorkspace: 200 } as const;

export { CUSTOM_VALUE_KEY_RE };

/** A key made from a label: "Booking link" → "booking_link". Always matches CUSTOM_VALUE_KEY_RE (empty labels give "value"). */
export function keyFromLabel(label: string): string {
  const s = (label ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, CUSTOM_VALUE_LIMITS.key)
    .replace(/_+$/g, "");
  if (!s) return "value";
  return /^[a-z]/.test(s) ? s : `value_${s}`.slice(0, CUSTOM_VALUE_LIMITS.key).replace(/_+$/g, "");
}

export function checkKey(raw: string): { ok: true; key: string } | { ok: false; error: string } {
  const key = (raw ?? "").trim();
  if (!CUSTOM_VALUE_KEY_RE.test(key)) {
    return { ok: false, error: "Keys start with a lower-case letter and use only lower-case letters, numbers and _ (up to 48 characters), for example booking_link." };
  }
  return { ok: true, key };
}

export function checkLabel(raw: string | null | undefined): { ok: true; label: string } | { ok: false; error: string } {
  const label = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!label) return { ok: false, error: "Give the value a name, such as “Booking link”." };
  if (label.length > CUSTOM_VALUE_LIMITS.label) return { ok: false, error: `Names are at most ${CUSTOM_VALUE_LIMITS.label} characters.` };
  return { ok: true, label };
}

/** A group name, or null for none. */
export function checkGroup(raw: string | null | undefined): { ok: true; group: string | null } | { ok: false; error: string } {
  const group = (raw ?? "").replace(/\s+/g, " ").trim();
  if (group.length > CUSTOM_VALUE_LIMITS.group) return { ok: false, error: `Group names are at most ${CUSTOM_VALUE_LIMITS.group} characters.` };
  return { ok: true, group: group || null };
}

/** A number as people write it: 15, -3, 1200.5, 1,200.50. */
const NUMBER_RE = /^-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/;
const HEX_RE = /^#?(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export type ValueCheck = { ok: true; value: string } | { ok: false; error: string };

/**
 * Checks and normalizes a value for its type. An empty value is allowed for every type (a required value can be created empty, for the
 * business to fill in later); anything else must be valid for the type and must not look like a credential.
 */
export function normalizeCustomValue(type: CustomValueType, raw: string | null | undefined, opts: { defaultCallingCode?: string | null } = {}): ValueCheck {
  const input = (raw ?? "").replace(/\r\n?/g, "\n");
  const trimmed = input.trim();
  if (!trimmed) return { ok: true, value: "" };
  if (input.length > CUSTOM_VALUE_LIMITS.value) return { ok: false, error: `Values are at most ${CUSTOM_VALUE_LIMITS.value.toLocaleString("en-US")} characters.` };
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(trimmed)) return { ok: false, error: "The value contains characters that can't be sent in a message. Retype it rather than pasting it." };
  if (trimmed.includes("{{") || trimmed.includes("}}")) {
    return { ok: false, error: "A value can't contain {{ or }}. It is inserted into messages exactly as written, so it can't hold other tokens." };
  }
  let value: string;
  switch (type) {
    case "text":
      value = trimmed;
      break;
    case "url": {
      if (/\s/.test(trimmed)) return { ok: false, error: "A web address can't contain spaces." };
      const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || /^(?:javascript|data|vbscript|mailto|tel|sms|file|blob):/i.test(trimmed);
      const withScheme = hasScheme ? trimmed : `https://${trimmed}`;
      let u: URL;
      try {
        u = new URL(withScheme);
      } catch {
        return { ok: false, error: "Enter a web address, such as https://www.yourbusiness.com/book." };
      }
      if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, error: "Web addresses start with https:// (or http://)." };
      if (!u.hostname.includes(".") || u.hostname.startsWith(".") || u.hostname.endsWith(".")) return { ok: false, error: "Enter a full web address, such as https://www.yourbusiness.com." };
      if (u.username || u.password) return { ok: false, error: "A web address used in messages can't contain a username or password." };
      value = withScheme;
      break;
    }
    case "phone": {
      const p = normalizePhone(trimmed, opts.defaultCallingCode ?? undefined);
      if (!p) return { ok: false, error: "Enter the number with its country code, such as +63 917 123 4567." };
      value = p;
      break;
    }
    case "email": {
      const e = normalizeEmail(trimmed);
      if (!e) return { ok: false, error: "Enter an email address, such as hello@yourbusiness.com." };
      value = e;
      break;
    }
    case "number": {
      const n = trimmed.replace(/\s+/g, "");
      if (!NUMBER_RE.test(n) || !Number.isFinite(Number(n.replace(/,/g, ""))) || Math.abs(Number(n.replace(/,/g, ""))) >= 1e15) {
        return { ok: false, error: "Enter a number, such as 15 or 1,200.50 (no currency symbols or units)." };
      }
      value = n;
      break;
    }
    case "color": {
      if (!HEX_RE.test(trimmed)) return { ok: false, error: "Enter a hex colour, such as #1f6feb." };
      value = `#${trimmed.replace(/^#/, "").toLowerCase()}`;
      break;
    }
  }
  const secret = detectSecret(value);
  if (secret) {
    return {
      ok: false,
      error: `This looks like ${secret.label}. Configuration values appear in messages to customers, so passwords, keys and tokens can't be stored here. Keep credentials in Integrations, where they are encrypted.`,
    };
  }
  return { ok: true, value };
}
