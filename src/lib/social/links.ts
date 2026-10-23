// Addresses a person typed or a platform returned, checked before they become a link anyone can click. Pure.

export const LINK_NOT_HTTPS = "Paste the full link, starting with https://";

/**
 * The address as a normalised https URL, or null when it is not one. Surrounding spaces are trimmed. A scheme-less value ("facebook.com/page/posts/1"), another
 * scheme (http:, data:, javascript:), an address with a sign-in embedded in it, or one longer than `max` is not a link to show.
 */
export function httpsUrl(raw: string | null | undefined, max = 500): string | null {
  const v = raw?.trim();
  if (!v || v.length > max) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || !u.hostname || u.username || u.password) return null;
  return u.toString();
}
