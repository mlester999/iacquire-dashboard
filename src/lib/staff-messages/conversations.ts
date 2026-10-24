// Who may do what in a conversation, and what a conversation may be called. Pure: the server asks these questions of facts it has just read from the database, and the
// screens ask them to decide which buttons to draw. The proposals are marked in docs/staff-messages.md.
//
//   * Everyone on the agency team who may use Messages (agency.messages.use) can write direct messages and start private groups.
//   * Channels (open to the whole team, or by invitation) are for people with agency.messages.channels (managers and the Super Admin, by default).
//   * A conversation's owner runs it. The holder of agency.messages.channels also runs the open (team-wide) channels. Nobody gets to read a private conversation they are
//     not in by holding a role: the Super Admin's moderation (agency.messages.moderate) is for channels, and works on what the moderator is a member of or can archive by id.

import { MAX_NAME_CHARS, MAX_TOPIC_CHARS } from "@/lib/staff-messages/limits";

export type ConversationKind = "direct" | "group" | "channel";
export type ChannelVisibility = "staff" | "private";
export type MemberRole = "owner" | "member";

export interface Caps {
  use: boolean;
  channels: boolean;
  moderate: boolean;
}

export const NO_CAPS: Caps = { use: false, channels: false, moderate: false };

export interface ConversationFacts {
  kind: ConversationKind;
  visibility: ChannelVisibility;
  archived: boolean;
}

/** The person's standing in one conversation right now: what they hold, and their active membership (null when they are not a member). */
export interface Standing {
  caps: Caps;
  memberRole: MemberRole | null;
}

export const canCreate = (kind: ConversationKind, caps: Caps): boolean => caps.use && (kind === "channel" ? caps.channels : true);

export const canRead = (_c: ConversationFacts, s: Standing): boolean => s.caps.use && s.memberRole !== null;

export const canPost = (c: ConversationFacts, s: Standing): boolean => canRead(c, s) && !c.archived;

/** Joining is for open channels; everything else is by invitation. */
export const canJoin = (c: ConversationFacts, s: Standing): boolean => s.caps.use && s.memberRole === null && c.kind === "channel" && c.visibility === "staff" && !c.archived;

/** A direct message has no way out (it is muted instead); anyone else may leave, and an owner leaving hands the conversation on (the service does that). */
export const canLeave = (c: ConversationFacts, s: Standing): boolean => s.memberRole !== null && c.kind !== "direct";

function runs(c: ConversationFacts, s: Standing): boolean {
  if (!s.caps.use || c.kind === "direct") return false;
  if (s.memberRole === "owner") return true;
  return c.kind === "channel" && c.visibility === "staff" && s.caps.channels;
}

/** Add or remove people, rename, change the topic. Not in an archived conversation. */
export const canManageMembers = (c: ConversationFacts, s: Standing): boolean => !c.archived && runs(c, s);
export const canRename = canManageMembers;

/** Archive or bring back. A channel can also be archived by the holder of agency.messages.channels or agency.messages.moderate, who need not be a member to do it. */
export function canArchive(c: ConversationFacts, s: Standing): boolean {
  if (!s.caps.use || c.kind === "direct") return false;
  if (s.memberRole === "owner") return true;
  return c.kind === "channel" && (s.caps.channels || s.caps.moderate);
}

export interface MessageFacts {
  authorId: string | null;
  deleted: boolean;
}

export const canReact = (c: ConversationFacts, s: Standing, m: MessageFacts): boolean => canPost(c, s) && !m.deleted;

/** Only the author edits, and only while the message stands and the conversation is open. */
export const canEditMessage = (c: ConversationFacts, s: Standing, userId: string, m: MessageFacts): boolean => canPost(c, s) && !m.deleted && m.authorId === userId;

/** The author removes their own message. A moderator removes one in a channel they are a member of (they can read it, so they are not given anything new). */
export function canDeleteMessage(c: ConversationFacts, s: Standing, userId: string, m: MessageFacts): boolean {
  if (m.deleted || !canRead(c, s)) return false;
  if (m.authorId === userId) return !c.archived;
  return c.kind === "channel" && s.caps.moderate;
}

export type NameResult = { ok: true; value: string } | { ok: false; message: string };

const isLetterOrDigit = (ch: string): boolean => /^[\p{L}\p{N}]$/u.test(ch);

/** Control codes and line breaks out; runs of spaces become one. A loop over characters. */
function plain(raw: string): string {
  const out: string[] = [];
  let pendingSpace = false;
  for (const ch of raw) {
    const code = ch.codePointAt(0) as number;
    if (code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029 || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) || code === 0x200b || code === 0xfeff) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (ch === " " || code === 160) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) out.push(" ");
    pendingSpace = false;
    out.push(ch);
  }
  return out.join("").normalize("NFC");
}

/**
 * A group's name is free text of 1 to 80 characters. A channel's name is lower case with hyphens, the way people write it after a #: spaces become hyphens, a leading #
 * is dropped, and only letters, numbers, hyphens and underscores remain (two channels never share a name, whatever the case: the database enforces it).
 */
export function normaliseName(kind: "group" | "channel", raw: unknown): NameResult {
  if (typeof raw !== "string" || raw.length > MAX_NAME_CHARS * 4) return { ok: false, message: `A name can be up to ${MAX_NAME_CHARS} characters.` };
  const text = plain(raw);
  if (kind === "group") {
    const n = Array.from(text).length;
    if (n === 0) return { ok: false, message: "Give the group a name." };
    if (n > MAX_NAME_CHARS) return { ok: false, message: `A name can be up to ${MAX_NAME_CHARS} characters.` };
    return { ok: true, value: text };
  }
  const out: string[] = [];
  let lastHyphen = true;
  for (const ch of text.toLowerCase()) {
    if (ch === "#" && out.length === 0) continue;
    if (ch === " " || ch === "-") {
      if (!lastHyphen) out.push("-");
      lastHyphen = true;
    } else if (ch === "_" || isLetterOrDigit(ch)) {
      out.push(ch);
      lastHyphen = false;
    } else return { ok: false, message: "A channel name can use letters, numbers, hyphens and underscores." };
  }
  while (out.length && out[out.length - 1] === "-") out.pop();
  if (out.length === 0) return { ok: false, message: "Give the channel a name." };
  if (out.length > MAX_NAME_CHARS) return { ok: false, message: `A name can be up to ${MAX_NAME_CHARS} characters.` };
  return { ok: true, value: out.join("") };
}

/** A topic is optional, up to 250 characters. Empty means none. */
export function normaliseTopic(raw: unknown): NameResult {
  if (raw === undefined || raw === null) return { ok: true, value: "" };
  if (typeof raw !== "string" || raw.length > MAX_TOPIC_CHARS * 4) return { ok: false, message: `A topic can be up to ${MAX_TOPIC_CHARS} characters.` };
  const text = plain(raw);
  if (Array.from(text).length > MAX_TOPIC_CHARS) return { ok: false, message: `A topic can be up to ${MAX_TOPIC_CHARS} characters.` };
  return { ok: true, value: text };
}
