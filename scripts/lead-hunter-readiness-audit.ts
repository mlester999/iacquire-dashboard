/**
 * Read-only Lead Hunter readiness audit.
 *
 *   NODE_ENV=production node --env-file=.env --conditions=react-server --import tsx scripts/lead-hunter-readiness-audit.ts --live
 *
 * It reads the agency workspace, the Lead Hunter instance, the applied configuration, the current profile-check and
 * acknowledgement evidence, and reports the exact 6/6 readiness state. It performs only SELECT queries. It does not
 * apply a configuration, run a health check, acknowledge anything, contact Hermes or start a research run. It prints
 * counts and pass/fail evidence only: no credentials, prompts, customer records or profile secrets.
 *
 * `--live` is required so a production connection cannot happen by a mistyped command. The result is a report, not
 * an authorization to change production.
 */
import { closeDb, readSystem } from "../src/server/db/index";
import { safeDiagnosticFields } from "../src/server/diagnostics";
import { AGENCY_HERMES_PROFILE_IDS, type AgentStatus } from "../src/lib/agents";
import { deriveEmployeeReadiness, internalAcknowledgementIsCurrent, internalIdentityIsCurrent } from "../src/lib/workforce-readiness";
import { agentSettingsSchema } from "../src/lib/agent-settings";
import { auditRoleConfiguration, recommendedSettings } from "../src/lib/role-playbooks";

if (!process.argv.includes("--live")) {
  console.error("This audit reads a remote database. Re-run with --live when that read is intended.");
  process.exit(2);
}

interface AgentRow {
  id: string;
  org_id: string;
  enabled: boolean;
  status: string;
  display_name: string;
  hermes_profile: string | null;
  hermes_gateway_id: string | null;
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
  credential_id: string | null;
}

async function main() {
  const result = await readSystem(async (db) => {
    const agency = await db.query<{ id: string }>("select id from organizations where kind = 'agency' order by created_at limit 1");
    const orgId = agency.rows[0]?.id;
    if (!orgId) return { error: "No agency workspace exists in this database." as const };

    const agents = await db.query<AgentRow>(
      `select a.id, a.org_id, a.enabled, a.status, a.display_name, a.hermes_profile, a.hermes_gateway_id,
              a.active_config_version_id, v.version as config_version, v.applied_at as config_applied_at, v.settings,
              a.last_health_check_at, a.last_health_ok, a.last_health_detail,
              a.tool_inventory_contract, a.tool_inventory_digest, a.tool_inventory_verified_at,
              a.tool_inventory_expires_at, a.tool_inventory_tool_count, a.credential_id
         from agent_instances a
         left join agent_config_versions v on v.id = a.active_config_version_id
        where a.org_id = $1 and a.role_key = 'lead_hunter'`,
      [orgId],
    );
    const agent = agents.rows[0];
    if (!agent) return { error: "The agency workspace has no Lead Hunter employee row." as const };

    const credentials = await db.query<{ revoked_at: Date | null }>(
      "select revoked_at from integration_credentials where id = $1 and org_id = $2 and provider = 'hermes'",
      [agent.credential_id, orgId],
    );
    const credentialReady = agent.credential_id !== null && credentials.rows[0] && credentials.rows[0].revoked_at === null;

    const evidence = await db.query<{
      profile_check_status: string | null; profile_check_profile_id: string | null; profile_check_gateway_id: string | null;
      identity_verified: boolean | null; api_contract_verified: boolean | null; tool_permissions_status: string | null; checked_at: Date | null;
      acknowledged_at: Date | null; acknowledged_profile: string | null; acknowledged_policy_id: string | null; internal_policy_id: string | null;
      acknowledged_config_version_id: string | null; acknowledged_inventory_digest: string | null; agent_policy_override_id: string | null;
    }>(
      `select c.status as profile_check_status,c.profile_id as profile_check_profile_id,c.gateway_id as profile_check_gateway_id,
              c.identity_verified,c.api_contract_verified,c.tool_permissions_status,c.checked_at,
              ack.acknowledged_at,ack.verified_profile as acknowledged_profile,ack.policy_id as acknowledged_policy_id,
              ack_policy.id as internal_policy_id,
              ack_history.policy_snapshot->>'activeConfigVersionId' as acknowledged_config_version_id,
              ack_history.policy_snapshot->>'inventoryDigest' as acknowledged_inventory_digest,
              agent_policy.id as agent_policy_override_id
         from agent_instances a
         left join agency_hermes_profile_checks c on c.agent_instance_id=a.id and c.org_id=a.org_id
         left join hermes_tool_policy_acknowledgements ack on ack.agent_id=a.id
         left join hermes_tool_policies ack_policy on ack_policy.id=ack.policy_id and ack_policy.scope_kind='internal_agency' and ack_policy.name='Full Hermes Capabilities'
         left join hermes_tool_policies agent_policy on agent_policy.scope_kind='agent' and agent_policy.agent_id=a.id
         left join lateral (
           select h.policy_snapshot from hermes_tool_policy_history h
           where h.agent_id=a.id and h.action='full_capabilities_acknowledged'
           order by h.occurred_at desc,h.id desc limit 1
         ) ack_history on true
        where a.id=$1 and a.org_id=$2`,
      [agent.id, orgId],
    );
    const row = evidence.rows[0];

    const company = await db.query<{ description: string | null; services: string | null; ideal_customers: string | null; operating_area: string | null; industry: string | null }>(
      `select p.description, p.services, p.ideal_customers, p.operating_area, o.industry
         from company_profiles p left join organizations o on o.id = p.org_id
        where p.org_id = $1`,
      [orgId],
    );
    return { orgId, agent, credentialReady: Boolean(credentialReady), evidence: row, company: company.rows[0] ?? null };
  });

  if ("error" in result) {
    console.log(JSON.stringify({ ok: false, error: result.error }, null, 2));
    await closeDb();
    process.exitCode = 1;
    return;
  }

  const { agent, evidence, credentialReady, company } = result;
  const identityEvidence = {
    expectedProfile: AGENCY_HERMES_PROFILE_IDS.lead_hunter,
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
    expectedPolicyId: evidence?.internal_policy_id ?? null,
    activeConfigVersionId: agent.active_config_version_id,
    acknowledgedConfigVersionId: evidence?.acknowledged_config_version_id ?? null,
    inventoryDigest: agent.tool_inventory_digest,
    acknowledgedInventoryDigest: evidence?.acknowledged_inventory_digest ?? null,
    credentialReady,
    hasAgentPolicyOverride: Boolean(evidence?.agent_policy_override_id),
  });
  const readiness = deriveEmployeeReadiness({
    displayName: agent.display_name,
    enabled: agent.enabled,
    status: agent.status as AgentStatus,
    configVersion: agent.config_version,
    lastHealthCheckAt: agent.last_health_check_at?.toISOString() ?? null,
    lastHealthOk: agent.last_health_ok,
    lastHealthDetail: agent.last_health_detail,
    inventoryContract: agent.tool_inventory_contract,
    inventoryDigest: agent.tool_inventory_digest,
    inventoryVerifiedAt: agent.tool_inventory_verified_at?.toISOString() ?? null,
    inventoryExpiresAt: agent.tool_inventory_expires_at?.toISOString() ?? null,
    inventoryToolCount: agent.tool_inventory_tool_count,
    credentialCurrent: credentialReady,
    identityCurrent,
    acknowledgementCurrent,
    isAgencyEmployee: true,
    taskExecuting: false,
  });

  const companyFacts = {
    description: company?.description ?? "",
    services: company?.services ?? "",
    idealCustomers: company?.ideal_customers ?? "",
    operatingArea: company?.operating_area ?? "",
    industry: company?.industry ?? "",
  };
  const parsedSettings = agentSettingsSchema.safeParse(agent.settings ?? {});
  const configAudit = parsedSettings.success
    ? auditRoleConfiguration("lead_hunter", parsedSettings.data, companyFacts)
    : null;
  // Report company-fact coverage even when no configuration is applied yet. This is what the
  // operator must supply before the recommended role setup can be complete.
  const companyCoverage = auditRoleConfiguration("lead_hunter", recommendedSettings("lead_hunter"), companyFacts);

  const blockers = readiness.steps
    .filter((step) => step.state !== "done" && step.key !== "ready")
    .map((step) => ({ key: step.key, label: step.label, detail: step.description }));

  console.log(JSON.stringify({
    ok: true,
    employee: "Lead Hunter",
    readiness: {
      completed: readiness.completed,
      total: readiness.total,
      stage: readiness.stage,
      label: readiness.label,
      chatAvailable: readiness.chatAvailable,
      steps: readiness.steps,
    },
    evidence: {
      configurationApplied: agent.active_config_version_id !== null,
      configVersion: agent.config_version,
      connectionChecked: agent.last_health_check_at !== null,
      lastHealthOk: agent.last_health_ok,
      inventoryRecorded: Boolean(agent.tool_inventory_digest),
      inventoryToolCount: agent.tool_inventory_tool_count,
      credentialReady,
      identityCurrent,
      acknowledgementCurrent,
    },
    configurationQuality: configAudit
      ? {
          ready: configAudit.ready,
          employeeComplete: configAudit.employeeComplete,
          employeeTotal: configAudit.employeeTotal,
          companyComplete: configAudit.companyComplete,
          companyTotal: configAudit.companyTotal,
          missingCompanyFacts: configAudit.missingCompanyFacts,
          missingEmployeeFields: configAudit.items.filter((item) => item.scope === "employee" && item.state === "missing").map((item) => item.label),
        }
      : { ready: false, error: "The applied settings do not match the current configuration schema." },
    companyFacts: {
      complete: companyCoverage.companyComplete,
      total: companyCoverage.companyTotal,
      missing: companyCoverage.missingCompanyFacts,
    },
    blockers,
    approvalCheckpoint: readiness.completed === readiness.total && configAudit?.ready
      ? "No activation change remains. A supervised live research run still needs explicit authorization."
      : "Applying/saving the production configuration, running the health/profile checks and recording the Super Admin acknowledgement are separate production actions. This audit did not perform them; explicit authorization is required.",
  }, null, 2));
  await closeDb();
}

main().catch(async (err) => {
  console.error("Lead Hunter readiness audit failed safely", safeDiagnosticFields(err, "lead_hunter.readiness_audit"));
  await closeDb().catch(() => undefined);
  process.exitCode = 1;
});
