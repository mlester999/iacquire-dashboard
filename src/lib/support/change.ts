// Request a Change: the pure rules shared by the server, the database tests and the screens. Nothing here reads the database or the environment.
//
// A change request is an ordinary request of the type "change". What only the team knows about it (the kind of change it is, whether the core system covers it, the monthly
// allowance covers it, or it needs a quote) lives in support_ticket_change and is never shown to the client. Nothing here prices a change or promises a date.

import { CHANGE_CATEGORIES } from "@/lib/support/lifecycle";

/** The workspace switch (org_features) that turns Request a Change and the client's change orders on. Absent means off. */
export const REQUEST_CHANGES_FEATURE = "request_changes";
export const REQUEST_CHANGES_NOT_ENABLED_MESSAGE = "Request a Change isn't switched on for your workspace yet. Ask your iAcquire contact to switch it on, or use Get Support in the meantime.";

export const CHANGE_TARGETS = ["ai_employee", "website", "automation", "integration", "project", "other"] as const;
export type ChangeTarget = (typeof CHANGE_TARGETS)[number];

type ChangeCategory = (typeof CHANGE_CATEGORIES)[number];

/** The category the person picks says what the change is about; the target kind is read from it, so the two can never disagree. */
export const CHANGE_CATEGORY_TARGET: Record<ChangeCategory, ChangeTarget> = {
  change_ai_employee: "ai_employee",
  change_website: "website",
  change_automation: "automation",
  change_integration: "integration",
  change_project: "project",
  change_other: "other",
};

export function changeTargetFor(category: string): ChangeTarget | null {
  return Object.prototype.hasOwnProperty.call(CHANGE_CATEGORY_TARGET, category) ? CHANGE_CATEGORY_TARGET[category as ChangeCategory] : null;
}

export const CHANGE_TARGET_LABELS: Record<ChangeTarget, string> = {
  ai_employee: "An AI employee",
  website: "Website",
  automation: "Automation or workflow",
  integration: "Connected service",
  project: "Custom project",
  other: "Something else",
};

// What the team decided. Agency only: a classification is an internal working label, not a quote and not a promise.
export const CHANGE_CLASSIFICATIONS = ["covered", "managed_allowance", "needs_quote", "out_of_scope"] as const;
export type ChangeClassification = (typeof CHANGE_CLASSIFICATIONS)[number];
export const CHANGE_CLASSIFICATION_LABELS: Record<ChangeClassification, { label: string; hint: string }> = {
  covered: { label: "Covered by the core system", hint: "Part of what the client already has. No charge and no quote." },
  managed_allowance: { label: "Belongs in the maintenance plan", hint: "A small change the client's maintenance plan covers. This is a label: it does not use up a plan request, which Maintenance counts." },
  needs_quote: { label: "Needs a quote", hint: "Real work. Staff write the quote; nothing is priced from here." },
  out_of_scope: { label: "Out of scope", hint: "The team will not do this, or not as asked." },
};
export const isChangeClassification = (v: unknown): v is ChangeClassification => typeof v === "string" && (CHANGE_CLASSIFICATIONS as readonly string[]).includes(v);

/**
 * Projects a person can ask a change of: ones that were agreed (a quote accepted), or finished. Before that the project's own conversation and quote are where a
 * change belongs, and a cancelled project takes no changes.
 */
export const CHANGE_REQUEST_PROJECT_STATUSES = ["approved", "in_development", "testing", "ready_for_review", "on_hold", "completed"] as const;
export const projectTakesChangeRequest = (status: string) => (CHANGE_REQUEST_PROJECT_STATUSES as readonly string[]).includes(status);

export interface AllowanceFacts { total: number; used: number; remaining: number; month: string }

/**
 * One sentence about the monthly maintenance allowance, or null. It exists only when an active plan does, and the number is the plan's own setting: a client without a
 * plan is told nothing about an allowance, and no figure is ever filled in for them.
 */
export function allowanceSentence(allowance: AllowanceFacts | null): string | null {
  if (!allowance || !Number.isInteger(allowance.total) || allowance.total < 1) return null;
  const left = Math.max(0, allowance.remaining);
  const plural = (n: number) => (n === 1 ? "request" : "requests");
  return `Your maintenance plan includes ${allowance.total} managed ${plural(allowance.total)} a month${left === 0 ? " and you have used them all this month" : ` (${left} left this month)`}. Small changes the plan covers are sent from Maintenance. Anything you send here, the team will tell you whether it is covered or needs a quote before anything is done.`;
}
