import "server-only";
import type { Queryable } from "@/server/db";
import { notifyOrgRoles } from "@/server/notifications";
import {
  LIMIT_LABELS, LIMIT_METRIC, STUDIO_DEFAULT_LIMITS, STUDIO_METRICS, periodMonth, quotaStatus,
  type LimitKey, type QuotaState, type StudioLimits, type StudioMetric,
} from "@/lib/automation-studio/plan";

/**
 * Automation Studio usage: monthly counters per workspace and the fair-use limits they are measured against.
 *
 * Counters are upserted in the same transaction as the work they count (a step's own transaction, a run's creation), so a figure never
 * counts work that rolled back and never misses work that committed. Only workflows that belong to the plan are metered and limited;
 * workflows from the CRM workflow screens are neither, so the contracted CRM never runs into a Studio limit.
 *
 * A limit is always a number: the platform default (src/lib/automation-studio/plan.ts) or the workspace's own, set by an agency member.
 * When a limit is reached, new runs are not started (and the owners are told once); runs already in progress finish, bounded by the
 * engine's own per-run step limit.
 */

const LIVE = ["queued", "running", "waiting", "awaiting_approval"];

/** Adds to a counter. `costMicros` is what the counted work cost iAcquire, where it was measured or estimated; it is never billed by itself. */
export async function addStudioUsage(db: Queryable, orgId: string, metric: StudioMetric, quantity = 1, opts: { costMicros?: number; at?: Date } = {}): Promise<void> {
  if (!Number.isInteger(quantity) || quantity < 0) throw new RangeError("A usage quantity is a non-negative whole number.");
  const cost = Math.max(0, Math.round(opts.costMicros ?? 0));
  await db.query(
    `insert into automation_studio_usage (org_id, period_month, metric, quantity, cost_micros) values ($1, $2, $3, $4, $5)
     on conflict (org_id, period_month, metric) do update
       set quantity = automation_studio_usage.quantity + excluded.quantity, cost_micros = automation_studio_usage.cost_micros + excluded.cost_micros, updated_at = now()`,
    [orgId, periodMonth(opts.at), metric, quantity, cost],
  );
}

interface LimitsRow {
  monthly_runs: number | null;
  monthly_steps: number | null;
  monthly_builder_messages: number | null;
  monthly_employee_invocations: number | null;
  monthly_integration_calls: number | null;
  max_active_workflows: number | null;
  max_live_runs: number | null;
  warn_at_percent: number;
  hard_stop: boolean;
  note: string | null;
}

const COLUMN_OF: Record<LimitKey, keyof LimitsRow> = {
  monthlyRuns: "monthly_runs", monthlySteps: "monthly_steps", monthlyBuilderMessages: "monthly_builder_messages",
  monthlyEmployeeInvocations: "monthly_employee_invocations", monthlyIntegrationCalls: "monthly_integration_calls",
  maxActiveWorkflows: "max_active_workflows", maxLiveRuns: "max_live_runs",
};
export const LIMIT_KEYS = Object.keys(COLUMN_OF) as LimitKey[];

export interface EffectiveLimits {
  limits: StudioLimits;
  /** The limits the workspace has of its own (the rest are platform defaults). */
  overrides: Partial<Record<LimitKey, number>>;
  warnAtPercent: number;
  /** True: reaching a limit stops new runs. False: the owners are told and nothing is stopped. */
  hardStop: boolean;
  note: string | null;
}

export async function studioLimits(db: Queryable, orgId: string): Promise<EffectiveLimits> {
  const { rows } = await db.query<LimitsRow>(
    `select monthly_runs, monthly_steps, monthly_builder_messages, monthly_employee_invocations, monthly_integration_calls, max_active_workflows, max_live_runs,
            warn_at_percent, hard_stop, note from automation_studio_limits where org_id = $1`,
    [orgId],
  );
  const row = rows[0];
  const limits = { ...STUDIO_DEFAULT_LIMITS };
  const overrides: Partial<Record<LimitKey, number>> = {};
  if (row) {
    for (const key of LIMIT_KEYS) {
      const v = row[COLUMN_OF[key]];
      if (typeof v === "number") {
        limits[key] = v;
        overrides[key] = v;
      }
    }
  }
  return { limits, overrides, warnAtPercent: row?.warn_at_percent ?? 80, hardStop: row?.hard_stop ?? true, note: row?.note ?? null };
}

async function counters(db: Queryable, orgId: string, at: Date, metrics: readonly StudioMetric[] = STUDIO_METRICS): Promise<Record<StudioMetric, { quantity: number; costMicros: number }>> {
  const { rows } = await db.query<{ metric: StudioMetric; quantity: string; cost_micros: string }>(
    "select metric, quantity::text, cost_micros::text from automation_studio_usage where org_id = $1 and period_month = $2 and metric = any($3::text[])",
    [orgId, periodMonth(at), metrics],
  );
  const out = Object.fromEntries(STUDIO_METRICS.map((m) => [m, { quantity: 0, costMicros: 0 }])) as Record<StudioMetric, { quantity: number; costMicros: number }>;
  for (const r of rows) out[r.metric] = { quantity: Number(r.quantity), costMicros: Number(r.cost_micros) };
  return out;
}

/** Workflows of the plan that are switched on, and runs of the plan that are unfinished: the two limits that count current state. */
async function liveCounts(db: Queryable, orgId: string): Promise<{ activeWorkflows: number; liveRuns: number }> {
  const { rows } = await db.query<{ active: number; live: number }>(
    `select
       (select count(*)::int from crm_workflows w join crm_workflow_versions v on v.id = w.published_version_id and v.org_id = w.org_id
         where w.org_id = $1 and w.status = 'active' and cardinality(v.premium_features) > 0) as active,
       (select count(*)::int from crm_workflow_runs r join crm_workflow_versions v on v.id = r.version_id and v.org_id = r.org_id
         where r.org_id = $1 and r.status = any($2::text[]) and cardinality(v.premium_features) > 0) as live`,
    [orgId, LIVE],
  );
  return { activeWorkflows: rows[0]?.active ?? 0, liveRuns: rows[0]?.live ?? 0 };
}

export interface UsageLine {
  key: LimitKey;
  label: string;
  used: number;
  limit: number;
  state: QuotaState;
  percent: number;
  remaining: number;
  /** The workspace has its own limit rather than the platform default. */
  custom: boolean;
}

export interface StudioUsageSnapshot {
  period: string;
  counters: Record<StudioMetric, { quantity: number; costMicros: number }>;
  lines: UsageLine[];
  /** Everything the counted work cost iAcquire this month, where measured or estimated (micro-dollars). */
  estimatedCostMicros: number;
  hardStop: boolean;
  warnAtPercent: number;
  note: string | null;
}

/** Everything the usage page shows: this month's counters against the workspace's limits. */
export async function studioUsageSnapshot(db: Queryable, orgId: string, now = new Date()): Promise<StudioUsageSnapshot> {
  const [lim, c, live] = await Promise.all([studioLimits(db, orgId), counters(db, orgId, now), liveCounts(db, orgId)]);
  const usedOf = (key: LimitKey): number => {
    if (key === "maxActiveWorkflows") return live.activeWorkflows;
    if (key === "maxLiveRuns") return live.liveRuns;
    return c[LIMIT_METRIC[key]!].quantity;
  };
  const lines = LIMIT_KEYS.map((key): UsageLine => ({
    key, label: LIMIT_LABELS[key], used: usedOf(key), limit: lim.limits[key], custom: key in lim.overrides, ...quotaStatus(usedOf(key), lim.limits[key], lim.warnAtPercent),
  }));
  return {
    period: periodMonth(now), counters: c, lines, estimatedCostMicros: Object.values(c).reduce((n, v) => n + v.costMicros, 0),
    hardStop: lim.hardStop, warnAtPercent: lim.warnAtPercent, note: lim.note,
  };
}

export type RunAdmission = { allowed: true } | { allowed: false; limit: LimitKey; detail: string };

const REFUSAL: Partial<Record<LimitKey, string>> = {
  monthlyRuns: "this workspace reached its monthly limit of Automation Studio workflow runs",
  monthlySteps: "this workspace reached its monthly limit of Automation Studio steps",
  maxLiveRuns: "this workspace has too many Automation Studio runs in progress at once",
};

/** Tells the owners once per month and limit, at the warning level and again when the limit is reached. */
async function noticeQuota(db: Queryable, orgId: string, key: LimitKey, state: QuotaState, used: number, limit: number, at: Date, hardStop: boolean) {
  if (state === "ok") return;
  const reached = state === "exceeded";
  await notifyOrgRoles(db, orgId, ["owner", "admin"], {
    kind: "usage_limit_approaching",
    severity: "warning",
    title: reached ? `Automation Studio limit reached: ${LIMIT_LABELS[key].toLowerCase()}` : `Automation Studio usage is at ${quotaStatus(used, limit).percent}% of ${LIMIT_LABELS[key].toLowerCase()}`,
    body: reached
      ? `${used.toLocaleString("en-US")} of ${limit.toLocaleString("en-US")} used.${hardStop ? " New workflow runs wait until the limit changes or the month ends; runs already in progress finish." : " Nothing is stopped; ask iAcquire if you need more capacity."}`
      : `${used.toLocaleString("en-US")} of ${limit.toLocaleString("en-US")} used this month. Contact iAcquire if you need more capacity.`,
    link: "/crm/workflows",
    dedupeKey: `studio-quota:${key}:${state}:${periodMonth(at)}`,
  });
}

/**
 * Whether a workspace may start another run of a plan workflow now. Called when a run would be created, in the creator's transaction.
 * Refusing never loses work silently: the caller records the run as not started with the reason.
 */
export async function admitStudioRun(db: Queryable, orgId: string, now = new Date()): Promise<RunAdmission> {
  const [lim, c, live] = await Promise.all([studioLimits(db, orgId), counters(db, orgId, now, ["runs_started", "steps_executed"]), liveCounts(db, orgId)]);
  const checks: Array<[LimitKey, number]> = [["monthlyRuns", c.runs_started.quantity], ["monthlySteps", c.steps_executed.quantity], ["maxLiveRuns", live.liveRuns]];
  let refused: RunAdmission = { allowed: true };
  for (const [key, used] of checks) {
    const limit = lim.limits[key];
    const q = quotaStatus(used, limit, lim.warnAtPercent);
    await noticeQuota(db, orgId, key, q.state, used, limit, now, lim.hardStop);
    if (q.state === "exceeded" && lim.hardStop && refused.allowed) refused = { allowed: false, limit: key, detail: `Not started: ${REFUSAL[key]}.` };
  }
  return refused;
}

/** Whether another workflow of the plan may be switched on. Raising the number of live workflows is the only thing this limit stops. */
export async function admitActiveWorkflow(db: Queryable, orgId: string): Promise<RunAdmission> {
  const [lim, live] = await Promise.all([studioLimits(db, orgId), liveCounts(db, orgId)]);
  const limit = lim.limits.maxActiveWorkflows;
  if (live.activeWorkflows >= limit && lim.hardStop) {
    return { allowed: false, limit: "maxActiveWorkflows", detail: `This workspace already has ${live.activeWorkflows} Automation Studio workflows switched on, which is its limit (${limit}). Switch one off or ask iAcquire to raise the limit.` };
  }
  return { allowed: true };
}
