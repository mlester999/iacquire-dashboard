// Migrations 0069 to 0072 in an isolated database: each rolls back to exactly the schema before it and applies again to exactly the schema after
// it, the four together round-trip without leaving or losing anything (a catalog comparison of the whole public schema, so drift anywhere shows),
// and 0072's rollback refuses while a connection or a call record exists. Every run happens in a transaction that is always rolled back, so
// the shared test database is never changed.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { crmOrg } from "./support/crm";

const read = (kind: "migrations" | "rollbacks", name: string) => readFileSync(`supabase/${kind}/${name}`, "utf8");
const FILES = [
  ["0069", "0069_automation_studio_foundation"],
  ["0070", "0070_automation_studio_conversations"],
  ["0071", "0071_automation_studio_plan_lookup"],
  ["0072", "0072_automation_connections"],
] as const;
const up = (n: string) => read("migrations", `${FILES.find((f) => f[0] === n)![1]}.sql`);
const down = (n: string) => read("rollbacks", `${FILES.find((f) => f[0] === n)![1]}.down.sql`);
class Done extends Error {}

/** Splits a script into statements, keeping `$$ ... $$` bodies whole (the test driver runs one statement per call). */
function statements(sql: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let inside = false;
  for (const raw of sql.split("\n")) {
    const line = raw.replace("\r", "");
    if (!inside && (line.trim() === "" || line.trim().startsWith("--"))) continue;
    cur.push(line);
    if (line.split("$$").length % 2 === 0) inside = !inside;
    if (!inside && line.trimEnd().endsWith(";")) {
      out.push(cur.join("\n"));
      cur = [];
    }
  }
  return out;
}
type Tx = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };
const run = async (db: Tx, sql: string) => {
  for (const stmt of statements(sql)) await db.query(stmt);
};

/** Everything about the public schema (and the helper functions in app) that a migration could change. */
async function catalog(db: Tx) {
  const q = async (sql: string) => (await db.query(sql)).rows;
  return {
    columns: await q("select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' order by 1, 2"),
    indexes: await q("select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' order by 2"),
    constraints: await q("select conrelid::regclass::text as t, conname, pg_get_constraintdef(oid) as d from pg_constraint where connamespace = 'public'::regnamespace order by 1, 2"),
    policies: await q("select tablename, policyname, cmd, roles::text as roles, qual, with_check from pg_policies where schemaname = 'public' order by 1, 2"),
    triggers: await q("select tgrelid::regclass::text as t, tgname, pg_get_triggerdef(oid) as d from pg_trigger where not tgisinternal order by 1, 2"),
    functions: await q("select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as args, md5(p.prosrc) as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('app', 'public') order by 1, 2, 3"),
    tableGrants: await q("select table_name, grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' and grantee in ('iaq_app_user', 'anon', 'authenticated') order by 1, 2, 3"),
    columnGrants: await q("select table_name, column_name, grantee, privilege_type from information_schema.column_privileges where table_schema = 'public' and grantee = 'iaq_app_user' order by 1, 2, 3, 4"),
    rls: await q("select relname, relrowsecurity, relforcerowsecurity from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' order by 1"),
  };
}
type Catalog = Awaited<ReturnType<typeof catalog>>;

/** The first difference between two catalogs, in words ("columns: …"), or null when they are the same. */
function firstDifference(a: Catalog, b: Catalog): string | null {
  for (const key of Object.keys(a) as Array<keyof Catalog>) {
    const left = a[key].map((r) => JSON.stringify(r));
    const right = new Set(b[key].map((r) => JSON.stringify(r)));
    const missing = left.find((r) => !right.has(r));
    if (missing) return `${key}: only in the first: ${missing}`;
    const leftSet = new Set(left);
    const extra = [...right].find((r) => !leftSet.has(r));
    if (extra) return `${key}: only in the second: ${extra}`;
  }
  return null;
}

const studioObjects = (c: Catalog) => ({
  tables: c.rls.map((r) => String(r.relname)).filter((n) => /^automation_(studio|connection)/.test(n)),
  functions: c.functions.map((f) => `${f.nspname}.${f.proname}`).filter((n) => /automation_studio/.test(n)),
  workflowColumns: c.columns.filter((r) => r.table_name === "crm_workflows" && ["origin", "entitlement_paused_at"].includes(String(r.column_name))).length,
});

describe("migrations 0069 to 0072 together", () => {
  it("roll back newest first to a schema without a trace of Automation Studio, and apply again to exactly the schema they started from", async () => {
    let start!: Catalog;
    let base!: Catalog;
    let again!: Catalog;
    await expect(
      withSystem(async (db) => {
        start = await catalog(db);
        for (const [n] of [...FILES].reverse()) await run(db, down(n));
        base = await catalog(db);
        for (const [n] of FILES) await run(db, up(n));
        again = await catalog(db);
        throw new Done();
      }),
    ).rejects.toBeInstanceOf(Done);

    expect(studioObjects(start)).toMatchObject({ tables: ["automation_connection_calls", "automation_connections", "automation_studio_limits", "automation_studio_messages", "automation_studio_changes", "automation_studio_usage"].sort(), workflowColumns: 2 });
    expect(studioObjects(base)).toEqual({ tables: [], functions: [], workflowColumns: 0 });
    expect(firstDifference(start, base)).not.toBeNull(); // the rollback really changed something
    // No drift: the same schema, grants, policies, triggers and functions as before.
    expect(firstDifference(start, again)).toBeNull();
    expect(firstDifference(again, start)).toBeNull();
    // And the real database was not changed by any of it.
    const still = await withSystem(async (db) => (await db.query("select to_regclass('public.automation_connections') is not null as ok")).rows[0].ok);
    expect(still).toBe(true);
  });

  it("each rolls back on its own to exactly the schema before it, in the order they ship", async () => {
    // Applying one migration to the schema that precedes it gives the schema that follows it: checked for each link of the chain.
    const states: Catalog[] = [];
    await expect(
      withSystem(async (db) => {
        states.push(await catalog(db)); // after 0072
        for (const [n] of [...FILES].reverse()) {
          await run(db, down(n));
          states.push(await catalog(db)); // before n
        }
        // Now at the schema before 0069. Walk forward and compare with what each state was.
        let i = states.length - 2;
        for (const [n] of FILES) {
          await run(db, up(n));
          const now = await catalog(db);
          expect(firstDifference(now, states[i]), `after ${n}`).toBeNull();
          expect(firstDifference(states[i], now), `after ${n}`).toBeNull();
          i -= 1;
        }
        throw new Done();
      }),
    ).rejects.toBeInstanceOf(Done);
    expect(states).toHaveLength(5);
  });
});

describe("migration 0072 (connections)", () => {
  const shape = async (db: Tx) => {
    const q = async (sql: string) => (await db.query(sql)).rows;
    return {
      tables: (await q("select table_name from information_schema.tables where table_name in ('automation_connections', 'automation_connection_calls') order by 1")).map((r) => r.table_name),
      policies: (await q("select policyname from pg_policies where tablename in ('automation_connections', 'automation_connection_calls') order by 1")).map((r) => r.policyname),
    };
  };

  it("applies, rolls back to nothing, and applies again to the same shape", async () => {
    const seen: Array<Awaited<ReturnType<typeof shape>>> = [];
    await expect(
      withSystem(async (db) => {
        seen.push(await shape(db));
        await run(db, down("0072"));
        seen.push(await shape(db));
        await run(db, up("0072"));
        seen.push(await shape(db));
        throw new Done();
      }),
    ).rejects.toBeInstanceOf(Done);
    expect(seen[0].tables).toEqual(["automation_connection_calls", "automation_connections"]);
    expect(seen[0].policies.length).toBeGreaterThanOrEqual(2);
    expect(seen[1]).toMatchObject({ tables: [], policies: [] });
    expect(seen[2]).toEqual(seen[0]);
  });

  it("keeps the encrypted secret out of the application role's reach, and the write paths closed to it", async () => {
    await withSystem(async (db) => {
      const q = async (sql: string) => (await db.query(sql)).rows;
      expect((await q("select has_column_privilege('iaq_app_user', 'public.automation_connections', 'secret_ciphertext', 'select') as ok"))[0].ok).toBe(false);
      expect((await q("select has_column_privilege('iaq_app_user', 'public.automation_connections', 'name', 'select') as ok"))[0].ok).toBe(true);
      for (const priv of ["insert", "update", "delete"]) {
        expect((await q(`select has_table_privilege('iaq_app_user', 'public.automation_connections', '${priv}') as ok`))[0].ok, `connections ${priv}`).toBe(false);
        expect((await q(`select has_table_privilege('iaq_app_user', 'public.automation_connection_calls', '${priv}') as ok`))[0].ok, `calls ${priv}`).toBe(false);
      }
      expect((await q("select has_table_privilege('anon', 'public.automation_connections', 'select') as ok"))[0].ok).toBe(false);
      expect((await q("select relrowsecurity as on from pg_class where oid = 'public.automation_connections'::regclass"))[0].on).toBe(true);
      expect((await q("select relrowsecurity as on from pg_class where oid = 'public.automation_connection_calls'::regclass"))[0].on).toBe(true);
    });
  });

  it("refuses to roll back while a connection exists, and again while only a call record exists, and says why", async () => {
    const o = await crmOrg();
    await expect(
      withSystem(async (db) => {
        await db.query("insert into automation_connections (org_id, kind, name, settings) values ($1, 'http', 'Keep me', '{}'::jsonb)", [o.org.id]);
        await db.query("savepoint refuse");
        await expect(run(db, down("0072"))).rejects.toThrow(/connection|call/i);
        await db.query("rollback to savepoint refuse");
        throw new Done();
      }),
    ).rejects.toBeInstanceOf(Done);

    await expect(
      withSystem(async (db) => {
        const c = (await db.query<{ id: string }>("insert into automation_connections (org_id, kind, name, settings) values ($1, 'http', 'Call log', '{}'::jsonb) returning id", [o.org.id])).rows[0];
        await db.query("insert into automation_connection_calls (org_id, connection_id, origin, method, host, path, outcome) values ($1, $2, 'test', 'GET', 'api.example.com', '/', 'sent')", [o.org.id, c.id]);
        // Even a revoked connection (its secret erased) and its call record are a record the rollback won't throw away.
        await db.query("update automation_connections set status = 'revoked', revoked_at = now() where id = $1", [c.id]);
        await db.query("savepoint refuse");
        await expect(run(db, down("0072"))).rejects.toThrow(/connection|call/i);
        await db.query("rollback to savepoint refuse");
        throw new Done();
      }),
    ).rejects.toBeInstanceOf(Done);

    // With nothing in them it rolls back cleanly, and the rows above were never committed.
    await expect(withSystem(async (db) => { await run(db, down("0072")); throw new Done(); })).rejects.toBeInstanceOf(Done);
    const left = await withSystem(async (db) => (await db.query("select 1 from automation_connections where org_id = $1", [o.org.id])).rows.length);
    expect(left).toBe(0);
  });

  it("constrains what a row may hold: kinds, statuses, one live connection per name, a bounded call log", async () => {
    const o = await crmOrg();
    await expect(
      withSystem(async (db) => {
        const insert = (kind: string, name: string, status = "unverified") => db.query("insert into automation_connections (org_id, kind, name, settings, status) values ($1, $2, $3, '{}'::jsonb, $4)", [o.org.id, kind, name, status]);
        await insert("http", "One");
        await db.query("savepoint s1");
        await expect(insert("ftp", "Bad kind")).rejects.toThrow();
        await db.query("rollback to savepoint s1");
        await expect(insert("http", "Bad status", "trusted")).rejects.toThrow();
        await db.query("rollback to savepoint s1");
        await expect(insert("http", "one")).rejects.toThrow(); // the same name, whatever the case, while the first is live
        await db.query("rollback to savepoint s1");
        // A revoked connection frees its name.
        await db.query("update automation_connections set status = 'revoked', revoked_at = now(), secret_ciphertext = null where org_id = $1 and name = 'One'", [o.org.id]);
        await insert("http", "One");
        throw new Done();
      }),
    ).rejects.toBeInstanceOf(Done);
  });
});
