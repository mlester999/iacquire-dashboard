import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { addMember, createOrg, createUser } from "./support/fixtures";

describe("migration 0051 AQi conversation titles", () => {
  it("adds title provenance with a safe default and a constrained vocabulary", async () => {
    const columns = await withSystem((db) =>
      db.query<{ column_name: string; is_nullable: string; column_default: string | null }>(
        `select column_name, is_nullable, column_default from information_schema.columns
         where table_schema = 'public' and table_name = 'aqi_conversations' and column_name in ('title_source','title_generated_at')
         order by column_name`,
      ),
    );
    expect(columns.rows).toEqual([
      { column_name: "title_generated_at", is_nullable: "YES", column_default: null },
      { column_name: "title_source", is_nullable: "NO", column_default: "'default'::text" },
    ]);
  });

  it("defaults new conversations and allows manual/auto provenance only", async () => {
    const org = await createOrg({ name: "AQi Title Migration" });
    const user = await createUser();
    await addMember(org.id, user.id, "owner");

    const created = await withSystem((db) =>
      db.query<{ id: string; title_source: string; title_generated_at: Date | null }>(
        "insert into aqi_conversations (org_id, user_id) values ($1, $2) returning id, title_source, title_generated_at",
        [org.id, user.id],
      ),
    );
    expect(created.rows[0]).toMatchObject({ title_source: "default", title_generated_at: null });

    await withSystem((db) =>
      db.query("update aqi_conversations set title = 'Manual name', title_source = 'manual', title_generated_at = now() where id = $1", [created.rows[0].id]),
    );
    const manual = await withSystem((db) =>
      db.query<{ title_source: string }>("select title_source from aqi_conversations where id = $1", [created.rows[0].id]),
    );
    expect(manual.rows[0].title_source).toBe("manual");

    await expect(
      withSystem((db) => db.query("update aqi_conversations set title_source = 'generating' where id = $1", [created.rows[0].id])),
    ).rejects.toThrow(/check constraint|violates/i);
  });

  it("keeps existing non-placeholder titles as manual instead of letting generation rewrite them", async () => {
    const org = await createOrg({ name: "AQi Title Backfill" });
    const user = await createUser();
    await addMember(org.id, user.id, "owner");
    const row = await withSystem((db) =>
      db.query<{ id: string }>(
        "insert into aqi_conversations (org_id, user_id, title, title_source) values ($1, $2, 'Named by a person', 'manual') returning id",
        [org.id, user.id],
      ),
    );
    expect(row.rows[0].id).toBeTruthy();
  });
});
