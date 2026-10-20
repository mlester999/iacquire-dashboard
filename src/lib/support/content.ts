// What a request is allowed to carry. Pure functions shared by the browser forms (so people see problems before sending) and the
// server (which repeats every check). Free text is stored as plain text and always rendered as text, never as markup.

import { ATTACHMENT_TYPES } from "@/lib/support/lifecycle";

/** Characters that can hide or reorder text (bidi overrides, zero-width joiners used for spoofing) or are control codes. */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0080-\u009F]/g;
const SPOOFING = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/** Plain text for a subject or message: normalised newlines, no control or direction-spoofing characters, trimmed, bounded blank lines. */
export function cleanText(input: string, max: number): string {
  return input
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL, "")
    .replace(SPOOFING, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim()
    .slice(0, max);
}

/** Escapes LIKE wildcards so a search for "100%" finds "100%" and nothing else. */
export const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export const cleanLine = (input: string, max: number) => cleanText(input, max).replace(/\s+/g, " ");

// ---------------------------------------------------------------------------
// Technical details ("Include technical details")
// ---------------------------------------------------------------------------

export interface Diagnostics {
  /** The page the person was on, as a path only (no query string or fragment). */
  page?: string;
  browser?: string;
  os?: string;
  appVersion?: string;
  /** Safe identifiers the person can read from an on-screen error (for example "Reference: abc123"). Letters, digits, - and _ only. */
  references?: string[];
  capturedAt?: string;
  timezone?: string;
  screen?: string;
  language?: string;
}

export const DIAGNOSTIC_LABELS: Record<keyof Diagnostics, string> = {
  page: "Page you were on",
  browser: "Browser",
  os: "Device",
  appVersion: "iAcquire version",
  references: "Error reference",
  capturedAt: "Time of report",
  timezone: "Your time zone",
  screen: "Screen size",
  language: "Language",
};

const PATH = /^\/[A-Za-z0-9/_\-.]{0,199}$/;
const REFERENCE = /^[A-Za-z0-9_-]{4,64}$/;

/**
 * Keeps only the fields above, each in a strict format, and drops everything else. It can never carry a token, cookie, header,
 * password, query string, request body or record content because there is nowhere to put one.
 */
export function sanitizeDiagnostics(input: unknown): Diagnostics | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const v = input as Record<string, unknown>;
  const out: Diagnostics = {};
  const str = (x: unknown, max: number) => (typeof x === "string" ? cleanLine(x, max) : "");
  if (typeof v.page === "string") {
    const path = v.page.split(/[?#]/)[0];
    if (PATH.test(path)) out.page = path;
  }
  const browser = str(v.browser, 60);
  if (/^[A-Za-z][A-Za-z0-9 ._()/-]{0,59}$/.test(browser)) out.browser = browser;
  const os = str(v.os, 40);
  if (/^[A-Za-z][A-Za-z0-9 ._()/-]{0,39}$/.test(os)) out.os = os;
  const appVersion = str(v.appVersion, 40);
  if (/^[A-Za-z0-9._+-]{1,40}$/.test(appVersion)) out.appVersion = appVersion;
  if (Array.isArray(v.references)) {
    const refs = v.references.filter((r): r is string => typeof r === "string" && REFERENCE.test(r)).slice(0, 5);
    if (refs.length) out.references = [...new Set(refs)];
  }
  if (typeof v.capturedAt === "string" && !Number.isNaN(Date.parse(v.capturedAt))) out.capturedAt = new Date(v.capturedAt).toISOString();
  const tz = str(v.timezone, 60);
  if (/^[A-Za-z]+(?:\/[A-Za-z_+-]+){0,2}$/.test(tz)) out.timezone = tz;
  const screen = str(v.screen, 12);
  if (/^\d{3,5}x\d{3,5}$/.test(screen)) out.screen = screen;
  const language = str(v.language, 12);
  if (/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(language)) out.language = language;
  return Object.keys(out).length ? out : null;
}

/** The lines the person sees (and approves) before anything is attached. */
export function describeDiagnostics(d: Diagnostics): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  for (const key of Object.keys(DIAGNOSTIC_LABELS) as Array<keyof Diagnostics>) {
    const value = d[key];
    if (value === undefined) continue;
    rows.push({ label: DIAGNOSTIC_LABELS[key], value: Array.isArray(value) ? value.join(", ") : String(value) });
  }
  return rows;
}

/** "Chrome 129" and "Windows" from a User-Agent string; unknown parts are left out instead of guessed. */
export function summarizeUserAgent(ua: string): { browser?: string; os?: string } {
  const out: { browser?: string; os?: string } = {};
  const pick = (re: RegExp, name: string) => {
    const m = re.exec(ua);
    return m ? `${name} ${m[1].split(".")[0]}` : null;
  };
  out.browser = pick(/Edg\/([\d.]+)/, "Edge") ?? pick(/OPR\/([\d.]+)/, "Opera") ?? pick(/Firefox\/([\d.]+)/, "Firefox") ?? pick(/(?:Chrome|CriOS)\/([\d.]+)/, "Chrome") ?? pick(/Version\/([\d.]+).*Safari/, "Safari") ?? undefined;
  out.os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad|iPod/.test(ua) ? "iOS" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : undefined;
  return out;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** A filename that is safe to store and show: no path, no odd characters, bounded length. */
export function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(SPOOFING, "").replace(CONTROL, "").replace(/[^\w.\- ()]+/g, "_").trim().replace(/^\.+/, "").slice(0, 120);
  return cleaned || "attachment";
}

export function fileExtension(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

export function mimeForFilename(name: string): string | null {
  const ext = fileExtension(name);
  return Object.hasOwn(ATTACHMENT_TYPES, ext) ? (ATTACHMENT_TYPES as Record<string, string>)[ext] : null;
}

/** Why a file can't be attached, or null when it can. Mirrors the server, so the person finds out before uploading. */
export function attachmentProblem(file: { name: string; size: number }, limits: { maxMb: number }): string | null {
  if (!mimeForFilename(file.name)) return "Choose a PNG, JPG, WebP, PDF, Word, CSV or text file.";
  if (file.size <= 0) return "That file is empty.";
  if (file.size > limits.maxMb * 1024 * 1024) return `Files can be up to ${limits.maxMb} MB.`;
  return null;
}

/** A client-generated key that lets a retry of the same submission be recognised. */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  return c?.randomUUID ? c.randomUUID() : `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
