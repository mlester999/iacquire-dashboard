import "server-only";
import {
  AGENCY_TEAM_MANAGED_PERMISSIONS,
  PERMISSION_MATRIX,
  isAgencyTeamPermission,
  type AgencyPermissionOverrides,
  type AgencyTeamPermission,
  type Permission,
  type PlatformRole,
} from "@/lib/permissions";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import type { SessionUser } from "@/server/auth/service";

export type AgencyScopeMode = "all_clients" | "assigned_clients";
export type AgencyPermissionEffect = "allow" | "deny";

export interface AgencyTeamView {
  permissionDefaults: Record<"agency_manager" | "agency_staff", Partial<Record<Permission, boolean>>>;
  members: Array<{
    id: string;
    name: string;
    email: string;
    role: Extract<PlatformRole, "agency_manager" | "agency_staff" | "agency_super_admin">;
    status: string;
    scopeMode: AgencyScopeMode;
    lastLoginAt: string | null;
    clients: Array<{ id: string; name: string }>;
    permissionOverrides: AgencyPermissionOverrides;
    revision: string;
    activity: Array<{ actorName: string | null; actorRole: string | null; action: string; result: string; occurredAt: string; targetType: string | null; metadata: Record<string, unknown> }>;
    openTasks: number;
    openTickets: number;
  }>;
  invitations: Array<{ id: string; email: string; role: string; scopeMode: AgencyScopeMode; initialAssignments: number; customPermissionCount: number; deliveryStatus: string | null; expiresAt: string }>;
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
      status: string; scope_mode: AgencyScopeMode | null; last_login_at: Date | null; open_tasks: number; open_tickets: number; permission_revision: string | null;
    }>(
      `select u.id,u.full_name,u.email,u.platform_role,u.status,s.scope_mode,u.last_login_at,v.revision::text as permission_revision,
       (select count(*)::int from client_setup_tasks t where t.assigned_to=u.id and t.status<>'completed' and not t.hidden and not t.service_excluded) as open_tasks,
       (select count(*)::int from support_tickets t where t.assigned_to=u.id and t.status in ('open','in_progress','waiting_for_client')) as open_tickets
       from users u left join agency_user_client_scopes s on s.user_id=u.id
       left join agency_team_member_versions v on v.user_id=u.id
       where u.platform_role in ('agency_super_admin','agency_manager','agency_staff')
       order by case u.platform_role when 'agency_super_admin' then 0 when 'agency_manager' then 1 else 2 end,u.full_name,u.email`,
    );
    const roleDefaults = await db.query<{ role: "agency_manager" | "agency_staff"; permission: string }>(
      "select role,permission from role_permissions where role=any($1::text[])",
      [["agency_manager", "agency_staff"]],
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
    const activity = await db.query<{ member_id: string; actor_user_id: string | null; actor_name: string | null; actor_role: string | null; target_id: string | null; target_type: string | null; target_email: string | null; action: string; result: string; metadata: Record<string, unknown>; created_at: Date }>(
      `select member.id as member_id,a.actor_user_id,actor.full_name as actor_name,actor.platform_role as actor_role,
         a.target_id,a.target_type,invite.email::text as target_email,a.action,a.result,a.metadata,a.created_at
       from users member
       cross join lateral (
         select a.*
         from audit_logs a
         left join invitations invite on a.target_type='invitation' and a.target_id=invite.id::text
         where a.actor_user_id=member.id
            or (a.target_type='user' and a.target_id=member.id::text)
            or (a.target_type='invitation' and lower(invite.email::text)=lower(member.email::text))
         order by a.created_at desc,a.id desc
         limit 30
       ) a
       left join users actor on actor.id=a.actor_user_id
       left join invitations invite on a.target_type='invitation' and a.target_id=invite.id::text
       where member.id=any($1::uuid[])
       order by member.id,a.created_at desc,a.id desc`,
      [memberIds],
    );
    const invitations = await db.query<{ id: string; email: string; platform_role: string; agency_scope_mode: AgencyScopeMode; initial_assignments: number; custom_permission_count: number; email_delivery_status: string | null; expires_at: Date }>(
      `select i.id,i.email::text as email,i.platform_role,i.agency_scope_mode,
       (select count(*)::int from invitation_client_assignments a where a.invitation_id=i.id) as initial_assignments,
       (select count(*)::int from invitation_agency_permission_overrides p where p.invitation_id=i.id) as custom_permission_count,
       i.email_delivery_status,i.expires_at from invitations i
       where i.org_id is null and i.accepted_at is null and i.revoked_at is null and i.expires_at>now() order by i.created_at desc`,
    );

    const permissionDefaults: AgencyTeamView["permissionDefaults"] = { agency_manager: {}, agency_staff: {} };
    for (const row of roleDefaults.rows) {
      if (row.permission in PERMISSION_MATRIX) permissionDefaults[row.role][row.permission as Permission] = true;
    }

    return {
      permissionDefaults,
      members: members.rows.map((m) => ({
        id: m.id,
        name: m.full_name || m.email,
        email: m.email,
        role: m.platform_role,
        status: m.status,
        scopeMode: m.scope_mode ?? (m.platform_role === "agency_manager" ? "all_clients" : "assigned_clients"),
        lastLoginAt: m.last_login_at ? new Date(m.last_login_at).toISOString() : null,
        clients: assignments.rows.filter((a) => a.user_id === m.id).map((a) => ({ id: a.org_id, name: a.name })),
        permissionOverrides: Object.fromEntries(overrides.rows.filter((o) => o.user_id === m.id && isAgencyTeamPermission(o.permission)).map((o) => [o.permission, o.effect])) as AgencyPermissionOverrides,
        revision: m.permission_revision ?? "0",
        activity: activity.rows.filter((a) => a.member_id === m.id).map((a) => ({
          actorName: a.actor_name,
          actorRole: a.actor_role,
          action: a.action,
          result: a.result,
          occurredAt: new Date(a.created_at).toISOString(),
          targetType: a.target_type,
          metadata: a.metadata ?? {},
        })),
        openTasks: m.open_tasks,
        openTickets: m.open_tickets,
      })),
      invitations: invitations.rows.map((i) => ({ id: i.id, email: i.email, role: i.platform_role, scopeMode: i.agency_scope_mode, initialAssignments: i.initial_assignments, customPermissionCount: i.custom_permission_count, deliveryStatus: i.email_delivery_status, expiresAt: new Date(i.expires_at).toISOString() })),
      clients: clients.rows.map((c) => ({ id: c.id, name: c.name, assignedStaff: c.assigned_staff })),
      coverage: { total: clients.rows.length, assigned: clients.rows.filter((c) => c.assigned_staff > 0).length },
    };
  });
}

function requireSuperAdmin(admin: SessionUser) {
  if (admin.platformRole !== "agency_super_admin") throw new AppError("forbidden", "Only agency super admins can manage agency team access.");
}

async function assertCurrentSuperAdmin(db: Queryable, userId: string) {
  const access = await db.query("select 1 from users where id=$1 and status='active' and platform_role='agency_super_admin'", [userId]);
  if (!access.rows.length) throw new AppError("forbidden", "Only active agency super admins can manage team access.");
}

async function lockMember(db: Queryable, userId: string, expectedRevision?: string) {
  const target = await db.query<{ platform_role: string; status: string }>("select platform_role,status from users where id=$1 for update", [userId]);
  if (!target.rows[0] || !["agency_manager", "agency_staff"].includes(target.rows[0].platform_role)) {
    throw new AppError("forbidden", "Super Admin accounts and non-agency accounts cannot be changed here.");
  }
  await db.query("insert into agency_team_member_versions(user_id) values($1) on conflict(user_id) do nothing", [userId]);
  const version = await db.query<{ revision: string }>("select revision::text as revision from agency_team_member_versions where user_id=$1 for update", [userId]);
  const revision = version.rows[0]?.revision ?? "0";
  if (expectedRevision !== undefined && expectedRevision !== revision) {
    throw new AppError("conflict", "This team member changed in another session. Reload the page and review the latest settings.");
  }
  return { ...target.rows[0], revision };
}

async function bumpMemberRevision(db: Queryable, userId: string, updatedBy: string) {
  await db.query("update agency_team_member_versions set revision=revision+1,updated_by=$2,updated_at=now() where user_id=$1", [userId, updatedBy]);
}

/** Changes only delegable agency roles; Super Admin ownership cannot be assigned or edited here. */
export async function updateAgencyTeamMember(
  admin: SessionUser,
  input: { userId: string; platformRole: "agency_manager" | "agency_staff"; status: "active" | "disabled"; scopeMode: AgencyScopeMode; expectedRevision?: string; permissionOverrides?: AgencyPermissionOverrides },
) {
  requireSuperAdmin(admin);
  if (input.scopeMode === "all_clients" && input.platformRole !== "agency_manager") throw new AppError("invalid_input", "Only an Agency Manager can have all-client scope.");
  await withSystem(async (db) => {
    await assertCurrentSuperAdmin(db, admin.id);
    const previous = await lockMember(db, input.userId, input.expectedRevision);
    const previousScope = await db.query<{ scope_mode: AgencyScopeMode | null }>("select scope_mode from agency_user_client_scopes where user_id=$1", [input.userId]);
    const oldScope = previousScope.rows[0]?.scope_mode ?? (previous.platform_role === "agency_manager" ? "all_clients" : "assigned_clients");
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
    if (input.permissionOverrides !== undefined) {
      const entries = Object.entries(input.permissionOverrides);
      if (entries.some(([permission, effect]) => !isAgencyTeamPermission(permission) || (effect !== "allow" && effect !== "deny"))) {
        throw new AppError("invalid_input", "One or more permission overrides are not supported.");
      }
      const before = await db.query<{ permission: string; effect: AgencyPermissionEffect }>("select permission,effect from agency_user_permission_overrides where user_id=$1", [input.userId]);
      await db.query("delete from agency_user_permission_overrides where user_id=$1", [input.userId]);
      for (const [permission, effect] of entries) {
        await db.query(
          "insert into agency_user_permission_overrides(user_id,permission,effect,reason,updated_by) values($1,$2,$3,'Updated with role or scope',$4)",
          [input.userId, permission, effect, admin.id],
        );
      }
      const beforeMap = new Map(before.rows.map((row) => [row.permission, row.effect]));
      const changes = new Set([...beforeMap.keys(), ...entries.map(([permission]) => permission)]);
      const changed = [...changes].filter((permission) => beforeMap.get(permission) !== input.permissionOverrides?.[permission as AgencyTeamPermission]);
      if (changed.length) {
        await recordAudit({ actorUserId: admin.id, actorKind: "agency", action: "team.permissions_updated", targetType: "user", targetId: input.userId, result: "success", metadata: { changes: changed.map((permission) => ({ permission, from: beforeMap.get(permission) ?? "role_default", to: input.permissionOverrides?.[permission as AgencyTeamPermission] ?? "role_default" })) } }, db);
      }
    }
    await bumpMemberRevision(db, input.userId, admin.id);
    // Both custom sessions and the per-request profile check used by Supabase Auth now reject stale access.
    await db.query("update auth_sessions set revoked_at=now() where user_id=$1 and revoked_at is null", [input.userId]);
    await recordAudit({
      actorUserId: admin.id, actorKind: "agency", action: "team.access_updated", targetType: "user", targetId: input.userId, result: "success",
      metadata: {
        changes: [
          ...(previous.platform_role !== input.platformRole ? [{ field: "role", from: previous.platform_role, to: input.platformRole }] : []),
          ...(previous.status !== input.status ? [{ field: "status", from: previous.status, to: input.status }] : []),
          ...(oldScope !== input.scopeMode ? [{ field: "scope", from: oldScope, to: input.scopeMode }] : []),
        ],
      },
    }, db);
  });
}

export async function updateAgencyUserPermission(
  admin: SessionUser,
  input: { userId: string; permission: AgencyTeamPermission; effect: AgencyPermissionEffect | null; reason?: string; expectedRevision?: string },
) {
  await updateAgencyUserPermissions(admin, {
    userId: input.userId,
    permissions: { [input.permission]: input.effect },
    expectedRevision: input.expectedRevision,
    reason: input.reason,
  });
}

export async function updateAgencyUserPermissions(
  admin: SessionUser,
  input: { userId: string; permissions: Partial<Record<AgencyTeamPermission, AgencyPermissionEffect | null>>; expectedRevision?: string; reason?: string },
) {
  requireSuperAdmin(admin);
  const changes = Object.entries(input.permissions);
  if (!changes.length || changes.some(([permission, effect]) => !isAgencyTeamPermission(permission) || ![null, "allow", "deny"].includes(effect))) {
    throw new AppError("invalid_input", "Choose supported permissions and access states.");
  }
  const reason = (input.reason ?? "").trim().slice(0, 300);
  await withSystem(async (db) => {
    await assertCurrentSuperAdmin(db, admin.id);
    const target = await lockMember(db, input.userId, input.expectedRevision);
    if (target.status !== "active") throw new AppError("conflict", "Reactivate this account before changing its permissions.");
    const before = await db.query<{ permission: string; effect: AgencyPermissionEffect }>(
      "select permission,effect from agency_user_permission_overrides where user_id=$1 and permission=any($2::text[])",
      [input.userId, changes.map(([permission]) => permission)],
    );
    const previous = new Map(before.rows.map((row) => [row.permission, row.effect]));
    for (const [permission, effect] of changes) {
      if (effect === null) {
        await db.query("delete from agency_user_permission_overrides where user_id=$1 and permission=$2", [input.userId, permission]);
      } else {
        await db.query(
          `insert into agency_user_permission_overrides(user_id,permission,effect,reason,updated_by)
           values($1,$2,$3,$4,$5) on conflict(user_id,permission) do update
           set effect=excluded.effect,reason=excluded.reason,updated_by=excluded.updated_by,updated_at=now()`,
          [input.userId, permission, effect, reason, admin.id],
        );
      }
    }
    await db.query("update auth_sessions set revoked_at=now() where user_id=$1 and revoked_at is null", [input.userId]);
    await bumpMemberRevision(db, input.userId, admin.id);
    await recordAudit({
      actorUserId: admin.id, actorKind: "agency", action: "team.permissions_updated", targetType: "user", targetId: input.userId, result: "success",
      metadata: { reason, changes: changes.map(([permission, effect]) => ({ permission, from: previous.get(permission) ?? "role_default", to: effect ?? "role_default" })) },
    }, db);
  });
}

/** Copies effective values for the selected safe actions. Roles, scope and client assignments never copy. */
export async function copyAgencyUserPermissions(
  admin: SessionUser,
  input: { sourceUserId: string; targetUserId: string; permissions: AgencyTeamPermission[]; expectedRevision: string },
) {
  requireSuperAdmin(admin);
  const permissions = [...new Set(input.permissions)];
  if (input.sourceUserId === input.targetUserId || !permissions.length || permissions.length > AGENCY_TEAM_MANAGED_PERMISSIONS.length || permissions.some((permission) => !isAgencyTeamPermission(permission))) {
    throw new AppError("invalid_input", "Choose a different source and supported permissions to copy.");
  }
  await withSystem(async (db) => {
    await assertCurrentSuperAdmin(db, admin.id);
    for (const userId of [input.sourceUserId, input.targetUserId].sort()) {
      await db.query("select id from users where id=$1 for update", [userId]);
      await db.query("insert into agency_team_member_versions(user_id) values($1) on conflict(user_id) do nothing", [userId]);
      await db.query("select revision from agency_team_member_versions where user_id=$1 for update", [userId]);
    }
    const people = await db.query<{ id: string; platform_role: string; status: string; revision: string }>(
      "select u.id,u.platform_role,u.status,v.revision::text as revision from users u join agency_team_member_versions v on v.user_id=u.id where u.id=any($1::uuid[])",
      [[input.sourceUserId, input.targetUserId]],
    );
    const source = people.rows.find((row) => row.id === input.sourceUserId);
    const target = people.rows.find((row) => row.id === input.targetUserId);
    if (!source || !target || !["agency_manager", "agency_staff"].includes(source.platform_role) || !["agency_manager", "agency_staff"].includes(target.platform_role)) {
      throw new AppError("invalid_input", "Copying is available only between Agency Managers and Agency Staff.");
    }
    if (source.status !== "active" || target.status !== "active") throw new AppError("conflict", "Reactivate both accounts before copying permissions.");
    if (target.revision !== input.expectedRevision) throw new AppError("conflict", "The destination member changed in another session. Reload and review the latest settings.");
    const defaults = await db.query<{ role: string; permission: string }>(
      "select role,permission from role_permissions where role=any($1::text[]) and permission=any($2::text[])",
      [[source.platform_role, target.platform_role], permissions],
    );
    const roleDefault = (role: string, permission: string) => defaults.rows.some((row) => row.role === role && row.permission === permission);
    const overrideRows = await db.query<{ user_id: string; permission: string; effect: AgencyPermissionEffect }>(
      "select user_id,permission,effect from agency_user_permission_overrides where user_id=any($1::uuid[]) and permission=any($2::text[])",
      [[input.sourceUserId, input.targetUserId], permissions],
    );
    const sourceOverrides = new Map(overrideRows.rows.filter((row) => row.user_id === input.sourceUserId).map((row) => [row.permission, row.effect]));
    const targetOverrides = new Map(overrideRows.rows.filter((row) => row.user_id === input.targetUserId).map((row) => [row.permission, row.effect]));
    const copied: Array<{ permission: string; from: string; to: string }> = [];
    for (const permission of permissions) {
      const from = sourceOverrides.get(permission) === "allow" ? true : sourceOverrides.get(permission) === "deny" ? false : roleDefault(source.platform_role, permission);
      const to = roleDefault(target.platform_role, permission);
      const effect = from === to ? null : from ? "allow" : "deny";
      if (effect === null) await db.query("delete from agency_user_permission_overrides where user_id=$1 and permission=$2", [input.targetUserId, permission]);
      else await db.query(
        `insert into agency_user_permission_overrides(user_id,permission,effect,reason,updated_by) values($1,$2,$3,'Copied from another teammate',$4)
         on conflict(user_id,permission) do update set effect=excluded.effect,reason=excluded.reason,updated_by=excluded.updated_by,updated_at=now()`,
        [input.targetUserId, permission, effect, admin.id],
      );
      if (targetOverrides.get(permission) !== effect) copied.push({ permission, from: sourceOverrides.get(permission) ?? (roleDefault(source.platform_role, permission) ? "role_default_allow" : "role_default_deny"), to: effect ?? "role_default" });
    }
    await db.query("update auth_sessions set revoked_at=now() where user_id=$1 and revoked_at is null", [input.targetUserId]);
    await bumpMemberRevision(db, input.targetUserId, admin.id);
    await recordAudit({ actorUserId: admin.id, actorKind: "agency", action: "team.permissions_copied", targetType: "user", targetId: input.targetUserId, result: "success", metadata: { sourceUserId: input.sourceUserId, permissions: copied } }, db);
  });
}

export async function agencyTeamMemberView(admin: SessionUser, userId: string) {
  const view = await agencyTeamView(admin);
  return { view, member: view.members.find((member) => member.id === userId && member.role !== "agency_super_admin") ?? null };
}
