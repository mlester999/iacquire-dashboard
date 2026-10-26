// Hosted Supabase refuses a direct delete from its storage tables unless the transaction says it is intended. The embedded database has no such guard, so the only
// thing that can be checked here is that every rollback that deletes from one says so, in the same transaction, before the delete.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DIR = "supabase/rollbacks";
const SETTING = /select\s+set_config\(\s*'storage\.allow_delete_query'\s*,\s*'true'\s*,\s*true\s*\)\s*;/i;
const DELETE = /delete\s+from\s+storage\.(buckets|objects)\b/gi;

describe("rollbacks that delete from a storage table", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".sql"));
  const touching = files.filter((f) => new RegExp(DELETE.source, "i").test(readFileSync(path.join(DIR, f), "utf8")));

  it("exist (this guards the guard: if the pattern stops matching, the loop below would check nothing)", () => {
    expect(touching).toEqual(expect.arrayContaining(["0049_aqi_attachments.down.sql", "0089_social_media_manager.down.sql"]));
  });

  for (const f of touching) {
    it(`${f} allows the delete for its own transaction, before the first one`, () => {
      const sql = readFileSync(path.join(DIR, f), "utf8");
      const setting = sql.search(SETTING);
      const firstDelete = sql.search(new RegExp(DELETE.source, "i"));
      expect(setting).toBeGreaterThanOrEqual(0);
      expect(setting).toBeLessThan(firstDelete);
      // The setting is local to the transaction (third argument true), so it cannot leave the protection weakened for anything after.
      expect(sql.match(SETTING)?.[0]).toMatch(/,\s*true\s*\)\s*;$/);
    });
  }
});
