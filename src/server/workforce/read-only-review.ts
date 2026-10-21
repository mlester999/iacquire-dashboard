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
  limitations: string;
  /** Short noun used in the notification, e.g. "CRM quality". */
  subject: string;
}

const num = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

export function reviewFinding(input: Omit<ReviewFinding, "samples"> & { samples?: string[] }): ReviewFinding {
  return { ...input, samples: (input.samples ?? []).filter(Boolean).slice(0, 3) };
}

export function severityTone(severity: ReviewSeverity): "danger" | "warning" | "neutral" {
  return severity === "critical" ? "danger" : severity === "warning" ? "warning" : "neutral";
}

export async function runReadOnlyReviewJob(job: WorkJobRow, spec: ReadOnlyReviewSpec): Promise<void> {
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
        status: "blocked",
        stage: "blocked",
        failureCode: "capability_not_allowed",
        failureMessage: "This employee's role is not allowed to perform this review.",
      });
      await appendWorkEvent(db, {
        jobId: job.id,
        orgId: job.org_id,
        kind: "error",
        stage: "blocked",
        message: "This employee's role is not allowed to perform this review, so nothing was read.",
      });
    });
    return;
  }

  await withSystem(async (db) => {
    await recordWorkStage(db, {
      jobId: job.id,
      orgId: job.org_id,
      stage: "scanning",
      message: spec.scanningMessage,
    });

    const findings: ReviewFinding[] = [];
    for (const check of spec.checks) {
      const result = await check(db, job);
      if (result && result.count > 0) findings.push(result);
    }
    const metrics = spec.metrics ? await spec.metrics(db, job) : [];
    if (metrics.length) {
      await appendWorkEvent(db, {
        jobId: job.id,
        orgId: job.org_id,
        kind: "progress",
        stage: "analyzing",
        message: `Measured ${metrics.length} KPI${metrics.length === 1 ? "" : "s"} from persisted records.`,
        data: { metrics: metrics.map((metric) => metric.key) },
      });
    }

    await recordWorkStage(db, {
      jobId: job.id,
      orgId: job.org_id,
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
    const summary = findings.length
      ? `${spec.subject} review found ${findings.length} signal${findings.length === 1 ? "" : "s"} across ${affected} affected item${affected === 1 ? "" : "s"} (${critical} critical, ${warning} warning).${metricNote}`
      : `${spec.subject} review found no actionable signals in the persisted records checked.${metricNote}`;

    await recordWorkStage(db, {
      jobId: job.id,
      orgId: job.org_id,
      stage: "preparing_results",
      message: "Review complete. Findings and recommended actions are ready.",
    });
    const finished = await finishWorkJob(db, {
      jobId: job.id,
      orgId: job.org_id,
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
        limitations: spec.limitations,
      },
    });
    if (!finished) throw new Error("work_finished_elsewhere");
    await appendWorkEvent(db, {
      jobId: job.id,
      orgId: job.org_id,
      kind: "notice",
      stage: "completed",
      message: summary,
      data: { critical, warning, findings: findings.length },
    });
    // The report is the durable proactive card. It is written after the job is complete, and its
    // delivery policy is per supervisor. A review with no findings is recorded but not announced.
    await publishReviewReport(db, {
      job,
      agent,
      subject: spec.subject,
      findings,
      metrics,
      limitations: spec.limitations,
      checksRun: spec.checks.length,
    });
  });
}
