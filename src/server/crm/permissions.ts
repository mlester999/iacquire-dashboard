import "server-only";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { assertCan, auditActor, crmRead, crmWrite, type CrmActor } from "@/server/crm/actor";
import { DELEGABLE_PERMISSIONS, effectivePermission, isDelegablePermission, ROLE_LABELS, type DelegablePermission, type OrgRole, type PermissionOverrides } from "@/lib/permissions";

export interface MemberAccess {
  userId: string;
  name: string;
  email: string;
  role: OrgRole;
  roleLabel: string;
  overrides: PermissionOverrides;
  effective: Record<DelegablePermission, boolean>;
  editable: boolean;
}

/** Who can do what, per person, for the delegable CRM permissions. */
export async function listMemberAccess(actor: CrmActor): Promise<MemberAccess[]> {
  assertCan(actor, "team.view");
  return crmRead(actor, async (db) => {
    const members = await db.query<{ user_id: string; full_name: string; email: string; role: OrgRole }>(
      `select m.user_id, u.full_name, u.email::text as email, m.role from organization_memberships m join users u on u.id = m.user_id
       where m.org_id = $1 and m.status = 'active' order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end, lower(u.full_name)`,
      [actor.orgId],
    );
    const ov = await db.query<{ user_id: string; permission: string; effect: "grant" | "revoke" }>("select user_id, permission, effect from member_permission_overrides where org_id = $1", [actor.orgId]);
    const canManage = actor.can("crm.permissions.manage");
    const actorRole = members.rows.find((m) => m.user_id === actor.userId)?.role;
    return members.rows.map((m) => {
      const overrides: PermissionOverrides = {};
      for (const o of ov.rows) if (o.user_id === m.user_id && isDelegablePermission(o.permission)) overrides[o.permission] = o.effect;
      const effective = Object.fromEntries(DELEGABLE_PERMISSIONS.map((p) => [p, effectivePermission(m.role, p, overrides)])) as Record<DelegablePermission, boolean>;
      const editable = canManage && m.user_id !== actor.userId && m.role !== "owner" && !(m.role === "admin" && actorRole !== "owner" && actor.kind === "member");
      return { userId: m.user_id, name: m.full_name || m.email, email: m.email, role: m.role, roleLabel: ROLE_LABELS[m.role], overrides, effective, editable };
    });
  });
}

/**
 * Grants or withdraws one delegable permission for one person, or clears the override (back to their role). Nobody changes their own access,
 * owners are never restricted, only an owner can adjust a manager, and you can only grant a permission you hold yourself.
 */
export async function setPermissionOverride(actor: CrmActor, input: { userId: string; permission: string; effect: "grant" | "revoke" | null; reason?: string }): Promise<void> {
  assertCan(actor, "crm.permissions.manage", "Only owners and managers can change individual permissions.");
  if (!isDelegablePermission(input.permission)) throw new AppError("invalid_input", "That permission always follows the person's role and can't be changed individually.");
  if (input.userId === actor.userId) throw new AppError("forbidden", "You can't change your own access. Ask another owner or manager.");
  if (input.effect === "grant" && !actor.can(input.permission)) throw new AppError("forbidden", "You can only grant a permission you have yourself.");
  await crmWrite(actor, async (db) => {
    const target = await db.query<{ role: OrgRole }>("select role from organization_memberships where org_id = $1 and user_id = $2 and status = 'active'", [actor.orgId, input.userId]);
    const role = target.rows[0]?.role;
    if (!role) throw new AppError("not_found", "That person isn't an active member of this workspace.");
    if (role === "owner") throw new AppError("forbidden", "The business owner always has full access.");
    if (role === "admin" && actor.kind === "member") {
      const mine = await db.query<{ role: OrgRole }>("select role from organization_memberships where org_id = $1 and user_id = $2", [actor.orgId, actor.userId]);
      if (mine.rows[0]?.role !== "owner") throw new AppError("forbidden", "Only the owner can change a manager's access.");
    }
    const before = await db.query<{ effect: string }>("select effect from member_permission_overrides where org_id = $1 and user_id = $2 and permission = $3", [actor.orgId, input.userId, input.permission]);
    if (input.effect === null) {
      await db.query("delete from member_permission_overrides where org_id = $1 and user_id = $2 and permission = $3", [actor.orgId, input.userId, input.permission]);
    } else {
      await db.query(
        `insert into member_permission_overrides (org_id, user_id, permission, effect, reason, granted_by) values ($1, $2, $3, $4, $5, $6)
         on conflict (org_id, user_id, permission) do update set effect = excluded.effect, reason = excluded.reason, granted_by = excluded.granted_by, created_at = now()`,
        [actor.orgId, input.userId, input.permission, input.effect, (input.reason ?? "").trim().slice(0, 300), actor.userId],
      );
    }
    await recordAudit({
      orgId: actor.orgId, ...auditActor(actor), action: "crm.permission_override_changed", targetType: "user", targetId: input.userId, result: "success",
      metadata: { permission: input.permission, from: before.rows[0]?.effect ?? "role", to: input.effect ?? "role" },
    }, db);
  });
}
