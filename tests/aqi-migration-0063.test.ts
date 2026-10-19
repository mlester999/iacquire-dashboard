import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { parseTutorialDefinition } from "@/server/aqi/tutorials";
import { validateTutorialDefinition } from "@/lib/aqi/tutorials";

const DOWN = readFileSync("supabase/rollbacks/0063_aqi_phase3_hardening.down.sql", "utf8");
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

describe("migration 0063 AQi Phase 3 hardening", () => {
  it("adds management-only knowledge history", async () => {
    const table = await withSystem(async (db) => (await db.query<{ relrowsecurity: boolean }>(
      "select relrowsecurity from pg_class where relnamespace='public'::regnamespace and relname='aqi_knowledge_versions'",
    )).rows[0]);
    expect(table?.relrowsecurity).toBe(true);
    const grant = await withSystem(async (db) => (await db.query<{ allowed: boolean }>(
      "select has_table_privilege('iaq_app_user','aqi_knowledge_versions','select') as allowed",
    )).rows[0].allowed);
    expect(grant).toBe(false);
    const columns = await withSystem(async (db) => (await db.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_schema='public' and table_name='aqi_knowledge_versions' order by ordinal_position",
    )).rows.map((row) => row.column_name));
    expect(columns).toEqual(expect.arrayContaining(["knowledge_entry_id", "version", "title", "category", "body", "status", "change_note", "created_by"]));
  });

  it("publishes the seeded contact walkthrough with authoritative completion", async () => {
    const rows = await withSystem(async (db) => (await db.query<{ version: number; status: string; definition: unknown; published_version_id: string | null; id: string }>(
      `select v.version, v.status, v.definition, t.published_version_id, v.id
         from aqi_tutorials t join aqi_tutorial_versions v on v.tutorial_id = t.id
        where t.slug = 'create-contact' order by v.version`,
    )).rows);
    expect(rows.map((row) => [row.version, row.status])).toEqual([[1, "archived"], [2, "published"]]);
    expect(rows[1].published_version_id).toBe(rows[1].id);
    const definition = parseTutorialDefinition(rows[1].definition);
    expect(definition.completion).toEqual({ kind: "contact_created", pattern: "/crm/contacts/:id" });
    expect(validateTutorialDefinition(definition).errors).toEqual([]);
  });

  it("rolls back the seeded completion and drops history inside a transaction", async () => {
    let report: Record<string, unknown> = {};
    await expect(
      withSystem(async (db) => {
        for (const statement of statements(DOWN)) await db.query(statement);
        report = {
          history: (await db.query("select to_regclass('public.aqi_knowledge_versions')::text as t")).rows[0],
          versions: (await db.query<{ version: number; status: string }>(
            "select v.version, v.status from aqi_tutorial_versions v join aqi_tutorials t on t.id=v.tutorial_id where t.slug='create-contact' order by v.version",
          )).rows,
        };
        throw new Done();
      }),
    ).rejects.toBeInstanceOf(Done);
    expect(report).toMatchObject({ history: { t: null } });
    expect(report.versions).toEqual([{ version: 1, status: "published" }, { version: 2, status: "archived" }]);
    // The transaction rolled back, so the migrated schema is still present.
    const still = await withSystem(async (db) => (await db.query("select to_regclass('public.aqi_knowledge_versions')::text as t")).rows[0]);
    expect(still).toEqual({ t: "aqi_knowledge_versions" });
  });
});
