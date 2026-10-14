import "server-only";
import { withUser } from "@/server/db";
import { sourceAvailability } from "@/server/queries/dashboard";
import type { OrgContext } from "@/server/tenancy/context";

export interface Range {
  from: Date;
  to: Date;
  days: number;
}

export function parseRange(params: { range?: string; from?: string; to?: string }): Range {
  const to = new Date();
  if (params.range === "custom" && params.from && params.to) {
    const f = new Date(`${params.from}T00:00:00Z`);
    const t = new Date(`${params.to}T23:59:59Z`);
    if (!Number.isNaN(f.getTime()) && !Number.isNaN(t.getTime()) && f <= t && t.getTime() - f.getTime() <= 366 * 86400000) {
      return { from: f, to: t, days: Math.ceil((t.getTime() - f.getTime()) / 86400000) };
    }
  }
  const days = params.range === "7d" ? 7 : params.range === "90d" ? 90 : 30;
  return { from: new Date(to.getTime() - days * 86400000), to, days };
}

export async function getAnalytics(ctx: OrgContext, range: Range) {
  const tz = ctx.org.timezone;
  return withUser(ctx.user.id, async (db) => {
    const org = ctx.org.orgId;
    const sources = await sourceAvailability(db, org, ctx.org.isDemo);
    const p = [org, range.from.toISOString(), range.to.toISOString()];
    const one = async (sql: string, params: unknown[] = p) => Number((await db.query<{ n: number | string | null }>(sql, params)).rows[0]?.n ?? 0);

    // Leads
    const leadsByDay = await db.query<{ day: string; n: number }>(
      `select to_char(date_trunc('day', created_at at time zone $4), 'YYYY-MM-DD') as day, count(*)::int as n
       from leads where org_id = $1 and created_at between $2 and $3 group by 1 order by 1`,
      [...p, tz],
    );
    const leadTotals = await db.query<{ total: number; approved: number; rejected: number; reviewed: number; avg_score: string | null; with_sources: number }>(
      `select count(*)::int as total,
              count(*) filter (where review_status = 'approved')::int as approved,
              count(*) filter (where review_status = 'rejected')::int as rejected,
              count(*) filter (where review_status <> 'pending')::int as reviewed,
              avg(score)::numeric(6,1)::text as avg_score,
              count(*) filter (where jsonb_array_length(evidence) >= 2)::int as with_sources
       from leads where org_id = $1 and created_at between $2 and $3`,
      p,
    );
    const bySource = await db.query<{ source: string; total: number; approved: number; avg_score: string | null }>(
      `select source_platform as source, count(*)::int as total, count(*) filter (where review_status = 'approved')::int as approved, avg(score)::numeric(6,1)::text as avg_score
       from leads where org_id = $1 and created_at between $2 and $3 group by 1 order by 2 desc`,
      p,
    );

    // Appointments
    const appts = sources.calendar
      ? (
          await db.query<{ booked: number; showed: number; noshow: number; cancelled: number }>(
            `select count(*) filter (where status in ('new','confirmed','showed','noshow'))::int as booked,
                    count(*) filter (where status = 'showed')::int as showed,
                    count(*) filter (where status = 'noshow')::int as noshow,
                    count(*) filter (where status = 'cancelled')::int as cancelled
             from appointment_refs where org_id = $1 and start_at between $2 and $3`,
            p,
          )
        ).rows[0]
      : null;

    // Sales
    const sales = sources.crm
      ? {
          stages: (
            await db.query<{ stage: string; n: number; value: string | null }>(
              `select coalesce(stage_name, 'Unknown stage') as stage, count(*)::int as n, sum(monetary_value)::text as value
               from crm_opportunities where org_id = $1 and status = 'open' group by 1 order by 2 desc`,
              [org],
            )
          ).rows,
          won: await one("select count(*)::int as n from crm_opportunities where org_id = $1 and status = 'won' and coalesce(remote_updated_at, synced_at) between $2 and $3"),
          lost: await one("select count(*)::int as n from crm_opportunities where org_id = $1 and status = 'lost' and coalesce(remote_updated_at, synced_at) between $2 and $3"),
          wonValue: await one("select coalesce(sum(monetary_value), 0)::text as n from crm_opportunities where org_id = $1 and status = 'won' and coalesce(remote_updated_at, synced_at) between $2 and $3"),
        }
      : null;

    // AI workforce
    const runsByAgent = await db.query<{ role_key: string; total: number; completed: number; failed: number; tokens: number }>(
      `select a.role_key, count(r.id)::int as total,
              count(r.id) filter (where r.status = 'completed')::int as completed,
              count(r.id) filter (where r.status in ('failed','timeout','interrupted'))::int as failed,
              coalesce(sum(r.total_tokens), 0)::int as tokens
       from agent_instances a left join agent_runs r on r.agent_instance_id = a.id and r.started_at between $2 and $3
       where a.org_id = $1 group by a.role_key`,
      p,
    );
    const toolSteps = await one("select count(*)::int as n from tool_executions t join agent_runs r on r.id = t.run_id where t.org_id = $1 and r.started_at between $2 and $3");
    const cancelled = await one("select count(*)::int as n from agent_runs where org_id = $1 and status = 'cancelled' and started_at between $2 and $3");

    // Approvals / workflow execution
    const exec = (
      await db.query<{ succeeded: number; blocked: number; failed: number; rejected: number; expired: number }>(
        `select count(*) filter (where execution_status = 'succeeded')::int as succeeded,
                count(*) filter (where execution_status = 'blocked')::int as blocked,
                count(*) filter (where execution_status = 'failed')::int as failed,
                count(*) filter (where status = 'rejected')::int as rejected,
                count(*) filter (where status = 'expired')::int as expired
         from approval_requests where org_id = $1 and created_at between $2 and $3`,
        p,
      )
    ).rows[0];

    // Usage
    const usage = (
      await db.query<{ messages: number; tokens: number; research: number; help: number }>(
        `select coalesce(sum(quantity) filter (where kind = 'agent_message'), 0)::int as messages,
                coalesce(sum(coalesce(input_tokens,0) + coalesce(output_tokens,0)), 0)::int as tokens,
                coalesce(sum(quantity) filter (where kind = 'lead_research'), 0)::int as research,
                coalesce(sum(quantity) filter (where kind = 'help_request'), 0)::int as help
         from usage_events where org_id = $1 and created_at between $2 and $3`,
        p,
      )
    ).rows[0];
    const messagesByDay = await db.query<{ day: string; n: number }>(
      `select to_char(date_trunc('day', created_at at time zone $4), 'YYYY-MM-DD') as day, coalesce(sum(quantity),0)::int as n
       from usage_events where org_id = $1 and kind = 'agent_message' and created_at between $2 and $3 group by 1 order by 1`,
      [...p, tz],
    );

    // Retention
    const retention = (
      await db.query<{ total: number; active: number; at_risk: number; churned: number }>(
        `select count(*)::int as total, count(*) filter (where status = 'active')::int as active,
                count(*) filter (where status = 'at_risk' or health = 'at_risk')::int as at_risk,
                count(*) filter (where status = 'churned')::int as churned
         from retention_accounts where org_id = $1`,
        [org],
      )
    ).rows[0];

    return {
      sources,
      leads: { byDay: leadsByDay.rows, totals: leadTotals.rows[0], bySource: bySource.rows },
      appointments: appts,
      sales,
      workforce: { byAgent: runsByAgent.rows, toolSteps, cancelled },
      execution: exec,
      usage,
      messagesByDay: messagesByDay.rows,
      retention,
    };
  });
}

/** Fills missing days so day series are continuous in the workspace time zone. */
export function fillDays(rows: Array<{ day: string; n: number }>, range: Range, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const map = new Map(rows.map((r) => [r.day, Number(r.n)]));
  const out: Array<{ day: string; n: number }> = [];
  const seen = new Set<string>();
  for (let t = range.from.getTime(); t <= range.to.getTime() + 1; t += 86400000) {
    const d = fmt.format(new Date(t));
    if (seen.has(d)) continue;
    seen.add(d);
    out.push({ day: d, n: map.get(d) ?? 0 });
  }
  return out;
}
