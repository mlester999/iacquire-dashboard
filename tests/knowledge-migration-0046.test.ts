import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { uploadKnowledgeDocument } from "@/server/knowledge/service";
import { addMember, createOrg, createUser, ctxFor } from "./support/fixtures";
import { makeMalformedDocx } from "./support/document-fixtures";

// The migration's rollback is reviewed with it, so prove it here on the fully migrated local database. Everything
// runs inside a transaction that is always rolled back, leaving the shared test database untouched.
const DOWN = readFileSync("supabase/rollbacks/0046_knowledge_document_extraction.down.sql", "utf8");
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

async function runDown(db: { query: (sql: string) => Promise<unknown> }) {
  for (const statement of statements(DOWN)) await db.query(statement);
}

async function statusCheck() {
  return withSystem(async (db) =>
    String((await db.query<{ def: string }>("select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'knowledge_documents_status_check'")).rows[0]?.def ?? ""),
  );
}

describe("migration 0046 and its rollback", () => {
  it("adds the extraction statuses and evidence columns", async () => {
    const check = await statusCheck();
    for (const status of ["processing", "ready", "failed", "unsupported"]) expect(check).toContain(status);
    const columns = await withSystem(async (db) =>
      (await db.query<{ column_name: string }>(
        "select column_name from information_schema.columns where table_name = 'knowledge_documents' and column_name in ('processing_detail','extraction_method','processed_at') order by column_name",
      )).rows.map((r) => r.column_name),
    );
    expect(columns).toEqual(["extraction_method", "processed_at", "processing_detail"]);
  });

  it("rolls back cleanly inside a transaction and restores the older status list", async () => {
    let report: Record<string, unknown> = {};
    await expect(
      withSystem(async (db) => {
        await runDown(db);
        report = {
          columns: (await db.query<{ column_name: string }>("select column_name from information_schema.columns where table_name = 'knowledge_documents' and column_name in ('processing_detail','extraction_method','processed_at')")).rows.length,
          check: String((await db.query<{ def: string }>("select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'knowledge_documents_status_check'")).rows[0]?.def ?? ""),
        };
        throw new Done();
      }),
    ).rejects.toBeInstanceOf(Done);
    expect(report.columns).toBe(0);
    expect(String(report.check)).toContain("ready");
    expect(String(report.check)).not.toContain("processing");
    // The transaction rolled back, so the migration's objects are still present.
    expect(await statusCheck()).toContain("processing");
  });

  it("refuses to roll back while a document is in a new state", async () => {
    const org = await createOrg({ name: "Extraction Rollback Co" });
    const owner = await createUser();
    await addMember(org.id, owner.id, "owner");
    const ctx = ctxFor(owner, org, "owner");
    await uploadKnowledgeDocument(ctx, { name: "broken.docx", bytes: makeMalformedDocx() });
    await expect(withSystem((db) => runDown(db))).rejects.toThrow(/Rollback refused/);
  });
});
