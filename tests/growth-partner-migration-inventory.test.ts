import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { getTenantDetail } from "@/server/admin/queries";
import { ensureGrowthPartnerRuntime } from "@/server/workforce/service";
import { addMember, agencyUser, agentId, createOrg, createUser } from "./support/fixtures";

describe("Growth Partner migration inventory", () => {
  it("counts persisted tenant records without exposing content or changing work", async () => {
    const org = await createOrg({ name: "Migration inventory source" });
    const otherOrg = await createOrg({ name: "Migration inventory other tenant" });
    const owner = await createUser();
    const member = await createUser();
    const superAdmin = await createUser({ platformRole: "agency_super_admin" });
    const assignedStaff = await createUser({ platformRole: "agency_staff" });
    await addMember(org.id, owner.id, "owner");
    await addMember(org.id, member.id, "member");
    await withSystem((db) => db.query(
      "insert into staff_assignments (org_id, user_id, assigned_by) values ($1, $2, $3)",
      [org.id, assignedStaff.id, superAdmin.id],
    ));

    const leadHunter = await agentId(org.id, "lead_hunter");
    const crmManager = await agentId(org.id, "crm_manager");
    const otherLeadHunter = await agentId(otherOrg.id, "lead_hunter");
    const before = await withSystem(async (db) => {
      await db.query("update agent_instances set enabled = false where org_id = $1 and role_key <> 'growth_partner'", [org.id]);
      await db.query("update agent_instances set enabled = true, hermes_profile = 'legacy-runner' where id = $1", [leadHunter]);
      const credential = (await db.query<{ id: string }>(
        "insert into integration_credentials (org_id, provider, label, ciphertext, fingerprint) values ($1, 'hermes', 'Synthetic legacy profile', 'fixture-ciphertext', 'fixture-fingerprint') returning id",
        [org.id],
      )).rows[0].id;
      const revokedCredential = (await db.query<{ id: string }>(
        "insert into integration_credentials (org_id, provider, label, ciphertext, fingerprint, revoked_at) values ($1, 'hermes', 'Synthetic revoked profile', 'revoked-fixture-ciphertext', 'revoked-fixture-fingerprint', now()) returning id",
        [org.id],
      )).rows[0].id;
      await db.query("update agent_instances set hermes_profile = 'legacy-crm', credential_id = $2 where id = $1", [crmManager, revokedCredential]);
      const foreignCredential = (await db.query<{ id: string }>(
        "insert into integration_credentials (org_id, provider, label, ciphertext, fingerprint) values ($1, 'hermes', 'Synthetic other-tenant profile', 'other-tenant-ciphertext', 'other-tenant-fingerprint') returning id",
        [otherOrg.id],
      )).rows[0].id;
      // Model a corrupt legacy binding: an old workspace row must not count another tenant's credential as its own.
      await db.query("update agent_instances set hermes_profile = 'foreign-bound-profile', credential_id = $2 where org_id = $1 and role_key = 'operations_manager'", [org.id, foreignCredential]);
      const activeConfig = (await db.query<{ id: string }>(
        `insert into agent_config_versions (org_id, agent_instance_id, version, settings, summary, compiled_instructions, policy_version, source, status)
         values ($1, $2, 1, '{"displayName":"Legacy Lead Hunter","tone":"professional","replyLength":"balanced","language":"English"}'::jsonb, 'Synthetic active config', 'Private instructions', 'test-policy', 'onboarding', 'applied') returning id`,
        [org.id, leadHunter],
      )).rows[0].id;
      await db.query("update agent_instances set credential_id = $2, active_config_version_id = $3 where id = $1", [leadHunter, credential, activeConfig]);
      await db.query(
        `insert into agent_config_versions (org_id, agent_instance_id, version, settings, summary, compiled_instructions, policy_version, source, status)
         values ($1, $2, 1, '{"displayName":"Legacy CRM Manager","tone":"professional","replyLength":"balanced","language":"English"}'::jsonb, 'Synthetic review', 'Private held instructions', 'test-policy', 'agency', 'pending_agency_review')`,
        [org.id, crmManager],
      );
      await db.query("insert into company_knowledge (org_id, section, content, review_status) values ($1, 'business_description', 'Private approved content', 'approved'), ($1, 'brand_voice', 'Private waiting content', 'pending_agency_review')", [org.id]);
      await db.query(
        `insert into employee_knowledge_entries (org_id, agent_instance_id, title, content, status, risk_flags, created_by, updated_by)
         values ($1, $2, 'Private approved note', 'Private approved note content', 'approved', '{}', $3, $3),
                ($1, $4, 'Private waiting note', 'Private waiting note content', 'pending_agency_review', '{prompt_injection}', $3, $3)`,
        [org.id, leadHunter, owner.id, crmManager],
      );
      await db.query(
        "insert into knowledge_documents (org_id, filename, mime_type, size_bytes, sha256, storage_key) values ($1, 'synthetic.pdf', 'application/pdf', 1, $2, $3)",
        [org.id, "a".repeat(64), `migration-inventory/${org.id}/synthetic.pdf`],
      );
      await db.query(
        `insert into knowledge_documents (org_id, agent_instance_id, filename, mime_type, size_bytes, sha256, storage_key, status, extracted_text, applied_at)
         values ($1, $2, 'released-role.pdf', 'application/pdf', 1, $3, $4, 'ready', 'Private released profile document', now()),
                ($1, null, 'released-shared.pdf', 'application/pdf', 1, $5, $6, 'ready', 'Private released shared document', now())`,
        [org.id, leadHunter, "b".repeat(64), `migration-inventory/${org.id}/released-role.pdf`, "c".repeat(64), `migration-inventory/${org.id}/released-shared.pdf`],
      );
      await db.query(
        `insert into knowledge_documents (org_id, agent_instance_id, filename, mime_type, size_bytes, sha256, storage_key, status, risk_flags)
         values ($1, $2, 'held-role.pdf', 'application/pdf', 1, $3, $4, 'ready', '{prompt_injection}'),
                ($1, null, 'held-shared.pdf', 'application/pdf', 1, $5, $6, 'ready', '{prompt_injection}')`,
        [org.id, crmManager, "d".repeat(64), `migration-inventory/${org.id}/held-role.pdf`, "e".repeat(64), `migration-inventory/${org.id}/held-shared.pdf`],
      );
      const conversation = (await db.query<{ id: string }>(
        "insert into chat_conversations (org_id, agent_instance_id, user_id, title, hermes_session_id) values ($1, $2, $3, 'Private legacy chat', $4) returning id",
        [org.id, leadHunter, owner.id, `legacy-${crypto.randomUUID()}`],
      )).rows[0].id;
      await db.query("insert into chat_messages (conversation_id, org_id, role, content) values ($1, $2, 'user', 'Private message content')", [conversation, org.id]);
      await db.query(
        `insert into ai_work_schedules (org_id, agent_instance_id, capability, cadence, interval_minutes, timezone, enabled)
         values ($1, $2, 'lead_generation_review', 'daily', 1440, 'America/New_York', true),
                ($1, $3, 'crm_quality_review', 'daily', 1440, 'America/New_York', false)`,
        [org.id, leadHunter, crmManager],
      );
      await db.query(
        `insert into ai_work_jobs (org_id, agent_instance_id, capability, title, idempotency_key, status)
         values ($1, $2, 'lead_generation_review', 'Synthetic active work', $3, 'running'),
                ($1, $2, 'lead_generation_review', 'Synthetic completed work', $4, 'completed')`,
        [org.id, leadHunter, `migration-inventory-${crypto.randomUUID()}`, `migration-inventory-${crypto.randomUUID()}`],
      );
      await db.query("insert into approval_requests (org_id, agent_instance_id, kind, title, reason) values ($1, $2, 'crm_update', 'Synthetic pending approval', 'Synthetic migration inventory')", [org.id, leadHunter]);
      await db.query("insert into integration_status (org_id, provider, status) values ($1, 'n8n', 'connected')", [org.id]);
      await db.query("insert into member_permission_overrides (org_id, user_id, permission, effect, reason) values ($1, $2, 'contacts.view', 'revoke', 'Synthetic scoped override')", [org.id, member.id]);
      await db.query("insert into org_features (org_id, feature, enabled) values ($1, 'invoices', false)", [org.id]);

      // Similar records in another workspace must not contribute to this snapshot.
      await db.query(
        `insert into ai_work_schedules (org_id, agent_instance_id, capability, cadence, interval_minutes, timezone, enabled)
         values ($1, $2, 'lead_generation_review', 'daily', 1440, 'America/New_York', true)`,
        [otherOrg.id, otherLeadHunter],
      );
      await db.query(
        "insert into ai_work_jobs (org_id, agent_instance_id, capability, title, idempotency_key, status) values ($1, $2, 'lead_generation_review', 'Other tenant work', $3, 'running')",
        [otherOrg.id, otherLeadHunter, `migration-inventory-${crypto.randomUUID()}`],
      );
      await db.query(
        "insert into employee_knowledge_entries (org_id, agent_instance_id, title, content, status, created_by, updated_by) values ($1, $2, 'Other tenant note', 'Other tenant content', 'approved', $3, $3)",
        [otherOrg.id, otherLeadHunter, owner.id],
      );
      return (await db.query<{ schedules: number; jobs: number; messages: number; notes: number; documents: number }>(
        `select
           (select count(*)::int from ai_work_schedules where org_id = $1) as schedules,
           (select count(*)::int from ai_work_jobs where org_id = $1) as jobs,
           (select count(*)::int from chat_messages where org_id = $1) as messages,
           (select count(*)::int from employee_knowledge_entries where org_id = $1) as notes,
           (select count(*)::int from knowledge_documents where org_id = $1) as documents`,
        [org.id],
      )).rows[0];
    });
    await withSystem((db) => ensureGrowthPartnerRuntime(org.id, db));

    const detail = await getTenantDetail(agencyUser(superAdmin, "agency_super_admin"), org.id);
    expect(detail.migrationInventory).toEqual({
      legacyProfiles: 6,
      enabledLegacyProfiles: 1,
      boundHermesProfiles: 3,
      unrevokedCredentialReferences: 1,
      profilesWithActiveConfig: 1,
      configReviewsWaiting: 1,
      approvedKnowledgeSections: 1,
      knowledgeSectionsWaiting: 1,
      retainedKnowledgeDocuments: 5,
      legacyProfileKnowledgeNotes: 2,
      approvedLegacyProfileKnowledgeNotes: 1,
      waitingLegacyProfileKnowledgeNotes: 1,
      retainedLegacyProfileDocuments: 2,
      releasedLegacyProfileDocuments: 1,
      heldLegacyProfileDocuments: 1,
      releasedSharedKnowledgeDocuments: 1,
      heldSharedKnowledgeDocuments: 1,
      legacyConversations: 1,
      legacyMessages: 1,
      schedules: 2,
      enabledSchedules: 1,
      workJobs: 2,
      openWorkJobs: 1,
      openApprovals: 1,
      connectedIntegrationStatuses: 1,
      memberPermissionOverrides: 1,
      workspaceFeatureOverrides: 1,
      growthPartnerIdentities: 1,
      permanentGrowthPartnerConversations: 0,
    });
    expect(JSON.stringify(detail.migrationInventory)).not.toContain("Private");
    expect(JSON.stringify(detail.migrationInventory)).not.toContain("fixture-ciphertext");
    expect(await withSystem(async (db) => (await db.query<{ schedules: number; jobs: number; messages: number; notes: number; documents: number }>(
      `select
         (select count(*)::int from ai_work_schedules where org_id = $1) as schedules,
         (select count(*)::int from ai_work_jobs where org_id = $1) as jobs,
         (select count(*)::int from chat_messages where org_id = $1) as messages,
         (select count(*)::int from employee_knowledge_entries where org_id = $1) as notes,
         (select count(*)::int from knowledge_documents where org_id = $1) as documents`,
      [org.id],
    )).rows[0])).toEqual(before);

    const staffDetail = await getTenantDetail(agencyUser(assignedStaff, "agency_staff"), org.id);
    expect(staffDetail.migrationInventory).toBeNull();
    expect(staffDetail.agents).toHaveLength(6);
  });
});
