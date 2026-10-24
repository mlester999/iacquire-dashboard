import "server-only";
import type { Queryable } from "@/server/db";
import { isSetupPaymentCleared } from "@/server/billing/clearance";
import { entitlementsFrom, currentPlanOf, type PlanFacts, type WorkspaceEntitlements } from "@/lib/entitlements";
import { todayIn } from "@/lib/invoices/state";
import type { PlanStatus } from "@/lib/automation-studio/plan";

/**
 * What a workspace is entitled to, read from the database once and decided by the pure rules in src/lib/entitlements.ts. Every server gate that asks "does this workspace have the
 * plan" (the Automation Studio gates and the engine's own checks through studioEntitlement, managed media storage) answers from here, so a plan that lapses lapses everywhere at the
 * same moment and a new premium feature cannot copy a raw query and quietly ignore the grace period. The answer is read on every call: a plan can lapse between two steps.
 *
 * This is for trusted server code (withSystem). A signed-in person's database role cannot read the plan's grace and paid-through columns; the portal shell asks through a
 * narrower function (app.automation_studio_plan, migration 0071) and applies the same pure rules.
 *
 * Core CRM, the inbox, the six employees, the website, booking and social text posts never ask this question.
 */

interface PlanRowDb {
  id: string;
  status: PlanStatus;
  grace_ends_at: Date | null;
  paid_through_on: string | null;
  created_at: Date;
}

/** The workspace's current plan (its open plan, else its most recent), or null when it never had one. */
export async function readCurrentPlan(db: Queryable, orgId: string): Promise<PlanFacts | null> {
  const { rows } = await db.query<PlanRowDb>(
    "select id, status, grace_ends_at, paid_through_on::text as paid_through_on, created_at from maintenance_subscriptions where org_id = $1 order by created_at desc limit 20",
    [orgId],
  );
  return currentPlanOf(rows.map((r) => ({ id: r.id, status: r.status, graceEndsAt: r.grace_ends_at, paidThroughOn: r.paid_through_on, createdAt: r.created_at })));
}

/** The agency's own calendar day: the day a plan is paid through is the day the agency recorded, in the agency's time zone. */
async function agencyToday(db: Queryable, now: Date): Promise<string> {
  const tz = (await db.query<{ timezone: string }>("select timezone from organizations where kind = 'agency' limit 1")).rows[0]?.timezone ?? "UTC";
  return todayIn(now, tz);
}

export async function workspaceEntitlements(db: Queryable, orgId: string, now: Date = new Date()): Promise<WorkspaceEntitlements> {
  const plan = await readCurrentPlan(db, orgId);
  const setupCleared = await isSetupPaymentCleared(db, orgId);
  return entitlementsFrom({ plan, setupCleared, now, today: await agencyToday(db, now) });
}
