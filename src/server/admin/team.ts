import "server-only";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import type { SessionUser } from "@/server/auth/service";

export interface AgencyTeamView {
  members: Array<{ id: string; name: string; email: string; role: "agency_super_admin" | "agency_staff"; status: string; lastLoginAt: string | null; clients: Array<{ id: string; name: string }>; openTasks: number; openTickets: number }>;
  invitations: Array<{ id: string; email: string; role: string; expiresAt: string }>;
  clients: Array<{ id: string; name: string; assignedStaff: number }>;
  coverage: { total: number; assigned: number };
}

/** Read-only aggregates from existing staff assignments. Reporting lines are not inferred. */
export async function agencyTeamView(admin: SessionUser): Promise<AgencyTeamView> {
  return withSystem(async (db) => {
    const access = await db.query("select 1 from users where id=$1 and status='active' and platform_role='agency_super_admin'", [admin.id]);
    if (!access.rows.length) throw new AppError("forbidden", "Only agency super admins can inspect the agency team.");
    const members = await db.query<{ id: string; full_name: string; email: string; platform_role: "agency_super_admin" | "agency_staff"; status: string; last_login_at: Date | null; open_tasks: number; open_tickets: number }>(
      `select u.id,u.full_name,u.email,u.platform_role,u.status,u.last_login_at,
       (select count(*)::int from client_setup_tasks t where t.assigned_to=u.id and t.status<>'completed' and not t.hidden and not t.service_excluded) as open_tasks,
       (select count(*)::int from support_tickets t where t.assigned_to=u.id and t.status in ('open','in_progress','waiting_for_client')) as open_tickets
       from users u where u.platform_role in ('agency_super_admin','agency_staff') order by u.platform_role desc,u.full_name,u.email`,
    );
    const clients = await db.query<{ id: string; name: string; assigned_staff: number }>(
      `select o.id,o.name,(select count(*)::int from staff_assignments s join users u on u.id=s.user_id and u.status='active' and u.platform_role='agency_staff' where s.org_id=o.id) as assigned_staff
       from organizations o where o.kind='client' and o.status<>'archived' order by o.name`,
    );
    const assignments = await db.query<{ user_id: string; org_id: string; name: string }>("select s.user_id,s.org_id,o.name from staff_assignments s join organizations o on o.id=s.org_id where o.kind='client' and o.status<>'archived' order by o.name");
    const invitations = await db.query<{ id: string; email: string; platform_role: string; expires_at: Date }>("select id,email,platform_role,expires_at from invitations where org_id is null and accepted_at is null and revoked_at is null and expires_at>now() order by created_at desc");
    return {
      members: members.rows.map((m) => ({ id:m.id,name:m.full_name||m.email,email:m.email,role:m.platform_role,status:m.status,lastLoginAt:m.last_login_at?new Date(m.last_login_at).toISOString():null,clients:assignments.rows.filter((a)=>a.user_id===m.id).map((a)=>({id:a.org_id,name:a.name})),openTasks:m.open_tasks,openTickets:m.open_tickets })),
      invitations: invitations.rows.map((i)=>({id:i.id,email:i.email,role:i.platform_role,expiresAt:new Date(i.expires_at).toISOString()})),
      clients: clients.rows.map((c)=>({id:c.id,name:c.name,assignedStaff:c.assigned_staff})),
      coverage: { total:clients.rows.length,assigned:clients.rows.filter((c)=>c.assigned_staff>0).length },
    };
  });
}
