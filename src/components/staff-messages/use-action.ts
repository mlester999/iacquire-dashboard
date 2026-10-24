"use client";

import * as React from "react";
import { toast } from "sonner";
import type { ActionResult } from "@/server/action-guard";

// Runs a Messages server action and says what happened. Unlike the shared CRM helper it does not reload the page's server data afterwards: the page keeps its own state and
// the next snapshot corrects it, so a reaction or a read mark does not cost a full page render.

export const NETWORK_FAILURE = "That didn't go through. Check your connection and try again.";

export type Outcome<T> = { ok: true; data: T } | { ok: false; error: string; code: string };

export function useAction() {
  const [pending, setPending] = React.useState<string | null>(null);
  const run = React.useCallback(async <T,>(key: string, fn: () => Promise<ActionResult<T>>, opts: { success?: string; quiet?: boolean } = {}): Promise<Outcome<T>> => {
    setPending(key);
    try {
      const res = await fn();
      if (!res.ok) {
        if (!opts.quiet) toast.error(res.error);
        return { ok: false, error: res.error, code: res.code };
      }
      if (opts.success) toast.success(opts.success);
      return { ok: true, data: res.data };
    } catch {
      if (!opts.quiet) toast.error(NETWORK_FAILURE);
      return { ok: false, error: NETWORK_FAILURE, code: "network" };
    } finally {
      setPending((current) => (current === key ? null : current));
    }
  }, []);
  return { run, pending, busy: (key: string) => pending === key };
}
