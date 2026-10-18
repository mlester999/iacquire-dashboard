import "server-only";
import { requireUserOrThrow } from "@/server/auth/session";
import { AppError } from "@/server/errors";
import { getOrgContext, loadAgencyPermissions } from "@/server/tenancy/context";
import type { SessionUser } from "@/server/auth/service";
import type { Permission } from "@/lib/permissions";
import type { Membership } from "@/server/tenancy/context";

export interface AqiViewer {
  user: SessionUser;
  org: Pick<Membership, "orgId" | "name" | "kind" | "role"> | null;
  permissions: Permission[];
  can: (permission: Permission) => boolean;
  agencyRole: "agency_staff" | "agency_manager" | "agency_super_admin" | null;
}

/**
 * AQi resolves the person's permissions from the authenticated session and the database, never from
 * anything the browser sends. Agency staff may not belong to a client organization; their AQi
 * conversations are private and have no organization scope.
 */
export async function resolveAqiViewer(): Promise<AqiViewer> {
  const user = await requireUserOrThrow();
  const ctx = await getOrgContext();
  if (ctx) {
    return {
      user,
      org: { orgId: ctx.org.orgId, name: ctx.org.name, kind: ctx.org.kind, role: ctx.org.role },
      permissions: ctx.permissions,
      can: ctx.can,
      agencyRole: user.platformRole !== "none" ? user.platformRole : null,
    };
  }
  if (user.platformRole === "none") {
    throw new AppError("forbidden", "A workspace is required to use AQi.");
  }
  const permissions = await loadAgencyPermissions(user.id);
  const set = new Set(permissions);
  return {
    user,
    org: null,
    permissions,
    can: (permission) => set.has(permission),
    agencyRole: user.platformRole,
  };
}

export function requireAqiAdmin(viewer: AqiViewer): void {
  if (viewer.user.platformRole !== "agency_super_admin") {
    throw new AppError("forbidden", "Only a Super Admin can manage AQi.");
  }
}
