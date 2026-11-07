import "server-only";

import { z } from "zod";
import {
  GROWTH_PARTNER_GOAL_DEFINITIONS,
  growthPartnerGoalEnabledSchema,
  growthPartnerGoalSaveSchema,
  type GrowthPartnerGoalCadence,
  type GrowthPartnerGoalMetric,
  type GrowthPartnerGoalProgress,
} from "@/lib/ai-growth-partner-goals";
import { recordAudit } from "@/server/audit";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import type { OrgContext } from "@/server/tenancy/context";

const HOST_UNCONFIRMED = "exists (select 1 from appointment_refs r where r.id = b.appointment_id and r.org_id = b.org_id and r.provider = 'native' and r.status = 'new')";

type GoalRow = {
  id: string;
  metric_key: GrowthPartnerGoalMetric;
  cadence: GrowthPartnerGoalCadence;
  target_value: number;
  enabled: boolean;
  revision: number;
  updated_at: Date;
};

function requireClient(ctx: OrgContext) {
  if (ctx.org.kind !== "client") throw new AppError("forbidden", "Growth Partner goals are available in client workspaces.");
}

function requireManage(ctx: OrgContext) {
  requireClient(ctx);
  if (!ctx.can("agents.configure")) throw new AppError("forbidden", "Only workspace owners and admins can change Growth Partner goals.");
}

function parseInput<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new AppError("invalid_input", "Check the goal metric, period and target value.");
  return parsed.data;
}

async function partnerId(db: Queryable, orgId: string): Promise<string> {
  const row = (await db.query<{ id: string }>("select id from ai_growth_partners where org_id = $1 for update", [orgId])).rows[0];
  if (!row) throw new AppError("not_found", "Set up the AI Growth Partner before adding a target.");
  return row.id;
}

export async function listGrowthPartnerGoalProgress(ctx: OrgContext): Promise<GrowthPartnerGoalProgress[]> {
  requireClient(ctx);
  if (!ctx.can("agents.use")) throw new AppError("forbidden", "You don't have access to Growth Partner goals.");
  const goals = await withUser(ctx.user.id, async (db) => (await db.query<GoalRow>(
    `select id, metric_key, cadence, target_value, enabled, revision, updated_at
       from ai_growth_partner_goals where org_id = $1
       order by metric_key, cadence`,
    [ctx.org.orgId],
  )).rows);
  if (!goals.length) return [];

  const bounds = await withSystem(async (db) => {
    const rows = await db.query<{ week_start: Date; month_start: Date; period_end: Date }>(
      `select timezone(coalesce(nullif(timezone, ''), 'UTC'), date_trunc('week', timezone(coalesce(nullif(timezone, ''), 'UTC'), now()))) as week_start,
              timezone(coalesce(nullif(timezone, ''), 'UTC'), date_trunc('month', timezone(coalesce(nullif(timezone, ''), 'UTC'), now()))) as month_start,
              now() as period_end
         from organizations where id = $1`,
      [ctx.org.orgId],
    );
    return rows.rows[0] ?? null;
  });
  if (!bounds) throw new AppError("not_found", "The workspace time zone is unavailable.");

  const sqlByMetric: Record<GrowthPartnerGoalMetric, string> = {
    leads_created: "select count(*)::int as value from leads where org_id = $1 and created_at >= $2 and created_at < $3",
    leads_approved: "select count(*)::int as value from leads where org_id = $1 and review_status = 'approved' and reviewed_at >= $2 and reviewed_at < $3",
    appointments_booked: `select count(*)::int as value from appointment_bookings b where b.org_id = $1 and b.status = 'booked' and b.booked_at >= $2 and b.booked_at < $3 and not ${HOST_UNCONFIRMED}`,
    deals_won: "select count(*)::int as value from crm_opportunities where org_id = $1 and status = 'won' and closed_at >= $2 and closed_at < $3",
  };
  const results: GrowthPartnerGoalProgress[] = [];
  for (const goal of goals) {
    const permission = GROWTH_PARTNER_GOAL_DEFINITIONS[goal.metric_key].permission;
    const canViewProgress = ctx.can(permission);
    const start = goal.cadence === "weekly" ? bounds.week_start : bounds.month_start;
    const actualValue = canViewProgress && goal.enabled
      ? await withSystem(async (db) => {
          const rows = await db.query<{ value: number }>(sqlByMetric[goal.metric_key], [ctx.org.orgId, start, bounds.period_end]);
          const value = Number(rows.rows[0]?.value ?? 0);
          return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
        })
      : null;
    const targetValue = Number(goal.target_value);
    results.push({
      id: goal.id,
      metric: goal.metric_key,
      metricLabel: GROWTH_PARTNER_GOAL_DEFINITIONS[goal.metric_key].label,
      cadence: goal.cadence,
      targetValue,
      enabled: goal.enabled,
      revision: Number(goal.revision),
      updatedAt: goal.updated_at,
      actualValue,
      percentComplete: actualValue === null ? null : Math.min(100, Math.round((actualValue / targetValue) * 100)),
      remainingValue: actualValue === null ? null : Math.max(0, targetValue - actualValue),
      periodLabel: goal.cadence === "weekly" ? "This week" : "This month",
      canViewProgress,
    });
  }
  return results;
}

export async function saveGrowthPartnerGoal(ctx: OrgContext, raw: unknown): Promise<{ id: string; revision: number }> {
  requireManage(ctx);
  const input = parseInput(growthPartnerGoalSaveSchema, raw);
  return withSystem(async (db) => {
    const partner = await partnerId(db, ctx.org.orgId);
    const saved = (await db.query<{ id: string; revision: number }>(
      `insert into ai_growth_partner_goals (org_id, partner_id, metric_key, cadence, target_value, enabled, revision, created_by, updated_by)
       values ($1, $2, $3, $4, $5, true, 1, $6, $6)
       on conflict (org_id, partner_id, metric_key, cadence) do update
         set target_value = excluded.target_value, enabled = true, revision = ai_growth_partner_goals.revision + 1, updated_by = excluded.updated_by, updated_at = now()
       where $7::integer is not null and ai_growth_partner_goals.revision = $7
       returning id, revision`,
      [ctx.org.orgId, partner, input.metric, input.cadence, input.targetValue, ctx.user.id, input.baseRevision],
    )).rows[0];
    if (!saved) throw new AppError("conflict", "This goal changed in another session. Refresh the page before saving it again.");
    await recordAudit({
      orgId: ctx.org.orgId,
      actorUserId: ctx.user.id,
      actorKind: "user",
      action: input.baseRevision === null ? "ai_growth_partner.goal_created" : "ai_growth_partner.goal_updated",
      targetType: "ai_growth_partner_goal",
      targetId: saved.id,
      result: "success",
      metadata: { metric: input.metric, cadence: input.cadence, targetValue: input.targetValue, revision: Number(saved.revision) },
    }, db);
    return { id: saved.id, revision: Number(saved.revision) };
  });
}

export async function setGrowthPartnerGoalEnabled(ctx: OrgContext, raw: unknown): Promise<{ id: string; revision: number; enabled: boolean }> {
  requireManage(ctx);
  const input = parseInput(growthPartnerGoalEnabledSchema, raw);
  return withSystem(async (db) => {
    const partner = await partnerId(db, ctx.org.orgId);
    const saved = (await db.query<{ id: string; revision: number; enabled: boolean; metric_key: GrowthPartnerGoalMetric; cadence: GrowthPartnerGoalCadence }>(
      `update ai_growth_partner_goals
          set enabled = $4, revision = revision + 1, updated_by = $5, updated_at = now()
        where id = $1 and org_id = $2 and partner_id = $3 and revision = $6 and enabled <> $4
        returning id, revision, enabled, metric_key, cadence`,
      [input.goalId, ctx.org.orgId, partner, input.enabled, ctx.user.id, input.baseRevision],
    )).rows[0];
    if (!saved) throw new AppError("conflict", "This goal changed in another session. Refresh the page before changing it again.");
    await recordAudit({
      orgId: ctx.org.orgId,
      actorUserId: ctx.user.id,
      actorKind: "user",
      action: saved.enabled ? "ai_growth_partner.goal_enabled" : "ai_growth_partner.goal_paused",
      targetType: "ai_growth_partner_goal",
      targetId: saved.id,
      result: "success",
      metadata: { metric: saved.metric_key, cadence: saved.cadence, revision: Number(saved.revision) },
    }, db);
    return { id: saved.id, revision: Number(saved.revision), enabled: saved.enabled };
  });
}

/** Monthly goal comparison used by a monthly Performance Snapshot; only exact measured KPI keys are attached. */
export async function growthPartnerMonthlyGoalTargets(db: Queryable, orgId: string) {
  const { rows } = await db.query<{ metric_key: GrowthPartnerGoalMetric; target_value: number }>(
    `select metric_key, target_value from ai_growth_partner_goals
      where org_id = $1 and cadence = 'monthly' and enabled`,
    [orgId],
  );
  return new Map(rows.map((row) => [row.metric_key, Number(row.target_value)]));
}

/** Small, bounded goal context for the tenant's linked runtime only. Progress stays in reports so the model never guesses a current count. */
export async function growthPartnerGoalPromptContext(db: Queryable, orgId: string, agentId: string): Promise<string> {
  const { rows } = await db.query<{ metric_key: GrowthPartnerGoalMetric; cadence: GrowthPartnerGoalCadence; target_value: number }>(
    `select g.metric_key, g.cadence, g.target_value
       from ai_growth_partner_goals g
       join ai_growth_partners p on p.id = g.partner_id and p.org_id = g.org_id
      where g.org_id = $1 and p.runtime_agent_instance_id = $2 and g.enabled
      order by g.metric_key, g.cadence limit 8`,
    [orgId, agentId],
  );
  if (!rows.length) return "";
  const goals = rows.map((row) => `- ${GROWTH_PARTNER_GOAL_DEFINITIONS[row.metric_key].label}: ${Number(row.target_value)} per ${row.cadence === "weekly" ? "week" : "month"}.`).join("\n");
  return [
    "WORKSPACE GROWTH GOALS — These are client-set objectives, not promises or guaranteed outcomes. Do not claim current progress unless a measured report supplies it. They never override permissions, approvals or saved policies.",
    goals,
  ].join("\n");
}
