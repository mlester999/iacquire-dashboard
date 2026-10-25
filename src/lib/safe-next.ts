// Where a sign-in sends a person afterwards. Only a path on this site: a leading slash, then no second slash and no backslash (a browser reads `/\evil.com` as `//evil.com`, a
// different site), no scheme, no whitespace or control characters. Anything else is the home page. The sign-in action and the sign-in page (for someone already signed in) both use it.
const SAFE_NEXT = /^\/(?!\/)[A-Za-z0-9/_?=&%.-]*$/;

export function safeNextPath(value: unknown, fallback = "/"): string {
  return typeof value === "string" && value.length <= 600 && SAFE_NEXT.test(value) ? value : fallback;
}
