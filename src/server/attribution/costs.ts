import "server-only";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { assertCan, auditActor, crmRead, crmWrite, type CrmActor } from "@/server/crm/actor";
import { normalizeSourceName, sourceLabel } from "@/lib/attribution/model";

// Campaign spend, as a person entered it. Nothing here is fetched from an advertising platform and nothing is estimated: cost per lead and return on spend
// exist only for a source and period where somebody typed a cost. Entering and removing costs is for the people who can export reports (owners and
// managers by default), and both are audited.

export const MAX_COST_ROWS = 500;

export interface CostEntry {
  id: string;
  source: string;
  label: string;
  campaign: string | null;
  periodStart: string;
  periodEnd: string;
  amount: number;
  currency: string;
  note: string | null;
  enteredBy: string | null;
  createdAt: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export async function addCost(
  actor: CrmActor,
  input: { source: string; campaign?: string | null; periodStart: string; periodEnd: string; amount: number; currency: string; note?: string | null },
): Promise<CostEntry> {
  assertCan(actor, "analytics.export", "Only people who can export reports can enter campaign costs.");
  const source = normalizeSourceName(input.source, 80);
  if (!source) throw new AppError("invalid_input", "Choose the source this cost belongs to, for example google or facebook.");
  if (!DAY.test(input.periodStart) || !DAY.test(input.periodEnd) || Number.isNaN(Date.parse(input.periodStart)) || Number.isNaN(Date.parse(input.periodEnd))) throw new AppError("invalid_input", "Enter the first and last day the cost covers.");
  const days = (Date.parse(input.periodEnd) - Date.parse(input.periodStart)) / 86_400_000;
  if (days < 0) throw new AppError("invalid_input", "The last day cannot be before the first day.");
  if (days > 366) throw new AppError("invalid_input", "A cost can cover at most a year. Split longer spending into periods.");
  if (!Number.isFinite(input.amount) || input.amount < 0 || input.amount >= 100_000_000) throw new AppError("invalid_input", "Enter the amount spent as a positive number.");
  const currency = input.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new AppError("invalid_input", "Use a three-letter currency code, such as USD.");
  const campaign = input.campaign?.replace(/\s+/g, " ").trim().slice(0, 120) || null;
  const note = input.note?.replace(/\s+/g, " ").trim().slice(0, 300) || null;
  return crmWrite(actor, async (db) => {
    const count = await db.query<{ n: string }>("select count(*)::text as n from attribution_costs where org_id = $1", [actor.orgId]);
    if (Number(count.rows[0].n) >= MAX_COST_ROWS) throw new AppError("usage_limit", `A workspace can keep up to ${MAX_COST_ROWS} cost entries. Remove old ones first.`);
    const { rows } = await db.query<{ id: string; created_at: Date }>(
      "insert into attribution_costs (org_id, source, campaign, period_start, period_end, amount, currency, note, entered_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id, created_at",
      [actor.orgId, source, campaign, input.periodStart, input.periodEnd, Math.round(input.amount * 100) / 100, currency, note, actor.userId],
    );
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "attribution.cost_entered", targetType: "attribution_cost", targetId: rows[0].id, result: "success", metadata: { source, currency } }, db);
    return { id: rows[0].id, source, label: sourceLabel(source), campaign, periodStart: input.periodStart, periodEnd: input.periodEnd, amount: Math.round(input.amount * 100) / 100, currency, note, enteredBy: actor.userId, createdAt: new Date(rows[0].created_at).toISOString() };
  });
}

export async function removeCost(actor: CrmActor, id: string): Promise<void> {
  assertCan(actor, "analytics.export", "Only people who can export reports can remove campaign costs.");
  await crmWrite(actor, async (db) => {
    const r = await db.query("delete from attribution_costs where id = $1 and org_id = $2 returning id", [id, actor.orgId]);
    if (!r.rows[0]) throw new AppError("not_found", "That cost entry was not found.");
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "attribution.cost_removed", targetType: "attribution_cost", targetId: id, result: "success" }, db);
  });
}

export async function listCosts(actor: CrmActor): Promise<CostEntry[]> {
  if (!actor.can("analytics.view")) throw new AppError("forbidden", "Your role can't see reports.");
  return crmRead(actor, async (db) => {
    const { rows } = await db.query<{ id: string; source: string; campaign: string | null; period_start: string; period_end: string; amount: string; currency: string; note: string | null; entered_by: string | null; created_at: Date }>(
      "select id, source, campaign, to_char(period_start, 'YYYY-MM-DD') as period_start, to_char(period_end, 'YYYY-MM-DD') as period_end, amount::text as amount, currency, note, entered_by, created_at from attribution_costs where org_id = $1 order by period_start desc, created_at desc limit 200",
      [actor.orgId],
    );
    return rows.map((r) => ({ id: r.id, source: r.source, label: sourceLabel(r.source), campaign: r.campaign, periodStart: r.period_start, periodEnd: r.period_end, amount: Number(r.amount), currency: r.currency, note: r.note, enteredBy: r.entered_by, createdAt: new Date(r.created_at).toISOString() }));
  });
}

/** The sources that appear in this workspace's touch history, for the cost form's list. */
export async function sourcesSeen(actor: CrmActor): Promise<Array<{ source: string; label: string }>> {
  return crmRead(actor, async (db) => {
    const { rows } = await db.query<{ source: string }>("select source from lead_touches where org_id = $1 and source <> 'unknown' group by source order by count(*) desc limit 40", [actor.orgId]);
    return rows.map((r) => ({ source: r.source, label: sourceLabel(r.source) }));
  });
}
