import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import type { AgentRoleKey } from "@/lib/agents";
import { evaluateRequirements, type WorkspaceFacts } from "@/lib/employee-requirements";
import { runtimeToolExposure } from "@/lib/employee-tool-policy";
import type { HealthSummary, ReadinessExtras } from "@/lib/workforce-readiness";
import { healthProbeSchemaReady } from "@/server/workforce/health-alerts";

// The workspace facts behind the role prerequisites, and the probe record behind "Degraded" / "Unavailable", read once per listing and handed to every screen as `readiness_extras`,
// so the gallery, the employee page, the chat header, the setup banner and the Super Admin all judge an employee from the same evidence (the pure rules are in
// src/lib/employee-requirements.ts and src/lib/workforce-readiness.ts). Read-only; trusted code: the caller has already authorized the person for `orgId`.

export async function loadWorkspaceFacts(db: Queryable, orgId: string): Promise<WorkspaceFacts> {
  const { rows } = await db.query<{
    knowledge: boolean; calendar: boolean; crm: boolean; pipeline: boolean; targeting: boolean; channel: boolean;
  }>(
    `with ws as (select coalesce((select mode from crm_workspaces where org_id = $1), 'native') as mode)
     select
       exists (select 1 from company_knowledge k where k.org_id = $1 and k.review_status = 'approved' and k.content <> '') as knowledge,
       (case when (select mode from ws) = 'native'
          then (select count(*) from crm_calendar_connections where org_id = $1 and status = 'connected')
             + (select count(*) from crm_calendars c where c.org_id = $1 and c.status = 'active' and c.archived_at is null
                  and exists (select 1 from crm_calendar_members m where m.calendar_id = c.id and m.org_id = c.org_id and m.active))
          else (select coalesce(sum(cardinality(calendar_ids)), 0) from ghl_location_mappings where org_id = $1 and status = 'connected')
        end) > 0 as calendar,
       (case when (select mode from ws) = 'native'
          then exists (select 1 from crm_blueprint_applications where org_id = $1 and status in ('applied', 'partially_applied'))
          else exists (select 1 from ghl_location_mappings where org_id = $1 and status = 'connected' and verified_at is not null)
        end) as crm,
       (exists (select 1 from crm_pipelines p where p.org_id = $1 and p.provider = 'native' and p.archived_at is null
                  and exists (select 1 from crm_pipeline_stages s where s.pipeline_id = p.id and s.org_id = p.org_id))
        or exists (select 1 from crm_pipelines p where p.org_id = $1 and p.provider <> 'native' and p.archived_at is null)) as pipeline,
       exists (select 1 from lead_targeting_profiles where org_id = $1 and criteria <> '{}'::jsonb) as targeting,
       exists (select 1 from messaging_channels where org_id = $1 and enabled) as channel`,
    [orgId],
  );
  const r = rows[0];
  return {
    knowledgeApproved: r?.knowledge === true,
    calendarReady: r?.calendar === true,
    crmReady: r?.crm === true,
    pipelineReady: r?.pipeline === true,
    leadTargetingSet: r?.targeting === true,
    customerChannelReady: r?.channel === true,
  };
}

interface HealthColumns {
  id: string;
  health_consecutive_failures: number;
  last_healthy_at: Date | null;
  last_health_failure_at: Date | null;
  last_probe_at: Date | null;
  last_probe_source: "scheduled" | "manual" | null;
}

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

/** What the probe has recorded for each employee, keyed by id. Empty before migration 0109. */
export async function loadHealthSummaries(db: Queryable, agentIds: string[]): Promise<Map<string, HealthSummary>> {
  const out = new Map<string, HealthSummary>();
  if (!agentIds.length || !(await healthProbeSchemaReady(db))) return out;
  const { rows } = await db.query<HealthColumns>(
    "select id, health_consecutive_failures, last_healthy_at, last_health_failure_at, last_probe_at, last_probe_source from agent_instances where id = any($1::uuid[])",
    [agentIds],
  );
  for (const r of rows) {
    out.set(r.id, {
      consecutiveFailures: r.health_consecutive_failures,
      lastHealthyAt: iso(r.last_healthy_at),
      lastFailureAt: iso(r.last_health_failure_at),
      lastProbeAt: iso(r.last_probe_at),
      lastProbeSource: r.last_probe_source,
    });
  }
  return out;
}

/** The tool names each employee's last verified inventory recorded (none for an employee with no inventory on record). */
async function loadRecordedToolNames(db: Queryable, agentIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!agentIds.length) return out;
  const { rows } = await db.query<{ id: string; tools: unknown }>("select id, tool_inventory_snapshot->'tools' as tools from agent_instances where id = any($1::uuid[]) and tool_inventory_digest is not null", [agentIds]);
  for (const r of rows) {
    if (!Array.isArray(r.tools)) continue;
    const names = r.tools.flatMap((t) => (t && typeof t === "object" && typeof (t as { name?: unknown }).name === "string" ? [(t as { name: string }).name] : []));
    if (names.length) out.set(r.id, names);
  }
  return out;
}

const SUSPENDED_TEXT: Record<string, string> = {
  suspended: "This workspace is suspended, so its AI employees are paused. Contact iAcquire to reopen it.",
  archived: "This workspace is archived, so its AI employees are not running.",
};

/** The readiness extras for every employee of one workspace. */
export async function readinessExtrasFor(orgId: string, agents: ReadonlyArray<{ id: string; role_key: AgentRoleKey }>): Promise<Map<string, ReadinessExtras>> {
  const out = new Map<string, ReadinessExtras>();
  if (!agents.length) return out;
  const { facts, health, org, tools } = await withSystem(async (db) => ({
    facts: await loadWorkspaceFacts(db, orgId),
    health: await loadHealthSummaries(db, agents.map((a) => a.id)),
    org: (await db.query<{ status: string; kind: string }>("select status, kind from organizations where id = $1", [orgId])).rows[0],
    tools: await loadRecordedToolNames(db, agents.map((a) => a.id)),
  }));
  const suspended = SUSPENDED_TEXT[org?.status ?? "active"] ? { reason: SUSPENDED_TEXT[org?.status ?? "active"] } : null;
  for (const a of agents) {
    // The role's tool policy applies to client employees; the internal agency employees run under their own acknowledged policy.
    const names = org?.kind === "client" ? tools.get(a.id) : undefined;
    const runtimeToolsExcess = names ? runtimeToolExposure(a.role_key, names).excess : null;
    out.set(a.id, { requirements: evaluateRequirements(a.role_key, facts, { runtimeToolsExcess }), health: health.get(a.id) ?? null, suspended });
  }
  return out;
}
