import "server-only";
import crypto from "node:crypto";
import { z } from "zod";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import type { SessionUser } from "@/server/auth/service";
import { recordAudit } from "@/server/audit";
import { assertAgencyAccess, lockAgencySetupAccess, mutateSetup } from "@/server/setup/core";
import { runChecks } from "@/server/setup/automation";
import { createConfigVersion, currentSettings, suggestedProfileName } from "@/server/workforce/service";
import type { AgentRoleKey } from "@/lib/agents";
import { CHECK_LABEL, type CheckKey, type CheckStatus } from "@/lib/setup";

export const PREPARATION_OPERATIONS = ["prepare_ai_configuration", "prepare_automation_configuration", "manual_ghl_mapping", "manual_hermes_profiles", "verify_integrations"] as const;
export type PreparationOperation = (typeof PREPARATION_OPERATIONS)[number];
export const OPERATION_LABEL: Record<PreparationOperation, string> = {
  prepare_ai_configuration: "Prepare AI configuration drafts",
  prepare_automation_configuration: "Prepare safe automation configuration",
  manual_ghl_mapping: "Create and map the CRM sub-account",
  manual_hermes_profiles: "Provision dedicated Hermes profiles",
  verify_integrations: "Verify configured integrations",
};
export interface PreparationJob {
  id: string;
  org_id: string;
  operation: PreparationOperation;
  status: "queued" | "running" | "awaiting_admin" | "succeeded" | "failed" | "cancelled";
  attempt_count: number;
  max_attempts: number;
  last_error: string | null;
  next_retry_at: Date | null;
  lease_expires_at: Date | null;
  external_resource_ids: Record<string, unknown>;
  prepared_configuration: Record<string, unknown>;
  requested_by: string | null;
  created_at: Date;
  updated_at: Date;
}
const queueSchema = z.object({
  operation: z.enum(PREPARATION_OPERATIONS),
  idempotencyKey: z.string().trim().min(8).max(160).regex(/^[a-zA-Z0-9:_-]+$/),
}).strict();
const retireSchema = z.object({
  reason: z.string().trim().min(10, "Explain why this job is being retired.").max(450),
  supersededBy: z.string().uuid().optional(),
}).strict();

async function mutatePreparation<T>(admin: SessionUser, orgId: string, fn: (db: Queryable) => Promise<T>): Promise<T> {
  const out = await mutateSetup(orgId, async (db) => {
    await lockAgencySetupAccess(db, admin, orgId);
    return fn(db);
  });
  return out.result;
}

/** Called only by trusted onboarding or an authorized agency transaction. No external operation. */
async function insertJob(db: Queryable, orgId: string, operation: PreparationOperation, key: string, userId: string | null) {
  const { rows } = await db.query<{ id: string }>(
    `insert into provisioning_jobs (org_id, operation, idempotency_key, requested_by)
     values ($1, $2, $3, $4) on conflict (org_id, operation, idempotency_key) do nothing returning id`,
    [orgId, operation, key, userId],
  );
  if (rows[0]) {
    await recordAudit({ orgId, actorUserId: userId, actorKind: userId ? "user" : "system", action: "provisioning.queued", targetType: "provisioning_job", targetId: rows[0].id, result: "success", metadata: { operation } }, db);
    return rows[0].id;
  }
  const existing = await db.query<{ id: string }>("select id from provisioning_jobs where org_id = $1 and operation = $2 and idempotency_key = $3", [orgId, operation, key]);
  return existing.rows[0].id;
}

export async function queueOnboardingPreparations(db: Queryable, orgId: string, userId: string) {
  // A workspace whose CRM doesn't use GoHighLevel at all (iAcquire's own CRM, or a hybrid with no GoHighLevel capability) has no sub-account
  // to create and map, so it gets no such job. The same rule scopes the Setup Center's GoHighLevel steps (app.setup_crm_uses, 0037).
  const usesGhl = (await db.query<{ uses: boolean }>("select app.setup_crm_uses($1, 'ghl') as uses", [orgId])).rows[0]?.uses === true;
  for (const op of PREPARATION_OPERATIONS.filter((o) => o !== "verify_integrations" && (usesGhl || o !== "manual_ghl_mapping"))) {
    await insertJob(db, orgId, op, `onboarding:${orgId}:v1`, userId);
  }
}

export async function queuePreparation(admin: SessionUser, orgId: string, input: z.input<typeof queueSchema>) {
  await assertAgencyAccess(admin, orgId);
  const parsed = queueSchema.parse(input);
  return mutatePreparation(admin, orgId, async (db) => {
    const org = await db.query("select 1 from organizations where id = $1 and kind = 'client' and status not in ('archived', 'suspended')", [orgId]);
    if (!org.rows.length) throw new AppError("not_found", "An available client workspace is required.");
    return insertJob(db, orgId, parsed.operation, parsed.idempotencyKey, admin.id);
  });
}

export async function getPreparationJobs(admin: SessionUser, orgId: string) {
  await assertAgencyAccess(admin, orgId);
  return withUser(admin.id, async (db) => {
    const jobs = await db.query<PreparationJob>("select * from provisioning_jobs where org_id = $1 order by created_at desc limit 100", [orgId]);
    const attempts = await db.query<{ job_id: string; attempt_number: number; status: string; error_summary: string | null; started_at: Date; finished_at: Date | null }>(
      "select job_id, attempt_number, status, error_summary, started_at, finished_at from provisioning_job_attempts where org_id = $1 order by started_at desc limit 300", [orgId],
    );
    const retirements = await db.query<{ target_id: string; metadata: { reason: string; supersededBy: string | null }; created_at: Date }>(
      "select target_id, metadata, created_at from audit_logs where org_id = $1 and action = 'provisioning.retired' order by created_at desc limit 100", [orgId],
    );
    return { jobs: jobs.rows, attempts: attempts.rows, retirements: retirements.rows };
  });
}

async function claimJob(admin: SessionUser, orgId: string, jobId: string) {
  return mutatePreparation(admin, orgId, async (db) => {
    const { rows } = await db.query<PreparationJob>("select * from provisioning_jobs where id = $1 and org_id = $2 for update", [jobId, orgId]);
    const job = rows[0];
    if (!job) throw new AppError("not_found", "Preparation job not found.");
    if (job.status === "running") {
      if (job.lease_expires_at && new Date(job.lease_expires_at).getTime() > Date.now()) throw new AppError("conflict", "This job is already running.");
      await db.query("update provisioning_job_attempts set status = 'interrupted', error_summary = 'Worker lease expired; safe to retry.', finished_at = now() where job_id = $1 and status = 'running'", [job.id]);
      await db.query("update provisioning_jobs set status = 'failed', lease_token = null, lease_expires_at = null, next_retry_at = null, last_error = 'Worker lease expired; review required.' where id = $1", [job.id]);
      await recordAudit({ orgId, actorUserId: admin.id, actorKind: "agency", action: "provisioning.lease_recovered", targetType: "provisioning_job", targetId: job.id, result: "failure" }, db);
      job.status = "failed";
      job.next_retry_at = null;
    }
    if (!["queued", "failed", "awaiting_admin"].includes(job.status)) return null;
    // Return the error after this transaction commits: throwing here would undo lease recovery.
    if (job.attempt_count >= job.max_attempts) return { exhausted: true } as const;
    if (job.next_retry_at && new Date(job.next_retry_at).getTime() > Date.now()) throw new AppError("conflict", "Wait until the recorded retry time before retrying.");
    const token = crypto.randomUUID();
    const claim = await db.query<PreparationJob>(
      `update provisioning_jobs set status = 'running', attempt_count = attempt_count + 1, last_error = null,
       next_retry_at = null, lease_token = $2, lease_expires_at = now() + interval '5 minutes'
       where id = $1 returning *`, [job.id, token],
    );
    await db.query("insert into provisioning_job_attempts (org_id, job_id, attempt_number, status) values ($1, $2, $3, 'running')", [orgId, job.id, claim.rows[0].attempt_count]);
    await recordAudit({ orgId, actorUserId: admin.id, actorKind: "agency", action: "provisioning.started", targetType: "provisioning_job", targetId: job.id, result: "success", metadata: { attempt: claim.rows[0].attempt_count, operation: job.operation } }, db);
    return { job: claim.rows[0], token };
  });
}

interface PreparationResult {
  status: "succeeded" | "awaiting_admin";
  detail?: string;
  resourceIds?: Record<string, unknown>;
  configuration?: Record<string, unknown>;
}
async function prepare(job: PreparationJob, admin: SessionUser, leaseToken: string): Promise<PreparationResult> {
  const actorId = admin.id;
  if (job.operation === "verify_integrations") {
    const result = await runChecks(job.org_id, { actorUserId: actorId, agency: admin, live: true, force: true });
    if (!result || !result.ran.length) {
      throw new AppError("integration_unavailable", "The setup checks could not run. Review the setup checks and try again.");
    }
    // Only the checks behind required steps decide this job, the same rule as final_health. Optional steps' checks (for example the SMS
    // and WhatsApp senders) run too; a failing one is reported in the job's result but never fails the job, so it can't block activation.
    // Every required check is read back from the stored results, including any the engine omitted because it could not run it.
    const required = (await withSystem((db) => db.query<{ check_key: CheckKey; status: CheckStatus | null }>(
      `select distinct t.check_key, c.status from client_setup_tasks t left join client_setup_checks c on c.org_id = t.org_id and c.check_key = t.check_key
       where t.org_id = $1 and t.required and not t.hidden and not t.service_excluded and t.completion_mode = 'verified'`, [job.org_id],
    ))).rows;
    const failedRequired = required.filter((r) => r.status === "failed");
    if (failedRequired.length) {
      throw new AppError("integration_unavailable", `A required integration check failed: ${failedRequired.map((r) => CHECK_LABEL[r.check_key] ?? r.check_key).join(", ")}. Review the setup checks.`);
    }
    if (required.some((r) => r.status !== "verified")) throw new AppError("integration_unavailable", "A required provider check is still unavailable or unverified.");
    const requiredKeys = new Set(required.map((r) => r.check_key));
    const optionalFailures = result.ran.filter((r) => r.status === "failed" && !requiredKeys.has(r.key)).map((r) => r.key);
    return {
      status: "succeeded",
      detail: optionalFailures.length ? `Every required check is verified. Optional checks that need attention: ${optionalFailures.map((k) => CHECK_LABEL[k] ?? k).join(", ")}.` : undefined,
      configuration: { checked: result.ran.map((r) => r.key), optionalFailures, externalActivation: false },
    };
  }
  return withSystem(async (db) => {
    await lockAgencySetupAccess(db, admin, job.org_id);
    const lease = await db.query("select 1 from provisioning_jobs where id=$1 and org_id=$2 and status='running' and lease_token=$3 and lease_expires_at>now() for update", [job.id,job.org_id,leaseToken]);
    if (!lease.rows.length) throw new AppError("conflict", "The preparation lease expired or changed. Review the job history before retrying.");
    // Serialize configuration versions against concurrent staff edits and worker retries.
    const org = await db.query<{ slug: string; timezone: string; onboarding_completed_at: Date | null }>("select slug, timezone, onboarding_completed_at from organizations where id = $1 for update", [job.org_id]);
    if (!org.rows[0]?.onboarding_completed_at) throw new AppError("conflict", "The client must submit company onboarding before preparation.");
    if (job.operation === "prepare_ai_configuration") {
      const { rows: agents } = await db.query<{ id: string }>("select id from agent_instances where org_id = $1 and enabled order by role_key for update", [job.org_id]);
      if (!agents.length) throw new AppError("conflict", "Select the included AI employees before preparation.");
      const versionIds: string[] = [];
      for (const agent of agents) {
        const marker = `Provisioning job ${job.id}`;
        const existing = await db.query<{ id: string }>("select id from agent_config_versions where agent_instance_id = $1 and org_id = $2 and change_request = $3", [agent.id, job.org_id, marker]);
        if (existing.rows[0]) { versionIds.push(existing.rows[0].id); continue; }
        const current = await currentSettings(db, agent.id, job.org_id);
        const version = await createConfigVersion(db, { orgId: job.org_id, agentId: agent.id, settings: current.settings, source: "agency", changeRequest: marker, userId: actorId, apply: false });
        versionIds.push(version.versionId);
      }
      return { status: "succeeded", resourceIds: { configurationVersionIds: versionIds }, configuration: { purpose: "Agency review drafts; no remote profile created or activated", count: versionIds.length } };
    }
    if (job.operation === "prepare_automation_configuration") {
      const profile = await db.query<{ ai_preferences: Record<string, unknown> }>("select ai_preferences from company_profiles where org_id = $1", [job.org_id]);
      return { status: "succeeded", configuration: { tenantId: job.org_id, timezone: org.rows[0].timezone, requiresAgencyApproval: true, outreachEnabled: false, workflowActivation: false, crmWritePermissions: [], communicationPreferences: profile.rows[0]?.ai_preferences ?? {} } };
    }
    if (job.operation === "manual_ghl_mapping") {
      return { status: "awaiting_admin", detail: "Create the sub-account manually from the approved Master Snapshot, then save and test its Location ID in Client Integrations. Snapshot installation needs separate evidence.", configuration: { manualSubaccountCreation: true, snapshotVerificationRequired: true, crmWritesEnabled: false } };
    }
    const { rows: agents } = await db.query<{ id: string; role_key: AgentRoleKey; hermes_profile: string | null }>("select id, role_key, hermes_profile from agent_instances where org_id = $1 and enabled order by role_key", [job.org_id]);
    return { status: "awaiting_admin", detail: "Use the agency provisioning runbook to create isolated profiles with separate keys and restricted tools. Save each mapping and run the verified health test. No remote profile-creation API has been assumed.", configuration: { profiles: agents.map((a) => ({ employeeId: a.id, role: a.role_key, suggestedProfile: a.hermes_profile ?? suggestedProfileName(org.rows[0].slug, a.role_key) })), remoteCreationSupported: false } };
  });
}

/** Explicit staff action: leased, retryable and idempotent. It cannot edit or activate remote systems. */
export async function executePreparation(admin: SessionUser, orgId: string, jobId: string) {
  await assertAgencyAccess(admin, orgId);
  z.string().uuid().parse(jobId);
  const claimed = await claimJob(admin, orgId, jobId);
  if (!claimed) return { repeated: true };
  if ("exhausted" in claimed) throw new AppError("conflict", "Retry limit reached. Review the history and retire this job before scheduling a replacement.");
  let outcome: PreparationResult | null = null;
  let error: string | null = null;
  try { outcome = await prepare(claimed.job, admin, claimed.token); }
  catch (err) { error = err instanceof AppError ? err.message : "Preparation failed safely. Review configuration and retry; no external activation occurred."; }
  await assertAgencyAccess(admin, orgId);
  await mutatePreparation(admin, orgId, async (db) => {
    const status = outcome?.status ?? "failed";
    const updated = await db.query(
      `update provisioning_jobs set status = $4, last_error = $5, external_resource_ids = $6, prepared_configuration = $7,
       next_retry_at = case when $4 = 'failed' and attempt_count < max_attempts then now() + ($8 * interval '1 second') end,
       lease_token = null, lease_expires_at = null where id = $1 and org_id = $2 and lease_token = $3`,
      [jobId, orgId, claimed.token, status, error ?? outcome?.detail ?? null, JSON.stringify(outcome?.resourceIds ?? claimed.job.external_resource_ids), JSON.stringify(outcome?.configuration ?? claimed.job.prepared_configuration), 30 * 2 ** (claimed.job.attempt_count - 1)],
    );
    if (!updated.rowCount) throw new AppError("conflict", "The worker lease changed. Refresh the job history.");
    await db.query("update provisioning_job_attempts set status = $3, error_summary = $4, finished_at = now() where job_id = $1 and attempt_number = $2 and status = 'running'", [jobId, claimed.job.attempt_count, status, error ?? outcome?.detail ?? null]);
    await recordAudit({ orgId, actorUserId: admin.id, actorKind: "agency", action: `provisioning.${status}`, targetType: "provisioning_job", targetId: jobId, result: error ? "failure" : "success", metadata: { operation: claimed.job.operation, attempt: claimed.job.attempt_count } }, db);
  });
  return { repeated: false, status: outcome?.status ?? "failed" };
}

/** Retires a job explicitly; previous attempts, drafts, task progress and provider checks are retained. */
export async function retirePreparation(admin: SessionUser, orgId: string, jobId: string, input: z.input<typeof retireSchema>) {
  await assertAgencyAccess(admin, orgId);
  z.string().uuid().parse(jobId);
  const data = retireSchema.parse(input);
  return mutatePreparation(admin, orgId, async (db) => {
    const { rows } = await db.query<PreparationJob>("select * from provisioning_jobs where id = $1 and org_id = $2 for update", [jobId, orgId]);
    const job = rows[0];
    if (!job) throw new AppError("not_found", "Preparation job not found.");
    if (job.status === "cancelled") return { repeated: true };
    if (job.status === "succeeded") throw new AppError("conflict", "A successful job remains in the preparation history.");
    if (job.status === "running" && job.lease_expires_at && new Date(job.lease_expires_at).getTime() > Date.now()) {
      throw new AppError("conflict", "This job has a live worker lease. Wait for it to finish or expire before retiring it.");
    }
    if (data.supersededBy) {
      if (data.supersededBy === jobId) throw new AppError("invalid_input", "A replacement must be a different job.");
      const replacement = await db.query("select 1 from provisioning_jobs where id = $1 and org_id = $2 and operation = $3 and status = 'succeeded' for share", [data.supersededBy, orgId, job.operation]);
      if (!replacement.rows.length) throw new AppError("invalid_input", "Select a successfully prepared replacement for the same client and operation.");
    }
    if (job.status === "running") {
      await db.query("update provisioning_job_attempts set status = 'interrupted', error_summary = $2, finished_at = now() where job_id = $1 and status = 'running'", [jobId, `Expired worker retired: ${data.reason}`]);
    }
    await db.query("update provisioning_jobs set status = 'cancelled', lease_token = null, lease_expires_at = null, next_retry_at = null, last_error = $2 where id = $1", [jobId, `Retired: ${data.reason}`]);
    await recordAudit({ orgId, actorUserId: admin.id, actorKind: "agency", action: "provisioning.retired", targetType: "provisioning_job", targetId: jobId, result: "success", metadata: { reason: data.reason, supersededBy: data.supersededBy ?? null, previousStatus: job.status, previousError: job.last_error, attemptsRetained: job.attempt_count } }, db);
    return { repeated: false };
  });
}
