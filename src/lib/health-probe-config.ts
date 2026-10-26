// How the scheduled AI-employee health probe is tuned, from environment variables. Pure, so a test can hand in any environment. Every number is bounded: a typo cannot make the
// probe hammer a gateway (a tiny interval, a huge batch) or hang the scheduler (a huge timeout); an unreadable value falls back to the default instead of failing the tick.
//
// The probe is OFF unless WORKFORCE_HEALTH_PROBE_ENABLED=true, and it only runs when the scheduler does (CRON_SECRET and SCHEDULER_ENABLED, and the job named in
// SCHEDULER_JOBS_ONLY during a staged start). Deploying this code starts nothing.

export interface ProbeConfig {
  enabled: boolean;
  /** Minutes between probes of a healthy employee. */
  intervalMinutes: number;
  /** Minutes between probes of an employee whose last probe failed (the retry cadence that counts toward the failure threshold). */
  retryMinutes: number;
  /** Most employees probed in one tick; the oldest-probed go first, so a long backlog is worked off fairly. */
  batch: number;
  /** Probes in flight at once. */
  concurrency: number;
  /** The longest one attempt may take before it is counted as a failure. */
  timeoutMs: number;
  /** Tries within one probe (the first plus bounded retries for a transient failure). */
  attempts: number;
  retryDelayMs: number;
  /** After this long a tick starts no further probe; the rest wait for the next tick. */
  budgetMs: number;
  /** Probe log rows older than this are removed. */
  retentionDays: number;
}

export const PROBE_DEFAULTS: Omit<ProbeConfig, "enabled"> = {
  intervalMinutes: 15,
  retryMinutes: 5,
  batch: 12,
  concurrency: 3,
  timeoutMs: 45_000,
  attempts: 2,
  retryDelayMs: 1_500,
  budgetMs: 80_000,
  retentionDays: 30,
};

const BOUNDS: Record<keyof Omit<ProbeConfig, "enabled">, [number, number]> = {
  intervalMinutes: [5, 1440],
  retryMinutes: [1, 120],
  batch: [1, 50],
  concurrency: [1, 6],
  timeoutMs: [5_000, 90_000],
  attempts: [1, 3],
  retryDelayMs: [0, 10_000],
  budgetMs: [10_000, 100_000],
  retentionDays: [1, 365],
};

const VARIABLES: Record<keyof Omit<ProbeConfig, "enabled">, string> = {
  intervalMinutes: "WORKFORCE_HEALTH_PROBE_INTERVAL_MINUTES",
  retryMinutes: "WORKFORCE_HEALTH_PROBE_RETRY_MINUTES",
  batch: "WORKFORCE_HEALTH_PROBE_BATCH",
  concurrency: "WORKFORCE_HEALTH_PROBE_CONCURRENCY",
  timeoutMs: "WORKFORCE_HEALTH_PROBE_TIMEOUT_MS",
  attempts: "WORKFORCE_HEALTH_PROBE_ATTEMPTS",
  retryDelayMs: "WORKFORCE_HEALTH_PROBE_RETRY_DELAY_MS",
  budgetMs: "WORKFORCE_HEALTH_PROBE_BUDGET_MS",
  retentionDays: "WORKFORCE_HEALTH_PROBE_RETENTION_DAYS",
};

export function probeConfig(vars: Record<string, string | undefined> = process.env): ProbeConfig {
  const out = { enabled: vars.WORKFORCE_HEALTH_PROBE_ENABLED === "true", ...PROBE_DEFAULTS } as ProbeConfig;
  for (const key of Object.keys(VARIABLES) as Array<keyof typeof VARIABLES>) {
    const raw = vars[VARIABLES[key]];
    if (raw === undefined || raw.trim() === "") continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n)) continue;
    const [lo, hi] = BOUNDS[key];
    out[key] = Math.min(hi, Math.max(lo, n));
  }
  return out;
}
