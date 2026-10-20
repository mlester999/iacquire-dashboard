import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { readSystem, withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { ORG_COOKIE, getCurrentUser, requireUser, requireUserOrThrow } from "@/server/auth/session";
import type { SessionUser } from "@/server/auth/service";
import {
  isAgencyTeamPermission,
  PERMISSION_MATRIX,
  effectivePermission,
  isDelegablePermission,
  type AgencyPermission,
  type AgencyPermissionOverrides,
  type OrgRole,
  type Permission,
  type PermissionOverrides,
  type PlatformRole,
} from "@/lib/permissions";

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

interface TenancyRow {
  memberships: Array<{
    org_id: string;
    name: string;
    slug: string;
    kind: "agency" | "client";
    status: Membership["status"];
    role: OrgRole;
    is_demo: boolean;
    onboarding_completed_at: string | null;
    timezone: string;
  }>;
  overrides: Array<{ org_id: string; permission: string; effect: "grant" | "revoke" }>;
}

/**
 * The active tenant's memberships and every per-person override in one read. This used to run as
 * two separate transactions (six sequential round trips) on every server render. The answer is
 * still the authoritative, RLS-backed one: it is filtered by the user id from the verified
 * session, and the permission rules themselves are unchanged.
 */
export async function loadTenancy(userId: string): Promise<{ memberships: Membership[]; overridesByOrg: Record<string, PermissionOverrides> }> {
  const { rows } = await readSystem((db) =>
    db.query<TenancyRow>(
      `select
         coalesce((select json_agg(json_build_object(
             'org_id', o.id, 'name', o.name, 'slug', o.slug, 'kind', o.kind, 'status', o.status,
             'role', m.role, 'is_demo', o.is_demo, 'onboarding_completed_at', o.onboarding_completed_at,
             'timezone', o.timezone) order by o.kind desc, o.name)
           from organization_memberships m join organizations o on o.id = m.org_id
           where m.user_id = $1 and m.status = 'active' and o.status not in ('archived')), '[]'::json) as memberships,
         coalesce((select json_agg(json_build_object(
             'org_id', org_id, 'permission', permission, 'effect', effect))
           from member_permission_overrides where user_id = $1), '[]'::json) as overrides`,
      [userId],
    ),
  );
  const row = rows[0];
  const memberships = (row?.memberships ?? []).map((r) => ({
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
  const overridesByOrg: Record<string, PermissionOverrides> = {};
  for (const r of row?.overrides ?? []) {
    if (!isDelegablePermission(r.permission)) continue;
    (overridesByOrg[r.org_id] ??= {})[r.permission] = r.effect;
  }
  return { memberships, overridesByOrg };
}

/** Per-person agency action overrides. Role defaults remain in role_permissions and are resolved on every request. */
export async function loadAgencyPermissionOverrides(userId: string): Promise<AgencyPermissionOverrides> {
  const { rows } = await withSystem((db) =>
    db.query<{ permission: string; effect: "allow" | "deny" }>("select permission,effect from agency_user_permission_overrides where user_id=$1", [userId]),
  );
  const out: AgencyPermissionOverrides = {};
  for (const row of rows) if (isAgencyTeamPermission(row.permission)) out[row.permission] = row.effect;
  return out;
}

export async function loadAgencyRolePermissions(role: PlatformRole): Promise<Set<Permission>> {
  if (role === "none") return new Set();
  const { rows } = await withSystem((db) => db.query<{ permission: string }>("select permission from role_permissions where role=$1", [role]));
  return new Set(rows.map((row) => row.permission).filter((permission): permission is Permission => permission in PERMISSION_MATRIX));
}

export async function agencyUserHasPermission(userId: string, permission: AgencyPermission | Permission): Promise<boolean> {
  const { rows } = await withSystem((db) => db.query<{ allowed: boolean }>(
    "select coalesce(app.user_has_agency_permission($1,$2),false) as allowed",
    [userId, permission],
  ));
  return rows[0]?.allowed === true;
}

/** Loads the current, database-resolved agency permissions for server-rendered navigation. */
export async function loadAgencyPermissions(userId: string): Promise<Permission[]> {
  const permissions = Object.keys(PERMISSION_MATRIX) as Permission[];
  const { rows } = await withSystem((db) => db.query<{ permission: string }>(
    `select p.permission from unnest($2::text[]) as p(permission)
     where coalesce(app.user_has_agency_permission($1,p.permission),false)`,
    [userId, permissions],
  ));
  return rows.map((row) => row.permission).filter((permission): permission is Permission => permission in PERMISSION_MATRIX);
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
  const { memberships, overridesByOrg } = await loadTenancy(user.id);
  const usable = memberships.filter((m) => m.status !== "suspended");
  if (usable.length === 0) return null;
  const jar = await cookies();
  const preferred = jar.get(ORG_COOKIE)?.value;
  const org = usable.find((m) => m.orgId === preferred) ?? usable[0];
  return buildContext(user, org, memberships, org.role === "owner" ? {} : overridesByOrg[org.orgId] ?? {});
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

/** Agency-level permission check for global actions. Overrides can never grant owner/security permissions. */
export async function requireAgencyPermissionOrThrow(permission: AgencyPermission): Promise<SessionUser> {
  const user = await requireAgencyOrThrow();
  const { rows } = await withSystem((db) => db.query<{ allowed: boolean }>(
    "select coalesce(app.user_has_agency_permission($1, $2), false) as allowed",
    [user.id, permission],
  ));
  if (rows[0]?.allowed !== true) throw new AppError("forbidden", "Your agency role does not allow this action.");
  return user;
}

/** Whether an agency user may administer a specific client tenant. */
export async function agencyCanAccessOrg(user: SessionUser, orgId: string): Promise<boolean> {
  const { rows } = await withSystem((db) =>
    db.query<{ allowed: boolean }>("select app.user_can_access_org($1, $2) as allowed", [user.id, orgId]),
  );
  return rows[0]?.allowed === true;
}

/** Checked against the current profile and client-scope function on each request. */
export async function requireAgencyOrgPermissionOrThrow(orgId: string, permission: Permission): Promise<SessionUser> {
  const user = await requireAgencyOrThrow();
  const { rows } = await withSystem((db) => db.query<{ allowed: boolean }>(
    "select app.user_can_access_org($1,$2) and app.user_has_agency_permission($1,$3) as allowed",
    [user.id, orgId, permission],
  ));
  if (rows[0]?.allowed !== true) throw new AppError("forbidden", "Your role or client scope does not allow this action.");
  return user;
}

export async function requireAgencyOrgAccessOrThrow(orgId: string, level: "staff" | "super_admin" = "staff") {
  const user = await requireAgencyOrThrow(level);
  if (!(await agencyCanAccessOrg(user, orgId))) throw new AppError("forbidden", "You are not assigned to this client.");
  return user;
}
