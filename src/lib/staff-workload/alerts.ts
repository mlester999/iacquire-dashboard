// When the history gets a new row, when an alert opens, changes or ends, and how long it has lasted. Pure: the clock is an argument.

import type { WorkloadLabel } from "@/lib/staff-workload/labels";

/** How much one run of the snapshot job may do before it stops and leaves the rest to the next run, so a tick (cut off at 120 seconds) is never held up by it. */
export const SNAPSHOT_BUDGET_MS = 30_000;
/** Snapshots and finished alerts are kept this long. The database repeats it (0097). */
export const HISTORY_RETENTION_DAYS = 400;
/** Time off that ended longer ago than this is removed: nobody needs a colleague's old sick days. */
export const TIME_OFF_RETENTION_DAYS = 400;

export type AlertLabel = "overloaded" | "critical";
export const isAlertLabel = (label: WorkloadLabel | null): label is AlertLabel => label === "overloaded" || label === "critical";

export interface OpenAlert {
  label: AlertLabel;
  since: string;
  criticalSince: string | null;
}

export type AlertDecision =
  | { action: "none" }
  | { action: "open"; label: AlertLabel; since: string; criticalSince: string | null }
  | { action: "change"; label: AlertLabel; criticalSince: string | null }
  | { action: "resolve" };

/**
 * One open alert per person. It opens when the label becomes Overloaded or Critical, follows the label between those two (Critical starts its own clock), and ends the moment the
 * label is anything else, including no label at all: an alert is never kept on a label that is no longer there.
 */
export function decideAlert(open: OpenAlert | null, label: WorkloadLabel | null, now: Date): AlertDecision {
  if (!isAlertLabel(label)) return open ? { action: "resolve" } : { action: "none" };
  const stamp = now.toISOString();
  if (!open) return { action: "open", label, since: stamp, criticalSince: label === "critical" ? stamp : null };
  if (open.label === label) return { action: "none" };
  return { action: "change", label, criticalSince: label === "critical" ? stamp : null };
}

export type SnapshotKind = "daily" | "change";

/**
 * Whether the history needs a new row: one for each day (in the agency's time zone), and one whenever the label or the points differ from the latest row. A run that finds
 * nothing new writes nothing, so running twice in a minute leaves one row.
 */
export function snapshotKind(last: { label: WorkloadLabel | null; pointsCenti: number } | null, current: { label: WorkloadLabel | null; pointsCenti: number }, dailyDone: boolean): SnapshotKind | null {
  if (!dailyDone) return "daily";
  if (!last || last.label !== current.label || last.pointsCenti !== current.pointsCenti) return "change";
  return null;
}

/** "under an hour", "5 hours", "2 days": how long something has lasted, for "Critical for 5 hours". */
export function durationText(since: string, now: Date): string {
  const ms = now.getTime() - Date.parse(since);
  if (!Number.isFinite(ms) || ms < 3_600_000) return "under an hour";
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 48) return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = Math.floor(hours / 24);
  return `${days} days`;
}

/** The key that makes a manager's notice once per person, label and day. */
export const managerNoticeKey = (userId: string, label: AlertLabel, day: string) => `workload:${userId}:${label}:${day}`;
/** The key that makes an assignee's overdue notice once per day. */
export const overdueNoticeKey = (userId: string, day: string) => `overdue:${userId}:${day}`;
