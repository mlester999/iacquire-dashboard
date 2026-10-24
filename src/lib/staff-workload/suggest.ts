// Who could take an item, ranked, with the reasons. Rules, not AI: the same facts always give the same list, and nothing is ever assigned by this file. A suggestion is applied
// only when a person with the right to assign clicks it, and then through the module's own assign function.
//
// The caller passes in only people who may be given the item: active agency accounts that can open the item's client and hold the permission the item's module needs. This
// file ranks them, in this order:
//   1. skill fit, only when a manager has recorded the needed skill for anyone (otherwise nobody is ranked on skills, and the list says so);
//   2. how loaded each person is now (Available before Balanced, and so on; a person with no capacity set last);
//   3. how loaded they would be with this item added (the lower the share of capacity, the earlier);
//   4. continuity: more open items for the same client first;
//   5. whoever was least recently given work from the board (never given any comes first);
//   6. the person's id, so equal people always come out in the same order.
// Someone who is away for the whole planning horizon is not offered.

import { computeWorkload, labelRank, LABEL_TEXT, resolveCapacity, type WorkloadLabel, type WorkloadResult } from "@/lib/staff-workload/labels";
import { CAPACITY_NOT_SET_TEXT, formatPoints, type WorkloadRules } from "@/lib/staff-workload/rules";
import { SKILL_LABELS, SKILL_LEVEL_LABELS, skillFor, type Skill, type WorkItem } from "@/lib/staff-workload/sources";

export const MAX_SUGGESTIONS = 3;

export interface SuggestionCandidate {
  userId: string;
  name: string;
  /** Skill levels a manager recorded (1 to 3). */
  skills: Partial<Record<Skill, number>>;
  /** The person's own capacity over the horizon, or null. */
  personCapacity: number | null;
  /** Half days they can work in the horizon (see availableHalfDays). */
  availableHalfDays: number;
  /** Everything open that is assigned to them now. */
  items: readonly WorkItem[];
  /** When the board last gave them an item, or null if it never has. */
  lastAssignedAt: string | null;
}

export interface LoadSummary {
  label: WorkloadLabel | null;
  points: number;
  ratioPercent: number | null;
}

export interface Suggestion {
  userId: string;
  name: string;
  rank: number;
  /** The level recorded for the skill the item needs, or null when none is recorded for this person. */
  skillLevel: number | null;
  current: LoadSummary;
  after: LoadSummary;
  reasons: string[];
}

export interface SuggestionList {
  suggestions: Suggestion[];
  /** People who could have been offered (everyone passed in). */
  considered: number;
  /** People left out because they are away for the whole horizon. */
  away: number;
  /** The skill the item needs, and whether the ranking used skills at all. */
  skill: Skill;
  skillsUsed: boolean;
  notes: string[];
}

const summary = (r: WorkloadResult): LoadSummary => ({ label: r.label, points: r.points, ratioPercent: r.ratioPercent });
const pct = (value: number | null) => (value === null ? Number.POSITIVE_INFINITY : value);

function loadText(s: LoadSummary, prefix: string): string {
  if (s.label === null) return `${prefix} ${CAPACITY_NOT_SET_TEXT.toLowerCase()}, with ${formatPoints(Math.round(s.points * 100))} points of open work.`;
  const share = s.ratioPercent === null ? "" : ` (${s.ratioPercent}% of capacity)`;
  return `${prefix} ${LABEL_TEXT[s.label]}${share}.`;
}

export function suggestAssignees(
  item: WorkItem, candidates: readonly SuggestionCandidate[], rules: WorkloadRules, now: Date, today: string, supportTargetsEnabled: boolean,
): SuggestionList {
  const skill = skillFor(item);
  const skillsUsed = candidates.some((c) => (c.skills[skill] ?? 0) > 0);
  const notes: string[] = [];
  let away = 0;
  const scored: Array<{ c: SuggestionCandidate; before: WorkloadResult; after: WorkloadResult; level: number; sameClient: number }> = [];
  for (const c of candidates) {
    if (c.availableHalfDays <= 0) {
      away += 1;
      continue;
    }
    const capacity = resolveCapacity(c.personCapacity, rules, c.availableHalfDays);
    const base = { capacity, rules, now, today, supportTargetsEnabled };
    const before = computeWorkload({ ...base, items: c.items });
    const after = computeWorkload({ ...base, items: [...c.items, { ...item, assigneeId: c.userId }] });
    scored.push({ c, before, after, level: c.skills[skill] ?? 0, sameClient: c.items.filter((i) => i.orgId === item.orgId).length });
  }
  scored.sort((a, b) =>
    (skillsUsed ? b.level - a.level : 0)
    || labelRank(a.before.label) - labelRank(b.before.label)
    || pct(a.after.ratioPercent) - pct(b.after.ratioPercent)
    || b.sameClient - a.sameClient
    || (a.c.lastAssignedAt ?? "").localeCompare(b.c.lastAssignedAt ?? "")
    || a.c.userId.localeCompare(b.c.userId),
  );

  const suggestions = scored.slice(0, MAX_SUGGESTIONS).map((s, i): Suggestion => {
    const reasons: string[] = [];
    if (skillsUsed) {
      reasons.push(s.level > 0 ? `${SKILL_LABELS[skill]}: ${SKILL_LEVEL_LABELS[s.level]} (recorded by a manager).` : `No ${SKILL_LABELS[skill].toLowerCase()} skill is recorded for this person.`);
    }
    reasons.push(loadText(summary(s.before), "Now:"));
    if (s.after.label !== s.before.label || s.after.ratioPercent !== s.before.ratioPercent) reasons.push(loadText(summary(s.after), "With this item:"));
    if (s.after.label === null) reasons.push("The effect of this item on their load cannot be shown until a capacity is set.");
    if (s.sameClient > 0) reasons.push(`Already has ${s.sameClient} open ${s.sameClient === 1 ? "item" : "items"} for this client.`);
    reasons.push(s.c.lastAssignedAt ? "Not the most recent person to be given work from the board." : "Has never been given work from the board.");
    if (s.c.personCapacity === null && s.before.capacitySource === "default") reasons.push("Capacity is the team default, not a number set for this person.");
    return { userId: s.c.userId, name: s.c.name, rank: i + 1, skillLevel: s.level > 0 ? s.level : null, current: summary(s.before), after: summary(s.after), reasons };
  });

  if (!skillsUsed) notes.push(`No ${SKILL_LABELS[skill].toLowerCase()} skill is recorded for anyone, so people are not ranked on skills.`);
  if (away) notes.push(`${away} ${away === 1 ? "person is" : "people are"} away for the whole planning period and ${away === 1 ? "is" : "are"} not offered.`);
  if (!candidates.length) notes.push("Nobody who can open this client and hold the permission for this kind of work is available to be offered.");
  return { suggestions, considered: candidates.length, away, skill, skillsUsed, notes };
}
