import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The current hosted record includes AQi migrations through 0052 but not local RLS migration 0060: it has
// app.has_permission/current_user_id but no app.permitted_orgs. This isolated database applies the AQi migrations,
// then re-runs the workforce migrations to prove their per-row compatibility branch without touching hosted data.
const ROOT = process.cwd();
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");

let db: PGlite;

beforeAll(async () => {
  db = new PGlite({ extensions: { citext, pg_trgm, btree_gist } });
  await db.waitReady;
  await db.exec(fs.readFileSync(path.join(ROOT, "supabase", "local-compat.sql"), "utf8"));
  const files = fs.readdirSync(MIGRATIONS).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
  for (const name of files) {
    const prefix = name.slice(0, 4);
    if (prefix >= "0060") continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS, name), "utf8");
    await db.transaction(async (tx) => {
      await tx.exec(sql);
    });
  }
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe("hosted-compatible workforce migrations", () => {
  it("has the hosted helper set and no permitted_orgs", async () => {
    const hasPermission = await db.query<{ t: string | null }>("select to_regprocedure('app.has_permission(uuid,text)')::text as t");
    const hasCurrentUser = await db.query<{ t: string | null }>("select to_regprocedure('app.current_user_id()')::text as t");
    const permitted = await db.query<{ t: string | null }>("select to_regprocedure('app.permitted_orgs(text)')::text as t");
    expect(hasPermission.rows[0].t).not.toBeNull();
    expect(hasCurrentUser.rows[0].t).not.toBeNull();
    expect(permitted.rows[0].t).toBeNull();
  });

  it("can re-run 0045/0046 after an interrupted deploy", async () => {
    const up45 = fs.readFileSync(path.join(MIGRATIONS, "0045_ai_workforce_experience.sql"), "utf8");
    const up46 = fs.readFileSync(path.join(MIGRATIONS, "0046_knowledge_document_extraction.sql"), "utf8");
    await db.exec(up45);
    await db.exec(up46);
    const table = await db.query<{ t: string | null }>("select to_regclass('public.employee_knowledge_entries')::text as t");
    expect(table.rows[0].t).not.toBeNull();
  });

  it("applies 0045/0046 and creates per-row permission policies", async () => {
    const table = await db.query<{ t: string | null }>("select to_regclass('public.employee_knowledge_entries')::text as t");
    expect(table.rows[0].t).not.toBeNull();
    const columns = await db.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_schema='public' and table_name='knowledge_documents' and column_name in ('agent_instance_id','risk_flags','last_used_at','processing_detail','extraction_method','processed_at') order by column_name",
    );
    expect(columns.rows.map((r) => r.column_name)).toEqual([
      "agent_instance_id", "extraction_method", "last_used_at", "processed_at", "processing_detail", "risk_flags",
    ]);
    const policies = await db.query<{ policyname: string; qual: string | null; with_check: string | null }>(
      "select policyname, qual, with_check from pg_policies where schemaname='public' and tablename='employee_knowledge_entries' order by policyname",
    );
    expect(policies.rows.map((p) => p.policyname)).toEqual(["employee_knowledge_insert", "employee_knowledge_select", "employee_knowledge_update"]);
    for (const policy of policies.rows) {
      expect(`${policy.qual ?? ""} ${policy.with_check ?? ""}`).toContain("has_permission");
      expect(`${policy.qual ?? ""} ${policy.with_check ?? ""}`).not.toContain("permitted_orgs");
    }
    const rls = await db.query<{ relrowsecurity: boolean }>("select relrowsecurity from pg_class where oid='public.employee_knowledge_entries'::regclass");
    expect(rls.rows[0].relrowsecurity).toBe(true);
    const status = await db.query<{ def: string }>("select pg_get_constraintdef(oid) as def from pg_constraint where conname='knowledge_documents_status_check'");
    expect(status.rows[0].def).toContain("processing");
    expect(status.rows[0].def).toContain("unsupported");
  });
});
