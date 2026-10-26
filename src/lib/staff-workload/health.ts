// Project health: on track, at risk, off track, or not enough data, from rows somebody recorded and nothing else. Pure: the clock is an argument.
//
// The rule, in the order it is applied (the two numbers are in the rules; the Super Admin can change them):
//   * off track:  expected completion has passed, or at least `offTrackOverdueMilestones` milestones are past their day and still open;
//   * at risk:    a milestone is past its day, a milestone is blocked, a review task the team owes is past its time, or nothing has happened for `staleDays` days;
//   * on track:   there is something to measure against (a milestone, a date or a review time) and none of the above;
//   * not enough data: nothing to measure against. A project is never called on track for want of evidence.
// A project waiting for the client (a quote sent, discovery needed, ready for the client's review, a milestone waiting for the client's approval) is shown as waiting and is not
// called stale or late because of it: the team is not blamed for the client's silence. A project on hold has no schedule being measured.

import type { WorkloadRules } from "@/lib/staff-workload/rules";
import { isDay } from "@/lib/staff-workload/sources";

export const HEALTH_STATES = ["on_track", "at_risk", "off_track", "not_enough_data"] as const;
export type ProjectHealthState = (typeof HEALTH_STATES)[number];

export const HEALTH_TEXT: Record<ProjectHealthState, string> = {
  on_track: "On track",
  at_risk: "At risk",
  off_track: "Off track",
  not_enough_data: "Not enough data",
};

/** Statuses in which the next move is the client's. */
export const PROJECT_WAITING_ON_CLIENT: readonly string[] = ["discovery_needed", "quote_sent", "awaiting_approval", "ready_for_review"];

export interface HealthMilestone {
  status: string;
  dueOn: string | null;
}

export interface HealthFacts {
  /** client_project_requests.status. */
  status: string;
  /** client_projects.expected_completion_on, once a quote was agreed. */
  expectedCompletionOn: string | null;
  milestones: readonly HealthMilestone[];
  /** The due times of the review tasks still open; null for one nobody gave a time. */
  openReviewTaskDueAts: ReadonlyArray<string | null>;
  lastActivityAt: string | null;
}

export interface ProjectHealth {
  state: ProjectHealthState;
  reasons: string[];
  /** Who the next move belongs to, when it is not the team. */
  waiting: "client" | "hold" | null;
  /** Milestones done of milestones set; null when none are set. */
  progress: { done: number; total: number } | null;
  overdueMilestones: number;
  blockedMilestones: number;
  overdueReviewTasks: number;
  daysSinceActivity: number | null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function projectHealth(facts: HealthFacts, rules: WorkloadRules, now: Date, today: string): ProjectHealth {
  const open = facts.milestones.filter((m) => m.status !== "completed");
  const waitingMilestones = open.filter((m) => m.status === "awaiting_approval").length;
  const overdueMilestones = open.filter((m) => m.status !== "awaiting_approval" && m.dueOn && isDay(m.dueOn) && m.dueOn < today).length;
  const blockedMilestones = open.filter((m) => m.status === "blocked").length;
  const overdueReviewTasks = facts.openReviewTaskDueAts.filter((t) => t !== null && Number.isFinite(Date.parse(t)) && Date.parse(t) < now.getTime()).length;
  const lastActivity = facts.lastActivityAt ? Date.parse(facts.lastActivityAt) : NaN;
  const daysSinceActivity = Number.isFinite(lastActivity) ? Math.max(0, Math.floor((now.getTime() - lastActivity) / 86_400_000)) : null;
  const progress = facts.milestones.length ? { done: facts.milestones.length - open.length, total: facts.milestones.length } : null;
  const base = { progress, overdueMilestones, blockedMilestones, overdueReviewTasks, daysSinceActivity };

  if (facts.status === "on_hold") {
    return { ...base, state: "not_enough_data", waiting: "hold", reasons: ["The project is on hold, so no schedule is being measured."] };
  }
  const waitingOnClient = PROJECT_WAITING_ON_CLIENT.includes(facts.status);
  const waiting = waitingOnClient ? "client" : null;
  const reasons: string[] = [];
  if (waitingOnClient) reasons.push("Waiting for the client. Their silence is not counted against the team.");
  if (waitingMilestones) reasons.push(`${plural(waitingMilestones, "milestone is", "milestones are")} waiting for the client's approval.`);

  const pastExpected = Boolean(facts.expectedCompletionOn && isDay(facts.expectedCompletionOn) && facts.expectedCompletionOn < today);
  const stale = !waitingOnClient && daysSinceActivity !== null && daysSinceActivity >= rules.health.staleDays;
  const hasSignal = facts.milestones.length > 0 || Boolean(facts.expectedCompletionOn) || facts.openReviewTaskDueAts.some((t) => t !== null);

  const offTrack = pastExpected || overdueMilestones >= rules.health.offTrackOverdueMilestones;
  const atRisk = overdueMilestones > 0 || blockedMilestones > 0 || overdueReviewTasks > 0 || stale;
  if (pastExpected) reasons.push(`The expected completion day (${facts.expectedCompletionOn}) has passed.`);
  if (overdueMilestones) reasons.push(`${plural(overdueMilestones, "milestone is", "milestones are")} past ${overdueMilestones === 1 ? "its day" : "their days"} and still open.`);
  if (blockedMilestones) reasons.push(`${plural(blockedMilestones, "milestone is", "milestones are")} blocked.`);
  if (overdueReviewTasks) reasons.push(`${plural(overdueReviewTasks, "review task is", "review tasks are")} past ${overdueReviewTasks === 1 ? "its time" : "their time"}.`);
  if (stale) reasons.push(`Nothing has been recorded on this project for ${plural(daysSinceActivity as number, "day", "days")}.`);

  if (offTrack) return { ...base, waiting, state: "off_track", reasons };
  if (atRisk) return { ...base, waiting, state: "at_risk", reasons };
  if (!hasSignal) {
    reasons.push("No milestone, expected date or review time is recorded, so there is nothing to measure it against.");
    return { ...base, waiting, state: "not_enough_data", reasons };
  }
  reasons.push(facts.milestones.length ? "No milestone is late or blocked, and nothing is overdue." : "Nothing recorded is overdue.");
  return { ...base, waiting, state: "on_track", reasons };
}
