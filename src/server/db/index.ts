import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { env } from "@/server/env";
import { SupabaseConfigError, supabaseConfigStatus } from "@/server/supabase/config";
import { planPostgresTls } from "@/server/db/tls";
import { OperationFailure } from "@/server/diagnostics";

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
  if (dataDir) fs.mkdirSync(dataDir, { recursive: true });
  const db = new PGlite({ dataDir, extensions: { citext } });
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
  // A missing or unreadable CA file is a configuration error, never a silent downgrade.
  let caPem: string | undefined;
  try {
    caPem = caFile ? fs.readFileSync(path.resolve(/* turbopackIgnore: true */ process.cwd(), caFile), "utf8") : e.DATABASE_SSL_CA;
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
  const pool = new Pool({ connectionString: tls.connectionString, ssl: tls.ssl, max: 10, idleTimeoutMillis: 30000 });
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
    try {
      return await d.transaction(fn);
    } finally {
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
 * Runs queries as the signed-in user under row-level security. Tenant isolation is enforced
 * by PostgreSQL policies in addition to application checks.
 */
export async function withUser<T>(userId: string, fn: (db: Queryable) => Promise<T>): Promise<T> {
  if (!UUID_RE.test(userId)) throw new Error("withUser requires a valid user id");
  const d = await driver();
  return runTransaction(
    "withUser",
    async (tx) => {
      await tx.query("select set_config('app.user_id', $1, true)", [userId]);
      await tx.query("set local role iaq_app_user");
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

export async function runMigrations(d?: Driver): Promise<string[]> {
  const target = d ?? (await driver());
  const applied = await appliedVersions(target);
  if (target.kind === "pglite" && !applied.has(COMPAT_VERSION)) {
    const compat = fs.readFileSync(localCompatFile(), "utf8");
    await target.execScript(`${compat}
insert into schema_migrations (version) values ('${COMPAT_VERSION}');`);
  }
  const ran: string[] = [];
  for (const file of listMigrationFiles()) {
    const version = file.replace(/\.sql$/, "");
    if (applied.has(version)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir(), file), "utf8");
    // `version` is constrained by MIGRATION_FILE, so interpolation is safe.
    await target.execScript(`${sql}
insert into schema_migrations (version) values ('${version}');`);
    await recordInSupabaseHistory(target, file);
    ran.push(version);
  }
  return ran;
}

export async function pendingMigrations(): Promise<string[]> {
  const d = await driver();
  const applied = await appliedVersions(d);
  return listMigrationFiles()
    .map((f) => f.replace(/\.sql$/, ""))
    .filter((v) => !applied.has(v));
}
