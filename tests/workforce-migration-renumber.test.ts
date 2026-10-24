import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runMigrations, type Queryable } from "@/server/db";

const RENAMED = [
  "0077_ai_work_jobs",
  "0078_ai_work_schedules",
  "0079_ai_work_triggers",
  "0080_proactive_ai_employees",
  "0081_ai_work_job_rls_hardening",
];

const PROVISIONER_DEPENDENTS = [
  "0082_client_employee_provisioning",
  "0083_unified_inbox",
  "0085_missed_call_recovery",
  "0086_lead_scoring",
];

function baseVersions(): string[] {
  return fs
    .readdirSync(path.resolve(process.cwd(), "supabase", "migrations"))
    .filter((file) => /^\d{4}_.+\.sql$/.test(file))
    .map((file) => file.replace(/\.sql$/, ""))
    .filter((version) => version < "0072")
    .sort();
}

describe("AI workforce migration renumbering", () => {
  it("applies the workforce migrations without replaying the existing 0072 automation migration", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { citext } = await import("@electric-sql/pglite/contrib/citext");
    const { pg_trgm } = await import("@electric-sql/pglite/contrib/pg_trgm");
    const { btree_gist } = await import("@electric-sql/pglite/contrib/btree_gist");
    const db = new PGlite({ extensions: { citext, pg_trgm, btree_gist } });
    await db.waitReady;
    const wrap = (q: typeof db): Queryable => ({
      async query<T>(sql: string, params?: unknown[]) {
        const res = await q.query<T>(sql, params);
        return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
      },
    });
    const driver = {
      kind: "pglite" as const,
      query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => wrap(db).query<T>(sql, params),
      exec: async (sql: string) => { await db.exec(sql); },
      execScript: async (sql: string) => { await db.transaction(async (tx) => { await tx.exec(sql); }); },
      transaction: <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction((tx) => fn(wrap(tx as unknown as typeof db))),
      close: () => db.close(),
    };

    try {
      const base = baseVersions();
      expect(base.at(-1)).toBe("0071_automation_studio_plan_lookup");
      const first = await runMigrations(driver as never, base);
      expect(first).toEqual(base);

      await driver.query("insert into schema_migrations (version) values ('0072_automation_connections') on conflict (version) do nothing");

      const applied = await runMigrations(driver as never, RENAMED);
      expect(applied).toEqual(RENAMED);
      const ledger = await driver.query<{ version: string }>("select version from schema_migrations order by version");
      const versions = ledger.rows.map((row) => row.version);
      expect(versions).toEqual(expect.arrayContaining(["0072_automation_connections", ...RENAMED]));
      expect(versions).not.toContain("0072_ai_work_jobs");

      // Production can have 0085/0086 recorded while 0084 is absent. Prove the
      // missing, independent provisioner extension can be applied afterward.
      expect(await runMigrations(driver as never, PROVISIONER_DEPENDENTS)).toEqual(PROVISIONER_DEPENDENTS);
      expect(await runMigrations(driver as never, ["0084_restricted_hermes_provisioner"])).toEqual([
        "0084_restricted_hermes_provisioner",
      ]);
      const provisionerColumns = await driver.query<{ table_name: string; column_name: string }>(
        "select table_name, column_name from information_schema.columns where table_schema = 'public' and ((table_name = 'hermes_gateways' and column_name = 'provisioner_isolation_verified_at') or (table_name = 'agent_instances' and column_name = 'hermes_profile_config_version_id') or (table_name = 'agent_provisioning_jobs' and column_name in ('config_version_id','source_job_id','manifest_soul_sha256','manifest_policy_config_sha256','manifest_challenge_sha256'))) order by table_name, column_name",
      );
      expect(provisionerColumns.rows).toHaveLength(7);
    } finally {
      await db.close();
    }
  }, 120000);
}, 130000);
