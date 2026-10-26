import "server-only";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import type { SessionUser } from "@/server/auth/service";

// Who may look at prospects and who may run the funnel. Prospects belong to no workspace, so there is no row-level policy to lean on: every function in this module that reads
// or changes one starts here, and the answer is re-read from the database for this request (active account, still an agency role, holding the permission now). Nothing the
// browser sent is trusted.
//
//   agency.prospects.view     agency managers and Super Admins: the list, a prospect's details and timeline, and (each read recorded) their conversation.
//   agency.prospects.manage   Super Admins only: the settings, extending, expiring, blocking, assigning, notes, erasing and converting.
// Neither can be handed to one person (they are not delegable); an agency staff member holds neither.

export type ProspectsPermission = "agency.prospects.view" | "agency.prospects.manage";

export async function assertProspectsAccess(user: Pick<SessionUser, "id" | "platformRole">, permission: ProspectsPermission): Promise<void> {
  const { rows } = await withSystem((db) =>
    db.query<{ active: boolean; platform_role: string; allowed: boolean }>(
      `select u.status = 'active' as active, u.platform_role, coalesce(app.user_has_agency_permission(u.id, $2), false) as allowed
         from users u where u.id = $1`,
      [user.id, permission],
    ),
  );
  const current = rows[0];
  if (!current?.active || current.platform_role === "none" || current.platform_role !== user.platformRole) {
    throw new AppError("forbidden", "Agency access is required; authorization has changed.");
  }
  if (!current.allowed) {
    throw new AppError("forbidden", permission === "agency.prospects.manage" ? "Only a Super Admin can change the demo funnel." : "Your agency role does not include demo prospects.");
  }
}

/** Both permissions in one round trip, for choosing which controls the Prospects screens show. */
export async function prospectsCapabilities(user: Pick<SessionUser, "id">): Promise<{ view: boolean; manage: boolean }> {
  const { rows } = await withSystem((db) =>
    db.query<{ view: boolean; manage: boolean }>(
      `select coalesce(app.user_has_agency_permission($1, 'agency.prospects.view'), false) as view,
              coalesce(app.user_has_agency_permission($1, 'agency.prospects.manage'), false) as manage`,
      [user.id],
    ),
  );
  return { view: rows[0]?.view === true, manage: rows[0]?.manage === true };
}
