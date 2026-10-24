// The numbers behind the workload labels, in one place. Every number here is a PROPOSAL from the audit (docs/roadmap/phases-3-to-7/audit/6de-staff-messages-workload.md,
// section 5), not a decision: the founder has not approved any of them. They are the defaults in code; a Super Admin can override any of them (staff_workload_settings
// stores only the overrides), and the Rules panel shows what is in force. Pure: no database, no clock.
//
// Points are kept as whole hundredths ("centi-points") whenever they are added or compared, and weights are multiples of a quarter point, so a label never depends on how
// floating point happened to round a boundary.

import type { WorkItem } from "@/lib/staff-workload/sources";

/** The workspace switch (org_features on the agency workspace): absent means off. */
export const STAFF_WORKLOAD_FEATURE = "staff_workload";

export const COUNTS_ONLY_NOTE = "This counts only work recorded in iAcquire: support requests, setup steps, custom projects and maintenance requests. Meetings, internal tasks and work done elsewhere are not counted.";
export const NOT_A_SCORE_NOTE = "A label is a prompt to look at how work is shared. It is not a score of anyone's performance.";
export const CAPACITY_NOT_SET_TEXT = "Capacity not set";

export const PROJECT_WEIGHT_STATUSES = [
  "submitted", "under_review", "discovery_needed", "quote_preparing", "quote_sent", "awaiting_approval", "approved", "in_development", "testing", "ready_for_review", "on_hold",
] as const;
export type ProjectWeightStatus = (typeof PROJECT_WEIGHT_STATUSES)[number];

export interface WorkloadRules {
  weights: {
    support: { urgent: number; high: number; normal: number; low: number };
    /** A request waiting for the client counts this percent of its points. */
    supportWaitingPercent: number;
    /** Points added to an escalated request. */
    supportEscalatedExtra: number;
    setupRequired: number;
    setupOptional: number;
    setupBlockedPercent: number;
    setupWaitingPercent: number;
    project: Record<ProjectWeightStatus, number>;
    maintenance: number;
    maintenanceWaitingPercent: number;
  };
  /** The percent of capacity at which each label begins. Below balancedFrom is Available. */
  thresholds: { balancedFrom: number; busyFrom: number; overloadedFrom: number; criticalFrom: number };
  /** How many overdue items lift the label to at least Busy, Overloaded and Critical. */
  floors: { busyAtOverdue: number; overloadedAtOverdue: number; criticalAtOverdue: number };
  /** The planning horizon, in working days (Monday to Friday) starting today. */
  horizonDays: number;
  /** Capacity points over the whole horizon for a person who has none of their own. Null: not set, so such a person gets no label. */
  defaultCapacityPoints: number | null;
  health: {
    /** A project with no activity for this many days is at risk (unless it is waiting for the client). */
    staleDays: number;
    /** This many overdue milestones make a project off track. */
    offTrackOverdueMilestones: number;
  };
}

export const DEFAULT_RULES: WorkloadRules = {
  weights: {
    support: { urgent: 5, high: 3, normal: 2, low: 1 },
    supportWaitingPercent: 25,
    supportEscalatedExtra: 2,
    setupRequired: 2,
    setupOptional: 1,
    setupBlockedPercent: 50,
    setupWaitingPercent: 25,
    project: {
      submitted: 2, under_review: 2, discovery_needed: 2, quote_preparing: 3, quote_sent: 1, awaiting_approval: 1, approved: 2, in_development: 5, testing: 3, ready_for_review: 2, on_hold: 0.5,
    },
    maintenance: 2,
    maintenanceWaitingPercent: 25,
  },
  thresholds: { balancedFrom: 50, busyFrom: 85, overloadedFrom: 100, criticalFrom: 125 },
  floors: { busyAtOverdue: 1, overloadedAtOverdue: 3, criticalAtOverdue: 5 },
  horizonDays: 5,
  // Not set: the audit gives no number for it and a number would be invented. Until a Super Admin sets a team default (or a manager sets a person's capacity), no label is shown.
  defaultCapacityPoints: null,
  health: { staleDays: 14, offTrackOverdueMilestones: 2 },
};

export interface RuleField {
  path: string;
  group: string;
  label: string;
  unit: "points" | "percent" | "items" | "days";
  min: number;
  max: number;
  /** Points move in quarters, everything else in whole numbers. */
  step: number;
  nullable?: boolean;
  help?: string;
}

const pts = (path: string, group: string, label: string, max = 50): RuleField => ({ path, group, label, unit: "points", min: 0, max, step: 0.25 });
const pct = (path: string, group: string, label: string): RuleField => ({ path, group, label, unit: "percent", min: 0, max: 100, step: 1 });

const PROJECT_LABELS: Record<ProjectWeightStatus, string> = {
  submitted: "Submitted", under_review: "Under review", discovery_needed: "Discovery needed", quote_preparing: "Preparing a quote", quote_sent: "Quote sent",
  awaiting_approval: "Awaiting the client's approval", approved: "Approved", in_development: "In development", testing: "Testing", ready_for_review: "Ready for the client's review", on_hold: "On hold",
};

/** Every number a Super Admin can change, with the range the database and the code accept. The Rules panel, the validation and the diff against the defaults all read this list. */
export const RULE_FIELDS: readonly RuleField[] = [
  pts("weights.support.urgent", "Support requests", "Urgent request"),
  pts("weights.support.high", "Support requests", "High-priority request"),
  pts("weights.support.normal", "Support requests", "Normal request"),
  pts("weights.support.low", "Support requests", "Low-priority request"),
  pct("weights.supportWaitingPercent", "Support requests", "Share of the points that still count while waiting for the client"),
  pts("weights.supportEscalatedExtra", "Support requests", "Extra points for an escalated request"),
  pts("weights.setupRequired", "Setup steps", "Required step"),
  pts("weights.setupOptional", "Setup steps", "Optional step"),
  pct("weights.setupBlockedPercent", "Setup steps", "Share of the points that still count while blocked"),
  pct("weights.setupWaitingPercent", "Setup steps", "Share of the points that still count while waiting for the client"),
  ...PROJECT_WEIGHT_STATUSES.map((s) => pts(`weights.project.${s}`, "Custom projects", PROJECT_LABELS[s])),
  pts("weights.maintenance", "Maintenance requests", "Open request"),
  pct("weights.maintenanceWaitingPercent", "Maintenance requests", "Share of the points that still count while waiting for the client"),
  { path: "thresholds.balancedFrom", group: "Labels", label: "Balanced begins at", unit: "percent", min: 1, max: 1000, step: 1, help: "Percent of capacity. Below this a person is Available." },
  { path: "thresholds.busyFrom", group: "Labels", label: "Busy begins at", unit: "percent", min: 1, max: 1000, step: 1 },
  { path: "thresholds.overloadedFrom", group: "Labels", label: "Overloaded begins at", unit: "percent", min: 1, max: 1000, step: 1 },
  { path: "thresholds.criticalFrom", group: "Labels", label: "Critical begins at", unit: "percent", min: 1, max: 1000, step: 1 },
  { path: "floors.busyAtOverdue", group: "Floors from real facts", label: "Overdue items that make a person at least Busy", unit: "items", min: 1, max: 50, step: 1 },
  { path: "floors.overloadedAtOverdue", group: "Floors from real facts", label: "Overdue items that make a person at least Overloaded", unit: "items", min: 1, max: 50, step: 1 },
  { path: "floors.criticalAtOverdue", group: "Floors from real facts", label: "Overdue items that make a person Critical", unit: "items", min: 1, max: 50, step: 1 },
  { path: "horizonDays", group: "Capacity", label: "Planning horizon", unit: "days", min: 1, max: 20, step: 1, help: "Working days, Monday to Friday, starting today." },
  { path: "defaultCapacityPoints", group: "Capacity", label: "Team default capacity over the horizon", unit: "points", min: 1, max: 200, step: 1, nullable: true, help: "Used for people with no capacity of their own. Empty means not set, and then those people get no label." },
  { path: "health.staleDays", group: "Project health", label: "Days without activity before a project is at risk", unit: "days", min: 1, max: 180, step: 1 },
  { path: "health.offTrackOverdueMilestones", group: "Project health", label: "Overdue milestones that make a project off track", unit: "items", min: 1, max: 20, step: 1 },
];

const FIELD_BY_PATH = new Map(RULE_FIELDS.map((f) => [f.path, f]));

/** What does not fit in a number: the logic the labels follow, in words, for the Rules panel. */
export const RULE_STATEMENTS: readonly string[] = [
  "Points count open work assigned to a person, from the weights above. Work for a suspended or archived workspace, a finished setup and a closed request is not counted.",
  "Capacity is a number of points over the planning horizon. A person's days off and the days they do not work take their share of it away; a half day counts half.",
  "A person's label comes from their points as a share of that capacity, then the floors below can only raise it: overdue items and escalated requests are real facts, whatever the points say.",
  "Only items with a due date set by someone can be overdue. An item with no due date is listed as having none; it is never shown as on track.",
  "Support requests have a due time only when response targets are switched on in Support settings. Maintenance requests have no due date at all.",
  "Custom project review tasks give the project its due time and carry no points of their own.",
  "Someone with no capacity of their own and no team default gets no label, only their counts.",
  "A person whose time off covers the whole horizon and who still has open work is shown as Critical, because nothing can be done on it.",
  COUNTS_ONLY_NOTE,
  NOT_A_SCORE_NOTE,
];

// ---------------------------------------------------------------------------
// Reading and validating
// ---------------------------------------------------------------------------

export interface RuleError {
  path: string;
  message: string;
}

export type NormalizeResult = { ok: true; rules: WorkloadRules } | { ok: false; errors: RuleError[] };

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function getRule(rules: WorkloadRules, path: string): number | null {
  let cursor: unknown = rules;
  for (const key of path.split(".")) {
    if (typeof cursor !== "object" || cursor === null) return null;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return typeof cursor === "number" ? cursor : null;
}

function setRule(rules: WorkloadRules, path: string, value: number | null): void {
  const keys = path.split(".");
  let cursor = rules as unknown as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) cursor = cursor[key] as Record<string, unknown>;
  cursor[keys[keys.length - 1]] = value;
}

const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Every leaf of a nested object as a dotted path. A leaf is anything that is not a plain object. */
function leavesOf(value: Record<string, unknown>, prefix: string, out: Array<[string, unknown]>, depth: number): void {
  for (const key of Object.keys(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const inner = value[key];
    if (isPlain(inner) && depth < 4) leavesOf(inner, path, out, depth + 1);
    else out.push([path, inner]);
  }
}

const unitWord = (f: RuleField) => (f.unit === "percent" ? "percent" : f.unit === "points" ? "points" : f.unit === "days" ? "days" : "items");

function checkField(f: RuleField, value: unknown): string | null {
  if (value === null) return f.nullable ? null : `${f.label} needs a number.`;
  if (typeof value !== "number" || !Number.isFinite(value)) return `${f.label} needs a number.`;
  if (value < f.min || value > f.max) return `${f.label} must be from ${f.min} to ${f.max} ${unitWord(f)}.`;
  const steps = value / f.step;
  if (Math.abs(steps - Math.round(steps)) > 1e-9) return f.step === 1 ? `${f.label} must be a whole number.` : `${f.label} must be a multiple of ${f.step}.`;
  return null;
}

/**
 * The defaults with the given changes laid over them, checked. The input may be partial (the stored overrides) or complete (a form). An unknown rule, a value out of range and
 * labels that are not in order are all refused with a plain message, and nothing is half-applied.
 */
export function normalizeRules(input: unknown): NormalizeResult {
  const errors: RuleError[] = [];
  const rules = clone(DEFAULT_RULES);
  if (input !== undefined && input !== null && !isPlain(input)) return { ok: false, errors: [{ path: "", message: "The rules must be an object of numbers." }] };
  const found: Array<[string, unknown]> = [];
  if (isPlain(input)) leavesOf(input, "", found, 0);
  for (const [path, value] of found) {
    const field = FIELD_BY_PATH.get(path);
    if (!field) {
      errors.push({ path, message: `"${path.slice(0, 80)}" is not a rule.` });
      continue;
    }
    const problem = checkField(field, value);
    if (problem) errors.push({ path, message: problem });
    else setRule(rules, path, value as number | null);
  }
  if (errors.length) return { ok: false, errors };
  const t = rules.thresholds;
  if (!(t.balancedFrom < t.busyFrom && t.busyFrom < t.overloadedFrom && t.overloadedFrom < t.criticalFrom)) {
    errors.push({ path: "thresholds", message: "The labels must begin in order: Balanced, then Busy, then Overloaded, then Critical, each at a higher percent than the one before." });
  }
  const f = rules.floors;
  if (!(f.busyAtOverdue < f.overloadedAtOverdue && f.overloadedAtOverdue < f.criticalAtOverdue)) {
    errors.push({ path: "floors", message: "The overdue floors must rise: more overdue items for Overloaded than for Busy, and more for Critical than for Overloaded." });
  }
  return errors.length ? { ok: false, errors } : { ok: true, rules };
}

/** Only what differs from the defaults, nested as the rules are. Empty when nothing was changed. */
export function overridesOf(rules: WorkloadRules): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of RULE_FIELDS) {
    const now = getRule(rules, f.path);
    if (now === getRule(DEFAULT_RULES, f.path)) continue;
    const keys = f.path.split(".");
    let cursor = out;
    for (const key of keys.slice(0, -1)) cursor = (cursor[key] ??= {}) as Record<string, unknown>;
    cursor[keys[keys.length - 1]] = now;
  }
  return out;
}

/** The paths whose value differs between two rule sets, for the audit trail. */
export function changedPaths(a: WorkloadRules, b: WorkloadRules): string[] {
  return RULE_FIELDS.filter((f) => getRule(a, f.path) !== getRule(b, f.path)).map((f) => f.path);
}

const unitText = (f: RuleField, value: number | null): string => {
  if (value === null) return "Not set";
  if (f.unit === "percent") return `${value}%`;
  if (f.unit === "points") return `${value} ${value === 1 ? "point" : "points"}`;
  if (f.unit === "days") return `${value} working ${value === 1 ? "day" : "days"}`;
  return `${value} ${value === 1 ? "item" : "items"}`;
};

export interface RuleRow {
  path: string;
  label: string;
  value: string;
  changed: boolean;
  help?: string;
}

/** The Rules panel: every number in force, grouped, with the ones a Super Admin changed marked. */
export function describeRules(rules: WorkloadRules): Array<{ group: string; rows: RuleRow[] }> {
  const groups = new Map<string, RuleRow[]>();
  for (const f of RULE_FIELDS) {
    const value = getRule(rules, f.path);
    const list = groups.get(f.group) ?? [];
    list.push({ path: f.path, label: f.label, value: unitText(f, value), changed: value !== getRule(DEFAULT_RULES, f.path), ...(f.help ? { help: f.help } : {}) });
    groups.set(f.group, list);
  }
  return [...groups.entries()].map(([group, rows]) => ({ group, rows }));
}

// ---------------------------------------------------------------------------
// Points
// ---------------------------------------------------------------------------

const centi = (points: number) => Math.round(points * 100);
/** base * percent / 100, rounded half up, in whole hundredths. */
const share = (baseCenti: number, percent: number) => Math.floor((baseCenti * percent + 50) / 100);

/**
 * The points one open item adds to its assignee, in hundredths of a point. Review tasks of a project carry none: they only give the project its due time. An unknown status or
 * priority adds nothing rather than a guess.
 */
export function itemPointsCenti(item: Pick<WorkItem, "source" | "status" | "priority" | "escalated" | "blocked" | "waitingOnClient" | "optional">, rules: WorkloadRules): number {
  const w = rules.weights;
  switch (item.source) {
    case "support": {
      const base = centi((w.support as Record<string, number>)[item.priority ?? ""] ?? 0);
      const counted = item.status === "waiting_for_client" || item.waitingOnClient ? share(base, w.supportWaitingPercent) : base;
      return counted + (item.escalated ? centi(w.supportEscalatedExtra) : 0);
    }
    case "setup_task": {
      const base = centi(item.optional ? w.setupOptional : w.setupRequired);
      if (item.blocked || item.status === "blocked") return share(base, w.setupBlockedPercent);
      if (item.waitingOnClient || item.status === "waiting_for_client") return share(base, w.setupWaitingPercent);
      return base;
    }
    case "project":
      return centi((w.project as Record<string, number>)[item.status] ?? 0);
    case "maintenance": {
      const base = centi(w.maintenance);
      return item.waitingOnClient || item.status === "waiting_for_client" ? share(base, w.maintenanceWaitingPercent) : base;
    }
  }
}

export const formatPoints = (centiPoints: number): string => {
  const whole = centiPoints / 100;
  return Number.isInteger(whole) ? String(whole) : whole.toFixed(2).replace(/0+$/, "").replace(/[.]$/, "");
};
