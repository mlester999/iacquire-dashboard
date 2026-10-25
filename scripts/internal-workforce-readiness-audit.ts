/**
 * Read-only readiness audit for the six internal iAcquire AI Employees.
 *
 *   NODE_ENV=production DATABASE_SSL_CA_FILE=certs/prod-ca-2021.crt `
 *     node --env-file=.env --conditions=react-server --import tsx `
 *     scripts/internal-workforce-readiness-audit.ts --live
 *
 * It performs SELECT queries only. It does not resolve or print credentials, contact Hermes,
 * apply configurations, run health checks, acknowledge policy or start employee work. The separate
 * `hermes-live-audit.ts` verifies live profile identity, authentication and tool inventory.
 */
import { closeDb, readSystem } from "../src/server/db/index";
import { safeDiagnosticFields } from "../src/server/diagnostics";
import { AGENT_ROLE_KEYS, AGENCY_HERMES_PROFILE_IDS, type AgentRoleKey, type AgentStatus } from "../src/lib/agents";
import {
  deriveEmployeeReadiness,
  internalAcknowledgementIsCurrent,
  internalIdentityIsCurrent,
} from "../src/lib/workforce-readiness";
import { agentSettingsSchema } from "../src/lib/agent-settings";
import { auditRoleConfiguration, recommendedSettings } from "../src/lib/role-playbooks";

if (!process.argv.includes("--live")) {
  console.error("This audit reads a remote database. Re-run with --live when that read is intended.");
  process.exit(2);
}

interface AgentRow {
  id: string;
  role_key: AgentRoleKey;
  display_name: string;
  enabled: boolean;
  status: AgentStatus;
  hermes_profile: string | null;
  hermes_gateway_id: string | null;
  credential_ready: boolean;
  active_config_version_id: string | null;
  config_version: number | null;
  config_applied_at: Date | null;
  settings: unknown;
  last_health_check_at: Date | null;
  last_health_ok: boolean | null;
  last_health_detail: string | null;
  tool_inventory_contract: string | null;
  tool_inventory_digest: string | null;
  tool_inventory_verified_at: Date | null;
  tool_inventory_expires_at: Date | null;
  tool_inventory_tool_count: number | null;
  active_run: boolean;
}

interface EvidenceRow {
  profile_check_status: string | null;
  profile_check_profile_id: string | null;
  profile_check_gateway_id: string | null;
  identity_verified: boolean | null;
  api_contract_verified: boolean | null;
  tool_permissions_status: string | null;
  checked_at: Date | null;
  acknowledged_at: Date | null;
  acknowledged_profile: string | null;
  acknowledged_policy_id: string | null;
  internal_policy_id: string | null;
  acknowledged_config_version_id: string | null;
  acknowledged_inventory_digest: string | null;
  agent_policy_override_id: string | null;
}

async function main() {
  const data = await readSystem(async (db) => {
    const agency = await db.query<{ id: string }>(
      "select id from organizations where kind = 'agency' order by created_at limit 1",
    );
    const orgId = agency.rows[0]?.id;
    if (!orgId) return { error: "No agency workspace exists in this database." as const };

    const agents = await db.query<AgentRow>(
      `select a.id,a.role_key,a.display_name,a.enabled,a.status,a.hermes_profile,a.hermes_gateway_id,
              (a.credential_id is not null and cred.revoked_at is null and cred_ref.revoked_at is null
                and cred.credential_reference_id is not null) as credential_ready,
              a.active_config_version_id,v.version as config_version,v.applied_at as config_applied_at,v.settings,
              a.last_health_check_at,a.last_health_ok,a.last_health_detail,
              a.tool_inventory_contract,a.tool_inventory_digest,a.tool_inventory_verified_at,
              a.tool_inventory_expires_at,a.tool_inventory_tool_count,
              exists(select 1 from agent_runs r where r.agent_instance_id=a.id and r.status in ('queued','running')) as active_run
         from agent_instances a
         left join agent_config_versions v on v.id=a.active_config_version_id and v.org_id=a.org_id
         left join integration_credentials cred on cred.id=a.credential_id
         left join credential_references cred_ref on cred_ref.id=cred.credential_reference_id
              and cred_ref.org_id=a.org_id and cred_ref.provider='hermes'
        where a.org_id=$1 and a.role_key=any($2::text[])
        order by a.role_key`,
      [orgId, [...AGENT_ROLE_KEYS]],
    );
    const company = await db.query<{
      description: string | null;
      services: string | null;
      ideal_customers: string | null;
      operating_area: string | null;
      industry: string | null;
    }>(
      `select p.description,p.services,p.ideal_customers,p.operating_area,o.industry
         from company_profiles p join organizations o on o.id=p.org_id where p.org_id=$1`,
      [orgId],
    );
    const policy = await db.query<{ id: string }>(
      "select id from hermes_tool_policies where scope_kind='internal_agency' and name='Full Hermes Capabilities'",
    );
    return { orgId, agents: agents.rows, company: company.rows[0] ?? null, internalPolicyId: policy.rows[0]?.id ?? null };
  });

  if ("error" in data) {
    console.log(JSON.stringify({ ok: false, error: data.error }, null, 2));
    await closeDb();
    process.exitCode = 1;
    return;
  }

  const companyFacts = {
    description: data.company?.description ?? "",
    services: data.company?.services ?? "",
    idealCustomers: data.company?.ideal_customers ?? "",
    operatingArea: data.company?.operating_area ?? "",
    industry: data.company?.industry ?? "",
  };
  const byRole = new Map(data.agents.map((agent) => [agent.role_key, agent]));
  const employees = AGENT_ROLE_KEYS.map((role) => {
    const agent = byRole.get(role);
    if (!agent) return { role, present: false, error: "Internal employee record is missing." };

    const evidenceRows = readSystem(async (db) => db.query<EvidenceRow>(
      `select c.status as profile_check_status,c.profile_id as profile_check_profile_id,c.gateway_id as profile_check_gateway_id,
              c.identity_verified,c.api_contract_verified,c.tool_permissions_status,c.checked_at,
              ack.acknowledged_at,ack.verified_profile as acknowledged_profile,ack.policy_id as acknowledged_policy_id,
              ack_history.policy_snapshot->>'activeConfigVersionId' as acknowledged_config_version_id,
              ack_history.policy_snapshot->>'inventoryDigest' as acknowledged_inventory_digest,
              agent_policy.id as agent_policy_override_id,
              ack_policy.id as internal_policy_id
         from agent_instances a
         left join agency_hermes_profile_checks c on c.agent_instance_id=a.id and c.org_id=a.org_id
         left join hermes_tool_policy_acknowledgements ack on ack.agent_id=a.id
         left join hermes_tool_policies ack_policy on ack_policy.id=ack.policy_id
              and ack_policy.scope_kind='internal_agency' and ack_policy.name='Full Hermes Capabilities'
         left join hermes_tool_policies agent_policy on agent_policy.scope_kind='agent' and agent_policy.agent_id=a.id
         left join lateral (
           select h.policy_snapshot from hermes_tool_policy_history h
            where h.agent_id=a.id and h.action='full_capabilities_acknowledged'
            order by h.occurred_at desc,h.id desc limit 1
         ) ack_history on true
        where a.id=$1 and a.org_id=$2`,
      [agent.id, data.orgId],
    )).then((result) => result.rows[0] ?? null);
    return evidenceRows.then((evidence) => {
      const expectedProfile = AGENCY_HERMES_PROFILE_IDS[role];
      const identityEvidence = {
        expectedProfile,
        savedProfile: agent.hermes_profile,
        savedGatewayId: agent.hermes_gateway_id,
        checkedProfile: evidence?.profile_check_profile_id ?? null,
        checkedGatewayId: evidence?.profile_check_gateway_id ?? null,
        checkStatus: evidence?.profile_check_status ?? null,
        identityVerified: evidence?.identity_verified ?? null,
        apiContractVerified: evidence?.api_contract_verified ?? null,
        toolPermissionsStatus: evidence?.tool_permissions_status ?? null,
        checkedAt: evidence?.checked_at ?? null,
        configAppliedAt: agent.config_applied_at,
      };
      const identityCurrent = internalIdentityIsCurrent(identityEvidence);
      const acknowledgementCurrent = internalAcknowledgementIsCurrent({
        ...identityEvidence,
        acknowledgedAt: evidence?.acknowledged_at ?? null,
        acknowledgedProfile: evidence?.acknowledged_profile ?? null,
        acknowledgedPolicyId: evidence?.acknowledged_policy_id ?? null,
        expectedPolicyId: evidence?.internal_policy_id ?? data.internalPolicyId ?? null,
        activeConfigVersionId: agent.active_config_version_id,
        acknowledgedConfigVersionId: evidence?.acknowledged_config_version_id ?? null,
        inventoryDigest: agent.tool_inventory_digest,
        acknowledgedInventoryDigest: evidence?.acknowledged_inventory_digest ?? null,
        credentialReady: agent.credential_ready,
        hasAgentPolicyOverride: Boolean(evidence?.agent_policy_override_id),
      });
      const readiness = deriveEmployeeReadiness({
        displayName: agent.display_name,
        enabled: agent.enabled,
        status: agent.status,
        configVersion: agent.config_version,
        lastHealthCheckAt: agent.last_health_check_at?.toISOString() ?? null,
        lastHealthOk: agent.last_health_ok,
        lastHealthDetail: agent.last_health_detail,
        inventoryContract: agent.tool_inventory_contract,
        inventoryDigest: agent.tool_inventory_digest,
        inventoryVerifiedAt: agent.tool_inventory_verified_at?.toISOString() ?? null,
        inventoryExpiresAt: agent.tool_inventory_expires_at?.toISOString() ?? null,
        inventoryToolCount: agent.tool_inventory_tool_count,
        credentialCurrent: agent.credential_ready,
        identityCurrent,
        acknowledgementCurrent,
        isAgencyEmployee: true,
        taskExecuting: agent.active_run,
      });
      const parsedSettings = agentSettingsSchema.safeParse(agent.settings ?? {});
      const activeConfigAudit = parsedSettings.success
        ? auditRoleConfiguration(role, parsedSettings.data, companyFacts)
        : null;
      const preview = auditRoleConfiguration(role, recommendedSettings(role), companyFacts);
      return {
        role,
        present: true,
        profile: agent.hermes_profile,
        enabled: agent.enabled,
        status: agent.status,
        configuration: {
          applied: agent.active_config_version_id !== null,
          version: agent.config_version,
          ready: activeConfigAudit?.ready ?? false,
          employeeFieldsComplete: activeConfigAudit?.employeeComplete ?? 0,
          employeeFieldsTotal: activeConfigAudit?.employeeTotal ?? 0,
          missingEmployeeFields: activeConfigAudit?.items.filter((item) => item.scope === "employee" && item.state === "missing").map((item) => item.label) ?? [],
          previewReady: preview.ready,
          previewEmployeeFieldsComplete: preview.employeeComplete,
          previewEmployeeFieldsTotal: preview.employeeTotal,
          previewMissingCompanyFacts: preview.missingCompanyFacts,
          schemaValid: parsedSettings.success,
        },
        connection: {
          savedCredentialCurrent: agent.credential_ready,
          lastHealthOk: agent.last_health_ok,
          hasRecordedInventory: Boolean(agent.tool_inventory_digest),
          inventoryToolCount: agent.tool_inventory_tool_count,
          profileIdentityCheckCurrent: identityCurrent,
          latestProfileCheckStatus: evidence?.profile_check_status ?? null,
          latestToolPermissionStatus: evidence?.tool_permissions_status ?? null,
          fullCapabilitiesAcknowledgementCurrent: acknowledgementCurrent,
        },
        readiness: {
          completed: readiness.completed,
          total: readiness.total,
          stage: readiness.stage,
          chatAvailable: readiness.chatAvailable,
          steps: readiness.steps.map((step) => ({ key: step.key, state: step.state })),
        },
      };
    });
  });

  const resolved = await Promise.all(employees);
  const readinessComplete = resolved.filter((item) => "readiness" in item && item.readiness.completed === item.readiness.total).length;
  console.log(JSON.stringify({
    ok: true,
    readOnly: true,
    employeeCount: resolved.length,
    employeesWithReadinessComplete: readinessComplete,
    companyFactsComplete: [companyFacts.description, companyFacts.services, companyFacts.idealCustomers, companyFacts.operatingArea].filter((value) => value.trim()).length,
    companyFactsTotal: 4,
    employees: resolved,
    notes: [
      "A readiness score is derived from saved configuration, connection, inventory, identity and acknowledgement evidence; no flags were changed.",
      "The configuration preview uses recommended role defaults and saved iAcquire company facts; it was not applied.",
      "Hermes effective SOUL instructions are not verifiable through the current API contract; the separate host attestation gate remains required.",
    ],
  }, null, 2));
  await closeDb();
}

main().catch(async (err) => {
  console.error("Internal workforce readiness audit failed safely", safeDiagnosticFields(err, "internal_workforce.readiness_audit"));
  await closeDb().catch(() => undefined);
  process.exitCode = 1;
});
