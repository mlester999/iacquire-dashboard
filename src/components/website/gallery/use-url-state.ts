"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";

/**
 * A handful of view settings (search, filters, collection, layout) kept in the page's query string. The page renders from React state, so typing
 * is immediate; the address mirrors it with the browser's own history API, which Next.js keeps in step with its router. Coming back from a
 * preview, an editor or a refresh therefore lands on the same view, and the address can be shared. Values equal to their default stay out of the
 * address, and a value outside `allowed` is ignored, so an edited link cannot put the page into a state it has no control for.
 */
export function useUrlState<T extends Record<string, string>>(defaults: T, allowed: { [K in keyof T]?: readonly string[] } = {}): [T, (patch: Partial<T>) => void] {
  const search = useSearchParams();
  const [state, setState] = React.useState<T>(() => {
    const next: Record<string, string> = { ...defaults };
    for (const key of Object.keys(defaults)) {
      const value = search.get(key);
      const options = allowed[key];
      if (value !== null && value !== "" && (!options || options.includes(value))) next[key] = value;
    }
    return next as T;
  });
  const current = React.useRef(state);
  const set = React.useCallback((patch: Partial<T>) => {
    const next = { ...current.current, ...patch } as T;
    current.current = next;
    setState(next);
    const query = new URLSearchParams(window.location.search);
    for (const key of Object.keys(defaults)) {
      if (next[key] === defaults[key] || next[key] === "") query.delete(key);
      else query.set(key, next[key]);
    }
    const text = query.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${text ? `?${text}` : ""}${window.location.hash}`);
    // `defaults` is a module-level constant at every call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return [state, set];
}
