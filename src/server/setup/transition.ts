import "server-only";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { clientTitle, loadRuleTasks, recordSetupEvent, type InstanceRow, type TaskRow, type TxHelpers } from "@/server/setup/core";
import { isApplicable, STATUS_LABEL, unmetDependencies, type TaskStatus } from "@/lib/setup";

export type CompletionSource = "agency" | "connector" | "attestation" | "activation";

/** Which completion sources are legitimate for each kind of task. The database enforces the same table. */
const SOURCE_FOR_MODE: Record<TaskRow["completion_mode"], CompletionSource[]> = {
  manual: ["agency"],
  verified: ["connector"],
  activation: ["activation"],
};

export interface Transition {
  task: TaskRow;
  to: TaskStatus;
  actor: { userId: string | null; kind: "agency" | "client" | "system" };
  /** Text the client will read about this change. */
  clientText?: string | null;
  /** Staff-only explanation (required when reopening). */
  internalReason?: string | null;
  source?: CompletionSource;
  verifiedDetail?: string | null;
  notify?: boolean;
}

/**
 * The single place a task changes status. Whatever the caller (agency edit, verification engine,
 * attestation, activation), the same rules apply: dependencies, required client approval,
 * required evidence, a reason for blocking, and a legitimate completion source for the task type.
 */
export async function applyTransition(db: Queryable, h: TxHelpers, inst: InstanceRow, t: Transition) {
  const { task, to, actor } = t;
  const from = task.status;
  if (from === to) throw new AppError("invalid_input", `This step is already ${STATUS_LABEL[to].toLowerCase()}.`);

  if (to === "waiting_for_client") {
    // A request the client cannot act on yet would only confuse them.
    const tasks = await loadRuleTasks(db, task.org_id);
    const byId = new Map(tasks.map((x) => [x.id, x]));
    const me = byId.get(task.id);
    const unmet = me ? unmetDependencies(me, byId) : [];
    if (unmet.length) throw new AppError("invalid_input", `Finish ${unmet.map((u) => `"${u.title}"`).join(", ")} first. The client can't act on this step until then.`);
  }
  if (to === "completed") {
    if (!t.source || !SOURCE_FOR_MODE[task.completion_mode].includes(t.source)) {
      throw new AppError("invalid_input", "This step can't be completed that way. Check its verification requirements.");
    }
    const tasks = await loadRuleTasks(db, task.org_id);
    const byId = new Map(tasks.map((x) => [x.id, x]));
    const me = byId.get(task.id);
    const unmet = me ? unmetDependencies(me, byId) : [];
    if (unmet.length) throw new AppError("invalid_input", `Finish ${unmet.map((u) => `"${u.title}"`).join(", ")} first.`);
    if (task.requires_client_response && !task.client_responded_at) {
      throw new AppError("invalid_input", "The client's approval is required before this can be completed.");
    }
    if (task.requires_evidence) {
      const { rows } = await db.query<{ n: number }>("select count(*)::int as n from client_setup_task_attachments where task_id = $1", [task.id]);
      if (!rows[0].n) throw new AppError("invalid_input", "Attach evidence (a link) before completing this step.");
    }
  }
  if (to === "blocked" && !t.clientText?.trim()) throw new AppError("invalid_input", "Explain why this step is blocked. The client will see the explanation.");

  const reopening = from === "completed" && to !== "completed";
  if (reopening && !t.internalReason?.trim()) throw new AppError("invalid_input", "Add a reason for reopening this step.");

  const evidence = task.check_key && ["pending", "in_progress", "waiting_for_client"].includes(to)
    ? await db.query("select 1 from client_setup_checks where org_id = $1 and check_key = $2 and status = 'attested'", [task.org_id, task.check_key])
    : null;
  const withdrawingEvidence = Boolean(evidence?.rows.length);

  const completing = to === "completed";
  const clearResponse = (reopening || withdrawingEvidence || to === "waiting_for_client") && task.requires_client_response;
  const clearAnyResponse = to === "waiting_for_client";
  const res = await db.query<{ id: string }>(
    `update client_setup_tasks set
       status = $3,
       completed_at = case when $9::boolean then now() end,
       completed_by = case when $9::boolean then $4::uuid end,
       completion_source = case when $9::boolean then $5::text end,
       completion_note = case when $9::boolean then $6::text end,
       verified_at = case when $9::boolean and $5::text in ('connector', 'attestation') then now() end,
       verified_detail = case when $9::boolean and $5::text in ('connector', 'attestation') then $7::text end,
       blocked_reason = case when $3 = 'blocked' then $8::text end,
       client_note = case when $3 in ('waiting_for_client', 'in_progress', 'pending', 'ready_for_review') and $10::text is not null then $10 else client_note end,
       client_response = case when $11::boolean or $12::boolean then null else client_response end,
       client_responded_at = case when $11::boolean or $12::boolean then null else client_responded_at end,
       client_responded_by = case when $11::boolean or $12::boolean then null else client_responded_by end,
       updated_by = $4
     where id = $1 and org_id = $2 and status = $13
     returning id`,
    [
      task.id,
      task.org_id,
      to,
      actor.userId,
      t.source ?? null,
      completing ? (t.clientText?.trim() || null) : null,
      t.verifiedDetail?.slice(0, 600) ?? null,
      to === "blocked" ? t.clientText!.trim().slice(0, 1000) : null,
      completing,
      to === "completed" || to === "blocked" ? null : t.clientText?.trim() || null,
      clearResponse,
      clearAnyResponse,
      from,
    ],
  );
  if (!res.rows[0]) throw new AppError("conflict", "This step was just changed by someone else. Refresh and try again.");

  // Reopening withdraws an attestation: the integration is back to "not verified" until re-proven.
  if ((withdrawingEvidence || (reopening && task.completion_source === "attestation")) && task.check_key) {
    await db.query(
      `update client_setup_checks set status = 'unverified', source = null, attested_by = null, attested_at = null, evidence_url = null, note = null,
         detail = 'The attestation was withdrawn because the step was reopened.' where org_id = $1 and check_key = $2`,
      [task.org_id, task.check_key],
    );
  }

  await recordSetupEvent(db, {
    orgId: task.org_id,
    instanceId: inst.id,
    taskId: task.id,
    actorUserId: actor.userId,
    actorKind: actor.kind,
    event: reopening ? "reopened" : "status_changed",
    fromStatus: from,
    toStatus: to,
    body: t.clientText?.trim() || null,
    reason: t.internalReason?.trim() || null,
    visibility: "client",
    metadata: t.source ? { source: t.source } : {},
  });
  await recordAudit(
    {
      orgId: task.org_id,
      actorUserId: actor.userId,
      actorKind: actor.kind === "client" ? "user" : actor.kind === "agency" ? "agency" : "system",
      action: "setup.task_status_changed",
      targetType: "setup_task",
      targetId: task.id,
      result: "success",
      metadata: { step: task.template_key ?? "custom", from, to, source: t.source ?? null },
    },
    db,
  );

  if (t.notify !== false && isApplicable({ hidden: task.hidden, serviceExcluded: task.service_excluded }) && task.completion_mode !== "activation") {
    const title = clientTitle(task);
    if (to === "completed") {
      await h.notifyClient({ kind: "setup_milestone", severity: "success", title: task.completion_notice || `${title} — completed`, body: t.clientText?.trim() || undefined, link: "/setup" });
    } else if (to === "waiting_for_client") {
      await h.notifyClient({ kind: "setup_action_required", severity: "warning", title: `Action needed: ${task.client_action?.label ?? title}`, body: t.clientText?.trim() || task.client_note || undefined, link: "/setup" });
    } else if (to === "blocked") {
      await h.notifyClient({ kind: "setup_issue", severity: "warning", title: `${title} needs attention`, body: t.clientText?.trim(), link: "/setup" });
    }
  }
}
