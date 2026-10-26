/**
 * Read-only production activation preflight for the current workforce release migrations.
 *
 *   NODE_ENV=production DATABASE_SSL_CA_FILE=certs/prod-ca-2021.crt \
 *     node --env-file=.env --conditions=react-server --import tsx \
 *     scripts/production-activation-preflight.ts --live
 *
 * It performs SELECT queries only. It never applies a migration, creates a table, writes a profile,
 * changes a Hermes setting or starts research.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { closeDb, MIGRATION_PREREQUISITES, readSystem } from "../src/server/db";
import { AGENT_ROLE_KEYS, AGENCY_HERMES_PROFILE_IDS, type AgentRoleKey } from "../src/lib/agents";
import { agentSettingsSchema } from "../src/lib/agent-settings";
import { auditRoleConfiguration, recommendedSettings } from "../src/lib/role-playbooks";
import {
  deriveEmployeeReadiness,
  internalAcknowledgementIsCurrent,
  internalIdentityIsCurrent,
  readinessClockNow,
} from "../src/lib/workforce-readiness";
import { toolInventoryReady, toolInventoryRecorded } from "../src/lib/hermes-tool-inventory";
import { OPTIONAL_INVENTORY_TOOLS, REQUIRED_INVENTORY_TOOLS } from "../src/server/integrations/hermes/inventory";

if (!process.argv.includes("--live")) {
  console.error("This reads the hosted database. Re-run with --live when that read is intended.");
  process.exit(2);
}

const TARGETS: Array<{
  version: string;
  tables: string[];
  columns: string[];
  constraints?: string[];
}> = [
  {
    version: "0077_ai_work_jobs",
    tables: ["ai_work_jobs", "ai_work_events"],
    columns: [
      "lead_research_requests.work_job_id",
      "chat_messages.work_job_id",
      "leads.duplicate_matches",
      "leads.public_contact",
    ],
  },
  { version: "0078_ai_work_schedules", tables: ["ai_work_schedules"], columns: [] },
  { version: "0079_ai_work_triggers", tables: ["ai_work_triggers"], columns: [] },
  {
    version: "0080_proactive_ai_employees",
    tables: ["ai_work_reports", "ai_work_report_deliveries"],
    columns: [
      "ai_work_schedules.business_hours",
      "ai_work_schedules.last_skipped_reason",
      "ai_work_schedules.last_skipped_at",
      "ai_work_schedules.payload",
    ],
  },
  { version: "0081_ai_work_job_rls_hardening", tables: ["ai_work_jobs", "ai_work_events"], columns: [] },
  {
    version: "0084_restricted_hermes_provisioner",
    tables: [],
    columns: [
      "hermes_gateways.provisioner_isolation_verified_at",
      "agent_instances.hermes_profile_config_version_id",
      "agent_provisioning_jobs.config_version_id",
      "agent_provisioning_jobs.source_job_id",
      "agent_provisioning_jobs.manifest_soul_sha256",
      "agent_provisioning_jobs.manifest_policy_config_sha256",
      "agent_provisioning_jobs.manifest_challenge_sha256",
    ],
  },
  {
    version: "0105_workforce_local_recurrence",
    tables: [],
    columns: ["ai_work_schedules.recurrence_rule"],
  },
  {
    version: "0106_workforce_chat_schedule_previews",
    tables: [],
    columns: ["chat_conversations.pending_workforce_schedule"],
  },
  {
    version: "0107_workforce_chat_booking_previews",
    tables: [],
    columns: ["chat_conversations.pending_workforce_booking"],
  },
  {
    version: "0108_workforce_appointment_changes",
    tables: [],
    columns: ["chat_conversations.pending_workforce_appointment_change"],
    constraints: ["approval_requests.approval_requests_kind_check"],
  },
  {
    version: "0109_employee_health_probe",
    tables: ["agent_health_probes"],
    columns: [
      "agent_instances.health_consecutive_failures",
      "agent_instances.last_healthy_at",
      "agent_instances.last_health_failure_at",
      "agent_instances.last_probe_at",
      "agent_instances.last_probe_source",
      "agent_instances.health_alerted_at",
    ],
  },
];

const REQUIRED_FUNCTIONS = ["app.touch_updated_at", "app.has_permission", "app.current_user_id", "app.permitted_orgs"];

function sha(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function main() {
  const migrationsDir = path.resolve(process.cwd(), "supabase", "migrations");
  const localVersions = fs
    .readdirSync(migrationsDir)
    .filter((file) => /^\d{4}_.+\.sql$/.test(file))
    .map((file) => file.replace(/\.sql$/, ""));
  const hashes = Object.fromEntries(
    TARGETS.map((target) => [target.version, sha(path.join(migrationsDir, `${target.version}.sql`))]),
  );

  const data = await readSystem(async (db) => {
    const appTable = await db.query<{ t: string | null }>("select to_regclass('public.schema_migrations')::text as t");
    const appLedger = appTable.rows[0]?.t
      ? await db.query<{ version: string; applied_at: Date }>("select version, applied_at from schema_migrations order by version")
      : { rows: [] as Array<{ version: string; applied_at: Date }> };
    const cliTable = await db.query<{ t: string | null }>("select to_regclass('supabase_migrations.schema_migrations')::text as t");
    const cliLedger = cliTable.rows[0]?.t
      ? await db.query<{ version: string }>("select version from supabase_migrations.schema_migrations order by version")
      : { rows: [] as Array<{ version: string }> };
    const checkedTables = [...new Set([
      ...TARGETS.flatMap((target) => target.tables),
      "organizations", "users", "agent_instances", "agent_runs", "lead_research_requests", "lead_targeting_profiles", "leads", "chat_messages", "notifications", "crm_events",
    ])];
    const tableRows = await db.query<{ name: string }>(
      "select tablename as name from pg_tables where schemaname = 'public' and tablename = any($1::text[])",
      [checkedTables],
    );
    const columnRows = await db.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
        where table_schema = 'public' and (table_name, column_name) in (
          select * from unnest($1::text[], $2::text[])
        )`,
      [TARGETS.flatMap((target) => target.columns).map((item) => item.split(".")[0]), TARGETS.flatMap((target) => target.columns).map((item) => item.split(".")[1])],
    );
    const constraintNames = TARGETS.flatMap((target) => target.constraints ?? []).map((item) => item.split(".")[1]);
    const constraintRows = constraintNames.length
      ? await db.query<{ table_name: string; constraint_name: string }>(
          `select r.relname as table_name, c.conname as constraint_name
             from pg_constraint c join pg_class r on r.oid=c.conrelid join pg_namespace n on n.oid=r.relnamespace
            where n.nspname='public' and c.conname=any($1::text[])`,
          [constraintNames],
        )
      : { rows: [] as Array<{ table_name: string; constraint_name: string }> };
    const functionRows = await db.query<{ name: string }>(
      `select n.nspname || '.' || p.proname as name
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where (n.nspname || '.' || p.proname) = any($1::text[])`,
      [REQUIRED_FUNCTIONS],
    );
    const agentKey = await db.query<{ def: string }>(
      `select pg_get_constraintdef(c.oid) as def from pg_constraint c
        where c.conrelid = 'agent_instances'::regclass and c.contype in ('p', 'u')`,
    );
    const agencies = await db.query<{ id: string; name: string }>("select id, name from organizations where kind = 'agency' order by created_at");
    const agency = agencies.rows[0] ?? null;
    const companyProfile = agency
      ? await db.query<{ description: string; services: string; ideal_customers: string; operating_area: string; industry: string | null }>(
          `select p.description, p.services, p.ideal_customers, p.operating_area, o.industry
             from company_profiles p left join organizations o on o.id = p.org_id where p.org_id = $1`,
          [agency.id],
        )
      : { rows: [] as Array<{ description: string; services: string; ideal_customers: string; operating_area: string; industry: string | null }> };
    const internalEmployees = agency
      ? await db.query<{
          id: string; role_key: AgentRoleKey; display_name: string; enabled: boolean; status: string;
          active_config_version_id: string | null; config_version: number | null; config_applied_at: Date | null;
          config_status: string | null; settings: unknown; last_health_check_at: Date | null; last_health_ok: boolean | null;
          last_health_detail: string | null; tool_inventory_contract: string | null; tool_inventory_digest: string | null;
          tool_inventory_verified_at: Date | null; tool_inventory_expires_at: Date | null; tool_inventory_tool_count: number | null;
          hermes_profile: string | null; hermes_gateway_id: string | null; check_status: string | null;
          check_profile: string | null; check_gateway_id: string | null; identity_verified: boolean | null;
          api_contract_verified: boolean | null; tool_permissions_status: string | null; checked_at: Date | null;
          credential_ready: boolean; acknowledged_profile: string | null; acknowledged_policy_id: string | null;
          acknowledged_at: Date | null; acknowledged_config_version_id: string | null;
          acknowledged_inventory_digest: string | null; has_agent_policy_override: boolean; expected_policy_id: string | null;
        }>(
          `select a.id,a.role_key,a.display_name,a.enabled,a.status,a.active_config_version_id,
                  v.version as config_version,v.applied_at as config_applied_at,v.status as config_status,v.settings,
                  a.last_health_check_at,a.last_health_ok,a.last_health_detail,
                  a.tool_inventory_contract,a.tool_inventory_digest,a.tool_inventory_verified_at,
                  a.tool_inventory_expires_at,a.tool_inventory_tool_count,
                  a.hermes_profile,a.hermes_gateway_id,
                  c.status as check_status,c.profile_id as check_profile,c.gateway_id as check_gateway_id,
                  c.identity_verified,c.api_contract_verified,c.tool_permissions_status,c.checked_at,
                  (a.credential_id is not null and cred.revoked_at is null
                    and cred.credential_reference_id is not null and cred_ref.revoked_at is null) as credential_ready,
                  ack.verified_profile as acknowledged_profile,ack.policy_id as acknowledged_policy_id,ack.acknowledged_at,
                  ack_history.policy_snapshot->>'activeConfigVersionId' as acknowledged_config_version_id,
                  ack_history.policy_snapshot->>'inventoryDigest' as acknowledged_inventory_digest,
                  exists(select 1 from hermes_tool_policies agent_policy
                    where agent_policy.scope_kind='agent' and agent_policy.agent_id=a.id) as has_agent_policy_override,
                  (select p.id from hermes_tool_policies p where p.scope_kind='internal_agency' order by p.created_at limit 1) as expected_policy_id
             from agent_instances a
             left join agent_config_versions v on v.id=a.active_config_version_id and v.org_id=a.org_id
             left join agency_hermes_profile_checks c on c.agent_instance_id=a.id and c.org_id=a.org_id
             left join integration_credentials cred on cred.id=a.credential_id
             left join credential_references cred_ref on cred_ref.id=cred.credential_reference_id
                  and cred_ref.org_id=a.org_id and cred_ref.provider='hermes'
             left join hermes_tool_policy_acknowledgements ack on ack.agent_id=a.id
             left join lateral (
               select h.policy_snapshot from hermes_tool_policy_history h
                where h.agent_id=a.id and h.action='full_capabilities_acknowledged'
                order by h.occurred_at desc,h.id desc limit 1
             ) ack_history on true
            where a.org_id=$1 and a.role_key=any($2::text[])
            order by array_position($2::text[],a.role_key)` ,
          [agency.id, AGENT_ROLE_KEYS],
        )
      : { rows: [] as Array<{
          id: string; role_key: AgentRoleKey; display_name: string; enabled: boolean; status: string;
          active_config_version_id: string | null; config_version: number | null; config_applied_at: Date | null;
          config_status: string | null; settings: unknown; last_health_check_at: Date | null; last_health_ok: boolean | null;
          last_health_detail: string | null; tool_inventory_contract: string | null; tool_inventory_digest: string | null;
          tool_inventory_verified_at: Date | null; tool_inventory_expires_at: Date | null; tool_inventory_tool_count: number | null;
          hermes_profile: string | null; hermes_gateway_id: string | null; check_status: string | null;
          check_profile: string | null; check_gateway_id: string | null; identity_verified: boolean | null;
          api_contract_verified: boolean | null; tool_permissions_status: string | null; checked_at: Date | null;
          credential_ready: boolean; acknowledged_profile: string | null; acknowledged_policy_id: string | null;
          acknowledged_at: Date | null; acknowledged_config_version_id: string | null;
          acknowledged_inventory_digest: string | null; has_agent_policy_override: boolean; expected_policy_id: string | null;
        }> };
    const workforceQueues = agency
      ? await db.query<{ status: string; capability: string; count: number }>(
          "select status,capability,count(*)::int as count from ai_work_jobs where org_id=$1 group by status,capability order by status,capability",
          [agency.id],
        )
      : { rows: [] as Array<{ status: string; capability: string; count: number }> };
    const scheduleState = agency
      ? await db.query<{
          schedules: number; enabled_schedules: number; triggers: number; enabled_triggers: number;
          open_reports: number; open_approvals: number;
        }>(
          `select
             (select count(*)::int from ai_work_schedules where org_id=$1) as schedules,
             (select count(*)::int from ai_work_schedules where org_id=$1 and enabled) as enabled_schedules,
             (select count(*)::int from ai_work_triggers where org_id=$1) as triggers,
             (select count(*)::int from ai_work_triggers where org_id=$1 and enabled) as enabled_triggers,
             (select count(*)::int from ai_work_reports where org_id=$1 and status='open') as open_reports,
             (select count(*)::int from approval_requests where org_id=$1 and status='pending') as open_approvals`,
          [agency.id],
        )
      : { rows: [] as Array<{
          schedules: number; enabled_schedules: number; triggers: number; enabled_triggers: number;
          open_reports: number; open_approvals: number;
        }> };
    const hunters = agency
      ? await db.query<{
          display_name: string; role_key: string; status: string; enabled: boolean; hermes_profile: string | null;
          config_version: number | null; credential_present: boolean; credential_id: string | null; inventory_count: number | null;
          inventory_digest: string | null; inventory_contract: string | null; inventory_snapshot: unknown;
        }>(
          `select a.display_name, a.role_key, a.status, a.enabled, a.hermes_profile,
                  v.version as config_version, (a.credential_id is not null) as credential_present, a.credential_id,
                  a.tool_inventory_tool_count as inventory_count, a.tool_inventory_digest as inventory_digest,
                  a.tool_inventory_contract as inventory_contract, a.tool_inventory_snapshot as inventory_snapshot
             from agent_instances a
             left join agent_config_versions v on v.id = a.active_config_version_id and v.org_id = a.org_id
            where a.org_id = $1 and a.role_key = 'lead_hunter'`,
          [agency.id],
        )
      : { rows: [] };
    const zeng = agency
      ? await db.query<{ credential_id: string | null; hermes_profile: string | null }>(
          "select credential_id, hermes_profile from agent_instances where org_id = $1 and role_key = 'operations_manager'",
          [agency.id],
        )
      : { rows: [] as Array<{ credential_id: string | null; hermes_profile: string | null }> };
    return {
      agencyCount: agencies.rows.length,
      agency,
      companyProfile: companyProfile.rows[0] ?? null,
      internalEmployees: internalEmployees.rows,
      workforceQueues: workforceQueues.rows,
      scheduleState: scheduleState.rows[0] ?? null,
      leadHunter: hunters.rows[0] ?? null,
      zeng: zeng.rows[0] ?? null,
      appLedger: appLedger.rows.map((row) => ({ version: row.version, appliedAt: row.applied_at.toISOString() })),
      cliLedger: cliLedger.rows.map((row) => row.version),
      tables: new Set(tableRows.rows.map((row) => row.name)),
      columns: new Set(columnRows.rows.map((row) => `${row.table_name}.${row.column_name}`)),
      constraints: new Set(constraintRows.rows.map((row) => `${row.table_name}.${row.constraint_name}`)),
      functions: new Set(functionRows.rows.map((row) => row.name)),
      agentKey: agentKey.rows.map((row) => row.def),
    };
  });

  const appApplied = new Set(data.appLedger.map((row) => row.version));
  const cliPrefixes = new Set(data.cliLedger);
  const applied = new Set(appApplied);
  for (const version of localVersions) {
    if (cliPrefixes.has(version.slice(0, 4))) applied.add(version);
  }
  const migrations = TARGETS.map((target) => {
    const missingTables = target.tables.filter((table) => !data.tables.has(table));
    const missingColumns = target.columns.filter((column) => !data.columns.has(column));
    const missingConstraints = (target.constraints ?? []).filter((constraint) => !data.constraints.has(constraint));
    const version = target.version;
    const prefix = version.slice(0, 4);
    const appVersionApplied = appApplied.has(version);
    const cliPrefixApplied = cliPrefixes.has(prefix);
    const migrationApplied = appVersionApplied || cliPrefixApplied;
    const prerequisites = MIGRATION_PREREQUISITES[version] ?? [];
    const missingPrerequisites = prerequisites.filter((required) => !applied.has(required));
    const objectsPresent = missingTables.length === 0 && missingColumns.length === 0 && missingConstraints.length === 0;
    return {
      version,
      applied: migrationApplied,
      appLedgerApplied: appVersionApplied,
      cliPrefixApplied,
      prerequisites,
      missingPrerequisites,
      sha256: hashes[version],
      expectedTables: target.tables,
      missingTables,
      missingColumns,
      expectedConstraints: target.constraints ?? [],
      missingConstraints,
      objectsPresent,
      schemaPresentWithoutLedger: !migrationApplied && objectsPresent,
    };
  });

  const dependencies = {
    baseTables: ["organizations", "users", "agent_instances", "agent_runs", "lead_research_requests", "lead_targeting_profiles", "leads", "chat_messages", "notifications", "crm_events"]
      .map((table) => ({ table, present: data.tables.has(table) })),
    functions: REQUIRED_FUNCTIONS.map((name) => ({ name, present: data.functions.has(name) })),
    agentInstanceIdOrgKey: data.agentKey.some((def) => /\(id, org_id\)/i.test(def)),
  };

  const snapshot = data.leadHunter?.inventory_snapshot;
  const inventoryTools = (() => {
    if (!snapshot || typeof snapshot !== "object") return [] as Array<{ name: string; toolset: string }>;
    const tools = (snapshot as { tools?: unknown }).tools;
    if (!Array.isArray(tools)) return [] as Array<{ name: string; toolset: string }>;
    return tools
      .filter((tool): tool is { name: string; toolset: string } => Boolean(tool) && typeof tool === "object" && typeof (tool as { name?: unknown }).name === "string")
      .map((tool) => ({ name: tool.name, toolset: typeof tool.toolset === "string" ? tool.toolset : "unknown" }));
  })();

  const inventoryNames = inventoryTools.map((tool) => tool.name);
  const missingRequiredTools = REQUIRED_INVENTORY_TOOLS.filter((name) => !inventoryNames.includes(name));
  const unexpectedTools = inventoryNames.filter((name) => ![...REQUIRED_INVENTORY_TOOLS, ...OPTIONAL_INVENTORY_TOOLS].includes(name));
  const inventoryMatchesReviewedSet = missingRequiredTools.length === 0 && unexpectedTools.length === 0;

  const targetVersions = new Set(TARGETS.map((target) => target.version));
  const pendingTargets = migrations.filter((migration) => !migration.applied).map((migration) => migration.version);
  const companyFacts = {
    description: data.companyProfile?.description ?? "",
    services: data.companyProfile?.services ?? "",
    idealCustomers: data.companyProfile?.ideal_customers ?? "",
    operatingArea: data.companyProfile?.operating_area ?? "",
    industry: data.companyProfile?.industry ?? "",
  };
  const configPreview = auditRoleConfiguration("lead_hunter", recommendedSettings("lead_hunter"), companyFacts);
  const evaluatedAt = new Date(readinessClockNow());
  const internalEmployees = data.internalEmployees.map((employee) => {
    const role = employee.role_key;
    const parsedSettings = employee.settings === null ? null : agentSettingsSchema.safeParse(employee.settings);
    const appliedSettings = parsedSettings?.success ? parsedSettings.data : null;
    const defaultsAudit = auditRoleConfiguration(role, recommendedSettings(role), companyFacts);
    const activeAudit = appliedSettings ? auditRoleConfiguration(role, appliedSettings, companyFacts) : null;
    const identityEvidence = {
      expectedProfile: AGENCY_HERMES_PROFILE_IDS[role],
      savedProfile: employee.hermes_profile,
      savedGatewayId: employee.hermes_gateway_id,
      checkedProfile: employee.check_profile,
      checkedGatewayId: employee.check_gateway_id,
      checkStatus: employee.check_status,
      identityVerified: employee.identity_verified,
      apiContractVerified: employee.api_contract_verified,
      toolPermissionsStatus: employee.tool_permissions_status,
      checkedAt: employee.checked_at,
      configAppliedAt: employee.config_applied_at,
    };
    const identityCurrent = internalIdentityIsCurrent(identityEvidence);
    const inventoryEvidence = {
      last_health_ok: employee.last_health_ok,
      tool_inventory_contract: employee.tool_inventory_contract,
      tool_inventory_digest: employee.tool_inventory_digest,
      tool_inventory_verified_at: employee.tool_inventory_verified_at,
      tool_inventory_expires_at: employee.tool_inventory_expires_at,
      tool_inventory_tool_count: employee.tool_inventory_tool_count,
    };
    const inventoryRecorded = toolInventoryRecorded(inventoryEvidence);
    const acknowledgementCurrent = internalAcknowledgementIsCurrent({
      ...identityEvidence,
      acknowledgedAt: employee.acknowledged_at,
      acknowledgedProfile: employee.acknowledged_profile,
      acknowledgedPolicyId: employee.acknowledged_policy_id,
      expectedPolicyId: employee.expected_policy_id,
      activeConfigVersionId: employee.active_config_version_id,
      acknowledgedConfigVersionId: employee.acknowledged_config_version_id,
      inventoryDigest: employee.tool_inventory_digest,
      acknowledgedInventoryDigest: employee.acknowledged_inventory_digest,
      credentialReady: employee.credential_ready,
      hasAgentPolicyOverride: employee.has_agent_policy_override,
    });
    const readiness = deriveEmployeeReadiness({
      displayName: employee.display_name,
      enabled: employee.enabled,
      status: employee.status as "online" | "busy" | "offline" | "setup_required" | "provisioning" | "error",
      configVersion: employee.config_version,
      lastHealthCheckAt: employee.last_health_check_at?.toISOString() ?? null,
      lastHealthOk: employee.last_health_ok,
      lastHealthDetail: employee.last_health_detail,
      inventoryContract: employee.tool_inventory_contract,
      inventoryDigest: employee.tool_inventory_digest,
      inventoryVerifiedAt: employee.tool_inventory_verified_at?.toISOString() ?? null,
      inventoryExpiresAt: employee.tool_inventory_expires_at?.toISOString() ?? null,
      inventoryToolCount: employee.tool_inventory_tool_count,
      credentialCurrent: employee.credential_ready,
      identityCurrent,
      acknowledgementCurrent,
      isAgencyEmployee: true,
      evaluatedAt,
    });
    return {
      role,
      displayName: employee.display_name,
      enabled: employee.enabled,
      status: employee.status,
      expectedProfileMatches: employee.hermes_profile === AGENCY_HERMES_PROFILE_IDS[role],
      appliedConfiguration: {
        version: employee.config_version,
        status: employee.config_status,
        settingsValid: employee.active_config_version_id ? parsedSettings?.success === true : false,
        roleFieldsComplete: activeAudit?.employeeComplete ?? null,
        roleFieldsTotal: activeAudit?.employeeTotal ?? defaultsAudit.employeeTotal,
        companyFactsComplete: activeAudit?.companyComplete ?? null,
        companyFactsTotal: activeAudit?.companyTotal ?? defaultsAudit.companyTotal,
        qualityReady: activeAudit?.ready ?? false,
        missingRoleFields: activeAudit?.items.filter((item) => item.scope === "employee" && item.state === "missing").map((item) => item.label) ?? null,
        missingCompanyFacts: activeAudit?.missingCompanyFacts ?? null,
      },
      recommendedConfigurationPreview: {
        roleFieldsComplete: defaultsAudit.employeeComplete,
        roleFieldsTotal: defaultsAudit.employeeTotal,
        companyFactsComplete: defaultsAudit.companyComplete,
        companyFactsTotal: defaultsAudit.companyTotal,
        readyWithoutInventingFacts: defaultsAudit.ready,
      },
      credentialCurrent: employee.credential_ready,
      lastHealthCheck: { at: employee.last_health_check_at?.toISOString() ?? null, passed: employee.last_health_ok },
      inventoryRecorded,
      inventoryCurrent: toolInventoryReady(inventoryEvidence, evaluatedAt),
      identityCurrent,
      acknowledgementCurrent,
      readiness: {
        score: `${readiness.completed}/${readiness.total}`,
        chatAvailable: readiness.chatAvailable,
        stage: readiness.stage,
        blockedSteps: readiness.steps.filter((step) => step.state !== "done").map((step) => step.key),
      },
    };
  });
  const internalWorkforceSummary = {
    rosterComplete: internalEmployees.length === AGENT_ROLE_KEYS.length,
    employees: internalEmployees.length,
    readyForAuthorizedChat: internalEmployees.filter((employee) => employee.readiness.chatAvailable).length,
    fullyReady: internalEmployees.filter((employee) => employee.readiness.score === "6/6" && employee.readiness.chatAvailable).length,
    byReadinessStage: Object.fromEntries(
      [...new Set(internalEmployees.map((employee) => employee.readiness.stage))]
        .map((stage) => [stage, internalEmployees.filter((employee) => employee.readiness.stage === stage).length]),
    ),
  };

  const appPrefixCollisions = TARGETS.flatMap((target) => {
    const prefix = target.version.slice(0, 4);
    return data.appLedger
      .filter((row) => row.version.startsWith(prefix) && row.version !== target.version)
      .map((row) => ({ local: target.version, applied: row.version }));
  });
  const cliPrefixCollisions = TARGETS.flatMap((target) => {
    const prefix = target.version.slice(0, 4);
    return data.cliLedger
      .filter((row) => row === prefix && !appApplied.has(target.version))
      .map((row) => ({ local: target.version, appliedPrefix: row }));
  });
  const appliedTargets = migrations.filter((migration) => migration.applied).map((migration) => migration.version);
  const pendingOther = localVersions.filter((version) => !applied.has(version) && !targetVersions.has(version));

  console.log(JSON.stringify({
    ok: true,
    readOnly: true,
    target: "0077–0081, 0084, 0105–0109",
    appliedTargets,
    pendingTargets,
    pendingOtherLocalMigrations: pendingOther,
    prefixCollisions: { appLedger: appPrefixCollisions, cliLedger: cliPrefixCollisions },
    migrations,
    dependencies,
    agencyCount: data.agencyCount,
    agency: data.agency ? { name: data.agency.name } : null,
    companyProfile: data.companyProfile
      ? {
          description: data.companyProfile.description.length,
          services: data.companyProfile.services.length,
          idealCustomers: data.companyProfile.ideal_customers.length,
          operatingArea: data.companyProfile.operating_area.length,
          industryPresent: Boolean(data.companyProfile.industry?.trim()),
          complete: [data.companyProfile.description, data.companyProfile.services, data.companyProfile.ideal_customers, data.companyProfile.operating_area].every((value) => value.trim().length > 0),
        }
      : null,
    configurationPreview: {
      role: "lead_hunter",
      employeeFieldsComplete: configPreview.employeeComplete,
      employeeFieldsTotal: configPreview.employeeTotal,
      companyFactsComplete: configPreview.companyComplete,
      companyFactsTotal: configPreview.companyTotal,
      missingCompanyFacts: configPreview.missingCompanyFacts,
      readyToApplyWithoutInventingFacts: configPreview.ready,
      note: "Built from recommendedSettings(lead_hunter) and the current saved company facts; nothing was saved.",
    },
    internalWorkforce: {
      summary: internalWorkforceSummary,
      employees: internalEmployees,
      jobCountsByStatusAndCapability: data.workforceQueues,
      scheduleState: data.scheduleState,
      instructionDisclosure: "This report checks saved portal configuration and readiness evidence only. It does not claim Hermes SOUL.md contents were read or start a model run.",
    },
    leadHunter: data.leadHunter
      ? {
          displayName: data.leadHunter.display_name,
          role: data.leadHunter.role_key,
          status: data.leadHunter.status,
          enabled: data.leadHunter.enabled,
          dedicatedProfile: data.leadHunter.hermes_profile,
          configVersion: data.leadHunter.config_version,
          credentialPresent: data.leadHunter.credential_present,
          inventoryCount: data.leadHunter.inventory_count,
          inventoryDigest: data.leadHunter.inventory_digest,
          inventoryTools,
          inventoryMatchesReviewedSet,
          missingRequiredTools,
          unexpectedTools,
          hasWebSearch: inventoryTools.some((tool) => tool.name === "web_search"),
          hasWebExtract: inventoryTools.some((tool) => tool.name === "web_extract"),
          profileSharedWithZeng: Boolean(data.leadHunter.hermes_profile && data.leadHunter.hermes_profile === data.zeng?.hermes_profile),
          credentialSharedWithZeng: Boolean(data.leadHunter.credential_id && data.leadHunter.credential_id === data.zeng?.credential_id),
        }
      : null,
    localTargetVersions: TARGETS.map((target) => target.version),
    appLedgerCount: data.appLedger.length,
    lastAppliedVersion: data.appLedger.at(-1)?.version ?? null,
    appliedThrough0071: applied.has("0071_automation_studio_plan_lookup"),
    cliLedgerPresent: data.cliLedger.length > 0,
    cliLedgerCount: data.cliLedger.length,
    operatorSwitches: {
      schedules: process.env.WORKFORCE_SCHEDULES_ENABLED === "true",
      triggers: process.env.WORKFORCE_TRIGGERS_ENABLED === "true",
      briefings: process.env.WORKFORCE_BRIEFINGS_ENABLED === "true",
      worker: process.env.WORKFORCE_WORKER_ENABLED === "true",
      source: "process environment used by this preflight",
    },
    note: "A pending target is not applied. No write was performed by this preflight.",
  }, null, 2));
  await closeDb();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
