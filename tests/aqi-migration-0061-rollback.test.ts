import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { addMember, createOrg, createUser } from "./support/fixtures";

const DOWN = readFileSync("supabase/rollbacks/0061_aqi_phase3_guidance.down.sql", "utf8");
class Done extends Error {}

function statements(sql: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let inside = false;
  for (const raw of sql.split("\n")) {
    const line = raw.replace("\r", "");
    if (!inside && (line.trim() === "" || line.trim().startsWith("--"))) continue;
    current.push(line);
    if (line.split("$$").length % 2 === 0) inside = !inside;
    if (!inside && line.trimEnd().endsWith(";")) {
      out.push(current.join("\n"));
      current = [];
    }
  }
  return out;
}

async function runDown(db: { query: (sql: string, params?: unknown[]) => Promise<unknown> }) {
  for (const statement of statements(DOWN)) await db.query(statement);
}

describe("migration 0061 rollback", () => {
  it("drops the Phase 3 objects inside a transaction when there is no user evidence", async () => {
    let report: Record<string, unknown> = {};
    await expect(
      withSystem(async (db) => {
        await runDown(db);
        report = {
          tutorials: (await db.query("select to_regclass('public.aqi_tutorials')::text as t")).rows[0],
          progress: (await db.query("select to_regclass('public.aqi_tutorial_progress')::text as t")).rows[0],
          documents: (await db.query("select to_regclass('public.aqi_knowledge_documents')::text as t")).rows[0],
          metadata: (await db.query<{ column_name: string }>("select column_name from information_schema.columns where table_name = 'aqi_usage_events' and column_name in ('metadata','intent')")).rows.length,
        };
        throw new Done();
      }),
    ).rejects.toBeInstanceOf(Done);
    expect(report).toEqual({ tutorials: { t: null }, progress: { t: null }, documents: { t: null }, metadata: 0 });
    // The probe transaction rolled back, so the real local schema is intact for other tests.
    const stillThere = await withSystem(async (db) => (await db.query("select to_regclass('public.aqi_tutorials')::text as t")).rows[0]);
    expect(stillThere).toEqual({ t: "aqi_tutorials" });
  });

  it("refuses to destroy tutorial progress or uploaded documents", async () => {
    const org = await createOrg({ name: "Rollback Evidence Co" });
    const owner = await createUser();
    await addMember(org.id, owner.id, "owner");
    const tutorial = await withSystem(async (db) => (await db.query<{ id: string }>("select id from aqi_tutorials where slug = 'getting-started'")).rows[0]);
    await withSystem((db) => db.query(
      "insert into aqi_tutorial_progress (org_id, user_id, tutorial_id, tutorial_version, status) values ($1, $2, $3, 1, 'paused')",
      [org.id, owner.id, tutorial.id],
    ));
    await expect(withSystem((db) => runDown(db))).rejects.toThrow(/Refusing to roll back 0061/);
  });
});
