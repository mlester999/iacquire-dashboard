import crypto from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const acting = vi.hoisted(() => ({ userId: null as string | null }));

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
// Choose a real agency user for the action while leaving its permission and assignment checks in the database.
vi.mock("@/server/tenancy/context", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/server/tenancy/context")>();
  const { withSystem } = await import("@/server/db");
  const { AppError } = await import("@/server/errors");
  return {
    ...mod,
    requireAgencyOrgPermissionOrThrow: async (orgId: string, permission: import("@/lib/permissions").Permission) => {
      if (!acting.userId) throw new Error("No agency user selected for this test.");
      const { rows } = await withSystem((db) => db.query<{ allowed: boolean }>(
        "select app.user_can_access_org($1,$2) and app.user_has_agency_permission($1,$3) as allowed",
        [acting.userId, orgId, permission],
      ));
      if (rows[0]?.allowed !== true) throw new AppError("forbidden", "The agency user is not assigned or lacks this permission.");
      return { id: acting.userId };
    },
  };
});

import { GrowthPartnerOperationsPanel } from "@/components/admin/growth-partner-operations";
import { TOOL_INVENTORY_CONTRACT } from "@/lib/hermes-tool-inventory";
import { getAdminOverview, getTenantDetail, listGrowthPartners } from "@/server/admin/queries";
import { setClientContentPolicy, CONTENT_WITHHELD_NOTICE } from "@/server/admin/client-content-policy";
import { updateAgencyTeamMember, updateAgencyUserPermission } from "@/server/admin/team";
import { recordAudit } from "@/server/audit";
import { withSystem } from "@/server/db";
import { createConfigVersion } from "@/server/workforce/service";
import { defaultSettings } from "@/server/workforce/compiler";
import { decideHeldVersionAction } from "@/app/(admin)/admin/actions";
import { agencyUser, createOrg, createUser } from "./support/fixtures";
import { createGrowthPartnerOnlyTenant, expectNoLegacyEmployeeRows } from "./support/growth-partner-tenant";

afterEach(async () => {
  acting.userId = null;
  await withSystem((db) => db.query(
    "update agency_policy_switches set enabled = false, changed_by = null, changed_at = null, note = null where key = 'client_content_needs_support_session'",
  ));
});

describe("assigned agency Growth Partner fleet", () => {
  it("scopes Partner-only tenants, agrees on readiness with revoked credentials, masks private failures, and allows an assigned manager to decide a held Partner config", async () => {
    const assigned = await createGrowthPartnerOnlyTenant({ name: "Assigned GP Fleet Client" });
    const unassigned = await createGrowthPartnerOnlyTenant({ name: "Out of scope GP Fleet Client" });
    const adminUser = await createUser({ platformRole: "agency_super_admin" });
    const managerUser = await createUser({ platformRole: "agency_manager" });
    const admin = agencyUser(adminUser, "agency_super_admin");
    const manager = agencyUser(managerUser, "agency_manager");

    await withSystem(async (db) => {
      await db.query("insert into staff_assignments(org_id,user_id,assigned_by) values($1,$2,$3)", [assigned.org.id, managerUser.id, adminUser.id]);
      const credential = await db.query<{ id: string }>(
        "insert into integration_credentials (org_id, provider, label, ciphertext, fingerprint) values ($1, 'hermes', 'Synthetic Partner credential', 'fixture-ciphertext', 'fixture-fingerprint') returning id",
        [assigned.org.id],
      );
      await db.query(
        `update agent_instances set enabled = true, status = 'online', last_health_ok = true, last_health_check_at = now(), credential_id = $2,
           tool_inventory_contract = $3, tool_inventory_digest = $4, tool_inventory_tool_count = 5,
           tool_inventory_verified_at = now(), tool_inventory_expires_at = now() + interval '2 minutes'
         where id = $1 and org_id = $5`,
        [assigned.runtimeAgentId, credential.rows[0].id, TOOL_INVENTORY_CONTRACT, "a".repeat(64), assigned.org.id],
      );
    });

    await updateAgencyTeamMember(admin, {
      userId: managerUser.id,
      platformRole: "agency_manager",
      status: "active",
      scopeMode: "assigned_clients",
    });
    await updateAgencyUserPermission(admin, { userId: managerUser.id, permission: "agency.workforce.view", effect: "allow" });
    await updateAgencyUserPermission(admin, { userId: managerUser.id, permission: "agency.workforce.manage", effect: "allow" });

    const readyPartners = await listGrowthPartners(manager);
    expect(readyPartners.map((partner) => partner.org_id)).toEqual([assigned.org.id]);
    expect(readyPartners[0].status).toBe("configured");
    expect((await getTenantDetail(manager, assigned.org.id)).growthPartner?.status).toBe("configured");
    expect(await getAdminOverview(manager)).toMatchObject({ growthPartnerRuntimesOnline: 1, growthPartnerRuntimesPreparing: 0, growthPartnerRuntimesNeedsAttention: 0 });

    const credentialId = (await withSystem((db) => db.query<{ credential_id: string }>(
      "select credential_id from agent_instances where id = $1 and org_id = $2",
      [assigned.runtimeAgentId, assigned.org.id],
    ))).rows[0].credential_id;
    await withSystem((db) => db.query("update integration_credentials set revoked_at = now() where id = $1", [credentialId]));
    const revokedPartners = await listGrowthPartners(manager);
    const revokedDetail = await getTenantDetail(manager, assigned.org.id);
    expect(revokedPartners[0].status).toBe("setup_required");
    expect(revokedDetail.growthPartner?.status).toBe("setup_required");
    expect(await getAdminOverview(manager)).toMatchObject({ growthPartnerRuntimesOnline: 0, growthPartnerRuntimesPreparing: 1, growthPartnerRuntimesNeedsAttention: 0 });

    const held = await withSystem((db) => createConfigVersion(db, {
      orgId: assigned.org.id,
      agentId: assigned.runtimeAgentId,
      settings: { ...defaultSettings("growth_partner"), escalationContact: "ops@example.test" },
      source: "client_edit",
      userId: assigned.owner.id,
      apply: true,
    }));
    expect(held.status).toBe("pending_agency_review");

    const failureCanary = `PRIVATE_PARTNER_FAILURE_${crypto.randomUUID()}`;
    const ids = await withSystem(async (db) => {
      await db.query("update agent_instances set last_health_detail = $2 where id = $1 and org_id = $3", [assigned.runtimeAgentId, failureCanary, assigned.org.id]);
      await db.query(
        `insert into agent_runs (org_id, agent_instance_id, purpose, idempotency_key, status, error_code, error_message, started_at, finished_at)
         values ($1, $2, 'chat', $3, 'failed', 'partner_runtime_failed', $4, now(), now())`,
        [assigned.org.id, assigned.runtimeAgentId, `gp-fleet-run-${crypto.randomUUID()}`, failureCanary],
      );
      const job = (await db.query<{ id: string }>(
        `insert into ai_work_jobs (org_id, agent_instance_id, capability, title, idempotency_key, status, failure_code, failure_message, finished_at)
         values ($1, $2, 'lead_generation_review', 'Private failed job title', $3, 'failed', 'provider_timeout', $4, now()) returning id`,
        [assigned.org.id, assigned.runtimeAgentId, `gp-fleet-job-${crypto.randomUUID()}`, failureCanary],
      )).rows[0];
      await db.query(
        `insert into approval_requests (org_id, agent_instance_id, kind, title, risk, status, execution_status, execution_detail, executed_at)
         values ($1, $2, 'crm_update', 'Private approval title', 'medium', 'approved', 'failed', $3, now())`,
        [assigned.org.id, assigned.runtimeAgentId, failureCanary],
      );
      const provisioning = (await db.query<{ id: string }>(
        `insert into agent_provisioning_jobs (org_id, agent_instance_id, kind, status, attempt_count, detail)
         values ($1, $2, 'provision', 'failed', 1, $3) returning id`,
        [assigned.org.id, assigned.runtimeAgentId, failureCanary],
      )).rows[0];
      await recordAudit({
        orgId: assigned.org.id,
        actorKind: "system",
        agentInstanceId: assigned.runtimeAgentId,
        action: "agent.profile_provisioning_failed",
        targetType: "agent_provisioning_job",
        targetId: provisioning.id,
        result: "failure",
        metadata: { attempt: 1, code: "setup_worker_failed" },
      }, db);
      return { jobId: job.id, provisioningId: provisioning.id };
    });

    await setClientContentPolicy(admin, { sessionRequired: true, note: "Mask private failure text in the fleet test." });
    const partners = await listGrowthPartners(manager);
    expect(partners).toHaveLength(1);
    expect(partners[0].org_id).toBe(assigned.org.id);
    expect(partners[0].last_health_detail).toBe(CONTENT_WITHHELD_NOTICE);
    expect(JSON.stringify(partners)).not.toContain(failureCanary);

    const detail = await getTenantDetail(manager, assigned.org.id);
    expect(detail.access.workforceManage).toBe(true);
    expect(detail.org.id).toBe(assigned.org.id);
    expect(detail.agents).toEqual([]);
    expect(detail.growthPartner?.last_health_detail).toBe(CONTENT_WITHHELD_NOTICE);
    expect(detail.failedRuns).toContainEqual(expect.objectContaining({ error_code: "partner_runtime_failed", error_message: CONTENT_WITHHELD_NOTICE }));
    expect(detail.failedWorkJobs).toContainEqual(expect.objectContaining({ id: ids.jobId, capability: "lead_generation_review", failure_code: "provider_timeout" }));
    expect(JSON.stringify(detail.failedWorkJobs)).not.toContain(failureCanary);
    expect(detail.failedApprovalExecutions).toContainEqual(expect.objectContaining({ execution_status: "failed" }));
    expect(JSON.stringify(detail.failedApprovalExecutions)).not.toContain(failureCanary);
    expect(detail.provisioning).toContainEqual(expect.objectContaining({ id: ids.provisioningId, agent_role: "growth_partner", detail: null }));
    expect(detail.provisioning.find((job) => job.id === ids.provisioningId)?.history).toContainEqual(expect.objectContaining({ code: "setup_worker_failed" }));
    expect(JSON.stringify(detail.provisioning)).not.toContain(failureCanary);
    expect(detail.heldVersions).toContainEqual(expect.objectContaining({ id: held.versionId, agentRole: "growth_partner" }));
    expect(await assigned.legacyAgentRowCount()).toBe(0);
    await expectNoLegacyEmployeeRows(assigned.org.id);

    acting.userId = managerUser.id;
    expect(await decideHeldVersionAction(assigned.org.id, held.versionId, false, "Reviewed and rejected" )).toEqual({ ok: true });
    const decided = (await withSystem((db) => db.query<{ status: string; decided_by: string }>(
      "select status, decided_by from agent_config_versions where id = $1 and org_id = $2",
      [held.versionId, assigned.org.id],
    ))).rows[0];
    expect(decided).toMatchObject({ status: "rejected", decided_by: managerUser.id });
    acting.userId = null;
    await expectNoLegacyEmployeeRows(unassigned.org.id);
  });
});

describe("Growth Partner schedule and execution diagnostics", () => {
  it("reads bounded, content-free metadata for the selected runtime and excludes all other profiles", async () => {
    const selected = await createGrowthPartnerOnlyTenant({ name: "Operations metadata tenant" });
    const outside = await createGrowthPartnerOnlyTenant({ name: "Operations unrelated tenant" });
    const adminUser = await createUser({ platformRole: "agency_super_admin" });
    const managerUser = await createUser({ platformRole: "agency_manager" });
    const admin = agencyUser(adminUser, "agency_super_admin");
    const manager = agencyUser(managerUser, "agency_manager");
    const secret = `PRIVATE_SCHEDULE_AND_JOB_${crypto.randomUUID()}`;
    const ids = await withSystem(async (db) => {
      const retained = (await db.query<{ id: string }>(
        "insert into agent_instances (org_id, role_key, display_name) values ($1, 'crm_manager', 'Retained CRM profile') returning id",
        [selected.org.id],
      )).rows[0];
      const addJob = async (orgId: string, agentId: string, status: string, finished: boolean) => (await db.query<{ id: string }>(
        `insert into ai_work_jobs (org_id, agent_instance_id, status, capability, title, input, result_summary,
           failure_message, failure_code, idempotency_key, attempts, created_at, finished_at)
         values ($1, $2, $3, 'lead_generation_review', $4, jsonb_build_object('prompt', $4::text), $4,
           $4, $4, $5, 1, now() - interval '2 hours', case when $6::boolean then now() end) returning id`,
        [orgId, agentId, status, secret, crypto.randomUUID(), finished],
      )).rows[0].id;
      const failed = await addJob(selected.org.id, selected.runtimeAgentId, "failed", true);
      const blocked = await addJob(selected.org.id, selected.runtimeAgentId, "blocked", true);
      const recovered = await addJob(selected.org.id, selected.runtimeAgentId, "running", false);
      const retainedJob = await addJob(selected.org.id, retained.id, "failed", true);
      const foreignJob = await addJob(outside.org.id, outside.runtimeAgentId, "failed", true);

      const addSchedule = async (orgId: string, agentId: string, lastJobId: string) => (await db.query<{ id: string }>(
        `insert into ai_work_schedules (org_id, agent_instance_id, capability, enabled, last_job_id, last_run_at,
           last_skipped_reason, last_skipped_at, payload)
         values ($1, $2, 'lead_generation_review', true, $3, now(), 'outside_business_hours', now(), jsonb_build_object('prompt', $4::text))
         returning id`,
        [orgId, agentId, lastJobId, secret],
      )).rows[0].id;
      const schedule = await addSchedule(selected.org.id, selected.runtimeAgentId, failed);
      const retainedSchedule = await addSchedule(selected.org.id, retained.id, retainedJob);
      const foreignSchedule = await addSchedule(outside.org.id, outside.runtimeAgentId, foreignJob);
      const pausedSchedule = (await db.query<{ id: string }>(
        `insert into ai_work_schedules (org_id, agent_instance_id, capability, last_skipped_reason)
         values ($1, $2, 'lead_research', $3) returning id`,
        [selected.org.id, selected.runtimeAgentId, secret],
      )).rows[0].id;

      await db.query(
        `insert into ai_work_jobs (org_id, agent_instance_id, capability, title, idempotency_key)
         select $1, $2, 'lead_generation_review', $3, $4 || '-' || n::text from generate_series(1, 10) n`,
        [selected.org.id, selected.runtimeAgentId, secret, crypto.randomUUID()],
      );
      await db.query("insert into staff_assignments (org_id, user_id, assigned_by) values ($1, $2, $3)", [selected.org.id, managerUser.id, adminUser.id]);
      return { failed, blocked, recovered, schedule, pausedSchedule, retainedJob, foreignJob, retainedSchedule, foreignSchedule };
    });
    await updateAgencyTeamMember(admin, {
      userId: managerUser.id, platformRole: "agency_manager", status: "active", scopeMode: "assigned_clients",
    });
    await updateAgencyUserPermission(admin, { userId: managerUser.id, permission: "agency.workforce.view", effect: "allow" });

    const detail = await getTenantDetail(admin, selected.org.id);
    const ops = detail.growthPartnerOperations;
    if (ops?.state !== "runtime_bound") throw new Error("Expected diagnostics for the bound Partner runtime.");
    expect(ops.pending).toHaveLength(8);
    expect(ops.pending[0]).toMatchObject({ id: ids.recovered, status: "running", label: "Recovery pending", attempts: 1 });
    expect(ops.outcomes.map((job) => job.id).sort()).toEqual([ids.failed, ids.blocked].sort());
    expect(ops.schedules).toMatchObject([
      { id: ids.schedule, enabled: true, lastJob: "Failed", lastSkip: "Moved to the next allowed business-hours window." },
      { id: ids.pausedSchedule, enabled: false, lastSkip: "Skipped because a required schedule check did not pass." },
    ]);
    const metadata = JSON.stringify(ops);
    for (const value of [secret, ids.retainedJob, ids.foreignJob, ids.retainedSchedule, ids.foreignSchedule]) {
      expect(metadata).not.toContain(value);
    }
    const rendered = renderToStaticMarkup(createElement(GrowthPartnerOperationsPanel, { operations: ops, timeZone: "UTC" }));
    expect(rendered).toContain("Schedules and executions");
    expect(rendered).toContain("Pending work");
    expect(rendered).toContain("Recovery pending");
    expect(rendered).toContain("Recent job outcomes");
    expect(rendered).not.toMatch(/<button|<form/);
    const assignedManagerDetail = await getTenantDetail(manager, selected.org.id);
    expect(assignedManagerDetail.access.workforce).toBe(true);
    expect(assignedManagerDetail.growthPartnerOperations).toBeNull();
    await expect(getTenantDetail(manager, outside.org.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(getTenantDetail({ ...admin, platformRole: "none" }, selected.org.id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("distinguishes a legacy-only tenant from a migration identity with no bound runtime", async () => {
    const org = await createOrg({ name: "Operations retained profiles tenant" });
    const admin = agencyUser(await createUser({ platformRole: "agency_super_admin" }), "agency_super_admin");
    const legacy = await getTenantDetail(admin, org.id);
    expect(legacy.agents.length).toBeGreaterThan(0);
    expect(legacy.growthPartnerOperations).toEqual({ state: "identity_missing" });
    await withSystem((db) => db.query("insert into ai_growth_partners (org_id, status) values ($1, 'migration_required')", [org.id]));
    const prepared = await getTenantDetail(admin, org.id);
    expect(prepared.agents.map((agent) => agent.id)).toEqual(legacy.agents.map((agent) => agent.id));
    expect(prepared.growthPartnerOperations).toEqual({ state: "runtime_unbound" });
  });
});
