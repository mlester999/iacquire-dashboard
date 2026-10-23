// Renewal reminders for the customer accounts kept on the retention page. A reminder is for the TEAM (a task and a notice). Nothing here is, or can become, a message to a
// customer: an account on that page has no link to a contact and no record of consent, and a renewal or auto-renewal notice to a customer needs legal review first.

/** Days before the renewal date at which the team is reminded, widest first. */
export const RENEWAL_WINDOWS = [30, 14, 7] as const;
export type RenewalWindow = (typeof RENEWAL_WINDOWS)[number];

/**
 * The reminder an account is due, given how many whole days are left until its renewal (in the workspace's own calendar): the tightest window it has reached, or none. An account
 * first seen 5 days before renewal gets the 7-day reminder only, not a catch-up of the two before it. A renewal that has passed gets nothing.
 */
export function renewalWindow(daysUntil: number): RenewalWindow | null {
  if (!Number.isInteger(daysUntil) || daysUntil < 0 || daysUntil > RENEWAL_WINDOWS[0]) return null;
  let found: RenewalWindow | null = null;
  for (const w of RENEWAL_WINDOWS) if (daysUntil <= w) found = w;
  return found;
}

/** One reminder for one account, renewal date and window: how the job tells it already made this one. */
export const renewalKey = (accountId: string, renewalDate: string, window: RenewalWindow) => `${accountId}:${renewalDate}:${window}`;

export function renewalTitle(name: string, daysUntil: number): string {
  const when = daysUntil === 0 ? "today" : daysUntil === 1 ? "tomorrow" : `in ${daysUntil} days`;
  return `${name.replace(/\s+/g, " ").trim().slice(0, 120)} renews ${when}`;
}
