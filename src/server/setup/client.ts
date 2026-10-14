import "server-only";
import { z } from "zod";
import { withUser } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyAgency } from "@/server/notifications";
import type { OrgContext } from "@/server/tenancy/context";
import { loadRuleTasks, lockClientSetupResponse, mutateSetup, recordSetupEvent, TASK_COLUMNS, type TaskRow } from "@/server/setup/core";
import { isApplicable, unmetDependencies } from "@/lib/setup";

export const responseSchema = z.object({
  decision: z.enum(["approve", "request_changes", "confirm"]).optional(),
  message: z.string().trim().max(2000).optional().default(""),
});

const DECISION_LABEL: Record<string, string> = { approve: "approved", request_changes: "asked for changes", confirm: "confirmed it is done" };

/**
 * What a client may do: answer the one request the agency opened on a step. Doing so never
 * completes anything: an approval or confirmation moves the step to "Ready for review" so the
 * agency checks it, and a request for changes sends it back to "In progress".
 *
 * The step must belong to the caller's own workspace (checked under row-level security), still be
 * waiting for the client, and carry an agency-authored request, so a client cannot invent a
 * response for any other step or change any agency-controlled state.
 */
export async function submitClientResponse(ctx: OrgContext, taskId: string, input: z.input<typeof responseSchema>) {
  if (!ctx.can("setup.respond")) throw new AppError("forbidden", "Only workspace owners and admins can respond to setup requests.");
  const data = responseSchema.parse(input);
  const visible = await withUser(ctx.user.id, (db) => db.query("select 1 from client_setup_tasks where id = $1 and org_id = $2", [taskId, ctx.org.orgId]));
  if (!visible.rows.length) throw new AppError("not_found", "That setup step wasn't found.");

  return mutateSetup(ctx.org.orgId, async (db, inst) => {
    await lockClientSetupResponse(db,ctx.user.id,ctx.org.orgId);
    const { rows } = await db.query<TaskRow>(`select ${TASK_COLUMNS} from client_setup_tasks t where t.id = $1 and t.org_id = $2`, [taskId, ctx.org.orgId]);
    const task = rows[0];
    if (!task || !isApplicable({ hidden: task.hidden, serviceExcluded: task.service_excluded })) throw new AppError("not_found", "That setup step wasn't found.");
    const action = task.client_action;
    if (!action) throw new AppError("forbidden", "There is nothing for you to respond to on this step.");
    if (task.status !== "waiting_for_client") throw new AppError("conflict", "This request is no longer open. Refresh to see its latest status.");

    const tasks = await loadRuleTasks(db, ctx.org.orgId);
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const me = byId.get(taskId);
    const unmet = me ? unmetDependencies(me, byId) : [];
    if (unmet.length) throw new AppError("conflict", "We need to finish an earlier step before this one.");

    let decision: string | null = null;
    if (action.type === "provide_info") {
      if (data.message.length < 2) throw new AppError("invalid_input", "Write your answer first.");
    } else if (action.type === "approve") {
      if (data.decision !== "approve") throw new AppError("invalid_input", "Choose Approve to continue.");
      decision = "approve";
    } else if (action.type === "review_and_approve") {
      if (data.decision !== "approve" && data.decision !== "request_changes") throw new AppError("invalid_input", "Approve the design or ask for changes.");
      if (data.decision === "request_changes" && data.message.length < 3) throw new AppError("invalid_input", "Tell us what you would like changed.");
      decision = data.decision;
    } else {
      if (data.decision !== "confirm") throw new AppError("invalid_input", "Confirm once you have done this.");
      decision = "confirm";
    }

    const positive = decision !== "request_changes";
    const to = positive ? "ready_for_review" : "in_progress";
    const response = { type: action.type, decision, message: data.message || null, at: new Date().toISOString() };
    const res = await db.query(
      `update client_setup_tasks set status = $3, client_response = $4,
         client_responded_at = case when $5::boolean then now() end, client_responded_by = $6, updated_by = $6
       where id = $1 and org_id = $2 and status = 'waiting_for_client' returning id`,
      [taskId, ctx.org.orgId, to, JSON.stringify(response), positive, ctx.user.id],
    );
    if (!res.rows[0]) throw new AppError("conflict", "This request was just answered. Refresh to see its latest status.");

    await recordSetupEvent(db, {
      orgId: ctx.org.orgId,
      instanceId: inst.id,
      taskId,
      actorUserId: ctx.user.id,
      actorKind: "client",
      event: "client_responded",
      fromStatus: "waiting_for_client",
      toStatus: to,
      body: data.message || (decision ? `You ${DECISION_LABEL[decision]}.` : "You sent your answer."),
      visibility: "client",
      metadata: { type: action.type, decision },
    });
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "setup.client_responded", targetType: "setup_task", targetId: taskId, result: "success", metadata: { type: action.type, decision } }, db);
    await notifyAgency(db, ctx.org.orgId, {
      kind: "system",
      severity: positive ? "info" : "warning",
      title: `${ctx.org.name}: ${action.label} — ${decision ? DECISION_LABEL[decision] : "answered"}`,
      body: data.message.slice(0, 300) || undefined,
      link: `/admin/clients/${ctx.org.orgId}/setup`,
    });
    return { status: to };
  });
}
