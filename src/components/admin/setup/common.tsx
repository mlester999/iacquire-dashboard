"use client";

import * as React from "react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/overlays";
import { STATUS_LABEL, type AgencyEventView, type AgencySetupSnapshot, type AgencyTaskView, type CompletionMode } from "@/lib/setup";
import { cn } from "@/lib/utils";

export type ActResult = { ok: true; data?: unknown } | { ok: false; error: string };

/** Runs a server action with consistent busy state, error toasts and an immediate refetch. */
export type Act = <T extends ActResult>(key: string, fn: () => Promise<T>, success?: string) => Promise<T | null>;

export function useAct(refresh: () => Promise<void>, enabled = true) {
  const [busy, setBusy] = React.useState<string | null>(null);
  const act: Act = React.useCallback(
    async (key, fn, success) => {
      if (!enabled) { toast("Design preview only. No change was saved."); return null; }
      setBusy(key);
      try {
        const res = await fn();
        if (!res.ok) {
          toast.error(res.error);
          return res;
        }
        if (success) toast.success(success);
        await refresh();
        return res;
      } catch {
        toast.error("Something went wrong. Please try again.");
        return null;
      } finally {
        setBusy(null);
      }
    },
    [refresh, enabled],
  );
  return { busy, act };
}

export const MODE_LABEL: Record<CompletionMode, string> = {
  manual: "Manual",
  verified: "System check",
  activation: "Final approval",
};

export const MODE_HINT: Record<CompletionMode, string> = {
  manual: "Staff mark this complete.",
  verified: "Only a passing system check completes this. An agency attestation records evidence for review.",
  activation: "Completed only by approving activation.",
};

export function CheckRow({ id, label, hint, checked, onChange, disabled }: { id: string; label: React.ReactNode; hint?: React.ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label htmlFor={id} className={cn("flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-surface px-3 py-2.5 transition hover:border-line-strong", disabled && "cursor-not-allowed opacity-60")}>
      <input id={id} type="checkbox" className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="min-w-0 text-[13.5px] leading-snug text-ink">
        {label}
        {hint && <span className="mt-0.5 block text-[12.5px] text-muted">{hint}</span>}
      </span>
    </label>
  );
}

export function SwitchRow({ id, label, hint, checked, onChange, disabled }: { id: string; label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <label htmlFor={id} className="min-w-0 text-[13.5px] font-medium text-ink">
        {label}
        {hint && <span className="mt-0.5 block text-[12.5px] font-normal text-muted">{hint}</span>}
      </label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}

const ACTOR = (e: AgencyEventView) => e.actor ?? (e.actorKind === "system" ? "System" : e.actorKind === "client" ? "Client" : "Team member");

/** One readable line per audit event. Staff-only reasons are rendered separately by the caller. */
export function eventLabel(e: AgencyEventView, tasks: Map<string, AgencyTaskView>): string {
  const who = ACTOR(e);
  const task = e.taskId ? tasks.get(e.taskId)?.title : null;
  const on = task ? ` “${task}”` : "";
  switch (e.event) {
    case "status_changed":
      return `${who} moved${on} from ${e.fromStatus ? STATUS_LABEL[e.fromStatus] : "—"} to ${e.toStatus ? STATUS_LABEL[e.toStatus] : "—"}`;
    case "reopened":
      return `${who} reopened${on} (was ${e.fromStatus ? STATUS_LABEL[e.fromStatus] : "Completed"})`;
    case "note":
      return `${who} added ${e.visibility === "client" ? "a client-visible note" : "an internal note"}${task ? ` to “${task}”` : ""}`;
    case "details_changed":
      return `${who} edited details${on}`;
    case "assigned":
      return `${who} changed the assignee${on}`;
    case "dependencies_changed":
      return `${who} changed prerequisites${on}`;
    case "attachment_added":
      return `${who} added an attachment${on}`;
    case "attachment_removed":
      return `${who} removed an attachment${on}`;
    case "visibility_changed":
      return `${who} changed whether${on} applies`;
    case "reordered":
      return `${who} reordered the checklist`;
    case "client_requested":
      return `${who} asked the client for something${on}`;
    case "client_responded":
      return `${who} responded${on}${e.toStatus ? ` — now ${STATUS_LABEL[e.toStatus]}` : ""}`;
    case "verified":
      return `${who} verified${on}`;
    case "attested":
      return `${who} attested${on} (not machine-verified)`;
    case "check_run":
      return `${who} ran readiness checks`;
    case "ready_for_review":
      return `${who} marked the setup ready for final review`;
    case "sent_back":
      return `${who} returned the setup to the team`;
    case "activated":
      return `${who} approved activation`;
    case "services_changed":
      return `${who} changed the services included`;
    case "task_created":
      return `${who} added${on}`;
    case "instance_created":
      return "Checklist created";
    case "template_expanded":
      return "Detailed milestones added to the checklist";
    default:
      return `${who} updated${on}`;
  }
}

export function snapshotTasks(s: AgencySetupSnapshot) {
  return new Map(s.tasks.map((t) => [t.id, t]));
}

export function initialsOf(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}
