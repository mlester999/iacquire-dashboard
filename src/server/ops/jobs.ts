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

/** Returned instead of an outcome when a slow-rhythm job was not due (or is still running): nothing was executed and nothing was recorded. */
export interface JobSkipped {
  ok: true;
  skipped: true;
  reason: "not_due" | "running";
  durationMs: 0;
}

export interface RunJobOptions {
  /**
   * Makes this a slow-rhythm job: it executes only if at least this many minutes have passed since its previous run *started*, is not
   * already running, and (after a failure) only after the shorter retry delay. The decision and the claim are one statement, so two
   * overlapping ticks cannot both run it.
   */
  everyMinutes?: number;
  /** The scheduler's clock. Production leaves it unset (the database clock is used); tests pass a simulated tick time. */
  now?: Date;
}

/** After a failure a slow job is retried on the next tick that is at least this far (or its own interval, if shorter) from the failure. */
export const JOB_RETRY_MINUTES = 15;
/** A gated job whose run started but never finished is treated as abandoned (the worker died) after this long, and becomes due again. */
export const JOB_ABANDONED_AFTER_MINUTES = 15;

/**
 * Runs one scheduled job and records its heartbeat. A job that throws is recorded as a failure and never stops the jobs after it.
 * Recording is best effort: if the heartbeat cannot be written, the job's own result is still returned (and the failure to record
 * shows up because the heartbeat goes stale).
 *
 * With `everyMinutes` the job is gated. A skipped tick writes nothing, so `last_success_at`, `last_started_at` and `runs_total` keep
 * describing the last time the job really ran. (Gating used to live inside each job and returned 0, which was recorded as a success and
 * moved `last_success_at` forward on every tick, so a gated job ran once and then never again.)
 */
export async function runJob<T>(name: string, fn: () => Promise<T>, summarize?: (value: T) => unknown): Promise<JobOutcome<T>>;
export async function runJob<T>(name: string, fn: () => Promise<T>, summarize: ((value: T) => unknown) | undefined, options: RunJobOptions): Promise<JobOutcome<T> | JobSkipped>;
export async function runJob<T>(name: string, fn: () => Promise<T>, summarize?: (value: T) => unknown, options: RunJobOptions = {}): Promise<JobOutcome<T> | JobSkipped> {
  const started = Date.now();
  const at = options.now ? options.now.toISOString() : null;

  if (options.everyMinutes !== undefined) {
    const every = Math.max(1, Math.floor(options.everyMinutes));
    try {
      const claimed = await withSystem((db) =>
        db.query<{ job_name: string }>(
          `insert into worker_job_runs (job_name, last_started_at) values ($1, coalesce($2::timestamptz, now()))
           on conflict (job_name) do update set last_started_at = coalesce($2::timestamptz, now())
           where case
                   -- The last run finished: due again after the interval, or sooner after a failure.
                   when worker_job_runs.last_finished_at is not null and worker_job_runs.last_finished_at >= worker_job_runs.last_started_at
                     then case when worker_job_runs.consecutive_failures > 0
                               then worker_job_runs.last_failure_at is null
                                    or worker_job_runs.last_failure_at <= coalesce($2::timestamptz, now()) - make_interval(mins => $4)
                               else worker_job_runs.last_success_at is null
                                    or worker_job_runs.last_started_at <= coalesce($2::timestamptz, now()) - make_interval(mins => $3)
                          end
                   -- The last run started and never finished: still running, until it has been silent long enough to be presumed dead.
                   else worker_job_runs.last_started_at is null
                        or worker_job_runs.last_started_at <= coalesce($2::timestamptz, now()) - make_interval(mins => $5)
                 end
           returning job_name`,
          [name, at, every, Math.min(every, JOB_RETRY_MINUTES), JOB_ABANDONED_AFTER_MINUTES],
        ),
      );
      if (claimed.rows.length === 0) {
        // Not due, or another tick holds it. Distinguish the two for the caller without a second write.
        const state = await withSystem((db) => db.query<{ running: boolean }>("select (last_finished_at is null or last_finished_at < last_started_at) as running from worker_job_runs where job_name = $1", [name]));
        return { ok: true, skipped: true, reason: state.rows[0]?.running ? "running" : "not_due", durationMs: 0 };
      }
    } catch (err) {
      // If the claim itself cannot be made the job is not run, but this must not stop the jobs after it.
      console.error(`[iacquire] scheduled job ${name} could not be claimed`);
      return { ok: false, error: sanitizeErrorText(err), durationMs: Date.now() - started };
    }
  } else {
    await withSystem((db) =>
      db.query(
        `insert into worker_job_runs (job_name, last_started_at) values ($1, coalesce($2::timestamptz, now()))
         on conflict (job_name) do update set last_started_at = coalesce($2::timestamptz, now())`,
        [name, at],
      ),
    ).catch(() => undefined);
  }

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
      `update worker_job_runs set last_finished_at = coalesce($6::timestamptz, now()), last_duration_ms = $2, runs_total = runs_total + 1,
         last_success_at = case when $3 then coalesce($6::timestamptz, now()) else last_success_at end,
         last_failure_at = case when $3 then last_failure_at else coalesce($6::timestamptz, now()) end,
         consecutive_failures = case when $3 then 0 else consecutive_failures + 1 end,
         last_error = case when $3 then null else $4 end,
         last_result = case when $3 then $5::jsonb else last_result end
       where job_name = $1`,
      [name, outcome.durationMs, outcome.ok, outcome.ok ? null : outcome.error, result, at],
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
