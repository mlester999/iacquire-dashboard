import "server-only";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import type { SessionUser } from "@/server/auth/service";
import type { TicketStatus, RequestType, FeedbackStage, TicketPriority } from "@/lib/support/lifecycle";

export const AGENCY_SUPPORT_PERMISSIONS = [
  "agency.support.view",
  "agency.support.manage",
  "agency.support.queue",
  "agency.support.notes",
  "agency.support.assign",
  "agency.support.priority",
  "agency.support.resolve",
  "agency.support.analytics",
  "agency.support.settings",
] as const;
export type AgencySupportPermission = (typeof AGENCY_SUPPORT_PERMISSIONS)[number];
export type AgencySupportCaps = Record<AgencySupportPermission, boolean>;

/** The minimum a service needs to know about a request to authorize an action on it. Never exposes message text. */
export interface TicketCore {
  id: string;
  ref: string;
  org_id: string;
  created_by: string | null;
  subject: string;
  request_type: RequestType;
  category: string;
  status: TicketStatus;
  priority: TicketPriority;
  assigned_to: string | null;
  feedback_stage: FeedbackStage | null;
  first_responded_at: Date | null;
  resolved_at: Date | null;
  reopened_count: number;
}

const CORE_COLUMNS = `id, ref, org_id, created_by, subject, request_type, category, status, priority, assigned_to, feedback_stage, first_responded_at, resolved_at, reopened_count`;

/**
 * Re-reads the person's agency standing from the database for this request: active, still an agency account, inside the client scope
 * (when an org is given) and holding the permission. Nothing the browser sent is trusted. A request outside the person's client scope
 * reads as "not found" so its existence is not revealed.
 */
export async function assertAgencySupportPermission(user: Pick<SessionUser, "id" | "platformRole">, orgId: string | null, permission: AgencySupportPermission): Promise<void> {
  const { rows } = await withSystem((db) =>
    db.query<{ active: boolean; platform_role: string; in_scope: boolean; allowed: boolean }>(
      `select u.status='active' as active,u.platform_role,
         ($2::uuid is null or app.user_can_access_org(u.id,$2)) as in_scope,
         coalesce(app.user_has_agency_permission(u.id,$3),false) as allowed
       from users u where u.id=$1`,
      [user.id, orgId, permission],
    ),
  );
  const current = rows[0];
  if (!current?.active || current.platform_role !== user.platformRole || current.platform_role === "none") {
    throw new AppError("forbidden", "Agency access is required; authorization has changed.");
  }
  if (!current.in_scope) throw new AppError("not_found", "Support request not found.");
  if (!current.allowed) throw new AppError("forbidden", "Your agency role does not allow this support action.");
}

/** Every support permission the person currently holds, in one round trip (for choosing which controls to show and which queue to load). */
export async function loadAgencySupportCaps(userId: string): Promise<AgencySupportCaps> {
  const { rows } = await withSystem((db) =>
    db.query<{ permission: AgencySupportPermission; allowed: boolean }>(
      `select p.permission, coalesce(app.user_has_agency_permission($1, p.permission), false) as allowed
       from unnest($2::text[]) as p(permission)`,
      [userId, AGENCY_SUPPORT_PERMISSIONS as readonly string[]],
    ),
  );
  const caps = Object.fromEntries(AGENCY_SUPPORT_PERMISSIONS.map((p) => [p, false])) as AgencySupportCaps;
  for (const r of rows) caps[r.permission] = r.allowed === true;
  return caps;
}

/**
 * Loads a request for an agency action after checking scope and permission. People without "see the full queue" reach only the
 * requests assigned to them; every other request reads as not found.
 */
export async function loadTicketForAgency(user: SessionUser, ticketId: string, permission: AgencySupportPermission = "agency.support.view"): Promise<TicketCore> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ticketId)) throw new AppError("not_found", "Support request not found.");
  const { rows } = await withSystem((db) => db.query<TicketCore>(`select ${CORE_COLUMNS} from support_tickets where id = $1`, [ticketId]));
  const t = rows[0];
  if (!t) throw new AppError("not_found", "Support request not found.");
  await assertAgencySupportPermission(user, t.org_id, "agency.support.view");
  if (permission !== "agency.support.view") await assertAgencySupportPermission(user, t.org_id, permission);
  const caps = await loadAgencySupportCaps(user.id);
  if (!caps["agency.support.queue"] && t.assigned_to !== user.id) throw new AppError("not_found", "Support request not found.");
  return t;
}

/** Whether a user could be given this request: an active agency person inside the client's scope who can read and work support. */
export async function isEligibleAssignee(userId: string, orgId: string): Promise<boolean> {
  const { rows } = await withSystem((db) =>
    db.query<{ ok: boolean }>(
      `select exists (
         select 1 from users u
         where u.id = $1 and u.status = 'active' and u.platform_role in ('agency_staff', 'agency_manager', 'agency_super_admin')
           and app.user_can_access_org(u.id, $2)
           and coalesce(app.user_has_agency_permission(u.id, 'agency.support.view'), false)
           and coalesce(app.user_has_agency_permission(u.id, 'agency.support.manage'), false)
       ) as ok`,
      [userId, orgId],
    ),
  );
  return rows[0]?.ok === true;
}

export interface Assignee { id: string; name: string; role: string; openAssigned: number }

/**
 * People who can be assigned a request, with the number of active requests already assigned to them. That count is the only workload
 * signal shown: it is a real count of rows, not a score.
 */
export async function listAssignableStaff(orgId: string): Promise<Assignee[]> {
  const { rows } = await withSystem((db) =>
    db.query<{ id: string; name: string; platform_role: string; open_assigned: number }>(
      `select u.id, coalesce(nullif(u.full_name, ''), u.email::text) as name, u.platform_role,
         (select count(*)::int from support_tickets t where t.assigned_to = u.id and t.status in ('new', 'open', 'in_progress', 'waiting_for_client')) as open_assigned
       from users u
       where u.status = 'active' and u.platform_role in ('agency_staff', 'agency_manager', 'agency_super_admin')
         and app.user_can_access_org(u.id, $1)
         and coalesce(app.user_has_agency_permission(u.id, 'agency.support.view'), false)
         and coalesce(app.user_has_agency_permission(u.id, 'agency.support.manage'), false)
       order by open_assigned asc, name`,
      [orgId],
    ),
  );
  return rows.map((r) => ({ id: r.id, name: r.name, role: r.platform_role, openAssigned: r.open_assigned }));
}
