// What counts as work in the staff workload engine (migration 0097), and the facts the engine needs about one piece of it. Pure: the server turns rows of four existing
// modules into WorkItem values, and every rule after that reads only these. Nothing here invents work: an item is a row somebody recorded in iAcquire.

/** The four places work is recorded today. Unified Inbox conversations, client CRM tasks and AI work jobs are excluded on purpose: they belong to the client or to no person. */
export const WORK_SOURCES = ["support", "setup_task", "project", "maintenance"] as const;
export type WorkSource = (typeof WORK_SOURCES)[number];

export const SOURCE_LABELS: Record<WorkSource, string> = {
  support: "Support request",
  setup_task: "Setup step",
  project: "Custom project",
  maintenance: "Maintenance request",
};

export const SOURCE_PLURAL: Record<WorkSource, string> = {
  support: "support requests",
  setup_task: "setup steps",
  project: "custom projects",
  maintenance: "maintenance requests",
};

/** Which date an item's due time came from, so a screen can say "response due" rather than a bare date. */
export type DueKind = "response" | "estimate" | "review_task" | "expected_completion";

export const DUE_LABELS: Record<DueKind, string> = {
  response: "Response due",
  estimate: "Estimated for",
  review_task: "Review due",
  expected_completion: "Expected by",
};

export interface WorkItem {
  source: WorkSource;
  itemId: string;
  /** The client workspace the work is for. */
  orgId: string;
  orgName: string;
  assigneeId: string | null;
  ref: string | null;
  title: string;
  status: string;
  /** Support requests only: low, normal, high or urgent. */
  priority: string | null;
  /** A category, service or kind, used only to match a skill. */
  hint: string | null;
  /** A real moment (a response target, a review task). Null when nobody set one. */
  dueAt: string | null;
  /** A real calendar day (a setup estimate, a project's expected completion). Null when nobody set one. */
  dueOn: string | null;
  dueKind: DueKind | null;
  escalated: boolean;
  /** A setup step the team has marked blocked. */
  blocked: boolean;
  /** Waiting for the client: the team cannot move it. */
  waitingOnClient: boolean;
  /** A setup step that is not required. */
  optional: boolean;
  /** Custom projects: review tasks still open (they give the project its due time; they carry no points of their own). */
  openReviewTasks: number;
  createdAt: string;
  lastActivityAt: string | null;
}

/** The skills a manager can record for a person. The database repeats this list (staff_work_profile_guard). */
export const SKILLS = ["support", "setup", "crm", "website", "ai_employees", "integrations", "billing", "projects", "maintenance"] as const;
export type Skill = (typeof SKILLS)[number];

export const SKILL_LABELS: Record<Skill, string> = {
  support: "Support",
  setup: "Client setup",
  crm: "CRM and automations",
  website: "Websites",
  ai_employees: "AI employees",
  integrations: "Integrations",
  billing: "Billing",
  projects: "Custom projects",
  maintenance: "Maintenance",
};

export const SKILL_LEVELS = [1, 2, 3] as const;
export const SKILL_LEVEL_LABELS: Record<number, string> = { 1: "Can help", 2: "Comfortable", 3: "Expert" };

export const isSkill = (value: unknown): value is Skill => typeof value === "string" && (SKILLS as readonly string[]).includes(value);

const SUPPORT_SKILL: Record<string, Skill> = {
  billing: "billing",
  integrations: "integrations",
  ai_employees: "ai_employees",
  website: "website",
  crm: "crm",
  onboarding: "setup",
  project: "projects",
  maintenance: "maintenance",
};

const SETUP_SKILL: Record<string, Skill> = {
  crm: "crm",
  automations: "crm",
  ai_workforce: "ai_employees",
  website: "website",
  email: "integrations",
  calendar: "integrations",
};

/** The skill that fits an item best, from the category or service it already carries. Never guessed from its text. */
export function skillFor(item: Pick<WorkItem, "source" | "hint">): Skill {
  const hint = (item.hint ?? "").toLowerCase();
  if (item.source === "support") return SUPPORT_SKILL[hint] ?? "support";
  if (item.source === "setup_task") return SETUP_SKILL[hint] ?? "setup";
  return item.source === "project" ? "projects" : "maintenance";
}

/**
 * What a person must hold to be given an item of this kind. One rule for every module: the modules themselves check different things (the audit found setup and projects
 * ignore a denied permission), so the board asks this before it calls any of them. The person must also be inside the item's client scope, which the server checks.
 */
export const ASSIGN_PERMISSIONS: Record<WorkSource, readonly string[]> = {
  support: ["agency.support.view", "agency.support.manage"],
  setup_task: ["setup.manage"],
  project: ["projects.view", "projects.manage"],
  maintenance: ["maintenance.manage"],
};

/** What a person must hold to see the details of an item (its title and client), as opposed to counting in its points. */
export const READ_PERMISSIONS: Record<WorkSource, readonly string[]> = {
  support: ["agency.support.view"],
  setup_task: ["setup.manage"],
  project: ["projects.view"],
  maintenance: ["maintenance.manage"],
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day (February 31 is not one). */
export function isDay(value: unknown): value is string {
  if (typeof value !== "string" || !DAY.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/**
 * Whether an item is past a due time that somebody really set. An item with no due time is never overdue, and the screens say "no due date" for it instead of "on track".
 * `today` is the day in the agency's time zone; a moment is compared as a moment, a day as a day (the due day itself is not overdue).
 */
export function isOverdue(item: Pick<WorkItem, "dueAt" | "dueOn">, now: Date, today: string): boolean {
  if (item.dueAt) {
    const t = Date.parse(item.dueAt);
    if (Number.isFinite(t) && t < now.getTime()) return true;
  }
  return Boolean(item.dueOn && isDay(item.dueOn) && item.dueOn < today);
}

export const hasDueDate = (item: Pick<WorkItem, "dueAt" | "dueOn">): boolean => Boolean(item.dueAt || item.dueOn);
