import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { createOrg } from "./support/fixtures";

// Migration 0117 adds the revision history, the waiting-edit columns and the document quarantine. Its rollback is reviewed with it, so both are proven here on the fully migrated
// local database. Everything that changes the schema runs inside a transaction that is always rolled back, leaving the shared test database untouched.
const UP = readFileSync("supabase/migrations/0117_company_knowledge_revisions.sql", "utf8");
const DOWN = readFileSync("supabase/rollbacks/0117_company_knowledge_revisions.down.sql", "utf8");
class Done extends Error {}

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

type Db = { query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> };
async function run(db: Db, sql: string) {
  for (const statement of statements(sql)) await db.query(statement);
}

/** Runs `fn` inside a transaction that is always rolled back, and hands back what it returned. */
async function rolledBack<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  let result: T | undefined;
  await expect(
    withSystem(async (db) => {
      result = await fn(db);
      throw new Done();
    }),
  ).rejects.toBeInstanceOf(Done);
  return result as T;
}

const columns = (db: Db, table: string, names: string[]) =>
  db.query<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'public' and table_name = $1 and column_name = any($2::text[]) order by column_name", [table, names]).then((r) => r.rows.map((x) => x.column_name));
const tableExists = (db: Db) => db.query<{ t: string | null }>("select to_regclass('public.company_knowledge_revisions')::text as t").then((r) => r.rows[0].t !== null);

describe("migration 0117 and its rollback", () => {
  it("takes the next free number and ships a rollback beside it", () => {
    expect(readdirSync("supabase/migrations").filter((f) => f.startsWith("0117_"))).toEqual(["0117_company_knowledge_revisions.sql"]);
    expect(readdirSync("supabase/rollbacks").filter((f) => f.startsWith("0117_"))).toEqual(["0117_company_knowledge_revisions.down.sql"]);
    expect(DOWN.trim().length).toBeGreaterThan(200);
  });

  it("adds the revision table, the waiting-edit columns and the document quarantine", async () => {
    const found = await withSystem(async (db) => ({
      revisions: await tableExists(db),
      knowledge: await columns(db, "company_knowledge", ["pending_content", "pending_flags"]),
      documents: await columns(db, "knowledge_documents", ["held_text"]),
      rls: (await db.query<{ relrowsecurity: boolean }>("select relrowsecurity from pg_class where oid = 'public.company_knowledge_revisions'::regclass")).rows[0].relrowsecurity,
    }));
    expect(found).toEqual({ revisions: true, knowledge: ["pending_content", "pending_flags"], documents: ["held_text"], rls: true });
  });

  it("gives the application role read and add on the history and nothing else, behind two scoped policies", async () => {
    const found = await withSystem(async (db) => {
      const privileges = (await db.query<{ s: boolean; i: boolean; u: boolean; d: boolean }>(
        `select has_table_privilege('iaq_app_user', 'public.company_knowledge_revisions', 'select') as s, has_table_privilege('iaq_app_user', 'public.company_knowledge_revisions', 'insert') as i,
                has_table_privilege('iaq_app_user', 'public.company_knowledge_revisions', 'update') as u, has_table_privilege('iaq_app_user', 'public.company_knowledge_revisions', 'delete') as d`,
      )).rows[0];
      const policies = (await db.query<{ cmd: string; qual: string | null; with_check: string | null }>(
        "select cmd, qual, with_check from pg_policies where schemaname = 'public' and tablename = 'company_knowledge_revisions' order by cmd",
      )).rows;
      const browser = (await db.query<{ n: number }>(
        "select count(*)::int as n from information_schema.role_table_grants where table_schema = 'public' and table_name = 'company_knowledge_revisions' and grantee in ('anon', 'authenticated', 'PUBLIC')",
      )).rows[0].n;
      return { privileges, policies, browser };
    });
    expect(found.privileges).toEqual({ s: true, i: true, u: false, d: false });
    expect(found.browser).toBe(0);
    expect(found.policies.map((p) => p.cmd)).toEqual(["INSERT", "SELECT"]);
    expect(found.policies[0].with_check).toMatch(/permitted_orgs.*knowledge\.edit/s);
    expect(found.policies[1].qual).toMatch(/permitted_orgs.*knowledge\.view/s);
  });

  it("enforces the shapes the application relies on", async () => {
    const org = await createOrg({ name: "Migration Shape Co" });
    const attempt = (sql: string, params: unknown[] = []) =>
      withSystem(async (db) => {
        await db.query(sql, params);
        throw new Done();
      });
    const revision = (status: string, source: string, version = 1) =>
      attempt(
        "insert into company_knowledge_revisions (org_id, section, version, content, review_status, source) values ($1, 'faq', $2, 'x', $3, $4)",
        [org.id, version, status, source],
      );
    // A good row passes (it is rolled back by the sentinel).
    await expect(revision("held", "client")).rejects.toBeInstanceOf(Done);
    await expect(revision("pending", "client")).rejects.toThrow(/company_knowledge_revisions_review_status_check/);
    await expect(revision("approved", "stranger")).rejects.toThrow(/company_knowledge_revisions_source_check/);
    await expect(revision("approved", "client", 0)).rejects.toThrow(/company_knowledge_revisions_version_check/);
    await expect(
      withSystem(async (db) => {
        await db.query("insert into company_knowledge_revisions (org_id, section, version, content, source) values ($1, 'faq', 7, 'a', 'client')", [org.id]);
        await db.query("insert into company_knowledge_revisions (org_id, section, version, content, source) values ($1, 'faq', 7, 'b', 'client')", [org.id]);
      }),
    ).rejects.toThrow(/company_knowledge_revisions_org_id_section_version_key/);
    // A waiting edit's flags only exist with the edit, and it stays inside the section's size limit.
    await expect(attempt("insert into company_knowledge (org_id, section, content, pending_flags) values ($1, 'faq', '', '{prompt_injection}')", [org.id])).rejects.toThrow(/company_knowledge_pending_shape/);
    await expect(attempt("insert into company_knowledge (org_id, section, content, pending_content) values ($1, 'faq', '', $2)", [org.id, "x".repeat(12001)])).rejects.toThrow(/company_knowledge_pending_shape/);
    await expect(attempt("insert into company_knowledge (org_id, section, content, pending_content, pending_flags) values ($1, 'faq', 'approved', 'waiting', '{prompt_injection}')", [org.id])).rejects.toBeInstanceOf(Done);
    // Revisions go with their workspace.
    await expect(
      withSystem(async (db) => {
        await db.query("insert into company_knowledge_revisions (org_id, section, version, content, source) values ($1, 'faq', 1, 'a', 'client')", [org.id]);
        await db.query("delete from organizations where id = $1", [org.id]);
        const left = (await db.query<{ n: number }>("select count(*)::int as n from company_knowledge_revisions where org_id = $1", [org.id])).rows[0].n;
        expect(left).toBe(0);
        throw new Done();
      }),
    ).rejects.toBeInstanceOf(Done);
  });

  it("can be applied twice (an interrupted deploy re-runs it) without error or duplicate objects", async () => {
    const found = await rolledBack(async (db) => {
      await run(db, UP);
      await run(db, UP);
      const policies = (await db.query<{ n: number }>("select count(*)::int as n from pg_policies where tablename = 'company_knowledge_revisions'")).rows[0].n;
      const constraints = (await db.query<{ n: number }>("select count(*)::int as n from pg_constraint where conname in ('company_knowledge_pending_shape', 'knowledge_documents_held_text_shape')")).rows[0].n;
      return { policies, constraints };
    });
    expect(found).toEqual({ policies: 2, constraints: 2 });
  });

  it("rolls back cleanly inside a transaction, and the migration's objects are still there afterwards", async () => {
    const report = await rolledBack(async (db) => {
      await run(db, DOWN);
      return {
        revisions: await tableExists(db),
        knowledge: await columns(db, "company_knowledge", ["pending_content", "pending_flags"]),
        documents: await columns(db, "knowledge_documents", ["held_text"]),
      };
    });
    expect(report).toEqual({ revisions: false, knowledge: [], documents: [] });
    expect(await withSystem((db) => tableExists(db))).toBe(true);
    expect(await withSystem((db) => columns(db, "company_knowledge", ["pending_content"]))).toEqual(["pending_content"]);
  });

  it("puts a waiting edit on a section with no approved text back in the older shape instead of dropping it", async () => {
    const org = await createOrg({ name: "Rollback Waiting Co" });
    const after = await rolledBack(async (db) => {
      await db.query("insert into company_knowledge (org_id, section, content, pending_content, pending_flags) values ($1, 'faq', '', 'WAITING-TEXT', '{prompt_injection}')", [org.id]);
      await run(db, DOWN);
      return (await db.query<{ content: string; review_status: string; risk_flags: string[] }>("select content, review_status, risk_flags from company_knowledge where org_id = $1 and section = 'faq'", [org.id])).rows[0];
    });
    expect(after).toEqual({ content: "WAITING-TEXT", review_status: "pending_agency_review", risk_flags: ["prompt_injection"] });
  });

  it("refuses to roll back while a section has both approved text and a waiting edit", async () => {
    const org = await createOrg({ name: "Rollback Refused Co" });
    await expect(
      withSystem(async (db) => {
        await db.query("insert into company_knowledge (org_id, section, content, pending_content, pending_flags) values ($1, 'faq', 'APPROVED-TEXT', 'WAITING-TEXT', '{prompt_injection}')", [org.id]);
        await run(db, DOWN);
      }),
    ).rejects.toThrow(/Rollback refused/);
    // The refusal changed nothing: the objects are still there.
    expect(await withSystem((db) => tableExists(db))).toBe(true);
  });
});
