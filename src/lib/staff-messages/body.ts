// What a message may contain, and the one tidy form it is stored in. Plain text only: it is always shown as text, never as markup. Pure; every step is linear in the
// length of the text (no pattern with nested repeats), so a 20,000 character paste costs about as much as a short one.

import { MAX_BODY_CHARS } from "@/lib/staff-messages/limits";

export type BodyProblem = "not_text" | "empty" | "too_long";
export type BodyResult = { ok: true; body: string; chars: number } | { ok: false; reason: BodyProblem; message: string };

export const BODY_MESSAGES: Record<BodyProblem, string> = {
  not_text: "A message is text.",
  empty: "Write something before you send.",
  too_long: `A message can be up to ${MAX_BODY_CHARS.toLocaleString("en-US")} characters.`,
};

// Characters that are removed: control codes (a new line and a tab stay), the bidirectional overrides and isolates that can make text read in a different order than it was
// written, the zero width space, the word joiner and the byte order mark. The joiners emoji sequences and some scripts need (U+200C, U+200D) and the direction marks stay.
const DROPPED = new Set<number>([0x200b, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0xfeff]);
for (let c = 0x202a; c <= 0x202e; c++) DROPPED.add(c);
for (let c = 0x2066; c <= 0x2069; c++) DROPPED.add(c);

function kept(code: number): boolean {
  if (code === 9 || code === 10) return true;
  if (code < 32 || (code >= 127 && code <= 159)) return false;
  return !DROPPED.has(code);
}

/** The code points of the text without the dropped ones, with every kind of line break turned into a new line, in composed form (after the drops, so a mark that only meets its letter once something between them is gone still joins it). */
function cleaned(text: string): string {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i) as number;
    if (code > 0xffff) i += 1;
    if (code === 13) {
      // A carriage return and the line feed after it are one line break.
      if (text.charCodeAt(i + 1) === 10) i += 1;
      out.push("\n");
    } else if (code === 0x2028 || code === 0x2029) out.push("\n");
    else if (kept(code)) out.push(String.fromCodePoint(code));
  }
  return out.join("").normalize("NFC");
}

/** A line without the spaces and tabs at its end (a loop, not a pattern: a pattern for "spaces then the end" is quadratic on a long run of spaces). */
function trimLineEnd(line: string): string {
  let end = line.length;
  while (end > 0 && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end -= 1;
  return end === line.length ? line : line.slice(0, end);
}

/** Spaces at the end of each line go, and no more than two blank lines in a row stay. */
function tidyLines(text: string): string {
  const out: string[] = [];
  let blank = 0;
  for (const line of text.split("\n")) {
    const trimmed = trimLineEnd(line);
    if (trimmed === "") {
      blank += 1;
      if (blank > 2) continue;
    } else blank = 0;
    out.push(trimmed);
  }
  return out.join("\n");
}

export function normaliseBody(raw: unknown): BodyResult {
  const fail = (reason: BodyProblem): BodyResult => ({ ok: false, reason, message: BODY_MESSAGES[reason] });
  if (typeof raw !== "string") return fail("not_text");
  // Far more than the limit can only be a mistake or an attack: refuse it before working through it. Four times the limit is room for every legal message.
  if (raw.length > MAX_BODY_CHARS * 4) return fail("too_long");
  const body = tidyLines(cleaned(raw)).trim();
  if (!body) return fail("empty");
  const chars = Array.from(body).length;
  if (chars > MAX_BODY_CHARS) return fail("too_long");
  return { ok: true, body, chars };
}
