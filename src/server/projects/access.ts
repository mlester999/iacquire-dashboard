import "server-only";
import { z } from "zod";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import type { SessionUser } from "@/server/auth/service";
import type { ProjectStatus } from "@/lib/projects";
import { todayIn } from "@/lib/invoices/state";
import { loadSupportSettings } from "@/server/support/settings";

// What every agency action on a custom project asks first, shared by the project, change-order and prerequisite services.

export function isStaff(user: Pick<SessionUser, "platformRole">) {
  return user.platformRole === "agency_staff" || user.platformRole === "agency_manager" || user.platformRole === "agency_super_admin";
}

export interface LockedProject {
  id: string;
  org_id: string;
  ref: string;
  title: string;
  status: ProjectStatus;
  status_before_hold: ProjectStatus | null;
  created_by: string | null;
}

export async function agencyAccessInTx(db: Queryable, user: Pick<SessionUser, "id">, orgId: string): Promise<boolean> {
  const { rows } = await db.query<{ allowed: boolean }>("select app.user_can_access_org($1,$2) as allowed", [user.id, orgId]);
  return rows[0]?.allowed === true;
}

/** The request's tenant must be one this agency user may work on (super admins: all; staff: assigned only). The request row is locked for the rest of the transaction. */
export async function authorizeRequest(db: Queryable, user: SessionUser, requestId: string, permission: "projects.manage" | "quotes.manage" = "projects.manage"): Promise<LockedProject> {
  if (!isStaff(user)) throw new AppError("forbidden", "Agency access is required.");
  const permissionCheck = await db.query<{ can_view: boolean; can_act: boolean }>(
    `select coalesce(app.user_has_agency_permission($1,'projects.view'),false) as can_view,
            coalesce(app.user_has_agency_permission($1,$2),false) as can_act`,
    [user.id, permission],
  );
  if (permissionCheck.rows[0]?.can_view !== true) throw new AppError("forbidden", "Your role does not allow viewing client projects.");
  if (permissionCheck.rows[0]?.can_act !== true) throw new AppError("forbidden", "Your role does not allow this project action.");
  if (!z.string().uuid().safeParse(requestId).success) throw new AppError("not_found", "Project not found.");
  const r = (await db.query<LockedProject>(
    "select id, org_id, ref, title, status, status_before_hold, created_by from client_project_requests where id = $1 for update", [requestId],
  )).rows[0];
  // Same answer for "missing" and "not yours" so ids cannot be probed.
  if (!r || !(await agencyAccessInTx(db, user, r.org_id))) throw new AppError("not_found", "Project not found.");
  return r;
}

export const CLIENT_ROLES: Array<"owner" | "admin"> = ["owner", "admin"];

export async function closeTasks(db: Queryable, requestId: string, kinds: string[], userId: string) {
  await db.query("update project_review_tasks set status = 'done', completed_at = now(), completed_by = $3 where request_id = $1 and status = 'open' and kind = any($2::text[])", [requestId, kinds, userId]);
}

/** Writes a line on the project's progress feed and returns its id, which names the event for the notice that goes with it (so a replayed event is announced once). */
export async function addUpdate(db: Queryable, r: { id: string; org_id: string }, userId: string | null, kind: string, body: string, visibility: "client" | "internal" = "client"): Promise<string> {
  const { rows } = await db.query<{ id: string }>("insert into project_updates (request_id, org_id, author_id, kind, body, visibility) values ($1,$2,$3,$4,$5,$6) returning id", [r.id, r.org_id, userId, kind, body.slice(0, 4000), visibility]);
  await db.query("update client_project_requests set last_activity_at = now() where id = $1", [r.id]);
  return rows[0].id;
}

/** Hours a new project request, or a change request, waits for its first look unless a Super Admin set a review target. */
export const DEFAULT_FIRST_LOOK_HOURS = 48;

/** When the team's first look at something new is due, in hours from now: the Super Admin's review target if there is one, otherwise two days. */
export async function firstLookHours(db: Queryable): Promise<number> {
  return (await loadSupportSettings(db)).projectReviewTargetHours ?? DEFAULT_FIRST_LOOK_HOURS;
}

/** Marks the team's "review this change" task done. `userId` is the team member who looked, or null when nobody on the team did (the client took the request back). */
export async function finishChangeReviewTask(db: Queryable, changeId: string, userId: string | null): Promise<void> {
  await db.query("update project_review_tasks set status = 'done', completed_at = now(), completed_by = $2 where change_order_id = $1 and status = 'open'", [changeId, userId]);
}

/** Today's date in the workspace's own calendar. A date a person sees, or a deadline, never comes from the server's UTC day. */
export async function orgToday(db: Queryable, orgId: string, now: Date = new Date()): Promise<string> {
  const tz = (await db.query<{ timezone: string }>("select timezone from organizations where id = $1", [orgId])).rows[0]?.timezone ?? "UTC";
  return todayIn(now, tz);
}
