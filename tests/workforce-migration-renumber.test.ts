import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runMigrations, type Queryable } from "@/server/db";

const RENAMED = [
  "0077_ai_work_jobs",
  "0078_ai_work_schedules",
  "0079_ai_work_triggers",
  "0080_proactive_ai_employees",
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
  it("applies the four renamed migrations without replaying the existing 0072 automation migration", async () => {
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
    } finally {
      await db.close();
    }
  }, 120000);
}, 130000);
