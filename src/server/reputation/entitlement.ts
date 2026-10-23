import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import type { SessionUser } from "@/server/auth/service";

// Satisfaction surveys (a request of kind "survey", CSAT and NPS, the Satisfaction view, a retention program's feedback link, a survey form's answers saved as private
// feedback) are dormant until a Super Admin switches them on for a workspace: org_features, feature "reputation_surveys"; no row means off. This is the one entitlement seam
// in front of them (where surveys sit relative to the implementation fee and the monthly plan is the founder's decision, and nothing here prices them).
//
// What stays on whatever the switch says: review requests, the customer's page for a request that exists, private feedback and its follow-up, the review links, and
// everything already sent. Switching it off stops new survey work; it never withdraws an answer a customer already gave or hides it from the team.

export const REPUTATION_SURVEYS_FEATURE = "reputation_surveys";
export const SURVEYS_NOT_ENABLED_MESSAGE = "Satisfaction surveys aren't switched on for this workspace yet. Ask your iAcquire contact to switch them on.";
export const SURVEYS_CLIENT_ONLY_MESSAGE = "Satisfaction surveys belong to a client's own workspace. They are not available in an agency workspace.";

export async function surveysEnabledIn(db: Queryable, orgId: string): Promise<boolean> {
  const { rows } = await db.query<{ enabled: boolean }>("select enabled from org_features where org_id = $1 and feature = $2", [orgId, REPUTATION_SURVEYS_FEATURE]);
  return rows[0]?.enabled === true;
}

/** Refuses survey work in a workspace nobody switched it on for. */
export async function assertSurveysEnabled(db: Queryable, orgId: string): Promise<void> {
  if (!(await surveysEnabledIn(db, orgId))) throw new AppError("not_enabled", SURVEYS_NOT_ENABLED_MESSAGE);
}

/** Whether a workspace has surveys, for deciding what to show. */
export function surveysEnabled(orgId: string): Promise<boolean> {
  return withSystem((db) => surveysEnabledIn(db, orgId));
}

// Review request batches (an owner-approved ask to many customers at a set pace) are dormant the same way: org_features, feature "reputation_batches"; no row means off. The
// switch is checked when a batch is prepared, approved or started and by the scheduler before every turn. Switching it off stops new asks; a batch that is already under way
// is not deleted or hidden: it simply is not worked on until the switch is on again, and its owner can still pause or cancel it.
export const REPUTATION_BATCHES_FEATURE = "reputation_batches";
export const BATCHES_NOT_ENABLED_MESSAGE = "Review request batches aren't switched on for this workspace yet. Ask your iAcquire contact to switch them on.";

export async function batchesEnabledIn(db: Queryable, orgId: string): Promise<boolean> {
  const { rows } = await db.query<{ enabled: boolean }>("select enabled from org_features where org_id = $1 and feature = $2", [orgId, REPUTATION_BATCHES_FEATURE]);
  return rows[0]?.enabled === true;
}

/** Refuses batch work in a workspace nobody switched it on for. */
export async function assertBatchesEnabled(db: Queryable, orgId: string): Promise<void> {
  if (!(await batchesEnabledIn(db, orgId))) throw new AppError("not_enabled", BATCHES_NOT_ENABLED_MESSAGE);
}

/** Whether a workspace has batches, for deciding what to show. */
export function batchesEnabled(orgId: string): Promise<boolean> {
  return withSystem((db) => batchesEnabledIn(db, orgId));
}

// Public reviews read from a review site, and replies to them (CRM -> Reviews -> Public reviews) are dormant the same way: org_features, feature "reputation_reviews"; no row
// means off. The switch is checked when a site is connected, when its reviews are read, when a reply is written, approved or posted, and by the scheduler. Switching it off stops
// new connecting, reading and replying; the reviews already read and the replies already written stay visible, and a connection can still be disconnected.
export const REPUTATION_REVIEWS_FEATURE = "reputation_reviews";
export const REVIEWS_NOT_ENABLED_MESSAGE = "Public reviews aren't switched on for this workspace yet. Ask your iAcquire contact to switch them on.";
export const REVIEWS_CLIENT_ONLY_MESSAGE = "Public reviews belong to a client's own workspace. They are not available in an agency workspace.";

export async function externalReviewsEnabledIn(db: Queryable, orgId: string): Promise<boolean> {
  const { rows } = await db.query<{ enabled: boolean }>("select enabled from org_features where org_id = $1 and feature = $2", [orgId, REPUTATION_REVIEWS_FEATURE]);
  return rows[0]?.enabled === true;
}

/** Refuses public-review work in a workspace nobody switched it on for. */
export async function assertExternalReviewsEnabled(db: Queryable, orgId: string): Promise<void> {
  if (!(await externalReviewsEnabledIn(db, orgId))) throw new AppError("not_enabled", REVIEWS_NOT_ENABLED_MESSAGE);
}

/** Whether a workspace has public reviews switched on, for deciding what to show. */
export function externalReviewsEnabled(orgId: string): Promise<boolean> {
  return withSystem((db) => externalReviewsEnabledIn(db, orgId));
}

/** A Super Admin switches public reviews on or off for one client workspace. Audited. Nothing is connected, read or posted by switching it on. */
export async function setExternalReviewsEnabled(user: Pick<SessionUser, "id" | "platformRole">, orgId: string, enabled: boolean): Promise<void> {
  if (user.platformRole !== "agency_super_admin") throw new AppError("forbidden", "Only a Super Admin can switch public reviews on or off for a workspace.");
  await withSystem(async (db) => {
    const org = (await db.query<{ kind: string }>("select kind from organizations where id = $1", [orgId])).rows[0];
    if (!org) throw new AppError("not_found", "That workspace was not found.");
    if (org.kind !== "client") throw new AppError("invalid_input", REVIEWS_CLIENT_ONLY_MESSAGE);
    await db.query(
      `insert into org_features (org_id, feature, enabled, updated_by) values ($1, $2, $3, $4)
       on conflict (org_id, feature) do update set enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = now()`,
      [orgId, REPUTATION_REVIEWS_FEATURE, enabled, user.id],
    );
    await recordAudit({ orgId, actorUserId: user.id, actorKind: "agency", action: enabled ? "reputation.reviews_enabled" : "reputation.reviews_disabled", targetType: "organization", targetId: orgId, result: "success" }, db);
  });
}

/** A Super Admin switches batches on or off for one client workspace. Audited. Nothing is created or sent by switching it on. */
export async function setBatchesEnabled(user: Pick<SessionUser, "id" | "platformRole">, orgId: string, enabled: boolean): Promise<void> {
  if (user.platformRole !== "agency_super_admin") throw new AppError("forbidden", "Only a Super Admin can switch review request batches on or off for a workspace.");
  await withSystem(async (db) => {
    const org = (await db.query<{ kind: string }>("select kind from organizations where id = $1", [orgId])).rows[0];
    if (!org) throw new AppError("not_found", "That workspace was not found.");
    if (org.kind !== "client") throw new AppError("invalid_input", "Review request batches belong to a client's own workspace. They are not available in an agency workspace.");
    await db.query(
      `insert into org_features (org_id, feature, enabled, updated_by) values ($1, $2, $3, $4)
       on conflict (org_id, feature) do update set enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = now()`,
      [orgId, REPUTATION_BATCHES_FEATURE, enabled, user.id],
    );
    await recordAudit({ orgId, actorUserId: user.id, actorKind: "agency", action: enabled ? "reputation.batches_enabled" : "reputation.batches_disabled", targetType: "organization", targetId: orgId, result: "success" }, db);
  });
}

/** A Super Admin switches surveys on or off for one client workspace. Audited. Nothing is created, sent or counted by switching it on. */
export async function setSurveysEnabled(user: Pick<SessionUser, "id" | "platformRole">, orgId: string, enabled: boolean): Promise<void> {
  if (user.platformRole !== "agency_super_admin") throw new AppError("forbidden", "Only a Super Admin can switch satisfaction surveys on or off for a workspace.");
  await withSystem(async (db) => {
    const org = (await db.query<{ kind: string }>("select kind from organizations where id = $1", [orgId])).rows[0];
    if (!org) throw new AppError("not_found", "That workspace was not found.");
    if (org.kind !== "client") throw new AppError("invalid_input", SURVEYS_CLIENT_ONLY_MESSAGE);
    await db.query(
      `insert into org_features (org_id, feature, enabled, updated_by) values ($1, $2, $3, $4)
       on conflict (org_id, feature) do update set enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = now()`,
      [orgId, REPUTATION_SURVEYS_FEATURE, enabled, user.id],
    );
    await recordAudit({ orgId, actorUserId: user.id, actorKind: "agency", action: enabled ? "reputation.surveys_enabled" : "reputation.surveys_disabled", targetType: "organization", targetId: orgId, result: "success" }, db);
  });
}
