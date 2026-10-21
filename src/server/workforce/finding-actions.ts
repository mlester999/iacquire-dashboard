import "server-only";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { systemActor } from "@/server/crm/actor";
import { createTaskInTx } from "@/server/crm/tasks";
import { getWorkJobView, type WorkJobView } from "@/server/workforce/jobs";
import type { OrgContext } from "@/server/tenancy/context";

/**
 * Turns one persisted review finding into an ordinary internal follow-up task.
 *
 * This is an explicit human action: the person clicks the action on a completed review, must hold
 * tasks.manage, and the task is assigned to them. The task service performs its normal validation,
 * emits task.created and records activity. It never sends outreach or changes a customer record.
 * Repeating the same action returns the existing task instead of creating a duplicate.
 */
export async function createFindingTask(ctx: OrgContext, input: { jobId: string; findingKey: string }): Promise<{ taskId: string; created: boolean }> {
  if (!ctx.can("tasks.manage")) throw new AppError("forbidden", "Your role can't create follow-up tasks.");
  const job: WorkJobView | null = await getWorkJobView(ctx, input.jobId);
  if (!job) throw new AppError("not_found", "Work job not found.");
  if (job.status !== "completed") throw new AppError("conflict", "Only a completed review can create a follow-up task.");
  const findings = Array.isArray(job.result.findings) ? (job.result.findings as Array<{ key?: string; title?: string; detail?: string; evidenceHref?: string; recommendedAction?: string }>) : [];
  const finding = findings.find((item) => item.key === input.findingKey);
  if (!finding || !finding.title) throw new AppError("not_found", "That finding is no longer part of this review.");
  const relatedId = `${job.id}:${input.findingKey}`;

  return withSystem(async (db) => {
    const existing = await db.query<{ id: string }>(
      "select id from tasks where org_id = $1 and related_type = 'ai_work_finding' and related_id = $2 limit 1",
      [ctx.org.orgId, relatedId],
    );
    if (existing.rows[0]) return { taskId: existing.rows[0].id, created: false };

    const description = [
      finding.detail ?? null,
      finding.recommendedAction ? `Recommended action: ${finding.recommendedAction}` : null,
      finding.evidenceHref ? `Evidence: ${finding.evidenceHref}` : null,
      `From AI Work Board job ${job.id}.`,
    ].filter(Boolean).join("\n\n").slice(0, 2000);

    const task = await createTaskInTx(
      db,
      systemActor({ id: ctx.org.orgId }),
      {
        title: `Follow up: ${finding.title}`.slice(0, 200),
        description,
        priority: "normal",
        assigneeId: ctx.user.id,
      },
      { source: "agent" },
    );
    await db.query("update tasks set related_type = 'ai_work_finding', related_id = $2 where id = $1 and org_id = $3", [task.id, relatedId, ctx.org.orgId]);
    await recordAudit({
      orgId: ctx.org.orgId,
      actorUserId: ctx.user.id,
      actorKind: "user",
      action: "workforce.finding_task_created",
      targetType: "task",
      targetId: task.id,
      result: "success",
      metadata: { jobId: job.id, findingKey: input.findingKey, capability: job.capability },
    }, db);
    return { taskId: task.id, created: true };
  });
}
