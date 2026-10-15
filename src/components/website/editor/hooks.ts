import * as React from "react";

/**
 * Runs `reset` at the moment `open` turns true, while rendering (the way React recommends for resetting state when an input changes),
 * so a dialog always opens fresh without an effect that sets state after the fact.
 */
export function useResetOnOpen(open: boolean, reset: () => void) {
  const [was, setWas] = React.useState(open);
  if (open !== was) {
    setWas(open);
    if (open) reset();
  }
}

/**
 * Text being typed into a field whose real value lives elsewhere. It shows what was typed until the real value changes, at which point the
 * real value wins again. Used where only valid input is committed, so a half-typed value never reaches the document.
 */
export function useDraft(value: string): [string, (text: string) => void] {
  const [draft, setDraft] = React.useState<{ base: string; text: string } | null>(null);
  const shown = draft && draft.base === value ? draft.text : value;
  return [shown, (text) => setDraft({ base: value, text })];
}

/** True once running in the browser (portals need a document). */
export const useMounted = () => React.useSyncExternalStore(() => () => undefined, () => true, () => false);
