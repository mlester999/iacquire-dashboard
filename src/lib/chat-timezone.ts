export const DEFAULT_CHAT_TIME_ZONE = "UTC";
const ACCOUNT_TIME_ZONE_CONFIGURED = "preferredDisplayTimezoneConfigured";

function validTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** The account timezone is an override only after the user has chosen one; UTC is the database default. */
export function preferredChatTimeZone(accountTimeZone: unknown, preferences: unknown): string | null {
  if (!validTimeZone(accountTimeZone)) return null;
  const prefs = preferences && typeof preferences === "object" ? preferences as Record<string, unknown> : null;
  const explicitlyConfigured = prefs?.[ACCOUNT_TIME_ZONE_CONFIGURED] === true;
  // Before the explicit preference marker was added, any non-default value came from the account setting.
  return explicitlyConfigured || accountTimeZone !== DEFAULT_CHAT_TIME_ZONE ? accountTimeZone : null;
}

/** Choose the saved display preference first, then the browser's IANA timezone, with UTC as a safe fallback. */
export function resolveChatTimeZone(preferred: unknown, browser: unknown): string {
  if (validTimeZone(preferred)) return preferred;
  if (validTimeZone(browser)) return browser;
  return DEFAULT_CHAT_TIME_ZONE;
}

/** Must only be called after mount; server and hydration renders use the same stable UTC fallback. */
export function detectBrowserTimeZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return validTimeZone(zone) ? zone : null;
  } catch {
    return null;
  }
}
