import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { addMember, createOrg, createUser } from "./support/fixtures";
import { parseTutorialDefinition } from "@/server/aqi/tutorials";
import { getAqiTarget } from "@/lib/aqi/targets";
import { validateTutorialDefinition } from "@/lib/aqi/tutorials";

describe("migration 0061 AQi Phase 3 guidance", () => {
  it("creates the tutorial, progress, onboarding, tip and document tables", async () => {
    const tables = await withSystem(async (db) => (await db.query<{ name: string }>(
      `select tablename as name from pg_tables where schemaname = 'public' and tablename in (
         'aqi_tutorials','aqi_tutorial_versions','aqi_tutorial_progress','aqi_tutorial_events',
         'aqi_user_preferences','aqi_contextual_tips','aqi_knowledge_documents'
       ) order by tablename`,
    )).rows.map((row) => row.name));
    expect(tables).toEqual([
      "aqi_contextual_tips",
      "aqi_knowledge_documents",
      "aqi_tutorial_events",
      "aqi_tutorial_progress",
      "aqi_tutorial_versions",
      "aqi_tutorials",
      "aqi_user_preferences",
    ]);

    const columns = await withSystem(async (db) => (await db.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
        where table_schema = 'public' and (
          (table_name = 'aqi_knowledge_entries' and column_name in ('last_reviewed_at','next_review_at','freshness_days','source_kind','source_document_id')) or
          (table_name = 'aqi_usage_events' and column_name in ('metadata','intent'))
        ) order by table_name, column_name`,
    )).rows);
    expect(columns.map((row) => `${row.table_name}.${row.column_name}`)).toEqual([
      "aqi_knowledge_entries.freshness_days",
      "aqi_knowledge_entries.last_reviewed_at",
      "aqi_knowledge_entries.next_review_at",
      "aqi_knowledge_entries.source_document_id",
      "aqi_knowledge_entries.source_kind",
      "aqi_usage_events.intent",
      "aqi_usage_events.metadata",
    ]);

    const rls = await withSystem(async (db) => (await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace
        and relname in ('aqi_tutorials','aqi_tutorial_versions','aqi_tutorial_progress','aqi_tutorial_events','aqi_user_preferences','aqi_contextual_tips','aqi_knowledge_documents')`,
    )).rows);
    expect(rls.every((row) => row.relrowsecurity)).toBe(true);
  });

  it("seeds a complete, valid starter library and the configured tips", async () => {
    const tutorials = await withSystem(async (db) => (await db.query<{ slug: string; title: string; status: string; published_version_id: string | null; definition: unknown; version: number }>(
      `select t.slug, t.title, t.status, t.published_version_id, v.definition, v.version
         from aqi_tutorials t join aqi_tutorial_versions v on v.id = t.published_version_id
        where t.status = 'published' order by t.priority`,
    )).rows);
    expect(tutorials.length).toBeGreaterThanOrEqual(12);
    for (const tutorial of tutorials) {
      const definition = parseTutorialDefinition(tutorial.definition);
      const validation = validateTutorialDefinition(definition);
      expect({ slug: tutorial.slug, errors: validation.errors }).toEqual({ slug: tutorial.slug, errors: [] });
      expect(tutorial.version).toBeGreaterThanOrEqual(1);
      for (const step of definition.steps) {
        if (step.targetId) expect(getAqiTarget(step.targetId), `${tutorial.slug} → ${step.targetId}`).not.toBeNull();
      }
      if (tutorial.slug === "create-contact") {
        expect(definition.completion.kind).toBe("contact_created");
        expect(tutorial.version).toBe(2);
      }
    }
    expect(tutorials.map((tutorial) => tutorial.slug)).toEqual(expect.arrayContaining([
      "getting-started", "create-contact", "manage-leads", "use-pipelines", "view-ai-employees",
      "find-integrations", "contact-support", "invite-team-member", "agency-tools", "aqi-management",
      "aqi-knowledge", "aqi-tutorials", "aqi-insights",
    ]));

    const tips = await withSystem(async (db) => (await db.query<{ slug: string }>("select slug from aqi_contextual_tips order by priority")).rows);
    expect(tips.length).toBeGreaterThanOrEqual(5);
    expect(tips.map((tip) => tip.slug)).toContain("contacts-help");
  });

  it("allows the new analytics event kinds and rejects an unknown one", async () => {
    const check = await withSystem(async (db) => String((await db.query<{ def: string }>(
      "select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'aqi_usage_events_kind_check'",
    )).rows[0]?.def ?? ""));
    for (const kind of ["knowledge_retrieval", "knowledge_miss", "guidance_offer", "guidance_accept", "guidance_decline", "tip_view", "tip_click"]) {
      expect(check).toContain(kind);
    }
    await expect(withSystem((db) => db.query("insert into aqi_usage_events (kind) values ('totally_unknown')"))).rejects.toThrow();
  });

  it("enforces per-person progress and onboarding preferences with RLS", async () => {
    const org = await createOrg({ name: "Tutorial RLS Co" });
    const owner = await createUser({ name: "Progress Owner" });
    const other = await createUser({ name: "Other Person" });
    await addMember(org.id, owner.id, "owner");
    await addMember(org.id, other.id, "owner");
    const tutorial = await withSystem(async (db) => (await db.query<{ id: string; slug: string }>("select id, slug from aqi_tutorials where slug = 'getting-started'")).rows[0]);

    const inserted = await withUser(owner.id, async (db) => (await db.query<{ id: string }>(
      `insert into aqi_tutorial_progress (org_id, user_id, tutorial_id, tutorial_version, status)
       values ($1, $2, $3, 1, 'in_progress') returning id`,
      [org.id, owner.id, tutorial.id],
    )).rows[0]);
    expect(inserted.id).toBeTruthy();

    const ownerRows = await withUser(owner.id, async (db) => (await db.query("select id from aqi_tutorial_progress")).rows);
    expect(ownerRows).toHaveLength(1);
    const otherRows = await withUser(other.id, async (db) => (await db.query("select id from aqi_tutorial_progress")).rows);
    expect(otherRows).toHaveLength(0);
    await expect(withUser(other.id, (db) => db.query("update aqi_tutorial_progress set current_step = 3"))).resolves.toBeTruthy();
    const unchanged = await withSystem(async (db) => (await db.query<{ current_step: number }>("select current_step from aqi_tutorial_progress where id = $1", [inserted.id])).rows[0].current_step);
    expect(unchanged).toBe(0);

    const prefs = await withUser(owner.id, async (db) => (await db.query<{ onboarding_status: string; tips_enabled: boolean }>(
      "insert into aqi_user_preferences (user_id, org_id) values ($1, $2) returning onboarding_status, tips_enabled",
      [owner.id, org.id],
    )).rows[0]);
    expect(prefs).toEqual({ onboarding_status: "not_seen", tips_enabled: true });

    const visible = await withUser(owner.id, async (db) => (await db.query<{ n: number }>("select count(*)::int as n from aqi_tutorials")).rows[0].n);
    expect(visible).toBeGreaterThanOrEqual(12);
  });

  it("keeps knowledge documents management-only and adds review metadata", async () => {
    const privileges = await withSystem(async (db) => (await db.query<{ allowed: boolean }>(
      "select has_table_privilege('iaq_app_user', 'aqi_knowledge_documents', 'select') as allowed",
    )).rows[0].allowed);
    expect(privileges).toBe(false);
    const auditColumns = await withSystem(async (db) => (await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'aqi_knowledge_documents'
        order by ordinal_position`,
    )).rows.map((row) => row.column_name));
    expect(auditColumns).toEqual(expect.arrayContaining(["filename", "mime_type", "size_bytes", "sha256", "storage_path", "extraction_status", "extracted_text", "risk_flags", "status"]));
  });

  it("documents a guarded rollback", () => {
    const down = readFileSync("supabase/rollbacks/0061_aqi_phase3_guidance.down.sql", "utf8");
    expect(down).toContain("Refusing to roll back 0061");
    expect(down).toContain("drop table if exists aqi_tutorial_progress");
    expect(down).toContain("aqi_usage_events_kind_check");
  });
});
