import "server-only";
import { withSystem } from "@/server/db";
import { sanitizeErrorText } from "@/lib/ops";

export interface JobRunRow {
  jobName: string;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  consecutiveFailures: number;
  runsTotal: number;
  lastDurationMs: number | null;
  lastError: string | null;
}

export type JobOutcome<T> = { ok: true; value: T; durationMs: number } | { ok: false; error: string; durationMs: number };

/**
 * Runs one scheduled job and records its heartbeat. A job that throws is recorded as a failure and never stops the jobs after it.
 * Recording is best effort: if the heartbeat cannot be written, the job's own result is still returned (and the failure to record
 * shows up because the heartbeat goes stale).
 */
export async function runJob<T>(name: string, fn: () => Promise<T>, summarize?: (value: T) => unknown): Promise<JobOutcome<T>> {
  const started = Date.now();
  await withSystem((db) =>
    db.query(
      `insert into worker_job_runs (job_name, last_started_at) values ($1, now())
       on conflict (job_name) do update set last_started_at = now()`,
      [name],
    ),
  ).catch(() => undefined);

  let outcome: JobOutcome<T>;
  try {
    const value = await fn();
    outcome = { ok: true, value, durationMs: Date.now() - started };
  } catch (err) {
    outcome = { ok: false, error: sanitizeErrorText(err), durationMs: Date.now() - started };
  }

  const result = outcome.ok && summarize ? JSON.stringify(summarize(outcome.value) ?? null) : null;
  await withSystem((db) =>
    db.query(
      `update worker_job_runs set last_finished_at = now(), last_duration_ms = $2, runs_total = runs_total + 1,
         last_success_at = case when $3 then now() else last_success_at end,
         last_failure_at = case when $3 then last_failure_at else now() end,
         consecutive_failures = case when $3 then 0 else consecutive_failures + 1 end,
         last_error = case when $3 then null else $4 end,
         last_result = case when $3 then $5::jsonb else last_result end
       where job_name = $1`,
      [name, outcome.durationMs, outcome.ok, outcome.ok ? null : outcome.error, result],
    ),
  ).catch(() => undefined);

  if (!outcome.ok) console.error(`[iacquire] scheduled job ${name} failed`);
  return outcome;
}

export async function listJobRuns(): Promise<JobRunRow[]> {
  const { rows } = await withSystem((db) =>
    db.query<{
      job_name: string; last_started_at: Date | null; last_finished_at: Date | null; last_success_at: Date | null; last_failure_at: Date | null;
      consecutive_failures: number; runs_total: string; last_duration_ms: number | null; last_error: string | null;
    }>("select * from worker_job_runs order by job_name"),
  );
  const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
  return rows.map((r) => ({
    jobName: r.job_name,
    lastStartedAt: iso(r.last_started_at),
    lastFinishedAt: iso(r.last_finished_at),
    lastSuccessAt: iso(r.last_success_at),
    lastFailureAt: iso(r.last_failure_at),
    consecutiveFailures: r.consecutive_failures,
    runsTotal: Number(r.runs_total),
    lastDurationMs: r.last_duration_ms,
    lastError: r.last_error,
  }));
}

/** True if this job succeeded less than `minutes` ago, so a slow-rhythm job can sit out most scheduler runs. A job that has never succeeded is due. */
export async function withinInterval(name: string, minutes: number, now = new Date()): Promise<boolean> {
  const { rows } = await withSystem((db) => db.query<{ last: Date | null }>("select last_success_at as last from worker_job_runs where job_name = $1", [name]));
  const last = rows[0]?.last ? new Date(rows[0].last).getTime() : null;
  return last !== null && now.getTime() - last < minutes * 60_000;
}
