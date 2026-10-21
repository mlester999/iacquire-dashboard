import "server-only";
import { runReadOnlyReviewJob, reviewFinding, type ReviewCheck } from "@/server/workforce/read-only-review";
import type { WorkJobRow } from "@/server/workforce/jobs";
import { INTERNAL_PROSPECTING } from "@/lib/internal-business-profile";

/**
 * Lead Hunter proactive duty.
 *
 * This review watches the authorized lead-generation pipeline the workspace already stores: research
 * requests, the human review queue, the CRM handoff and the saved targeting. It does not start a
 * provider run, import a lead, send outreach or invent a prospect. When research is stale it names
 * the saved target and recommends the next assignment; starting it remains a separate authorized
 * action.
 */

const samples = (value: unknown) => (Array.isArray(value) ? (value as string[]).filter((item) => typeof item === "string") : []);

const STALLED_STATUSES = ["queued", "running"];

const stalledResearch: ReviewCheck = async (db, job) => {
  const { rows } = await db.query<{ count: number; samples: string[] }>(
    `select count(*)::int as count, coalesce(array_agg(prompt order by created_at asc), '{}') as samples
       from lead_research_requests
      where org_id = $1
        and (
          (status = any($2::text[]) and created_at < now() - interval '2 hours')
          or (status = 'waiting_for_agent' and created_at < now() - interval '24 hours')
        )`,
    [job.org_id, STALLED_STATUSES],
  );
  const count = Number(rows[0]?.count ?? 0);
  if (!count) return null;
  return reviewFinding({
    key: "lead_research_stalled",
    severity: "warning",
    title: `${count} research request${count === 1 ? " has" : "s have"} not reached a result`,
    detail: "The request is still recorded as queued, running or waiting for the Lead Hunter. No research result is being claimed.",
    count,
    samples: samples(rows[0]?.samples),
    evidenceHref: "/leads?tab=research",
    recommendedAction: "Open the research request, read the recorded job state and retry only after the cause is understood.",
    requiresApproval: false,
  });
};

const reviewBacklog: ReviewCheck = async (db, job) => {
  const { rows } = await db.query<{ count: number; samples: string[] }>(
    `select count(*)::int as count, coalesce(array_agg(business_name order by created_at asc), '{}') as samples
       from leads
      where org_id = $1 and review_status = 'pending' and created_at < now() - interval '48 hours'`,
    [job.org_id],
  );
  const count = Number(rows[0]?.count ?? 0);
  if (!count) return null;
  return reviewFinding({
    key: "lead_review_backlog",
    severity: "info",
    title: `${count} researched lead${count === 1 ? " is" : "s are"} waiting over 48 hours for review`,
    detail: "The research is complete, but nobody has decided whether these businesses fit. Nothing has been imported or contacted.",
    count,
    samples: samples(rows[0]?.samples),
    evidenceHref: "/leads?tab=review",
    recommendedAction: "Review the cited evidence and approve, reject or ask for better evidence.",
    requiresApproval: false,
  });
};

const crmHandoff: ReviewCheck = async (db, job) => {
  const { rows } = await db.query<{ count: number; samples: string[] }>(
    `select count(*)::int as count, coalesce(array_agg(business_name order by created_at asc), '{}') as samples
       from leads
      where org_id = $1 and review_status = 'approved'
        and crm_sync_status in ('not_synced', 'blocked', 'failed')`,
    [job.org_id],
  );
  const count = Number(rows[0]?.count ?? 0);
  if (!count) return null;
  return reviewFinding({
    key: "approved_leads_not_in_crm",
    severity: "warning",
    title: `${count} approved lead${count === 1 ? " has" : "s have"} not reached the CRM`,
    detail: "The human review is complete, but the CRM handoff is still not recorded as synced. No import is being claimed.",
    count,
    samples: samples(rows[0]?.samples),
    evidenceHref: "/leads?tab=approved",
    recommendedAction: "Request the CRM import from the approved leads queue and check the recorded sync result.",
    requiresApproval: false,
  });
};

async function savedTarget(db: Parameters<ReviewCheck>[0], job: WorkJobRow): Promise<{ target: string; location: string; qualification: string } | null> {
  const { rows } = await db.query<{ settings: { targetCustomers?: string; roleAnswers?: Record<string, string> } | null; kind: "agency" | "client" }>(
    `select v.settings, o.kind
       from agent_instances a
       join agent_config_versions v on v.id = a.active_config_version_id and v.org_id = a.org_id
       join organizations o on o.id = a.org_id
      where a.id = $1 and a.org_id = $2`,
    [job.agent_instance_id, job.org_id],
  );
  const settings = rows[0]?.settings;
  if (!settings) return null;
  const target = (settings.roleAnswers?.targets || settings.targetCustomers || "").trim();
  if (!target && rows[0]?.kind === "agency") {
    // The internal workspace has approved prospecting defaults; a client must ask for its own.
    return {
      target: INTERNAL_PROSPECTING.targetCustomers.slice(0, 200),
      location: INTERNAL_PROSPECTING.countries.join(", "),
      qualification: INTERNAL_PROSPECTING.qualification.slice(0, 240),
    };
  }
  const qualification = (settings.roleAnswers?.qualification || "").trim();
  const locationMatch = qualification.match(/\b(?:in|near|around|across)\s+([^;,.]+)/i);
  return {
    target: target.slice(0, 200),
    location: (locationMatch?.[1] ?? "").trim().slice(0, 120),
    qualification: qualification.slice(0, 240),
  };
}

const coverageGap: ReviewCheck = async (db, job) => {
  const { rows } = await db.query<{ recent: number; approved: number }>(
    `select
       (select count(*)::int from lead_research_requests where org_id = $1 and created_at >= now() - interval '14 days') as recent,
       (select count(*)::int from leads where org_id = $1 and review_status = 'approved' and reviewed_at >= now() - interval '30 days') as approved`,
    [job.org_id],
  );
  const recent = Number(rows[0]?.recent ?? 0);
  const approved = Number(rows[0]?.approved ?? 0);
  if (recent > 0) return null;
  const target = await savedTarget(db, job);
  const assignment = target?.target
    ? `Next approved assignment: research ${target.location ? `${target.target} in ${target.location}` : target.target} and prepare candidates for human review.`
    : "Set the Lead Hunter's target customer and operating area in Configure, then start an approved research assignment.";
  return reviewFinding({
    key: "lead_research_coverage_gap",
    severity: approved > 0 ? "info" : "warning",
    title: "No authorized lead research ran in the last 14 days",
    detail: target?.target
      ? `The saved target is “${target.target}”${target.location ? ` in ${target.location}` : ""}. ${approved ? `${approved} lead${approved === 1 ? " was" : "s were"} approved in the last 30 days.` : "No lead was approved in the last 30 days."} There is no active research queue for this period.`
      : "No lead research ran, and the employee's target-customer information is not specific enough to recommend a segment. The review will not invent one.",
    count: 1,
    samples: target?.qualification ? [target.qualification] : [],
    evidenceHref: target?.target ? "/employees/lead-hunter?tab=configure" : "/employees/lead-hunter",
    recommendedAction: assignment,
    requiresApproval: false,
  });
};

const duplicateQuality: ReviewCheck = async (db, job) => {
  const { rows } = await db.query<{ total: number; flagged: number; samples: string[] }>(
    `select count(*)::int as total,
            count(*) filter (where duplicate_status in ('possible_duplicate', 'duplicate'))::int as flagged,
            coalesce(array_agg(business_name order by created_at asc) filter (where duplicate_status in ('possible_duplicate', 'duplicate')), '{}') as samples
       from leads
      where org_id = $1 and created_at >= now() - interval '90 days'`,
    [job.org_id],
  );
  const total = Number(rows[0]?.total ?? 0);
  const flagged = Number(rows[0]?.flagged ?? 0);
  if (!total || !flagged || flagged / total < 0.2) return null;
  return reviewFinding({
    key: "lead_duplicate_rate",
    severity: "warning",
    title: `${flagged} of ${total} recently researched leads may duplicate an existing record`,
    detail: "This is above the 20% review threshold used by this check. A duplicate warning is not proof; a person must compare the records.",
    count: flagged,
    samples: samples(rows[0]?.samples),
    evidenceHref: "/leads?tab=all",
    recommendedAction: "Review the candidate matches against the CRM before importing, and narrow the targeting if the overlap is genuine.",
    requiresApproval: false,
  });
};

export async function runLeadGenerationReviewJob(job: WorkJobRow, _context: { workerId: string; controller: AbortController }): Promise<void> {
  return runReadOnlyReviewJob(job, {
    capability: "lead_generation_review",
    allowedRoles: ["lead_hunter"],
    scanningMessage: "Reading the authorized research queue, reviewed leads, CRM handoff states and saved targeting…",
    analyzingMessage: "Assessing generation gaps and preparing an evidence-backed next assignment…",
    checks: [stalledResearch, reviewBacklog, crmHandoff, coverageGap, duplicateQuality],
    limitations: "Only persisted research requests, leads and the saved Lead Hunter configuration were read. No provider was contacted, no research was started, no lead was imported and no prospect was contacted.",
    subject: "Lead generation",
  });
}
