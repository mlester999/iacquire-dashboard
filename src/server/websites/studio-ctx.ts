import "server-only";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { requireUserOrThrow } from "@/server/auth/session";
import { agencyCanAccessOrg, requireOrgContextOrThrow, type Membership, type OrgContext } from "@/server/tenancy/context";
import type { SessionUser } from "@/server/auth/service";
import { permissionsFor, roleHasPermission, type OrgRole, type Permission } from "@/lib/permissions";

/**
 * An organization context for an agency user working inside one client's tenant. It carries the agency role, so every check still goes through the
 * normal permission matrix (website.edit for staff, website.publish for super admins only), and `agencyCanAccessOrg` has already confirmed the
 * person is assigned to this client (or is a super admin). It never widens what the role allows.
 */
export function agencyOrgContext(user: SessionUser, org: { orgId: string; name: string; slug: string; status: Membership["status"]; timezone: string; isDemo?: boolean }): OrgContext {
  const role = user.platformRole;
  if (role === "none") throw new AppError("forbidden", "Agency access is required.");
  const membership: Membership = {
    orgId: org.orgId, name: org.name, slug: org.slug, kind: "client", status: org.status, role: role as unknown as OrgRole,
    isDemo: org.isDemo === true, onboardingCompletedAt: null, timezone: org.timezone,
  };
  return { user, org: membership, role: role as unknown as OrgRole, permissions: permissionsFor(role), can: (p) => roleHasPermission(role, p), memberships: [] };
}

/**
 * The tenant a Studio request acts on. A client user always acts on their own active workspace (a different `orgId` is refused, not honoured).
 * An agency user names the client they were assigned to. Either way the server decides, never the request.
 */
export async function studioContext(orgId: string | null | undefined, permission?: Permission): Promise<OrgContext> {
  const user = await requireUserOrThrow();
  if (!orgId) {
    const ctx = await requireOrgContextOrThrow(permission);
    // An agency user's own workspace is not a client site, so there is nothing to edit there.
    if (ctx.org.kind !== "client") throw new AppError("invalid_input", "Choose a client to work on.");
    return ctx;
  }
  if (user.platformRole === "none") {
    const ctx = await requireOrgContextOrThrow(permission);
    if (ctx.org.orgId !== orgId) throw new AppError("forbidden", "You don't have access to that workspace.");
    return ctx;
  }
  if (!(await agencyCanAccessOrg(user, orgId))) throw new AppError("forbidden", "You are not assigned to this client.");
  const org = await withSystem(async (db) =>
    (await db.query<{ id: string; name: string; slug: string; status: Membership["status"]; timezone: string; is_demo: boolean; kind: string }>(
      "select id, name, slug, status, timezone, is_demo, kind from organizations where id = $1", [orgId])).rows[0],
  );
  if (!org || org.kind !== "client") throw new AppError("not_found", "Client not found.");
  const ctx = agencyOrgContext(user, { orgId: org.id, name: org.name, slug: org.slug, status: org.status, timezone: org.timezone, isDemo: org.is_demo });
  if (permission && !ctx.can(permission)) throw new AppError("forbidden", "Your role doesn't allow this action.");
  return ctx;
}
