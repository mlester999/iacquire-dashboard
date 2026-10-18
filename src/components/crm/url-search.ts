// A list screen's search box and the address bar it drives. Typing changes the URL's `q` after a pause (router.replace, so pauses don't
// pile up in history); a search changed anywhere else (Back, a navigation link, a filter that clears it) replaces the box's text. The
// decisions are pure functions so they can be tested without a browser; useUrlSearch wires them to React.
import * as React from "react";

/**
 * `seen` is the search the page last loaded with, `sent` what this box asked for since (null once the page has loaded again), and
 * `version` the server's state object for that page load: every load, a refresh included, brings a new one.
 */
export interface SearchSync {
  text: string;
  seen: string;
  sent: string | null;
  version: unknown;
}

export function initialSearch(urlQ: string, version: unknown): SearchSync {
  return { text: urlQ, seen: urlQ, sent: null, version };
}

/**
 * The box after the page loads again. When the load carries the search this box sent, or the same search as before, whatever has been
 * typed since stays; any other search came from elsewhere and replaces the text.
 */
export function followUrlSearch(s: SearchSync, urlQ: string, version: unknown): SearchSync {
  if (version === s.version) return s;
  const fromElsewhere = urlQ !== s.seen && urlQ !== s.sent;
  return { text: fromElsewhere ? urlQ : s.text, seen: urlQ, sent: null, version };
}

/**
 * What to send after a pause in typing: the trimmed text, or null when the page already shows that search or it is on its way. Spaces
 * at either end are never sent, so they can't make the box and the address disagree for ever (a refetch every pause).
 */
export function searchToSend(s: SearchSync): string | null {
  const next = s.text.trim();
  return next === s.seen || next === s.sent ? null : next;
}

/**
 * The search box's state. `urlQ` is the search the page was loaded with and `version` the server's state object for that load; `send`
 * changes the address (with router.replace) and is called with the latest props when the pause ends. Use `reset` when the caller changes
 * the address itself (a Clear button), so the pause doesn't send the old search back.
 */
export function useUrlSearch(urlQ: string, version: object, send: (q: string) => void, delay = 300) {
  const [sync, setSync] = React.useState(() => initialSearch(urlQ, version));
  const current = followUrlSearch(sync, urlQ, version);
  if (current !== sync) setSync(current);
  const next = searchToSend(current);
  const onPause = React.useEffectEvent((q: string) => {
    setSync((s) => ({ ...s, sent: q }));
    send(q);
  });
  React.useEffect(() => {
    if (next === null) return;
    const t = setTimeout(() => onPause(next), delay);
    return () => clearTimeout(t);
  }, [next, delay]);
  const setText = React.useCallback((text: string) => setSync((s) => ({ ...s, text })), []);
  const reset = React.useCallback((text = "") => setSync((s) => ({ ...s, text, sent: text.trim() })), []);
  return { text: current.text, setText, reset };
}
