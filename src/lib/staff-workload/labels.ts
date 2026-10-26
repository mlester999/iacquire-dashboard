// From a person's open work and available time to a label, with the reasons. Pure and exact: points are whole hundredths, thresholds are whole percents, and every
// comparison is between integers, so a person exactly on a boundary always gets the same label. Nothing here reads a clock: `now` and `today` are arguments.
//
// The five labels are Available, Balanced, Busy, Overloaded and Critical. A label comes from the ratio of open points to capacity; floors raise it when real facts (overdue
// items, an escalated request) say more than the points do. Capacity that cannot be determined gives no label at all, and the counts are still shown.

import { CAPACITY_NOT_SET_TEXT, formatPoints, itemPointsCenti, type WorkloadRules } from "@/lib/staff-workload/rules";
import { hasDueDate, isOverdue, type WorkItem } from "@/lib/staff-workload/sources";

export const LABELS = ["available", "balanced", "busy", "overloaded", "critical"] as const;
export type WorkloadLabel = (typeof LABELS)[number];

export const LABEL_TEXT: Record<WorkloadLabel, string> = {
  available: "Available",
  balanced: "Balanced",
  busy: "Busy",
  overloaded: "Overloaded",
  critical: "Critical",
};

export const labelRank = (label: WorkloadLabel | null): number => (label === null ? LABELS.length : LABELS.indexOf(label));
const higher = (a: WorkloadLabel, b: WorkloadLabel): WorkloadLabel => (labelRank(a) >= labelRank(b) ? a : b);

export type CapacitySource = "person" | "default" | "none";

export interface CapacityFacts {
  /** Points over the whole horizon, before time off. Null when neither the person nor the team has one. */
  capacityPoints: number | null;
  source: CapacitySource;
  /** Half days the person can work in the horizon (see availableHalfDays). */
  availableHalfDays: number;
  horizonDays: number;
}

/** A person's own capacity, else the team default, else none. */
export function resolveCapacity(personCapacity: number | null, rules: WorkloadRules, availableHalfDays: number): CapacityFacts {
  const own = personCapacity !== null && personCapacity > 0 ? personCapacity : null;
  const capacityPoints = own ?? rules.defaultCapacityPoints;
  return {
    capacityPoints,
    source: own !== null ? "person" : rules.defaultCapacityPoints !== null ? "default" : "none",
    availableHalfDays,
    horizonDays: rules.horizonDays,
  };
}

/**
 * The label for open points against capacity, before the floors. `pointsCenti * 2 * horizon >= percent * capacity * availableHalfDays` is "points are at least that percent
 * of the capacity that is left", written without division. With no time left the answer is Critical if anything is open (nothing can be done on it) and Available if not.
 */
export function labelForRatio(pointsCenti: number, cap: CapacityFacts, rules: WorkloadRules): WorkloadLabel | null {
  if (cap.capacityPoints === null) return null;
  if (cap.availableHalfDays <= 0) return pointsCenti > 0 ? "critical" : "available";
  const atLeast = (percent: number) => pointsCenti * 2 * cap.horizonDays >= percent * cap.capacityPoints! * cap.availableHalfDays;
  const t = rules.thresholds;
  if (atLeast(t.criticalFrom)) return "critical";
  if (atLeast(t.overloadedFrom)) return "overloaded";
  if (atLeast(t.busyFrom)) return "busy";
  if (atLeast(t.balancedFrom)) return "balanced";
  return "available";
}

/** The least a label can be, from overdue items and escalations. */
export function floorFor(overdue: number, escalated: number, rules: WorkloadRules): { label: WorkloadLabel | null; why: string | null } {
  const f = rules.floors;
  if (overdue >= f.criticalAtOverdue) return { label: "critical", why: `${overdue} items are overdue, so the label is Critical.` };
  if (overdue >= f.overloadedAtOverdue) return { label: "overloaded", why: `${overdue} items are overdue, so the label is at least Overloaded.` };
  if (escalated > 0) return { label: "overloaded", why: `${escalated === 1 ? "An escalated request is" : `${escalated} escalated requests are`} open, so the label is at least Overloaded.` };
  if (overdue >= f.busyAtOverdue) return { label: "busy", why: `${overdue === 1 ? "An item is" : `${overdue} items are`} overdue, so the label is at least Busy.` };
  return { label: null, why: null };
}

export interface WorkloadQuality {
  /** The label rests on the team default, not on a number a manager set for this person. */
  capacityFromDefault: boolean;
  /** Open items nobody gave a date. They cannot be overdue, and are not counted as on track. */
  itemsWithoutDueDate: number;
  /** Support requests that count here while response targets are off, so none can be overdue. */
  supportOverdueUnknown: number;
  /** Maintenance requests have no due date at all. */
  maintenanceWithoutDueDate: number;
}

export interface WorkloadResult {
  /** Null when capacity cannot be determined. */
  label: WorkloadLabel | null;
  /** Hundredths of a point, as computed; `points` is the same for display. */
  pointsCenti: number;
  points: number;
  /** The share of capacity that is left, in points. Null when capacity is not set. */
  capacity: number | null;
  capacityPoints: number | null;
  capacitySource: CapacitySource;
  availableDays: number;
  horizonDays: number;
  /** Points as a percent of the capacity that is left. Null when capacity is not set or there is no time left. */
  ratioPercent: number | null;
  items: number;
  overdue: number;
  escalated: number;
  /** Nothing can be worked in the whole horizon. */
  away: boolean;
  reasons: string[];
  quality: WorkloadQuality;
}

export interface WorkloadInput {
  items: readonly WorkItem[];
  capacity: CapacityFacts;
  rules: WorkloadRules;
  now: Date;
  /** Today in the agency's time zone. */
  today: string;
  /** Whether Support's response targets are switched on; off means no support request has a due time. */
  supportTargetsEnabled: boolean;
}

const round = (value: number, places: number) => {
  const f = 10 ** places;
  return Math.round(value * f) / f;
};

export function computeWorkload(input: WorkloadInput): WorkloadResult {
  const { items, capacity: cap, rules, now, today } = input;
  let pointsCenti = 0;
  let overdue = 0;
  let escalated = 0;
  let undated = 0;
  let support = 0;
  let maintenance = 0;
  for (const item of items) {
    pointsCenti += itemPointsCenti(item, rules);
    if (isOverdue(item, now, today)) overdue += 1;
    if (item.escalated) escalated += 1;
    if (!hasDueDate(item)) undated += 1;
    if (item.source === "support") support += 1;
    if (item.source === "maintenance") maintenance += 1;
  }
  const away = cap.availableHalfDays <= 0;
  const base = labelForRatio(pointsCenti, cap, rules);
  const floor = floorFor(overdue, escalated, rules);
  // No capacity, no label: a floor cannot invent the other half of the ratio. The overdue and escalated counts are still returned.
  const label = base === null ? null : floor.label ? higher(base, floor.label) : base;
  const available = cap.capacityPoints === null ? null : round((cap.capacityPoints * cap.availableHalfDays) / (2 * cap.horizonDays), 2);
  const ratioPercent = cap.capacityPoints === null || away ? null : round((pointsCenti * 2 * cap.horizonDays) / (cap.capacityPoints * cap.availableHalfDays), 1);

  const reasons: string[] = [];
  const days = cap.horizonDays === 1 ? "working day" : "working days";
  if (cap.capacityPoints === null) {
    reasons.push(`${CAPACITY_NOT_SET_TEXT}, so no label is shown. Set a capacity for this person, or a team default in the rules.`);
  } else if (away) {
    reasons.push(pointsCenti > 0
      ? `Away for the whole of the next ${cap.horizonDays} ${days} (time off or days not worked), with ${formatPoints(pointsCenti)} points of work open: nothing can be done on it, so the label is Critical.`
      : `Away for the whole of the next ${cap.horizonDays} ${days} (time off or days not worked), with no work open.`);
  } else {
    const left = cap.availableHalfDays / 2;
    reasons.push(`${formatPoints(pointsCenti)} points of open work against ${available} points of capacity over the next ${cap.horizonDays} ${days} (${ratioPercent}%).`);
    if (cap.availableHalfDays < cap.horizonDays * 2) reasons.push(`Capacity is reduced because ${left} of the ${cap.horizonDays} ${days} can be worked (time off or days not worked).`);
  }
  if (cap.source === "default") reasons.push(`Capacity is the team default of ${cap.capacityPoints} points, not a number set for this person.`);
  // A floor is explained only when it changed the answer: when the points already gave the same label or a higher one, it said nothing new.
  if (floor.why && label !== null && base !== null && labelRank(label) > labelRank(base)) reasons.push(floor.why);
  else if (floor.why && cap.capacityPoints === null) reasons.push(floor.why.replace(/, so the label is.*$/, "."));

  return {
    label,
    pointsCenti,
    points: pointsCenti / 100,
    capacity: available,
    capacityPoints: cap.capacityPoints,
    capacitySource: cap.source,
    availableDays: cap.availableHalfDays / 2,
    horizonDays: cap.horizonDays,
    ratioPercent,
    items: items.length,
    overdue,
    escalated,
    away,
    reasons,
    quality: {
      capacityFromDefault: cap.source === "default",
      itemsWithoutDueDate: undated,
      supportOverdueUnknown: input.supportTargetsEnabled ? 0 : support,
      maintenanceWithoutDueDate: maintenance,
    },
  };
}
