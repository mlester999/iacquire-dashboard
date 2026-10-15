import type { ClientSetupRow, HealthLevel } from "@/server/setup/snapshots";

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

export function countStates(rows: ClientSetupRow[]) {
  const counts: Record<StateKey, number> = { not_started: 0, awaiting_onboarding: 0, in_setup: 0, ready_for_review: 0, activated: 0, suspended: 0 };
  rows.forEach((r) => (counts[stateOf(r)] += 1));
  return counts;
}

export function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}
