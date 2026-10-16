// Custom field definitions and value validation. Pure, so the form, the import, the API and the database trigger agree on one rule.
import { normalizeEmail, normalizePhone } from "@/lib/messaging";
import type { FieldType } from "@/lib/crm/types";

export interface FieldOption {
  value: string;
  label: string;
}

export interface FieldDefinition {
  id: string;
  key: string;
  label: string;
  type: FieldType;
  options: FieldOption[];
  required: boolean;
}

/** The typed columns of crm_field_values. Exactly one is set. */
export interface StoredFieldValue {
  value_text: string | null;
  value_number: string | null;
  value_date: string | null;
  value_ts: string | null;
  value_bool: boolean | null;
  value_list: string[] | null;
}

export type FieldValue = string | number | boolean | string[] | null;

export type CoerceResult = { ok: true; stored: StoredFieldValue | null; display: FieldValue } | { ok: false; error: string };

const empty = (): StoredFieldValue => ({ value_text: null, value_number: null, value_date: null, value_ts: null, value_bool: null, value_list: null });

export function slugifyKey(label: string): string {
  const s = label
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return /^[a-z]/.test(s) ? s : `field_${s}`.slice(0, 48);
}

/** Options from free text ("Gold, Silver") or structured input. Values are stable slugs; labels are what people see. */
export function normalizeOptions(input: Array<string | Partial<FieldOption>>): FieldOption[] {
  const out: FieldOption[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    const label = (typeof item === "string" ? item : item.label ?? item.value ?? "").trim().slice(0, 80);
    if (!label) continue;
    const value = (typeof item === "string" ? slugifyKey(label) : item.value?.trim() || slugifyKey(label)).slice(0, 60);
    if (seen.has(value)) continue;
    seen.add(value);
    out.push({ value, label });
  }
  return out.slice(0, 100);
}

const isBlank = (v: unknown) => v === null || v === undefined || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);

function matchOption(def: FieldDefinition, raw: string): FieldOption | undefined {
  const s = raw.trim().toLowerCase();
  return def.options.find((o) => o.value.toLowerCase() === s || o.label.toLowerCase() === s);
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
function validDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/**
 * Validates and converts one value for a field. Blank values clear the field (the caller decides whether a required field may be
 * cleared). Never guesses: an unknown choice, an ambiguous phone number or a malformed date is an error, not a best effort.
 */
export function coerceFieldValue(def: FieldDefinition, raw: unknown, opts: { defaultCallingCode?: string | null } = {}): CoerceResult {
  if (isBlank(raw)) return { ok: true, stored: null, display: null };
  const out = empty();
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" || typeof v === "boolean" ? String(v) : "");
  switch (def.type) {
    case "text": {
      const s = str(raw);
      if (s.length > 500) return { ok: false, error: `${def.label} must be 500 characters or fewer.` };
      out.value_text = s;
      return { ok: true, stored: out, display: s };
    }
    case "textarea": {
      const s = str(raw);
      if (s.length > 5000) return { ok: false, error: `${def.label} must be 5000 characters or fewer.` };
      out.value_text = s;
      return { ok: true, stored: out, display: s };
    }
    case "number":
    case "currency": {
      const n = typeof raw === "number" ? raw : Number(str(raw).replace(/,/g, ""));
      if (!Number.isFinite(n) || Math.abs(n) >= 1e14) return { ok: false, error: `${def.label} must be a number.` };
      const v = def.type === "currency" ? Math.round(n * 100) / 100 : n;
      out.value_number = String(v);
      return { ok: true, stored: out, display: v };
    }
    case "date": {
      const s = str(raw);
      if (!validDate(s)) return { ok: false, error: `${def.label} must be a date like 2026-10-31.` };
      out.value_date = s;
      return { ok: true, stored: out, display: s };
    }
    case "datetime": {
      const s = str(raw);
      // A time without an explicit offset would be read in whatever zone the server runs in, so it is refused.
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(s) || Number.isNaN(Date.parse(s))) {
        return { ok: false, error: `${def.label} must be a date and time with a time zone.` };
      }
      out.value_ts = new Date(s).toISOString();
      return { ok: true, stored: out, display: out.value_ts };
    }
    case "boolean": {
      const s = str(raw).toLowerCase();
      const v = raw === true || ["true", "yes", "y", "1"].includes(s) ? true : raw === false || ["false", "no", "n", "0"].includes(s) ? false : null;
      if (v === null) return { ok: false, error: `${def.label} must be yes or no.` };
      out.value_bool = v;
      return { ok: true, stored: out, display: v };
    }
    case "select": {
      const opt = matchOption(def, str(raw));
      if (!opt) return { ok: false, error: `${def.label} must be one of: ${def.options.map((o) => o.label).join(", ")}.` };
      out.value_text = opt.value;
      return { ok: true, stored: out, display: opt.value };
    }
    case "multiselect": {
      const parts = Array.isArray(raw) ? raw.map(str) : str(raw).split(/[;,]/).map((p) => p.trim());
      const values: string[] = [];
      for (const p of parts.filter(Boolean)) {
        const opt = matchOption(def, p);
        if (!opt) return { ok: false, error: `"${p.slice(0, 40)}" is not an option for ${def.label}.` };
        if (!values.includes(opt.value)) values.push(opt.value);
      }
      if (!values.length) return { ok: true, stored: null, display: null };
      out.value_list = values;
      return { ok: true, stored: out, display: values };
    }
    case "email": {
      const e = normalizeEmail(str(raw));
      if (!e) return { ok: false, error: `${def.label} must be a valid email address.` };
      out.value_text = e;
      return { ok: true, stored: out, display: e };
    }
    case "phone": {
      const p = normalizePhone(str(raw), opts.defaultCallingCode ?? undefined);
      if (!p) return { ok: false, error: `${def.label} must be a phone number with its country code, like +63 917 123 4567.` };
      out.value_text = p;
      return { ok: true, stored: out, display: p };
    }
    case "url": {
      const s = str(raw);
      let u: URL;
      try {
        u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
      } catch {
        return { ok: false, error: `${def.label} must be a web address.` };
      }
      if (!["http:", "https:"].includes(u.protocol) || !u.hostname.includes(".") || u.toString().length > 500) return { ok: false, error: `${def.label} must be a web address.` };
      out.value_text = u.toString();
      return { ok: true, stored: out, display: out.value_text };
    }
  }
}

/** Reads a stored row back into a display value. */
export function readStoredValue(type: FieldType, row: Partial<StoredFieldValue>): FieldValue {
  switch (type) {
    case "number":
    case "currency":
      return row.value_number === null || row.value_number === undefined ? null : Number(row.value_number);
    case "date":
      return row.value_date ? String(row.value_date).slice(0, 10) : null;
    case "datetime":
      return row.value_ts ? new Date(row.value_ts).toISOString() : null;
    case "boolean":
      return row.value_bool ?? null;
    case "multiselect":
      return row.value_list ?? null;
    default:
      return row.value_text ?? null;
  }
}

/** Human-readable text for a value (labels instead of option slugs). */
export function formatFieldValue(def: Pick<FieldDefinition, "type" | "options">, value: FieldValue, locale = "en-US", currency = "USD"): string {
  if (value === null || value === undefined) return "";
  const label = (v: string) => def.options.find((o) => o.value === v)?.label ?? v;
  switch (def.type) {
    case "boolean":
      return value ? "Yes" : "No";
    case "select":
      return label(String(value));
    case "multiselect":
      return (value as string[]).map(label).join(", ");
    case "currency":
      return new Intl.NumberFormat(locale, { style: "currency", currency }).format(Number(value));
    case "number":
      return new Intl.NumberFormat(locale).format(Number(value));
    default:
      return String(value);
  }
}
