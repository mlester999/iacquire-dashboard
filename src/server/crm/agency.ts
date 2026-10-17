import "server-only";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import type { SessionUser } from "@/server/auth/service";
import type { CrmMode } from "@/lib/crm/types";

export interface AgencyCrmRow {
  orgId: string;
  name: string;
  status: string;
  mode: CrmMode;
  contacts: number;
  newContacts7d: number;
  openDeals: number;
  overdueTasks: number;
  lastActivityAt: string | null;
  mySession: { mode: "read" | "write"; expiresAt: string } | null;
}

/**
 * The agency's view across client CRMs: counts only, never names, emails or message content. Opening a client's records still needs a
 * support session for that client. Super admins see every client; staff see the clients they are assigned to.
 */
export async function agencyCrmPortfolio(user: Pick<SessionUser, "id" | "platformRole">): Promise<AgencyCrmRow[]> {
  if (user.platformRole === "none") return [];
  return withSystem(async (db) => {
    const access = await db.query<{ allowed: boolean }>(
      `select coalesce(app.user_has_agency_permission($1,'agency.crm.read'),false) as allowed`,
      [user.id],
    );
    if (access.rows[0]?.allowed !== true) throw new AppError("forbidden", "Your agency role does not allow viewing client CRM summaries.");

    const { rows } = await db.query<{
      id: string; name: string; status: string; mode: CrmMode | null; contacts: string; new_contacts: string; open_deals: string; overdue: string; last_activity: Date | null;
      session_mode: "read" | "write" | null; session_expires: Date | null;
    }>(
      `select o.id, o.name, o.status, w.mode,
              (select count(*) from contacts c where c.org_id = o.id and c.deleted_at is null and c.archived_at is null)::text as contacts,
              (select count(*) from contacts c where c.org_id = o.id and c.deleted_at is null and c.created_at > now() - interval '7 days')::text as new_contacts,
              (select count(*) from crm_opportunities op where op.org_id = o.id and op.provider = 'native' and op.status = 'open' and op.archived_at is null)::text as open_deals,
              (select count(*) from tasks t where t.org_id = o.id and t.status in ('open', 'in_progress') and t.due_at < now() and t.category in ('crm', 'appointment', 'follow_up', 'sales', 'general'))::text as overdue,
              (select max(a.occurred_at) from crm_activities a where a.org_id = o.id) as last_activity,
              s.mode as session_mode, s.expires_at as session_expires
       from organizations o
       left join crm_workspaces w on w.org_id = o.id
       left join lateral (select mode, expires_at from crm_support_sessions ss where ss.org_id = o.id and ss.user_id = $1 and ss.ended_at is null and ss.expires_at > now() order by ss.started_at desc limit 1) s on true
       where o.kind = 'client' and o.status <> 'archived'
         and app.user_can_access_org($1,o.id)
       order by lower(o.name)`,
      [user.id],
    );
    return rows.map((r) => ({
      orgId: r.id, name: r.name, status: r.status, mode: r.mode ?? "native", contacts: Number(r.contacts), newContacts7d: Number(r.new_contacts), openDeals: Number(r.open_deals),
      overdueTasks: Number(r.overdue), lastActivityAt: r.last_activity ? new Date(r.last_activity).toISOString() : null,
      mySession: r.session_mode && r.session_expires ? { mode: r.session_mode, expiresAt: new Date(r.session_expires).toISOString() } : null,
    }));
  });
}
