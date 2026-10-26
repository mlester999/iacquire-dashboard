// Unread is a subtraction: the number of the newest message in a conversation minus the number of the newest one the person has read. Numbers are whole and only grow, so
// "read" can only move forward (two tabs, a late request or a replayed one can never un-read anything). Pure.

const whole = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

/** Messages the person has not read. Never negative, and never more than the conversation holds. */
export function unreadCount(lastSeq: number, lastReadSeq: number): number {
  const last = whole(lastSeq);
  return Math.max(0, last - Math.min(whole(lastReadSeq), last));
}

/** Where the cursor goes when the person says they have read up to `requested`: forward only, and never past the newest message. */
export function advanceCursor(current: number, requested: number, lastSeq: number): number {
  return Math.max(whole(current), Math.min(whole(requested), whole(lastSeq)));
}

/** The number of the first message the person has not read (where a conversation opens, with a marker above it). */
export const firstUnreadSeq = (lastReadSeq: number): number => whole(lastReadSeq) + 1;

export interface RailRow {
  lastSeq: number;
  lastReadSeq: number;
  muted: boolean;
  /** An archived conversation shows no badge: nothing new can arrive in it. */
  archived?: boolean;
}

/** What the navigation badge counts: unread messages in conversations that are neither muted nor archived. A muted one still shows its own count in the list. */
export function badgeTotal(rows: readonly RailRow[]): number {
  let total = 0;
  for (const r of rows) if (!r.muted && !r.archived) total += unreadCount(r.lastSeq, r.lastReadSeq);
  return total;
}

/** The text of a badge: nothing for zero, the number up to 99, then "99+". */
export function badgeText(n: number): string | null {
  const count = whole(n);
  return count === 0 ? null : count > 99 ? "99+" : String(count);
}

/** A bigint column as it arrives from either driver (a number from the embedded database, text from the hosted one) as a safe whole number. */
export function seqOf(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("A message number is outside what can be counted.");
  return n;
}
