import "server-only";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { assertNativeOwner } from "@/server/crm/workspace";
import { loadValidationContext } from "@/server/crm/workflows/context";
import { hasErrors, validateDefinition } from "@/lib/crm/workflow/spec";

/**
 * What happens when a person decides a workflow approval in the Approval Center (src/server/approvals/service.ts calls these).
 *
 *  - workflow_activation: an owner approved one published version. The approval is bound to that version's content hash
 *    (approved_hash = content_hash), so editing the workflow (a new version) needs a new approval. When the request asked for it, the
 *    workflow is switched on. The approval then stands for as long as that version is the one running: it no longer expires on the
 *    request's own deadline.
 *  - workflow_action: a person approved one step of one run ("ask before doing this"). Only the step is marked approved and the run made
 *    due; the scheduler runs the step, never this request.
 *  - A rejection (or a request for changes) of a step cancels that step and its run; of a version, leaves it unable to run.
 */

export type WorkflowExecOutcome = { status: "succeeded" | "failed" | "blocked"; detail: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown) => (typeof v === "string" ? v : null);

export async function executeWorkflowActivation(orgId: string, approvalId: string, action: Record<string, unknown>, actorUserId: string): Promise<WorkflowExecOutcome> {
  const versionId = str(action.versionId);
  const workflowId = str(action.workflowId);
  if (!versionId || !workflowId || !UUID.test(versionId) || !UUID.test(workflowId)) return { status: "failed", detail: "This approval doesn't name a workflow version, so nothing was switched on." };
  return withSystem(async (db): Promise<WorkflowExecOutcome> => {
    const w = (await db.query<{ id: string; name: string; status: string; published_version_id: string | null }>(
      "select id, name, status, published_version_id from crm_workflows where id = $1 and org_id = $2 for update",
      [workflowId, orgId],
    )).rows[0];
    if (!w) return { status: "blocked", detail: "The workflow no longer exists, so nothing was switched on." };
    const v = (await db.query<{ id: string; version: number; content_hash: string; trigger_config: unknown; steps: unknown }>(
      "select id, version, content_hash, trigger_config, steps from crm_workflow_versions where id = $1 and workflow_id = $2 and org_id = $3 for update",
      [versionId, workflowId, orgId],
    )).rows[0];
    if (!v) return { status: "blocked", detail: "That workflow version no longer exists, so nothing was switched on." };
    // The approval covers exactly the content the owner was shown.
    if (str(action.contentHash) && action.contentHash !== v.content_hash) return { status: "blocked", detail: "The workflow's content doesn't match what was approved, so nothing was switched on." };
    await db.query(
      "update crm_workflow_versions set approval_id = $2, approved_hash = content_hash, approved_by = $3, approved_at = now() where id = $1",
      [v.id, approvalId, actorUserId],
    );
    // Approved: it stands for as long as this version is the one running (a new version needs a new approval).
    await db.query("update approval_requests set expires_at = null where id = $1 and org_id = $2 and status = 'approved'", [approvalId, orgId]);
    let detail = `Version ${v.version} of "${w.name}" is approved.`;
    let switchedOn = false;
    if (action.activate === true) {
      if (w.published_version_id !== v.id) detail += " A newer version has been published since, so the workflow wasn't switched on; that version needs its own approval.";
      else if (w.status === "active") detail += " The workflow is already on.";
      else if (w.status === "archived") detail += " The workflow is archived, so it wasn't switched on.";
      else {
        const problems = validateDefinition({ trigger: v.trigger_config, steps: v.steps }, await loadValidationContext(db, orgId)).filter((i) => i.level === "error");
        let providerProblem: string | null = null;
        try {
          await assertNativeOwner(db, orgId, "workflows");
        } catch (err) {
          if (!(err instanceof AppError)) throw err;
          providerProblem = err.message;
        }
        if (providerProblem) detail += ` It wasn't switched on: ${providerProblem}`;
        else if (hasErrors(problems)) detail += ` It wasn't switched on because something it uses changed: ${problems[0].message} Edit and publish it again.`;
        else {
          await db.query("update crm_workflows set status = 'active', archived_at = null where id = $1", [w.id]);
          switchedOn = true;
          detail += " The workflow is on and starts for new matching events from now.";
        }
      }
    }
    await recordAudit({
      orgId, actorUserId, actorKind: "user", action: "crm.workflow_version_approved", targetType: "crm_workflow", targetId: w.id, approvalId, result: "success",
      metadata: { versionId: v.id, version: v.version, contentHash: v.content_hash, switchedOn },
    }, db);
    if (switchedOn) {
      await recordAudit({ orgId, actorUserId, actorKind: "user", action: "crm.workflow_status_changed", targetType: "crm_workflow", targetId: w.id, approvalId, result: "success", metadata: { from: w.status, to: "active", via: "approval" } }, db);
    }
    return { status: "succeeded", detail };
  });
}

export async function executeWorkflowAction(orgId: string, approvalId: string, action: Record<string, unknown>): Promise<WorkflowExecOutcome> {
  const runId = str(action.runId);
  if (!runId || !UUID.test(runId)) return { status: "failed", detail: "This approval doesn't name a workflow run." };
  return withSystem(async (db): Promise<WorkflowExecOutcome> => {
    const run = (await db.query<{ id: string; status: string; context: { approval?: { approvalId?: string } } | null }>(
      "select id, status, context from crm_workflow_runs where id = $1 and org_id = $2 for update",
      [runId, orgId],
    )).rows[0];
    if (!run) return { status: "blocked", detail: "The workflow run no longer exists, so nothing will happen." };
    const step = await db.query<{ id: string }>(
      "update crm_workflow_run_steps set result = result || $3::jsonb where run_id = $1 and approval_id = $2 and status = 'awaiting_approval' returning id",
      [run.id, approvalId, JSON.stringify({ approved: true, approvedAt: new Date().toISOString() })],
    );
    if (!step.rows[0] || run.status !== "awaiting_approval" || run.context?.approval?.approvalId !== approvalId) {
      return { status: "blocked", detail: "The workflow run had already stopped or moved on, so nothing will happen." };
    }
    await db.query("update crm_workflow_runs set status = 'queued', next_run_at = now(), claimed_at = null where id = $1", [run.id]);
    return { status: "succeeded", detail: "Approved. The step runs at the next scheduler pass, with every pause and messaging rule checked again then." };
  });
}

export async function releaseRejectedWorkflowApproval(orgId: string, approvalId: string, kind: "workflow_activation" | "workflow_action", action: Record<string, unknown>, actorUserId: string): Promise<void> {
  await withSystem(async (db) => {
    if (kind === "workflow_activation") {
      // The version simply stays unapproved: it can't be switched on, and nothing about it runs.
      const versionId = str(action.versionId);
      await recordAudit({ orgId, actorUserId, actorKind: "user", action: "crm.workflow_version_rejected", targetType: "crm_workflow", targetId: str(action.workflowId) ?? undefined, approvalId, result: "success", metadata: { versionId } }, db);
      return;
    }
    const runId = str(action.runId);
    if (!runId || !UUID.test(runId)) return;
    const run = (await db.query<{ id: string; status: string; workflow_id: string }>("select id, status, workflow_id from crm_workflow_runs where id = $1 and org_id = $2 for update", [runId, orgId])).rows[0];
    if (!run) return;
    const step = await db.query(
      "update crm_workflow_run_steps set status = 'cancelled', error = 'Rejected in the Approval Center.', finished_at = now() where run_id = $1 and approval_id = $2 and status = 'awaiting_approval' returning id",
      [run.id, approvalId],
    );
    if (step.rowCount && ["queued", "waiting", "awaiting_approval"].includes(run.status)) {
      await db.query(
        "update crm_workflow_runs set status = 'cancelled', finished_at = now(), claimed_at = null, cancelled_by = $2, last_error = 'A person rejected a step that needed approval, so the run stopped.' where id = $1",
        [run.id, actorUserId],
      );
    }
    await recordAudit({ orgId, actorUserId, actorKind: "user", action: "crm.workflow_step_rejected", targetType: "crm_workflow_run", targetId: run.id, approvalId, result: "success", metadata: { workflowId: run.workflow_id, stepKey: str(action.stepKey) } }, db);
  });
}
