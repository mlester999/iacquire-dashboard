import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { saveEmployeeKnowledgeEntry } from "@/server/workforce/knowledge";
import { addMember, agentId, createOrg, createUser, ctxFor } from "./support/fixtures";

const DOWN = readFileSync("supabase/rollbacks/0045_ai_workforce_experience.down.sql", "utf8");
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

async function columns() {
  return withSystem(async (db) =>
    (await db.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name = 'knowledge_documents' and column_name in ('agent_instance_id','risk_flags','last_used_at') order by column_name",
    )).rows.map((r) => r.column_name),
  );
}

async function tableExists() {
  return withSystem(async (db) =>
    (await db.query("select 1 from information_schema.tables where table_schema = 'public' and table_name = 'employee_knowledge_entries'")).rows.length === 1,
  );
}

describe("migration 0045 and its rollback", () => {
  it("adds the employee knowledge table and document scope columns", async () => {
    expect(await tableExists()).toBe(true);
    expect(await columns()).toEqual(["agent_instance_id", "last_used_at", "risk_flags"]);
  });

  it("rolls back cleanly and restores the schema after the transaction", async () => {
    let report: Record<string, unknown> = {};
    await expect(
      withSystem(async (db) => {
        await runDown(db);
        report = {
          table: (await db.query("select 1 from information_schema.tables where table_schema = 'public' and table_name = 'employee_knowledge_entries'")).rows.length,
          columns: (await db.query<{ column_name: string }>("select column_name from information_schema.columns where table_name = 'knowledge_documents' and column_name in ('agent_instance_id','risk_flags','last_used_at')")).rows.length,
        };
        throw new Done();
      }),
    ).rejects.toBeInstanceOf(Done);
    expect(report).toMatchObject({ table: 0, columns: 0 });
    expect(await tableExists()).toBe(true);
    expect(await columns()).toHaveLength(3);
  });

  it("refuses to roll back while employee-specific knowledge exists", async () => {
    const org = await createOrg({ name: "Migration 0041 Co" });
    const owner = await createUser();
    await addMember(org.id, owner.id, "owner");
    const agent = await agentId(org.id, "sales_assistant");
    await saveEmployeeKnowledgeEntry(ctxFor(owner, org, "owner"), agent, { title: "Kept note", content: "This note must block rollback." });
    await expect(withSystem((db) => runDown(db))).rejects.toThrow(/Rollback refused/);
  });
});
