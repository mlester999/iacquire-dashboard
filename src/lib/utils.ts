import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * A request-stable "now" for server components and render-time props.
 *
 * Relative timestamps need one instant shared by the server render and hydration. Reading it through
 * this helper keeps that explicit and gives the React purity lint a single, intentional boundary.
 */
export function currentTime() {
  return Date.now();
}

export function initials(name: string | null | undefined, fallback = "?") {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return fallback;
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

export function firstName(name: string | null | undefined) {
  return (name ?? "").trim().split(/\s+/)[0] || null;
}

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat("en-US");

export function formatNumber(n: number | null | undefined, opts?: { compact?: boolean }) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return opts?.compact && Math.abs(n) >= 10000 ? compact.format(n) : whole.format(n);
}

/** A byte count in the largest sensible unit (1.4 MB, 820 KB). */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 B";
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function formatCurrency(n: number | null | undefined, currency = "USD") {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: n % 1 === 0 ? 0 : 2 }).format(n);
}

export function formatPercent(n: number | null | undefined, digits = 0) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(digits)}%`;
}

function toDate(d: Date | string | number) {
  return d instanceof Date ? d : new Date(d);
}

export function formatDateTime(d: Date | string | null | undefined, timeZone?: string, opts?: Intl.DateTimeFormatOptions) {
  if (!d) return "—";
  try {
    return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone, ...opts }).format(toDate(d));
  } catch {
    return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(toDate(d));
  }
}

export function formatDate(d: Date | string | null | undefined, timeZone?: string) {
  if (!d) return "—";
  try {
    return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone }).format(toDate(d));
  } catch {
    return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(toDate(d));
  }
}

export function formatTime(d: Date | string | null | undefined, timeZone?: string) {
  if (!d) return "";
  try {
    return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(toDate(d));
  } catch {
    return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(toDate(d));
  }
}

export function timeZoneLabel(timeZone: string) {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName");
    return part ? `${timeZone.replace(/_/g, " ")} (${part.value})` : timeZone;
  } catch {
    return timeZone;
  }
}

export function relativeTime(d: Date | string | null | undefined, now = Date.now()) {
  if (!d) return "never";
  const diff = toDate(d).getTime() - now;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 31536000000],
    ["month", 2592000000],
    ["week", 604800000],
    ["day", 86400000],
    ["hour", 3600000],
    ["minute", 60000],
  ];
  for (const [unit, ms] of units) if (abs >= ms) return rtf.format(Math.round(diff / ms), unit);
  return "just now";
}

export function pluralize(n: number, one: string, many = `${one}s`) {
  return `${formatNumber(n)} ${n === 1 ? one : many}`;
}

export function titleCase(s: string) {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function sentenceCase(s: string) {
  const t = s.replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}
