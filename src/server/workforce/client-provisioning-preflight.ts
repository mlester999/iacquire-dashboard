import "server-only";
import { AGENCY_HERMES_PROFILE_IDS, AGENT_ROLE_KEYS, isAgentRoleKey } from "@/lib/agents";
import { RUNTIME_ONLINE_STATUSES } from "@/lib/employee-runtime";
import { MIGRATION_PREREQUISITES, type Queryable } from "@/server/db";
import { inReadOnlyTransaction } from "@/server/workforce/hermes-a4a-evidence";
import { PROVISIONING_PAYMENT_CLEARED_SQL } from "@/server/workforce/provisioning";
import { suggestedProfileName } from "@/server/workforce/service";

/**
 * The read-only preflight for client provisioning: what the database says before the restricted provisioner is enabled (and again while it runs), written independently of the
 * code that provisions. It answers "is the schema, the profile table, the job queue and the gateway in a state where turning provisioning on is safe", and it says plainly what it
 * cannot see (the environment of the hosted app, the host's resources, the backup).
 *
 * Two parts, so every rule is tested without a database. `readProvisioningFacts` reads counts, ids, role keys and booleans inside a transaction the database itself holds READ ONLY
 * (the same wrapper the A4a evidence tool uses). `evaluateProvisioningPreflight` is pure: facts in, checks out.
 *
 * Privacy: the facts and the checks hold counts, ids (workspace, employee, job, gateway), role keys, version and object names and booleans, never a profile name, a slug, a company
 * name, a credential or its fingerprint, a URL or the detail text of a row. A client employee's profile name is derived from the workspace slug, so it identifies the client: the one
 * place the code looks at it (does the profile equal the identity the provisioner derives) answers with an id and nothing else. Running it against production is a separate approval.
 * Operator procedure: docs/client-pilot-package-2026-11-01.md.
 */

export type PreflightMode = "dormant" | "enabled";
export type PreflightStatus = "pass" | "fail" | "warn" | "unknown" | "manual";
export type PreflightArea = "ledger" | "schema" | "rls" | "jobs" | "profiles" | "gateway" | "env" | "capacity" | "manual";

export interface PreflightCheck {
  id: string;
  area: PreflightArea;
  status: PreflightStatus;
  /** One sentence in plain words. Counts and object names only. */
  detail: string;
  count?: number;
  /** Workspace, employee, job or gateway ids behind a count (the first few). */
  ids?: string[];
  /** Small name-to-value tables (job counts, environment names and their classes). Values are numbers, words and booleans, never a configured value. */
  values?: Record<string, string | number>;
}

export interface PreflightResult {
  /** No check failed. A warning, an unknown or a manual item is never a pass and never turns one into a failure either: they are listed separately. */
  ok: boolean;
  /** Nothing is unknown: every machine check could be decided from what was read. False when no environment file was given. */
  complete: boolean;
  expect: PreflightMode;
  checks: PreflightCheck[];
  summary: Record<PreflightStatus, number>;
}

/** What a query found: how many rows, and the first few ids. */
export interface Finding {
  count: number;
  ids: string[];
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// What the preflight expects to find. Each list is tested against the repository (tests/client-provisioning-preflight.test.ts), so a typo cannot make a check pass by matching nothing.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Migrations the provisioning path stands on: the workforce tables, tenant keys, gateways, inventory, jobs, the payment gate, the native CRM and calendar the launch panel reads. */
export const PROVISIONING_REQUIRED_VERSIONS: readonly string[] = [
  "0002_workforce", "0005_tenant_integrity", "0027_native_crm", "0029_crm_calendars", "0030_crm_scheduling", "0034_hermes_gateways", "0054_crm_blueprints", "0056_crm_setup_native",
  "0059_hermes_tool_inventory", "0060_rls_initplan", "0077_ai_work_jobs", "0081_ai_work_job_rls_hardening", "0082_client_employee_provisioning", "0084_restricted_hermes_provisioner",
  "0099_payment_controls", "0102_onboarding_snapshot", "0109_employee_health_probe",
];

export const PROVISIONING_SCHEMA_TABLES: readonly string[] = [
  "agent_instances", "agent_config_versions", "agent_provisioning_jobs", "hermes_gateways", "integration_credentials", "credential_references", "agent_health_probes", "ai_work_jobs",
  "ai_work_events", "billing_accounts", "onboarding_responses", "crm_calendars", "crm_availability_rules", "crm_calendar_members", "crm_appointment_types", "crm_host_settings",
];

export const PROVISIONING_SCHEMA_COLUMNS: readonly string[] = [
  "hermes_gateways.provisioner_isolation_verified_at", "agent_instances.hermes_profile_config_version_id", "agent_instances.hermes_gateway_id",
  "agent_provisioning_jobs.config_version_id", "agent_provisioning_jobs.source_job_id", "agent_provisioning_jobs.manifest_soul_sha256",
  "agent_provisioning_jobs.manifest_policy_config_sha256", "agent_provisioning_jobs.manifest_challenge_sha256",
  "agent_provisioning_jobs.attempt_count", "agent_provisioning_jobs.next_retry_at", "agent_provisioning_jobs.lease_token", "agent_provisioning_jobs.lease_expires_at",
  "agent_provisioning_jobs.result_reference",
  "agent_instances.tool_inventory_contract", "agent_instances.tool_inventory_digest", "agent_instances.tool_inventory_verified_at", "agent_instances.tool_inventory_expires_at",
  "agent_instances.tool_inventory_tool_count", "agent_instances.tool_inventory_snapshot",
  "agent_instances.health_consecutive_failures", "agent_instances.last_healthy_at", "agent_instances.last_health_failure_at", "agent_instances.last_probe_at",
  "agent_instances.last_probe_source", "agent_instances.health_alerted_at", "onboarding_responses.submitted_snapshot",
];

/** An index that must exist, whether it must be unique, and the words its definition must contain (the predicate of a partial index is what makes it the rule it is). */
export interface RequiredIndex {
  name: string;
  unique: boolean;
  contains: readonly string[];
}

export const PROVISIONING_SCHEMA_INDEXES: readonly RequiredIndex[] = [
  { name: "agent_provisioning_one_open_per_employee", unique: true, contains: ["agent_instance_id", "requested", "in_progress", "awaiting_health_check"] },
  { name: "agent_provisioning_retry_queue", unique: false, contains: ["next_retry_at", "requested", "failed"] },
  { name: "agent_instances_profile_unique", unique: true, contains: ["hermes_base_url", "hermes_profile"] },
  { name: "agent_instances_gateway_profile_unique", unique: true, contains: ["hermes_gateway_id", "hermes_profile"] },
  { name: "organizations_single_agency", unique: true, contains: ["agency"] },
  { name: "ai_work_jobs_idempotency_key_key", unique: true, contains: ["idempotency_key"] },
];

export const PROVISIONING_SCHEMA_TRIGGERS: readonly string[] = [
  "agent_instances_guard", "agent_hermes_gateway_guard", "hermes_gateway_credential_guard", "hermes_gateway_type_guard", "billing_accounts_guard",
];

// The payment function is named from the one definition the claim uses (the setup payment question is asked in a short list of places: tests/payment-gate.test.ts).
const PAYMENT_FUNCTION = PROVISIONING_PAYMENT_CLEARED_SQL.slice(0, PROVISIONING_PAYMENT_CLEARED_SQL.indexOf("("));
export const PROVISIONING_SCHEMA_FUNCTIONS: readonly string[] = ["app.guard_agent_profile", PAYMENT_FUNCTION, "app.permitted_orgs", "app.accessible_orgs"];

/** Tables the signed-in application role may only read: it holds no insert, update or delete on any of them. */
export const READ_ONLY_FOR_APP_ROLE: readonly string[] = ["agent_instances", "agent_config_versions", "agent_provisioning_jobs", "hermes_gateways", "integration_credentials"];

/** A job whose lease ran out this long ago, with attempts left, is reported (it is normally taken over by the next claim within minutes). */
const STUCK_RETRYABLE_MINUTES = 30;
/** A job waiting for the portal's own health check this long is reported. */
const STALE_HEALTH_STAGE_MINUTES = 60;
/** A pinned gateway whose own health check is older than this is reported as stale (a warning: the employees' probes are the real signal). */
const STALE_GATEWAY_HOURS = 24;
const HEADROOM_WARN_RATIO = 0.8;
const FINDING_IDS = 20;

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Environment, by NAME only
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** What is known about one environment name: whether it is set, and a class of its value, never the value. */
export interface EnvEntry {
  set: boolean;
  /** A true/false switch: on or off. */
  on?: boolean;
  /** A secret: it meets the minimum length the application enforces. */
  lengthOk?: boolean;
  /** An id: it has the shape of a UUID. */
  uuid?: boolean;
  /** A plain number (a ceiling), the one value kept because it is not a secret and the capacity check needs it. */
  number?: number;
  /** A list: how many names it holds. */
  names?: number;
  /** A word from a fixed vocabulary (the tool-enforcement mode). */
  word?: string;
}

export interface EnvNames {
  /** Where the names came from, said in every output: a file somebody pulled from the hosting provider, or this machine's own environment. */
  source: "env_file" | "process";
  entries: Record<string, EnvEntry>;
  /** The pinned gateway id when it is a UUID. An id, not a secret; used only to find the gateway row and never printed. */
  pinnedGatewayId: string | null;
}

const SWITCHES = [
  "HERMES_PROVISIONER_ENABLED", "HERMES_BUSINESS_MCP_ENABLED", "HERMES_BUSINESS_MCP_WRITES_ENABLED", "HERMES_CLIENT_BUSINESS_MCP_ENABLED",
  "HERMES_CLIENT_BUSINESS_MCP_PROPOSALS_ENABLED", "SCHEDULER_ENABLED",
] as const;
const SECRET_MINIMUMS: Record<string, number> = { HERMES_PROVISIONER_TOKEN: 32, HERMES_BUSINESS_MCP_SECRET: 32, CRON_SECRET: 24 };
const SET_ONLY = ["APP_ENCRYPTION_KEY", "DATABASE_URL", "PAYMONGO_WEBHOOK_SECRET", "PAYPAL_WEBHOOK_ID"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every name the preflight looks at. */
export const PREFLIGHT_ENV_NAMES: readonly string[] = [
  ...SWITCHES, ...Object.keys(SECRET_MINIMUMS), ...SET_ONLY, "HERMES_PROVISIONER_GATEWAY_ID", "HERMES_PROVISIONER_MAX_PROFILES", "SCHEDULER_JOBS_ONLY", "WORKFORCE_ROLE_TOOL_ENFORCEMENT",
];

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) return value.slice(1, -1);
  return value;
}

/**
 * Reads an environment file's text in memory and keeps only the class of each value the preflight needs (set or not, on or off, long enough, UUID-shaped, a ceiling's number).
 * Nothing is printed or stored, and every other name in the file is ignored.
 */
export function summarizeEnvText(text: string, source: EnvNames["source"] = "env_file"): EnvNames {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (match && PREFLIGHT_ENV_NAMES.includes(match[1])) values.set(match[1], unquote(match[2]));
  }
  return summarizeEnvValues(Object.fromEntries(values), source);
}

/** The same summary from a name-to-value map (this machine's environment). Values are classified here and dropped. */
export function summarizeEnvValues(vars: Record<string, string | undefined>, source: EnvNames["source"] = "env_file"): EnvNames {
  const entries: Record<string, EnvEntry> = {};
  const present = (name: string) => {
    const value = vars[name];
    return value !== undefined && value.trim() !== "" ? value.trim() : null;
  };
  for (const name of SWITCHES) {
    const value = present(name);
    entries[name] = { set: value !== null, on: value === "true" || value === "1" };
  }
  for (const [name, minimum] of Object.entries(SECRET_MINIMUMS)) {
    const value = present(name);
    entries[name] = { set: value !== null, lengthOk: value !== null && value.length >= minimum };
  }
  for (const name of SET_ONLY) entries[name] = { set: present(name) !== null };
  const gateway = present("HERMES_PROVISIONER_GATEWAY_ID");
  entries.HERMES_PROVISIONER_GATEWAY_ID = { set: gateway !== null, uuid: gateway !== null && UUID.test(gateway) };
  const cap = present("HERMES_PROVISIONER_MAX_PROFILES");
  const capNumber = cap !== null && /^\d{1,6}$/.test(cap) ? Number(cap) : undefined;
  entries.HERMES_PROVISIONER_MAX_PROFILES = { set: cap !== null, ...(capNumber !== undefined && capNumber >= 1 ? { number: capNumber } : {}) };
  const only = present("SCHEDULER_JOBS_ONLY");
  entries.SCHEDULER_JOBS_ONLY = { set: only !== null, names: only === null ? 0 : only.split(",").map((part) => part.trim()).filter(Boolean).length };
  const enforcement = present("WORKFORCE_ROLE_TOOL_ENFORCEMENT");
  // The application reads exactly "report" as report mode and everything else as enforce (src/lib/employee-tool-policy.ts).
  entries.WORKFORCE_ROLE_TOOL_ENFORCEMENT = { set: enforcement !== null, word: enforcement === "report" ? "report" : "enforce" };
  return { source, entries, pinnedGatewayId: gateway !== null && UUID.test(gateway) ? gateway.toLowerCase() : null };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface LedgerFacts {
  appTable: boolean;
  cliTable: boolean;
  /** Version names in the application's own ledger. */
  app: string[];
  /** Rows of the Supabase CLI ledger: the four-digit prefix and the migration's name when the ledger records one. */
  cli: Array<{ version: string; name: string | null }>;
}

export interface SchemaFacts {
  tables: string[];
  columns: string[];
  indexes: Array<{ name: string; definition: string }>;
  triggers: Array<{ name: string; enabled: string }>;
  functions: string[];
  serverVersionNum: number | null;
}

export interface RlsTableFact {
  table: string;
  rowSecurity: boolean;
  hasOrgId: boolean;
  appSelect: boolean;
  appWrite: { insert: boolean; update: boolean; delete: boolean };
  /** anon, authenticated or PUBLIC holds a privilege on the table. */
  publicPrivilege: boolean;
  /** A policy applies to the application role (or to everyone) for reading. */
  selectPolicy: boolean;
  /** A policy applies to anon, authenticated or PUBLIC. */
  openPolicy: boolean;
}

export interface RlsFacts {
  roles: { app: boolean; anon: boolean; authenticated: boolean };
  tables: RlsTableFact[];
  /** Whether the application role can read the lease token column of the job table (null when it could not be asked). */
  leaseTokenSelectable: boolean | null;
}

export interface JobFacts {
  byKindStatus: Array<{ kind: string; status: string; count: number }> | null;
  duplicateOpen: Finding | null;
  stuckExhausted: Finding | null;
  stuckRetryable: Finding | null;
  exhaustedFailed: Finding | null;
  staleAwaitingHealth: Finding | null;
  /** Jobs that could be claimed (or retried) that belong to a workspace the claim would refuse. */
  ineligibleDue: Finding | null;
  /** Jobs already running or waiting for the health check for such a workspace. */
  ineligibleOpen: Finding | null;
  withoutRequester: Finding | null;
}

export interface ProfileFacts {
  clientWorkspaces: number | null;
  notSixPerClient: Finding | null;
  reservedOnClients: Finding | null;
  notClientNamed: Finding | null;
  gatewayPairing: Finding | null;
  duplicateProfiles: Finding | null;
  identityMismatch: Finding | null;
  credentialForeign: Finding | null;
  credentialRevoked: Finding | null;
  credentialShared: Finding | null;
  credentialFingerprintShared: Finding | null;
  onlineWithoutProfile: Finding | null;
  activeVersionForeign: Finding | null;
  profileVersionForeign: Finding | null;
  jobVersionForeign: Finding | null;
  jobSourceForeign: Finding | null;
  agencyWorkspaces: number | null;
  agencyOnAttestedGateway: Finding | null;
  clientOnAgencyGateway: Finding | null;
  enabledWithoutAppliedConfig: Finding | null;
}

export interface GatewayFact {
  id: string;
  status: string;
  gatewayType: string;
  profileCreationStatus: string;
  attested: boolean;
  attestedAgeHours: number | null;
  healthAgeMinutes: number | null;
  agencyEmployees: number;
  clientProfiles: number;
}

export interface ProvisioningFacts {
  readAt: string;
  ledger: LedgerFacts | null;
  schema: SchemaFacts | null;
  rls: RlsFacts | null;
  jobs: JobFacts;
  profiles: ProfileFacts;
  gateways: GatewayFact[] | null;
  /** Enabled client employees without a profile that already have a provision request: the profiles the clients that began are still owed. */
  owedProfiles: number | null;
}

const num = (value: unknown) => Number(value ?? 0);
const OPEN_STATUSES = "'requested','in_progress','awaiting_health_check'";

/**
 * Runs one read under a savepoint. A statement that fails (a table a missing migration never made) aborts the transaction until it is rolled back, and one unreadable section must
 * not turn every later section into "could not be read". A section that failed is null, and its checks answer `unknown`, never a pass.
 */
export async function guarded<T>(db: Queryable, read: () => Promise<T>): Promise<T | null> {
  await db.query("savepoint preflight_read");
  try {
    const result = await read();
    await db.query("release savepoint preflight_read");
    return result;
  } catch {
    await db.query("rollback to savepoint preflight_read");
    return null;
  }
}

/** The number of rows a query selects (as `id`) and the first few ids. The inner query names one text column, `id`. */
async function finding(db: Queryable, inner: string, params: unknown[] = []): Promise<Finding | null> {
  return guarded(db, async () => {
    const { rows } = await db.query<{ n: number; id: string }>(`select (count(*) over ())::int as n, q.id from (${inner}) q order by q.id limit ${FINDING_IDS}`, params);
    return { count: rows[0] ? num(rows[0].n) : 0, ids: rows.map((row) => row.id) };
  });
}

const clientEmployees = "from agent_instances a join organizations o on o.id = a.org_id where o.kind = 'client'";
const owner = "exists (select 1 from organization_memberships m join users u on u.id = m.user_id where m.org_id = o.id and m.role = 'owner' and m.status = 'active' and u.email_verified_at is not null)";
// The same rule the claim uses (PROVISIONING_PAYMENT_CLEARED_SQL), for the jobs that wait on a workspace the claim would refuse.
const refusedWorkspace =
  `(o.is_demo or o.kind <> 'client' or o.status <> 'active' or o.onboarding_completed_at is null or not a.enabled or not ${owner} or (j.kind = 'provision' and not coalesce(${PROVISIONING_PAYMENT_CLEARED_SQL}, false)))`;
const jobsOfRefusedWorkspaces = `from agent_provisioning_jobs j join agent_instances a on a.id = j.agent_instance_id and a.org_id = j.org_id join organizations o on o.id = j.org_id where j.kind in ('provision', 'sync') and ${refusedWorkspace}`;

export async function readLedgerFacts(db: Queryable): Promise<LedgerFacts | null> {
  return guarded(db, async () => {
    const appTable = Boolean((await db.query<{ t: string | null }>("select to_regclass('public.schema_migrations')::text as t")).rows[0]?.t);
    const cliTable = Boolean((await db.query<{ t: string | null }>("select to_regclass('supabase_migrations.schema_migrations')::text as t")).rows[0]?.t);
    const app = appTable ? (await db.query<{ version: string }>("select version from schema_migrations order by version")).rows.map((row) => row.version) : [];
    let cli: LedgerFacts["cli"] = [];
    if (cliTable) {
      // The CLI ledger records a name next to the prefix; an older ledger may not, and then only the prefix is known.
      const named = await guarded(db, async () => (await db.query<{ version: string; name: string | null }>("select version, name from supabase_migrations.schema_migrations order by version")).rows);
      cli = named ?? (await db.query<{ version: string }>("select version from supabase_migrations.schema_migrations order by version")).rows.map((row) => ({ version: row.version, name: null }));
    }
    return { appTable, cliTable, app, cli };
  });
}

async function readSchema(db: Queryable): Promise<SchemaFacts | null> {
  return guarded(db, async () => {
    const tables = await db.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' and table_name = any($1::text[])", [PROVISIONING_SCHEMA_TABLES]);
    const columns = await db.query<{ c: string }>("select table_name || '.' || column_name as c from information_schema.columns where table_schema = 'public' and (table_name || '.' || column_name) = any($1::text[])", [PROVISIONING_SCHEMA_COLUMNS]);
    const indexes = await db.query<{ indexname: string; indexdef: string }>("select indexname, indexdef from pg_indexes where schemaname = 'public' and indexname = any($1::text[])", [PROVISIONING_SCHEMA_INDEXES.map((index) => index.name)]);
    const triggers = await db.query<{ name: string; enabled: string }>(
      `select t.tgname::text as name, t.tgenabled::text as enabled from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
        where not t.tgisinternal and n.nspname = 'public' and t.tgname = any($1::text[])`,
      [PROVISIONING_SCHEMA_TRIGGERS],
    );
    const functions = await db.query<{ name: string }>("select (n.nspname || '.' || p.proname) as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace where (n.nspname || '.' || p.proname) = any($1::text[])", [PROVISIONING_SCHEMA_FUNCTIONS]);
    const version = await guarded(db, async () => num((await db.query<{ v: number }>("select current_setting('server_version_num')::int as v")).rows[0]?.v));
    return {
      tables: tables.rows.map((row) => row.table_name), columns: columns.rows.map((row) => row.c), indexes: indexes.rows.map((row) => ({ name: row.indexname, definition: row.indexdef })),
      triggers: triggers.rows.map((row) => ({ name: row.name, enabled: row.enabled })), functions: functions.rows.map((row) => row.name), serverVersionNum: version,
    };
  });
}

async function readRls(db: Queryable): Promise<RlsFacts | null> {
  return guarded(db, async () => {
    const { rows: roleRows } = await db.query<{ rolname: string }>("select rolname::text as rolname from pg_roles where rolname in ('iaq_app_user', 'anon', 'authenticated')");
    const has = (name: string) => roleRows.some((row) => row.rolname === name);
    const roles = { app: has("iaq_app_user"), anon: has("anon"), authenticated: has("authenticated") };
    // The privilege functions raise on a role that does not exist, so only the roles that exist are asked about (the role names are constants, never input).
    const app = (privilege: string) => (roles.app ? `has_table_privilege('iaq_app_user', c.oid, '${privilege}')` : "false");
    const named = [roles.anon ? "has_table_privilege('anon', c.oid, 'select,insert,update,delete')" : "false", roles.authenticated ? "has_table_privilege('authenticated', c.oid, 'select,insert,update,delete')" : "false"].join(" or ");
    const { rows } = await db.query<{ tbl: string; rls: boolean; has_org: boolean; app_select: boolean; app_insert: boolean; app_update: boolean; app_delete: boolean; public_priv: boolean; select_policy: boolean; open_policy: boolean }>(
      `select c.relname::text as tbl, c.relrowsecurity as rls,
              exists (select 1 from information_schema.columns k where k.table_schema = 'public' and k.table_name = c.relname and k.column_name = 'org_id') as has_org,
              ${app("select")} as app_select, ${app("insert")} as app_insert, ${app("update")} as app_update, ${app("delete")} as app_delete,
              (${named} or exists (select 1 from aclexplode(c.relacl) x where x.grantee = 0)) as public_priv,
              exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname and p.cmd in ('SELECT', 'ALL') and (p.roles::text[] && array['iaq_app_user', 'public'])) as select_policy,
              exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname and (p.roles::text[] && array['anon', 'authenticated', 'public'])) as open_policy
         from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname = any($1::text[]) order by c.relname`,
      [PROVISIONING_SCHEMA_TABLES],
    );
    const leaseTokenSelectable = roles.app
      ? await guarded(db, async () => Boolean((await db.query<{ ok: boolean }>("select has_column_privilege('iaq_app_user', 'public.agent_provisioning_jobs', 'lease_token', 'select') as ok")).rows[0]?.ok))
      : null;
    return {
      roles, leaseTokenSelectable,
      tables: rows.map((row) => ({
        table: row.tbl, rowSecurity: Boolean(row.rls), hasOrgId: Boolean(row.has_org), appSelect: Boolean(row.app_select),
        appWrite: { insert: Boolean(row.app_insert), update: Boolean(row.app_update), delete: Boolean(row.app_delete) },
        publicPrivilege: Boolean(row.public_priv), selectPolicy: Boolean(row.select_policy), openPolicy: Boolean(row.open_policy),
      })),
    };
  });
}

async function readJobs(db: Queryable): Promise<JobFacts> {
  const byKindStatus = await guarded(db, async () => (await db.query<{ kind: string; status: string; n: number }>("select kind, status, count(*)::int as n from agent_provisioning_jobs group by kind, status order by kind, status")).rows.map((row) => ({ kind: row.kind, status: row.status, count: num(row.n) })));
  return {
    byKindStatus,
    duplicateOpen: await finding(db, `select agent_instance_id::text as id from agent_provisioning_jobs where status in (${OPEN_STATUSES}) group by agent_instance_id having count(*) > 1`),
    stuckExhausted: await finding(db, "select j.id::text as id from agent_provisioning_jobs j where j.status = 'in_progress' and j.lease_expires_at < now() and j.attempt_count >= 3"),
    stuckRetryable: await finding(db, `select j.id::text as id from agent_provisioning_jobs j where j.status = 'in_progress' and j.attempt_count < 3 and j.lease_expires_at < now() - interval '${STUCK_RETRYABLE_MINUTES} minutes'`),
    exhaustedFailed: await finding(db, "select j.id::text as id from agent_provisioning_jobs j where j.status = 'failed' and j.attempt_count >= 3"),
    staleAwaitingHealth: await finding(db, `select j.id::text as id from agent_provisioning_jobs j where j.status = 'awaiting_health_check' and j.updated_at < now() - interval '${STALE_HEALTH_STAGE_MINUTES} minutes'`),
    ineligibleDue: await finding(db, `select j.id::text as id ${jobsOfRefusedWorkspaces} and (j.status = 'requested' or (j.status = 'failed' and j.attempt_count < 3 and (j.next_retry_at is null or j.next_retry_at <= now())))`),
    ineligibleOpen: await finding(db, `select j.id::text as id ${jobsOfRefusedWorkspaces} and j.status in ('in_progress', 'awaiting_health_check')`),
    withoutRequester: await finding(db, `select j.id::text as id from agent_provisioning_jobs j where j.kind = 'provision' and j.requested_by is null and j.status in ('requested', 'failed', 'in_progress') and not exists (select 1 from organization_memberships m where m.org_id = j.org_id and m.role = 'owner' and m.status = 'active')`),
  };
}

async function readProfiles(db: Queryable): Promise<ProfileFacts> {
  const reserved = Object.values(AGENCY_HERMES_PROFILE_IDS);
  const count = async (sql: string, params: unknown[] = []) => guarded(db, async () => num((await db.query<{ n: number }>(sql, params)).rows[0]?.n));
  // The one place a profile name is looked at: it must equal the identity the provisioner derives for that workspace and role. Only ids leave this function.
  const identityMismatch = await guarded(db, async (): Promise<Finding> => {
    const { rows } = await db.query<{ id: string; role_key: string; hermes_profile: string; slug: string }>(`select a.id::text as id, a.role_key, a.hermes_profile, o.slug ${clientEmployees} and a.hermes_profile like 'c-%'`);
    const wrong = rows.filter((row) => !isAgentRoleKey(row.role_key) || row.hermes_profile !== suggestedProfileName(row.slug, row.role_key)).map((row) => row.id).sort();
    return { count: wrong.length, ids: wrong.slice(0, FINDING_IDS) };
  });
  const versionForeign = (column: string) =>
    `select a.id::text as id from agent_instances a where a.${column} is not null and not exists (select 1 from agent_config_versions v where v.id = a.${column} and v.org_id = a.org_id and v.agent_instance_id = a.id)`;
  return {
    clientWorkspaces: await count("select count(*)::int as n from organizations where kind = 'client' and not is_demo"),
    notSixPerClient: await finding(db, `select o.id::text as id from organizations o where o.kind = 'client' and not o.is_demo and ((select count(*) from agent_instances a where a.org_id = o.id) <> $1::int or (select count(distinct a.role_key) from agent_instances a where a.org_id = o.id and a.role_key = any($2::text[])) <> $1::int)`, [AGENT_ROLE_KEYS.length, [...AGENT_ROLE_KEYS]]),
    reservedOnClients: await finding(db, `select a.id::text as id ${clientEmployees} and a.hermes_profile is not null and (a.hermes_profile = 'default' or a.hermes_profile like 'iacquire-%' or a.hermes_profile = any($1::text[]))`, [reserved]),
    notClientNamed: await finding(db, `select a.id::text as id ${clientEmployees} and a.hermes_profile is not null and a.hermes_profile not like 'c-%'`),
    gatewayPairing: await finding(db, `select a.id::text as id ${clientEmployees} and ((a.hermes_profile is not null and a.hermes_gateway_id is null) or (a.hermes_gateway_id is not null and (a.hermes_profile is null or not exists (select 1 from hermes_gateways g where g.id = a.hermes_gateway_id and rtrim(g.base_url, '/') = rtrim(coalesce(a.hermes_base_url, ''), '/')))))`),
    duplicateProfiles: await finding(db, "select min(a.id::text) as id from agent_instances a where a.hermes_profile is not null group by rtrim(coalesce(a.hermes_base_url, ''), '/'), a.hermes_profile having count(*) > 1"),
    identityMismatch,
    credentialForeign: await finding(db, `select a.id::text as id ${clientEmployees} and a.credential_id is not null and exists (select 1 from integration_credentials c where c.id = a.credential_id and c.org_id is distinct from a.org_id)`),
    credentialRevoked: await finding(db, `select a.id::text as id ${clientEmployees} and a.credential_id is not null and exists (select 1 from integration_credentials c where c.id = a.credential_id and c.revoked_at is not null)`),
    credentialShared: await finding(db, "select min(a.id::text) as id from agent_instances a where a.credential_id is not null group by a.credential_id having count(*) > 1"),
    credentialFingerprintShared: await finding(db, "select min(c.id::text) as id from integration_credentials c where c.provider = 'hermes' and c.org_id is not null and c.revoked_at is null group by c.fingerprint having count(*) > 1"),
    onlineWithoutProfile: await finding(db, `select a.id::text as id ${clientEmployees} and a.status = any($1::text[]) and (a.hermes_profile is null or a.credential_id is null)`, [[...RUNTIME_ONLINE_STATUSES]]),
    activeVersionForeign: await finding(db, versionForeign("active_config_version_id")),
    profileVersionForeign: await finding(db, versionForeign("hermes_profile_config_version_id")),
    jobVersionForeign: await finding(db, "select j.id::text as id from agent_provisioning_jobs j where j.config_version_id is not null and not exists (select 1 from agent_config_versions v where v.id = j.config_version_id and v.org_id = j.org_id and v.agent_instance_id = j.agent_instance_id)"),
    jobSourceForeign: await finding(db, "select j.id::text as id from agent_provisioning_jobs j where j.source_job_id is not null and not exists (select 1 from agent_provisioning_jobs s where s.id = j.source_job_id and s.org_id = j.org_id and s.agent_instance_id = j.agent_instance_id)"),
    agencyWorkspaces: await count("select count(*)::int as n from organizations where kind = 'agency'"),
    agencyOnAttestedGateway: await finding(db, "select g.id::text as id from hermes_gateways g where (g.provisioner_isolation_verified_at is not null or g.profile_creation_status = 'restricted_service_verified') and exists (select 1 from agent_instances ai join organizations oi on oi.id = ai.org_id where ai.hermes_gateway_id = g.id and oi.kind = 'agency')"),
    clientOnAgencyGateway: await finding(db, `select a.id::text as id ${clientEmployees} and a.hermes_gateway_id is not null and exists (select 1 from agent_instances ai join organizations oi on oi.id = ai.org_id where ai.hermes_gateway_id = a.hermes_gateway_id and oi.kind = 'agency')`),
    enabledWithoutAppliedConfig: await finding(db, `select a.id::text as id ${clientEmployees} and not o.is_demo and o.onboarding_completed_at is not null and a.enabled and not exists (select 1 from agent_config_versions v where v.id = a.active_config_version_id and v.org_id = a.org_id and v.agent_instance_id = a.id and v.status = 'applied' and v.applied_at is not null)`),
  };
}

export async function readGatewayFacts(db: Queryable): Promise<GatewayFact[] | null> {
  return guarded(db, async () => {
    const { rows } = await db.query<{ id: string; status: string; gateway_type: string; profile_creation_status: string; attested: boolean; attested_age_hours: number | null; health_age_minutes: number | null; agency_employees: number; client_profiles: number }>(
      `select g.id::text as id, g.status, g.gateway_type, g.profile_creation_status, (g.provisioner_isolation_verified_at is not null) as attested,
              (extract(epoch from (now() - g.provisioner_isolation_verified_at)) / 3600)::float8 as attested_age_hours,
              (extract(epoch from (now() - g.last_health_check_at)) / 60)::float8 as health_age_minutes,
              (select count(*) from agent_instances ai join organizations oi on oi.id = ai.org_id where ai.hermes_gateway_id = g.id and oi.kind = 'agency')::int as agency_employees,
              (select count(*) from agent_instances ai join organizations oi on oi.id = ai.org_id where ai.hermes_gateway_id = g.id and oi.kind = 'client' and ai.hermes_profile is not null)::int as client_profiles
         from hermes_gateways g order by g.created_at, g.id`,
    );
    return rows.map((row) => ({
      id: row.id, status: row.status, gatewayType: row.gateway_type, profileCreationStatus: row.profile_creation_status, attested: Boolean(row.attested),
      attestedAgeHours: row.attested_age_hours === null ? null : Number(row.attested_age_hours), healthAgeMinutes: row.health_age_minutes === null ? null : Number(row.health_age_minutes),
      agencyEmployees: num(row.agency_employees), clientProfiles: num(row.client_profiles),
    }));
  });
}

/** Every read of the preflight on the transaction it is handed. Use `readProvisioningFacts` to read inside a transaction the database holds READ ONLY. */
export async function readProvisioningFactsIn(db: Queryable): Promise<ProvisioningFacts> {
  return {
    readAt: new Date().toISOString(),
    ledger: await readLedgerFacts(db),
    schema: await readSchema(db),
    rls: await readRls(db),
    jobs: await readJobs(db),
    profiles: await readProfiles(db),
    gateways: await readGatewayFacts(db),
    owedProfiles: await guarded(db, async () => num((await db.query<{ n: number }>(
      `select count(*)::int as n ${clientEmployees} and not o.is_demo and a.enabled and a.hermes_profile is null
          and exists (select 1 from agent_provisioning_jobs rj where rj.agent_instance_id = a.id and rj.org_id = a.org_id and rj.kind = 'provision' and rj.status in ('requested', 'in_progress', 'failed'))`,
    )).rows[0]?.n)),
  };
}

/**
 * Reads the facts inside one READ ONLY transaction: the database refuses an insert, update, delete, schema change or data-modifying `with` whatever a statement says. It runs as the
 * application's own role on purpose (see inReadOnlyTransaction): a restricted role would see every workspace table as empty and report a healthy database that is not.
 */
export async function readProvisioningFacts(): Promise<ProvisioningFacts> {
  return inReadOnlyTransaction(readProvisioningFactsIn);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Evaluation (pure)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface PreflightOptions {
  expect: PreflightMode;
  /** The environment summary of the hosted app, or null: with no file somebody pulled from the hosting provider, every environment check is `unknown`. */
  envNames: EnvNames | null;
  /** The repository's migration files (names with or without .sql). */
  localMigrations: readonly string[];
  /** Overrides the application's own prerequisite table (tests only). */
  prerequisites?: Record<string, readonly string[]>;
}

const strip = (version: string) => version.replace(/\.sql$/, "");
const prefixOf = (version: string) => (version.includes("_") ? version.slice(0, version.indexOf("_")) : version);
const nameOf = (version: string) => (version.includes("_") ? version.slice(version.indexOf("_") + 1) : version);
const list = (items: readonly string[], max = 12) => (items.length > max ? `${items.slice(0, max).join(", ")} and ${items.length - max} more` : items.join(", "));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The versions the runner counts as applied: the application's own ledger, plus every local file whose number the Supabase CLI ledger holds (the runner honours both, so a
 * database migrated with `supabase db push` is never migrated twice).
 */
export function appliedMigrationVersions(ledger: LedgerFacts, localMigrations: readonly string[]): Set<string> {
  const cliPrefixes = new Set(ledger.cli.map((row) => row.version));
  const applied = new Set(ledger.app);
  for (const version of localMigrations.map(strip)) if (cliPrefixes.has(prefixOf(version))) applied.add(version);
  return applied;
}

/** The migrations the provisioning path stands on that this database does not have. */
export function missingRequiredVersions(ledger: LedgerFacts, localMigrations: readonly string[]): string[] {
  const applied = appliedMigrationVersions(ledger, localMigrations);
  return PROVISIONING_REQUIRED_VERSIONS.filter((version) => !applied.has(version));
}

export function evaluateProvisioningPreflight(facts: ProvisioningFacts, options: PreflightOptions): PreflightResult {
  const { expect, envNames } = options;
  const dormant = expect === "dormant";
  const checks: PreflightCheck[] = [];
  const add = (check: PreflightCheck) => { checks.push(check); };
  const unreadable = (id: string, area: PreflightArea, what: string) => add({ id, area, status: "unknown", detail: `${what} could not be read, so this check is not decided (the schema checks say why).` });
  /** A check that fails when anything is found and passes when nothing is. A section that could not be read is unknown. */
  const finds = (id: string, area: PreflightArea, found: Finding | null, o: { fail?: PreflightStatus; none: string; some: (n: number) => string }) => {
    if (!found) return unreadable(id, area, "The rows");
    if (found.count === 0) return add({ id, area, status: "pass", detail: o.none, count: 0 });
    add({ id, area, status: o.fail ?? "fail", detail: o.some(found.count), count: found.count, ids: found.ids });
  };

  // ---- ledger
  const local = [...new Set(options.localMigrations.map(strip))].sort();
  const ledger = facts.ledger;
  if (!ledger) {
    for (const id of ["ledger_tables", "ledger_required_versions", "ledger_pending_local", "ledger_unknown_applied", "ledger_prefix_collisions", "ledger_prerequisites"]) unreadable(id, "ledger", "The migration ledger");
  } else {
    const cliPrefixes = new Set(ledger.cli.map((row) => row.version));
    const applied = appliedMigrationVersions(ledger, local);
    const cliOnly = local.filter((version) => !ledger.app.includes(version) && cliPrefixes.has(prefixOf(version)));
    add(ledger.appTable
      ? { id: "ledger_tables", area: "ledger", status: "pass", detail: `The application's ledger holds ${plural(ledger.app.length, "version")}; the Supabase CLI ledger is ${ledger.cliTable ? `present (${plural(ledger.cli.length, "row")}${cliOnly.length ? `, ${cliOnly.length} version${cliOnly.length === 1 ? "" : "s"} recorded only there` : ""})` : "absent"}.`, count: ledger.app.length }
      : { id: "ledger_tables", area: "ledger", status: "fail", detail: "The application's migration ledger (schema_migrations) does not exist: this database has not been migrated by this runner." });

    const missing = missingRequiredVersions(ledger, local);
    add(missing.length
      ? { id: "ledger_required_versions", area: "ledger", status: "fail", detail: `${plural(missing.length, "required migration")} not applied: ${list(missing)}.`, count: missing.length }
      : { id: "ledger_required_versions", area: "ledger", status: "pass", detail: `All ${PROVISIONING_REQUIRED_VERSIONS.length} migrations the provisioning path stands on are applied.`, count: 0 });

    const pending = local.filter((version) => !applied.has(version));
    add(pending.length
      ? { id: "ledger_pending_local", area: "ledger", status: "warn", detail: `${plural(pending.length, "local migration")} not applied: ${list(pending)}. Each is its own release step; apply none of them here.`, count: pending.length }
      : { id: "ledger_pending_local", area: "ledger", status: "pass", detail: "Every local migration is applied.", count: 0 });

    const localSet = new Set(local);
    const localPrefixes = new Set(local.map(prefixOf));
    const unknownApp = ledger.app.filter((version) => !localSet.has(version) && !version.startsWith("compat_"));
    const unknownCli = ledger.cli.filter((row) => !localPrefixes.has(row.version)).map((row) => row.version);
    add(unknownApp.length || unknownCli.length
      ? { id: "ledger_unknown_applied", area: "ledger", status: "warn", detail: `${unknownApp.length ? `Applied but not in this repository: ${list(unknownApp)}. ` : ""}${unknownCli.length ? `CLI ledger prefixes with no local file: ${list(unknownCli)}.` : ""}`.trim(), count: unknownApp.length + unknownCli.length }
      : { id: "ledger_unknown_applied", area: "ledger", status: "pass", detail: "Every applied version has a file in this repository.", count: 0 });

    // Two different files with one number: the CLI ledger keys on the number alone, so the second is silently skipped. Three shapes: two names under one number in the application's
    // ledger, an applied name whose number belongs to a different local file, and a CLI row whose recorded name is not the local file's name.
    const byPrefix = new Map<string, Set<string>>();
    for (const version of ledger.app.filter((v) => /^\d{4}_/.test(v))) byPrefix.set(prefixOf(version), new Set([...(byPrefix.get(prefixOf(version)) ?? []), version]));
    const collisions = new Set<string>();
    for (const [prefix, names] of byPrefix) if (names.size > 1) collisions.add(prefix);
    for (const version of local) for (const name of byPrefix.get(prefixOf(version)) ?? []) if (name !== version) collisions.add(prefixOf(version));
    for (const row of ledger.cli) {
      const file = local.find((version) => prefixOf(version) === row.version);
      if (file && row.name !== null && row.name !== nameOf(file)) collisions.add(row.version);
    }
    add(collisions.size
      ? { id: "ledger_prefix_collisions", area: "ledger", status: "fail", detail: `${plural(collisions.size, "migration number")} used by two different files: ${list([...collisions].sort())}. The runner would treat the second as applied.`, count: collisions.size }
      : { id: "ledger_prefix_collisions", area: "ledger", status: "pass", detail: "No migration number is used by two different files.", count: 0 });

    const prerequisites = options.prerequisites ?? MIGRATION_PREREQUISITES;
    const unmet = [...applied].filter((version) => (prerequisites[version] ?? []).some((required) => !applied.has(required))).sort();
    add(unmet.length
      ? { id: "ledger_prerequisites", area: "ledger", status: "fail", detail: `${plural(unmet.length, "applied migration")} without its prerequisites: ${list(unmet)}.`, count: unmet.length }
      : { id: "ledger_prerequisites", area: "ledger", status: "pass", detail: "Every applied migration has the migrations it depends on.", count: 0 });
  }

  // ---- schema objects, by name
  const schema = facts.schema;
  if (!schema) {
    for (const id of ["schema_tables", "schema_columns", "schema_indexes", "schema_triggers", "schema_functions", "schema_server_version"]) unreadable(id, "schema", "The schema");
  } else {
    const missingTables = PROVISIONING_SCHEMA_TABLES.filter((name) => !schema.tables.includes(name));
    add(missingTables.length ? { id: "schema_tables", area: "schema", status: "fail", detail: `Missing tables: ${list(missingTables)}.`, count: missingTables.length } : { id: "schema_tables", area: "schema", status: "pass", detail: `All ${PROVISIONING_SCHEMA_TABLES.length} tables exist.`, count: 0 });
    const missingColumns = PROVISIONING_SCHEMA_COLUMNS.filter((name) => !schema.columns.includes(name));
    add(missingColumns.length ? { id: "schema_columns", area: "schema", status: "fail", detail: `Missing columns: ${list(missingColumns)}.`, count: missingColumns.length } : { id: "schema_columns", area: "schema", status: "pass", detail: `All ${PROVISIONING_SCHEMA_COLUMNS.length} columns exist.`, count: 0 });
    const badIndexes = PROVISIONING_SCHEMA_INDEXES.flatMap((required) => {
      const found = schema.indexes.find((index) => index.name === required.name);
      if (!found) return [`${required.name} (missing)`];
      const definition = found.definition.toLowerCase();
      if ((required.unique && !definition.includes("unique")) || required.contains.some((word) => !definition.includes(word))) return [`${required.name} (not the intended rule)`];
      return [];
    });
    add(badIndexes.length ? { id: "schema_indexes", area: "schema", status: "fail", detail: `Indexes that are missing or are not the intended rule: ${list(badIndexes)}.`, count: badIndexes.length } : { id: "schema_indexes", area: "schema", status: "pass", detail: `All ${PROVISIONING_SCHEMA_INDEXES.length} indexes exist with their intended uniqueness and predicate.`, count: 0 });
    const badTriggers = PROVISIONING_SCHEMA_TRIGGERS.flatMap((name) => {
      const found = schema.triggers.find((trigger) => trigger.name === name);
      if (!found) return [`${name} (missing)`];
      return found.enabled === "O" || found.enabled === "A" ? [] : [`${name} (disabled)`];
    });
    add(badTriggers.length ? { id: "schema_triggers", area: "schema", status: "fail", detail: `Guard triggers missing or disabled: ${list(badTriggers)}.`, count: badTriggers.length } : { id: "schema_triggers", area: "schema", status: "pass", detail: `All ${PROVISIONING_SCHEMA_TRIGGERS.length} guard triggers exist and are enabled.`, count: 0 });
    const missingFunctions = PROVISIONING_SCHEMA_FUNCTIONS.filter((name) => !schema.functions.includes(name));
    add(missingFunctions.length ? { id: "schema_functions", area: "schema", status: "fail", detail: `Missing functions: ${list(missingFunctions)}.`, count: missingFunctions.length } : { id: "schema_functions", area: "schema", status: "pass", detail: `All ${PROVISIONING_SCHEMA_FUNCTIONS.length} functions exist.`, count: 0 });
    add(schema.serverVersionNum === null
      ? { id: "schema_server_version", area: "schema", status: "unknown", detail: "The server version could not be read." }
      : { id: "schema_server_version", area: "schema", status: "pass", detail: `server_version_num ${schema.serverVersionNum}${schema.serverVersionNum >= 150000 ? " (supports ON DELETE SET NULL (column))" : " (below 150000: use NO ACTION in any composite-key migration)"}.`, values: { server_version_num: schema.serverVersionNum } });
  }

  // ---- row-level security and grants
  const rls = facts.rls;
  if (!rls) {
    for (const id of ["rls_enabled", "rls_select_policy", "rls_no_public_access", "rls_app_role_read_only", "rls_lease_columns"]) unreadable(id, "rls", "Row-level security");
  } else {
    const noRls = rls.tables.filter((table) => !table.rowSecurity).map((table) => table.table);
    add(noRls.length ? { id: "rls_enabled", area: "rls", status: "fail", detail: `Row-level security is off on: ${list(noRls)}.`, count: noRls.length } : { id: "rls_enabled", area: "rls", status: "pass", detail: `Row-level security is on for all ${rls.tables.length} tables read.`, count: 0 });
    if (!rls.roles.app) {
      for (const id of ["rls_select_policy", "rls_app_role_read_only", "rls_lease_columns"]) add({ id, area: "rls", status: "unknown", detail: "The application's database role does not exist here, so what it may do is not decided." });
    } else {
      const invisible = rls.tables.filter((table) => table.appSelect && !table.selectPolicy).map((table) => table.table);
      add(invisible.length ? { id: "rls_select_policy", area: "rls", status: "fail", detail: `The application role may select but no policy lets it see a row in: ${list(invisible)}.`, count: invisible.length } : { id: "rls_select_policy", area: "rls", status: "pass", detail: "Every table the application role may read has a read policy.", count: 0 });
      const writable = rls.tables.filter((table) => READ_ONLY_FOR_APP_ROLE.includes(table.table) && (table.appWrite.insert || table.appWrite.update || table.appWrite.delete)).map((table) => table.table);
      add(writable.length ? { id: "rls_app_role_read_only", area: "rls", status: "fail", detail: `The application role can write to tables only trusted server code may write: ${list(writable)}.`, count: writable.length } : { id: "rls_app_role_read_only", area: "rls", status: "pass", detail: `The application role holds no insert, update or delete on the ${READ_ONLY_FOR_APP_ROLE.length} provisioning tables.`, count: 0 });
      add(rls.leaseTokenSelectable === null
        ? { id: "rls_lease_columns", area: "rls", status: "unknown", detail: "Whether the application role can read lease tokens could not be asked." }
        : rls.leaseTokenSelectable
          ? { id: "rls_lease_columns", area: "rls", status: "warn", detail: "A signed-in member can read the lease token, result reference and manifest hashes of their own workspace's jobs (more than the product needs; the optional column-grant migration closes it)." }
          : { id: "rls_lease_columns", area: "rls", status: "pass", detail: "The application role cannot read the lease token of a job." });
    }
    const open = rls.tables.filter((table) => (table.hasOrgId && table.publicPrivilege) || table.openPolicy).map((table) => table.table);
    add(open.length ? { id: "rls_no_public_access", area: "rls", status: "fail", detail: `anon, authenticated or PUBLIC can reach: ${list(open)}.`, count: open.length } : { id: "rls_no_public_access", area: "rls", status: "pass", detail: "The browser-facing roles hold no privilege on any workspace table and no policy names them.", count: 0 });
  }

  // ---- jobs
  const jobs = facts.jobs;
  add(jobs.byKindStatus
    ? { id: "jobs_by_status_kind", area: "jobs", status: "pass", detail: `${plural(jobs.byKindStatus.reduce((sum, row) => sum + row.count, 0), "provisioning job")} in total.`, count: jobs.byKindStatus.reduce((sum, row) => sum + row.count, 0), values: Object.fromEntries(jobs.byKindStatus.map((row) => [`${row.kind}.${row.status}`, row.count])) }
    : { id: "jobs_by_status_kind", area: "jobs", status: "unknown", detail: "The provisioning jobs could not be counted." });
  finds("jobs_duplicate_open", "jobs", jobs.duplicateOpen, { none: "No employee has two open provisioning jobs.", some: (n) => `${plural(n, "employee")} with more than one open provisioning job (the one-open-job index is missing or was bypassed).` });
  finds("jobs_stuck_leases", "jobs", jobs.stuckExhausted, { none: "No job on its last attempt holds an expired lease.", some: (n) => `${plural(n, "job")} on the last attempt hold an expired lease: nothing reclaims them and they block every later job of that employee.` });
  finds("jobs_stuck_retryable", "jobs", jobs.stuckRetryable, { fail: "warn", none: `No job has been past its lease for more than ${STUCK_RETRYABLE_MINUTES} minutes.`, some: (n) => `${plural(n, "job")} past their lease for more than ${STUCK_RETRYABLE_MINUTES} minutes (the next claim should take them over; check that the worker is running).` });
  finds("jobs_exhausted", "jobs", jobs.exhaustedFailed, { fail: "warn", none: "No job has used all its attempts.", some: (n) => `${plural(n, "job")} used all three attempts and wait for a person's decision.` });
  finds("jobs_stale_awaiting_health", "jobs", jobs.staleAwaitingHealth, { fail: "warn", none: `No job has waited more than ${STALE_HEALTH_STAGE_MINUTES} minutes for the portal's health check.`, some: (n) => `${plural(n, "job")} waiting more than ${STALE_HEALTH_STAGE_MINUTES} minutes for the portal's health check.` });
  // A job that waits on a workspace the claim would refuse is a problem only once the worker is on: while dormant it is simply queued.
  finds("jobs_ineligible_open", "jobs", jobs.ineligibleDue, { fail: dormant ? "warn" : "fail", none: "No claimable job belongs to a workspace the claim would refuse.", some: (n) => `${plural(n, "claimable job")} belong to a demo, inactive, not-onboarded, ownerless, unpaid or disabled workspace: the claim refuses them, and they wait.` });
  finds("jobs_ineligible_running", "jobs", jobs.ineligibleOpen, { fail: "warn", none: "No running job belongs to a workspace the claim would now refuse.", some: (n) => `${plural(n, "running job")} belong to a workspace that is no longer eligible (for example a refunded setup fee).` });
  finds("jobs_without_requester", "jobs", jobs.withoutRequester, { fail: "warn", none: "Every open provision job has a requester or an owner who can be held accountable.", some: (n) => `${plural(n, "provision job")} with no requester in a workspace with no active owner (the work runner refuses work with nobody accountable).` });

  // ---- profile table integrity
  const profiles = facts.profiles;
  finds("profiles_six_per_client", "profiles", profiles.notSixPerClient, { none: `Every client workspace has exactly ${AGENT_ROLE_KEYS.length} employees, one per role.`, some: (n) => `${plural(n, "client workspace")} without exactly one employee for each of the six roles.` });
  finds("profiles_reserved_on_clients", "profiles", profiles.reservedOnClients, { none: "No client employee is mapped to a reserved or internal profile.", some: (n) => `${plural(n, "client employee")} mapped to a reserved or internal agency profile.` });
  finds("profiles_naming", "profiles", profiles.notClientNamed, { fail: "warn", none: "Every client profile carries the client prefix.", some: (n) => `${plural(n, "client profile")} without the client prefix (connected by hand, not provisioned).` });
  finds("profiles_identity_matches", "profiles", profiles.identityMismatch, { none: "Every provisioned client profile equals the identity derived for its workspace and role.", some: (n) => `${plural(n, "client profile")} that is not the identity derived for its workspace and role.` });
  finds("profiles_gateway_pairing", "profiles", profiles.gatewayPairing, { none: "Every client profile and gateway reference agree.", some: (n) => `${plural(n, "client employee")} with a profile but no gateway, a gateway but no profile, or a base address that is not its gateway's.` });
  finds("profiles_normalized_duplicates", "profiles", profiles.duplicateProfiles, { none: "No two employees share a profile once the address is normalised.", some: (n) => `${plural(n, "profile")} backing more than one employee (a trailing slash defeats the plain unique index).` });
  finds("profiles_credential_org_ownership", "profiles", profiles.credentialForeign, { none: "Every client employee's credential belongs to its own workspace.", some: (n) => `${plural(n, "client employee")} using a credential that belongs to another workspace or to nobody.` });
  const credentialProblems = [profiles.credentialRevoked, profiles.credentialShared, profiles.credentialFingerprintShared];
  if (credentialProblems.some((entry) => entry === null)) unreadable("profiles_credential_integrity", "profiles", "The credentials");
  else {
    const [revoked, shared, fingerprint] = credentialProblems as Finding[];
    const total = revoked.count + shared.count + fingerprint.count;
    add(total
      ? { id: "profiles_credential_integrity", area: "profiles", status: "fail", detail: `${revoked.count} client employee(s) on a revoked credential, ${shared.count} credential(s) shared by two employees, ${fingerprint.count} live key fingerprint(s) held twice.`, count: total, ids: [...revoked.ids, ...shared.ids, ...fingerprint.ids].slice(0, FINDING_IDS) }
      : { id: "profiles_credential_integrity", area: "profiles", status: "pass", detail: "No client credential is revoked, shared or duplicated.", count: 0 });
  }
  finds("profiles_online_without_profile", "profiles", profiles.onlineWithoutProfile, { none: "No client employee is online without a profile and a credential.", some: (n) => `${plural(n, "client employee")} shown online with no profile or no credential.` });
  finds("profiles_active_version_ownership", "profiles", profiles.activeVersionForeign, { none: "Every active configuration version belongs to its own employee and workspace.", some: (n) => `${plural(n, "employee")} whose active configuration version belongs to another employee or workspace.` });
  finds("profiles_profile_version_ownership", "profiles", profiles.profileVersionForeign, { none: "Every profile configuration version belongs to its own employee and workspace.", some: (n) => `${plural(n, "employee")} whose profile configuration version belongs to another employee or workspace.` });
  finds("profiles_job_version_ownership", "profiles", profiles.jobVersionForeign, { none: "Every job's configuration version belongs to its own employee and workspace.", some: (n) => `${plural(n, "job")} pointing at another employee's or workspace's configuration version.` });
  finds("profiles_job_source_ownership", "profiles", profiles.jobSourceForeign, { none: "Every job's source job belongs to its own employee and workspace.", some: (n) => `${plural(n, "job")} pointing at another employee's or workspace's source job.` });
  add(profiles.agencyWorkspaces === null
    ? { id: "profiles_agency_count", area: "profiles", status: "unknown", detail: "The agency workspaces could not be counted." }
    : profiles.agencyWorkspaces === 1
      ? { id: "profiles_agency_count", area: "profiles", status: "pass", detail: "Exactly one agency workspace exists.", count: 1 }
      : { id: "profiles_agency_count", area: "profiles", status: "fail", detail: `${profiles.agencyWorkspaces} agency workspaces exist; there must be exactly one.`, count: profiles.agencyWorkspaces });
  finds("profiles_agency_on_client_gateway", "profiles", profiles.agencyOnAttestedGateway, { none: "No gateway marked client-only has an agency employee mapped to it.", some: (n) => `${plural(n, "gateway")} marked client-only host an agency employee: the client-only runtime is not separate.` });
  finds("profiles_client_on_agency_gateway", "profiles", profiles.clientOnAgencyGateway, { fail: dormant ? "warn" : "fail", none: "No client employee is mapped to a gateway that also hosts agency employees.", some: (n) => `${plural(n, "client employee")} mapped to a gateway that also hosts the agency's own employees.` });
  finds("profiles_applied_config", "profiles", profiles.enabledWithoutAppliedConfig, { fail: "warn", none: "Every enabled employee of an onboarded client has an applied configuration.", some: (n) => `${plural(n, "enabled employee")} of an onboarded client without an applied configuration (the claim skips them).` });

  // ---- gateways and attestation
  const gateways = facts.gateways;
  if (!gateways) {
    for (const id of ["gateway_inventory", "gateway_pinned_valid", "gateway_attestation_state"]) unreadable(id, "gateway", "The gateways");
  } else {
    const attested = gateways.filter((gateway) => gateway.attested);
    add({
      id: "gateway_inventory", area: "gateway", status: "pass", detail: `${plural(gateways.length, "gateway")}, ${attested.length} attested as client-only.`, count: gateways.length, ids: gateways.map((gateway) => gateway.id).slice(0, FINDING_IDS),
      values: Object.fromEntries(gateways.slice(0, FINDING_IDS).map((gateway) => [gateway.id.slice(0, 8), `${gateway.status}, ${gateway.gatewayType}, ${gateway.profileCreationStatus}, ${gateway.attested ? "attested" : "not attested"}, ${gateway.agencyEmployees} agency employee(s), ${gateway.clientProfiles} client profile(s)`])),
    });
    if (dormant) {
      add(attested.length === 0
        ? { id: "gateway_attestation_state", area: "gateway", status: "pass", detail: "No gateway is attested as client-only, which is the dormant state.", count: 0 }
        : { id: "gateway_attestation_state", area: "gateway", status: "warn", detail: `${plural(attested.length, "gateway")} already attested as client-only while the expected state is dormant.`, count: attested.length, ids: attested.map((gateway) => gateway.id) });
    } else {
      add(attested.length > 0
        ? { id: "gateway_attestation_state", area: "gateway", status: "pass", detail: `${plural(attested.length, "gateway")} attested as client-only.`, count: attested.length }
        : { id: "gateway_attestation_state", area: "gateway", status: "fail", detail: "No gateway is attested as client-only, so the claim has nowhere to place a profile.", count: 0 });
    }
    if (!envNames) {
      add({ id: "gateway_pinned_valid", area: "gateway", status: "unknown", detail: "The pinned gateway id lives in the hosted app's environment; no environment file was given, so which gateway is pinned is not known." });
    } else {
      const pinned = envNames.pinnedGatewayId ? gateways.find((gateway) => gateway.id.toLowerCase() === envNames.pinnedGatewayId) : undefined;
      if (dormant) {
        add(!pinned || !pinned.attested
          ? { id: "gateway_pinned_valid", area: "gateway", status: "pass", detail: !envNames.pinnedGatewayId ? "No gateway is pinned, which is the dormant state." : !pinned ? "The pinned gateway id matches no gateway row." : "The pinned gateway is not attested." }
          : { id: "gateway_pinned_valid", area: "gateway", status: "fail", detail: "The pinned gateway is attested as client-only while the expected state is dormant." });
      } else if (!envNames.pinnedGatewayId) {
        add({ id: "gateway_pinned_valid", area: "gateway", status: "fail", detail: "No gateway id is pinned for the provisioner." });
      } else if (!pinned) {
        add({ id: "gateway_pinned_valid", area: "gateway", status: "fail", detail: "The pinned gateway id matches no gateway row." });
      } else {
        const problems = [
          pinned.status !== "connected" ? "not connected" : null,
          pinned.gatewayType !== "multiplexed_profiles" ? "not a multiplexed gateway" : null,
          pinned.profileCreationStatus !== "restricted_service_verified" ? "restricted service not verified" : null,
          !pinned.attested ? "not attested as client-only" : null,
          pinned.agencyEmployees > 0 ? "hosts agency employees" : null,
        ].filter((problem): problem is string => problem !== null);
        const stale = pinned.healthAgeMinutes === null || pinned.healthAgeMinutes > STALE_GATEWAY_HOURS * 60;
        add(problems.length
          ? { id: "gateway_pinned_valid", area: "gateway", status: "fail", detail: `The pinned gateway is ${problems.join(", ")}.`, count: problems.length }
          : stale
            ? { id: "gateway_pinned_valid", area: "gateway", status: "warn", detail: `The pinned gateway is verified and attested, but its own health check is ${pinned.healthAgeMinutes === null ? "missing" : `older than ${STALE_GATEWAY_HOURS} hours`}.` }
            : { id: "gateway_pinned_valid", area: "gateway", status: "pass", detail: "The pinned gateway is connected, multiplexed, restricted-service verified, attested and hosts no agency employee." });
      }
    }
  }

  // ---- environment, by name only
  const source = envNames ? (envNames.source === "env_file" ? "the environment file that was given" : "this machine's own environment (not the hosted app's)") : null;
  const noEnv = (id: string) => add({ id, area: "env", status: "unknown", detail: "No environment file was given. This machine's environment is not the hosted app's, so the names are not read from it; pass --env-file with the names pulled from the hosting provider." });
  const entry = (name: string): EnvEntry => envNames?.entries[name] ?? { set: false };
  if (!envNames) for (const id of ["env_names", "env_provisioner_switch", "env_provisioner_credential", "env_flags_consistency", "env_role_tool_enforcement"]) noEnv(id);
  else {
    const classOf = (name: string): string => {
      const e = entry(name);
      if (!e.set) return "not set";
      if (e.on !== undefined) return e.on ? "on" : "off";
      if (e.lengthOk !== undefined) return e.lengthOk ? "set, meets minimum length" : "set, below minimum length";
      if (e.uuid !== undefined) return e.uuid ? "set, id-shaped" : "set, not id-shaped";
      if (e.number !== undefined) return "set, a number";
      if (e.names !== undefined) return `set, ${e.names} name(s)`;
      if (e.word !== undefined) return `set, ${e.word} mode`;
      return "set";
    };
    add({ id: "env_names", area: "env", status: "pass", detail: `Read ${PREFLIGHT_ENV_NAMES.length} names from ${source}; names and classes only, never a value.`, count: PREFLIGHT_ENV_NAMES.length, values: Object.fromEntries(PREFLIGHT_ENV_NAMES.map((name) => [name, classOf(name)])) });

    const enabledOn = entry("HERMES_PROVISIONER_ENABLED").on === true;
    const cap = entry("HERMES_PROVISIONER_MAX_PROFILES");
    if (dormant) {
      add(enabledOn
        ? { id: "env_provisioner_switch", area: "env", status: "fail", detail: "HERMES_PROVISIONER_ENABLED is on while the expected state is dormant." }
        : { id: "env_provisioner_switch", area: "env", status: "pass", detail: "HERMES_PROVISIONER_ENABLED is off, so the worker's routes refuse every request." });
      add({ id: "env_provisioner_credential", area: "env", status: "pass", detail: "The worker's token and pinned gateway are not required while the provisioner is dormant." });
    } else {
      const missing = [
        !enabledOn ? "HERMES_PROVISIONER_ENABLED is not on" : null,
        !entry("HERMES_PROVISIONER_TOKEN").lengthOk ? "HERMES_PROVISIONER_TOKEN is missing or too short" : null,
        !entry("HERMES_PROVISIONER_GATEWAY_ID").uuid ? "HERMES_PROVISIONER_GATEWAY_ID is missing or not an id" : null,
        cap.number === undefined ? "HERMES_PROVISIONER_MAX_PROFILES is not set" : null,
      ].filter((problem): problem is string => problem !== null);
      add(missing.length
        ? { id: "env_provisioner_switch", area: "env", status: "fail", detail: `The provisioner cannot run as configured: ${missing.join("; ")}.`, count: missing.length }
        : { id: "env_provisioner_switch", area: "env", status: "pass", detail: "The provisioner is on with its token, pinned gateway and profile ceiling." });
      const gatewayRow = envNames.pinnedGatewayId ? gateways?.some((gateway) => gateway.id.toLowerCase() === envNames.pinnedGatewayId) : undefined;
      add(!entry("HERMES_PROVISIONER_TOKEN").lengthOk || !entry("HERMES_PROVISIONER_GATEWAY_ID").uuid
        ? { id: "env_provisioner_credential", area: "env", status: "fail", detail: "The worker's token is missing or shorter than 32 characters, or the pinned gateway id is not an id." }
        : gatewayRow === undefined ? { id: "env_provisioner_credential", area: "env", status: "unknown", detail: "The gateways could not be read, so the pinned id is not matched to a row." }
        : gatewayRow ? { id: "env_provisioner_credential", area: "env", status: "pass", detail: "The worker's token meets the minimum length and the pinned gateway id matches a gateway row." }
        : { id: "env_provisioner_credential", area: "env", status: "fail", detail: "The pinned gateway id matches no gateway row." });
    }

    const stagedJobs = entry("SCHEDULER_JOBS_ONLY").names ?? 0;
    const inconsistent = [
      entry("HERMES_BUSINESS_MCP_WRITES_ENABLED").on && !entry("HERMES_BUSINESS_MCP_ENABLED").on ? "business writes are on without the business tools" : null,
      entry("HERMES_CLIENT_BUSINESS_MCP_PROPOSALS_ENABLED").on && !entry("HERMES_CLIENT_BUSINESS_MCP_ENABLED").on ? "client proposals are on without the client business tools" : null,
      entry("HERMES_BUSINESS_MCP_ENABLED").on && !entry("HERMES_BUSINESS_MCP_SECRET").lengthOk ? "the business tools are on without a signing secret of the minimum length" : null,
      dormant && entry("SCHEDULER_ENABLED").on && stagedJobs === 0 ?"the scheduler is on with no named job list (every job would run)" : null,
      dormant && entry("HERMES_CLIENT_BUSINESS_MCP_ENABLED").on ? "the client business tools are on while the expected state is dormant" : null,
    ].filter((problem): problem is string => problem !== null);
    add(inconsistent.length
      ? { id: "env_flags_consistency", area: "env", status: "fail", detail: `Switch combinations that should not exist: ${inconsistent.join("; ")}.`, count: inconsistent.length }
      : { id: "env_flags_consistency", area: "env", status: "pass", detail: "The business-tool and scheduler switches are consistent." });

    const word = entry("WORKFORCE_ROLE_TOOL_ENFORCEMENT").word ?? "enforce";
    add(word === "report"
      ? { id: "env_role_tool_enforcement", area: "env", status: dormant ? "warn" : "fail", detail: "The per-role tool allowlist is in report mode (it records a violation and still lets the run go on); a client team runs in enforce mode." }
      : { id: "env_role_tool_enforcement", area: "env", status: "pass", detail: "The per-role tool allowlist enforces (the default)." });
  }

  // ---- capacity
  const mapped = gateways ? (envNames?.pinnedGatewayId ? gateways.filter((gateway) => gateway.id.toLowerCase() === envNames.pinnedGatewayId) : gateways).reduce((sum, gateway) => sum + gateway.clientProfiles, 0) : null;
  const owed = facts.owedProfiles;
  const capNumber = envNames?.entries.HERMES_PROVISIONER_MAX_PROFILES?.number;
  if (!envNames) {
    noEnv("capacity_configured");
    noEnv("capacity_headroom");
  } else if (capNumber === undefined) {
    add({ id: "capacity_configured", area: "capacity", status: dormant ? "warn" : "fail", detail: "HERMES_PROVISIONER_MAX_PROFILES is not set: nothing stops the claim from creating profile after profile on a runtime whose headroom is not measured." });
    add({ id: "capacity_headroom", area: "capacity", status: "warn", detail: "With no ceiling set there is no headroom to measure." });
  } else if (mapped === null || owed === null) {
    unreadable("capacity_configured", "capacity", "The profile counts");
    unreadable("capacity_headroom", "capacity", "The profile counts");
  } else {
    const needed = mapped + owed;
    add(capNumber >= needed
      ? { id: "capacity_configured", area: "capacity", status: "pass", detail: `The ceiling (${capNumber}) covers the ${mapped} mapped profile(s) and the ${owed} still owed.`, count: needed }
      : { id: "capacity_configured", area: "capacity", status: dormant ? "warn" : "fail", detail: `The ceiling (${capNumber}) is below the ${mapped} mapped profile(s) plus the ${owed} still owed.`, count: needed });
    add(mapped / capNumber >= HEADROOM_WARN_RATIO
      ? { id: "capacity_headroom", area: "capacity", status: "warn", detail: `${mapped} of ${capNumber} profiles are in use (${Math.round((mapped / capNumber) * 100)}%): raise the ceiling only after measuring the host.`, count: mapped }
      : { id: "capacity_headroom", area: "capacity", status: "pass", detail: `${mapped} of ${capNumber} profiles are in use.`, count: mapped });
  }
  add({ id: "capacity_runtime_resources", area: "capacity", status: "manual", detail: "The client runtime's memory, processor and one-run-at-a-time limits are starting limits, not a load test. This tool cannot read the host: measure it before raising the ceiling." });

  // ---- manual items: never a pass
  add({ id: "manual_backup", area: "manual", status: "manual", detail: "Confirm the database has a backup or point-in-time recovery and that a restore was tried. This tool cannot see the hosting plan." });
  add({ id: "manual_apply_plan", area: "manual", status: "manual", detail: "For any pending migration: review the dry-run list, the rollback file, who applies it and when. This tool applies nothing." });
  add({ id: "manual_runtime_separation", area: "manual", status: "manual", detail: "Confirm the client-only runtime is separate from the internal one and that the gateway hardening gates are done. This tool cannot see the hosts." });

  const summary: Record<PreflightStatus, number> = { pass: 0, fail: 0, warn: 0, unknown: 0, manual: 0 };
  for (const check of checks) summary[check.status] += 1;
  return { ok: summary.fail === 0, complete: summary.unknown === 0, expect, checks, summary };
}

/** The result as plain lines for a terminal: a status word, the check id and its detail. Nothing here is more than the checks themselves hold. */
export function formatPreflight(result: PreflightResult): string[] {
  const word: Record<PreflightStatus, string> = { pass: " OK ", fail: "FAIL", warn: "WARN", unknown: "????", manual: "TODO" };
  const lines = result.checks.map((check) => `  [${word[check.status]}] ${check.id}: ${check.detail}`);
  lines.push(`  ${result.summary.pass} passed, ${result.summary.fail} failed, ${result.summary.warn} warning(s), ${result.summary.unknown} not decided, ${result.summary.manual} manual item(s) that are never a pass.`);
  lines.push(result.ok ? (result.complete ? "RESULT: NO FAILURES" : "RESULT: NO FAILURES, BUT SOME CHECKS WERE NOT DECIDED") : "RESULT: FAIL");
  return lines;
}
