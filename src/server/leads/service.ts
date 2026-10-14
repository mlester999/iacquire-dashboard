import "server-only";
import crypto from "node:crypto";
import { z } from "zod";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { assertWithinLimits, recordUsage } from "@/server/usage";
import { notifyOrgRoles } from "@/server/notifications";
import { createApproval } from "@/server/approvals/service";
import { buildRunInstructions, loadConnection, markAgentDegraded } from "@/server/workforce/service";
import { HermesError, startRun, streamRunEvents } from "@/server/integrations/hermes/client";
import { env } from "@/server/env";
import { canChat, type AgentStatus } from "@/lib/agents";
import type { OrgContext } from "@/server/tenancy/context";

const list = (max: number) => z.array(z.string().trim().min(1).max(120)).max(max).default([]);

export const targetingSchema = z.object({
  industries: list(15),
  countries: list(15),
  regions: list(20),
  businessSize: z.enum(["any", "solo", "2-10", "11-50", "51-200", "200+"]).default("any"),
  servicesNeeded: list(15),
  keywords: list(20),
  customerType: z.enum(["b2b", "b2c", "both"]).default("b2b"),
  buyingSignals: list(15),
  excluded: list(30),
  minimumCriteria: z.string().trim().max(1000).default(""),
  influencer: z
    .object({
      enabled: z.boolean().default(false),
      platform: z.enum(["instagram", "tiktok", "youtube", "linkedin", "x", "other"]).default("instagram"),
      niche: z.string().trim().max(120).default(""),
      region: z.string().trim().max(120).default(""),
      minFollowers: z.coerce.number().int().min(0).max(100_000_000).default(0),
      engagementCriteria: z.string().trim().max(300).default(""),
      objective: z.string().trim().max(300).default(""),
    })
    .default({ enabled: false, platform: "instagram", niche: "", region: "", minFollowers: 0, engagementCriteria: "", objective: "" }),
});
export type Targeting = z.infer<typeof targetingSchema>;

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
// Research output contract (validated server-side; the agent cannot set consent or CRM state)
// ---------------------------------------------------------------------------

const httpsUrl = z
  .string()
  .trim()
  .max(500)
  .refine((v) => /^https?:\/\/[^\s]+\.[^\s]+/.test(v), "URL");

const researchLeadSchema = z.object({
  business_name: z.string().trim().min(1).max(200),
  website: z.string().trim().max(300).optional().nullable(),
  industry: z.string().trim().max(120).optional().nullable(),
  location: z.string().trim().max(200).optional().nullable(),
  evidence: z
    .array(z.object({ url: httpsUrl, observed_at: z.string().max(40).optional().nullable(), summary: z.string().trim().max(500).optional().nullable() }))
    .max(10)
    .default([]),
  buying_signals: z.array(z.string().trim().max(200)).max(10).default([]),
  qualification_summary: z.string().trim().max(2000).optional().nullable(),
  score: z
    .object({
      service_fit: z.number().optional(),
      problem_evidence: z.number().optional(),
      buying_intent: z.number().optional(),
      market_fit: z.number().optional(),
      source_quality: z.number().optional(),
    })
    .default({}),
});
const researchOutputSchema = z.object({ leads: z.array(z.unknown()).max(50) });

export const SCORE_MAX = { service_fit: 30, problem_evidence: 25, buying_intent: 20, market_fit: 15, source_quality: 10 } as const;

export function normalizeScore(raw: Partial<Record<keyof typeof SCORE_MAX, number>>, evidenceCount: number) {
  const out = {} as Record<keyof typeof SCORE_MAX, number>;
  for (const key of Object.keys(SCORE_MAX) as Array<keyof typeof SCORE_MAX>) {
    const v = Number(raw[key] ?? 0);
    out[key] = Math.max(0, Math.min(SCORE_MAX[key], Number.isFinite(v) ? Math.round(v) : 0));
  }
  // Points that claim evidence require cited sources.
  if (evidenceCount === 0) {
    out.problem_evidence = 0;
    out.buying_intent = 0;
    out.source_quality = 0;
  }
  return { breakdown: out, total: Object.values(out).reduce((a, b) => a + b, 0) };
}

export function normalizeDomain(website: string | null | undefined): string | null {
  if (!website) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`);
    return u.hostname.toLowerCase().replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/** Extracts the JSON payload from an agent answer (bare JSON or a fenced ```json block). */
export function parseResearchOutput(output: string) {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { leads: [], rejected: 0, error: "The Lead Hunter's answer wasn't in the expected format." };
  }
  const top = researchOutputSchema.safeParse(parsed);
  if (!top.success) return { leads: [], rejected: 0, error: "The Lead Hunter's answer wasn't in the expected format." };
  const leads: Array<z.infer<typeof researchLeadSchema>> = [];
  let rejected = 0;
  for (const item of top.data.leads.slice(0, 20)) {
    const r = researchLeadSchema.safeParse(item);
    if (r.success) leads.push(r.data);
    else rejected++;
  }
  return { leads, rejected, error: null as string | null };
}

function researchPrompt(prompt: string, targeting: Targeting, campaign: "business" | "influencer") {
  return [
    `Research request from the business owner: ${prompt}`,
    "",
    "Targeting rules (client-provided data):",
    JSON.stringify(campaign === "influencer" ? { ...targeting, influencer: targeting.influencer } : { ...targeting, influencer: undefined }),
    "",
    "Use only approved public sources (company websites, official registries, public business pages). Do not scrape personal profiles, do not message anyone, and do not guess contact details.",
    "Return at most 20 candidates. Only include evidence you actually observed, with its URL. If you cannot find evidence, say so in qualification_summary and leave evidence empty.",
    "Respond with JSON only, in this exact shape:",
    '```json\n{"leads":[{"business_name":"","website":"","industry":"","location":"","evidence":[{"url":"https://…","observed_at":"ISO-8601","summary":""}],"buying_signals":[""],"qualification_summary":"","score":{"service_fit":0,"problem_evidence":0,"buying_intent":0,"market_fit":0,"source_quality":0}}]}\n```',
    `Score maxima: service_fit ${SCORE_MAX.service_fit}, problem_evidence ${SCORE_MAX.problem_evidence}, buying_intent ${SCORE_MAX.buying_intent}, market_fit ${SCORE_MAX.market_fit}, source_quality ${SCORE_MAX.source_quality}. A score is a research priority, not consent or confirmed interest.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

async function leadHunter(db: Queryable, orgId: string) {
  const { rows } = await db.query<{ id: string; status: AgentStatus; enabled: boolean }>(
    "select id, status, enabled from agent_instances where org_id = $1 and role_key = 'lead_hunter'",
    [orgId],
  );
  return rows[0] ?? null;
}

export async function createResearchRequest(ctx: OrgContext, input: { prompt: string; campaignType: "business" | "influencer" }) {
  if (!ctx.can("leads.research")) throw new AppError("forbidden", "Only owners and admins can request lead research.");
  const prompt = input.prompt.trim();
  if (prompt.length < 3 || prompt.length > 1000) throw new AppError("invalid_input", "Describe who you'd like to find in up to 1,000 characters.");
  const limit = await consumeRateLimit(RATE_LIMITS.researchByOrg, ctx.org.orgId);
  if (!limit.allowed) throw new AppError("rate_limited", "Too many research requests this hour.");
  const targeting = await getTargeting(ctx);
  const agent = await withSystem((db) => leadHunter(db, ctx.org.orgId));
  const ready = Boolean(agent?.enabled && canChat(agent.status));
  if (ready) await assertWithinLimits(ctx.org.orgId, "lead_research");

  const requestId = await withSystem(async (db) => {
    const { rows } = await db.query<{ id: string }>(
      `insert into lead_research_requests (org_id, requested_by, prompt, campaign_type, criteria, status, failure_reason)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [
        ctx.org.orgId, ctx.user.id, prompt, input.campaignType, JSON.stringify(targeting),
        ready ? "queued" : "waiting_for_agent",
        ready ? null : "The Lead Hunter isn't connected yet, so no research has run.",
      ],
    );
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "leads.research_requested", targetType: "lead_research_request", targetId: rows[0].id, result: "success", metadata: { ready } }, db);
    return rows[0].id;
  });
  if (ready && agent) void runResearch(ctx.org.orgId, requestId, agent.id, ctx.user.id);
  return { requestId, status: ready ? "queued" : "waiting_for_agent" };
}

/** Re-runs a request that was saved while the Lead Hunter was unavailable. Never automatic. */
export async function retryResearchRequest(ctx: OrgContext, requestId: string) {
  if (!ctx.can("leads.research")) throw new AppError("forbidden", "Only owners and admins can run lead research.");
  const agent = await withSystem((db) => leadHunter(db, ctx.org.orgId));
  if (!agent?.enabled || !canChat(agent.status)) throw new AppError("agent_unavailable", "The Lead Hunter isn't connected yet.");
  await assertWithinLimits(ctx.org.orgId, "lead_research");
  const res = await withSystem((db) =>
    db.query(
      "update lead_research_requests set status = 'queued', failure_reason = null where id = $1 and org_id = $2 and status in ('waiting_for_agent', 'failed')",
      [requestId, ctx.org.orgId],
    ),
  );
  if (!res.rowCount) throw new AppError("conflict", "This request is already running or finished.");
  void runResearch(ctx.org.orgId, requestId, agent.id, ctx.user.id);
}

export async function runResearch(orgId: string, requestId: string, agentId: string, userId: string) {
  const fail = (reason: string) =>
    withSystem((db) =>
      db.query("update lead_research_requests set status = 'failed', failure_reason = $3, completed_at = now() where id = $1 and org_id = $2", [requestId, orgId, reason]),
    ).catch(() => undefined);
  try {
    const setup = await withSystem(async (db) => {
      const { rows } = await db.query<{ prompt: string; criteria: unknown; campaign_type: "business" | "influencer" }>(
        "select prompt, criteria, campaign_type from lead_research_requests where id = $1 and org_id = $2",
        [requestId, orgId],
      );
      const req = rows[0];
      if (!req) throw new AppError("not_found", "Request not found.");
      const conn = await loadConnection(db, agentId);
      if (!conn) throw new AppError("agent_unavailable", "Lead Hunter is not connected.");
      const { instructions, versionId } = await buildRunInstructions(db, orgId, agentId);
      const idempotencyKey = `research:${requestId}:${crypto.randomUUID()}`;
      const { rows: run } = await db.query<{ id: string }>(
        `insert into agent_runs (org_id, agent_instance_id, user_id, purpose, idempotency_key, status, config_version_id)
         values ($1, $2, $3, 'lead_research', $4, 'running', $5) returning id`,
        [orgId, agentId, userId, idempotencyKey, versionId],
      );
      await db.query("update lead_research_requests set status = 'running', agent_run_id = $3 where id = $1 and org_id = $2", [requestId, orgId, run[0].id]);
      await recordUsage(db, { orgId, userId, agentId, kind: "lead_research" });
      const targeting = targetingSchema.safeParse(req.criteria);
      return { conn, instructions, idempotencyKey, runId: run[0].id, input: researchPrompt(req.prompt, targeting.success ? targeting.data : targetingSchema.parse({}), req.campaign_type) };
    });

    const { runId: hermesRunId } = await startRun(setup.conn, {
      input: setup.input,
      instructions: setup.instructions,
      idempotencyKey: setup.idempotencyKey,
      memoryScope: `iaq:${orgId}:lead_hunter`,
    });
    await withSystem((db) => db.query("update agent_runs set hermes_run_id = $2 where id = $1", [setup.runId, hermesRunId]));
    let output: string | null = null;
    let streamed = "";
    let failure: string | null = null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env().HERMES_RUN_TIMEOUT_MS);
    try {
      for await (const ev of streamRunEvents(setup.conn, hermesRunId, controller.signal)) {
        if (ev.type === "delta") streamed += ev.text;
        else if (ev.type === "completed") {
          output = ev.output ?? streamed;
          break;
        } else if (ev.type === "failed" || ev.type === "interrupted") {
          failure = "The Lead Hunter couldn't complete this research.";
          break;
        } else if (ev.type === "cancelled") {
          failure = "The research was stopped.";
          break;
        }
      }
    } finally {
      clearTimeout(timer);
    }
    if (!output && !failure) failure = controller.signal.aborted ? "The research took too long and was stopped." : "The research ended without a result.";
    await withSystem((db) =>
      db.query("update agent_runs set status = $2, finished_at = now() where id = $1", [setup.runId, failure ? "failed" : "completed"]),
    );
    if (failure || !output) return fail(failure ?? "No result.");

    const parsed = parseResearchOutput(output);
    if (parsed.error) return fail(parsed.error);
    const inserted = await withSystem(async (db) => {
      let count = 0;
      for (const lead of parsed.leads) {
        const domain = normalizeDomain(lead.website);
        const { breakdown, total } = normalizeScore(lead.score, lead.evidence.length);
        let duplicate: "no_match" | "duplicate" | "possible_duplicate" = "no_match";
        if (domain) {
          const { rows } = await db.query("select 1 from leads where org_id = $1 and domain = $2 limit 1", [orgId, domain]);
          if (rows.length) duplicate = "duplicate";
        } else {
          const { rows } = await db.query("select 1 from leads where org_id = $1 and lower(business_name) = lower($2) limit 1", [orgId, lead.business_name]);
          if (rows.length) duplicate = "possible_duplicate";
        }
        await db.query(
          `insert into leads (org_id, research_request_id, business_name, website, domain, industry, location, source_platform,
             evidence, score, score_breakdown, qualification_summary, buying_signals, duplicate_status)
           values ($1, $2, $3, $4, $5, $6, $7, 'lead_hunter', $8, $9, $10, $11, $12, $13)`,
          [
            orgId, requestId, lead.business_name, lead.website ?? null, domain, lead.industry ?? null, lead.location ?? null,
            JSON.stringify(lead.evidence), total, JSON.stringify(breakdown), lead.qualification_summary ?? null,
            lead.buying_signals, duplicate,
          ],
        );
        count++;
      }
      await db.query(
        "update lead_research_requests set status = 'completed', result_count = $3, completed_at = now(), failure_reason = $4 where id = $1 and org_id = $2",
        [requestId, orgId, count, parsed.rejected ? `${parsed.rejected} result(s) were discarded because they didn't meet the evidence format.` : null],
      );
      if (count) {
        await notifyOrgRoles(db, orgId, ["owner", "admin"], {
          kind: "lead_awaiting_approval",
          severity: "info",
          title: `${count} researched lead${count === 1 ? "" : "s"} ready for review`,
          link: "/leads?tab=review",
        });
      }
      return count;
    });
    return inserted;
  } catch (err) {
    if (err instanceof HermesError && (err.kind === "unreachable" || err.kind === "auth_failed")) await markAgentDegraded(agentId, err.message);
    await fail(err instanceof AppError ? err.message : "The research couldn't be completed.");
  }
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
  review_status: "pending" | "approved" | "rejected";
  crm_sync_status: string;
  created_at: Date;
}

export async function listLeads(ctx: OrgContext, status: "pending" | "approved" | "rejected" | "all" = "all"): Promise<LeadRow[]> {
  return withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<LeadRow>(
      `select id, business_name, website, domain, industry, location, score, score_breakdown, qualification_summary,
              buying_signals, evidence, duplicate_status, review_status, crm_sync_status, created_at
       from leads where org_id = $1 and ($2 = 'all' or review_status = $2)
       order by created_at desc limit 500`,
      [ctx.org.orgId, status],
    );
    return rows;
  });
}

export async function listResearchRequests(ctx: OrgContext) {
  return withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<{ id: string; prompt: string; campaign_type: string; status: string; result_count: number; failure_reason: string | null; created_at: Date; completed_at: Date | null; requested_by_name: string | null }>(
      `select r.id, r.prompt, r.campaign_type, r.status, r.result_count, r.failure_reason, r.created_at, r.completed_at, u.full_name as requested_by_name
       from lead_research_requests r left join users u on u.id = r.requested_by
       where r.org_id = $1 order by r.created_at desc limit 50`,
      [ctx.org.orgId],
    );
    return rows;
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
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const header = ["Business", "Website", "Industry", "Location", "Score", "Review status", "Duplicate status", "CRM sync", "Sources", "Researched at"];
  const lines = rows.map((r) =>
    [r.business_name, r.website, r.industry, r.location, r.score, r.review_status, r.duplicate_status, r.crm_sync_status, r.evidence.map((e) => e.url).join(" "), new Date(r.created_at).toISOString()]
      .map(esc)
      .join(","),
  );
  return [header.join(","), ...lines].join("\n");
}
