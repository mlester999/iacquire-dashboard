import "server-only";
import { AGENT_ROLE_KEYS } from "@/lib/agents";
import { recordAudit } from "@/server/audit";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";

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
