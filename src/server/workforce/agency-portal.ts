import "server-only";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import type { SessionUser } from "@/server/auth/service";
import { switchActiveOrg } from "@/server/tenancy/context";
import { ensureAgencyWorkforceRegistry } from "@/server/workforce/agency-registry";

/**
 * Gives the signed-in Super Admin owner access to the internal agency workspace so the normal chat
 * backend can be used. The agency registry owns the six employee identities; this function only adds
 * the membership needed for workspace context and then switches to that workspace.
 */
export async function ensureAgencyPortalAccess(user: SessionUser): Promise<{ id: string; name: string; slug: string }> {
  if (user.platformRole !== "agency_super_admin") {
    throw new AppError("forbidden", "Only a Super Admin can open the internal workforce chat.");
  }
  const agencyId = await ensureAgencyWorkforceRegistry(user);
  const agency = await withSystem(async (db) => {
    await db.query(
      `insert into organization_memberships (org_id, user_id, role, status)
       values ($1, $2, 'owner', 'active')
       on conflict (org_id, user_id) do update set role = 'owner', status = 'active'`,
      [agencyId, user.id],
    );
    const { rows } = await db.query<{ id: string; name: string; slug: string }>(
      "select id, name, slug from organizations where id = $1 and kind = 'agency'",
      [agencyId],
    );
    return rows[0];
  });
  if (!agency) throw new AppError("not_found", "The internal agency workspace could not be opened.");
  await switchActiveOrg(agency.id);
  return agency;
}
