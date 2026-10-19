import { describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { addMember, createOrg, createUser } from "./support/fixtures";

describe("migration 0047 AQi schema", () => {
  it("creates AQi tables, RLS and the initial published configuration", async () => {
    const tables = await withSystem(async (db) => db.query<{ name: string }>(
      "select relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname='public' and c.relkind='r' and c.relname like 'aqi_%' order by relname",
    ));
    expect(tables.rows.map((row) => row.name)).toEqual([
      "aqi_attachments", "aqi_budgets", "aqi_config_versions", "aqi_contextual_tips", "aqi_conversations",
      "aqi_knowledge_documents", "aqi_knowledge_entries", "aqi_messages", "aqi_model_prices", "aqi_suggested_questions",
      "aqi_tutorial_events", "aqi_tutorial_progress", "aqi_tutorial_versions", "aqi_tutorials", "aqi_usage_events",
      "aqi_user_preferences",
    ]);
    const rls = await withSystem(async (db) => db.query<{ relname: string; relrowsecurity: boolean }>(
      "select relname, relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname='public' and c.relname in ('aqi_conversations','aqi_messages','aqi_knowledge_entries')",
    ));
    expect(rls.rows.every((row) => row.relrowsecurity)).toBe(true);
    const config = await withSystem(async (db) => db.query<{ version: number; status: string }>("select version, status from aqi_config_versions where version = 1"));
    expect(config.rows).toHaveLength(1);
    expect(["published", "archived"]).toContain(config.rows[0].status);
    const knowledge = await withSystem(async (db) => db.query<{ n: number }>("select count(*)::int as n from aqi_knowledge_entries where status='published'"));
    expect(knowledge.rows[0].n).toBeGreaterThanOrEqual(10);
  });

  it("keeps conversations private to the signed-in person", async () => {
    const org = await createOrg({ name: "AQi Privacy" });
    const owner = await createUser();
    const other = await createUser();
    await addMember(org.id, owner.id, "owner");
    await addMember(org.id, other.id, "member");
    const id = await withUser(owner.id, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        "insert into aqi_conversations (org_id, user_id, title) values ($1, $2, 'Private question') returning id",
        [org.id, owner.id],
      );
      return rows[0].id;
    });
    const own = await withUser(owner.id, (db) => db.query("select id from aqi_conversations where id = $1", [id]));
    const otherView = await withUser(other.id, (db) => db.query("select id from aqi_conversations where id = $1", [id]));
    expect(own.rows).toHaveLength(1);
    expect(otherView.rows).toHaveLength(0);
  });
});
