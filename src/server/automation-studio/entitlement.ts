import "server-only";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import type { StudioEntitlement } from "@/lib/automation-studio/plan";
import { studioEntitlementOf } from "@/lib/entitlements";
import { readCurrentPlan } from "@/server/entitlements";
import type { PremiumFeature } from "@/lib/crm/workflow/spec";

/**
 * Whether a workspace is entitled to Automation Studio, decided on the server from its maintenance plan (the optional "Managed Maintenance +
 * Automation Studio" subscription). Navigation hiding is only cosmetic: every server entry point that creates, changes, publishes, switches
 * on, tests or runs a premium workflow calls assertStudioEntitled, and the engine checks it again before it starts or advances a run.
 *
 * The answer is read from the database on every call (a plan can lapse between two steps of a run). Reading, pausing, archiving and
 * exporting a workflow never need the plan, so a lapsed workspace can always see and keep what it built.
 */

// The plan is read, and the rule applied, in src/server/entitlements.ts and src/lib/entitlements.ts: the one place that decides what a plan entitles a workspace to, so this gate,
// the engine's own checks, managed media storage and the portal menu cannot disagree.
export async function studioEntitlement(db: Queryable, orgId: string, now = new Date()): Promise<StudioEntitlement> {
  return studioEntitlementOf(await readCurrentPlan(db, orgId), now);
}

/** Refuses with code "plan_required" (the interface shows the upgrade page) unless the workspace is entitled. `doing` completes "… needs". */
export async function assertStudioEntitled(db: Queryable, orgId: string, doing = "Automation Studio", now = new Date()): Promise<StudioEntitlement> {
  const ent = await studioEntitlement(db, orgId, now);
  if (!ent.entitled) throw new AppError("plan_required", `${doing} needs the Managed Maintenance + Automation Studio plan. ${ent.reason}`.slice(0, 600));
  return ent;
}

/** Whether a version (or draft) uses any premium capability, which is what ties it to the plan. */
export const needsStudioPlan = (features: readonly PremiumFeature[] | readonly string[] | null | undefined) => (features?.length ?? 0) > 0;
