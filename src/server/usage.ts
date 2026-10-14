import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { notifyOrgRoles, notifyAgency } from "@/server/notifications";

type UsageKind = "agent_message" | "agent_run_failed" | "lead_research" | "help_request" | "crm_sync";

export interface UsageLimits {
  monthly_agent_messages: number;
  monthly_tokens: number | null;
  daily_lead_research: number;
  monthly_help_requests: number;
  warn_at_percent: number;
  hard_stop: boolean;
  fair_use_note: string | null;
}

const DEFAULT_LIMITS: UsageLimits = {
  monthly_agent_messages: 1500,
  monthly_tokens: null,
  daily_lead_research: 5,
  monthly_help_requests: 500,
  warn_at_percent: 80,
  hard_stop: true,
  fair_use_note: null,
};

export async function getLimits(db: Queryable, orgId: string): Promise<UsageLimits> {
  const { rows } = await db.query<UsageLimits>(
    `select monthly_agent_messages, monthly_tokens, daily_lead_research, monthly_help_requests, warn_at_percent,
            hard_stop, fair_use_note from usage_limits where org_id = $1`,
    [orgId],
  );
  return rows[0] ? { ...rows[0], monthly_tokens: rows[0].monthly_tokens === null ? null : Number(rows[0].monthly_tokens) } : DEFAULT_LIMITS;
}

export interface UsageSummary {
  agentMessages: number;
  tokens: number;
  leadResearchToday: number;
  helpRequests: number;
  failedRuns: number;
  limits: UsageLimits;
}

export async function usageSummary(db: Queryable, orgId: string): Promise<UsageSummary> {
  const { rows } = await db.query<{ agent: string; tokens: string; research: string; help: string; failed: string }>(
    `select
       coalesce(sum(quantity) filter (where kind = 'agent_message' and created_at >= date_trunc('month', now())), 0)::text as agent,
       coalesce(sum(coalesce(input_tokens, 0) + coalesce(output_tokens, 0)) filter (where created_at >= date_trunc('month', now())), 0)::text as tokens,
       coalesce(sum(quantity) filter (where kind = 'lead_research' and created_at >= date_trunc('day', now())), 0)::text as research,
       coalesce(sum(quantity) filter (where kind = 'help_request' and created_at >= date_trunc('month', now())), 0)::text as help,
       coalesce(sum(quantity) filter (where kind = 'agent_run_failed' and created_at >= date_trunc('month', now())), 0)::text as failed
     from usage_events where org_id = $1`,
    [orgId],
  );
  const r = rows[0];
  return {
    agentMessages: Number(r?.agent ?? 0),
    tokens: Number(r?.tokens ?? 0),
    leadResearchToday: Number(r?.research ?? 0),
    helpRequests: Number(r?.help ?? 0),
    failedRuns: Number(r?.failed ?? 0),
    limits: await getLimits(db, orgId),
  };
}

/** Throws when a hard limit would be exceeded. Called before any costly operation starts. */
export async function assertWithinLimits(orgId: string, kind: "agent_message" | "lead_research" | "help_request") {
  const summary = await withSystem((db) => usageSummary(db, orgId));
  const { limits } = summary;
  const checks: Array<[boolean, string]> = [
    [kind === "agent_message" && summary.agentMessages >= limits.monthly_agent_messages, "Your workspace has reached its monthly AI message limit."],
    [kind === "agent_message" && limits.monthly_tokens !== null && summary.tokens >= limits.monthly_tokens, "Your workspace has reached its monthly AI usage limit."],
    [kind === "lead_research" && summary.leadResearchToday >= limits.daily_lead_research, "You've reached today's lead research limit."],
    [kind === "help_request" && summary.helpRequests >= limits.monthly_help_requests, "The help assistant has reached this month's limit for your workspace."],
  ];
  const hit = checks.find(([exceeded]) => exceeded);
  if (hit && limits.hard_stop) {
    throw new AppError("usage_limit", `${hit[1]} Contact iAcquire if you need more capacity.`);
  }
}

export async function recordUsage(
  db: Queryable,
  e: { orgId: string; userId?: string | null; agentId?: string | null; kind: UsageKind; quantity?: number; inputTokens?: number | null; outputTokens?: number | null },
) {
  await db.query(
    `insert into usage_events (org_id, user_id, agent_instance_id, kind, quantity, input_tokens, output_tokens)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [e.orgId, e.userId ?? null, e.agentId ?? null, e.kind, e.quantity ?? 1, e.inputTokens ?? null, e.outputTokens ?? null],
  );
  if (e.kind !== "agent_message") return;
  // Warn once per month when crossing the configured threshold.
  const s = await usageSummary(db, e.orgId);
  const pct = s.limits.monthly_agent_messages > 0 ? (s.agentMessages / s.limits.monthly_agent_messages) * 100 : 0;
  const previousPct = s.limits.monthly_agent_messages > 0 ? ((s.agentMessages - (e.quantity ?? 1)) / s.limits.monthly_agent_messages) * 100 : 0;
  if (pct >= s.limits.warn_at_percent && previousPct < s.limits.warn_at_percent) {
    const n = {
      kind: "usage_limit_approaching" as const,
      severity: "warning" as const,
      title: `AI usage is at ${Math.round(pct)}% of this month's limit`,
      body: `${s.agentMessages} of ${s.limits.monthly_agent_messages} AI messages used.`,
      link: "/settings/usage",
    };
    await notifyOrgRoles(db, e.orgId, ["owner", "admin"], n);
    await notifyAgency(db, e.orgId, { ...n, link: `/admin/clients/${e.orgId}` });
  }
}
