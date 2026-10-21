import "server-only";
import { createHash } from "node:crypto";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { systemActor } from "@/server/crm/actor";
import { createTaskInTx } from "@/server/crm/tasks";
import { notifyUser } from "@/server/notifications";
import type { WorkJobRow } from "@/server/workforce/jobs";
import type { ReviewFinding, ReviewMetric } from "@/server/workforce/read-only-review";
import type { OrgContext } from "@/server/tenancy/context";
import type { AgentRoleKey } from "@/lib/agents";
import {
  highestSeverity,
  localDateKey,
  localHour,
  localWeekday,
  parseProactivePrefs,
  proactiveDeliveryDecision,
  proactiveQuietNow,
  severityAtLeast,
  type ProactiveReportKind,
  type ProactiveSeverity,
} from "@/lib/proactive";

/**
 * Persisted proactive reports and their delivery policy.
 *
 * Nothing in this module invents work. A report is published only after a reviewed capability has
 * finished and recorded real findings. Delivery then applies the recipient's own severity threshold,
 * quiet hours and digest preference through the existing notifications table. A critical report
 * always bypasses those filters, and every suppressed or deferred alert records the reason.
 *
 * The only business action this module can take is creating an ordinary internal follow-up task,
 * and only when an owner explicitly opted in to that safe action and the report is critical.
 */

export interface ProactiveFinding extends ReviewFinding {
  /** A stable key within the report, used by the "Create follow-up task" action. */
  key: string;
}

export interface ProactiveSection {
  key: string;
  title: string;
  body?: string;
  items?: string[];
}

export interface ProactiveEvidence {
  label: string;
  href?: string;
}

export interface ProactiveActionView {
  type: "task_created" | "acknowledged";
  taskId?: string;
  title?: string;
  at: string;
  authorization?: string;
}

export interface ProactiveReportView {
  id: string;
  kind: ProactiveReportKind;
  severity: ProactiveSeverity;
  title: string;
  summary: string;
  sections: ProactiveSection[];
  findings: ProactiveFinding[];
  evidence: ProactiveEvidence[];
  metrics: ReviewMetric[];
  actions: ProactiveActionView[];
  data: Record<string, unknown>;
  employeeName: string;
  employeeRole: AgentRoleKey | null;
  capability: string | null;
  jobId: string | null;
  jobStatus: string | null;
  status: "open" | "acknowledged" | "resolved";
  deliveryStatus: "pending" | "delivered" | "held" | "digest" | "suppressed" | null;
  deliveryReason: string | null;
  canCreateTask: boolean;
  createdAt: string;
  acknowledgedAt: string | null;
}

export interface MonitoringStatus {
  state: "active" | "paused" | "not_configured";
  schedulesEnabled: number;
  triggersEnabled: number;
  schedulesOperatorEnabled: boolean;
  triggersOperatorEnabled: boolean;
  briefingsOperatorEnabled: boolean;
  lastVerifiedReportAt: string | null;
  byRole: Array<{ role: AgentRoleKey; schedules: number; triggers: number; enabled: number }>;
}

export function proactiveBriefingsEnabled(): boolean {
  return process.env.WORKFORCE_BRIEFINGS_ENABLED === "true";
}

/** Read the deployment switches directly to keep this module free of a runner import cycle. */
function schedulesSwitchOn(): boolean {
  return process.env.WORKFORCE_SCHEDULES_ENABLED === "true";
}

function triggersSwitchOn(): boolean {
  return process.env.WORKFORCE_TRIGGERS_ENABLED === "true";
}

const iso = (value: Date | null | undefined) => (value ? new Date(value).toISOString() : null);
const num = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 8) : [];
}

function asSections(value: unknown): ProactiveSection[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item))
    .map((item) => ({
      key: typeof item.key === "string" ? item.key : "section",
      title: typeof item.title === "string" ? item.title : "Report",
      body: typeof item.body === "string" ? item.body : undefined,
      items: asStringArray(item.items),
    }))
    .slice(0, 12);
}

function asFindings(value: unknown): ProactiveFinding[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item))
    .filter((item) => typeof item.key === "string" && typeof item.title === "string" && typeof item.severity === "string")
    .map((item) => ({
      key: String(item.key),
      severity: (["info", "warning", "critical"].includes(String(item.severity)) ? String(item.severity) : "info") as ProactiveSeverity,
      title: String(item.title),
      detail: typeof item.detail === "string" ? item.detail : "",
      count: num(item.count),
      samples: asStringArray(item.samples),
      evidenceHref: typeof item.evidenceHref === "string" && item.evidenceHref.startsWith("/") ? item.evidenceHref : "/work",
      recommendedAction: typeof item.recommendedAction === "string" ? item.recommendedAction : "",
      requiresApproval: item.requiresApproval === true,
    }))
    .slice(0, 20);
}

function asMetrics(value: unknown): ReviewMetric[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is ReviewMetric => typeof item === "object" && item !== null && "key" in item && "label" in item).slice(0, 20);
}

function asEvidence(value: unknown): ProactiveEvidence[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item))
    .map((item) => ({
      label: typeof item.label === "string" ? item.label : "Evidence",
      href: typeof item.href === "string" && item.href.startsWith("/") ? item.href : undefined,
    }))
    .slice(0, 12);
}

function asActions(value: unknown): ProactiveActionView[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item))
    .map((item) => ({
      type: item.type === "task_created" ? "task_created" as const : "acknowledged" as const,
      taskId: typeof item.taskId === "string" ? item.taskId : undefined,
      title: typeof item.title === "string" ? item.title : undefined,
      at: typeof item.at === "string" ? item.at : new Date().toISOString(),
      authorization: typeof item.authorization === "string" ? item.authorization : undefined,
    }))
    .slice(0, 8);
}

interface Recipient {
  id: string;
  timezone: string | null;
  prefs: Record<string, unknown> | null;
}

async function orgTimezone(db: Queryable, orgId: string): Promise<string> {
  const { rows } = await db.query<{ timezone: string | null }>("select timezone from organizations where id = $1", [orgId]);
  return rows[0]?.timezone || "UTC";
}

async function supervisors(db: Queryable, orgId: string): Promise<Recipient[]> {
  const { rows } = await db.query<Recipient>(
    `select u.id, u.timezone, p.prefs
       from organization_memberships m
       join users u on u.id = m.user_id and u.status = 'active'
       left join notification_preferences p on p.user_id = u.id and p.org_id = m.org_id
      where m.org_id = $1 and m.status = 'active' and m.role in ('owner', 'admin')
      order by case m.role when 'owner' then 0 else 1 end, m.created_at asc`,
    [orgId],
  );
  return rows;
}

function reportLink(jobId: string | null, reportId: string): string {
  return jobId ? `/work?job=${jobId}&report=${reportId}` : `/work?report=${reportId}`;
}

/** Notifications cap dedupe_key at 160 characters; a stable hash keeps the day and finding identity distinct. */
function notificationDedupeKey(alertKey: string): string {
  return `proactive:${createHash("sha256").update(alertKey).digest("hex").slice(0, 48)}`;
}

function alertTitle(agentName: string, subject: string, findings: ProactiveFinding[]): string {
  const count = findings.length;
  if (!count) return `${agentName} completed a ${subject.toLowerCase()} review`;
  const critical = findings.some((item) => item.severity === "critical");
  const qualifier = subject.toLowerCase() === "operations" ? "" : ` ${subject.toLowerCase()}`;
  return critical
    ? `${agentName} found ${count} urgent${qualifier} signal${count === 1 ? "" : "s"}`
    : `${agentName} found ${count}${qualifier} signal${count === 1 ? "" : "s"} that need attention`;
}

function sectionsFor(input: {
  subject: string;
  summary: string;
  findings: ProactiveFinding[];
  metrics: ReviewMetric[];
  limitations: string;
  agentName: string;
}): ProactiveSection[] {
  const affected = input.findings.reduce((total, item) => total + item.count, 0);
  const approvals = input.findings.filter((item) => item.requiresApproval);
  const next = input.findings.map((item) => item.recommendedAction).filter(Boolean).slice(0, 5);
  return [
    { key: "what_happened", title: "What happened", body: input.summary },
    {
      key: "why_it_matters",
      title: "Why it matters",
      body: input.findings.length
        ? `${input.findings.length} distinct signal${input.findings.length === 1 ? " affects" : "s affect"} ${affected} persisted item${affected === 1 ? "" : "s"}. A person still decides any customer-facing or high-impact change.`
        : `No actionable ${input.subject.toLowerCase()} signal crossed a stated review check. This is a completed check, not a promise that every record is correct.`,
    },
    { key: "verified", title: "What I verified", body: input.limitations },
    {
      key: "action_taken",
      title: "What action I took",
      body: input.findings.length
        ? "I recorded this report with the counts, examples and links below. I did not change a customer record, contact a provider or approve anything on your behalf."
        : "I completed the review and recorded the checks that ran. Nothing needed a business-record change.",
    },
    {
      key: "still_blocked",
      title: "What remains blocked or incomplete",
      body: input.findings.length
        ? "The items below are still in their recorded state until a person or an explicitly authorized follow-up changes them."
        : "Nothing is blocked by this review.",
    },
    { key: "next", title: "What should happen next", items: next.length ? next : ["No follow-up action is required from this review."] },
    {
      key: "approval",
      title: "Does the owner need to approve anything?",
      body: approvals.length
        ? `${approvals.length} finding${approvals.length === 1 ? " is" : "s are"} marked as needing a person's approval before any sensitive change. Open the linked evidence to decide.`
        : "No new approval request was created by this report. Any external or customer-facing action still requires the normal Approval Center decision.",
    },
  ];
}

async function insertReport(
  db: Queryable,
  input: {
    orgId: string;
    agentId: string | null;
    jobId: string | null;
    capability: string | null;
    kind: ProactiveReportKind;
    severity: ProactiveSeverity;
    title: string;
    summary: string;
    sections: ProactiveSection[];
    findings: ProactiveFinding[];
    evidence: ProactiveEvidence[];
    data: Record<string, unknown>;
    dedupeKey: string;
    alertKey: string;
  },
): Promise<{ id: string; created: boolean }> {
  const { rows } = await db.query<{ id: string }>(
    `insert into ai_work_reports
       (org_id, agent_instance_id, job_id, capability, kind, severity, title, summary, sections, findings, evidence, data, dedupe_key, alert_key)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13, $14)
     on conflict (dedupe_key) do nothing
     returning id`,
    [
      input.orgId, input.agentId, input.jobId, input.capability, input.kind, input.severity,
      input.title.slice(0, 200), input.summary.slice(0, 2000), JSON.stringify(input.sections.slice(0, 12)),
      JSON.stringify(input.findings.slice(0, 20)), JSON.stringify(input.evidence.slice(0, 12)), JSON.stringify(input.data),
      input.dedupeKey.slice(0, 240), input.alertKey.slice(0, 240),
    ],
  );
  if (rows[0]) return { id: rows[0].id, created: true };
  const existing = await db.query<{ id: string }>("select id from ai_work_reports where dedupe_key = $1", [input.dedupeKey]);
  if (!existing.rows[0]) throw new AppError("conflict", "The proactive report could not be recorded.");
  return { id: existing.rows[0].id, created: false };
}

interface DeliveryReport {
  id: string;
  orgId: string;
  jobId: string | null;
  title: string;
  summary: string;
  severity: ProactiveSeverity;
  alertKey: string;
  dedupeKey: string;
  hasFindings: boolean;
}

async function recordDelivery(
  db: Queryable,
  recipient: Recipient,
  report: DeliveryReport,
  options: { now: Date; orgZone: string; notifyEligible: boolean },
): Promise<"delivered" | "held" | "digest" | "suppressed"> {
  const inserted = await db.query<{ id: string }>(
    `insert into ai_work_report_deliveries (report_id, org_id, user_id, status)
     values ($1, $2, $3, 'pending') on conflict (report_id, user_id) do nothing returning id`,
    [report.id, report.orgId, recipient.id],
  );
  let currentStatus: string | null = null;
  if (!inserted.rows[0]) {
    const existing = await db.query<{ status: string }>(
      "select status from ai_work_report_deliveries where report_id = $1 and user_id = $2",
      [report.id, recipient.id],
    );
    currentStatus = existing.rows[0]?.status ?? null;
    if (currentStatus === "delivered") return "delivered";
  }

  const timeZone = recipient.timezone || options.orgZone;
  const prefs = parseProactivePrefs(recipient.prefs);
  if (!options.notifyEligible || !report.hasFindings) {
    await db.query(
      `update ai_work_report_deliveries set status = 'suppressed', reason = 'no_actionable_findings', updated_at = now()
        where report_id = $1 and user_id = $2`,
      [report.id, recipient.id],
    );
    return "suppressed";
  }
  const decision = proactiveDeliveryDecision({ prefs, severity: report.severity, now: options.now, timeZone });
  if (decision.action === "suppress") {
    await db.query(
      `update ai_work_report_deliveries set status = 'suppressed', reason = $3, updated_at = now()
        where report_id = $1 and user_id = $2`,
      [report.id, recipient.id, decision.reason],
    );
    return "suppressed";
  }
  if (decision.action === "hold") {
    await db.query(
      `update ai_work_report_deliveries set status = 'held', reason = $3, updated_at = now()
        where report_id = $1 and user_id = $2`,
      [report.id, recipient.id, decision.reason],
    );
    return "held";
  }
  if (decision.action === "digest") {
    await db.query(
      `update ai_work_report_deliveries set status = 'digest', reason = $3, updated_at = now()
        where report_id = $1 and user_id = $2`,
      [report.id, recipient.id, decision.reason],
    );
    return "digest";
  }

  const notificationId = await notifyUser(db, recipient.id, report.orgId, {
    kind: "agent_task_completed",
    severity: report.severity,
    title: report.title,
    body: report.summary,
    link: reportLink(report.jobId, report.id),
    dedupeKey: notificationDedupeKey(report.alertKey),
  });
  if (!notificationId) {
    await db.query(
      `update ai_work_report_deliveries set status = 'suppressed', reason = 'duplicate_alert', updated_at = now()
        where report_id = $1 and user_id = $2`,
      [report.id, recipient.id],
    );
    return "suppressed";
  }
  await db.query(
    `update ai_work_report_deliveries
        set status = 'delivered', reason = null, notification_id = $3, delivered_at = $4, updated_at = now()
      where report_id = $1 and user_id = $2`,
    [report.id, recipient.id, notificationId, options.now.toISOString()],
  );
  return "delivered";
}

async function maybeCreateAuthorizedTask(
  db: Queryable,
  input: {
    orgId: string;
    reportId: string;
    severity: ProactiveSeverity;
    findings: ProactiveFinding[];
    recipients: Recipient[];
    subject: string;
    agentName: string;
  },
): Promise<ProactiveActionView | null> {
  if (input.severity !== "critical" || !input.findings.length) return null;
  const authorized = input.recipients.find((recipient) => parseProactivePrefs(recipient.prefs).autoCreateTasks);
  if (!authorized) return null;

  const existing = await db.query<{ id: string }>(
    "select id from tasks where org_id = $1 and related_type = 'ai_work_report' and related_id = $2 limit 1",
    [input.orgId, input.reportId],
  );
  if (existing.rows[0]) return null;

  const lead = input.findings[0];
  const title = `Review follow-up: ${lead.title}`.replace(/\s+/g, " ").slice(0, 200);
  const description = [
    `${input.agentName} found ${input.findings.length} signal${input.findings.length === 1 ? "" : "s"} in the ${input.subject.toLowerCase()} review.`,
    ...input.findings.slice(0, 3).map((item) => `- ${item.title}${item.recommendedAction ? `: ${item.recommendedAction}` : ""}`),
    `Open the report: /work?report=${input.reportId}`,
    "This task was created because the workspace owner explicitly enabled follow-up task creation for critical proactive reports. No customer record was changed.",
  ].join("\n").slice(0, 2000);

  const task = await createTaskInTx(
    db,
    systemActor({ id: input.orgId }),
    { title, description, priority: "urgent", assigneeId: authorized.id },
    { source: "agent" },
  );
  await db.query(
    "update tasks set related_type = 'ai_work_report', related_id = $2 where id = $1 and org_id = $3",
    [task.id, input.reportId, input.orgId],
  );
  const action: ProactiveActionView = {
    type: "task_created",
    taskId: task.id,
    title,
    at: new Date().toISOString(),
    authorization: "owner_proactive_preference",
  };
  await db.query("update ai_work_reports set actions = actions || $2::jsonb where id = $1 and org_id = $3", [
    input.reportId,
    JSON.stringify([action]),
    input.orgId,
  ]);
  await recordAudit({
    orgId: input.orgId,
    actorUserId: null,
    actorKind: "system",
    action: "workforce.proactive_task_created",
    targetType: "task",
    targetId: task.id,
    result: "success",
    metadata: { reportId: input.reportId, authorization: "owner_proactive_preference", severity: input.severity },
  }, db);
  return action;
}

async function deliverReport(
  db: Queryable,
  report: DeliveryReport,
  recipients: Recipient[],
  options: { now: Date; orgZone: string; notifyEligible: boolean },
): Promise<Record<string, number>> {
  const counts = { delivered: 0, held: 0, digest: 0, suppressed: 0 };
  for (const recipient of recipients) {
    const outcome = await recordDelivery(db, recipient, report, options);
    counts[outcome] += 1;
  }
  return counts;
}

/** Publishes one review report and applies each supervisor's notification preferences. */
export async function publishReviewReport(
  db: Queryable,
  input: {
    job: WorkJobRow;
    agent: { display_name: string; role_key: string };
    subject: string;
    findings: ProactiveFinding[];
    metrics: ReviewMetric[];
    limitations: string;
    checksRun: number;
    now?: Date;
  },
): Promise<{ reportId: string; created: boolean }> {
  const now = input.now ?? new Date();
  const zone = await orgTimezone(db, input.job.org_id);
  const severity = highestSeverity(input.findings.map((item) => item.severity));
  const kind: ProactiveReportKind = !input.findings.length
    ? "completion"
    : input.findings.some((item) => item.severity === "critical")
      ? "alert"
      : input.findings.some((item) => item.severity === "warning")
        ? "alert"
        : "recommendation";
  const title = alertTitle(input.agent.display_name, input.subject, input.findings);
  const affected = input.findings.reduce((total, item) => total + num(item.count), 0);
  const summary = input.findings.length
    ? `${input.findings.length} signal${input.findings.length === 1 ? "" : "s"} across ${affected} affected item${affected === 1 ? "" : "s"} (${input.findings.filter((item) => item.severity === "critical").length} urgent, ${input.findings.filter((item) => item.severity === "warning").length} needing attention).`
    : `Completed ${input.checksRun} ${input.subject.toLowerCase()} check${input.checksRun === 1 ? "" : "s"}; no actionable signal was recorded.`;
  const findingKeys = input.findings.map((item) => item.key).sort().join(",");
  const alertKey = `${input.job.capability}:${findingKeys || "no_findings"}:${localDateKey(now, zone)}`;
  const evidence: ProactiveEvidence[] = input.findings.map((item) => ({ label: item.title, href: item.evidenceHref }));

  const report = await insertReport(db, {
    orgId: input.job.org_id,
    agentId: input.job.agent_instance_id,
    jobId: input.job.id,
    capability: input.job.capability,
    kind,
    severity,
    title,
    summary,
    sections: sectionsFor({
      subject: input.subject,
      summary,
      findings: input.findings,
      metrics: input.metrics,
      limitations: input.limitations,
      agentName: input.agent.display_name,
    }),
    findings: input.findings,
    evidence,
    data: {
      subject: input.subject,
      checksRun: input.checksRun,
      limitations: input.limitations,
      metrics: input.metrics,
      affectedItems: affected,
      verifiedAt: now.toISOString(),
    },
    dedupeKey: `job:${input.job.id}`,
    alertKey,
  });
  if (!report.created) return { reportId: report.id, created: false };

  const recipients = await supervisors(db, input.job.org_id);
  await deliverReport(db, {
    id: report.id,
    orgId: input.job.org_id,
    jobId: input.job.id,
    title,
    summary,
    severity,
    alertKey,
    dedupeKey: `job:${input.job.id}`,
    hasFindings: input.findings.length > 0,
  }, recipients, { now, orgZone: zone, notifyEligible: input.findings.length > 0 });

  await maybeCreateAuthorizedTask(db, {
    orgId: input.job.org_id,
    reportId: report.id,
    severity,
    findings: input.findings,
    recipients,
    subject: input.subject,
    agentName: input.agent.display_name,
  });

  return { reportId: report.id, created: true };
}

/**
 * Releases non-critical reports that were held only because they arrived during quiet hours.
 * The policy is re-evaluated for the current time; a person who lowered a threshold or turned the
 * group back on also gets the pending item. Safe to run repeatedly.
 */
export async function releaseHeldProactiveReports(now = new Date()): Promise<{ delivered: number; stillHeld: number; suppressed: number }> {
  return withSystem(async (db) => {
    const { rows } = await db.query<{
      report_id: string; org_id: string; user_id: string; title: string; summary: string; severity: ProactiveSeverity;
      job_id: string | null; alert_key: string; timezone: string | null; prefs: Record<string, unknown> | null; org_timezone: string | null;
    }>(
      `select d.report_id, d.org_id, d.user_id, r.title, r.summary, r.severity, r.job_id, r.alert_key,
              u.timezone, p.prefs, o.timezone as org_timezone
         from ai_work_report_deliveries d
         join ai_work_reports r on r.id = d.report_id and r.org_id = d.org_id
         join users u on u.id = d.user_id and u.status = 'active'
         join organizations o on o.id = d.org_id
         left join notification_preferences p on p.user_id = d.user_id and p.org_id = d.org_id
        where d.status = 'held'
        order by d.created_at asc
        limit 100`,
    );
    let delivered = 0;
    let stillHeld = 0;
    let suppressed = 0;
    for (const row of rows) {
      const timeZone = row.timezone || row.org_timezone || "UTC";
      const prefs = parseProactivePrefs(row.prefs);
      const decision = proactiveDeliveryDecision({ prefs, severity: row.severity, now, timeZone });
      if (decision.action === "hold") {
        stillHeld += 1;
        continue;
      }
      if (decision.action === "suppress" || decision.action === "digest") {
        await db.query(
          "update ai_work_report_deliveries set status = $3, reason = $4, updated_at = now() where report_id = $1 and user_id = $2",
          [row.report_id, row.user_id, decision.action === "digest" ? "digest" : "suppressed", decision.reason],
        );
        suppressed += 1;
        continue;
      }
      const notificationId = await notifyUser(db, row.user_id, row.org_id, {
        kind: "agent_task_completed",
        severity: row.severity,
        title: row.title,
        body: row.summary,
        link: reportLink(row.job_id, row.report_id),
        dedupeKey: notificationDedupeKey(row.alert_key),
      });
      await db.query(
        `update ai_work_report_deliveries
            set status = $3, reason = $4, notification_id = $5, delivered_at = case when $3 = 'delivered' then $6 else delivered_at end, updated_at = now()
          where report_id = $1 and user_id = $2`,
        [row.report_id, row.user_id, notificationId ? "delivered" : "suppressed", notificationId ? null : "duplicate_alert", notificationId, now.toISOString()],
      );
      if (notificationId) delivered += 1;
      else suppressed += 1;
    }
    return { delivered, stillHeld, suppressed };
  });
}

async function briefingCounts(db: Queryable, orgId: string, since: Date): Promise<{
  approvals: number; failedJobs: number; overdueTasks: number; pendingLeads: number;
}> {
  const { rows } = await db.query<{ approvals: number; failed_jobs: number; overdue_tasks: number; pending_leads: number }>(
    `select
       (select count(*)::int from approval_requests where org_id = $1 and status = 'pending' and (expires_at is null or expires_at > now())) as approvals,
       (select count(*)::int from ai_work_jobs where org_id = $1 and status in ('failed', 'blocked') and created_at >= $2) as failed_jobs,
       (select count(*)::int from tasks where org_id = $1 and status = 'open' and due_at is not null and due_at < now()) as overdue_tasks,
       (select count(*)::int from leads where org_id = $1 and review_status = 'pending') as pending_leads`,
    [orgId, since.toISOString()],
  );
  const row = rows[0];
  return {
    approvals: num(row?.approvals),
    failedJobs: num(row?.failed_jobs),
    overdueTasks: num(row?.overdue_tasks),
    pendingLeads: num(row?.pending_leads),
  };
}

async function composeBriefing(
  db: Queryable,
  input: { orgId: string; userId: string; now: Date; kind: "daily_briefing" | "weekly_summary" },
): Promise<{
  title: string;
  summary: string;
  sections: ProactiveSection[];
  severity: ProactiveSeverity;
  hasContent: boolean;
  counts: Record<string, number>;
  reports: number;
  metrics: ReviewMetric[];
} | null> {
  const hours = input.kind === "daily_briefing" ? 24 : 168;
  const since = new Date(input.now.getTime() - hours * 3_600_000);
  const [reportsResult, counts, orgRow] = await Promise.all([
    db.query<{ id: string; kind: string; severity: ProactiveSeverity; title: string; summary: string; created_at: Date; employee_name: string | null }>(
      `select r.id, r.kind, r.severity, r.title, r.summary, r.created_at, a.display_name as employee_name
         from ai_work_reports r
         left join agent_instances a on a.id = r.agent_instance_id and a.org_id = r.org_id
        where r.org_id = $1 and r.created_at >= $2
          and r.kind not in ('daily_briefing', 'weekly_summary')
        order by r.created_at desc limit 30`,
      [input.orgId, since.toISOString()],
    ),
    briefingCounts(db, input.orgId, since),
    db.query<{ timezone: string | null }>("select timezone from organizations where id = $1", [input.orgId]),
  ]);
  const reports = reportsResult.rows;
  let performanceMetrics: ReviewMetric[] = [];
  if (input.kind === "weekly_summary") {
    const performance = await db.query<{ result: { metrics?: unknown } | null }>(
      `select result from ai_work_jobs
        where org_id = $1 and capability = 'performance_snapshot' and status = 'completed' and finished_at >= $2
        order by finished_at desc limit 1`,
      [input.orgId, since.toISOString()],
    );
    performanceMetrics = asMetrics(performance.rows[0]?.result?.metrics);
  }
  const hasContent = reports.length > 0 || counts.approvals > 0 || counts.failedJobs > 0 || counts.overdueTasks > 0 || counts.pendingLeads > 0 || performanceMetrics.length > 0;
  if (!hasContent) return null;

  const severity = highestSeverity([
    ...reports.map((report) => report.severity),
    counts.approvals > 0 ? "warning" : "info",
    counts.failedJobs > 0 ? "warning" : "info",
  ]);
  const title = input.kind === "daily_briefing" ? "Your daily AI workforce briefing" : "Your weekly AI workforce summary";
  const metricNote = performanceMetrics.length ? ` It includes ${performanceMetrics.length} measured performance value${performanceMetrics.length === 1 ? "" : "s"} from the latest completed Performance snapshot.` : "";
  const summary = `${reports.length} proactive report${reports.length === 1 ? "" : "s"}, ${counts.approvals} approval${counts.approvals === 1 ? "" : "s"} waiting, ${counts.failedJobs} failed or blocked job${counts.failedJobs === 1 ? "" : "s"}, ${counts.overdueTasks} overdue task${counts.overdueTasks === 1 ? "" : "s"} and ${counts.pendingLeads} lead${counts.pendingLeads === 1 ? "" : "s"} awaiting review in the last ${hours === 24 ? "24 hours" : "7 days"}.${metricNote}`;
  const sections: ProactiveSection[] = [
    {
      key: "what_happened",
      title: "What happened",
      body: reports.length
        ? reports.slice(0, 6).map((report) => `${report.employee_name ?? "AI workforce"}: ${report.title}`).join("\n")
        : "No proactive review produced a report in this period.",
      items: reports.slice(0, 6).map((report) => report.title),
    },
    ...(performanceMetrics.length ? [{
      key: "measured_performance",
      title: "Measured performance",
      body: "These values come from the latest completed Performance snapshot. They are measurements, not targets.",
      items: performanceMetrics.slice(0, 8).map((metric) => `${metric.label}: ${metric.value}${metric.unit ? ` ${metric.unit}` : ""} (${metric.period})`),
    }] : []),
    { key: "why_it_matters", title: "Why it matters", body: "These are persisted workspace records and completed AI checks, not estimates. They gather the work that needs a person's attention into one place." },
    {
      key: "verified",
      title: "What I verified",
      body: `Counts were read from this workspace at ${input.now.toISOString()} in ${orgRow.rows[0]?.timezone || "UTC"}. Each underlying report links to the records it checked.`,
    },
    { key: "action_taken", title: "What action I took", body: "I generated this briefing from existing reports. No business record was changed and no external action was taken." },
    { key: "still_blocked", title: "What remains blocked or incomplete", body: counts.failedJobs || counts.overdueTasks ? `${counts.failedJobs} failed or blocked AI job${counts.failedJobs === 1 ? "" : "s"} and ${counts.overdueTasks} overdue task${counts.overdueTasks === 1 ? "" : "s"} are still recorded in that state.` : "No failed AI job or overdue task was recorded in this period." },
    {
      key: "next",
      title: "What should happen next",
      items: [
        counts.approvals ? `Review ${counts.approvals} pending approval${counts.approvals === 1 ? "" : "s"} in the Approval Center.` : null,
        counts.pendingLeads ? `Review ${counts.pendingLeads} researched lead${counts.pendingLeads === 1 ? "" : "s"}.` : null,
        counts.failedJobs ? "Open the AI Work Board and read the recorded failure reason before retrying." : null,
        reports.length ? "Open the reports below for evidence and recommended next actions." : "No further action is indicated by this briefing.",
      ].filter((item): item is string => Boolean(item)),
    },
    { key: "approval", title: "Does the owner need to approve anything?", body: counts.approvals ? `${counts.approvals} approval${counts.approvals === 1 ? " is" : "s are"} already waiting. This briefing does not approve or create one.` : "No approval is waiting. Any sensitive action still requires a decision in the Approval Center." },
  ];
  return { title, summary, sections, severity, hasContent, counts: { ...counts, reports: reports.length, metrics: performanceMetrics.length }, reports: reports.length, metrics: performanceMetrics };
}

/**
 * Produces opt-in daily briefings and weekly summaries after the configured local hour. The slot
 * is keyed per person and local date, so overlapping ticks cannot duplicate one. This job is gated by
 * WORKFORCE_BRIEFINGS_ENABLED and is off by default.
 */
export async function runProactiveBriefings(now = new Date()): Promise<{
  operatorEnabled: boolean;
  generated: number;
  suppressed: number;
  held: number;
  failed: number;
}> {
  if (!proactiveBriefingsEnabled()) return { operatorEnabled: false, generated: 0, suppressed: 0, held: 0, failed: 0 };
  const result = { operatorEnabled: true, generated: 0, suppressed: 0, held: 0, failed: 0 };
  const { rows } = await withSystem((db) =>
    db.query<{ org_id: string; user_id: string; timezone: string | null; prefs: Record<string, unknown> | null; org_timezone: string | null }>(
      `select m.org_id, u.id as user_id, u.timezone, p.prefs, o.timezone as org_timezone
         from organization_memberships m
         join users u on u.id = m.user_id and u.status = 'active'
         join organizations o on o.id = m.org_id
         left join notification_preferences p on p.user_id = m.user_id and p.org_id = m.org_id
        where m.status = 'active' and m.role in ('owner', 'admin')
        order by m.org_id, u.id
        limit 100`,
    ),
  );
  for (const row of rows) {
    const prefs = parseProactivePrefs(row.prefs);
    if (!prefs.dailyBriefing && !prefs.weeklySummary) continue;
    const timeZone = row.timezone || row.org_timezone || "UTC";
    if (localHour(now, timeZone) < prefs.briefingHour) continue;
    const dateKey = localDateKey(now, timeZone);
    const due: Array<"daily_briefing" | "weekly_summary"> = [];
    if (prefs.dailyBriefing) due.push("daily_briefing");
    if (prefs.weeklySummary && localWeekday(now, timeZone) === 1) due.push("weekly_summary");
    for (const kind of due) {
      const dedupeKey = `${kind}:${row.user_id}:${dateKey}`;
      const existing = await withSystem((db) => db.query<{ id: string }>("select id from ai_work_reports where dedupe_key = $1", [dedupeKey]));
      if (existing.rows[0]) continue;
      try {
        const briefing = await withSystem((db) => composeBriefing(db, { orgId: row.org_id, userId: row.user_id, now, kind }));
        if (!briefing) {
          result.suppressed += 1;
          continue;
        }
        const created = await withSystem(async (db) => {
          const report = await insertReport(db, {
            orgId: row.org_id,
            agentId: null,
            jobId: null,
            capability: null,
            kind,
            severity: briefing.severity,
            title: briefing.title,
            summary: briefing.summary,
            sections: briefing.sections,
            findings: [],
            evidence: [],
            data: { ...briefing.counts, metrics: briefing.metrics, periodHours: kind === "daily_briefing" ? 24 : 168, generatedFor: row.user_id },
            dedupeKey,
            alertKey: dedupeKey,
          });
          if (!report.created) return { reportId: report.id, delivery: "suppressed" as const };
          const delivery = parseProactivePrefs(row.prefs);
          if (!delivery.enabled) {
            await db.query(
              "insert into ai_work_report_deliveries (report_id, org_id, user_id, status, reason) values ($1, $2, $3, 'suppressed', 'proactive_notifications_off') on conflict (report_id, user_id) do nothing",
              [report.id, row.org_id, row.user_id],
            );
            return { reportId: report.id, delivery: "suppressed" as const };
          }
          if (proactiveQuietNow(delivery, now, timeZone) && briefing.severity !== "critical") {
            await db.query(
              "insert into ai_work_report_deliveries (report_id, org_id, user_id, status, reason) values ($1, $2, $3, 'held', 'quiet_hours') on conflict (report_id, user_id) do nothing",
              [report.id, row.org_id, row.user_id],
            );
            return { reportId: report.id, delivery: "held" as const };
          }
          const notificationId = await notifyUser(db, row.user_id, row.org_id, {
            kind: "agent_task_completed",
            severity: briefing.severity,
            title: briefing.title,
            body: briefing.summary,
            link: `/work?report=${report.id}`,
            dedupeKey: notificationDedupeKey(dedupeKey),
          });
          await db.query(
            `insert into ai_work_report_deliveries (report_id, org_id, user_id, status, reason, notification_id, delivered_at)
             values ($1, $2, $3, $4, $5, $6, $7)
             on conflict (report_id, user_id) do nothing`,
            [report.id, row.org_id, row.user_id, notificationId ? "delivered" : "suppressed", notificationId ? null : "duplicate_alert", notificationId, now.toISOString()],
          );
          return { reportId: report.id, delivery: notificationId ? "delivered" as const : "suppressed" as const };
        });
        if (created.delivery === "delivered") result.generated += 1;
        else if (created.delivery === "held") result.held += 1;
        else result.suppressed += 1;
      } catch {
        result.failed += 1;
      }
    }
  }
  return result;
}

/** Reports visible to a supervisor with activity.view, with the current person's delivery state. */
export async function listProactiveReports(
  ctx: OrgContext,
  options: { limit?: number; role?: AgentRoleKey; includeBriefings?: boolean } = {},
): Promise<ProactiveReportView[]> {
  if (!ctx.can("activity.view")) return [];
  const limit = Math.min(50, Math.max(1, options.limit ?? 20));
  const includeBriefings = options.includeBriefings !== false;
  return withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<{
      id: string; kind: ProactiveReportKind; severity: ProactiveSeverity; title: string; summary: string;
      sections: unknown; findings: unknown; evidence: unknown; data: Record<string, unknown>; actions: unknown;
      capability: string | null; job_id: string | null; status: "open" | "acknowledged" | "resolved";
      acknowledged_at: Date | null; created_at: Date; employee_name: string | null; employee_role: AgentRoleKey | null;
      job_status: string | null; delivery_status: ProactiveReportView["deliveryStatus"]; delivery_reason: string | null;
    }>(
      `select r.id, r.kind, r.severity, r.title, r.summary, r.sections, r.findings, r.evidence, r.data, r.actions,
              r.capability, r.job_id, r.status, r.acknowledged_at, r.created_at,
              a.display_name as employee_name, a.role_key as employee_role,
              j.status as job_status, d.status as delivery_status, d.reason as delivery_reason
         from ai_work_reports r
         left join agent_instances a on a.id = r.agent_instance_id and a.org_id = r.org_id
         left join ai_work_jobs j on j.id = r.job_id and j.org_id = r.org_id
         left join ai_work_report_deliveries d on d.report_id = r.id and d.user_id = $2
        where r.org_id = $1
          and ($3::boolean or r.kind not in ('daily_briefing', 'weekly_summary'))
          and ($4::text is null or a.role_key = $4)
        order by r.created_at desc limit $5`,
      [ctx.org.orgId, ctx.user.id, includeBriefings, options.role ?? null, limit],
    );
    return rows.map((row) => {
      const findings = asFindings(row.findings);
      const data = typeof row.data === "object" && row.data !== null ? row.data : {};
      return {
        id: row.id,
        kind: row.kind,
        severity: row.severity,
        title: row.title,
        summary: row.summary,
        sections: asSections(row.sections),
        findings,
        evidence: asEvidence(row.evidence),
        metrics: asMetrics(data.metrics),
        actions: asActions(row.actions),
        data,
        employeeName: row.employee_name ?? "AI workforce",
        employeeRole: row.employee_role,
        capability: row.capability,
        jobId: row.job_id,
        jobStatus: row.job_status,
        status: row.status,
        deliveryStatus: row.delivery_status,
        deliveryReason: row.delivery_reason,
        canCreateTask: row.job_status === "completed" && ctx.can("tasks.manage"),
        createdAt: new Date(row.created_at).toISOString(),
        acknowledgedAt: iso(row.acknowledged_at),
      };
    });
  });
}

/** Acknowledges a report for the workspace. The report remains in history and evidence is never deleted. */
export async function acknowledgeProactiveReport(ctx: OrgContext, reportId: string): Promise<{ acknowledged: boolean }> {
  if (!ctx.can("activity.view")) throw new AppError("forbidden", "Your role can't acknowledge proactive reports.");
  if (!/^[0-9a-f-]{36}$/i.test(reportId)) throw new AppError("not_found", "Report not found.");
  return withSystem(async (db) => {
    const { rows } = await db.query<{ id: string; status: string }>(
      "select id, status from ai_work_reports where id = $1 and org_id = $2",
      [reportId, ctx.org.orgId],
    );
    if (!rows[0]) throw new AppError("not_found", "Report not found.");
    if (rows[0].status === "acknowledged") return { acknowledged: false };
    await db.query(
      "update ai_work_reports set status = 'acknowledged', acknowledged_by = $3, acknowledged_at = now() where id = $1 and org_id = $2",
      [reportId, ctx.org.orgId, ctx.user.id],
    );
    await db.query(
      `insert into ai_work_report_deliveries (report_id, org_id, user_id, status, read_at)
       values ($1, $2, $3, 'delivered', now())
       on conflict (report_id, user_id) do update set read_at = coalesce(ai_work_report_deliveries.read_at, now()), updated_at = now()`,
      [reportId, ctx.org.orgId, ctx.user.id],
    );
    await recordAudit({
      orgId: ctx.org.orgId,
      actorUserId: ctx.user.id,
      actorKind: "user",
      action: "workforce.proactive_report_acknowledged",
      targetType: "ai_work_report",
      targetId: reportId,
      result: "success",
    }, db);
    return { acknowledged: true };
  });
}

/** Honest monitoring state: an enabled row is not active while its operator switch is off. */
export async function getProactiveMonitoringStatus(ctx: OrgContext): Promise<MonitoringStatus> {
  if (!ctx.can("activity.view")) {
    return {
      state: "not_configured",
      schedulesEnabled: 0,
      triggersEnabled: 0,
      schedulesOperatorEnabled: schedulesSwitchOn(),
      triggersOperatorEnabled: triggersSwitchOn(),
      briefingsOperatorEnabled: proactiveBriefingsEnabled(),
      lastVerifiedReportAt: null,
      byRole: [],
    };
  }
  return withUser(ctx.user.id, async (db) => {
    const [scheduleRows, triggerRows, reportRows] = await Promise.all([
      db.query<{ role: AgentRoleKey; n: number }>(
        `select a.role_key as role, count(*) filter (where s.enabled)::int as n
           from ai_work_schedules s join agent_instances a on a.id = s.agent_instance_id and a.org_id = s.org_id
          where s.org_id = $1 group by a.role_key`,
        [ctx.org.orgId],
      ),
      db.query<{ role: AgentRoleKey; n: number }>(
        `select a.role_key as role, count(*) filter (where t.enabled)::int as n
           from ai_work_triggers t join agent_instances a on a.id = t.agent_instance_id and a.org_id = t.org_id
          where t.org_id = $1 group by a.role_key`,
        [ctx.org.orgId],
      ),
      db.query<{ last: Date | null }>(
        "select max(created_at) as last from ai_work_reports where org_id = $1",
        [ctx.org.orgId],
      ),
    ]);
    const schedulesEnabled = scheduleRows.rows.reduce((total, row) => total + num(row.n), 0);
    const triggersEnabled = triggerRows.rows.reduce((total, row) => total + num(row.n), 0);
    const schedulesOn = schedulesSwitchOn();
    const triggersOn = triggersSwitchOn();
    const active = (schedulesEnabled > 0 && schedulesOn) || (triggersEnabled > 0 && triggersOn);
    const anyEnabled = schedulesEnabled > 0 || triggersEnabled > 0;
    const roles = new Set<string>([...scheduleRows.rows.map((row) => row.role), ...triggerRows.rows.map((row) => row.role)]);
    return {
      state: active ? "active" : anyEnabled ? "paused" : "not_configured",
      schedulesEnabled,
      triggersEnabled,
      schedulesOperatorEnabled: schedulesOn,
      triggersOperatorEnabled: triggersOn,
      briefingsOperatorEnabled: proactiveBriefingsEnabled(),
      lastVerifiedReportAt: iso(reportRows.rows[0]?.last ?? null),
      byRole: [...roles].map((role) => {
        const schedules = num(scheduleRows.rows.find((row) => row.role === role)?.n);
        const triggers = num(triggerRows.rows.find((row) => row.role === role)?.n);
        return { role: role as AgentRoleKey, schedules, triggers, enabled: schedules + triggers };
      }),
    };
  });
}

/** Number of unacknowledged reports for the workspace, used by the Work Board summary. */
export async function openProactiveReportCount(ctx: OrgContext): Promise<number> {
  if (!ctx.can("activity.view")) return 0;
  return withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<{ n: number }>(
      "select count(*)::int as n from ai_work_reports where org_id = $1 and status = 'open'",
      [ctx.org.orgId],
    );
    return num(rows[0]?.n);
  });
}

/** Used by tests and the work-board summary without exposing delivery internals. */
export function reportSeverityAtLeast(value: ProactiveSeverity, minimum: ProactiveSeverity): boolean {
  return severityAtLeast(value, minimum);
}
