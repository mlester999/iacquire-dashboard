// Where a workspace's public booking pages and a customer's manage link live. Pure and safe in the browser: paths are relative,
// and an absolute form is built from APP_URL on the server (or an origin the caller passes, such as window.location.origin).

const seg = (s: string) => encodeURIComponent(s.trim().toLowerCase());

/** A calendar's booking page (`/book/<org>/<calendar>`, where the customer picks a type) or one type's page. */
export function bookingUrl(orgSlug: string, calendarSlug: string, typeSlug?: string | null): string {
  const base = `/book/${seg(orgSlug)}/${seg(calendarSlug)}`;
  return typeSlug ? `${base}/${seg(typeSlug)}` : base;
}

/** The confirmation page shown right after booking. It carries the manage secret, so it is never cached or indexed. */
export function bookingConfirmedUrl(orgSlug: string, calendarSlug: string, typeSlug: string, manageToken: string): string {
  return `${bookingUrl(orgSlug, calendarSlug, typeSlug)}/confirmed?booking=${encodeURIComponent(manageToken)}`;
}

/** The customer's own link to see, reschedule or cancel a booking. */
export function manageUrl(token: string): string {
  return `/book/manage/${encodeURIComponent(token)}`;
}

/** The add-to-calendar file for a booking, authorized by its manage secret. */
export function bookingIcsUrl(token: string): string {
  return `/api/public/booking/ics?token=${encodeURIComponent(token)}`;
}

/**
 * The absolute form of a path. `base` defaults to APP_URL, which only the server knows; in the browser pass the page's origin.
 * Without either it returns the path unchanged rather than inventing a host.
 */
export function absoluteUrl(path: string, base?: string | null): string {
  const origin = base ?? (typeof process !== "undefined" ? process.env.APP_URL : undefined);
  if (!origin) return path;
  try {
    return new URL(path, origin).toString();
  } catch {
    return path;
  }
}
