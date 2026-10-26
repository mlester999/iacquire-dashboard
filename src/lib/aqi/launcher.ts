/**
 * Whether the floating AQi launcher must sit above a page's bottom composer. Only the paths with a composer need it; elsewhere it sits in the
 * normal bottom-right corner. Kept pure so the routing cases can be tested without a browser.
 */
export function aqiLauncherRaised(pathname: string | null): boolean {
  const path = pathname ?? "";
  return path.startsWith("/chat") || /^\/admin\/messages\/[0-9a-f-]{36}/.test(path);
}
