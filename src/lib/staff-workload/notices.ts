// The words of the two notices this module sends. Plain and specific, with counts and no client name or item title: a notice can be read over a shoulder and is kept in
// the bell. The workload counts only work recorded in iAcquire, and the notice to a manager says so. Pure.

import type { AlertLabel } from "@/lib/staff-workload/alerts";
import { durationText } from "@/lib/staff-workload/alerts";
import { LABEL_TEXT, type WorkloadResult } from "@/lib/staff-workload/labels";
import { formatPoints } from "@/lib/staff-workload/rules";
import { SOURCE_LABELS, SOURCE_PLURAL, WORK_SOURCES, type WorkSource } from "@/lib/staff-workload/sources";

export interface Notice {
  title: string;
  body: string;
  link: string;
}

/** What a person's name in a notice is replaced with once they are no longer on the agency team. */
export const FORMER_PERSON_TEXT = "A former team member";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** To the managers: someone is Overloaded or Critical. */
export function managerAlertNotice(input: { userId: string; name: string; label: AlertLabel; result: WorkloadResult; since: string; criticalSince: string | null; now: Date }): Notice {
  const { result: r } = input;
  const lines: string[] = [];
  if (r.away) lines.push(`Away for the whole planning period with ${formatPoints(r.pointsCenti)} points of work open.`);
  else if (r.capacity !== null) lines.push(`${formatPoints(r.pointsCenti)} points of open work against ${r.capacity} points of capacity over the next ${r.horizonDays} working ${r.horizonDays === 1 ? "day" : "days"}.`);
  if (r.overdue) lines.push(`${plural(r.overdue, "item is", "items are")} overdue.`);
  if (r.escalated) lines.push(`${plural(r.escalated, "request is", "requests are")} escalated.`);
  lines.push(input.label === "critical" && input.criticalSince ? `Critical for ${durationText(input.criticalSince, input.now)}.` : `Overloaded for ${durationText(input.since, input.now)}.`);
  lines.push("Counts only work recorded in iAcquire.");
  return {
    title: `${input.name} is ${LABEL_TEXT[input.label]}`,
    body: lines.join(" "),
    link: `/admin/workload/people/${input.userId}`,
  };
}

/** To the person: some of what is assigned to them is past its due time. */
export function overdueNotice(bySource: Partial<Record<WorkSource, number>>): Notice {
  const parts = WORK_SOURCES.filter((s) => (bySource[s] ?? 0) > 0).map((s) => `${bySource[s]} ${bySource[s] === 1 ? SOURCE_LABELS[s].toLowerCase() : SOURCE_PLURAL[s]}`);
  const total = WORK_SOURCES.reduce((n, s) => n + (bySource[s] ?? 0), 0);
  return {
    title: total === 1 ? "You have 1 overdue item" : `You have ${total} overdue items`,
    body: `${parts.join(", ")} assigned to you ${total === 1 ? "is" : "are"} past ${total === 1 ? "its" : "their"} due time. Open your workload to see which.`,
    link: "/admin/workload/me",
  };
}
