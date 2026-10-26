// Searching what colleagues wrote. The words a person types are looked for as plain text (never as a pattern), and the database only ever searches the conversations the
// person is in. Pure.

import { SEARCH_MAX_CHARS, SEARCH_MIN_CHARS } from "@/lib/staff-messages/limits";

export type QueryResult = { ok: true; query: string } | { ok: false; message: string };

/** The search words: control codes out, runs of spaces made one, trimmed, 2 to 100 characters. */
export function normaliseQuery(raw: unknown): QueryResult {
  if (typeof raw !== "string" || raw.length > SEARCH_MAX_CHARS * 4) return { ok: false, message: `Search for up to ${SEARCH_MAX_CHARS} characters.` };
  const out: string[] = [];
  let pendingSpace = false;
  for (const ch of raw) {
    const code = ch.codePointAt(0) as number;
    if (code <= 32 || (code >= 127 && code <= 160) || code === 0x2028 || code === 0x2029) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) out.push(" ");
    pendingSpace = false;
    out.push(ch);
  }
  const query = out.join("").normalize("NFC");
  const n = Array.from(query).length;
  if (n < SEARCH_MIN_CHARS) return { ok: false, message: `Type at least ${SEARCH_MIN_CHARS} characters to search.` };
  if (n > SEARCH_MAX_CHARS) return { ok: false, message: `Search for up to ${SEARCH_MAX_CHARS} characters.` };
  return { ok: true, query };
}

const BACKSLASH = String.fromCharCode(92);

/** The text with the three characters a LIKE pattern gives a meaning to (backslash, percent and underscore) protected by a backslash, for `ilike ... escape` with a backslash. */
export function escapeLike(text: string): string {
  let out = "";
  for (const ch of text) out += ch === BACKSLASH || ch === "%" || ch === "_" ? BACKSLASH + ch : ch;
  return out;
}

export const likePattern = (query: string): string => `%${escapeLike(query)}%`;

export interface Snippet {
  text: string;
  /** Where the match sits in `text`, to be shown highlighted; null if the words are not found as typed. */
  match: { start: number; end: number } | null;
}

/** A short piece of the message around the first match, with an ellipsis where it was cut. Case does not matter. */
export function snippetOf(body: string, query: string, radius = 70): Snippet {
  const flat = body.replace(/\s+/g, " ");
  const at = flat.toLowerCase().indexOf(query.toLowerCase());
  if (at === -1) return { text: flat.length > radius * 2 ? `${flat.slice(0, radius * 2)}…` : flat, match: null };
  const from = Math.max(0, at - radius);
  const to = Math.min(flat.length, at + query.length + radius);
  const head = from > 0 ? "…" : "";
  const text = `${head}${flat.slice(from, to)}${to < flat.length ? "…" : ""}`;
  return { text, match: { start: head.length + (at - from), end: head.length + (at - from) + query.length } };
}
