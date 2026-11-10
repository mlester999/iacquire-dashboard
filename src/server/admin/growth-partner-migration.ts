import "server-only";
import { AGENT_ROLE_KEYS } from "@/lib/agents";
import { capabilityDefinition } from "@/lib/workforce-capabilities";
import { recordAudit } from "@/server/audit";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";

const OPEN_WORK_STATUSES = ["queued", "running", "waiting_for_approval", "blocked"] as const;

export interface GrowthPartnerScheduleMigrationPreview {
  generatedAt: string;
  summary: {
    total: number;
    enabled: number;
    potentiallySupported: number;
    openWorkItems: number;
    partnerScheduleMatches: number;
    dueSchedules: number;
  };
  openWorkItems: Array<{
    id: string;
    legacyRole: (typeof AGENT_ROLE_KEYS)[number];
    capability: string;
    status: string;
    idempotencyKey: string;
    scheduleId: string | null;
  }>;
  schedules: Array<{
    id: string;
    legacyRole: (typeof AGENT_ROLE_KEYS)[number];
    capability: string;
    capabilityLabel: string;
    cadence: string;
    intervalMinutes: number;
    timezone: string;
    enabled: boolean;
    nextRunAt: string;
    lastRunAt: string | null;
    due: boolean;
    potentiallySupportedByGrowthPartner: boolean;
    matchingGrowthPartnerSchedule: boolean;
    openWorkItemsForCapability: number;
  }>;
}

/**
 * Read-only, tenant-scoped schedule reconciliation preview for a future Growth Partner cutover.
 * It exposes schedule metadata and open-work identifiers/statuses, but never saved assignment text. It does not
 * write audit rows or change schedules, jobs, profiles, or partner setup.
 */
export async function previewGrowthPartnerScheduleMigration(
  orgId: string,
): Promise<GrowthPartnerScheduleMigrationPreview> {
  return withSystem(async (db) => {
    const org = (await db.query<{ kind: string; status: string }>(
      "select kind, status from organizations where id = $1",
      [orgId],
    )).rows[0];
    if (!org) throw new AppError("not_found", "Client workspace not found.");
    if (org.kind !== "client" || org.status !== "active") {
      throw new AppError("conflict", "Schedule migration review is available only for active client workspaces.");
    }

    const rows = (await db.query<{
      id: string;
      legacy_role: (typeof AGENT_ROLE_KEYS)[number];
      capability: string;
      cadence: string;
      interval_minutes: number;
      timezone: string;
      enabled: boolean;
      next_run_at: Date | string;
      last_run_at: Date | string | null;
      due: boolean;
      matching_growth_partner_schedule: boolean;
      open_work_items_for_capability: number;
    }>(
      `select s.id, a.role_key as legacy_role, s.capability, s.cadence, s.interval_minutes,
              s.timezone, s.enabled, s.next_run_at, s.last_run_at,
              (s.enabled and s.next_run_at <= now()) as due,
              exists (
                select 1
                  from ai_work_schedules partner_schedule
                  join agent_instances partner on partner.id = partner_schedule.agent_instance_id
                   and partner.org_id = partner_schedule.org_id
                 where partner_schedule.org_id = s.org_id
                   and partner.role_key = 'growth_partner'
                   and partner_schedule.capability = s.capability
              ) as matching_growth_partner_schedule,
              (select count(*)::int
                 from ai_work_jobs j
                where j.org_id = s.org_id
                  and j.agent_instance_id = s.agent_instance_id
                  and j.capability = s.capability
                  and j.status = any($3::text[])
              ) as open_work_items_for_capability
         from ai_work_schedules s
         join agent_instances a on a.id = s.agent_instance_id and a.org_id = s.org_id
        where s.org_id = $1 and a.role_key = any($2::text[])
        order by a.role_key, s.capability, s.created_at, s.id`,
      [orgId, AGENT_ROLE_KEYS, OPEN_WORK_STATUSES],
    )).rows;

    const openWorkItems = (await db.query<{
      id: string;
      legacy_role: (typeof AGENT_ROLE_KEYS)[number];
      capability: string;
      status: string;
      idempotency_key: string;
      schedule_id: string | null;
    }>(
      `select j.id, a.role_key as legacy_role, j.capability, j.status, j.idempotency_key,
              coalesce(
                j.input->>'scheduleId',
                (select r.criteria->>'scheduleId' from lead_research_requests r where r.org_id = j.org_id and r.work_job_id = j.id limit 1)
              ) as schedule_id
         from ai_work_jobs j
         join agent_instances a on a.id = j.agent_instance_id and a.org_id = j.org_id
        where j.org_id = $1 and a.role_key = any($2::text[]) and j.status = any($3::text[])
        order by a.role_key, j.created_at, j.id`,
      [orgId, AGENT_ROLE_KEYS, OPEN_WORK_STATUSES],
    )).rows.map((row) => ({
      id: row.id,
      legacyRole: row.legacy_role,
      capability: row.capability,
      status: row.status,
      idempotencyKey: row.idempotency_key,
      scheduleId: row.schedule_id,
    }));

    const schedules = rows.map((row) => {
      const definition = capabilityDefinition(row.capability);
      const potentiallySupportedByGrowthPartner = Boolean(
        definition?.allowedRoles.includes("growth_partner")
        && (definition.key === "lead_research" || (definition.workBoardAction && definition.risk === "read_only")),
      );
      const iso = (value: Date | string | null) => value === null ? null : new Date(value).toISOString();
      return {
        id: row.id,
        legacyRole: row.legacy_role,
        capability: row.capability,
        capabilityLabel: definition?.label ?? row.capability.replaceAll("_", " "),
        cadence: row.cadence,
        intervalMinutes: Number(row.interval_minutes),
        timezone: row.timezone,
        enabled: row.enabled,
        nextRunAt: iso(row.next_run_at)!,
        lastRunAt: iso(row.last_run_at),
        due: row.due,
        potentiallySupportedByGrowthPartner,
        matchingGrowthPartnerSchedule: row.matching_growth_partner_schedule,
        openWorkItemsForCapability: Number(row.open_work_items_for_capability),
      };
    });

    return {
      generatedAt: new Date().toISOString(),
      summary: {
        total: schedules.length,
        enabled: schedules.filter((schedule) => schedule.enabled).length,
        potentiallySupported: schedules.filter((schedule) => schedule.potentiallySupportedByGrowthPartner).length,
        openWorkItems: openWorkItems.length,
        partnerScheduleMatches: schedules.filter((schedule) => schedule.matchingGrowthPartnerSchedule).length,
        dueSchedules: schedules.filter((schedule) => schedule.due).length,
      },
      openWorkItems,
      schedules,
    };
  });
}

export interface PreparedGrowthPartnerMigrationCandidate {
  id: string;
  created: boolean;
  status: "migration_required";
  runtimeBound: false;
  businessBrainVersion: null;
  legacyProfilesPreserved: 6;
}

/**
 * Creates the first reversible migration artifact for one existing client: an unbound logical
 * identity marked migration_required. This deliberately does not create a runtime or conversation,
 * copy Business Brain data, or alter any legacy profile, schedule, job, credential, or approval.
 * Authorization is enforced by the Super Admin server action before this trusted service is called.
 */
export async function prepareGrowthPartnerMigrationCandidate(orgId: string, actorUserId: string): Promise<PreparedGrowthPartnerMigrationCandidate> {
  return withSystem(async (db) => {
    const org = (await db.query<{ kind: string; status: string }>(
      "select kind, status from organizations where id = $1 for update",
      [orgId],
    )).rows[0];
    if (!org) throw new AppError("not_found", "Client workspace not found.");
    if (org.kind !== "client" || org.status !== "active") {
      throw new AppError("conflict", "Migration preparation is available only for active client workspaces.");
    }

    const legacy = (await db.query<{ profiles: number; roles: number }>(
      `select count(*)::int as profiles, count(distinct role_key)::int as roles
       from agent_instances where org_id = $1 and role_key = any($2::text[])`,
      [orgId, AGENT_ROLE_KEYS],
    )).rows[0];
    if (Number(legacy?.profiles ?? 0) !== AGENT_ROLE_KEYS.length || Number(legacy?.roles ?? 0) !== AGENT_ROLE_KEYS.length) {
      throw new AppError("conflict", "The six retained profiles are not all present. Refresh the inventory before preparing a candidate.");
    }

    const runtimes = (await db.query<{ count: number }>(
      "select count(*)::int as count from agent_instances where org_id = $1 and role_key = 'growth_partner'",
      [orgId],
    )).rows[0];
    if (Number(runtimes?.count ?? 0) > 0) {
      throw new AppError("conflict", "A Growth Partner runtime already exists. Review its binding before preparing a migration candidate.");
    }

    const inserted = await db.query<{ id: string }>(
      `insert into ai_growth_partners (org_id, status) values ($1, 'migration_required')
       on conflict (org_id) do nothing returning id`,
      [orgId],
    );
    const created = inserted.rowCount > 0;
    const candidate = (await db.query<{
      id: string;
      status: string;
      runtime_agent_instance_id: string | null;
      current_version: number | null;
      versions: number;
      conversations: number;
    }>(
      `select p.id, p.status, p.runtime_agent_instance_id, p.current_version,
              (select count(*)::int from ai_growth_partner_versions v where v.org_id = p.org_id and v.partner_id = p.id) as versions,
              (select count(*)::int from chat_conversations c where c.org_id = p.org_id and c.growth_partner_id = p.id and c.deleted_at is null) as conversations
       from ai_growth_partners p where p.org_id = $1`,
      [orgId],
    )).rows[0];

    if (!candidate) throw new AppError("internal", "The migration candidate could not be loaded.");
    if (!created && (
      candidate.status !== "migration_required"
      || candidate.runtime_agent_instance_id !== null
      || candidate.current_version !== null
      || Number(candidate.versions) !== 0
      || Number(candidate.conversations) !== 0
    )) {
      throw new AppError("conflict", "This workspace already has Growth Partner setup in progress. Review its current state before migrating it.");
    }

    if (created) {
      await recordAudit({
        orgId,
        actorUserId,
        actorKind: "agency",
        action: "ai_growth_partner.migration_candidate_prepared",
        targetType: "ai_growth_partner",
        targetId: candidate.id,
        result: "success",
        metadata: {
          phase: "identity_only",
          legacyProfileCount: AGENT_ROLE_KEYS.length,
          runtimeBound: false,
          businessBrainVersion: null,
          conversationCreated: false,
          legacyProfilesChanged: false,
          schedulesChanged: false,
          jobsChanged: false,
          integrationsChanged: false,
          approvalsChanged: false,
        },
      }, db);
    }

    return {
      id: candidate.id,
      created,
      status: "migration_required",
      runtimeBound: false,
      businessBrainVersion: null,
      legacyProfilesPreserved: AGENT_ROLE_KEYS.length,
    };
  });
}
