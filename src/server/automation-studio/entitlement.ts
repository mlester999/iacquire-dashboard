import "server-only";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { currentPlan, entitlementFor, type PlanStatus, type StudioEntitlement } from "@/lib/automation-studio/plan";
import type { PremiumFeature } from "@/lib/crm/workflow/spec";

/**
 * Whether a workspace is entitled to Automation Studio, decided on the server from its maintenance plan (the optional "Managed Maintenance +
 * Automation Studio" subscription). Navigation hiding is only cosmetic: every server entry point that creates, changes, publishes, switches
 * on, tests or runs a premium workflow calls assertStudioEntitled, and the engine checks it again before it starts or advances a run.
 *
 * The answer is read from the database on every call (a plan can lapse between two steps of a run). Reading, pausing, archiving and
 * exporting a workflow never need the plan, so a lapsed workspace can always see and keep what it built.
 */

interface PlanRowDb {
  id: string;
  status: PlanStatus;
  grace_ends_at: Date | null;
  paid_through_on: string | null;
  created_at: Date;
}

export async function studioEntitlement(db: Queryable, orgId: string, now = new Date()): Promise<StudioEntitlement> {
  const { rows } = await db.query<PlanRowDb>(
    "select id, status, grace_ends_at, paid_through_on::text as paid_through_on, created_at from maintenance_subscriptions where org_id = $1 order by created_at desc limit 20",
    [orgId],
  );
  const plan = currentPlan(rows.map((r) => ({ id: r.id, status: r.status, graceEndsAt: r.grace_ends_at, paidThroughOn: r.paid_through_on, createdAt: r.created_at })));
  return entitlementFor(plan, now);
}

/** Refuses with code "plan_required" (the interface shows the upgrade page) unless the workspace is entitled. `doing` completes "… needs". */
export async function assertStudioEntitled(db: Queryable, orgId: string, doing = "Automation Studio", now = new Date()): Promise<StudioEntitlement> {
  const ent = await studioEntitlement(db, orgId, now);
  if (!ent.entitled) throw new AppError("plan_required", `${doing} needs the Managed Maintenance + Automation Studio plan. ${ent.reason}`.slice(0, 600));
  return ent;
}

/** Whether a version (or draft) uses any premium capability, which is what ties it to the plan. */
export const needsStudioPlan = (features: readonly PremiumFeature[] | readonly string[] | null | undefined) => (features?.length ?? 0) > 0;
