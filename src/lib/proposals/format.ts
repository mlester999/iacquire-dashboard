// Small ways of writing facts for the proposal screens. Pure.

/** A moment in the workspace's time zone: "Oct 23, 2026, 8:00 PM". An unknown time zone name falls back to UTC rather than failing a page. */
export function whenIn(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, dateStyle: "medium", timeStyle: "short" }).format(d);
  } catch {
    return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }).format(d);
  }
}

/** A calendar-day-and-time without the clock, for lists. */
export function dayIn(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, dateStyle: "medium" }).format(d);
  } catch {
    return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", dateStyle: "medium" }).format(d);
  }
}

/** The first characters of a content fingerprint, grouped so two can be compared by eye. */
export const shortHash = (hash: string): string => (hash.slice(0, 12).match(/.{1,4}/g) ?? []).join(" ");
