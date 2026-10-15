import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { saveOnboardingStep } from "@/server/onboarding/service";
import { createWebsite } from "@/server/websites/service";
import { addMember, createOrg, createUser, ctxFor } from "./support/fixtures";

// The rollback is reviewed with the migration, so it is proven here: on a fully migrated local database it must execute, remove everything 0026
// added, and put back what 0026 changed. It runs inside a transaction that is always rolled back, so the shared test database is untouched.
const DOWN = readFileSync("supabase/rollbacks/0026_website_studio_admin.down.sql", "utf8");
const UP = readFileSync("supabase/migrations/0026_website_studio_admin.sql", "utf8");
class Done extends Error {}

/** Splits a script into statements, keeping `$$ ... $$` bodies whole. The test driver runs one statement per call. */
function statements(sql: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let inside = false;
  for (const raw of sql.split("\n")) {
    const line = raw.replace("\r", "");
    if (!inside && (line.trim() === "" || line.trim().startsWith("--"))) continue;
    cur.push(line);
    if (line.split("$$").length % 2 === 0) inside = !inside;
    if (!inside && line.trimEnd().endsWith(";")) {
      out.push(cur.join("\n"));
      cur = [];
    }
  }
  return out;
}
const runDown = async (db: { query: (sql: string) => Promise<unknown> }) => {
  for (const stmt of statements(DOWN)) await db.query(stmt);
};

describe("migration 0026 and its rollback", () => {
  it("adds exactly the objects the review lists", async () => {
    const tables = [...UP.matchAll(/^create table (\w+) \(/gm)].map((m) => m[1]).sort();
    expect(tables).toEqual(["website_comments", "website_components", "website_patterns", "website_template_versions", "website_templates"]);
    const present = await withSystem(async (db) => (await db.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema = 'public' and table_name = any($1)", [tables])).rows.map((r) => r.table_name).sort());
    expect(present).toEqual(tables);
  });

  it("rolls back cleanly on a fully migrated database, and restores the older constraints", async () => {
    let report: Record<string, unknown> = {};
    await expect(
      withSystem(async (db) => {
        await runDown(db);
        const q = async (sql: string) => (await db.query<Record<string, unknown>>(sql)).rows;
        report = {
          tables: (await q("select table_name from information_schema.tables where table_schema = 'public' and table_name in ('website_templates','website_template_versions','website_patterns','website_components','website_comments')")).length,
          lockColumns: (await q("select column_name from information_schema.columns where table_name = 'websites' and column_name in ('archived_at','edit_lock_user','edit_lock_name','edit_lock_expires')")).length,
          formColumns: (await q("select column_name from information_schema.columns where table_name = 'website_form_submissions' and column_name in ('purpose','form_id')")).length,
          folder: (await q("select column_name from information_schema.columns where table_name = 'org_assets' and column_name = 'folder'")).length,
          oldFunction: (await q("select pronargs from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = 'submit_site_form'")).map((r) => Number(r.pronargs)),
          permissions: (await q("select permission from role_permissions where permission in ('website.templates.design','website.templates.publish','website.review')")).length,
          keyCheck: String((await q("select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'websites_template_key_check'"))[0]?.def ?? ""),
        };
        throw new Done();
      }),
    ).rejects.toBeInstanceOf(Done);
    expect(report).toMatchObject({ tables: 0, lockColumns: 0, formColumns: 0, folder: 0, oldFunction: [14], permissions: 0 });
    expect(String(report.keyCheck)).toContain("[a-z]+");
    expect(String(report.keyCheck)).not.toContain("[a-z0-9-]*");
    // Rolled back: the migration's objects are all still there.
    const still = await withSystem(async (db) => (await db.query("select 1 from information_schema.tables where table_name = 'website_templates'")).rows.length);
    expect(still).toBe(1);
  });

  it("refuses to roll back while data exists that the older schema can't hold", async () => {
    const org = await createOrg({ name: "Rollback Co" });
    const owner = await createUser();
    await addMember(org.id, owner.id, "owner");
    const ctx = ctxFor(owner, org, "owner");
    await saveOnboardingStep(ctx, {
      answers: {
        "a.business_name": { value: "Rollback Co" }, "a.industry": { value: "home_services" }, "a.business_model": { value: "local" }, "a.description": { value: "We help." },
        "a.contact_phone": { value: "+15125550100" }, "a.contact_email": { value: "hello@example.test" }, "a.territories": { value: "Austin" }, "b.services": { value: "Repairs, Inspections" },
      },
    });
    await createWebsite(ctx, { templateKey: "care.haven" });
    // A hyphenated template key is valid after 0026 and not before it.
    await expect(
      withSystem(async (db) => {
        await db.query("update websites set template_key = 'custom.my-template' where org_id = $1", [org.id]);
        await runDown(db);
      }),
    ).rejects.toThrow(/Rollback refused/);
    // And it left nothing half-done.
    const rows = await withSystem(async (db) => (await db.query<{ template_key: string }>("select template_key from websites where org_id = $1", [org.id])).rows);
    expect(rows[0].template_key).toBe("care.haven");
  });
});
