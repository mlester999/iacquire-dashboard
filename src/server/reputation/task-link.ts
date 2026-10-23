import "server-only";
import type { Queryable } from "@/server/db";
import { recordAudit } from "@/server/audit";

/**
 * Finishing the follow-up task of low private feedback resolves that feedback: the team did what the task asked, so the "needs follow-up" badge and the open list
 * stop showing it. Called inside the task's own transaction. A feedback row that was already resolved, or that no task points at, is left alone. A task that was
 * only cancelled resolves nothing (cancelling is not following up).
 *
 * Kept apart from feedback.ts so tasks.ts can use it without importing the service that creates tasks.
 */
export async function resolveFeedbackForTask(db: Queryable, orgId: string, taskId: string, userId: string | null): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `update customer_feedback set follow_up_status = 'resolved', resolved_at = now(), resolved_by = $3,
       acknowledged_at = coalesce(acknowledged_at, now()), acknowledged_by = coalesce(acknowledged_by, $3)
     where org_id = $1 and escalated_task_id = $2 and follow_up_status in ('new', 'acknowledged', 'escalated') returning id`,
    [orgId, taskId, userId],
  );
  for (const r of rows) {
    await recordAudit({ orgId, actorUserId: userId, actorKind: userId ? "user" : "system", action: "crm.feedback_follow_up", targetType: "customer_feedback", targetId: r.id, result: "success", metadata: { to: "resolved", via: "task_completed", taskId } }, db);
  }
  return rows.length;
}
