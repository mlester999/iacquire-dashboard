import "server-only";
import { AGENCY_DELEGABLE_PERMISSIONS, AGENCY_PERMISSION_INFO, type AgencyPermission, type PlatformRole } from "@/lib/permissions";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import type { SessionUser } from "@/server/auth/service";

export type AgencyScopeMode = "all_clients" | "assigned_clients";
export type AgencyPermissionEffect = "allow" | "deny";

export interface AgencyTeamView {
  members: Array<{
    id: string;
    name: string;
    email: string;
    role: Extract<PlatformRole, "agency_manager" | "agency_staff" | "agency_super_admin">;
    status: string;
    scopeMode: AgencyScopeMode;
    lastLoginAt: string | null;
    clients: Array<{ id: string; name: string }>;
    permissionOverrides: Partial<Record<AgencyPermission, AgencyPermissionEffect>>;
    activity: Array<{ action: string; result: string; occurredAt: string }>;
    openTasks: number;
    openTickets: number;
  }>;
  invitations: Array<{ id: string; email: string; role: string; scopeMode: AgencyScopeMode; initialAssignments: number; deliveryStatus: string | null; expiresAt: string }>;
  clients: Array<{ id: string; name: string; assignedStaff: number }>;
  coverage: { total: number; assigned: number };
}

/** Read-only aggregates from agency roles and client assignments. */
export async function agencyTeamView(admin: SessionUser): Promise<AgencyTeamView> {
  return withSystem(async (db) => {
    const access = await db.query("select 1 from users where id=$1 and status='active' and platform_role='agency_super_admin'", [admin.id]);
    if (!access.rows.length) throw new AppError("forbidden", "Only agency super admins can inspect the agency team.");

    const members = await db.query<{
      id: string; full_name: string; email: string; platform_role: Extract<PlatformRole, "agency_manager" | "agency_staff" | "agency_super_admin">;
      status: string; scope_mode: AgencyScopeMode | null; last_login_at: Date | null; open_tasks: number; open_tickets: number;
    }>(
      `select u.id,u.full_name,u.email,u.platform_role,u.status,s.scope_mode,u.last_login_at,
       (select count(*)::int from client_setup_tasks t where t.assigned_to=u.id and t.status<>'completed' and not t.hidden and not t.service_excluded) as open_tasks,
       (select count(*)::int from support_tickets t where t.assigned_to=u.id and t.status in ('open','in_progress','waiting_for_client')) as open_tickets
       from users u left join agency_user_client_scopes s on s.user_id=u.id
       where u.platform_role in ('agency_super_admin','agency_manager','agency_staff')
       order by case u.platform_role when 'agency_super_admin' then 0 when 'agency_manager' then 1 else 2 end,u.full_name,u.email`,
    );
    const clients = await db.query<{ id: string; name: string; assigned_staff: number }>(
      `select o.id,o.name,(select count(*)::int from staff_assignments s join users u on u.id=s.user_id and u.status='active' and u.platform_role in ('agency_staff','agency_manager') where s.org_id=o.id) as assigned_staff
       from organizations o where o.kind='client' and o.status<>'archived' order by o.name`,
    );
    const assignments = await db.query<{ user_id: string; org_id: string; name: string }>(
      "select s.user_id,s.org_id,o.name from staff_assignments s join organizations o on o.id=s.org_id where o.kind='client' and o.status<>'archived' order by o.name",
    );
    const overrides = await db.query<{ user_id: string; permission: string; effect: AgencyPermissionEffect }>(
      "select user_id,permission,effect from agency_user_permission_overrides",
    );
    const memberIds = members.rows.map((m) => m.id);
    const activity = await db.query<{ actor_user_id: string | null; target_id: string | null; action: string; result: string; created_at: Date }>(
      `select actor_user_id,target_id,action,result,created_at from audit_logs
       where actor_user_id = any($1::uuid[]) or (target_type='user' and target_id = any($2::text[]))
       order by created_at desc limit 200`,
      [memberIds, memberIds],
    );
    const invitations = await db.query<{ id: string; email: string; platform_role: string; agency_scope_mode: AgencyScopeMode; initial_assignments: number; email_delivery_status: string | null; expires_at: Date }>(
      `select i.id,i.email::text as email,i.platform_role,i.agency_scope_mode,
       (select count(*)::int from invitation_client_assignments a where a.invitation_id=i.id) as initial_assignments,
       i.email_delivery_status,i.expires_at from invitations i
       where i.org_id is null and i.accepted_at is null and i.revoked_at is null and i.expires_at>now() order by i.created_at desc`,
    );

    return {
      members: members.rows.map((m) => ({
        id: m.id,
        name: m.full_name || m.email,
        email: m.email,
        role: m.platform_role,
        status: m.status,
        scopeMode: m.scope_mode ?? (m.platform_role === "agency_manager" ? "all_clients" : "assigned_clients"),
        lastLoginAt: m.last_login_at ? new Date(m.last_login_at).toISOString() : null,
        clients: assignments.rows.filter((a) => a.user_id === m.id).map((a) => ({ id: a.org_id, name: a.name })),
        permissionOverrides: Object.fromEntries(overrides.rows.filter((o) => o.user_id === m.id && o.permission in AGENCY_PERMISSION_INFO).map((o) => [o.permission, o.effect])) as Partial<Record<AgencyPermission, AgencyPermissionEffect>>,
        activity: activity.rows.filter((a) => a.actor_user_id === m.id || a.target_id === m.id).slice(0, 8).map((a) => ({ action: a.action, result: a.result, occurredAt: new Date(a.created_at).toISOString() })),
        openTasks: m.open_tasks,
        openTickets: m.open_tickets,
      })),
      invitations: invitations.rows.map((i) => ({ id: i.id, email: i.email, role: i.platform_role, scopeMode: i.agency_scope_mode, initialAssignments: i.initial_assignments, deliveryStatus: i.email_delivery_status, expiresAt: new Date(i.expires_at).toISOString() })),
      clients: clients.rows.map((c) => ({ id: c.id, name: c.name, assignedStaff: c.assigned_staff })),
      coverage: { total: clients.rows.length, assigned: clients.rows.filter((c) => c.assigned_staff > 0).length },
    };
  });
}

function requireSuperAdmin(admin: SessionUser) {
  if (admin.platformRole !== "agency_super_admin") throw new AppError("forbidden", "Only agency super admins can manage agency team access.");
}

/** Changes only delegable agency roles; Super Admin ownership cannot be assigned or edited here. */
export async function updateAgencyTeamMember(
  admin: SessionUser,
  input: { userId: string; platformRole: "agency_manager" | "agency_staff"; status: "active" | "disabled"; scopeMode: AgencyScopeMode },
) {
  requireSuperAdmin(admin);
  if (input.scopeMode === "all_clients" && input.platformRole !== "agency_manager") throw new AppError("invalid_input", "Only an Agency Manager can have all-client scope.");
  await withSystem(async (db) => {
    const { rows } = await db.query<{ platform_role: string; status: string }>(
      "select platform_role,status from users where id=$1 for update",
      [input.userId],
    );
    if (!rows[0] || !["agency_manager", "agency_staff"].includes(rows[0].platform_role)) {
      throw new AppError("forbidden", "Super Admin accounts and non-agency accounts cannot be changed here.");
    }
    await db.query("update users set platform_role=$2,status=$3 where id=$1", [input.userId, input.platformRole, input.status]);
    if (input.platformRole === "agency_manager" && input.scopeMode === "all_clients") {
      await db.query("delete from agency_user_client_scopes where user_id=$1", [input.userId]);
    } else {
      await db.query(
        `insert into agency_user_client_scopes(user_id,scope_mode,updated_by) values($1,'assigned_clients',$2)
         on conflict(user_id) do update set scope_mode='assigned_clients',updated_by=excluded.updated_by,updated_at=now()`,
        [input.userId, admin.id],
      );
    }
    // Both custom sessions and the per-request profile check used by Supabase Auth now reject stale access.
    await db.query("update auth_sessions set revoked_at=now() where user_id=$1 and revoked_at is null", [input.userId]);
    await recordAudit({ actorUserId: admin.id, actorKind: "agency", action: "team.access_updated", targetType: "user", targetId: input.userId, result: "success", metadata: { role: input.platformRole, status: input.status, scope: input.scopeMode } }, db);
  });
}

export async function updateAgencyUserPermission(
  admin: SessionUser,
  input: { userId: string; permission: AgencyPermission; effect: AgencyPermissionEffect | null; reason?: string },
) {
  requireSuperAdmin(admin);
  if (!AGENCY_DELEGABLE_PERMISSIONS.includes(input.permission)) throw new AppError("forbidden", "This agency permission is protected and cannot be delegated.");
  const reason = (input.reason ?? "").trim().slice(0, 300);
  await withSystem(async (db) => {
    const target = await db.query<{ platform_role: string; status: string }>("select platform_role,status from users where id=$1 for update", [input.userId]);
    if (!target.rows[0] || !["agency_manager", "agency_staff"].includes(target.rows[0].platform_role)) throw new AppError("forbidden", "Only an Agency Manager or Agency Staff account can be customized.");
    if (target.rows[0].status !== "active") throw new AppError("conflict", "Reactivate this account before changing its permissions.");
    if (input.effect === null) {
      await db.query("delete from agency_user_permission_overrides where user_id=$1 and permission=$2", [input.userId, input.permission]);
    } else {
      await db.query(
        `insert into agency_user_permission_overrides(user_id,permission,effect,reason,updated_by)
         values($1,$2,$3,$4,$5) on conflict(user_id,permission) do update
         set effect=excluded.effect,reason=excluded.reason,updated_by=excluded.updated_by,updated_at=now()`,
        [input.userId, input.permission, input.effect, reason, admin.id],
      );
    }
    await db.query("update auth_sessions set revoked_at=now() where user_id=$1 and revoked_at is null", [input.userId]);
    await recordAudit({ actorUserId: admin.id, actorKind: "agency", action: "team.permission_updated", targetType: "user", targetId: input.userId, result: "success", metadata: { permission: input.permission, effect: input.effect, reason } }, db);
  });
}
