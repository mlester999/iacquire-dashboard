"use client";

import * as React from "react";
import { toast } from "sonner";
import { StatusPill } from "@/components/ui/status";
import { PROJECT_STATUS_LABEL, PROJECT_STATUS_TONE, type ProjectStatus } from "@/lib/projects";
import { cn } from "@/lib/utils";

export function ProjectStatusBadge({ status, className }: { status: ProjectStatus; className?: string }) {
  return (
    <StatusPill tone={PROJECT_STATUS_TONE[status]} className={className}>
      {PROJECT_STATUS_LABEL[status]}
    </StatusPill>
  );
}

export function Chip({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn("inline-flex items-center rounded-full bg-surface-2 px-2.5 py-0.5 text-[12px] ring-1 ring-inset ring-line font-medium text-ink-2", className)}>{children}</span>;
}

/** Result shape returned by the portal's server actions. */
export type ActionResult<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

/** Runs a server action, toasting failures and (optionally) successes. Returns the data or null. */
export function useRunner() {
  const [pending, setPending] = React.useState<string | null>(null);
  const run = React.useCallback(async <T,>(key: string, fn: () => Promise<ActionResult<T>>, success?: string): Promise<T | null> => {
    setPending(key);
    try {
      const res = await fn();
      if (!res.ok) {
        toast.error(res.error);
        return null;
      }
      if (success) toast.success(success);
      return res.data;
    } catch {
      toast.error("Something went wrong. Please try again.");
      return null;
    } finally {
      setPending(null);
    }
  }, []);
  return { run, pending, isPending: (key?: string) => (key ? pending === key : pending !== null) };
}

export function bytesLabel(n: number) {
  return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}
