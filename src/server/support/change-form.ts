import "server-only";
import { withUser } from "@/server/db";
import type { OrgContext } from "@/server/tenancy/context";
import { CHANGE_REQUEST_PROJECT_STATUSES, type AllowanceFacts } from "@/lib/support/change";
import { CHANGEABLE_PROJECT_STATUSES } from "@/lib/project-change-orders";
import { requestChangesEnabled } from "@/server/support/change-feature";
import { getMaintenanceAllowance } from "@/server/maintenance/service";

// What the Request a Change page needs before it can show its form.

export interface ChangeFormProject { id: string; ref: string; title: string; status: string; /** Can also be filed as a change to what was agreed. */ canFileAsChange: boolean }

export interface ChangeFormContext {
  enabled: boolean;
  projects: ChangeFormProject[];
  /** Only when the workspace has an active maintenance plan; the number is the plan's own. */
  allowance: AllowanceFacts | null;
  /** The person may file a change to what was agreed on a project (an owner or admin). */
  canFileAsChange: boolean;
}

export async function loadChangeFormContext(ctx: OrgContext): Promise<ChangeFormContext> {
  const enabled = ctx.org.kind === "client" && (await requestChangesEnabled(ctx.org.orgId));
  if (!enabled) return { enabled: false, projects: [], allowance: null, canFileAsChange: false };
  const projects = await withUser(ctx.user.id, async (db) =>
    (await db.query<{ id: string; ref: string; title: string; status: string; agreed: boolean }>(
      `select r.id, r.ref, r.title, r.status, exists (select 1 from client_projects cp where cp.request_id = r.id) as agreed
       from client_project_requests r where r.org_id = $1 and r.status = any($2::text[]) order by r.last_activity_at desc limit 100`,
      [ctx.org.orgId, [...CHANGE_REQUEST_PROJECT_STATUSES]],
    )).rows,
  );
  const canFileAsChange = ctx.can("projects.request");
  return {
    enabled: true,
    projects: projects.map((p) => ({ id: p.id, ref: p.ref, title: p.title, status: p.status, canFileAsChange: canFileAsChange && p.agreed && (CHANGEABLE_PROJECT_STATUSES as readonly string[]).includes(p.status) })),
    allowance: await getMaintenanceAllowance(ctx),
    canFileAsChange,
  };
}
