import "server-only";
import { withSystem } from "@/server/db";
import type { AgentRoleKey } from "@/lib/agents";
import { probeConfig } from "@/lib/health-probe-config";
import { sanitizeErrorText } from "@/lib/ops";
import { runHealthCheck, type HealthResult } from "@/server/workforce/service";

// The first portal health check of a freshly provisioned (or re-synchronized) client profile, started by the platform and not by a person.
//
// The restricted worker leaves an employee in "provisioning" with its job in "awaiting_health_check": it proved the host side (identity, effective SOUL, tool inventory), and the
// portal has still to look for itself. Until now only an agency button or someone opening the employee's chat did that. This module runs the SAME check an administrator's "check
// connection" runs (runHealthCheck as the system actor: read-only GETs with the employee's own credential, no model tokens, no run, nothing to a customer).
//
// What a pass does:  runHealthCheck flips the employee online and closes the job (succeeded), and then starts the launch sweep and the setup checklist, exactly as it does for a person.
// What a failure does: the failure is recorded as one more consecutive failure (one alert at the threshold, see health-alerts.ts), the employee shows the real reason, and the job
//   stays open (awaiting_health_check) so a later pass can still close it. A failed check never fails or cancels a job.
// Who is checked:     only an enabled employee of an active client workspace whose job is awaiting its check and that has a profile and a saved credential. Anything else is left
//   alone, so nothing here ever contacts a gateway for a disabled employee or a suspended workspace.
// When it runs:       right after the worker's completion (the complete route, after the response) and, as the safety net, from the provisioning watchdog.

export interface FirstCheckDeps {
  /** The check. Tests hand in a stand-in; the default is the real, read-only health check. */
  check?: (agentId: string, opts: { now: Date }) => Promise<HealthResult>;
}

export interface FirstCheckOutcome {
  agentId: string;
  orgId: string;
  jobId: string;
  role: AgentRoleKey;
  ok: boolean;
  status: string;
  detail: string;
}

export interface FirstCheckSummary {
  /** Employees whose turn it was. */
  due: number;
  /** Roles that were checked (the same role can appear once per workspace). */
  checked: AgentRoleKey[];
  /** The subset of `checked` whose check did not pass. */
  failed: AgentRoleKey[];
  /** Due employees left for the next pass because the budget ran out. */
  deferred: number;
  outcomes: FirstCheckOutcome[];
}

export interface FirstCheckOptions {
  now?: Date;
  /** Only employees whose job has waited at least this long and whose last check is at least this old (the watchdog's follow-up). 0 or absent: everyone who is waiting. */
  minAgeMinutes?: number;
  limit?: number;
  budgetMs?: number;
  deps?: FirstCheckDeps;
}

const BATCH = 12;
const CONCURRENCY = 3;
const BUDGET_MS = 60_000;

interface DueEmployee {
  agent_id: string;
  org_id: string;
  role_key: AgentRoleKey;
  job_id: string;
}

const realCheck = (agentId: string, opts: { now: Date }) =>
  runHealthCheck(agentId, { userId: null, kind: "system" }, { scheduled: true, countFailure: true, now: opts.now });

async function selectAwaiting(filter: { orgId?: string; jobId?: string; settledBefore: Date | null; limit: number }): Promise<DueEmployee[]> {
  return withSystem(async (db) => {
    const { rows } = await db.query<DueEmployee>(
      `select a.id as agent_id, a.org_id, a.role_key, j.id as job_id
         from agent_provisioning_jobs j
         join agent_instances a on a.id = j.agent_instance_id and a.org_id = j.org_id
         join organizations o on o.id = j.org_id
        where j.status = 'awaiting_health_check' and j.kind in ('provision', 'sync')
          and a.enabled and a.hermes_profile is not null and a.credential_id is not null
          and o.kind = 'client' and o.status = 'active' and not o.is_demo
          and ($1::uuid is null or j.org_id = $1::uuid)
          and ($2::uuid is null or j.id = $2::uuid)
          and ($3::timestamptz is null or (j.updated_at <= $3::timestamptz and (a.last_health_check_at is null or a.last_health_check_at <= $3::timestamptz)))
        order by j.updated_at, j.id
        limit $4`,
      [filter.orgId ?? null, filter.jobId ?? null, filter.settledBefore ? filter.settledBefore.toISOString() : null, filter.limit],
    );
    return rows;
  });
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<{ done: true; value: T } | { done: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ done: false }>((resolve) => { timer = setTimeout(() => resolve({ done: false }), ms); });
  try {
    return await Promise.race([work.then((value) => ({ done: true as const, value })), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function checkOne(due: DueEmployee, check: NonNullable<FirstCheckDeps["check"]>, now: Date, timeoutMs: number): Promise<FirstCheckOutcome> {
  let result: HealthResult;
  try {
    const attempt = await withTimeout(check(due.agent_id, { now }), timeoutMs);
    result = attempt.done ? attempt.value : { ok: false, status: "offline", detail: `The health check did not answer within ${Math.round(timeoutMs / 1000)} seconds.` };
  } catch (error) {
    // An unexpected error is not a verdict about the employee: nothing is recorded, and the watchdog looks again on its next pass.
    result = { ok: false, status: "offline", detail: `The health check could not run: ${sanitizeErrorText(error, 200)}` };
  }
  return { agentId: due.agent_id, orgId: due.org_id, jobId: due.job_id, role: due.role_key, ok: result.ok, status: result.status, detail: result.detail.slice(0, 500) };
}

async function runDue(due: DueEmployee[], now: Date, opts: FirstCheckOptions): Promise<FirstCheckSummary> {
  const cfg = probeConfig();
  const check = opts.deps?.check ?? realCheck;
  const deadline = Date.now() + (opts.budgetMs ?? BUDGET_MS);
  const queue = [...due];
  const outcomes: FirstCheckOutcome[] = [];
  const worker = async () => {
    for (;;) {
      if (Date.now() >= deadline) return;
      const next = queue.shift();
      if (!next) return;
      outcomes.push(await checkOne(next, check, now, cfg.timeoutMs));
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, due.length) }, worker));
  return {
    due: due.length,
    checked: outcomes.map((o) => o.role),
    failed: outcomes.filter((o) => !o.ok).map((o) => o.role),
    deferred: queue.length,
    outcomes,
  };
}

/**
 * The first check of the one employee a provisioning job belongs to, started the moment the worker's completion is accepted. Does nothing (and contacts nobody) when the job is not
 * waiting for its check any more, or the employee is disabled, has no profile or credential, or its workspace is not active.
 */
export async function runPostProvisionCheck(jobId: string, opts: FirstCheckOptions = {}): Promise<FirstCheckSummary> {
  const now = opts.now ?? new Date();
  const due = await selectAwaiting({ jobId, settledBefore: null, limit: 1 });
  return runDue(due, now, opts);
}

/** Every employee whose job is waiting for its first check (one workspace's, or all of them), oldest first and bounded. The watchdog's follow-up uses `minAgeMinutes`. */
export async function runAwaitingHealthChecks(orgId?: string, opts: FirstCheckOptions = {}): Promise<FirstCheckSummary> {
  const now = opts.now ?? new Date();
  const minAge = Math.max(0, opts.minAgeMinutes ?? 0);
  const due = await selectAwaiting({
    orgId,
    settledBefore: minAge > 0 ? new Date(now.getTime() - minAge * 60_000) : null,
    limit: Math.min(Math.max(1, opts.limit ?? BATCH), 50),
  });
  return runDue(due, now, opts);
}
