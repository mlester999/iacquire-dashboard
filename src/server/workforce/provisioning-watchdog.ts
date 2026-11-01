import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AGENT_BY_KEY, isAgentRoleKey } from "@/lib/agents";
import { sanitizeErrorText } from "@/lib/ops";
import { env } from "@/server/env";
import { recordAudit } from "@/server/audit";
import { notifyAgency, notifyOrgRoles } from "@/server/notifications";
import { runAwaitingHealthChecks, type FirstCheckDeps } from "@/server/workforce/first-health-check";

// The provisioning watchdog: what notices a client profile job that nobody is working on any more.
//
// The restricted worker claims a job for ten minutes at a time and gives up after three attempts. Before this, an exhausted job whose last lease ran out stayed "in progress" for
// ever (the claim skips it, nothing closed it), a failure that arrived from the worker told nobody, a dead worker was invisible, and the first portal health check waited for a person.
// One pass (job `provisioningWatchdog`, every five minutes, only when the scheduler runs) does four bounded things, each safe to repeat:
//   1. closes a job whose third attempt's lease ran out, as failed (code lease_expired), once, with an audit row and a notice to the agency and to the client's owner;
//   2. announces every other terminal failure (three attempts used) once, the same way, because the worker's own failure callback tells nobody;
//   3. when a request has waited longer than HERMES_PROVISIONER_STALL_MINUTES and the worker has been silent or the gateway is not verified, tells the agency once per workspace per day;
//   4. follows up on employees still waiting for their first health check after two minutes (the complete route starts that check by itself; this is the safety net).
// What it never does: fail a job because a health check failed, cancel anything, contact a customer, or touch a job whose lease is still live or that has attempts left (the claim
// retries those). Notices carry employee names, workspace names and a failure code, never a profile name, key, SOUL or prompt.

/** The liveness row the claim route keeps (the existing worker_job_runs table; no migration). Its success time is the last time the worker asked for work. */
export const PROVISIONER_LIVENESS_JOB = "hermes_provisioner_claim";
/** The worker polls every few seconds when idle; this long without a claim means it is not running. */
export const WORKER_SILENT_MINUTES = 5;
/** An employee waiting this long for its first check is followed up on. */
export const HEALTH_FOLLOW_UP_MINUTES = 2;
const BATCH = 50;

export interface WatchdogSummary {
  /** Jobs closed because their last lease ran out. */
  settled: number;
  /** Failed jobs announced for the first time (includes the ones just settled). */
  announced: number;
  /** Workspaces with a stalled queue that were looked at (the notice itself is once per workspace per day). */
  stalled: number;
  /** Employees whose first health check was followed up on, and how many of those did not pass. */
  checked: number;
  failedChecks: number;
}

export interface WatchdogOptions {
  now?: Date;
  deps?: FirstCheckDeps;
}

/**
 * Notes that the worker asked for work, at most once a minute (the write is skipped, not queued, inside the minute). Best effort: a failure here never touches the claim.
 * Returns whether this call wrote the row.
 */
export async function recordProvisionerClaimSeen(): Promise<boolean> {
  try {
    const { rows } = await withSystem((db) =>
      db.query<{ job_name: string }>(
        `insert into worker_job_runs (job_name, last_started_at, last_finished_at, last_success_at)
         values ($1, now(), now(), now())
         on conflict (job_name) do update
           set last_started_at = now(), last_finished_at = now(), last_success_at = now(), consecutive_failures = 0, last_error = null
           where worker_job_runs.last_success_at is null or worker_job_runs.last_success_at <= now() - interval '1 minute'
         returning job_name`,
        [PROVISIONER_LIVENESS_JOB],
      ),
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

/** Whether the worker has stopped asking for work: no record at all, or none for WORKER_SILENT_MINUTES. */
export async function provisionerWorkerSilence(db: Queryable, now: Date): Promise<{ silent: boolean; lastSeenAt: Date | null }> {
  const { rows } = await db.query<{ last_success_at: Date | null }>("select last_success_at from worker_job_runs where job_name = $1", [PROVISIONER_LIVENESS_JOB]);
  const last = rows[0]?.last_success_at ? new Date(rows[0].last_success_at) : null;
  return { silent: !last || last.getTime() <= now.getTime() - WORKER_SILENT_MINUTES * 60_000, lastSeenAt: last };
}

/** Whether the gateway the worker is pinned to is registered, connected and attested as the client-only runtime. */
export async function pinnedGatewayVerified(db: Queryable): Promise<boolean> {
  const id = env().HERMES_PROVISIONER_GATEWAY_ID;
  if (!id) return false;
  const { rows } = await db.query(
    `select 1 from hermes_gateways where id = $1 and status = 'connected' and gateway_type = 'multiplexed_profiles'
       and profile_creation_status = 'restricted_service_verified' and provisioner_isolation_verified_at is not null`,
    [id],
  );
  return rows.length > 0;
}

interface FailedJob {
  id: string;
  org_id: string;
  agent_instance_id: string;
  kind: string;
  detail: string | null;
  updated_at: Date | string;
  role_key: string;
  org_name: string;
}

const JOB_COLUMNS = "j.id, j.org_id, j.agent_instance_id, j.kind, j.detail, j.updated_at, a.role_key, o.name as org_name";
const JOB_JOINS = "from agent_provisioning_jobs j join agent_instances a on a.id = j.agent_instance_id and a.org_id = j.org_id join organizations o on o.id = j.org_id";

/**
 * SQL that keeps only an employee's newest job (`alias` is the agent_provisioning_jobs row being judged). Requeueing never edits the old failed row: it opens a new job beside it,
 * so a failed job that a later job replaced says nothing about the employee any more. Everything that counts or announces failures (this watchdog, the incident collector and the
 * health numbers) uses this, so none of them keeps reporting a failure that was already put right. The alias is code, never input.
 */
export function newestJobOfEmployeeSql(alias: string): string {
  return `${alias}.id = (select l.id from agent_provisioning_jobs l where l.agent_instance_id = ${alias}.agent_instance_id and l.org_id = ${alias}.org_id order by l.created_at desc, l.id desc limit 1)`;
}

/** The worker's failure code, read back from the detail text failJob and this watchdog write (a closed list of codes). Anything else, such as an agency note, is not repeated. */
function failureCodeOf(detail: string | null): string | null {
  const m = /^Restricted Hermes profile setup failed \(([a-z][a-z0-9_]{0,79})\)\./.exec(detail ?? "");
  return m ? m[1] : null;
}

/**
 * Tells the agency and the client's owner about one terminal failure, once. The notice keys carry the moment the job failed, so a job that is requeued and fails again is a new
 * announcement, while a repeated pass cannot repeat this one. The audit row is what the next pass reads to know it was announced.
 */
async function announceFailedJob(db: Queryable, job: FailedJob): Promise<void> {
  const meta = isAgentRoleKey(job.role_key) ? AGENT_BY_KEY[job.role_key] : null;
  const role = meta?.shortName ?? "AI employee";
  const updating = job.kind === "sync";
  const code = failureCodeOf(job.detail);
  const key = `provisioning-failed:${job.id}:${Math.floor(new Date(job.updated_at).getTime() / 1000)}`;
  await notifyAgency(db, job.org_id, {
    kind: "setup_issue",
    severity: "warning",
    title: `${job.org_name}: ${role} ${updating ? "configuration update" : "setup"} failed after 3 attempts`,
    body: `The restricted profile job stopped${code ? ` (${code})` : ""}. Review the isolated host result, then requeue it from the client's page.`,
    link: `/admin/clients/${job.org_id}`,
    dedupeKey: key,
  });
  await notifyOrgRoles(db, job.org_id, ["owner"], {
    kind: "setup_issue",
    severity: "info",
    title: `${role} ${updating ? "is taking longer to update" : "is taking longer to set up"} than expected`,
    body: "iAcquire has been told and is looking into it. You do not need to do anything.",
    link: "/setup",
    dedupeKey: `${key}:client`,
  });
  await recordAudit({
    orgId: job.org_id,
    actorKind: "system",
    agentInstanceId: job.agent_instance_id,
    action: "agent.provisioning_failure_announced",
    targetType: "agent_provisioning_job",
    targetId: job.id,
    result: "success",
    metadata: { code: code ?? "unknown", kind: job.kind },
  }, db);
}

/** 1. A job on its third attempt whose lease ran out is closed as failed. A live lease, and a job with attempts left (the claim retries it), are not touched. */
async function settleExpiredLeases(now: Date): Promise<number> {
  return withSystem(async (db) => {
    const { rows } = await db.query<FailedJob & { attempt_count: number }>(
      `select ${JOB_COLUMNS}, j.attempt_count ${JOB_JOINS}
        where j.kind in ('provision', 'sync') and j.status = 'in_progress' and j.attempt_count >= 3
          and (j.lease_expires_at is null or j.lease_expires_at <= $1::timestamptz)
        order by j.lease_expires_at nulls first, j.id
        limit $2
        for update of j skip locked`,
      [now.toISOString(), BATCH],
    );
    let settled = 0;
    for (const job of rows) {
      const closed = await db.query<{ updated_at: Date | string }>(
        `update agent_provisioning_jobs set status = 'failed', lease_token = null, lease_expires_at = null, next_retry_at = null,
           detail = 'Restricted Hermes profile setup failed (lease_expired). Review the isolated host result before retrying.'
         where id = $1 and status = 'in_progress' returning updated_at`,
        [job.id],
      );
      if (!closed.rows[0]) continue;
      settled += 1;
      await recordAudit({
        orgId: job.org_id,
        actorKind: "system",
        agentInstanceId: job.agent_instance_id,
        action: "agent.profile_provisioning_failed",
        targetType: "agent_provisioning_job",
        targetId: job.id,
        result: "failure",
        metadata: { code: "lease_expired", attempt: Number(job.attempt_count) },
      }, db);
      await announceFailedJob(db, { ...job, detail: "Restricted Hermes profile setup failed (lease_expired).", updated_at: closed.rows[0].updated_at });
    }
    return settled;
  });
}

/**
 * 2. Terminal failures (three attempts used, no retry left) nobody has been told about yet. The audit row written after the failure is the "told" marker. Only the employee's newest
 * job is announced: a failure that was requeued (or already replaced by a job that succeeded) before this pass, including every old one on the first pass after release, is history.
 */
async function announceTerminalFailures(): Promise<number> {
  return withSystem(async (db) => {
    const { rows } = await db.query<FailedJob>(
      `select ${JOB_COLUMNS} ${JOB_JOINS}
        where j.kind in ('provision', 'sync') and j.status = 'failed' and j.attempt_count >= 3
          and ${newestJobOfEmployeeSql("j")}
          and not exists (
            select 1 from audit_logs au
             where au.action = 'agent.provisioning_failure_announced' and au.target_id = j.id::text and au.created_at >= j.updated_at)
        order by j.updated_at, j.id
        limit $1
        for update of j skip locked`,
      [BATCH],
    );
    for (const job of rows) await announceFailedJob(db, job);
    return rows.length;
  });
}

/**
 * 3. A request that has waited longer than the stall threshold while the worker is silent or the gateway is not verified: one notice per workspace per day, and no state change.
 * Nothing is said while the provisioner is switched off (waiting is then the intended state) or while the worker is alive and the gateway is sound (the job is waiting on something
 * specific to its workspace, which the launch panel shows).
 */
async function noticeStalledQueue(now: Date): Promise<number> {
  const config = env();
  if (!config.HERMES_PROVISIONER_ENABLED) return 0;
  return withSystem(async (db) => {
    const cutoff = new Date(now.getTime() - config.HERMES_PROVISIONER_STALL_MINUTES * 60_000).toISOString();
    const { rows: waiting } = await db.query<{ org_id: string; org_name: string; n: number }>(
      `select j.org_id, o.name as org_name, count(*)::int as n
         from agent_provisioning_jobs j join organizations o on o.id = j.org_id
        where j.kind in ('provision', 'sync') and j.status = 'requested' and j.updated_at <= $1::timestamptz and o.status = 'active'
        group by j.org_id, o.name order by min(j.updated_at), j.org_id
        limit $2`,
      [cutoff, BATCH],
    );
    if (!waiting.length) return 0;
    const worker = await provisionerWorkerSilence(db, now);
    const gatewayOk = await pinnedGatewayVerified(db);
    if (!worker.silent && gatewayOk) return 0;
    const day = now.toISOString().slice(0, 10);
    const why = [
      worker.silent ? (worker.lastSeenAt ? `the worker has not asked for work since ${worker.lastSeenAt.toISOString().slice(0, 16).replace("T", " ")} UTC` : "the worker has never asked for work") : null,
      gatewayOk ? null : "the client Hermes gateway is not connected and verified",
    ].filter(Boolean).join("; ");
    for (const w of waiting) {
      await notifyAgency(db, w.org_id, {
        kind: "setup_issue",
        severity: "warning",
        title: `${w.org_name}: AI employee setup is stalled`,
        body: `${w.n} request${w.n === 1 ? " has" : "s have"} waited more than ${config.HERMES_PROVISIONER_STALL_MINUTES} minutes: ${why}. Nothing was changed.`,
        link: `/admin/clients/${w.org_id}`,
        dedupeKey: `provisioning-stalled:${w.org_id}:${day}`,
      });
    }
    return waiting.length;
  });
}

/** One watchdog pass. Every step runs even if another fails; a failed step is reported at the end so the scheduler records the failure. */
export async function runProvisioningWatchdog(opts: WatchdogOptions = {}): Promise<WatchdogSummary> {
  const now = opts.now ?? new Date();
  const summary: WatchdogSummary = { settled: 0, announced: 0, stalled: 0, checked: 0, failedChecks: 0 };
  const errors: unknown[] = [];
  const step = async (work: () => Promise<void>) => {
    try { await work(); } catch (error) { errors.push(error); }
  };
  await step(async () => { summary.settled = await settleExpiredLeases(now); summary.announced += summary.settled; });
  await step(async () => { summary.announced += await announceTerminalFailures(); });
  await step(async () => { summary.stalled = await noticeStalledQueue(now); });
  await step(async () => {
    // A failed check never fails the job: it stays open so a later pass can still close it, and the failure is counted and alerted by the health check itself.
    const r = await runAwaitingHealthChecks(undefined, { now, minAgeMinutes: HEALTH_FOLLOW_UP_MINUTES, deps: opts.deps });
    summary.checked = r.checked.length;
    summary.failedChecks = r.failed.length;
  });
  if (errors.length) throw new Error(`provisioning watchdog: ${errors.length} step${errors.length === 1 ? "" : "s"} failed. ${sanitizeErrorText(errors[0], 200)}`);
  return summary;
}
