import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { consumeRateLimit, RATE_LIMITS, type RateLimitRule } from "@/server/security/rate-limit";
import type { PlatformRole } from "@/lib/permissions";
import { CAP_PERMISSIONS, NO_CAPS, type WorkloadCaps } from "@/lib/staff-workload/visibility";
import { STAFF_WORKLOAD_FEATURE } from "@/lib/staff-workload/rules";

// Every staff workload request starts here. Nothing the browser sent is trusted and nothing from the session is trusted beyond who it names: the person's standing (still
// active, still the same agency role, holding the permission, the module switched on) is read from the database on every request. A person who is demoted, disabled or denied
// the permission is therefore out on their very next request, whatever their session or an open page says.

export type AgencyRole = "agency_staff" | "agency_manager" | "agency_super_admin";

/** The part of a session this module needs. */
export interface StaffUser {
  id: string;
  platformRole: PlatformRole;
}

export interface WorkloadActor {
  userId: string;
  role: AgencyRole;
  /** The name other people see for them. */
  name: string;
  caps: WorkloadCaps;
  /** The one agency workspace every row of this module belongs to. */
  agencyOrgId: string;
  /** The agency workspace's time zone: every day in this module is a day there. */
  timeZone: string;
}

export const NOT_ENABLED_MESSAGE = "Staff workload is not switched on yet. A Super Admin can switch it on.";
export const AUTHORIZATION_CHANGED_MESSAGE = "Agency access is required; authorization has changed.";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isId = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

interface StandingRow {
  active: boolean;
  platform_role: string;
  name: string;
  view: boolean;
  team: boolean;
  assign: boolean;
  manage: boolean;
  settings: boolean;
  agency_org: string | null;
  timezone: string | null;
  enabled: boolean;
}

/** The person's standing in one statement, for any of the module's services (the Super Admin's switch uses it too, because that works while the module is off). */
async function standing(user: StaffUser, db: Queryable | undefined): Promise<StandingRow> {
  if (!isId(user.id)) throw new AppError("forbidden", AUTHORIZATION_CHANGED_MESSAGE);
  const run = (q: Queryable) =>
    q.query<StandingRow>(
      `select u.status = 'active' as active, u.platform_role,
              coalesce(nullif(u.full_name, ''), split_part(u.email::text, '@', 1)) as name,
              coalesce(app.user_has_agency_permission(u.id, $2), false) as view,
              coalesce(app.user_has_agency_permission(u.id, $3), false) as team,
              coalesce(app.user_has_agency_permission(u.id, $4), false) as assign,
              coalesce(app.user_has_agency_permission(u.id, $5), false) as manage,
              coalesce(app.user_has_agency_permission(u.id, $6), false) as settings,
              (select o.id from organizations o where o.kind = 'agency') as agency_org,
              (select o.timezone from organizations o where o.kind = 'agency') as timezone,
              exists (select 1 from org_features f join organizations o on o.id = f.org_id where o.kind = 'agency' and f.feature = $7 and f.enabled) as enabled
         from users u where u.id = $1`,
      [user.id, CAP_PERMISSIONS.view, CAP_PERMISSIONS.team, CAP_PERMISSIONS.assign, CAP_PERMISSIONS.manage, CAP_PERMISSIONS.settings, STAFF_WORKLOAD_FEATURE],
    );
  const { rows } = db ? await run(db) : await withSystem(run);
  const row = rows[0];
  if (!row?.active || row.platform_role === "none" || row.platform_role !== user.platformRole) throw new AppError("forbidden", AUTHORIZATION_CHANGED_MESSAGE);
  return row;
}

/**
 * The person's current standing for a request that uses the module. Throws forbidden when they are not an active agency account of the role their session says (the session is
 * stale), not_enabled when the module is off, unavailable when the agency workspace does not exist, and forbidden when they may not use the workload pages at all.
 */
export async function loadWorkloadActor(user: StaffUser, db?: Queryable): Promise<WorkloadActor> {
  const row = await standing(user, db);
  if (!row.enabled) throw new AppError("not_enabled", NOT_ENABLED_MESSAGE);
  if (!row.agency_org) throw new AppError("unavailable", "The agency workspace does not exist yet, so there is nowhere to keep the workload.");
  if (!row.view) throw new AppError("forbidden", "Your agency role does not allow the workload pages.");
  return {
    userId: user.id,
    role: row.platform_role as AgencyRole,
    name: row.name,
    caps: { view: true, team: row.team, assign: row.assign, manage: row.manage, settings: row.settings },
    agencyOrgId: row.agency_org,
    timeZone: row.timezone ?? "UTC",
  };
}

const CAP_WORDS: Record<Exclude<keyof WorkloadCaps, "view">, string> = {
  team: "Seeing the whole team's workload needs the workload team permission.",
  assign: "Giving work to someone needs the workload assign permission.",
  manage: "Changing someone's capacity, working days, skills or time off needs the workload manage permission.",
  settings: "Changing the workload rules needs the workload settings permission, which only a Super Admin has.",
};

/** Like loadWorkloadActor, and the person must also hold the capability named. A missing one reads as forbidden in words that say which. */
export async function requireWorkloadCap(user: StaffUser, cap: Exclude<keyof WorkloadCaps, "view">, db?: Queryable): Promise<WorkloadActor> {
  const actor = await loadWorkloadActor(user, db);
  if (!actor.caps[cap]) throw new AppError("forbidden", CAP_WORDS[cap]);
  return actor;
}

/** A Super Admin's standing, for the module switch (which works while the module is off). */
export async function loadSuperAdminStanding(user: StaffUser, db?: Queryable): Promise<{ userId: string; agencyOrgId: string }> {
  const row = await standing(user, db);
  if (row.platform_role !== "agency_super_admin") throw new AppError("forbidden", "Only a Super Admin can switch staff workload on or off.");
  if (!row.agency_org) throw new AppError("unavailable", "The agency workspace does not exist yet.");
  return { userId: user.id, agencyOrgId: row.agency_org };
}

export { NO_CAPS };

/** One rule per person, counted before the work is done. */
export async function throttle(rule: keyof Pick<typeof RATE_LIMITS, "staffWorkloadReadByUser" | "staffWorkloadAssignByUser" | "staffWorkloadManageByUser">, userId: string): Promise<void> {
  const r: RateLimitRule = RATE_LIMITS[rule];
  const result = await consumeRateLimit(r, userId);
  if (!result.allowed) throw new AppError("rate_limited", "You are doing that very often. Wait a moment and try again.", { retryAfterSeconds: result.retryAfterSeconds });
}
