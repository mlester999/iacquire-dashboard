import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STARTER_TUTORIALS, validateTutorialDefinition } from "@/lib/aqi/tutorials";
import { parseTutorialDefinition } from "@/server/aqi/tutorials";
import { withSystem } from "@/server/db";
import { createUser } from "./support/fixtures";

const UP = readFileSync("supabase/migrations/0131_ai_growth_partner_aqi_guidance.sql", "utf8");
const DOWN = readFileSync("supabase/rollbacks/0131_ai_growth_partner_aqi_guidance.down.sql", "utf8");
const SLUGS = ["getting-started", "navigate-dashboard", "view-ai-employees"] as const;
const MIGRATION_NOTE = "AI Growth Partner guidance migration 0131";
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

async function run(sql: string, db: { query: (query: string, params?: unknown[]) => Promise<unknown> }) {
  for (const statement of statements(sql)) await db.query(statement);
}

describe("migration 0131 AI Growth Partner AQi guidance", () => {
  it("publishes valid version-2 guidance that matches the source definitions", async () => {
    const rows = await withSystem(async (db) => (await db.query<{
      slug: string;
      title: string;
      category: string;
      route_prefix: string;
      status: string;
      tutorial_version: number;
      version_status: string;
      notes: string;
      definition: unknown;
      published_version_id: string;
      version_id: string;
    }>(
      `select t.slug, t.title, t.category, t.route_prefix, t.status,
              v.version as tutorial_version, v.status as version_status, v.notes, v.definition,
              t.published_version_id, v.id as version_id
         from aqi_tutorials t join aqi_tutorial_versions v on v.id = t.published_version_id
        where t.slug = any($1::text[]) order by t.priority`,
      [SLUGS],
    )).rows);

    expect(rows.map((row) => row.slug).sort()).toEqual([...SLUGS].sort());
    for (const row of rows) {
      expect(row).toMatchObject({
        status: "published",
        tutorial_version: 2,
        version_status: "published",
        notes: MIGRATION_NOTE,
      });
      expect(row.published_version_id).toBe(row.version_id);
      const definition = parseTutorialDefinition(row.definition);
      const source = STARTER_TUTORIALS.find((tutorial) => tutorial.slug === row.slug);
      expect(source, row.slug).toBeDefined();
      expect(definition, row.slug).toEqual(source!.definition);
      expect(validateTutorialDefinition(definition).errors, row.slug).toEqual([]);
      expect(row.title).toBe(definition.title);
      expect(row.category).toBe(definition.category);
      expect(row.route_prefix).toBe(definition.routePrefix);
    }
  });

  it("retains the original seed version and does not rewrite other published guidance", async () => {
    const rows = await withSystem(async (db) => (await db.query<{ slug: string; version: number; status: string; notes: string | null }>(
      `select t.slug, v.version, v.status, v.notes
         from aqi_tutorials t join aqi_tutorial_versions v on v.tutorial_id = t.id
        where t.slug = any($1::text[]) order by t.slug, v.version`,
      [SLUGS],
    )).rows);
    expect(rows).toHaveLength(SLUGS.length * 2);
    for (const slug of SLUGS) {
      expect(rows.filter((row) => row.slug === slug)).toEqual([
        { slug, version: 1, status: "archived", notes: "Starter library" },
        { slug, version: 2, status: "published", notes: MIGRATION_NOTE },
      ]);
    }
    const untouched = await withSystem(async (db) => (await db.query<{ version: number; notes: string }>(
      `select v.version, v.notes from aqi_tutorials t
         join aqi_tutorial_versions v on v.id = t.published_version_id
        where t.slug = 'create-contact'`,
    )).rows[0]);
    expect(untouched).toEqual({ version: 2, notes: "Completion requires CRM confirmation" });
  });

  it("applies, rolls back and reapplies inside a disposable transaction", async () => {
    let report: Record<string, unknown> = {};
    await expect(withSystem(async (db) => {
      // Any evidence made by another test is removed only in this transaction and restored when
      // the sentinel rolls the probe back.
      await db.query(
        `delete from aqi_tutorial_events e using aqi_tutorials t
          where e.tutorial_id = t.id and t.slug = any($1::text[]) and e.tutorial_version = 2`,
        [SLUGS],
      );
      await db.query(
        `delete from aqi_tutorial_progress p using aqi_tutorials t
          where p.tutorial_id = t.id and t.slug = any($1::text[]) and p.tutorial_version = 2`,
        [SLUGS],
      );
      await run(DOWN, db);
      const down = await db.query<{ n: number }>(
        `select count(*)::int as n from aqi_tutorial_versions v join aqi_tutorials t on t.id = v.tutorial_id
          where t.slug = any($1::text[]) and v.version = 2 and v.notes = $2`,
        [SLUGS, MIGRATION_NOTE],
      );
      const restored = await db.query<{ n: number }>(
        `select count(*)::int as n from aqi_tutorials t join aqi_tutorial_versions v on v.id = t.published_version_id
          where t.slug = any($1::text[]) and v.version = 1 and v.status = 'published'`,
        [SLUGS],
      );
      await run(UP, db);
      const reapplied = await db.query<{ n: number }>(
        `select count(*)::int as n from aqi_tutorials t join aqi_tutorial_versions v on v.id = t.published_version_id
          where t.slug = any($1::text[]) and v.version = 2 and v.notes = $2`,
        [SLUGS, MIGRATION_NOTE],
      );
      report = { down: down.rows[0].n, restored: restored.rows[0].n, reapplied: reapplied.rows[0].n };
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
    expect(report).toEqual({ down: 0, restored: 3, reapplied: 3 });
    const stillApplied = await withSystem(async (db) => (await db.query<{ n: number }>(
      `select count(*)::int as n from aqi_tutorials t join aqi_tutorial_versions v on v.id = t.published_version_id
        where t.slug = any($1::text[]) and v.version = 2 and v.notes = $2`,
      [SLUGS, MIGRATION_NOTE],
    )).rows[0].n);
    expect(stillApplied).toBe(3);
  });

  it("leaves a customized version-1 definition untouched", async () => {
    let report: Record<string, unknown> = {};
    await expect(withSystem(async (db) => {
      await db.query(
        `delete from aqi_tutorial_events e using aqi_tutorials t
          where e.tutorial_id = t.id and t.slug = any($1::text[]) and e.tutorial_version = 2`,
        [SLUGS],
      );
      await db.query(
        `delete from aqi_tutorial_progress p using aqi_tutorials t
          where p.tutorial_id = t.id and t.slug = any($1::text[]) and p.tutorial_version = 2`,
        [SLUGS],
      );
      await run(DOWN, db);
      await db.query(
        `update aqi_tutorial_versions v
            set definition = jsonb_set(v.definition, '{description}', '"Workspace-specific welcome"'::jsonb)
           from aqi_tutorials t
          where v.tutorial_id = t.id and t.slug = 'getting-started' and v.version = 1`,
      );
      await run(UP, db);
      report = {
        published: (await db.query<{ version: number; description: string }>(
          `select v.version, v.definition->>'description' as description
             from aqi_tutorials t join aqi_tutorial_versions v on v.id = t.published_version_id
            where t.slug = 'getting-started'`,
        )).rows[0],
        migratedVersions: (await db.query<{ n: number }>(
          `select count(*)::int as n from aqi_tutorial_versions v join aqi_tutorials t on t.id = v.tutorial_id
            where t.slug = 'getting-started' and v.notes = $1`,
          [MIGRATION_NOTE],
        )).rows[0].n,
      };
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
    expect(report).toEqual({
      published: { version: 1, description: "Workspace-specific welcome" },
      migratedVersions: 0,
    });
  });

  it("refuses rollback when users have progress on the published guidance", async () => {
    const user = await createUser();
    await expect(withSystem(async (db) => {
      const tutorial = (await db.query<{ id: string }>(
        "select id from aqi_tutorials where slug = 'getting-started'",
      )).rows[0];
      await db.query(
        `insert into aqi_tutorial_progress (user_id, tutorial_id, tutorial_version, status)
         values ($1, $2, 2, 'paused')`,
        [user.id, tutorial.id],
      );
      await run(DOWN, db);
    })).rejects.toThrow(/Refusing to roll back 0131: AQi progress or events exist/);
  });

  it("documents customized-content protection and an evidence guard in the migration pair", () => {
    expect(UP).toMatch(/notes is distinct from 'Starter library'/i);
    expect(UP).toMatch(/legacy_description/i);
    expect(UP).toMatch(/version = 2[\s\S]*?continue;/i);
    expect(DOWN).toMatch(/aqi_tutorial_progress/i);
    expect(DOWN).toMatch(/aqi_tutorial_events/i);
    expect(DOWN).toMatch(/Refusing to roll back 0131/i);
  });
});
