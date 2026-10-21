import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { notifyOrgRoles } from "@/server/notifications";
import {
  appendWorkEvent,
  finishWorkJob,
  recordWorkStage,
  type WorkJobRow,
} from "@/server/workforce/jobs";
import { roleMayUseCapability } from "@/lib/workforce-capabilities";
import type { AgentRoleKey } from "@/lib/agents";

/**
 * On-demand Operations Manager review.
 *
 * This is intentionally native and read-only: it reads persisted workspace records, produces
 * evidence-backed findings and recommended actions, and finishes the durable job. It never sends
 * messages, changes a record, creates an approval on the employee's behalf or starts an autonomous
 * schedule. A person can request it from the AI Work Board.
 */

type Severity = "critical" | "warning" | "info";

export interface ProactiveFinding {
  key: string;
  severity: Severity;
  title: string;
  detail: string;
  count: number;
  samples: string[];
  evidenceHref: string;
  recommendedAction: string;
  requiresApproval: boolean;
}

const num = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

function finding(input: Omit<ProactiveFinding, "samples"> & { samples?: string[] }): ProactiveFinding {
  return { ...input, samples: (input.samples ?? []).filter(Boolean).slice(0, 3) };
}

async function failedRuns(db: Queryable, orgId: string, sinceDays: number): Promise<ProactiveFinding | null> {
  const { rows } = await db.query<{ count: number; samples: string[] }>(
    `select count(*)::int as count,
            coalesce(array_agg(distinct r.purpose) filter (where r.purpose is not null), '{}') as samples
       from agent_runs r
      where r.org_id = $1 and r.status in ('failed', 'timeout', 'interrupted')
        and r.started_at >= now() - make_interval(days => $2)`,
    [orgId, sinceDays],
  );
  const count = num(rows[0]?.count);
  if (!count) return null;
  return finding({
    key: "failed_runs",
    severity: "warning",
    title: `${count} AI run${count === 1 ? "" : "s"} did not complete`,
    detail: "These runs stopped before producing a verified result. Review the recorded failure before retrying; a step may already have run.",
    count,
    samples: (rows[0]?.samples ?? []).map((purpose) => purpose.replaceAll("_", " ")),
    evidenceHref: "/activity",
    recommendedAction: "Open the recent runs, check the failure reason and retry only after the cause is understood.",
    requiresApproval: false,
  });
}

async function pendingApprovals(db: Queryable, orgId: string): Promise<ProactiveFinding | null> {
  const { rows } = await db.query<{ count: number; samples: string[] }>(
    `select count(*)::int as count, coalesce(array_agg(title order by created_at asc), '{}') as samples
       from approval_requests
      where org_id = $1 and status = 'pending' and created_at < now() - interval '24 hours'`,
    [orgId],
  );
  const count = num(rows[0]?.count);
  if (!count) return null;
  return finding({
    key: "pending_approvals",
    severity: "warning",
    title: `${count} approval${count === 1 ? "" : "s"} waiting over a day`,
    detail: "Customer-facing, CRM or high-impact work cannot continue until a person decides. The employee has not applied anything.",
    count,
    samples: rows[0]?.samples ?? [],
    evidenceHref: "/approvals",
    recommendedAction: "Review the proposed action and approve, reject or ask for changes.",
    requiresApproval: false,
  });
}

async function overdueTasks(db: Queryable, orgId: string): Promise<ProactiveFinding | null> {
  const { rows } = await db.query<{ count: number; samples: string[] }>(
    `select count(*)::int as count, coalesce(array_agg(title order by due_at asc), '{}') as samples
       from tasks
      where org_id = $1 and status = 'open' and due_at is not null and due_at < now()`,
    [orgId],
  );
  const count = num(rows[0]?.count);
  if (!count) return null;
  return finding({
    key: "overdue_tasks",
    severity: "warning",
    title: `${count} overdue task${count === 1 ? "" : "s"}`,
    detail: "Open tasks have passed their due time. This can block follow-up or a customer commitment.",
    count,
    samples: rows[0]?.samples ?? [],
    evidenceHref: "/crm/tasks",
    recommendedAction: "Reschedule, reassign or close each overdue task, starting with customer-facing work.",
    requiresApproval: false,
  });
}

async function leadsAwaitingReview(db: Queryable, orgId: string): Promise<ProactiveFinding | null> {
  const { rows } = await db.query<{ count: number; samples: string[] }>(
    `select count(*)::int as count, coalesce(array_agg(business_name order by created_at asc), '{}') as samples
       from leads
      where org_id = $1 and review_status = 'pending' and created_at < now() - interval '48 hours'`,
    [orgId],
  );
  const count = num(rows[0]?.count);
  if (!count) return null;
  return finding({
    key: "leads_awaiting_review",
    severity: "info",
    title: `${count} researched lead${count === 1 ? " is" : "s are"} waiting for review`,
    detail: "Research is complete but a person has not reviewed the candidate. Nothing has been imported or contacted.",
    count,
    samples: rows[0]?.samples ?? [],
    evidenceHref: "/leads?tab=review",
    recommendedAction: "Review the evidence and either approve, reject or request better evidence.",
    requiresApproval: false,
  });
}

async function workforceAttention(db: Queryable, orgId: string): Promise<ProactiveFinding | null> {
  const { rows } = await db.query<{ count: number; samples: string[] }>(
    `select count(*)::int as count, coalesce(array_agg(display_name || ' · ' || replace(status, '_', ' ')), '{}') as samples
       from agent_instances
      where org_id = $1 and enabled and status in ('error', 'offline', 'setup_required', 'provisioning')`,
    [orgId],
  );
  const count = num(rows[0]?.count);
  if (!count) return null;
  return finding({
    key: "workforce_attention",
    severity: "warning",
    title: `${count} AI employee${count === 1 ? " needs" : "s need"} attention`,
    detail: "An unavailable or unconfigured employee cannot perform authorized work. This is an availability state, not a job failure.",
    count,
    samples: rows[0]?.samples ?? [],
    evidenceHref: "/employees",
    recommendedAction: "Run the connection check or finish the employee's configuration before assigning work.",
    requiresApproval: false,
  });
}

async function integrationAttention(db: Queryable, orgId: string): Promise<ProactiveFinding | null> {
  const { rows } = await db.query<{ count: number; samples: string[] }>(
    `select count(*)::int as count, coalesce(array_agg(provider || ' · ' || replace(status, '_', ' ')), '{}') as samples
       from integration_status
      where org_id = $1 and status in ('error', 'degraded')`,
    [orgId],
  );
  const count = num(rows[0]?.count);
  if (!count) return null;
  return finding({
    key: "integration_attention",
    severity: "critical",
    title: `${count} integration${count === 1 ? " needs" : "s need"} attention`,
    detail: "A degraded connection can block work that depends on it. No external action was attempted.",
    count,
    samples: rows[0]?.samples ?? [],
    evidenceHref: "/settings/integrations",
    recommendedAction: "Inspect the connection status and recheck it before relying on it for customer work.",
    requiresApproval: false,
  });
}

async function stalledJobs(db: Queryable, orgId: string, sinceDays: number): Promise<ProactiveFinding | null> {
  const { rows } = await db.query<{ count: number; samples: string[] }>(
    `select count(*)::int as count, coalesce(array_agg(title order by created_at asc), '{}') as samples
       from ai_work_jobs
      where org_id = $1 and status in ('failed', 'blocked')
        and created_at >= now() - make_interval(days => $2)`,
    [orgId, sinceDays],
  );
  const count = num(rows[0]?.count);
  if (!count) return null;
  return finding({
    key: "stalled_jobs",
    severity: "warning",
    title: `${count} AI work item${count === 1 ? "" : "s"} failed or blocked`,
    detail: "The employee recorded a real failure or blocker. No success is being claimed for these items.",
    count,
    samples: rows[0]?.samples ?? [],
    evidenceHref: "/work?status=attention",
    recommendedAction: "Open the work board, read the recorded reason and retry only when it is safe.",
    requiresApproval: false,
  });
}

async function contactDataQuality(db: Queryable, orgId: string): Promise<ProactiveFinding | null> {
  const { rows } = await db.query<{ count: number; samples: string[] }>(
    `select count(*)::int as count, coalesce(array_agg(coalesce(nullif(display_name, ''), 'Unnamed contact') order by created_at asc), '{}') as samples
       from contacts
      where org_id = $1 and deleted_at is null and email is null and phone is null
        and created_at >= now() - interval '90 days'`,
    [orgId],
  );
  const count = num(rows[0]?.count);
  if (!count) return null;
  return finding({
    key: "contact_data_quality",
    severity: "info",
    title: `${count} recent contact${count === 1 ? " has" : "s have"} no email or phone`,
    detail: "These records can still be worked, but the missing detail may block follow-up. The cause is not inferred.",
    count,
    samples: rows[0]?.samples ?? [],
    evidenceHref: "/crm/contacts",
    recommendedAction: "Check the original source and add a verified contact detail, or mark the record as incomplete.",
    requiresApproval: false,
  });
}

export async function runProactiveReviewJob(job: WorkJobRow, _context: { workerId: string; controller: AbortController }): Promise<void> {
  const agent = await withSystem(async (db) => {
    const { rows } = await db.query<{ role_key: string; display_name: string }>(
      `select a.role_key, a.display_name from agent_instances a where a.id = $1 and a.org_id = $2`,
      [job.agent_instance_id, job.org_id],
    );
    return rows[0] ?? null;
  });
  if (!agent || !roleMayUseCapability(agent.role_key as AgentRoleKey, job.capability)) {
    await withSystem(async (db) => {
      await finishWorkJob(db, {
        jobId: job.id,
        orgId: job.org_id,
        status: "blocked",
        stage: "blocked",
        failureCode: "capability_not_allowed",
        failureMessage: "This employee's role is not allowed to perform an operations review.",
      });
      await appendWorkEvent(db, {
        jobId: job.id,
        orgId: job.org_id,
        kind: "error",
        stage: "blocked",
        message: "This employee's role is not allowed to perform an operations review, so nothing was read.",
      });
    });
    return;
  }

  const sinceDays = Math.max(1, Math.min(30, Number(job.input.sinceDays) || 7));
  await withSystem(async (db) => {
    await recordWorkStage(db, {
      jobId: job.id,
      orgId: job.org_id,
      stage: "scanning",
      message: "Reading persisted workspace records across work, approvals, CRM, integrations and the AI workforce…",
    });

    // Sequential on one trusted transaction: PGlite serialises a single connection, and this also
    // keeps a slow check from interleaving with the job's own stage writes.
    const findings: ProactiveFinding[] = [];
    for (const check of [
      () => failedRuns(db, job.org_id, sinceDays),
      () => pendingApprovals(db, job.org_id),
      () => overdueTasks(db, job.org_id),
      () => leadsAwaitingReview(db, job.org_id),
      () => workforceAttention(db, job.org_id),
      () => integrationAttention(db, job.org_id),
      () => stalledJobs(db, job.org_id, sinceDays),
      () => contactDataQuality(db, job.org_id),
    ]) {
      const result = await check();
      if (result) findings.push(result);
    }

    await recordWorkStage(db, {
      jobId: job.id,
      orgId: job.org_id,
      stage: "analyzing",
      message: "Assessing each signal, separating observed evidence from recommendations and preparing the review…",
      progress: {
        checksRun: 8,
        findings: findings.length,
        affectedItems: findings.reduce((total, item) => total + item.count, 0),
      },
    });

    for (const item of findings.slice(0, 8)) {
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
    const summary = findings.length
      ? `Operations review found ${findings.length} signal${findings.length === 1 ? "" : "s"} across ${findings.reduce((total, item) => total + item.count, 0)} affected item${findings.reduce((total, item) => total + item.count, 0) === 1 ? "" : "s"} (${critical} critical, ${warning} warning).`
      : "Operations review found no actionable signals in the persisted records checked.";

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
        sinceDays,
        checkedAt: new Date().toISOString(),
        checksRun: 8,
        findings,
        limitations: "Only records this workspace already stores were read. No external provider was contacted and no business record was changed.",
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
    if (findings.length) {
      await notifyOrgRoles(db, job.org_id, ["owner", "admin"], {
        kind: "agent_task_completed",
        severity: critical ? "critical" : "warning",
        title: `${agent.display_name} found ${findings.length} signal${findings.length === 1 ? "" : "s"} that need attention`,
        body: summary,
        link: `/work?job=${job.id}`,
        dedupeKey: `proactive-review:${job.id}`,
      });
    }
  });
}
