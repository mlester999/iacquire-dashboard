// Who is told about a message, and in what words. In-app only: a notice never carries message text (the title is generic, the body names the sender and where), and the
// email job sends these kinds as a title and a link only. One notice per unread burst: while a person has not read past the point they had reached when the first new message
// arrived, further messages in that conversation do not add notices. Pure.

import type { ConversationKind } from "@/lib/staff-messages/conversations";

export type NoticeKind = "staff_message_direct" | "staff_message_mention" | "staff_message_added";

export interface Recipient {
  userId: string;
  notify: "all" | "mentions" | "none";
  muted: boolean;
  /** The newest message the person has read, before this one. */
  lastReadSeq: number;
}

export interface PlannedNotice {
  userId: string;
  kind: NoticeKind;
  dedupeKey: string;
}

export interface MessageFacts {
  conversationId: string;
  messageId: string;
  authorId: string;
  mentions: readonly string[];
}

/**
 * Notices for a new message. Never the author. A person whose setting is "nothing" hears nothing; a mention always reaches everyone else (a muted conversation is silenced
 * for ordinary messages only); an ordinary message reaches those who chose "everything" and have not muted it. A mention is one notice per message; an ordinary message is
 * one notice per unread burst (the key carries how far the person had read).
 */
export function planMessageNotices(message: MessageFacts, recipients: readonly Recipient[]): PlannedNotice[] {
  const mentioned = new Set(message.mentions.map((id) => id.toLowerCase()));
  const out: PlannedNotice[] = [];
  for (const r of recipients) {
    if (r.userId === message.authorId || r.notify === "none") continue;
    if (mentioned.has(r.userId.toLowerCase())) out.push({ userId: r.userId, kind: "staff_message_mention", dedupeKey: `staffmention:${message.messageId}` });
    else if (r.notify === "all" && !r.muted) out.push({ userId: r.userId, kind: "staff_message_direct", dedupeKey: `staffmsg:${message.conversationId}:${r.lastReadSeq}` });
  }
  return out;
}

export interface NoticeWords {
  title: string;
  body: string;
}

/** Plain words for a notice. `where` is the conversation's name (not used for a direct message, which is named by the sender). */
export function noticeWords(kind: NoticeKind, conversation: ConversationKind, sender: string, where: string | null): NoticeWords {
  const place = conversation === "channel" ? `#${where ?? "channel"}` : (where ?? "a group");
  if (kind === "staff_message_mention") return { title: "You were mentioned", body: conversation === "direct" ? `${sender} mentioned you in a direct message.` : `${sender} mentioned you in ${place}.` };
  if (kind === "staff_message_added") return { title: "You were added to a conversation", body: conversation === "direct" ? `${sender} started a direct message with you.` : `${sender} added you to ${place}.` };
  if (conversation === "direct") return { title: "New direct message", body: `From ${sender}.` };
  return { title: conversation === "channel" ? "New message in a channel" : "New message in a group", body: `${sender} wrote in ${place}.` };
}

/** Where the notice leads. */
export const noticeLink = (conversationId: string): string => `/admin/messages/${conversationId}`;
