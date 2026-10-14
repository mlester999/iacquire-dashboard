import "server-only";
import { withUser } from "@/server/db";
import { AppError } from "@/server/errors";

/** Read each revision under current database permissions, including during an open stream. */
export async function authorizedSetupRevision(userId: string, orgId: string, agency: boolean): Promise<number | null> {
  return withUser(userId, async (db) => {
    const { rows: access } = await db.query<{ allowed: boolean }>(
      "select app.has_permission($1, 'setup.view') and (not $2::boolean or app.staff_assigned($1)) as allowed",
      [orgId, agency],
    );
    if (!access[0]?.allowed) throw new AppError("forbidden", "Your access to this setup has changed. Refresh or sign in again.");
    const { rows } = await db.query<{ revision: number }>("select revision::int as revision from client_setup_instances where org_id = $1", [orgId]);
    return rows[0]?.revision ?? null;
  });
}
