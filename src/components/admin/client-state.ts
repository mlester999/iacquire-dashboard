import type { ClientSetupRow, HealthLevel } from "@/server/setup/snapshots";
import type { LaunchState } from "@/lib/launch-readiness";

/** Plain module (no "use client") so the server page and the client directory share one definition. */

export type Tone = "neutral" | "warning" | "primary" | "violet" | "success" | "danger";
export type StateKey = "not_started" | "awaiting_onboarding" | "in_setup" | "ready_for_review" | "activated" | "suspended";

export const STATE: Record<StateKey, { label: string; tone: Tone }> = {
  not_started: { label: "Not started", tone: "neutral" },
  awaiting_onboarding: { label: "Awaiting onboarding", tone: "warning" },
  in_setup: { label: "In setup", tone: "primary" },
  ready_for_review: { label: "Final review", tone: "violet" },
  activated: { label: "Approved", tone: "success" },
  suspended: { label: "Suspended", tone: "danger" },
};

export const STATE_ORDER: StateKey[] = ["awaiting_onboarding", "in_setup", "ready_for_review", "activated", "not_started", "suspended"];

export function stateOf(r: ClientSetupRow): StateKey {
  if (r.orgStatus === "suspended") return "suspended";
  if (!r.setup.started) return "not_started";
  if (r.setup.state === "activated") return "activated";
  if (r.setup.state === "ready_for_review") return "ready_for_review";
  if (!r.onboardingCompletedAt) return "awaiting_onboarding";
  return "in_setup";
}

export const HEALTH: Record<HealthLevel, { label: string; tone: Tone }> = {
  healthy: { label: "Healthy", tone: "success" },
  issue: { label: "Needs attention", tone: "danger" },
  partial: { label: "Partly connected", tone: "warning" },
  not_connected: { label: "Not connected", tone: "neutral" },
};

/** The tone of a launch state, the same colours the client's own panel uses. */
export const LAUNCH_TONE: Record<LaunchState, Tone> = {
  not_started: "neutral", questionnaire_submitted: "primary", provisioning: "primary", action_required: "warning", ready_for_review: "violet", ready_to_launch: "success",
};

/** How long a client may sit in one launch state before the agency's list calls it stuck. */
export const LAUNCH_STUCK_HOURS = 24;

/** Waiting on iAcquire: something that is iAcquire's to do blocks the launch. A client that is 100% ready, or has nothing recorded, is not waiting on anyone. */
export function waitingOnIacquire(r: ClientSetupRow): boolean {
  return Boolean(r.launch && r.launch.state !== "ready_to_launch" && r.launch.needsIacquire > 0);
}

/** Stuck: not ready, and in the same launch state for longer than LAUNCH_STUCK_HOURS. `now` is passed in so the answer is the same for the whole list (and testable). */
export function stuckOverDay(r: ClientSetupRow, now: number): boolean {
  if (!r.launch || r.launch.state === "ready_to_launch" || r.launch.state === "not_started") return false;
  return now - new Date(r.launch.since).getTime() > LAUNCH_STUCK_HOURS * 3_600_000;
}

export function countStates(rows: ClientSetupRow[]) {
  const counts: Record<StateKey, number> = { not_started: 0, awaiting_onboarding: 0, in_setup: 0, ready_for_review: 0, activated: 0, suspended: 0 };
  rows.forEach((r) => (counts[stateOf(r)] += 1));
  return counts;
}

export function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}
