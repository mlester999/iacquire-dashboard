import "server-only";
import type { Queryable } from "@/server/db";
import { effectivePermission, isDelegablePermission, isOrgRole, type Permission, type PermissionOverrides } from "@/lib/permissions";

/**
 * What one person may do in a workspace right now: their role plus any per-person grants or withdrawals (the same rule as the session's
 * context and app.has_permission). Used where something a person set up keeps acting after they set it up (API keys, webhook
 * subscriptions), so withdrawing their access also limits what it does.
 */
export type PermissionCheck = (permission: Permission) => boolean;

/** From a membership role and that person's override rows. Null when they aren't an active member (anymore). */
export function permissionCheckFrom(role: string | null | undefined, overrides: Record<string, unknown> | null | undefined): PermissionCheck | null {
  if (!role || !isOrgRole(role)) return null;
  const o: PermissionOverrides = {};
  for (const [p, effect] of Object.entries(overrides ?? {})) if (isDelegablePermission(p) && (effect === "grant" || effect === "revoke")) o[p] = effect;
  return (p) => effectivePermission(role, p, o);
}

/** SQL columns (role, overrides) for the person in `userColumn` of the row whose workspace is in `orgColumn`. */
export const memberAccessColumns = (orgColumn: string, userColumn: string) => `
  (select m.role from organization_memberships m where m.org_id = ${orgColumn} and m.user_id = ${userColumn} and m.status = 'active') as member_role,
  (select coalesce(jsonb_object_agg(o.permission, o.effect), '{}'::jsonb) from member_permission_overrides o where o.org_id = ${orgColumn} and o.user_id = ${userColumn}) as member_overrides`;

export async function memberPermissionCheck(db: Queryable, orgId: string, userId: string | null): Promise<PermissionCheck | null> {
  if (!userId) return null;
  const { rows } = await db.query<{ member_role: string | null; member_overrides: Record<string, unknown> | null }>(`select ${memberAccessColumns("$1::uuid", "$2::uuid")}`, [orgId, userId]);
  return permissionCheckFrom(rows[0]?.member_role, rows[0]?.member_overrides);
}
