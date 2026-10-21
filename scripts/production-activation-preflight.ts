/**
 * Read-only production activation preflight for migrations 0072–0075.
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
import { closeDb, readSystem } from "../src/server/db";
import { auditRoleConfiguration, recommendedSettings } from "../src/lib/role-playbooks";
import { OPTIONAL_INVENTORY_TOOLS, REQUIRED_INVENTORY_TOOLS } from "../src/server/integrations/hermes/inventory";

if (!process.argv.includes("--live")) {
  console.error("This reads the hosted database. Re-run with --live when that read is intended.");
  process.exit(2);
}

const TARGETS = [
  {
    version: "0072_ai_work_jobs",
    tables: ["ai_work_jobs", "ai_work_events"],
    columns: [
      "lead_research_requests.work_job_id",
      "chat_messages.work_job_id",
      "leads.duplicate_matches",
      "leads.public_contact",
    ],
  },
  {
    version: "0073_ai_work_schedules",
    tables: ["ai_work_schedules"],
    columns: [],
  },
  {
    version: "0074_ai_work_triggers",
    tables: ["ai_work_triggers"],
    columns: [],
  },
  {
    version: "0075_proactive_ai_employees",
    tables: ["ai_work_reports", "ai_work_report_deliveries"],
    columns: [
      "ai_work_schedules.business_hours",
      "ai_work_schedules.last_skipped_reason",
      "ai_work_schedules.last_skipped_at",
      "ai_work_schedules.payload",
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
      leadHunter: hunters.rows[0] ?? null,
      zeng: zeng.rows[0] ?? null,
      appLedger: appLedger.rows.map((row) => ({ version: row.version, appliedAt: row.applied_at.toISOString() })),
      cliLedger: cliLedger.rows.map((row) => row.version),
      tables: new Set(tableRows.rows.map((row) => row.name)),
      columns: new Set(columnRows.rows.map((row) => `${row.table_name}.${row.column_name}`)),
      functions: new Set(functionRows.rows.map((row) => row.name)),
      agentKey: agentKey.rows.map((row) => row.def),
    };
  });

  const applied = new Set(data.appLedger.map((row) => row.version));
  const migrations = TARGETS.map((target) => {
    const missingTables = target.tables.filter((table) => !data.tables.has(table));
    const missingColumns = target.columns.filter((column) => !data.columns.has(column));
    return {
      version: target.version,
      applied: applied.has(target.version),
      sha256: hashes[target.version],
      expectedTables: target.tables,
      missingTables,
      missingColumns,
      objectsPresent: missingTables.length === 0 && missingColumns.length === 0,
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
  };
  const configPreview = auditRoleConfiguration("lead_hunter", recommendedSettings("lead_hunter"), companyFacts);

  const prefixCollisions = TARGETS.flatMap((target) => {
    const prefix = target.version.slice(0, 4);
    return data.appLedger
      .filter((row) => row.version.startsWith(prefix) && row.version !== target.version)
      .map((row) => ({ local: target.version, applied: row.version }));
  });
  const appliedTargets = migrations.filter((migration) => migration.applied).map((migration) => migration.version);
  const pendingOther = localVersions.filter((version) => !applied.has(version) && !targetVersions.has(version));

  console.log(JSON.stringify({
    ok: true,
    readOnly: true,
    target: "0072–0075",
    appliedTargets,
    pendingTargets,
    pendingOtherLocalMigrations: pendingOther,
    prefixCollisions,
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
