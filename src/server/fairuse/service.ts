import "server-only";
import { z } from "zod";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyAgency, notifyOrgRoles } from "@/server/notifications";
import { evaluateFairUse, FAIR_USE_METRICS, formatMetricValue, METRIC_INFO, type FairUseMetric, type FairUseState } from "@/lib/fair-use";
import type { OrgContext } from "@/server/tenancy/context";
import type { SessionUser } from "@/server/auth/service";

/** Measures a workspace from recorded usage, in one pass. Every number is a count of what is actually stored or recorded. */
export async function measureOrg(db: Queryable, orgId: string): Promise<Record<FairUseMetric, number>> {
  const { rows } = await db.query<Record<FairUseMetric, string>>(
    `select
       ((select coalesce(sum(size_bytes), 0) from private_files where org_id = $1 and status <> 'deleted')
         + (select coalesce(sum(octet_length(bytes)), 0) from website_asset_blobs where org_id = $1))::text as storage_bytes,
       (select coalesce(sum(bytes_served), 0) from website_usage_daily where org_id = $1 and day > current_date - 30)::text as site_bandwidth_bytes_30d,
       (select coalesce(sum(requests), 0) from website_usage_daily where org_id = $1 and day > current_date - 30)::text as site_requests_30d,
       ((select count(*) from agent_runs where org_id = $1 and started_at > now() - interval '30 days')
         + (select coalesce(sum(quantity), 0) from usage_events where org_id = $1 and kind = 'customer_reply' and created_at > now() - interval '30 days'))::text as ai_runs_30d,
       (select count(*) from lead_research_requests where org_id = $1 and created_at > now() - interval '30 days')::text as research_calls_30d,
       (select count(*) from conversation_messages where org_id = $1)::text as stored_messages`,
    [orgId],
  );
  return Object.fromEntries(FAIR_USE_METRICS.map((m) => [m, Number(rows[0][m])])) as Record<FairUseMetric, number>;
}

export interface EffectivePolicy {
  warn: number | null;
  limit: number | null;
  enforcement: "report_only" | "block_new";
  /** Whether this workspace has its own setting, as opposed to the platform default. */
  scope: "workspace" | "default" | "none";
  note: string | null;
}

/** The threshold in force: the workspace's own setting if it has one, otherwise the platform default, otherwise none. */
export async function effectivePolicy(db: Queryable, orgId: string, metric: FairUseMetric): Promise<EffectivePolicy> {
  const { rows } = await db.query<{ org_id: string | null; warn_value: string | null; limit_value: string | null; enforcement: "report_only" | "block_new"; note: string | null }>(
    "select org_id, warn_value::text, limit_value::text, enforcement, note from fair_use_policies where metric = $1 and (org_id = $2 or org_id is null) order by org_id nulls last limit 1",
    [metric, orgId],
  );
  const r = rows[0];
  if (!r) return { warn: null, limit: null, enforcement: "report_only", scope: "none", note: null };
  return { warn: r.warn_value === null ? null : Number(r.warn_value), limit: r.limit_value === null ? null : Number(r.limit_value), enforcement: r.enforcement, scope: r.org_id ? "workspace" : "default", note: r.note };
}

/**
 * Refuses NEW storage once a workspace is over a limit the agency set to block. It never deletes anything and never touches the website.
 * With no limit, or a limit that is report-only, this does nothing: nothing is blocked until the agency has chosen a number.
 */
export async function assertStorageAllowed(orgId: string, addBytes: number): Promise<void> {
  const verdict = await withSystem(async (db) => {
    const p = await effectivePolicy(db, orgId, "storage_bytes");
    if (p.enforcement !== "block_new" || p.limit === null) return null;
    const used = (await measureOrg(db, orgId)).storage_bytes;
    return used + addBytes > p.limit ? { used, limit: p.limit } : null;
  });
  if (verdict) throw new AppError("usage_limit", `Your file storage is full (${formatMetricValue("storage_bytes", verdict.used)} of ${formatMetricValue("storage_bytes", verdict.limit)}). Remove something, or contact iAcquire to talk about more space. Nothing you already have is affected.`);
}

export interface FairUseRow {
  metric: FairUseMetric;
  label: string;
  window: string;
  explain: string;
  value: number;
  valueText: string;
  state: FairUseState;
  warn: number | null;
  limit: number | null;
  limitText: string | null;
  enforcement: "report_only" | "block_new";
  measuredAt: string | null;
}

const toRow = (metric: FairUseMetric, value: number, p: EffectivePolicy, measuredAt: string | null): FairUseRow => ({
  metric, label: METRIC_INFO[metric].label, window: METRIC_INFO[metric].window, explain: METRIC_INFO[metric].explain, value, valueText: formatMetricValue(metric, value),
  state: evaluateFairUse(value, p.warn, p.limit), warn: p.warn, limit: p.limit, limitText: p.limit === null ? null : formatMetricValue(metric, p.limit), enforcement: p.enforcement, measuredAt,
});

/** What a client sees about its own usage: real measurements, the limit if one exists, and an honest "no limit set" if not. */
export async function getClientFairUse(ctx: OrgContext): Promise<FairUseRow[]> {
  if (!ctx.can("usage.view")) return [];
  // The thresholds are read on the client's behalf: the platform defaults aren't tied to any one workspace, so the client's own access rules can't show them,
  // yet they apply to the client and are exactly what it should be able to see.
  return withSystem(async (db) => {
    const measured = await measureOrg(db, ctx.org.orgId);
    const out: FairUseRow[] = [];
    for (const m of FAIR_USE_METRICS) out.push(toRow(m, measured[m], await effectivePolicy(db, ctx.org.orgId, m), new Date().toISOString()));
    return out;
  });
}

/**
 * Measures every active client, records where each stands, and tells people when that changes. The owner and managers hear about it in
 * plain words; the agency hears too. Each change is announced once. Nothing is stopped by this job.
 */
export async function runFairUseChecks(now = new Date()): Promise<{ checked: number; warnings: number; over: number }> {
  const orgs = await withSystem((db) => db.query<{ id: string; name: string }>("select id, name from organizations where kind = 'client' and status = 'active'"));
  const out = { checked: 0, warnings: 0, over: 0 };
  for (const org of orgs.rows) {
    await withSystem(async (db) => {
      const measured = await measureOrg(db, org.id);
      for (const metric of FAIR_USE_METRICS) {
        const p = await effectivePolicy(db, org.id, metric);
        const state = evaluateFairUse(measured[metric], p.warn, p.limit);
        const prior = (await db.query<{ notified_state: string | null }>("select notified_state from fair_use_status where org_id = $1 and metric = $2", [org.id, metric])).rows[0];
        // Announce only a worsening (ok to warning, warning to over). A fall back is recorded so the next worsening is announced again.
        const rank = { unset: 0, ok: 0, warning: 1, over: 2 } as const;
        const was = (prior?.notified_state ?? "ok") as "ok" | "warning" | "over";
        const notify = rank[state] > rank[was];
        const nextNotified = rank[state] >= rank[was] ? (notify ? state : was) : state === "unset" ? "ok" : state;
        await db.query(
          `insert into fair_use_status (org_id, metric, value, state, warn_value, limit_value, measured_at, notified_state) values ($1, $2, $3, $4, $5, $6, $7, $8)
           on conflict (org_id, metric) do update set value = excluded.value, state = excluded.state, warn_value = excluded.warn_value, limit_value = excluded.limit_value, measured_at = excluded.measured_at, notified_state = excluded.notified_state`,
          [org.id, metric, measured[metric], state, p.warn, p.limit, now.toISOString(), nextNotified],
        );
        out.checked += 1;
        if (state === "warning") out.warnings += 1;
        if (state === "over") out.over += 1;
        if (notify) {
          const info = METRIC_INFO[metric];
          const used = formatMetricValue(metric, measured[metric]);
          const limitText = p.limit === null ? "" : ` of ${formatMetricValue(metric, p.limit)}`;
          const word = state === "over" ? "gone past" : "are close to";
          await notifyOrgRoles(db, org.id, ["owner", "admin"], {
            kind: "fair_use_notice", severity: state === "over" ? "warning" : "info",
            title: `You ${word} your ${info.label.toLowerCase()} allowance`,
            body: `${used}${limitText} (${info.window}). ${info.canBlock && p.enforcement === "block_new" && state === "over" ? "New uploads are paused until there's room. Nothing you already have is affected." : "Nothing has been switched off. Talk to the iAcquire team if you expect to need more."}`,
            link: "/settings/usage", dedupeKey: `fairuse:${org.id}:${metric}:${state}:${now.toISOString().slice(0, 7)}`,
          });
          await notifyAgency(db, org.id, { kind: "fair_use_notice", severity: "info", title: `${org.name}: ${info.label.toLowerCase()} ${state === "over" ? "over its allowance" : "approaching its allowance"}`, body: `${used}${limitText} (${info.window}).`, link: `/admin/clients/${org.id}`, dedupeKey: `fairuse-agency:${org.id}:${metric}:${state}:${now.toISOString().slice(0, 7)}` });
        }
      }
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Agency side
// ---------------------------------------------------------------------------

export interface PolicyRow {
  id: string;
  orgId: string | null;
  orgName: string | null;
  metric: FairUseMetric;
  label: string;
  warn: number | null;
  limit: number | null;
  enforcement: "report_only" | "block_new";
  note: string | null;
}

export async function listPolicies(user: Pick<SessionUser, "id" | "platformRole">): Promise<PolicyRow[]> {
  const access = await withSystem((db) => db.query<{ allowed: boolean; agency_wide: boolean }>(
    `select coalesce(app.user_has_agency_permission($1,'usage.view'),false) as allowed,
            coalesce(app.user_has_agency_permission($1,'agency.security.manage'),false) as agency_wide`,
    [user.id],
  ));
  if (access.rows[0]?.allowed !== true) throw new AppError("forbidden", "Only agency staff can view fair-use thresholds.");
  const { rows } = await withSystem((db) =>
    db.query<{ id: string; org_id: string | null; name: string | null; metric: FairUseMetric; warn_value: string | null; limit_value: string | null; enforcement: "report_only" | "block_new"; note: string | null }>(
      `select p.id, p.org_id, o.name, p.metric, p.warn_value::text, p.limit_value::text, p.enforcement, p.note
       from fair_use_policies p left join organizations o on o.id = p.org_id
       where p.org_id is null or $2::boolean or app.user_can_access_org($1,p.org_id)
       order by p.org_id nulls first, p.metric`,
      [user.id, access.rows[0].agency_wide],
    ),
  );
  return rows.map((r) => ({ id: r.id, orgId: r.org_id, orgName: r.name, metric: r.metric, label: METRIC_INFO[r.metric].label, warn: r.warn_value === null ? null : Number(r.warn_value), limit: r.limit_value === null ? null : Number(r.limit_value), enforcement: r.enforcement, note: r.note }));
}

const policySchema = z.object({
  orgId: z.string().uuid().nullable(),
  metric: z.enum(FAIR_USE_METRICS),
  warn: z.number().int().min(0).nullable(),
  limit: z.number().int().min(0).nullable(),
  enforcement: z.enum(["report_only", "block_new"]).default("report_only"),
  note: z.string().trim().max(500).optional(),
});

/** Sets a threshold, for every workspace (orgId null) or one. Only a super admin can, and only storage can ever be set to block new uploads. */
export async function savePolicy(user: Pick<SessionUser, "id" | "platformRole">, input: z.input<typeof policySchema>): Promise<void> {
  if (user.platformRole !== "agency_super_admin") throw new AppError("forbidden", "Only super admins can set fair-use thresholds.");
  const d = policySchema.parse(input);
  if (d.warn !== null && d.limit !== null && d.warn > d.limit) throw new AppError("invalid_input", "The warning level can't be above the limit.");
  if (d.enforcement === "block_new" && !METRIC_INFO[d.metric].canBlock) throw new AppError("invalid_input", "Only file storage can be set to refuse new uploads. Other measures are reported, never switched off.");
  if (d.enforcement === "block_new" && d.limit === null) throw new AppError("invalid_input", "Choose a limit before refusing new uploads.");
  await withSystem(async (db) => {
    if (d.orgId) {
      const org = await db.query("select 1 from organizations where id = $1 and kind = 'client'", [d.orgId]);
      if (!org.rows[0]) throw new AppError("not_found", "Client not found.");
    }
    await db.query(
      `insert into fair_use_policies (org_id, metric, warn_value, limit_value, enforcement, note, updated_by) values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid), metric) do update set warn_value = excluded.warn_value, limit_value = excluded.limit_value, enforcement = excluded.enforcement,
         note = excluded.note, updated_by = excluded.updated_by, updated_at = now()`,
      [d.orgId, d.metric, d.warn, d.limit, d.enforcement, d.note ?? null, user.id],
    );
    await recordAudit({ orgId: d.orgId, actorUserId: user.id, actorKind: "agency", action: "fair_use.policy_set", targetType: "fair_use_policy", targetId: d.metric, result: "success", metadata: { warn: d.warn, limit: d.limit, enforcement: d.enforcement } }, db);
  });
}

export async function clearPolicy(user: Pick<SessionUser, "id" | "platformRole">, policyId: string): Promise<void> {
  if (user.platformRole !== "agency_super_admin") throw new AppError("forbidden", "Only super admins can change fair-use thresholds.");
  await withSystem(async (db) => {
    const res = await db.query<{ org_id: string | null; metric: string }>("delete from fair_use_policies where id = $1 returning org_id, metric", [policyId]);
    if (!res.rows[0]) throw new AppError("not_found", "Threshold not found.");
    await recordAudit({ orgId: res.rows[0].org_id, actorUserId: user.id, actorKind: "agency", action: "fair_use.policy_cleared", targetType: "fair_use_policy", targetId: res.rows[0].metric, result: "success" }, db);
  });
}

export interface FleetRow {
  orgId: string;
  name: string;
  metrics: Array<{ metric: FairUseMetric; valueText: string; state: FairUseState }>;
}

/** Latest recorded measurements across the clients this person looks after, so cost drivers are visible before limits are chosen. */
export async function fleetFairUse(user: Pick<SessionUser, "id" | "platformRole">): Promise<FleetRow[]> {
  const permission = await withSystem((db) => db.query<{ allowed: boolean }>(
    "select coalesce(app.user_has_agency_permission($1,'usage.view'),false) as allowed", [user.id],
  ));
  if (permission.rows[0]?.allowed !== true) throw new AppError("forbidden", "Only agency staff can view usage.");
  const { rows } = await withSystem((db) =>
    db.query<{ org_id: string; name: string; metric: FairUseMetric; value: string; state: FairUseState }>(
      `select o.id as org_id, o.name, s.metric, s.value::text, s.state
       from organizations o join fair_use_status s on s.org_id = o.id
       where o.kind = 'client' and app.user_can_access_org($1,o.id) order by o.name, s.metric`,
      [user.id],
    ),
  );
  const byOrg = new Map<string, FleetRow>();
  for (const r of rows) {
    const row = byOrg.get(r.org_id) ?? { orgId: r.org_id, name: r.name, metrics: [] };
    row.metrics.push({ metric: r.metric, valueText: formatMetricValue(r.metric, Number(r.value)), state: r.state });
    byOrg.set(r.org_id, row);
  }
  return [...byOrg.values()];
}
