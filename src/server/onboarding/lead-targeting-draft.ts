import "server-only";
import type { Queryable } from "@/server/db";
import { recordAudit } from "@/server/audit";
import { planLeadTargeting } from "@/lib/onboarding/lead-targeting-draft";
import type { Answers } from "@/lib/onboarding/types";

export type LeadTargetingOutcome =
  | { state: "created"; from: string[] }
  | { state: "kept"; reason: string }
  | { state: "skipped"; reason: string };

/**
 * Saves a first set of lead-targeting rules from the client's own answers, inside the caller's transaction and a savepoint of its own: a problem is reported as "skipped" and never
 * takes the submission down with it. A workspace that already has rules (the client's, or a Super Admin's) keeps them exactly: only the first submission can fill an empty profile.
 * Trusted code: the caller has authorized the person for this workspace.
 */
export async function proposeLeadTargeting(db: Queryable, ctx: { orgId: string; userId: string }, answers: Answers): Promise<LeadTargetingOutcome> {
  const plan = planLeadTargeting(answers);
  if (!plan) return { state: "skipped", reason: "The answers do not describe who to look for, so no lead targeting was drafted." };
  await db.query("savepoint onboarding_targeting");
  try {
    const { rows } = await db.query<{ org_id: string }>(
      `insert into lead_targeting_profiles (org_id, criteria, updated_by) values ($1, $2::jsonb, $3)
       on conflict (org_id) do nothing returning org_id`,
      [ctx.orgId, JSON.stringify(plan.targeting), ctx.userId],
    );
    await db.query("release savepoint onboarding_targeting");
    if (!rows.length) return { state: "kept", reason: "Lead targeting already exists, so it was left as it is." };
    await recordAudit({ orgId: ctx.orgId, actorUserId: ctx.userId, actorKind: "user", action: "onboarding.lead_targeting_drafted", targetType: "organization", targetId: ctx.orgId, result: "success", metadata: { from: plan.from } }, db);
    return { state: "created", from: plan.from };
  } catch (err) {
    await db.query("rollback to savepoint onboarding_targeting");
    await db.query("release savepoint onboarding_targeting");
    if (process.env.NODE_ENV !== "test") console.error("[iacquire] drafting lead targeting from onboarding answers failed", (err as { code?: string }).code ?? (err as Error).name);
    return { state: "skipped", reason: "Lead targeting could not be drafted this time. Nothing was changed; set it in Leads." };
  }
}
