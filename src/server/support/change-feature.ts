import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { setOrgFeature } from "@/server/proposals/features";
import type { SessionUser } from "@/server/auth/service";
import { REQUEST_CHANGES_FEATURE, REQUEST_CHANGES_NOT_ENABLED_MESSAGE } from "@/lib/support/change";

// Request a Change, and a client's change orders on an agreed project, are dormant until a Super Admin switches them on for a workspace: org_features, feature
// "request_changes"; no row means off. This is the one entitlement seam in front of the module (where it sits relative to the implementation fee and the monthly plan is the
// founder's decision, and nothing here prices it).
//
// Switching it off stops new change requests and new change orders. It never strands one that already exists: a quote waiting for the owner can still be decided or
// withdrawn, and the team's own screens keep working, because those people already asked and were answered.

export { REQUEST_CHANGES_FEATURE, REQUEST_CHANGES_NOT_ENABLED_MESSAGE };

export async function requestChangesEnabledIn(db: Queryable, orgId: string): Promise<boolean> {
  const { rows } = await db.query<{ enabled: boolean }>("select enabled from org_features where org_id = $1 and feature = $2", [orgId, REQUEST_CHANGES_FEATURE]);
  return rows[0]?.enabled === true;
}

/** Whether a workspace has Request a Change, for deciding what to show. */
export function requestChangesEnabled(orgId: string): Promise<boolean> {
  return withSystem((db) => requestChangesEnabledIn(db, orgId));
}

/** Refuses new change work in an agency workspace, and in a client workspace nobody switched it on for. */
export async function assertRequestChangesEnabled(db: Queryable, ctx: { org: { orgId: string; kind: "agency" | "client" } }): Promise<void> {
  if (ctx.org.kind !== "client") throw new AppError("forbidden", "Request a Change belongs to a client's own workspace.");
  if (!(await requestChangesEnabledIn(db, ctx.org.orgId))) throw new AppError("not_enabled", REQUEST_CHANGES_NOT_ENABLED_MESSAGE);
}

/**
 * A Super Admin switches Request a Change on or off for one client workspace, through the shared workspace-feature service (which checks the Super Admin again and audits the
 * change). Nothing is created, sent or charged by switching it on.
 */
export async function setRequestChangesEnabled(user: SessionUser, orgId: string, enabled: boolean): Promise<{ changed: boolean }> {
  if (user.platformRole !== "agency_super_admin") throw new AppError("forbidden", "Only a Super Admin can switch Request a Change on or off for a workspace.");
  const org = (await withSystem((db) => db.query<{ kind: string }>("select kind from organizations where id = $1", [orgId]))).rows[0];
  if (!org) throw new AppError("not_found", "That workspace was not found.");
  if (org.kind !== "client") throw new AppError("invalid_input", "Request a Change belongs to a client's own workspace.");
  return setOrgFeature(user, { orgId, feature: REQUEST_CHANGES_FEATURE, enabled });
}
