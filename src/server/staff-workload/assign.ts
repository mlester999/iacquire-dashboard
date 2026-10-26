import "server-only";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import type { SessionUser } from "@/server/auth/service";
import { assignRequest } from "@/server/support/agency";
import { assignProject } from "@/server/projects/agency";
import { updateTaskDetails } from "@/server/setup/agency";
import { assignMaintenanceRequest } from "@/server/maintenance/service";
import { SOURCE_LABELS, type WorkSource } from "@/lib/staff-workload/sources";
import { isId, requireWorkloadCap, throttle } from "@/server/staff-workload/access";
import { loadWorkItem, SUPPORT_OPEN_STATUSES } from "@/server/staff-workload/projection";
import { isEligibleAssignee, parseItemRef } from "@/server/staff-workload/suggestions";

// Giving work to someone from the workload board or from a suggestion. The board never writes an assignee itself: it asks the module that owns the item (Support, Custom
// projects, Setup, Maintenance) through that module's own assign function, so the module's permission rules, history, notice to the new owner and audit all happen exactly as
// they do when the module's own screen is used. What this file adds is the checks that are the same for every module (the one eligibility rule, the client scope, a stale
// board refused) and one row in work_assignment_events for what the board did.

export type AssignVia = "board" | "suggestion";

export interface AssignInput {
  source: unknown;
  itemId: unknown;
  /** The person to give it to, or null to take it from whoever has it. */
  assigneeId: string | null;
  via?: AssignVia;
  /** Who the board showed as holding it (null for nobody). If the item is held by someone else now, nothing is changed and the person is told to reload. Omit to skip the check. */
  expectedAssigneeId?: string | null;
}

export interface AssignResult {
  changed: boolean;
  from: string | null;
  to: string | null;
}

const NOT_FOUND = "That item was not found.";

async function callModule(user: SessionUser, source: WorkSource, orgId: string, itemId: string, assigneeId: string | null): Promise<void> {
  switch (source) {
    case "support":
      return assignRequest(user, itemId, assigneeId);
    case "project":
      return assignProject(user, itemId, assigneeId);
    case "setup_task":
      await updateTaskDetails(user, orgId, itemId, { assignedTo: assigneeId });
      return;
    case "maintenance":
      return assignMaintenanceRequest(user, itemId, assigneeId);
  }
}

/**
 * Gives an item to someone (or takes it away). Needs the workload assign permission AND whatever the item's module asks (support: assign unless taking it for yourself;
 * projects and setup and maintenance: their manage permission), which the module checks itself. Idempotent: giving it to the person who has it changes nothing and writes
 * nothing. The item must belong to a client the person can open; any other reads as not found.
 */
export async function assignWorkItem(user: SessionUser, input: AssignInput): Promise<AssignResult> {
  const actor = await requireWorkloadCap(user, "assign");
  const ref = parseItemRef(input.source, input.itemId);
  if (input.assigneeId !== null && !isId(input.assigneeId)) throw new AppError("invalid_input", "Choose a team member.");
  const via: AssignVia = input.via === "suggestion" ? "suggestion" : "board";
  await throttle("staffWorkloadAssignByUser", user.id);

  const before = await withSystem(async (db) => {
    const item = await loadWorkItem(db, ref.source, ref.itemId);
    if (!item && ref.source === "maintenance") {
      // A maintenance request is counted through its support request while that is open (see MIRRORED_TICKET_OPEN): say so, to a person who can open the client.
      const mirrored = (await db.query<{ ok: boolean }>(
        `select exists (select 1 from maintenance_requests m join support_tickets t on t.id = m.ticket_id
                         where m.id = $1::uuid and t.status in ('${SUPPORT_OPEN_STATUSES.join("', '")}') and app.user_can_access_org($2::uuid, m.org_id)) as ok`, [ref.itemId, actor.userId],
      )).rows[0]?.ok === true;
      if (mirrored) throw new AppError("conflict", "This maintenance request is handled through its support request while that is open. Give the support request to someone instead.");
    }
    const reach = item && (await db.query<{ ok: boolean }>("select app.user_can_access_org($1::uuid, $2::uuid) as ok", [actor.userId, item.orgId])).rows[0]?.ok === true;
    if (!item || !reach) throw new AppError("not_found", NOT_FOUND);
    if (input.expectedAssigneeId !== undefined && input.expectedAssigneeId !== item.assigneeId) {
      throw new AppError("conflict", "Someone else changed who has this item while you were looking. Reload the board to see the current state.");
    }
    if (input.assigneeId !== null && !(await isEligibleAssignee(db, ref.source, item.orgId, input.assigneeId))) {
      throw new AppError("invalid_input", `That person cannot take a ${SOURCE_LABELS[ref.source].toLowerCase()} for this client: they must be on the agency team, able to open the client and allowed to work this kind of request.`);
    }
    return item;
  });
  if (before.assigneeId === input.assigneeId) return { changed: false, from: before.assigneeId, to: input.assigneeId };

  // The module owns the change: its own permission check, history, notice and audit.
  await callModule(user, ref.source, before.orgId, before.itemId, input.assigneeId);

  return withSystem(async (db) => {
    const after = await loadWorkItem(db, ref.source, ref.itemId);
    if (!after || after.assigneeId !== input.assigneeId) {
      throw new AppError("conflict", "Someone else changed who has this item at the same moment. Reload the board to see the current state.");
    }
    // One lock per item, so two identical requests at the same moment leave one row: the second waits, then finds the first's row inside the window and writes none.
    await db.query("select pg_advisory_xact_lock(hashtext($1))", [`work_assignment:${ref.itemId}`]);
    const written = await db.query(
      `insert into work_assignment_events (org_id, source, item_id, client_ref, from_user, to_user, actor_id, via)
       select $1, $2, $3, $4, $5, $6, $7, $8
        where not exists (select 1 from work_assignment_events e where e.item_id = $3 and e.from_user is not distinct from $5::uuid and e.to_user is not distinct from $6::uuid
                            and e.created_at > now() - interval '30 seconds')`,
      [actor.agencyOrgId, ref.source, ref.itemId, before.orgId, before.assigneeId, input.assigneeId, actor.userId, via],
    );
    if (written.rowCount) {
      // The audit row belongs to the agency workspace, not the client's: the client's own audit already has the module's line. Ids and the kind of work only, no title.
      await recordAudit({
        orgId: actor.agencyOrgId, actorUserId: actor.userId, actorKind: "agency", action: "staff_workload.assigned", targetType: "work_item", targetId: ref.itemId, result: "success",
        metadata: { source: ref.source, from: before.assigneeId, to: input.assigneeId, via },
      }, db);
    }
    // False when an identical request a moment earlier already did and recorded it.
    return { changed: Boolean(written.rowCount), from: before.assigneeId, to: input.assigneeId };
  });
}
