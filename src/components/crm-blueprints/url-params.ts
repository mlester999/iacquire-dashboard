// One-time address parameters (?new=1, ?capture=<orgId>, ?publish=1) open a dialog once. They are taken out of the address when that
// dialog closes, so a refresh or a shared link doesn't open it again. Everything else in the address (tabs, filters) stays.

/** The query string without the named parameters, without a leading "?". Pure. */
export function withoutParams(search: string, names: readonly string[]): string {
  const q = new URLSearchParams(search);
  for (const n of names) q.delete(n);
  return q.toString();
}

/** Removes the named parameters from the address without navigating (Next.js keeps its router in step with the history API). */
export function dropParams(...names: string[]): void {
  if (typeof window === "undefined") return;
  const current = new URLSearchParams(window.location.search);
  if (!names.some((n) => current.has(n))) return;
  const text = withoutParams(window.location.search, names);
  window.history.replaceState(null, "", `${window.location.pathname}${text ? `?${text}` : ""}${window.location.hash}`);
}
