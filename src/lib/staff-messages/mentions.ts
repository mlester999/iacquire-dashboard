// Mentions. A mention is written into the text as <@person-id> (the composer inserts it when a name is chosen), so the text is the single record of who was named and
// a rename never breaks one. The server reads the tokens and checks every one against the conversation's members: a token for anyone else is refused, never trusted. Pure.

import { isUserId } from "@/lib/staff-messages/direct";
import { MAX_MENTIONS } from "@/lib/staff-messages/limits";

const OPEN = "<@";
// "<@" + a 36 character id + ">"
const TOKEN_LENGTH = 39;

export const mentionToken = (userId: string): string => `<@${userId.toLowerCase()}>`;

export interface MentionToken {
  id: string;
  start: number;
  end: number;
}

/** Every well-formed token in the text, in order. A scan with indexOf: no pattern, so no input makes it slow. */
export function findMentionTokens(body: string): MentionToken[] {
  const out: MentionToken[] = [];
  let from = 0;
  for (;;) {
    const at = body.indexOf(OPEN, from);
    if (at === -1) return out;
    const id = body.slice(at + 2, at + 38);
    if (body.charAt(at + 38) === ">" && isUserId(id)) {
      out.push({ id: id.toLowerCase(), start: at, end: at + TOKEN_LENGTH });
      from = at + TOKEN_LENGTH;
    } else from = at + 2;
  }
}

export type MentionResult =
  | { ok: true; ids: string[] }
  | { ok: false; reason: "too_many" | "not_a_member"; message: string };

/** The people a message names, each once, in the order they first appear, if every one of them is in the conversation. */
export function resolveMentions(body: string, memberIds: Iterable<string>): MentionResult {
  const members = new Set(Array.from(memberIds, (id) => id.toLowerCase()));
  const ids = [...new Set(findMentionTokens(body).map((t) => t.id))];
  if (ids.length > MAX_MENTIONS) return { ok: false, reason: "too_many", message: `A message can mention up to ${MAX_MENTIONS} people.` };
  if (ids.some((id) => !members.has(id))) return { ok: false, reason: "not_a_member", message: "You mentioned someone who is not in this conversation. Add them first, or take the mention out." };
  return { ok: true, ids };
}

export type MentionSegment = { type: "text"; text: string } | { type: "mention"; id: string };

/** The text cut into plain runs and mentions, for a screen to show a name where a token is. A token for someone the screen cannot name is still a mention segment. */
export function splitMentions(body: string): MentionSegment[] {
  const out: MentionSegment[] = [];
  let cursor = 0;
  for (const token of findMentionTokens(body)) {
    if (token.start > cursor) out.push({ type: "text", text: body.slice(cursor, token.start) });
    out.push({ type: "mention", id: token.id });
    cursor = token.end;
  }
  if (cursor < body.length) out.push({ type: "text", text: body.slice(cursor) });
  return out;
}

/** The text with each mention turned into "@name" (or "@someone"), for a notification or a search result that must not carry an id. */
export function plainMentions(body: string, nameOf: (id: string) => string | null): string {
  return splitMentions(body).map((s) => (s.type === "text" ? s.text : `@${nameOf(s.id) ?? "someone"}`)).join("");
}
