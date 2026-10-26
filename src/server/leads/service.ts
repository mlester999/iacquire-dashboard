import "server-only";
import crypto from "node:crypto";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { assertWithinLimits } from "@/server/usage";
import { assertJobAllowed, jobGate } from "@/server/automation/job-gate";
import { createApproval } from "@/server/approvals/service";
import { createWorkJob, getWorkJob, retryWorkJob, workJobStageLabel } from "@/server/workforce/jobs";
import { runWorkJob } from "@/server/workforce/work-runner";
import { kickWorkJob } from "@/server/workforce/work-kick";
import { canChat, type AgentStatus } from "@/lib/agents";
import { targetingSchema, type Targeting } from "@/lib/leads-targeting";
import { roleMayUseCapability } from "@/lib/workforce-capabilities";
import { sanitizeQualificationSummary } from "@/server/leads/research-contract";
import type { OrgContext } from "@/server/tenancy/context";

export { targetingSchema };
export type { Targeting };
export { normalizeScore, normalizeDomain, parseResearchOutput, SCORE_MAX } from "@/server/leads/research-contract";

export async function getTargeting(ctx: OrgContext): Promise<Targeting> {
  return withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<{ criteria: unknown }>("select criteria from lead_targeting_profiles where org_id = $1", [ctx.org.orgId]);
    const parsed = targetingSchema.safeParse(rows[0]?.criteria ?? {});
    return parsed.success ? parsed.data : targetingSchema.parse({});
  });
}

export async function saveTargeting(ctx: OrgContext, input: unknown) {
  if (!ctx.can("leads.research")) throw new AppError("forbidden", "Only owners and admins can change targeting rules.");
  const data = targetingSchema.parse(input);
  await withUser(ctx.user.id, (db) =>
    db.query(
      `insert into lead_targeting_profiles (org_id, criteria, updated_by) values ($1, $2, $3)
       on conflict (org_id) do update set criteria = excluded.criteria, updated_by = excluded.updated_by, updated_at = now()`,
      [ctx.org.orgId, JSON.stringify(data), ctx.user.id],
    ),
  );
}

// ---------------------------------------------------------------------------
// Requests and jobs
// ---------------------------------------------------------------------------

async function leadHunter(db: Queryable, orgId: string) {
  const { rows } = await db.query<{ id: string; status: AgentStatus; enabled: boolean }>(
    "select id, status, enabled from agent_instances where org_id = $1 and role_key = 'lead_hunter'",
    [orgId],
  );
  return rows[0] ?? null;
}

/**
 * Creates the research request and its durable work job. The job is the unit of execution and
 * evidence; the request keeps the existing review-queue contract. If the Lead Hunter is not ready,
 * the request is saved honestly as `waiting_for_agent` and no job pretends to run.
 */
export async function createResearchRequest(
  ctx: OrgContext,
  input: { prompt: string; campaignType: "business" | "influencer" },
  options: { conversationId?: string | null; deferKick?: boolean } = {},
) {
  if (!ctx.can("leads.research")) throw new AppError("forbidden", "Only owners and admins can request lead research.");
  // The reviewed capability allowlist is the same one the generic dispatcher and work board use.
  if (!roleMayUseCapability("lead_hunter", "lead_research")) {
    throw new AppError("forbidden", "The Lead Hunter is not allowed to perform research in this deployment.");
  }
  const prompt = input.prompt.trim();
  if (prompt.length < 3 || prompt.length > 1000) throw new AppError("invalid_input", "Describe who you'd like to find in up to 1,000 characters.");
  const limit = await consumeRateLimit(RATE_LIMITS.researchByOrg, ctx.org.orgId);
  if (!limit.allowed) throw new AppError("rate_limited", "Too many research requests this hour.");
  const targeting = await getTargeting(ctx);
  const agent = await withSystem((db) => leadHunter(db, ctx.org.orgId));
  const connected = Boolean(agent?.enabled && canChat(agent.status));
  // Pauses and unavailable employees keep the request honestly waiting; nothing starts in that state.
  const gate = connected && agent
    ? await withSystem((db) => jobGate(db, { orgId: ctx.org.orgId, agentId: agent.id }))
    : null;
  const ready = connected && gate?.allowed === true;
  const waitingReason = gate && !gate.allowed
    ? gate.detail
    : "The Lead Hunter isn't connected yet, so no research has run.";
  if (ready) await assertWithinLimits(ctx.org.orgId, "lead_research");

  const created = await withSystem(async (db) => {
    const { rows } = await db.query<{ id: string }>(
      `insert into lead_research_requests (org_id, requested_by, prompt, campaign_type, criteria, status, failure_reason)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [
        ctx.org.orgId, ctx.user.id, prompt, input.campaignType, JSON.stringify(targeting),
        ready ? "queued" : "waiting_for_agent",
        ready ? null : waitingReason,
      ],
    );
    const requestId = rows[0].id;
    let jobId: string | null = null;
    if (ready && agent) {
      const job = await createWorkJob(db, {
        orgId: ctx.org.orgId,
        agentId: agent.id,
        requestedBy: ctx.user.id,
        capability: "lead_research",
        title: prompt.replace(/\s+/g, " ").slice(0, 200),
        idempotencyKey: `lead-research:${requestId}`,
        input: { requestId, prompt, campaignType: input.campaignType, criteria: targeting, origin: options.conversationId ? "chat" : "leads" },
        conversationId: options.conversationId ?? null,
      });
      jobId = job.id;
      await db.query("update lead_research_requests set work_job_id = $3 where id = $1 and org_id = $2", [requestId, ctx.org.orgId, job.id]);
    }
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "leads.research_requested", targetType: "lead_research_request", targetId: requestId, result: "success", metadata: { ready, jobId } }, db);
    return { requestId, jobId };
  });
  if (ready && created.jobId && !options.deferKick) kickWorkJob(created.jobId);
  return { requestId: created.requestId, jobId: created.jobId, status: ready ? "queued" : "waiting_for_agent" };
}

/** Re-runs a request that was saved while the Lead Hunter was unavailable. Never automatic. */
export async function retryResearchRequest(ctx: OrgContext, requestId: string) {
  if (!ctx.can("leads.research")) throw new AppError("forbidden", "Only owners and admins can run lead research.");
  const agent = await withSystem((db) => leadHunter(db, ctx.org.orgId));
  if (!agent?.enabled || !canChat(agent.status)) throw new AppError("agent_unavailable", "The Lead Hunter isn't connected yet.");
  await withSystem((db) => assertJobAllowed(db, { orgId: ctx.org.orgId, agentId: agent.id }));
  await assertWithinLimits(ctx.org.orgId, "lead_research");
  const jobId = await withSystem(async (db) => {
    const { rows } = await db.query<{ status: string; work_job_id: string | null; prompt: string; campaign_type: "business" | "influencer"; criteria: unknown }>(
      "select status, work_job_id, prompt, campaign_type, criteria from lead_research_requests where id = $1 and org_id = $2",
      [requestId, ctx.org.orgId],
    );
    const request = rows[0];
    if (!request) throw new AppError("not_found", "Request not found.");
    if (!["waiting_for_agent", "failed", "cancelled"].includes(request.status)) throw new AppError("conflict", "This request is already running or finished.");
    const { rows: updated } = await db.query(
      "update lead_research_requests set status = 'queued', failure_reason = null, completed_at = null where id = $1 and org_id = $2 and status in ('waiting_for_agent', 'failed', 'cancelled') returning id",
      [requestId, ctx.org.orgId],
    );
    if (!updated.length) throw new AppError("conflict", "This request is already running or finished.");
    if (request.work_job_id) {
      await retryWorkJob(db, { jobId: request.work_job_id, orgId: ctx.org.orgId });
      return request.work_job_id;
    }
    const job = await createWorkJob(db, {
      orgId: ctx.org.orgId,
      agentId: agent.id,
      requestedBy: ctx.user.id,
      capability: "lead_research",
      title: request.prompt.replace(/\s+/g, " ").slice(0, 200),
      idempotencyKey: `lead-research:${requestId}`,
      input: { requestId, prompt: request.prompt, campaignType: request.campaign_type, criteria: request.criteria },
    });
    await db.query("update lead_research_requests set work_job_id = $3 where id = $1 and org_id = $2", [requestId, ctx.org.orgId, job.id]);
    return job.id;
  });
  kickWorkJob(jobId);
}

/** Compatibility entry point for tests and existing callers: runs the request's durable job. */
export async function runResearch(orgId: string, requestId: string, agentId: string, userId: string) {
  const jobId = await withSystem(async (db) => {
    const { rows } = await db.query<{ work_job_id: string | null; prompt: string; campaign_type: "business" | "influencer"; criteria: unknown }>(
      "select work_job_id, prompt, campaign_type, criteria from lead_research_requests where id = $1 and org_id = $2",
      [requestId, orgId],
    );
    const request = rows[0];
    if (!request) throw new AppError("not_found", "Request not found.");
    if (request.work_job_id) {
      const job = await getWorkJob(db, orgId, request.work_job_id);
      if (job && ["failed", "blocked", "cancelled"].includes(job.status)) await retryWorkJob(db, { jobId: job.id, orgId });
      return request.work_job_id;
    }
    const job = await createWorkJob(db, {
      orgId,
      agentId,
      requestedBy: userId,
      capability: "lead_research",
      title: request.prompt.replace(/\s+/g, " ").slice(0, 200),
      idempotencyKey: `lead-research:${requestId}`,
      input: { requestId, prompt: request.prompt, campaignType: request.campaign_type, criteria: request.criteria },
    });
    await db.query("update lead_research_requests set work_job_id = $3 where id = $1 and org_id = $2", [requestId, orgId, job.id]);
    return job.id;
  });
  await runWorkJob(jobId);
}

// ---------------------------------------------------------------------------
// Review queue
// ---------------------------------------------------------------------------

export interface LeadRow {
  id: string;
  business_name: string;
  website: string | null;
  domain: string | null;
  industry: string | null;
  location: string | null;
  score: number | null;
  score_breakdown: Record<string, number>;
  qualification_summary: string | null;
  buying_signals: string[];
  evidence: Array<{ url: string; observed_at?: string | null; summary?: string | null }>;
  duplicate_status: string;
  duplicate_matches: Array<{ kind: "lead" | "crm_company"; id: string; label: string; domain: string | null }>;
  public_contact: { name?: string | null; role?: string | null; email?: string | null; phone?: string | null; source_url?: string | null };
  review_status: "pending" | "approved" | "rejected";
  crm_sync_status: string;
  created_at: Date;
}

export async function listLeads(ctx: OrgContext, status: "pending" | "approved" | "rejected" | "all" = "all"): Promise<LeadRow[]> {
  return withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<LeadRow>(
      `select id, business_name, website, domain, industry, location, score, score_breakdown, qualification_summary,
              buying_signals, evidence, duplicate_status, duplicate_matches, public_contact, review_status, crm_sync_status, created_at
       from leads where org_id = $1 and ($2 = 'all' or review_status = $2)
       order by created_at desc limit 500`,
      [ctx.org.orgId, status],
    );
    // Older rows may contain model-authored claims about CRM checks, queue persistence, or page
    // observation times. Those are application-owned facts, so suppress unsupported claims at
    // read time as well as when new research is saved; the underlying evidence rows stay intact.
    return rows.map((row) => ({
      ...row,
      qualification_summary: sanitizeQualificationSummary(row.qualification_summary),
      evidence: Array.isArray(row.evidence) ? row.evidence.map((item) => ({ ...item, observed_at: null })) : [],
    }));
  });
}

export async function listResearchRequests(ctx: OrgContext) {
  return withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<{
      id: string; prompt: string; campaign_type: string; status: string; result_count: number; failure_reason: string | null;
      created_at: Date; completed_at: Date | null; requested_by_name: string | null;
      work_job_id: string | null; job_status: string | null; job_stage: string | null; job_stage_label: string | null; job_progress: Record<string, unknown> | null;
    }>(
      `select r.id, r.prompt, r.campaign_type, r.status, r.result_count, r.failure_reason, r.created_at, r.completed_at, u.full_name as requested_by_name,
              r.work_job_id, j.status as job_status, j.stage as job_stage, j.progress as job_progress
       from lead_research_requests r
       left join users u on u.id = r.requested_by
       left join ai_work_jobs j on j.id = r.work_job_id and j.org_id = r.org_id
       where r.org_id = $1 order by r.created_at desc limit 50`,
      [ctx.org.orgId],
    );
    return rows.map((row) => ({
      ...row,
      job_stage_label: row.job_stage ? workJobStageLabel(row.job_stage) : null,
    }));
  });
}

export async function reviewLeads(ctx: OrgContext, leadIds: string[], decision: "approve" | "reject") {
  if (!ctx.can("leads.review")) throw new AppError("forbidden", "Only owners and admins can review leads.");
  const ids = leadIds.filter((id) => /^[0-9a-f-]{36}$/i.test(id)).slice(0, 200);
  if (!ids.length) throw new AppError("invalid_input", "Select at least one lead.");
  const res = await withSystem(async (db) => {
    const r = await db.query(
      `update leads set review_status = $3, reviewed_by = $4, reviewed_at = now()
       where org_id = $1 and id = any($2::uuid[]) and review_status = 'pending'`,
      [ctx.org.orgId, ids, decision === "approve" ? "approved" : "rejected", ctx.user.id],
    );
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: `leads.${decision === "approve" ? "approved" : "rejected"}`, result: "success", metadata: { count: r.rowCount } }, db);
    return r.rowCount;
  });
  return res;
}

/** Creates an Approval Center request to import approved leads into the CRM. */
export async function requestCrmImport(ctx: OrgContext, leadIds: string[]) {
  if (!ctx.can("leads.review")) throw new AppError("forbidden", "Only owners and admins can send leads to the CRM.");
  const ids = leadIds.filter((id) => /^[0-9a-f-]{36}$/i.test(id)).slice(0, 100);
  return withSystem(async (db) => {
    const { rows } = await db.query<{ id: string; business_name: string }>(
      "select id, business_name from leads where org_id = $1 and id = any($2::uuid[]) and review_status = 'approved' and crm_sync_status in ('not_synced', 'blocked', 'failed')",
      [ctx.org.orgId, ids],
    );
    if (!rows.length) throw new AppError("invalid_input", "Choose approved leads that haven't been sent to the CRM yet.");
    const approvalId = await createApproval(db, {
      orgId: ctx.org.orgId,
      requestedBy: ctx.user.id,
      kind: "lead_import",
      title: `Import ${rows.length} researched lead${rows.length === 1 ? "" : "s"} into the CRM`,
      action: { leadIds: rows.map((r) => r.id) },
      targetType: "leads",
      targetLabel: rows.slice(0, 3).map((r) => r.business_name).join(", ") + (rows.length > 3 ? ` +${rows.length - 3} more` : ""),
      reason: "These businesses were reviewed and approved as good fits.",
      expectedEffect: "Creates or updates contacts in your connected CRM. It does not contact anyone and does not mark them as consenting to marketing.",
      risk: "medium",
      idempotencyKey: `lead-import:${crypto.createHash("sha256").update(rows.map((r) => r.id).sort().join(",")).digest("hex").slice(0, 32)}`,
    });
    if (!approvalId) throw new AppError("conflict", "An import request for these leads already exists.");
    await db.query("update leads set crm_sync_status = 'awaiting_approval' where org_id = $1 and id = any($2::uuid[])", [ctx.org.orgId, rows.map((r) => r.id)]);
    return approvalId;
  });
}

export function leadsToCsv(rows: LeadRow[]): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    // Neutralise spreadsheet formula injection.
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const header = ["Business", "Website", "Industry", "Location", "Score", "Review status", "Duplicate status", "CRM sync", "Sources", "Researched at"];
  const lines = rows.map((r) =>
    [r.business_name, r.website, r.industry, r.location, r.score, r.review_status, r.duplicate_status, r.crm_sync_status, r.evidence.map((e) => e.url).join(" "), new Date(r.created_at).toISOString()]
      .map(esc)
      .join(","),
  );
  return [header.join(","), ...lines].join("\n");
}
