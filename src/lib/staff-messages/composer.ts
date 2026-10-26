// What the message box decides: which word is being typed as a mention, how a chosen name becomes the id the server stores and back again, how many characters are left, why a
// message cannot be sent, and the id a browser gives each message it composes. Pure; the source of random bytes is passed in. Every scan is a loop over the text with a bounded
// look-back, so a pasted wall of text costs about what a short one does.

import { normaliseBody } from "@/lib/staff-messages/body";
import { findMentionTokens, mentionToken } from "@/lib/staff-messages/mentions";
import { MAX_BODY_CHARS } from "@/lib/staff-messages/limits";

export interface ChosenMention {
  id: string;
  name: string;
}

/** How far back from the caret a mention's word can start: a name and a bit, no further. */
const LOOK_BACK = 40;
const NO_BREAK_SPACE = String.fromCharCode(160);
const isSpace = (ch: string): boolean => ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === NO_BREAK_SPACE;
const isWordChar = (ch: string): boolean => /^[\p{L}\p{N}_]$/u.test(ch);

/**
 * The mention being typed: the text between an @ (at the start or after a space) and the caret, when it has no line break and does not begin with a space. Null otherwise
 * (an address, a sentence with an @ in it, a caret that has moved on).
 */
export function activeMention(text: string, caret: number): { start: number; query: string } | null {
  const end = Math.min(Math.max(0, caret), text.length);
  const floor = Math.max(0, end - LOOK_BACK);
  for (let i = end - 1; i >= floor; i--) {
    const ch = text[i];
    if (ch === "\n") return null;
    if (ch !== "@") continue;
    if (i > 0 && !isSpace(text[i - 1])) return null;
    const query = text.slice(i + 1, end);
    if (query.length > 0 && isSpace(query[0])) return null;
    return { start: i, query };
  }
  return null;
}

/**
 * People to offer for what was typed after the @: the ones whose name starts with it first (the shorter, closer match before the longer), then the ones that contain it; with
 * nothing typed yet, everyone in alphabetical order. Never the person writing; at most eight.
 */
export function filterMembers<T extends ChosenMention>(members: readonly T[], query: string, selfId: string): T[] {
  const needle = query.trim().toLowerCase();
  const starts: T[] = [];
  const contains: T[] = [];
  for (const m of members) {
    if (m.id.toLowerCase() === selfId.toLowerCase()) continue;
    const name = m.name.toLowerCase();
    if (needle === "" || name.startsWith(needle)) starts.push(m);
    else if (name.includes(needle)) contains.push(m);
  }
  const alphabetical = (a: T, b: T) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  const byLength = (a: T, b: T) => a.name.length - b.name.length || alphabetical(a, b);
  const order = needle === "" ? alphabetical : byLength;
  return [...starts.sort(order), ...contains.sort(order)].slice(0, 8);
}

/** Puts the chosen name where the typed word was ("@Maya Santos " with one space after), and returns the text and where the caret goes. */
export function applyMention(text: string, start: number, caret: number, member: ChosenMention): { text: string; caret: number } {
  const before = text.slice(0, start);
  const inserted = `@${member.name} `;
  return { text: before + inserted + text.slice(caret), caret: before.length + inserted.length };
}

/**
 * The text as it will be stored: each name the person chose, written as @Name where the text stands on its own (the start of the text or after a space) and not followed by
 * more of a word, becomes the id token the server reads. A name typed by hand, or one the person edited afterwards, stays as plain text, and so does anything that is not
 * one of the chosen names.
 */
export function compileMentions(display: string, chosen: readonly ChosenMention[]): string {
  if (chosen.length === 0 || display.indexOf("@") === -1) return display;
  const byName = new Map<string, ChosenMention>();
  for (const c of chosen) if (!byName.has(c.name)) byName.set(c.name, c);
  const candidates = [...byName.values()].sort((a, b) => b.name.length - a.name.length);
  const out: string[] = [];
  let i = 0;
  while (i < display.length) {
    if (display[i] === "@" && (i === 0 || isSpace(display[i - 1]))) {
      const hit = candidates.find((c) => {
        const end = i + 1 + c.name.length;
        return display.startsWith(c.name, i + 1) && (end >= display.length || !isWordChar(display[end]));
      });
      if (hit) {
        out.push(mentionToken(hit.id));
        i += 1 + hit.name.length;
        continue;
      }
    }
    out.push(display[i]);
    i += 1;
  }
  return out.join("");
}

/** A stored message as the text box shows it for editing: each id token becomes @Name (or @someone for a person who cannot be named), and the names are returned as chosen. */
export function displayFromBody(body: string, nameOf: (id: string) => string | null): { text: string; chosen: ChosenMention[] } {
  const chosen = new Map<string, ChosenMention>();
  const out: string[] = [];
  let cursor = 0;
  for (const token of findMentionTokens(body)) {
    out.push(body.slice(cursor, token.start));
    const name = nameOf(token.id);
    if (name) {
      out.push(`@${name}`);
      chosen.set(token.id, { id: token.id, name });
    } else out.push("@someone");
    cursor = token.end;
  }
  out.push(body.slice(cursor));
  return { text: out.join(""), chosen: [...chosen.values()] };
}

export interface Budget {
  chars: number;
  limit: number;
  remaining: number;
  over: boolean;
  /** True from nine tenths of the limit on, when the counter is worth showing. */
  near: boolean;
}

/** Characters used and left, counted as the server counts them (a character outside the basic plane is one). */
export function budget(text: string): Budget {
  const chars = Array.from(text).length;
  return { chars, limit: MAX_BODY_CHARS, remaining: MAX_BODY_CHARS - chars, over: chars > MAX_BODY_CHARS, near: chars >= MAX_BODY_CHARS * 0.9 };
}

/** Why the message cannot be sent, in the server's own words, or null when it can. */
export function composeProblem(display: string, chosen: readonly ChosenMention[]): string | null {
  const result = normaliseBody(compileMentions(display, chosen));
  return result.ok ? null : result.message;
}

/** A version 4 id from sixteen random bytes. The page passes crypto.getRandomValues; the id is what makes a retried send post once. */
export function newClientId(randomBytes: (length: number) => Uint8Array): string {
  const b = Uint8Array.from(randomBytes(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A message the page has composed and is sending (or could not send). It keeps its id, so trying again cannot post it twice. */
export interface PendingMessage {
  clientId: string;
  conversationId: string;
  body: string;
  threadRootId: string | null;
  attachments: Array<{ id: string; filename: string; mimeType: string; sizeBytes: number }>;
  status: "sending" | "failed";
  error: string | null;
  /** The server's code for a refusal (null for a request that never got an answer), which decides whether trying again can work. */
  errorCode: string | null;
  createdAt: string;
}

/**
 * Whether the Enter key sends the message. With a mouse and keyboard Enter sends and Shift+Enter starts a new line; on a touch screen Enter always starts a new line (there is
 * a Send button, and a phone keyboard has no Shift+Enter). Ctrl or Command with Enter sends in both. While an input method is composing a word, Enter belongs to it.
 */
export function enterSends(event: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; isComposing?: boolean }, finePointer: boolean): boolean {
  if (event.key !== "Enter" || event.isComposing) return false;
  if (event.ctrlKey || event.metaKey) return true;
  return finePointer && !event.shiftKey;
}
