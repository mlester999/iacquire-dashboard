import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STARTER_TUTORIALS, validateTutorialDefinition } from "@/lib/aqi/tutorials";
import { parseTutorialDefinition } from "@/server/aqi/tutorials";
import { withSystem } from "@/server/db";
import { createUser } from "./support/fixtures";

const UP_0131 = readFileSync("supabase/migrations/0131_ai_growth_partner_aqi_guidance.sql", "utf8");
const DOWN_0131 = readFileSync("supabase/rollbacks/0131_ai_growth_partner_aqi_guidance.down.sql", "utf8");
const UP_0136 = readFileSync("supabase/migrations/0136_ai_growth_partner_conversation_first_aqi_guidance.sql", "utf8");
const DOWN_0136 = readFileSync("supabase/rollbacks/0136_ai_growth_partner_conversation_first_aqi_guidance.down.sql", "utf8");
const SLUGS = ["getting-started", "navigate-dashboard", "view-ai-employees"] as const;
const REFRESHED_SLUGS = ["getting-started", "view-ai-employees"] as const;
const MIGRATION_0131_NOTE = "AI Growth Partner guidance migration 0131";
const MIGRATION_0136_NOTE = "AI Growth Partner conversation-first guidance migration 0136";
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

describe("AI Growth Partner AQi guidance migrations", () => {
  it("publishes current versioned guidance that matches the source definitions", async () => {
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
      const refreshed = (REFRESHED_SLUGS as readonly string[]).includes(row.slug);
      const definition = parseTutorialDefinition(row.definition);
      const source = STARTER_TUTORIALS.find((tutorial) => tutorial.slug === row.slug);
      expect(source, row.slug).toBeDefined();
      expect(row).toMatchObject({
        status: "published",
        tutorial_version: refreshed ? 3 : 2,
        version_status: "published",
        notes: refreshed ? MIGRATION_0136_NOTE : MIGRATION_0131_NOTE,
      });
      expect(row.published_version_id).toBe(row.version_id);
      expect(definition, row.slug).toEqual(source!.definition);
      expect(validateTutorialDefinition(definition).errors, row.slug).toEqual([]);
      expect(row.title).toBe(definition.title);
      expect(row.category).toBe(definition.category);
      expect(row.route_prefix).toBe(definition.routePrefix);
    }
  });

  it("retains each earlier guidance version and leaves unrelated published guidance unchanged", async () => {
    const rows = await withSystem(async (db) => (await db.query<{ slug: string; version: number; status: string; notes: string | null }>(
      `select t.slug, v.version, v.status, v.notes
         from aqi_tutorials t join aqi_tutorial_versions v on v.tutorial_id = t.id
        where t.slug = any($1::text[]) order by t.slug, v.version`,
      [SLUGS],
    )).rows);
    expect(rows).toHaveLength(8);
    for (const slug of SLUGS) {
      const history = rows.filter((row) => row.slug === slug);
      if ((REFRESHED_SLUGS as readonly string[]).includes(slug)) {
        expect(history).toEqual([
          { slug, version: 1, status: "archived", notes: "Starter library" },
          { slug, version: 2, status: "archived", notes: MIGRATION_0131_NOTE },
          { slug, version: 3, status: "published", notes: MIGRATION_0136_NOTE },
        ]);
      } else {
        expect(history).toEqual([
          { slug, version: 1, status: "archived", notes: "Starter library" },
          { slug, version: 2, status: "published", notes: MIGRATION_0131_NOTE },
        ]);
      }
    }
    const untouched = await withSystem(async (db) => (await db.query<{ version: number; notes: string }>(
      `select v.version, v.notes from aqi_tutorials t
         join aqi_tutorial_versions v on v.id = t.published_version_id
        where t.slug = 'create-contact'`,
    )).rows[0]);
    expect(untouched).toEqual({ version: 2, notes: "Completion requires CRM confirmation" });
  });

  it("applies, rolls back and reapplies both guidance migrations inside a disposable transaction", async () => {
    let report: Record<string, unknown> = {};
    await expect(withSystem(async (db) => {
      // Any evidence made by another test is removed only in this transaction and restored when
      // the sentinel rolls the probe back.
      for (const table of ["aqi_tutorial_events", "aqi_tutorial_progress"]) {
        await db.query(
          `delete from ${table} e using aqi_tutorials t
            where e.tutorial_id = t.id and t.slug = any($1::text[]) and e.tutorial_version = any($2::int[])`,
          [SLUGS, [2, 3]],
        );
      }

      await run(DOWN_0136, db);
      const version2Restored = await db.query<{ n: number }>(
        `select count(*)::int as n from aqi_tutorials t join aqi_tutorial_versions v on v.id = t.published_version_id
          where t.slug = any($1::text[]) and v.version = 2 and v.notes = $2`,
        [SLUGS, MIGRATION_0131_NOTE],
      );
      await run(DOWN_0131, db);
      const version1Restored = await db.query<{ n: number }>(
        `select count(*)::int as n from aqi_tutorials t join aqi_tutorial_versions v on v.id = t.published_version_id
          where t.slug = any($1::text[]) and v.version = 1 and v.status = 'published'`,
        [SLUGS],
      );
      await run(UP_0131, db);
      await run(UP_0136, db);
      const currentReapplied = await db.query<{ n: number }>(
        `select count(*)::int as n from aqi_tutorials t join aqi_tutorial_versions v on v.id = t.published_version_id
          where (t.slug = any($1::text[]) and v.version = 3 and v.notes = $2)
             or (t.slug = 'navigate-dashboard' and v.version = 2 and v.notes = $3)`,
        [REFRESHED_SLUGS, MIGRATION_0136_NOTE, MIGRATION_0131_NOTE],
      );
      report = {
        version2Restored: version2Restored.rows[0].n,
        version1Restored: version1Restored.rows[0].n,
        currentReapplied: currentReapplied.rows[0].n,
      };
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
    expect(report).toEqual({ version2Restored: 3, version1Restored: 3, currentReapplied: 3 });
    const stillApplied = await withSystem(async (db) => (await db.query<{ n: number }>(
      `select count(*)::int as n from aqi_tutorials t join aqi_tutorial_versions v on v.id = t.published_version_id
        where (t.slug = any($1::text[]) and v.version = 3 and v.notes = $2)
           or (t.slug = 'navigate-dashboard' and v.version = 2 and v.notes = $3)`,
      [REFRESHED_SLUGS, MIGRATION_0136_NOTE, MIGRATION_0131_NOTE],
    )).rows[0].n);
    expect(stillApplied).toBe(3);
  });

  it("leaves customized version-1 content untouched across both migrations", async () => {
    let report: Record<string, unknown> = {};
    await expect(withSystem(async (db) => {
      for (const table of ["aqi_tutorial_events", "aqi_tutorial_progress"]) {
        await db.query(
          `delete from ${table} e using aqi_tutorials t
            where e.tutorial_id = t.id and t.slug = any($1::text[]) and e.tutorial_version = any($2::int[])`,
          [SLUGS, [2, 3]],
        );
      }
      await run(DOWN_0136, db);
      await run(DOWN_0131, db);
      await db.query(
        `update aqi_tutorial_versions v
            set definition = jsonb_set(v.definition, '{description}', '"Workspace-specific welcome"'::jsonb)
           from aqi_tutorials t
          where v.tutorial_id = t.id and t.slug = 'getting-started' and v.version = 1`,
      );
      await run(UP_0131, db);
      await run(UP_0136, db);
      report = {
        published: (await db.query<{ version: number; description: string }>(
          `select v.version, v.definition->>'description' as description
             from aqi_tutorials t join aqi_tutorial_versions v on v.id = t.published_version_id
            where t.slug = 'getting-started'`,
        )).rows[0],
        migratedVersions: (await db.query<{ n: number }>(
          `select count(*)::int as n from aqi_tutorial_versions v join aqi_tutorials t on t.id = v.tutorial_id
            where t.slug = 'getting-started' and v.notes = any($1::text[])`,
          [[MIGRATION_0131_NOTE, MIGRATION_0136_NOTE]],
        )).rows[0].n,
      };
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
    expect(report).toEqual({
      published: { version: 1, description: "Workspace-specific welcome" },
      migratedVersions: 0,
    });
  });

  it("refuses rollback if there is progress on either published guidance revision", async () => {
    const user = await createUser();
    await expect(withSystem(async (db) => {
      const tutorial = (await db.query<{ id: string }>(
        "select id from aqi_tutorials where slug = 'getting-started'",
      )).rows[0];
      await db.query(
        `insert into aqi_tutorial_progress (user_id, tutorial_id, tutorial_version, status)
         values ($1, $2, 3, 'paused')`,
        [user.id, tutorial.id],
      );
      await run(DOWN_0136, db);
    })).rejects.toThrow(/Refusing to roll back 0136: AQi progress or events exist/);

    await expect(withSystem(async (db) => {
      const tutorial = (await db.query<{ id: string }>(
        "select id from aqi_tutorials where slug = 'getting-started'",
      )).rows[0];
      await run(DOWN_0136, db);
      await db.query(
        `insert into aqi_tutorial_progress (user_id, tutorial_id, tutorial_version, status)
         values ($1, $2, 2, 'paused')`,
        [user.id, tutorial.id],
      );
      await run(DOWN_0131, db);
    })).rejects.toThrow(/Refusing to roll back 0131: AQi progress or events exist/);
  });

  it("documents customization and evidence guards for both migration pairs", () => {
    expect(UP_0131).toMatch(/notes is distinct from 'Starter library'/i);
    expect(UP_0131).toMatch(/legacy_description/i);
    expect(UP_0131).toMatch(/version = 2[\s\S]*?continue;/i);
    expect(DOWN_0131).toMatch(/aqi_tutorial_progress/i);
    expect(DOWN_0131).toMatch(/aqi_tutorial_events/i);
    expect(DOWN_0131).toMatch(/Refusing to roll back 0131/i);
    expect(UP_0136).toMatch(/previous_body/i);
    expect(UP_0136).toMatch(/version >= 3[\s\S]*?continue;/i);
    expect(DOWN_0136).toMatch(/aqi_tutorial_progress/i);
    expect(DOWN_0136).toMatch(/aqi_tutorial_events/i);
    expect(DOWN_0136).toMatch(/Refusing to roll back 0136/i);
  });
});
