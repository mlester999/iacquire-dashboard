import { describe, expect, it } from "vitest";
import { prepareGrowthPartnerMigrationCandidate } from "@/server/admin/growth-partner-migration";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { agentId, createOrg, createUser } from "./support/fixtures";

describe("Growth Partner migration candidate preparation", () => {
  it("creates one inactive, tenant-scoped identity and preserves all previous work", async () => {
    const org = await createOrg({ name: "Candidate preparation client" });
    const otherOrg = await createOrg({ name: "Other candidate client" });
    const admin = await createUser({ platformRole: "agency_super_admin" });
    const leadHunter = await agentId(org.id, "lead_hunter");

    await withSystem(async (db) => {
      await db.query("update agent_instances set enabled = false where org_id = $1 and role_key <> 'growth_partner'", [org.id]);
      await db.query("update agent_instances set enabled = true, hermes_profile = 'legacy-lead-hunter' where id = $1", [leadHunter]);
      await db.query(
        `insert into ai_work_schedules (org_id, agent_instance_id, capability, cadence, interval_minutes, timezone, enabled)
         values ($1, $2, 'lead_generation_review', 'daily', 1440, 'America/New_York', true)`,
        [org.id, leadHunter],
      );
      await db.query(
        `insert into ai_work_jobs (org_id, agent_instance_id, capability, title, idempotency_key, status)
         values ($1, $2, 'lead_generation_review', 'Retained synthetic job', $3, 'queued')`,
        [org.id, leadHunter, `candidate-${crypto.randomUUID()}`],
      );
      await db.query(
        "insert into approval_requests (org_id, agent_instance_id, kind, title, reason) values ($1, $2, 'crm_update', 'Retained synthetic approval', 'Candidate preparation test')",
        [org.id, leadHunter],
      );
    });

    const before = await withSystem(async (db) => ({
      profiles: (await db.query(
        `select role_key, enabled, status, hermes_profile, credential_id, active_config_version_id
         from agent_instances where org_id = $1 order by role_key`, [org.id],
      )).rows,
      schedules: (await db.query("select org_id, agent_instance_id, capability, enabled from ai_work_schedules where org_id = $1", [org.id])).rows,
      jobs: (await db.query("select org_id, agent_instance_id, capability, idempotency_key, status from ai_work_jobs where org_id = $1", [org.id])).rows,
      approvals: (await db.query("select org_id, agent_instance_id, kind, title, status from approval_requests where org_id = $1", [org.id])).rows,
    }));

    const created = await prepareGrowthPartnerMigrationCandidate(org.id, admin.id);
    const retried = await prepareGrowthPartnerMigrationCandidate(org.id, admin.id);

    expect(created).toMatchObject({
      created: true,
      status: "migration_required",
      runtimeBound: false,
      businessBrainVersion: null,
      legacyProfilesPreserved: 6,
    });
    expect(retried).toEqual({ ...created, created: false });
    expect(await withSystem(async (db) => ({
      profiles: (await db.query(
        `select role_key, enabled, status, hermes_profile, credential_id, active_config_version_id
         from agent_instances where org_id = $1 order by role_key`, [org.id],
      )).rows,
      schedules: (await db.query("select org_id, agent_instance_id, capability, enabled from ai_work_schedules where org_id = $1", [org.id])).rows,
      jobs: (await db.query("select org_id, agent_instance_id, capability, idempotency_key, status from ai_work_jobs where org_id = $1", [org.id])).rows,
      approvals: (await db.query("select org_id, agent_instance_id, kind, title, status from approval_requests where org_id = $1", [org.id])).rows,
    }))).toEqual(before);

    const persisted = await withSystem(async (db) => ({
      candidate: (await db.query<{ id: string; status: string; runtime_agent_instance_id: string | null; current_version: number | null }>(
        "select id, status, runtime_agent_instance_id, current_version from ai_growth_partners where org_id = $1", [org.id],
      )).rows,
      versions: (await db.query("select id from ai_growth_partner_versions where org_id = $1", [org.id])).rows,
      conversations: (await db.query("select id from chat_conversations where org_id = $1 and growth_partner_id is not null", [org.id])).rows,
      runtimeProfiles: (await db.query("select id from agent_instances where org_id = $1 and role_key = 'growth_partner'", [org.id])).rows,
      audits: (await db.query<{ action: string; target_id: string; metadata: Record<string, unknown> }>(
        "select action, target_id, metadata from audit_logs where org_id = $1 and action = 'ai_growth_partner.migration_candidate_prepared'", [org.id],
      )).rows,
      otherTenantPartners: (await db.query("select id from ai_growth_partners where org_id = $1", [otherOrg.id])).rows,
    }));
    expect(persisted.candidate).toEqual([{ id: created.id, status: "migration_required", runtime_agent_instance_id: null, current_version: null }]);
    expect(persisted.versions).toEqual([]);
    expect(persisted.conversations).toEqual([]);
    expect(persisted.runtimeProfiles).toEqual([]);
    expect(persisted.otherTenantPartners).toEqual([]);
    expect(persisted.audits).toHaveLength(1);
    expect(persisted.audits[0]).toMatchObject({
      action: "ai_growth_partner.migration_candidate_prepared",
      target_id: created.id,
      metadata: {
        phase: "identity_only",
        legacyProfileCount: 6,
        runtimeBound: false,
        businessBrainVersion: null,
        conversationCreated: false,
        legacyProfilesChanged: false,
        schedulesChanged: false,
        jobsChanged: false,
        integrationsChanged: false,
        approvalsChanged: false,
      },
    });
  });

  it("refuses an incomplete legacy set, a non-client tenant, and existing partner setup", async () => {
    const incomplete = await createOrg({ name: "Incomplete legacy client" });
    await withSystem((db) => db.query("delete from agent_instances where org_id = $1 and role_key = 'lead_hunter'", [incomplete.id]));
    await expect(prepareGrowthPartnerMigrationCandidate(incomplete.id, crypto.randomUUID()))
      .rejects.toMatchObject({ code: "conflict" });

    const agency = await createOrg({ name: "Not a client workspace", kind: "agency" });
    await expect(prepareGrowthPartnerMigrationCandidate(agency.id, crypto.randomUUID()))
      .rejects.toMatchObject({ code: "conflict" });

    const inactive = await createOrg({ name: "Inactive legacy client", status: "suspended" });
    await expect(prepareGrowthPartnerMigrationCandidate(inactive.id, crypto.randomUUID()))
      .rejects.toMatchObject({ code: "conflict" });

    const orphanedRuntime = await createOrg({ name: "Orphan runtime" });
    await withSystem((db) => db.query(
      "insert into agent_instances (org_id, role_key, display_name) values ($1, 'growth_partner', 'AI Growth Partner')",
      [orphanedRuntime.id],
    ));
    await expect(prepareGrowthPartnerMigrationCandidate(orphanedRuntime.id, crypto.randomUUID()))
      .rejects.toMatchObject({ code: "conflict" });
    expect((await withSystem((db) => db.query("select id from ai_growth_partners where org_id = $1", [orphanedRuntime.id]))).rows).toEqual([]);

    const existing = await createOrg({ name: "Existing partner setup" });
    await withSystem((db) => db.query("insert into ai_growth_partners (org_id) values ($1)", [existing.id]));
    await expect(prepareGrowthPartnerMigrationCandidate(existing.id, crypto.randomUUID()))
      .rejects.toMatchObject({ code: "conflict" });
    expect(await withSystem((db) => db.query<{ status: string }>("select status from ai_growth_partners where org_id = $1", [existing.id])))
      .toMatchObject({ rows: [{ status: "setup_required" }] });
  });

  it("returns not found for an unknown tenant without creating a candidate", async () => {
    await expect(prepareGrowthPartnerMigrationCandidate(crypto.randomUUID(), crypto.randomUUID()))
      .rejects.toBeInstanceOf(AppError);
    await expect(prepareGrowthPartnerMigrationCandidate(crypto.randomUUID(), crypto.randomUUID()))
      .rejects.toMatchObject({ code: "not_found" });
  });
});
