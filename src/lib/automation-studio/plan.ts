// The Automation Studio plan, as pure rules shared by the server and the interface: what the plan is called and costs, who is entitled to it
// at a given moment, the fair-use limits and how a usage figure compares with one, and what happens when the plan lapses.
//
// Automation Studio is included only in the optional "Managed Maintenance + Automation Studio" plan (the existing maintenance subscription,
// src/server/maintenance/service.ts). Nothing here changes what a workspace gets without it: the contracted native CRM, configured AI
// employees and their schedules, authorized external automations (n8n, Zapier, Make), webhooks and the API all stay available.
import { MAINTENANCE_MONTHLY_USD, SETUP_FEE_USD } from "@/lib/billing";

export const STUDIO_PLAN_NAME = "Managed Maintenance + Automation Studio";
export const STUDIO_PLAN_MONTHLY_USD = MAINTENANCE_MONTHLY_USD;
export const STUDIO_SETUP_FEE_USD = SETUP_FEE_USD;

/**
 * How long a workspace keeps Automation Studio after a payment is recorded as failed, before the plan expires: the default. It is
 * configurable (STUDIO_PAYMENT_GRACE_DAYS, and per case by the agency member recording the failure, between 1 and MAX_GRACE_DAYS days), and the
 * client is always told the actual date. Disclosed on the upgrade page.
 */
export const PAYMENT_GRACE_DAYS = 7;
export const MAX_GRACE_DAYS = 30;
/** A client with a plan in its grace period is reminded once when this little time is left. */
export const GRACE_REMINDER_HOURS = 48;

export type PlanStatus = "requested" | "active" | "past_due" | "cancel_requested" | "cancelled" | "declined" | "expired";
/** Plans that count as "the workspace's plan" (the database allows one of these per workspace). */
export const OPEN_PLAN_STATUSES: readonly PlanStatus[] = ["requested", "active", "past_due", "cancel_requested"];

export type StudioEntitlementState = "active" | "cancelling" | "past_due" | "pending" | "expired" | "cancelled" | "declined" | "none";

export interface PlanRow {
  id: string;
  status: PlanStatus;
  graceEndsAt: Date | string | null;
  paidThroughOn?: string | null;
}

export interface StudioEntitlement {
  entitled: boolean;
  state: StudioEntitlementState;
  /** In words, for the person looking at the page or the error. Never mentions another workspace or an internal id. */
  reason: string;
  subscriptionId: string | null;
  /** Past due only: until when Automation Studio keeps working. */
  graceEndsAt: string | null;
  paidThroughOn: string | null;
}

const asDate = (d: Date | string | null | undefined) => (d ? new Date(d) : null);

/**
 * Whether a workspace is entitled to Automation Studio, from its plan row (or none). Time-aware: a plan that is past due stops being
 * entitled the moment its grace period ends, whether or not the sweeper has marked it expired yet.
 */
export function entitlementFor(plan: PlanRow | null, now = new Date()): StudioEntitlement {
  const base = { subscriptionId: plan?.id ?? null, graceEndsAt: null as string | null, paidThroughOn: plan?.paidThroughOn ?? null };
  if (!plan) {
    return { ...base, entitled: false, state: "none", reason: `Automation Studio is part of the optional ${STUDIO_PLAN_NAME} plan.` };
  }
  switch (plan.status) {
    case "active":
      return { ...base, entitled: true, state: "active", reason: "Your plan is active." };
    case "cancel_requested":
      return { ...base, entitled: true, state: "cancelling", reason: "Your plan stays active until iAcquire confirms the cancellation." };
    case "past_due": {
      const grace = asDate(plan.graceEndsAt);
      const open = grace !== null && now.getTime() < grace.getTime();
      return {
        ...base, graceEndsAt: grace?.toISOString() ?? null, entitled: open, state: "past_due",
        reason: open ? "A payment for your plan didn't go through. Automation Studio keeps working until the grace period ends." : "A payment for your plan didn't go through and the grace period has ended.",
      };
    }
    case "requested":
      return { ...base, entitled: false, state: "pending", reason: "Your request is waiting for iAcquire to activate the plan." };
    case "expired":
      return { ...base, entitled: false, state: "expired", reason: "Your plan has expired. Your workflows are saved; reactivate the plan to turn them on again." };
    case "cancelled":
      return { ...base, entitled: false, state: "cancelled", reason: "Your plan was cancelled. Your workflows are saved; reactivate the plan to turn them on again." };
    case "declined":
      return { ...base, entitled: false, state: "declined", reason: `Your plan request wasn't activated. Automation Studio is part of the ${STUDIO_PLAN_NAME} plan.` };
  }
}

/** The plan a workspace is judged by: its open plan, else the most recent one. `rows` are in any order; `created` breaks ties. */
export function currentPlan<T extends PlanRow & { createdAt: Date | string }>(rows: readonly T[]): T | null {
  const open = rows.filter((r) => OPEN_PLAN_STATUSES.includes(r.status));
  const pool = open.length ? open : rows;
  return [...pool].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] ?? null;
}

// ---------------------------------------------------------------------------
// Lifecycle transitions (agency-confirmed; nothing here talks to a payment provider)
// ---------------------------------------------------------------------------

// A cancelled plan is not revived: the client enrols again (a new request the agency activates). An expired one is reactivated by a
// verified payment.
export type PlanTransition = "payment_failed" | "payment_verified" | "expire";

const ALLOWED_FROM: Record<PlanTransition, readonly PlanStatus[]> = {
  payment_failed: ["active", "cancel_requested"],
  payment_verified: ["active", "past_due", "cancel_requested", "expired"],
  expire: ["past_due", "active", "cancel_requested"],
};

export function canTransition(from: PlanStatus, t: PlanTransition): boolean {
  return ALLOWED_FROM[t].includes(from);
}

/**
 * Why the period a verified payment covers (a YYYY-MM-DD date it is paid through) can't be recorded, in words, or null when it can. A payment can't cover a
 * period that already ended (a day of slack for time zones) or more than about a year ahead. Shared by activation and by recording a later payment.
 */
export function paidThroughProblem(value: string, now = new Date()): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) return "Use a valid date for the period the payment covers.";
  const through = new Date(`${value}T00:00:00Z`).getTime();
  if (through < now.getTime() - 86_400_000) return "A payment can't cover a period that has already ended.";
  if (through > now.getTime() + 400 * 86_400_000) return "A payment can't cover more than about a year ahead.";
  return null;
}

/** What lapsing does and doesn't do, in the words the upgrade page and the lapse notice use. Kept next to the behaviour it describes. */
export const STUDIO_LAPSE_POLICY = {
  paused: "Workflows built in Automation Studio are paused. Runs already in progress wait; none is failed or cancelled because of the lapse.",
  kept: "Your workflows, their versions, run history and conversations are kept for as long as your workspace exists.",
  unaffected: "Your CRM, AI employees and their schedules, n8n / Zapier / Make connections, webhooks and the API keep working.",
  resume: "When the plan is active again, each workflow stays off until someone checks it still works and turns it on.",
} as const;

// ---------------------------------------------------------------------------
// Fair-use limits
// ---------------------------------------------------------------------------

export const STUDIO_METRICS = [
  "runs_started", "runs_refused", "steps_executed", "step_failures", "step_retries", "test_runs",
  "builder_messages", "builder_input_tokens", "builder_output_tokens", "employee_invocations", "integration_calls",
] as const;
export type StudioMetric = (typeof STUDIO_METRICS)[number];

export const STUDIO_METRIC_LABELS: Record<StudioMetric, string> = {
  runs_started: "Workflow runs", runs_refused: "Runs not started (limit or plan)", steps_executed: "Steps executed", step_failures: "Step failures",
  step_retries: "Step retries", test_runs: "Test runs", builder_messages: "AI Builder messages", builder_input_tokens: "AI Builder input tokens",
  builder_output_tokens: "AI Builder output tokens", employee_invocations: "AI employee requests", integration_calls: "Integration calls",
};

/** The limits that can be set per workspace. Every one is a number: there is no "unlimited" unless an agency member sets a high one. */
export type LimitKey = "monthlyRuns" | "monthlySteps" | "monthlyBuilderMessages" | "monthlyEmployeeInvocations" | "monthlyIntegrationCalls" | "maxActiveWorkflows" | "maxLiveRuns";
export type StudioLimits = Record<LimitKey, number>;

/**
 * Platform defaults for a workspace without its own limits. PROVISIONAL: chosen to be generous for a small business and low enough to
 * stop a runaway loop from costing real money; the founder confirms them before launch (docs/automation-studio/open-decisions.md).
 */
export const STUDIO_DEFAULT_LIMITS: StudioLimits = {
  monthlyRuns: 5_000,
  monthlySteps: 50_000,
  monthlyBuilderMessages: 300,
  monthlyEmployeeInvocations: 500,
  monthlyIntegrationCalls: 10_000,
  maxActiveWorkflows: 25,
  maxLiveRuns: 500,
};

export const LIMIT_LABELS: Record<LimitKey, string> = {
  monthlyRuns: "Workflow runs per month", monthlySteps: "Steps per month", monthlyBuilderMessages: "AI Builder messages per month",
  monthlyEmployeeInvocations: "AI employee requests per month", monthlyIntegrationCalls: "Integration calls per month",
  maxActiveWorkflows: "Workflows switched on", maxLiveRuns: "Runs in progress at once",
};

/** The metric each monthly limit is measured against. `maxActiveWorkflows` and `maxLiveRuns` are counts of current state, not counters. */
export const LIMIT_METRIC: Partial<Record<LimitKey, StudioMetric>> = {
  monthlyRuns: "runs_started", monthlySteps: "steps_executed", monthlyBuilderMessages: "builder_messages",
  monthlyEmployeeInvocations: "employee_invocations", monthlyIntegrationCalls: "integration_calls",
};

export type QuotaState = "ok" | "warning" | "exceeded";

export function quotaStatus(used: number, limit: number, warnAtPercent = 80): { state: QuotaState; percent: number; remaining: number } {
  const percent = limit > 0 ? Math.min(100, Math.floor((used / limit) * 100)) : used > 0 ? 100 : 0;
  const remaining = Math.max(0, limit - used);
  if (limit <= 0 || used >= limit) return { state: "exceeded", percent: limit <= 0 ? 100 : percent, remaining };
  return { state: percent >= warnAtPercent ? "warning" : "ok", percent, remaining };
}

/** The first day of the calendar month (UTC) a moment falls in, as YYYY-MM-DD: the key of a monthly counter. */
export function periodMonth(at = new Date()): string {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)).toISOString().slice(0, 10);
}
