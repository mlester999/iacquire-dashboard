import { describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { addMember, createOrg, createUser } from "./support/fixtures";

describe("migration 0052 AQi conversation lifecycle", () => {
  it("adds the saved marker and defaults new conversations to temporary", async () => {
    const columns = await withSystem((db) => db.query<{ column_name: string; is_nullable: string; data_type: string }>(
      `select column_name, is_nullable, data_type
       from information_schema.columns
       where table_schema = 'public' and table_name = 'aqi_conversations'
         and column_name in ('saved_at', 'saved_by')
       order by column_name`,
    ));
    expect(columns.rows).toEqual([
      { column_name: "saved_at", is_nullable: "YES", data_type: "timestamp with time zone" },
      { column_name: "saved_by", is_nullable: "YES", data_type: "uuid" },
    ]);

    const indexes = await withSystem((db) => db.query<{ indexname: string }>(
      "select indexname from pg_indexes where schemaname = 'public' and tablename = 'aqi_conversations'",
    ));
    expect(indexes.rows.map((row) => row.indexname)).toContain("aqi_conversations_saved_idx");

    const org = await createOrg({ name: "AQi Lifecycle Migration" });
    const owner = await createUser({ name: "AQi Lifecycle Migration Owner" });
    await addMember(org.id, owner.id, "owner");
    const conversation = await withUser(owner.id, async (db) => (await db.query<{ saved_at: Date | null }>(
      `insert into aqi_conversations (org_id, user_id, title) values ($1, $2, 'Temporary migration chat') returning saved_at`,
      [org.id, owner.id],
    )).rows[0]);
    expect(conversation.saved_at).toBeNull();
  });
});
