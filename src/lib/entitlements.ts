// What a workspace is entitled to, decided from its facts by pure rules: the optional Managed Maintenance + Automation Studio plan and what hangs on it (Automation Studio,
// managed media storage), and whether the one-time setup fee is cleared. No server or database code, so the shell and the screens use the same rules the server gates use.
//
// Core CRM, the inbox, the six AI employees, the website, booking and social text posts are NOT entitlements: no plan, lapse, refund or unpaid fee ever touches them. The only
// things this file can say "no" to are the premium ones (Automation Studio workflows, managed media storage) and, for the agency, the second paid product (a new plan).
import { currentPlan, entitlementFor, type PlanStatus, type StudioEntitlement, type StudioEntitlementState } from "@/lib/automation-studio/plan";
import { daysUntil, paidPeriodEnded } from "@/lib/billing-renewal";

/** The facts about one maintenance plan that its entitlement is decided from. */
export interface PlanFacts {
  id: string;
  status: PlanStatus;
  graceEndsAt: Date | string | null;
  paidThroughOn: string | null;
  createdAt: Date | string;
}

export interface MaintenanceEntitlement {
  /** The workspace's current plan status, or null when it never had one. */
  status: PlanStatus | null;
  state: StudioEntitlementState;
  paidThroughOn: string | null;
  /** The day the plan was paid through has passed and nobody has recorded a payment since. Information only: it does not by itself end anything. */
  paidPeriodEnded: boolean;
  /** Days to the paid-through day (negative once passed) while the plan is active; null otherwise. */
  daysLeft: number | null;
}

export interface WorkspaceEntitlements {
  /** Automation Studio: the same answer every server gate and the engine give. */
  studio: StudioEntitlement;
  /** Managed media storage for social posts. It follows the plan exactly as Automation Studio does, so a lapsed plan cannot keep it by another route. */
  managedStorage: boolean;
  maintenance: MaintenanceEntitlement;
  /** The one-time setup fee is paid or waived. This is NOT an entitlement to anything core; it gates only provisioning, activation and starting a plan. */
  setupCleared: boolean;
}

/** The plan a workspace is judged by (its open plan, else its most recent), from its plan rows in any order. */
export function currentPlanOf(rows: readonly PlanFacts[]): PlanFacts | null {
  return currentPlan(rows);
}

/** Automation Studio entitlement from a plan (or none) at a moment. The one place the rule is applied, so the shell, the gates and the engine cannot disagree. */
export function studioEntitlementOf(plan: PlanFacts | null, now: Date = new Date()): StudioEntitlement {
  return entitlementFor(plan ? { id: plan.id, status: plan.status, graceEndsAt: plan.graceEndsAt, paidThroughOn: plan.paidThroughOn } : null, now);
}

/** Everything a workspace is entitled to, from its plan, the fee, the clock and today's date in the agency's time zone (the paid-through day is the agency's day). */
export function entitlementsFrom(input: { plan: PlanFacts | null; setupCleared: boolean; now: Date; today: string }): WorkspaceEntitlements {
  const studio = studioEntitlementOf(input.plan, input.now);
  const status = input.plan?.status ?? null;
  const paidThroughOn = input.plan?.paidThroughOn ?? null;
  return {
    studio,
    managedStorage: studio.entitled,
    maintenance: {
      status,
      state: studio.state,
      paidThroughOn,
      paidPeriodEnded: paidPeriodEnded(status, paidThroughOn, input.today),
      daysLeft: status === "active" ? daysUntil(paidThroughOn, input.today) : null,
    },
    setupCleared: input.setupCleared,
  };
}
