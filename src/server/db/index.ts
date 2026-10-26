import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { env } from "@/server/env";
import { SupabaseConfigError, supabaseConfigStatus } from "@/server/supabase/config";
import { loadDatabaseCa, planPostgresTls } from "@/server/db/tls";
import { OperationFailure } from "@/server/diagnostics";
import { attachPoolErrorHandlers } from "@/server/db/pool-errors";

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

interface Driver {
  /** "pglite" is the embedded development database; it needs the Supabase emulation layer. */
  kind: "pglite" | "postgres";
  query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  exec(sql: string): Promise<void>;
  /** Executes a multi-statement script atomically. */
  execScript(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function createPgliteDriver(dataDir: string | undefined): Promise<Driver> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { citext } = await import("@electric-sql/pglite/contrib/citext");
  // The same contrib extensions the hosted Supabase project offers: trigram search and GiST equality (booking exclusion constraints).
  const { pg_trgm } = await import("@electric-sql/pglite/contrib/pg_trgm");
  const { btree_gist } = await import("@electric-sql/pglite/contrib/btree_gist");
  if (dataDir) fs.mkdirSync(dataDir, { recursive: true });
  const db = new PGlite({ dataDir, extensions: { citext, pg_trgm, btree_gist } });
  await db.waitReady;
  const wrap = (q: { query: typeof db.query }): Queryable => ({
    async query<T>(sql: string, params?: unknown[]) {
      const res = await q.query<T>(sql, params as unknown[] | undefined);
      return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
    },
  });
  return {
    kind: "pglite",
    query: (sql, params) => wrap(db).query(sql, params),
    exec: async (sql) => {
      await db.exec(sql);
    },
    execScript: async (sql) => {
      await db.transaction(async (tx) => {
        await tx.exec(sql);
      });
    },
    transaction: (fn) => db.transaction((tx) => fn(wrap(tx))),
    close: () => db.close(),
  };
}

async function createPostgresDriver(connectionString: string): Promise<Driver> {
  const { Pool } = await import("pg");
  const e = env();
  const caFile = e.DATABASE_SSL_CA_FILE?.trim();
  // A missing or unreadable CA file never downgrades TLS; the known production root has a bundled fallback.
  let caPem: string | undefined;
  try {
    const ca = loadDatabaseCa({ caFile, inlinePem: e.DATABASE_SSL_CA });
    caPem = ca.pem;
    if (ca.source === "bundled") {
      console.warn("[iacquire] configured Supabase root CA file was absent from the function path; using the bundled Supabase Root 2021 CA");
    }
  } catch (cause) {
    throw new OperationFailure("database.read_tls_ca_file", cause);
  }
  let tls: ReturnType<typeof planPostgresTls>;
  try {
    tls = planPostgresTls({ connectionString, caPem, requireVerified: e.NODE_ENV === "production" });
  } catch (cause) {
    throw new OperationFailure("database.configure_tls", cause);
  }
  if (tls.warning) console.warn(`[iacquire] ${tls.warning}`);
  const pool = new Pool({ connectionString: tls.connectionString, ssl: tls.ssl, max: Math.max(1, Number(process.env.DATABASE_POOL_MAX) || 4), idleTimeoutMillis: 10000 });
  // A dropped connection must be an error for the query that was using it, never an uncaught exception that ends the process.
  attachPoolErrorHandlers(pool);
  const query = async <T>(operation: string, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (cause) {
      if (cause instanceof OperationFailure) throw cause;
      throw new OperationFailure(operation, cause);
    }
  };
  return {
    kind: "postgres",
    async query<T>(sql: string, params?: unknown[]) {
      const res = await query("database.postgres_query", () => pool.query(sql, params));
      return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
    },
    async exec(sql) {
      await query("database.postgres_query", () => pool.query(sql));
    },
    async execScript(sql) {
      const client = await query("database.postgres_pool_connect", () => pool.connect());
      try {
        await query("database.transaction_begin", () => client.query("begin"));
        await query("database.postgres_query", () => client.query(sql));
        await query("database.transaction_commit", () => client.query("commit"));
      } catch (err) {
        await client.query("rollback").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    async transaction(fn) {
      const client = await query("database.postgres_pool_connect", () => pool.connect());
      try {
        await query("database.transaction_begin", () => client.query("begin"));
        const result = await fn({
          async query<T>(sql: string, params?: unknown[]) {
            const res = await query("database.postgres_query", () => client.query(sql, params));
            return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
          },
        });
        await query("database.transaction_commit", () => client.query("commit"));
        return result;
      } catch (err) {
        await client.query("rollback").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

type GlobalDb = { promise?: Promise<Driver> };
const globalForDb = globalThis as unknown as { __iaqDb?: GlobalDb };
const holder: GlobalDb = (globalForDb.__iaqDb ??= {});

async function init(): Promise<Driver> {
  const e = env();
  if (e.AUTH_PROVIDER === "supabase" && e.NODE_ENV !== "test") {
    const config = supabaseConfigStatus();
    if (!config.configured) throw new SupabaseConfigError(config.problems);
  }
  let driver: Driver;
  if (e.DATABASE_DRIVER === "postgres") {
    if (!e.DATABASE_URL) throw new Error("DATABASE_URL is required for the postgres driver.");
    driver = await createPostgresDriver(e.DATABASE_URL);
  } else {
    const dir = e.DATABASE_DRIVER === "pglite-memory" ? undefined : path.resolve(/* turbopackIgnore: true */ process.cwd(), e.PGLITE_DATA_DIR);
    driver = await createPgliteDriver(dir);
    // Embedded databases are migrated automatically. Hosted Postgres is migrated explicitly
    // with `npm run db:migrate` so schema changes are a deliberate deployment step.
    await runMigrations(driver);
  }
  return driver;
}

function driver(): Promise<Driver> {
  holder.promise ??= init().catch((err) => {
    holder.promise = undefined;
    throw err;
  });
  return holder.promise;
}

// Tracks the transaction currently running in this async context. Opening a second transaction
// from inside one deadlocks the single-connection embedded database (the inner waits for the
// outer, which waits for the inner) and holds two pool connections on hosted Postgres. Callers
// must pass the `db` they were given instead.
const activeTx = new AsyncLocalStorage<{ open: boolean; label: string }>();

export class NestedTransactionError extends Error {
  constructor(outer: string, inner: string) {
    super(`${inner} was called inside an open ${outer} transaction. Pass the existing db handle instead.`);
  }
}

async function runTransaction<T>(label: string, fn: (tx: Queryable) => Promise<T>, d: Driver): Promise<T> {
  const outer = activeTx.getStore();
  if (outer?.open) {
    const err = new NestedTransactionError(outer.label, label);
    // Reject in every environment; allowing nesting can deadlock production row locks as well.
    throw err;
  }
  const marker = { open: true, label };
  return activeTx.run(marker, async () => {
    // Opt-in profiling for high-latency deployments: one line per transaction showing how many
    // statements it sends. Off in normal runs, so it adds no logging or output overhead.
    const trace = process.env.IAQ_DB_TRACE === "1";
    const started = trace ? performance.now() : 0;
    let statements = 0;
    try {
      return await d.transaction((tx) =>
        fn(
          trace
            ? {
                query: <R>(sql: string, params?: unknown[]) => {
                  statements += 1;
                  return tx.query<R>(sql, params);
                },
              }
            : tx,
        ),
      );
    } finally {
      if (trace) {
        console.log(`[db-trace] ${label} driver=${d.kind} statements=${statements} ms=${Math.round(performance.now() - started)}`);
      }
      marker.open = false;
    }
  });
}

/**
 * Trusted server-side access as the table owner. RLS does not apply, so every caller must
 * perform its own authorization first. Used for auth, audit writes, background execution and
 * agency operations that are authorized in code.
 */
export async function withSystem<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
  const d = await driver();
  return runTransaction("withSystem", fn, d);
}

/**
 * Read-only counterpart to `withSystem` for one trusted query. A read does not need BEGIN/COMMIT,
 * and on the hosted database those two extra round trips cost roughly 300 ms per call. Callers
 * authorize and scope the read exactly as a `withSystem` caller would; only `select`/`with`
 * statements are accepted so this helper can never become an unreviewed write path.
 */
export async function readSystem<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
  const outer = activeTx.getStore();
  if (outer?.open) throw new NestedTransactionError(outer.label, "readSystem");
  const d = await driver();
  return fn({
    query: async <R>(sql: string, params?: unknown[]) => {
      if (!/^\s*(select|with)\b/i.test(sql)) throw new Error("readSystem only runs select statements");
      return d.query<R>(sql, params);
    },
  });
}

/**
 * Executes as Supabase's service_role for narrowly scoped server operations that need its
 * explicit grants (for example credential metadata). The database login must be allowed to
 * assume service_role; the transaction-local switch is automatically reset before the pooled
 * connection is reused. Callers still authorize before entering this boundary.
 */
export async function withServiceRole<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
  const d = await driver();
  return runTransaction("withServiceRole", async (tx) => {
    await tx.query("set local role service_role");
    return fn(tx);
  }, d);
}

/**
 * Runs queries as the signed-in user under row-level security. Tenant isolation is enforced
 * by PostgreSQL policies in addition to application checks.
 *
 * The identity, role and statement timeout are applied in one statement. On a hosted database
 * every extra statement is another network round trip (~150 ms between iad1 and Tokyo), so the
 * former `set_config` + `set local role` pair cost one round trip per transaction.
 */
export async function withUser<T>(
  userId: string,
  fn: (db: Queryable) => Promise<T>,
  options: { statementTimeout?: string } = {},
): Promise<T> {
  if (!UUID_RE.test(userId)) throw new Error("withUser requires a valid user id");
  const d = await driver();
  return runTransaction(
    "withUser",
    async (tx) => {
      await tx.query(
        `select set_config('app.user_id', $1, true),
                set_config('role', 'iaq_app_user', true),
                set_config('statement_timeout', $2, true)`,
        [userId, options.statementTimeout ?? "0"],
      );
      return fn(tx);
    },
    d,
  );
}

/**
 * Runs queries as iaq_site_runtime, the role behind the public website runtime. It has no table privileges and can only
 * execute the few narrow functions defined for it (see the websites migration), so a flaw in the public runtime cannot
 * expose a draft, another tenant or any customer record.
 */
export async function withSiteRuntime<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
  const d = await driver();
  return runTransaction(
    "withSiteRuntime",
    async (tx) => {
      await tx.query("set local role iaq_site_runtime");
      return fn(tx);
    },
    d,
  );
}

export async function closeDb() {
  if (!holder.promise) return;
  const d = await holder.promise;
  holder.promise = undefined;
  await d.close();
}

export async function pingDb(): Promise<{ ok: boolean; latencyMs: number }> {
  const start = Date.now();
  try {
    const d = await driver();
    await d.query("select 1");
    return { ok: true, latencyMs: Date.now() - start };
  } catch {
    return { ok: false, latencyMs: Date.now() - start };
  }
}

/** Canonical schema. The folder layout and file names follow the Supabase CLI convention. */
export function migrationsDir() {
  return path.resolve(/* turbopackIgnore: true */ process.cwd(), "supabase", "migrations");
}

/**
 * Emulation of the Supabase-managed schemas (auth, storage, realtime) and roles for the embedded
 * development database ONLY. A real Supabase project already provides all of this and must never
 * run this file. It exists so row-level-security and policy tests can run without Docker.
 */
export function localCompatFile() {
  return path.resolve(/* turbopackIgnore: true */ process.cwd(), "supabase", "local-compat.sql");
}

const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;
const COMPAT_VERSION = "compat_local_supabase_1";

export function listMigrationFiles(): string[] {
  return fs.readdirSync(migrationsDir()).filter((f) => MIGRATION_FILE.test(f)).sort();
}

const migrationPrefix = (file: string) => file.slice(0, file.indexOf("_"));

/** Select exact migration versions while retaining repository order. */
export function selectMigrationFiles(versions?: readonly string[]): string[] {
  const files = listMigrationFiles();
  if (versions === undefined) return files;
  if (!versions.length) throw new Error("Pass at least one exact migration version after --only.");
  if (new Set(versions).size !== versions.length) throw new Error("A migration version was requested more than once.");

  const byVersion = new Map(files.map((file) => [file.replace(/\.sql$/, ""), file]));
  const unknown = versions.filter((version) => !byVersion.has(version));
  if (unknown.length) throw new Error(`Unknown migration version(s): ${unknown.join(", ")}. Pass exact filenames without .sql.`);

  const selected = new Set(versions);
  return files.filter((file) => selected.has(file.replace(/\.sql$/, "")));
}

export const MIGRATION_PREREQUISITES: Record<string, readonly string[]> = {
  "0039_agency_team_permission_overrides": [
    "0037_service_role_integration_credential_access",
    "0038_agency_team_and_hermes_policies",
  ],
  "0040_agency_workforce_permissions": ["0039_agency_team_permission_overrides"],
  "0041_crm_action_permissions": ["0040_agency_workforce_permissions"],
  "0042_company_delete_permission": ["0041_crm_action_permissions"],
  "0043_agency_manager_operational_defaults": ["0042_company_delete_permission"],
  "0044_agency_module_view_overrides": ["0043_agency_manager_operational_defaults"],
  "0061_aqi_phase3_guidance": ["0047_aqi_assistant", "0048_aqi_cost_controls", "0052_aqi_conversation_lifecycle"],
  "0063_aqi_phase3_hardening": ["0061_aqi_phase3_guidance"],
  // The AI workforce migrations share tables and columns. Refuse an out-of-order partial apply
  // instead of letting 0080 fail halfway through its pending-report tables.
  "0078_ai_work_schedules": ["0077_ai_work_jobs"],
  "0079_ai_work_triggers": ["0077_ai_work_jobs"],
  "0080_proactive_ai_employees": ["0077_ai_work_jobs", "0078_ai_work_schedules"],
  "0081_ai_work_job_rls_hardening": ["0077_ai_work_jobs", "0080_proactive_ai_employees"],
  // 0083 extends notifications_kind_check from the live constraint. 0065 is the last migration that rewrites that constraint from a copied list, so it
  // must already be in: applied after 0083 (for example by --only), it would silently drop the inbox's three notification kinds.
  "0083_unified_inbox": ["0065_support_requests"],
  // The restricted client provisioner extends the client job queue introduced by 0082.
  "0084_restricted_hermes_provisioner": ["0082_client_employee_provisioning"],
  // 0085 and 0086 extend notifications_kind_check from the live constraint, like 0083, so 0065 must already be in. 0085 also needs the Unified Inbox's
  // conversation_events trail (the missed call is written to the conversation), and 0086 follows 0085 so the two never reach a database in the other order.
  "0085_missed_call_recovery": ["0065_support_requests", "0083_unified_inbox"],
  "0086_lead_scoring": ["0065_support_requests", "0085_missed_call_recovery"],
  // 0087 extends notifications_kind_check from the live constraint (so 0065 must already be in) and adds a conversation channel and a created-via value
  // to tables from 0019 and 0027.
  "0087_website_chat": ["0065_support_requests"],
  // 0089 extends notifications_kind_check from the live constraint (0065 must already be in) and replaces app.file_permission with 0049's definition plus
  // one bucket, so 0049 must already be in: applied before it, 0089 would be overwritten by it and managed media would silently lose its access rule.
  "0089_social_media_manager": ["0049_aqi_attachments", "0065_support_requests"],
  // 0090 replaces app.file_permission with 0089's definition plus two buckets: applied before 0089 (or before 0049), it would put back a definition that lacks the
  // social-media rule (and every bucket added since 0049), so 0089 must already be in.
  "0090_document_buckets": ["0049_aqi_attachments", "0089_social_media_manager"],
  // 0091 extends notifications_kind_check from the live constraint, so 0065 must already be in (applied before it, 0065 would put its copied list back and drop the
  // nine proposal kinds). It does not replace app.file_permission: the proposal-documents rule is 0090's, so 0090 must be in for the permission names to mean anything.
  "0091_proposals": ["0065_support_requests", "0090_document_buckets"],
  // 0092 hangs signature requests off proposals and links proposal_decisions to them, so 0091 must already be in. It extends no notification list (the signature kinds came
  // with 0091) and does not replace app.file_permission.
  "0092_esign": ["0091_proposals"],
  // 0094 extends notifications_kind_check from the live constraint, so 0065 must already be in (applied before it, 0065 would put its copied list back and drop the
  // six reputation kinds). It also alters customer_feedback and crm_review_requests (0033) and points at human_escalations (0019).
  "0094_reputation_followthrough": ["0033_crm_growth", "0065_support_requests"],
  // 0093 extends notifications_kind_check from the live constraint, so 0065 must already be in (applied before it, 0065 would put its copied list back and drop the
  // eight invoice and payment kinds). It also adds the 'billing' message scope by reading the live conversation_messages_scope_check (0024), and hangs invoices off
  // contacts (0027), companies and deals (0028). An invoice made from a proposal points at it (composite keys to proposals and proposal_versions) and a message that delivers one
  // uses the 'delivery' scope, both 0091's.
  "0093_customer_invoices_payments": ["0028_crm_sales", "0065_support_requests", "0091_proposals"],
  // 0095 points at social_accounts (0089: a Facebook review connection reads through the Page connected for Social media) and relies on 0094's three reviews.* permissions and
  // six notification kinds. It extends no notification list and does not replace app.file_permission.
  "0095_external_reviews": ["0089_social_media_manager", "0094_reputation_followthrough"],
  // 0096 extends notifications_kind_check, notifications_audience_check and the two agency permission-override lists from the live constraints, so 0065 (the last to copy those
  // lists) must already be in. It replaces app.notification_visible with 0067's definition plus one branch, so 0067 must be in. The staff-messages bucket, its file rule and the
  // use of the agency.messages.use permission in it are 0090's.
  "0096_staff_messages": ["0065_support_requests", "0067_notification_authorization", "0090_document_buckets"],
  // 0097 extends the two agency permission-override lists from the live constraints, so 0065 (which copied them) and 0096 (the last to extend them) must already be in: applied
  // before 0096, 0096 would still read the lists from the live constraint, but applied before 0065, 0065 would put its copied list back and drop the four workload permissions.
  // The notification kinds staff_workload_alert and staff_work_overdue and the 'staff' audience are 0096's; 0097 changes no notification list.
  "0097_staff_workload": ["0065_support_requests", "0096_staff_messages"],
  // 0098 extends the request-type, category and timeline-kind checks of 0065 and 0015 and the notification kinds from the live constraints, so 0065 must already be in (applied
  // before it, 0065 would put its copied lists back and drop the new values). It hangs change orders and prerequisites off the custom-project tables, so 0015 must be in too.
  "0098_requests_completion": ["0015_custom_projects", "0065_support_requests"],
  // 0099 backfills billing_accounts (0004) from client_setup_instances (0008), widens payments (0018), adds a column to maintenance_subscriptions (0015) and extends
  // notifications_kind_check from the live constraint, so 0065 must already be in (applied before it, 0065 would put its copied list back and drop the four billing kinds).
  "0099_payment_controls": ["0008_setup_center", "0015_custom_projects", "0018_billing_credits", "0065_support_requests"],
  // 0100 extends notifications_kind_check from the live constraint, so 0065 must already be in (applied before it, 0065 would put its copied list back and drop the four demo kinds),
  // and adds role_permissions rows for the agency_manager role, which 0038 (the last to widen that table's role check) makes valid. It points at access_requests (0001) and nothing
  // that belongs to a workspace except the converted_org_id of a prospect a Super Admin made a client.
  "0100_demo_funnel": ["0038_agency_team_and_hermes_policies", "0065_support_requests"],
  // 0102 replaces the check on crm_calendars.origin that 0054 added, adds a column to onboarding_responses (0002, 0020) and adds a step to the default checklist (0008) and to
  // the checklists that are not activated yet (0013 and 0056 added steps the same way, and 0056 gave the steps their provider column).
  "0102_onboarding_snapshot": ["0020_onboarding_v2", "0054_crm_blueprints", "0056_crm_setup_native"],
  // Workforce migrations follow the current master sequence; 0109 records the complete Hermes health probe contract.
  "0105_workforce_local_recurrence": ["0078_ai_work_schedules"],
  "0106_workforce_chat_schedule_previews": ["0105_workforce_local_recurrence"],
  "0107_workforce_chat_booking_previews": ["0106_workforce_chat_schedule_previews"],
  "0108_workforce_appointment_changes": ["0107_workforce_chat_booking_previews"],
  // 0109 reads the statement-level permission helper added by 0060 (its probe-log policy) and sits on the agent_instances columns 0059 extended.
  "0109_employee_health_probe": ["0059_hermes_tool_inventory", "0060_rls_initplan"],
  // 0110 hangs agreements off maintenance_subscriptions (0015, whose (id, org_id) key 0099's payments already point at), adds a column and two foreign keys to payments (0018, widened by
  // 0099 and 0103) and a switch to agency_billing_settings; applied before 0103 the payment's plan link would not exist.
  "0110_maintenance_agreements": ["0099_payment_controls", "0103_purchase_checkouts"],
  // 0111 replaces the invoice guard function and two of the invoice table's checks that 0093 made, adds a generated-column definition over them, and gives the invoice settings
  // two columns; applied before 0093 none of that exists. (No later migration touches the invoice tables.)
  "0111_customer_credit_notes": ["0093_customer_invoices_payments"],
  // 0112 rewrites the two permission functions that 0042 (has_permission) and 0060 (permitted_orgs) wrote, so both must already be in; applied before them 0042/0060 would put the old text back.
  "0112_client_content_policy": ["0042_company_delete_permission", "0060_rls_initplan"],
  // 0113 is the signed marketing registration: it adds the replay ledger and installs a trigger on demo_prospects, so the demo funnel (0100) must already be in. Its prefix
  // is deliberately above the highest number used on any branch: 0105–0109 belong to the workforce migrations and 0110–0112 exist on the release-candidate branch.
  "0113_demo_registration_requests": ["0100_demo_funnel"],
};

/**
 * Versions already applied. Besides this app's own table, the Supabase CLI history is honoured
 * when it exists, so a database migrated with `supabase db push` is never migrated twice.
 */
async function appliedVersions(target: Driver): Promise<Set<string>> {
  await target.exec(
    "create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())",
  );
  const applied = new Set(
    (await target.query<{ version: string }>("select version from schema_migrations")).rows.map((r) => r.version),
  );
  const cli = await target.query<{ t: string | null }>("select to_regclass('supabase_migrations.schema_migrations')::text as t");
  if (cli.rows[0]?.t) {
    const prefixes = new Set(
      (await target.query<{ version: string }>("select version from supabase_migrations.schema_migrations")).rows.map((r) => r.version),
    );
    for (const file of listMigrationFiles()) if (prefixes.has(migrationPrefix(file))) applied.add(file.replace(/\.sql$/, ""));
  }
  return applied;
}

async function recordInSupabaseHistory(target: Driver, file: string) {
  const cli = await target.query<{ t: string | null }>("select to_regclass('supabase_migrations.schema_migrations')::text as t");
  if (!cli.rows[0]?.t) return;
  // Best effort: keep `supabase migration list` in step with this runner.
  await target
    .query(
      "insert into supabase_migrations.schema_migrations (version, name) values ($1, $2) on conflict (version) do nothing",
      [migrationPrefix(file), file.replace(/^\d+_/, "").replace(/\.sql$/, "")],
    )
    .catch(() => undefined);
}

export async function runMigrations(d?: Driver, selectedVersions?: readonly string[]): Promise<string[]> {
  const files = selectMigrationFiles(selectedVersions);
  const target = d ?? (await driver());
  const applied = await appliedVersions(target);
  if (target.kind === "pglite" && !applied.has(COMPAT_VERSION)) {
    const compat = fs.readFileSync(localCompatFile(), "utf8");
    await target.execScript(`${compat}
insert into schema_migrations (version) values ('${COMPAT_VERSION}');`);
  }
  const ran: string[] = [];
  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    if (applied.has(version)) continue;
    const missingPrerequisites = (MIGRATION_PREREQUISITES[version] ?? []).filter((required) => !applied.has(required));
    if (missingPrerequisites.length) {
      throw new Error(`Cannot apply ${version} before ${missingPrerequisites.join(", ")}.`);
    }
    const sql = fs.readFileSync(path.join(migrationsDir(), file), "utf8");
    // `version` is constrained by MIGRATION_FILE, so interpolation is safe.
    await target.execScript(`${sql}
insert into schema_migrations (version) values ('${version}');`);
    await recordInSupabaseHistory(target, file);
    applied.add(version);
    ran.push(version);
  }
  return ran;
}

export async function pendingMigrations(selectedVersions?: readonly string[]): Promise<string[]> {
  const files = selectMigrationFiles(selectedVersions);
  const d = await driver();
  const applied = await appliedVersions(d);
  return files
    .map((f) => f.replace(/\.sql$/, ""))
    .filter((v) => !applied.has(v));
}
