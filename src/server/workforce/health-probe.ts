import "server-only";
import { withSystem } from "@/server/db";
import type { AgentRoleKey, AgentStatus } from "@/lib/agents";
import { probeConfig, type ProbeConfig } from "@/lib/health-probe-config";
import { runHealthCheck, type HealthResult } from "@/server/workforce/service";
import { announceHealthObservation, healthProbeSchemaReady, recordHealthObservation, type HealthObservation } from "@/server/workforce/health-alerts";

// The scheduled AI-employee health probe: an authenticated, bounded, read-only look at each connected employee's Hermes profile, so an outage is seen by the platform and not
// first by whoever opens a chat.
//
// What a probe is:  the same check an administrator's "check connection" runs (runHealthCheck): capabilities, identity, the profile's toolsets and the complete tool inventory read
//   twice, all GET requests with the employee's own credential. It spends no model tokens, starts no run, writes nothing to Hermes and sends nothing to a customer.
// What it is not:   a capability test. A passing probe says the runtime is reachable and unchanged; it does not say the employee can do its job (the role prerequisites in
//   src/lib/employee-requirements.ts and the conformance suite say that). And it never confirms a CHANGED tool inventory: that stays an explicit human step.
// What it costs:    at most `batch` employees per tick, `concurrency` at a time, each with a time limit and one bounded retry, and no new probe after the tick's budget is spent.
// When it runs:     only inside the scheduler (job `aiHealthProbe`), only when WORKFORCE_HEALTH_PROBE_ENABLED=true, and in a staged start only when named in SCHEDULER_JOBS_ONLY.
// Alerts:           below the threshold the employee reads "Degraded" on screen and nobody is notified; at HEALTH_FAILURE_THRESHOLD consecutive failures the owners, admins and the
//   agency staff who look after the workspace get ONE notice, and one more when it recovers (src/server/workforce/health-alerts.ts).

export interface ProbeOutcome {
  agentId: string;
  orgId: string;
  role: AgentRoleKey;
  ok: boolean;
  status: AgentStatus;
  detail: string;
  attempts: number;
  durationMs: number;
  timedOut: boolean;
  consecutiveFailures: number;
  alerted: boolean;
  recovered: boolean;
}

export interface ProbeSummary {
  enabled: boolean;
  due: number;
  probed: number;
  failed: number;
  alerted: number;
  recovered: number;
  /** Due employees left for the next tick because the budget ran out. */
  deferred: number;
  pruned: number;
  outcomes: ProbeOutcome[];
}

export interface ProbeDeps {
  /** The check. Tests hand in a stand-in; the default is the real, read-only health check. `countFailure` is false on an attempt the probe will retry. */
  check?: (agentId: string, opts: { countFailure: boolean; now: Date }) => Promise<HealthResult>;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
}

interface DueAgent {
  id: string;
  org_id: string;
  role_key: AgentRoleKey;
}

const realCheck = (agentId: string, opts: { countFailure: boolean; now: Date }) => runHealthCheck(agentId, { userId: null, kind: "system" }, { skipSetupSync: true, scheduled: true, countFailure: opts.countFailure, now: opts.now });
const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The employees whose turn it is: switched on, with an applied configuration and a saved Hermes credential, in an active workspace, not waiting on a person (set up, provisioning,
 * disabled), whose last probe is older than the interval (older than the shorter retry interval while it is failing). Oldest probe first, so a backlog is worked off fairly.
 */
export async function selectDueAgents(now: Date, cfg: Pick<ProbeConfig, "intervalMinutes" | "retryMinutes" | "batch">, limit = cfg.batch): Promise<DueAgent[]> {
  return withSystem(async (db) => {
    if (!(await healthProbeSchemaReady(db))) return [];
    const { rows } = await db.query<DueAgent>(
      `select a.id, a.org_id, a.role_key
         from agent_instances a
         join organizations o on o.id = a.org_id
        where a.enabled
          and o.status = 'active'
          and a.active_config_version_id is not null
          and a.credential_id is not null
          and a.hermes_profile is not null
          and a.status not in ('disabled', 'setup_required', 'provisioning')
          and (a.last_probe_at is null
               or a.last_probe_at <= $1::timestamptz - make_interval(mins => case when a.health_consecutive_failures > 0 then $3::int else $2::int end))
        order by a.last_probe_at asc nulls first, a.id
        limit $4`,
      [now.toISOString(), cfg.intervalMinutes, cfg.retryMinutes, limit],
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

/** A failure that is worth another try within the same probe: the gateway did not answer. A rejected key, a changed inventory or an unsafe tool will not fix itself in a second. */
const transient = (r: HealthResult) => !r.ok && r.status === "offline";

async function probeOne(agent: DueAgent, cfg: ProbeConfig, deps: Required<ProbeDeps>, now: Date): Promise<ProbeOutcome> {
  const started = deps.clock();
  const check = deps.check;
  let last: HealthResult | null = null;
  let attempts = 0;
  let timedOut = false;
  for (let i = 0; i < cfg.attempts; i += 1) {
    attempts += 1;
    // Never counted by the check itself: whether a failure counts is decided once, below, after the last try.
    const attempt = await withTimeout(check(agent.id, { countFailure: false, now }).catch((error: unknown): HealthResult => ({ ok: false, status: "offline", detail: `The health check could not run: ${error instanceof Error ? error.message : "unknown error"}`.slice(0, 400) })), cfg.timeoutMs);
    if (!attempt.done) {
      timedOut = true;
      last = { ok: false, status: "offline", detail: `The health check did not answer within ${Math.round(cfg.timeoutMs / 1000)} seconds.` };
      break; // a check that hangs is not retried: the next tick will look again
    }
    last = attempt.value;
    if (last.ok || !transient(last) || i === cfg.attempts - 1) break;
    await deps.sleep(cfg.retryDelayMs);
  }
  const result = last as HealthResult;
  let observation: HealthObservation | null = result.observation ?? null;
  let announced = result.announced ?? { alerted: false, recovered: false };
  if (!result.ok) {
    // One probe is one observation: the failure (after the last try, or the timeout) is recorded here, once, and announced the same way a check would announce it.
    await withSystem(async (db) => {
      observation = await recordHealthObservation(db, { agentId: agent.id, ok: false, source: "scheduled", now });
      if (observation) announced = await announceHealthObservation(db, { orgId: agent.org_id, agentId: agent.id, role: agent.role_key, observation, detail: result.detail });
    });
  }
  const failures = (observation as HealthObservation | null)?.consecutiveFailures;
  return {
    agentId: agent.id, orgId: agent.org_id, role: agent.role_key, ok: result.ok, status: result.status, detail: result.detail.slice(0, 500), attempts,
    durationMs: Math.max(0, deps.clock() - started), timedOut, consecutiveFailures: failures ?? (result.ok ? 0 : 1),
    alerted: announced.alerted, recovered: announced.recovered,
  };
}

async function logProbe(outcome: ProbeOutcome) {
  await withSystem((db) => db.query(
    `insert into agent_health_probes (org_id, agent_instance_id, source, ok, status, detail, attempts, duration_ms, consecutive_failures)
     values ($1, $2, 'scheduled', $3, $4, $5, $6, $7, $8)`,
    [outcome.orgId, outcome.agentId, outcome.ok, outcome.status, outcome.detail, outcome.attempts, outcome.durationMs, outcome.consecutiveFailures],
  ));
}

/** Probe log rows past their retention. Telemetry only. */
export async function pruneProbeLog(now: Date, retentionDays: number, limit = 500): Promise<number> {
  return withSystem(async (db) => {
    if (!(await healthProbeSchemaReady(db))) return 0;
    const { rowCount } = await db.query(
      "delete from agent_health_probes where id in (select id from agent_health_probes where probed_at < $1::timestamptz - make_interval(days => $2::int) limit $3)",
      [now.toISOString(), retentionDays, limit],
    );
    return rowCount ?? 0;
  });
}

/** One scheduler pass. Safe to call when the probe is off: it does nothing and says so. */
export async function runHealthProbe(opts: { now?: Date; config?: ProbeConfig; deps?: ProbeDeps } = {}): Promise<ProbeSummary> {
  const cfg = opts.config ?? probeConfig();
  const summary: ProbeSummary = { enabled: cfg.enabled, due: 0, probed: 0, failed: 0, alerted: 0, recovered: 0, deferred: 0, pruned: 0, outcomes: [] };
  if (!cfg.enabled) return summary;
  const now = opts.now ?? new Date();
  const deps: Required<ProbeDeps> = { check: opts.deps?.check ?? realCheck, sleep: opts.deps?.sleep ?? realSleep, clock: opts.deps?.clock ?? Date.now };
  const due = await selectDueAgents(now, cfg);
  summary.due = due.length;
  const deadline = deps.clock() + cfg.budgetMs;
  const queue = [...due];
  const worker = async () => {
    for (;;) {
      if (deps.clock() >= deadline) return;
      const next = queue.shift();
      if (!next) return;
      const outcome = await probeOne(next, cfg, deps, now);
      summary.outcomes.push(outcome);
      summary.probed += 1;
      if (!outcome.ok) summary.failed += 1;
      await logProbe(outcome).catch(() => undefined);
    }
  };
  await Promise.all(Array.from({ length: Math.min(cfg.concurrency, due.length) }, worker));
  summary.deferred = queue.length;
  summary.alerted = summary.outcomes.filter((o) => o.alerted).length;
  summary.recovered = summary.outcomes.filter((o) => o.recovered).length;
  summary.pruned = await pruneProbeLog(now, cfg.retentionDays).catch(() => 0);
  return summary;
}
