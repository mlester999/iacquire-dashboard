// Where a conversation's scroll position goes when something changes, and when the person has read what is on screen. Pure: the page measures, these decide.

export type ScrollAction = "bottom" | "keep-position" | "stay";

/** Distance from the bottom, in pixels, within which a person counts as reading the newest messages (a little slack for rounding and a half-visible line). */
export const NEAR_BOTTOM_PX = 80;

export const isNearBottom = (scrollHeight: number, scrollTop: number, clientHeight: number): boolean => scrollHeight - scrollTop - clientHeight <= NEAR_BOTTOM_PX;

export interface ScrollChange {
  /** The first time this conversation is drawn. */
  initial: boolean;
  /** Whether the person was at the bottom just before the change. */
  wasAtBottom: boolean;
  /** A message was added after the newest one shown. */
  appendedNewest: boolean;
  /** Older messages were added above the first one shown. */
  prependedOlder: boolean;
  /** The newest message is the person's own. */
  ownMessage: boolean;
}

/**
 * New messages at the end follow the person only if they were already at the end (someone reading up the page is not pulled away), their own message always brings them
 * down, and older messages added above must not move what they are reading.
 */
export function scrollPlan(change: ScrollChange): ScrollAction {
  if (change.initial) return "bottom";
  if (change.prependedOlder && !change.appendedNewest) return "keep-position";
  if (change.appendedNewest && (change.wasAtBottom || change.ownMessage)) return "bottom";
  return "stay";
}

export interface ReadFacts {
  /** The tab is on screen and has focus (a hidden tab reads nothing). */
  visible: boolean;
  /** The person is looking at the newest messages, not at older ones. */
  atBottom: boolean;
  /** The window shows the newest messages (not a page around an old search hit). */
  showingNewest: boolean;
  lastSeq: number;
  lastReadSeq: number;
  /** The highest number already sent as read from this page, so it is not sent twice. */
  sentSeq: number;
}

/** The number to tell the server the person has read up to, or null if there is nothing new to say. */
export function readTarget(facts: ReadFacts): number | null {
  if (!facts.visible || !facts.atBottom || !facts.showingNewest) return null;
  const known = Math.max(facts.lastReadSeq, facts.sentSeq);
  return facts.lastSeq > known ? facts.lastSeq : null;
}
