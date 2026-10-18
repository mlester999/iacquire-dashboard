import "server-only";
import { crmRead } from "@/server/crm/actor";
import { getPipelineMetrics } from "@/server/crm/opportunities";
import { byCurrency, num, ownerNote, pct, type ReportScope } from "@/server/crm/reports/scope";
import type { DealsReport, PipelineReport, SectionResult } from "@/components/crm/reports/types";

const VIA_LABELS: Record<string, string> = {
  manual: "Added by hand", import: "Import", form: "Form", booking: "Booking", api: "API", agent: "AI employee", workflow: "Automation", ghl_migration: "GoHighLevel migration", unknown: "Not recorded",
};

// Native deals only (GoHighLevel copies are excluded); archived deals are left out, as everywhere else in the CRM.
// $1 org, $2 member (deal owner), $3 source (the contact's created via), $4 pipeline; $5 and $6 the period. Every query names all it is given.
const JOIN = "from crm_opportunities o left join contacts c on c.id = o.contact_id and c.org_id = o.org_id";
const WHERE = `where o.org_id = $1 and o.provider = 'native' and o.archived_at is null
    and ($2::uuid is null or o.assigned_user_id = $2) and ($3::text is null or c.created_via = $3) and ($4::uuid is null or o.pipeline_ref = $4)`;
const CREATED = "o.created_at >= $5 and o.created_at < $6";
const CLOSED = "o.closed_at >= $5 and o.closed_at < $6";

/**
 * Deals & revenue: deals created in the period, deals won and lost in it (by the date they closed), and the value recorded on them, always
 * per currency. Open deals are a snapshot of now. Every filter applies: owner, the contact's lead source, and pipeline.
 */
export async function dealsSection(scope: ReportScope): Promise<SectionResult<"deals">> {
  const { actor, filters: f } = scope;
  const data = await crmRead(actor, async (db) => {
    const base = [actor.orgId, f.member ?? null, f.source ?? null, f.pipeline ?? null];
    const p = [...base, scope.startsAt, scope.endsAt];
    type Agg = { currency: string | null; n: string; total: string | null; novalue: string };
    const agg = (cond: string) =>
      db.query<Agg>(`select o.currency, count(*)::text as n, sum(o.monetary_value)::text as total, count(*) filter (where o.monetary_value is null)::text as novalue ${JOIN} ${WHERE} and ${cond} group by o.currency`, p);
    const created = await agg(CREATED);
    const won = await agg(`o.status = 'won' and ${CLOSED}`);
    const lost = await agg(`o.status = 'lost' and ${CLOSED}`);
    const open = await db.query<Agg>(`select o.currency, count(*)::text as n, sum(o.monetary_value)::text as total, '0' as novalue ${JOIN} ${WHERE} and o.status = 'open' group by o.currency`, base);
    const owners = await db.query<{ id: string | null; name: string | null; created: string; won: string; lost: string }>(
      `select o.assigned_user_id::text as id, nullif(u.full_name, '') as name,
              count(*) filter (where ${CREATED})::text as created,
              count(*) filter (where o.status = 'won' and ${CLOSED})::text as won,
              count(*) filter (where o.status = 'lost' and ${CLOSED})::text as lost
       ${JOIN} left join users u on u.id = o.assigned_user_id ${WHERE} and ((${CREATED}) or (o.status in ('won', 'lost') and ${CLOSED}))
       group by o.assigned_user_id, u.full_name order by count(*) desc, 2 limit 25`,
      p,
    );
    const ownerValue = await db.query<{ id: string | null; currency: string; total: string | null }>(
      `select o.assigned_user_id::text as id, o.currency, sum(o.monetary_value)::text as total ${JOIN} ${WHERE} and o.status = 'won' and ${CLOSED} group by 1, 2`,
      p,
    );
    const via = await db.query<{ via: string; created: string; won: string }>(
      `select coalesce(o.created_via, 'unknown') as via, count(*) filter (where ${CREATED})::text as created, count(*) filter (where o.status = 'won' and ${CLOSED})::text as won
       ${JOIN} ${WHERE} and ((${CREATED}) or (o.status = 'won' and ${CLOSED})) group by 1 order by count(*) desc`,
      p,
    );
    const reasons = await db.query<{ reason: string; n: string }>(
      `select coalesce(nullif(btrim(o.lost_reason), ''), '') as reason, count(*)::text as n ${JOIN} ${WHERE} and o.status = 'lost' and ${CLOSED} group by 1 order by count(*) desc, 1 limit 10`,
      p,
    );
    const count = (r: { rows: Agg[] }) => r.rows.reduce((n, x) => n + num(x.n), 0);
    const wonN = count(won);
    const lostN = count(lost);
    return {
      created: count(created),
      won: wonN,
      lost: lostN,
      winRate: pct(wonN, wonN + lostN),
      wonValue: byCurrency(won.rows),
      lostValue: byCurrency(lost.rows),
      createdValue: byCurrency(created.rows),
      openNow: count(open),
      openValueNow: byCurrency(open.rows),
      wonWithoutValue: won.rows.reduce((n, x) => n + num(x.novalue), 0),
      byOwner: owners.rows.map((r) => ({
        key: r.id ?? "none", label: r.id ? (r.name ?? "Former team member") : "Unassigned", created: num(r.created), won: num(r.won), lost: num(r.lost),
        wonValue: byCurrency(ownerValue.rows.filter((v) => v.id === r.id)),
      })),
      byCreatedVia: via.rows.map((r) => ({ key: r.via, label: VIA_LABELS[r.via] ?? r.via, created: num(r.created), won: num(r.won) })),
      lostReasons: reasons.rows.map((r) => ({ key: r.reason || "(none)", label: r.reason || "No reason recorded", count: num(r.n) })),
    } satisfies DealsReport;
  });
  return {
    section: "deals",
    data,
    empty: data.created === 0 && data.won === 0 && data.lost === 0 && data.openNow === 0,
    ignored: [],
    notes: ownerNote(scope, "opportunities", "opportunities"),
  };
}

/** Pipelines computed when no pipeline is chosen. More are listed by count, not computed, so a report stays quick. */
export const PIPELINES_SHOWN = 4;

/**
 * Pipeline conversion: for each native pipeline, open deals by stage (count and value per currency), deals created, won and lost in the
 * period, win rate, weighted forecast, and how long deals stayed in each stage before moving on. Computed by getPipelineMetrics, the same
 * numbers the pipeline screens use.
 */
export async function pipelineSection(scope: ReportScope): Promise<SectionResult<"pipeline">> {
  const { actor, filters: f } = scope;
  const list = await crmRead(actor, (db) =>
    db.query<{ id: string; name: string; is_default: boolean }>(
      `select id, name, is_default from crm_pipelines where org_id = $1 and provider = 'native' and archived_at is null and ($2::uuid is null or id = $2) order by is_default desc, position, lower(name)`,
      [actor.orgId, f.pipeline ?? null],
    ),
  );
  const shown = list.rows.slice(0, PIPELINES_SHOWN);
  const pipelines: PipelineReport["pipelines"] = [];
  // getPipelineMetrics treats both ends as inclusive; the report's end is the first instant after the period.
  const period = { from: scope.startsAt, to: new Date(scope.endsAt.getTime() - 1) };
  for (const pl of shown) {
    const m = await getPipelineMetrics(actor, pl.id, period);
    pipelines.push({
      id: pl.id,
      name: pl.name,
      isDefault: pl.is_default,
      created: m.createdCount,
      won: m.wonCount,
      lost: m.lostCount,
      winRate: m.winRate,
      wonValue: m.wonValue,
      openValue: m.openValue,
      weightedForecast: m.weightedForecast,
      dealsWithoutProbability: m.dealsWithoutProbability,
      stages: m.byStage.map((s) => ({ id: s.stageId, name: s.name, kind: s.kind, open: s.count, value: s.totals, probability: s.probability, avgDaysInStage: s.avgDaysInStage })),
    });
  }
  const data: PipelineReport = { pipelines, more: Math.max(0, list.rows.length - shown.length) };
  return {
    section: "pipeline",
    data,
    empty: pipelines.every((p) => p.created === 0 && p.won === 0 && p.lost === 0 && p.stages.every((s) => s.open === 0)),
    ignored: [],
    notes: ownerNote(scope, "opportunities", "opportunities"),
  };
}
