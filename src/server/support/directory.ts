import "server-only";
import { withSystem } from "@/server/db";
import type { SessionUser } from "@/server/auth/service";
import { assertAgencySupportPermission } from "@/server/support/access";

export interface FilterOptions {
  clients: Array<{ id: string; name: string }>;
  staff: Array<{ id: string; name: string }>;
}

/** The clients the person can reach and the team members who work support, for the queue's filters. */
export async function listAgencyFilterOptions(user: SessionUser): Promise<FilterOptions> {
  await assertAgencySupportPermission(user, null, "agency.support.view");
  const clients = await withSystem(async (db) =>
    (await db.query<{ id: string; name: string }>(
      `select o.id, o.name from organizations o where o.kind = 'client' and o.status not in ('archived') and app.user_can_access_org($1, o.id) order by o.name limit 300`,
      [user.id],
    )).rows,
  );
  const staff = await withSystem(async (db) =>
    (await db.query<{ id: string; name: string }>(
      `select u.id, coalesce(nullif(u.full_name, ''), u.email::text) as name from users u
       where u.status = 'active' and u.platform_role in ('agency_staff', 'agency_manager', 'agency_super_admin')
         and coalesce(app.user_has_agency_permission(u.id, 'agency.support.view'), false) order by name limit 200`,
    )).rows,
  );
  return { clients, staff };
}
