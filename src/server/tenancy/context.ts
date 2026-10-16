import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { ORG_COOKIE, getCurrentUser, requireUser, requireUserOrThrow } from "@/server/auth/session";
import type { SessionUser } from "@/server/auth/service";
import { PERMISSION_MATRIX, effectivePermission, isDelegablePermission, type OrgRole, type Permission, type PermissionOverrides } from "@/lib/permissions";

export interface Membership {
  orgId: string;
  name: string;
  slug: string;
  kind: "agency" | "client";
  status: "invited" | "onboarding" | "active" | "suspended" | "archived";
  role: OrgRole;
  isDemo: boolean;
  onboardingCompletedAt: string | null;
  timezone: string;
}

export interface OrgContext {
  user: SessionUser;
  org: Membership;
  role: OrgRole;
  permissions: Permission[];
  can: (permission: Permission) => boolean;
  memberships: Membership[];
}

export async function listMemberships(userId: string): Promise<Membership[]> {
  return withSystem(async (db) => {
    const { rows } = await db.query<{
      org_id: string;
      name: string;
      slug: string;
      kind: "agency" | "client";
      status: Membership["status"];
      role: OrgRole;
      is_demo: boolean;
      onboarding_completed_at: Date | null;
      timezone: string;
    }>(
      `select o.id as org_id, o.name, o.slug, o.kind, o.status, m.role, o.is_demo, o.onboarding_completed_at, o.timezone
       from organization_memberships m join organizations o on o.id = m.org_id
       where m.user_id = $1 and m.status = 'active' and o.status not in ('archived')
       order by o.kind desc, o.name`,
      [userId],
    );
    return rows.map((r) => ({
      orgId: r.org_id,
      name: r.name,
      slug: r.slug,
      kind: r.kind,
      status: r.status,
      role: r.role,
      isDemo: r.is_demo,
      onboardingCompletedAt: r.onboarding_completed_at ? new Date(r.onboarding_completed_at).toISOString() : null,
      timezone: r.timezone,
    }));
  });
}

/** Per-person grants and withdrawals of delegable permissions in one workspace. The database applies the same rule in app.has_permission. */
export async function loadPermissionOverrides(userId: string, orgId: string): Promise<PermissionOverrides> {
  const { rows } = await withSystem((db) =>
    db.query<{ permission: string; effect: "grant" | "revoke" }>("select permission, effect from member_permission_overrides where org_id = $1 and user_id = $2", [orgId, userId]),
  );
  const out: PermissionOverrides = {};
  for (const r of rows) if (isDelegablePermission(r.permission)) out[r.permission] = r.effect;
  return out;
}

export function buildContext(user: SessionUser, org: Membership, memberships: Membership[], overrides: PermissionOverrides = {}): OrgContext {
  const can = (p: Permission) => effectivePermission(org.role, p, overrides);
  const permissions = (Object.keys(PERMISSION_MATRIX) as Permission[]).filter(can);
  return {
    user,
    org,
    role: org.role,
    permissions,
    can,
    memberships,
  };
}

/**
 * The active tenant is chosen by a cookie but only ever honoured when the signed-in user holds
 * an active membership in it. Changing the cookie, URL or request body cannot widen access.
 */
export const getOrgContext = cache(async (): Promise<OrgContext | null> => {
  const user = await getCurrentUser();
  if (!user) return null;
  const memberships = await listMemberships(user.id);
  const usable = memberships.filter((m) => m.status !== "suspended");
  if (usable.length === 0) return null;
  const jar = await cookies();
  const preferred = jar.get(ORG_COOKIE)?.value;
  const org = usable.find((m) => m.orgId === preferred) ?? usable[0];
  return buildContext(user, org, memberships, org.role === "owner" ? {} : await loadPermissionOverrides(user.id, org.orgId));
});

/** Pages: redirect to the right place when there is no usable workspace. */
export async function requireOrgContext(permission?: Permission): Promise<OrgContext> {
  const user = await requireUser();
  const ctx = await getOrgContext();
  if (!ctx) {
    if (user.platformRole !== "none") redirect("/admin");
    redirect("/no-workspace");
  }
  if (permission && !ctx.can(permission)) redirect("/overview?denied=1");
  return ctx;
}

/** Route handlers and server actions. */
export async function requireOrgContextOrThrow(permission?: Permission): Promise<OrgContext> {
  await requireUserOrThrow();
  const ctx = await getOrgContext();
  if (!ctx) throw new AppError("forbidden", "You don't have access to a workspace.");
  if (ctx.org.status === "suspended") throw new AppError("forbidden", "This workspace is suspended. Contact iAcquire support.");
  if (permission && !ctx.can(permission)) {
    throw new AppError("forbidden", "Your role doesn't allow this action. Ask a workspace owner for access.");
  }
  return ctx;
}

export async function switchActiveOrg(orgId: string): Promise<boolean> {
  const user = await requireUserOrThrow();
  const memberships = await listMemberships(user.id);
  if (!memberships.some((m) => m.orgId === orgId && m.status !== "suspended")) return false;
  const jar = await cookies();
  jar.set(ORG_COOKIE, orgId, { httpOnly: true, sameSite: "lax", path: "/", secure: process.env.NODE_ENV === "production" });
  return true;
}

// ---------------------------------------------------------------------------
// Agency access
// ---------------------------------------------------------------------------

export async function requireAgency(level: "staff" | "super_admin" = "staff"): Promise<SessionUser> {
  const user = await requireUser();
  const ok = level === "super_admin" ? user.platformRole === "agency_super_admin" : user.platformRole !== "none";
  if (!ok) redirect("/overview");
  return user;
}

export async function requireAgencyOrThrow(level: "staff" | "super_admin" = "staff"): Promise<SessionUser> {
  const user = await requireUserOrThrow();
  const ok = level === "super_admin" ? user.platformRole === "agency_super_admin" : user.platformRole !== "none";
  if (!ok) throw new AppError("forbidden", "Agency access is required.");
  return user;
}

/** Whether an agency user may administer a specific client tenant. */
export async function agencyCanAccessOrg(user: SessionUser, orgId: string): Promise<boolean> {
  if (user.platformRole === "agency_super_admin") return true;
  if (user.platformRole !== "agency_staff") return false;
  const { rows } = await withSystem((db) =>
    db.query("select 1 from staff_assignments where org_id = $1 and user_id = $2", [orgId, user.id]),
  );
  return rows.length > 0;
}

export async function requireAgencyOrgAccessOrThrow(orgId: string, level: "staff" | "super_admin" = "staff") {
  const user = await requireAgencyOrThrow(level);
  if (!(await agencyCanAccessOrg(user, orgId))) throw new AppError("forbidden", "You are not assigned to this client.");
  return user;
}
