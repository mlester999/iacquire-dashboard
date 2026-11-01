import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import {
  appendWorkEvent,
  finishWorkJob,
  recordWorkStage,
  type WorkJobRow,
} from "@/server/workforce/jobs";
import { publishReviewReport } from "@/server/workforce/reports";
import { roleMayUseCapability } from "@/lib/workforce-capabilities";
import type { AgentRoleKey } from "@/lib/agents";

/**
 * Shared execution path for a reviewed, read-only native review capability.
 *
 * The handler only reads records the tenant already stores. It writes the job's own stage/progress
 * events, a result and a reviewer notification. It never writes a business record, contacts a
 * provider or creates a schedule. A role that is not allowed to perform the capability is blocked
 * before any query runs.
 */

export type ReviewSeverity = "critical" | "warning" | "info";

export interface ReviewFinding {
  key: string;
  severity: ReviewSeverity;
  title: string;
  detail: string;
  count: number;
  samples: string[];
  evidenceHref: string;
  recommendedAction: string;
  requiresApproval: boolean;
}

export type ReviewCheck = (db: Queryable, job: WorkJobRow) => Promise<ReviewFinding | null>;

export interface ReviewMetric {
  key: string;
  label: string;
  value: number | string;
  unit?: string;
  period: string;
  definition: string;
  source: string;
  /** The measured value in the immediately preceding equal-length period, when a comparison exists. */
  previous?: number | null;
  change?: number | null;
  changePct?: number | null;
  trend?: "up" | "down" | "flat";
  comparisonPeriod?: string;
  /** Used by the UI to colour a trend without assuming every increase is good. */
  higherIsBetter?: boolean;
}

/** What a review looked at, so a count of zero reads as "nothing there yet" and never as "all clear". Label is a plural noun ("deals"). Contract C2. */
export interface ReviewExamined {
  label: string;
  count: number;
}

/** Which CRM mode the workspace is in and who owns the records the review read, so chat and the buttons describe a workspace the same way. */
export interface ReviewSource {
  crmMode: "native" | "ghl" | "hybrid" | null;
  provider: "native" | "ghl" | null;
}

export type ReviewCapabilityArea = "contacts" | "companies" | "opportunities" | "appointments" | "calendars" | "reporting";

export interface ReadOnlyReviewSpec {
  capability: string;
  allowedRoles: readonly AgentRoleKey[];
  /** Copy for the first stage, e.g. "Reading persisted CRM records…". */
  scanningMessage: string;
  /** Copy for the analysis stage. */
  analyzingMessage: string;
  checks: readonly ReviewCheck[];
  /** Optional measured KPIs. Only values read from this workspace appear; nothing is benchmarked. */
  metrics?: (db: Queryable, job: WorkJobRow) => Promise<ReviewMetric[]>;
  /** Cheap counts of what the checks read. Absent means the result carries no `examined` and the summary keeps its older wording. */
  examined?: (db: Queryable, job: WorkJobRow) => Promise<ReviewExamined[]>;
  /**
   * Set by a review of CRM records: the result then carries `source` and says where the records were read from. The value is the capability whose owner is named in
   * `source.provider` (a hybrid workspace has one owner per capability). A review with no CRM mode to describe leaves it out and its result stays as it was.
   */
  sourceArea?: ReviewCapabilityArea;
  /** Runs after the role gate and before the records are read, outside the review's transaction (for example a permission lookup about the requester). */
  beforeScan?: (job: WorkJobRow) => Promise<void>;
  limitations: string;
  /** Short noun used in the notification, e.g. "CRM quality". */
  subject: string;
}

const num = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/** One count(*) read, as a whole number. */
export async function reviewCount(db: Queryable, sql: string, params: unknown[]): Promise<number> {
  const { rows } = await db.query<{ count: number }>(sql, params);
  return num(rows[0]?.count);
}

/** "1 deal", "120 deals": the examined labels are plural nouns, and a count of one reads in the singular. */
function countNoun(item: ReviewExamined): string {
  if (item.count !== 1) return `${item.count} ${item.label}`;
  const singular = item.label.replace(/ies$/, "y").replace(/([^s])s$/, "$1");
  return `1 ${singular}`;
}

/** "120 deals", "3 contacts and 2 companies", "1 lead, 4 contacts and 2 deals". */
export function examinedPhrase(examined: readonly ReviewExamined[]): string {
  const parts = examined.map(countNoun);
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * Reads how this workspace keeps its CRM: the mode and the owner of one capability. The internal agency workspace is native by design and its row is created lazily, so a missing row
 * there is still native; a client workspace with no row stays unknown rather than guessed.
 */
export async function readReviewSource(db: Queryable, orgId: string, area?: ReviewCapabilityArea): Promise<ReviewSource> {
  const { rows } = await db.query<{ mode: "native" | "ghl" | "hybrid" | null; kind: string }>(
    "select w.mode, o.kind from organizations o left join crm_workspaces w on w.org_id = o.id where o.id = $1",
    [orgId],
  );
  const crmMode = rows[0]?.mode ?? (rows[0]?.kind === "agency" ? "native" : null);
  if (crmMode === "native" || crmMode === "ghl") return { crmMode, provider: crmMode };
  if (crmMode === "hybrid" && area) {
    const owner = await db.query<{ provider: "native" | "ghl" }>("select provider from crm_capability_providers where org_id = $1 and capability = $2", [orgId, area]);
    return { crmMode, provider: owner.rows[0]?.provider ?? null };
  }
  return { crmMode, provider: null };
}

/** The limitation sentence that says where the records came from, so a GoHighLevel or hybrid workspace is not described as native by the button and as unreadable by chat. */
export function sourceLimitation(source: ReviewSource): string {
  if (source.crmMode === "native") return "Read from the records iAcquire holds (native mode).";
  if (source.crmMode === "ghl") return "Read from the records iAcquire holds (GoHighLevel mode): these are the copies iAcquire stores, so anything newer in GoHighLevel is not included.";
  if (source.crmMode === "hybrid") return "Read from the records iAcquire holds (hybrid mode): a record that another system owns may be missing or older here.";
  return "Read from the records iAcquire holds (the CRM mode is not recorded for this workspace).";
}

interface SummaryInput {
  subject: string;
  findings: number;
  affected: number;
  critical: number;
  warning: number;
  metricNote: string;
  examined?: readonly ReviewExamined[];
}

/**
 * The job's one-line result. With a denominator it says what was checked: "Checked 0 deals. Nothing to review yet." for an empty workspace (still a pass, because a new client is
 * legitimately empty) and "Checked 120 deals: no signals" for a seeded one. A review with no reader keeps the older wording.
 */
export function reviewSummary(input: SummaryInput): string {
  const { subject, findings, affected, critical, warning, metricNote, examined } = input;
  const checked = examined?.length ? `Checked ${examinedPhrase(examined)}` : null;
  if (findings) {
    return `${subject} review found ${findings} signal${findings === 1 ? "" : "s"} across ${affected} affected item${affected === 1 ? "" : "s"} (${critical} critical, ${warning} warning).${checked ? ` ${checked}.` : ""}${metricNote}`;
  }
  if (!checked) return `${subject} review found no actionable signals in the persisted records checked.${metricNote}`;
  const nothingThere = (examined ?? []).every((item) => item.count === 0);
  return `${subject} review. ${checked}${nothingThere ? ". Nothing to review yet." : ": no signals."}${metricNote}`;
}

export function reviewFinding(input: Omit<ReviewFinding, "samples"> & { samples?: string[] }): ReviewFinding {
  return { ...input, samples: (input.samples ?? []).filter(Boolean).slice(0, 3) };
}

export function severityTone(severity: ReviewSeverity): "danger" | "warning" | "neutral" {
  return severity === "critical" ? "danger" : severity === "warning" ? "warning" : "neutral";
}

export async function runReadOnlyReviewJob(job: WorkJobRow, spec: ReadOnlyReviewSpec): Promise<void> {
  const workerId = job.lease_owner ?? "";
  const agent = await withSystem(async (db) => {
    const { rows } = await db.query<{ role_key: string; display_name: string }>(
      "select role_key, display_name from agent_instances where id = $1 and org_id = $2",
      [job.agent_instance_id, job.org_id],
    );
    return rows[0] ?? null;
  });
  if (!agent || !spec.allowedRoles.includes(agent.role_key as AgentRoleKey) || !roleMayUseCapability(agent.role_key as AgentRoleKey, job.capability)) {
    await withSystem(async (db) => {
      await finishWorkJob(db, {
        jobId: job.id,
        orgId: job.org_id,
        workerId,
        status: "blocked",
        stage: "blocked",
        failureCode: "capability_not_allowed",
        failureMessage: "This employee's role is not allowed to perform this review.",
        event: {
          kind: "error",
          stage: "blocked",
          message: "This employee's role is not allowed to perform this review, so nothing was read.",
        },
      });
    });
    return;
  }

  if (spec.beforeScan) await spec.beforeScan(job);

  await withSystem(async (db) => {
    await recordWorkStage(db, {
      jobId: job.id,
      orgId: job.org_id,
      workerId,
      stage: "scanning",
      message: spec.scanningMessage,
    });

    const findings: ReviewFinding[] = [];
    for (const check of spec.checks) {
      const result = await check(db, job);
      if (result && result.count > 0) findings.push(result);
    }
    const metrics = spec.metrics ? await spec.metrics(db, job) : [];
    const examined = spec.examined ? (await spec.examined(db, job)).map((item) => ({ label: item.label, count: num(item.count) })) : undefined;
    // Only the reviews of CRM records say where they read from; a receivables or social review has no CRM mode to describe.
    const source = spec.sourceArea ? await readReviewSource(db, job.org_id, spec.sourceArea) : undefined;
    const limitations = source ? `${spec.limitations} ${sourceLimitation(source)}` : spec.limitations;
    if (metrics.length) {
      await appendWorkEvent(db, {
        jobId: job.id,
        orgId: job.org_id,
        workerId,
        kind: "progress",
        stage: "analyzing",
        message: `Measured ${metrics.length} KPI${metrics.length === 1 ? "" : "s"} from persisted records.`,
        data: { metrics: metrics.map((metric) => metric.key) },
      });
    }

    await recordWorkStage(db, {
      jobId: job.id,
      orgId: job.org_id,
      workerId,
      stage: "analyzing",
      message: spec.analyzingMessage,
      progress: {
        checksRun: spec.checks.length,
        findings: findings.length,
        affectedItems: findings.reduce((total, item) => total + num(item.count), 0),
      },
    });

    for (const item of findings.slice(0, 12)) {
      await appendWorkEvent(db, {
        jobId: job.id,
        orgId: job.org_id,
        workerId,
        kind: "evidence",
        stage: "analyzing",
        message: `${item.title}${item.samples.length ? ` — e.g. ${item.samples.join("; ")}` : ""}`,
        data: { key: item.key, severity: item.severity, count: item.count, href: item.evidenceHref },
      });
    }

    const critical = findings.filter((item) => item.severity === "critical").length;
    const warning = findings.filter((item) => item.severity === "warning").length;
    const affected = findings.reduce((total, item) => total + num(item.count), 0);
    const metricNote = metrics.length ? ` Measured ${metrics.length} KPI${metrics.length === 1 ? "" : "s"} from the same records.` : "";
    const summary = reviewSummary({ subject: spec.subject, findings: findings.length, affected, critical, warning, metricNote, examined });

    await recordWorkStage(db, {
      jobId: job.id,
      orgId: job.org_id,
      workerId,
      stage: "preparing_results",
      message: "Review complete. Findings and recommended actions are ready.",
    });
    const finished = await finishWorkJob(db, {
      jobId: job.id,
      orgId: job.org_id,
      workerId,
      status: "completed",
      stage: "completed",
      resultCount: findings.length,
      resultSummary: summary,
      result: {
        subject: spec.subject,
        checkedAt: new Date().toISOString(),
        checksRun: spec.checks.length,
        findings,
        metrics,
        ...(examined ? { examined } : {}),
        ...(source ? { source } : {}),
        limitations,
      },
      event: {
        kind: "notice",
        stage: "completed",
        message: summary,
        data: { critical, warning, findings: findings.length, ...(examined ? { examined } : {}), ...(source ? { source } : {}) },
      },
    });
    if (!finished) throw new Error("work_finished_elsewhere");
    // The report is the durable proactive card. It is written after the job is complete, and its
    // delivery policy is per supervisor. A review with no findings is recorded but not announced.
    await publishReviewReport(db, {
      job,
      agent,
      subject: spec.subject,
      findings,
      metrics,
      limitations,
      checksRun: spec.checks.length,
    });
  });
}
