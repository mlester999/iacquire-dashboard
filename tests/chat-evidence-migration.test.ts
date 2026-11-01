// Migration 0116: the evidence marker on a chat reply. Only a server-written assistant or notice row may carry one, it is bounded and shaped by the table itself, the existing
// grant already covers it, nobody signed in can write an assistant row at all, and the rollback removes it cleanly. Each rollback case runs in a transaction that is rolled back.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { addMember, agentId, createOrg, createUser, uid } from "./support/fixtures";

class Done extends Error {}
const up = readFileSync("supabase/migrations/0116_chat_message_evidence.sql", "utf8");
const down = readFileSync("supabase/rollbacks/0116_chat_message_evidence.down.sql", "utf8");

/** Splits a script into statements, keeping `$$ ... $$` bodies whole (the test driver runs one statement per call). */
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
const run = async (db: Queryable, sql: string) => {
  for (const statement of statements(sql)) await db.query(statement);
};
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T>(sql, params))).rows;

async function inRolledBackTransaction(body: (db: Queryable) => Promise<void>) {
  await expect(withSystem(async (db) => {
    await body(db);
    throw new Done();
  })).rejects.toBeInstanceOf(Done);
}

async function conversation() {
  const org = await createOrg({ name: `Evidence Migration ${uid()}` });
  const owner = await createUser();
  await addMember(org.id, owner.id, "owner");
  const agent = await agentId(org.id, "operations_manager");
  const { rows } = await withSystem((db) => db.query<{ id: string }>(
    "insert into chat_conversations (org_id, agent_instance_id, user_id, title, hermes_session_id) values ($1, $2, $3, 'Evidence', $4) returning id",
    [org.id, agent, owner.id, `iaq-${uid()}`],
  ));
  return { org, owner, conversationId: rows[0].id };
}

const marker = (over: Record<string, unknown> = {}) => JSON.stringify({ v: 1, class: "system_notice", ...over });
async function insert(conv: { org: { id: string }; conversationId: string }, role: string, evidence: string | null) {
  return withSystem((db) => db.query(
    "insert into chat_messages (conversation_id, org_id, role, content, status, evidence) values ($1, $2, $3, 'x', 'complete', $4::jsonb) returning id, evidence",
    [conv.conversationId, conv.org.id, role, evidence],
  ));
}

describe("the column", () => {
  it("is a nullable jsonb, so every row written before it has none", async () => {
    const column = (await q<{ data_type: string; is_nullable: string; column_default: string | null }>(
      "select data_type, is_nullable, column_default from information_schema.columns where table_name = 'chat_messages' and column_name = 'evidence'",
    ))[0];
    expect(column).toMatchObject({ data_type: "jsonb", is_nullable: "YES", column_default: null });
    const conv = await conversation();
    const legacy = await insert(conv, "assistant", null);
    expect(legacy.rows[0]).toMatchObject({ evidence: null });
  });

  it("has a validated check, so no existing row escaped it", async () => {
    const check = (await q<{ convalidated: boolean }>("select convalidated from pg_constraint where conname = 'chat_messages_evidence_shape'"))[0];
    expect(check).toEqual({ convalidated: true });
  });
});

describe("the shape check", () => {
  it("lets a server-written assistant or notice row carry a marker", async () => {
    const conv = await conversation();
    expect((await insert(conv, "assistant", marker({ class: "approved_write", ledger: { kind: "schedule", id: "abc" } }))).rows[0]).toMatchObject({ evidence: { class: "approved_write" } });
    expect((await insert(conv, "notice", marker())).rows[0]).toMatchObject({ evidence: { class: "system_notice" } });
  });

  it("refuses a marker on a user row", async () => {
    const conv = await conversation();
    await expect(insert(conv, "user", marker())).rejects.toThrow(/chat_messages_evidence_shape|check constraint/);
    expect((await insert(conv, "user", null)).rows[0]).toMatchObject({ evidence: null });
  });

  it("refuses anything that is not a version 1 object of a known class", async () => {
    const conv = await conversation();
    for (const bad of [
      "[]", "\"system_notice\"", "42", "true", "{}", JSON.stringify({ v: 2, class: "system_notice" }), JSON.stringify({ v: "one", class: "system_notice" }),
      JSON.stringify({ class: "system_notice" }), JSON.stringify({ v: 1, class: "guess" }), JSON.stringify({ v: 1 }), JSON.stringify({ v: 1, class: 7 }),
    ]) {
      await expect(insert(conv, "assistant", bad), bad).rejects.toThrow(/chat_messages_evidence_shape|check constraint/);
    }
  });

  it("accepts all six classes", async () => {
    const conv = await conversation();
    for (const cls of ["model_response", "record_retrieval", "proposed_change", "approved_write", "completed_action", "system_notice"]) {
      expect((await insert(conv, "assistant", marker({ class: cls }))).rows).toHaveLength(1);
    }
  });

  it("holds a marker to 2 KB", async () => {
    const conv = await conversation();
    const big = marker({ records: { readAt: "2026-10-26T06:00:00.000Z", areas: [{ id: "x".repeat(3000), state: "ready" }] } });
    await expect(insert(conv, "assistant", big)).rejects.toThrow(/chat_messages_evidence_shape|check constraint/);
    // The largest marker the application builds (sixteen areas with the longest names) fits with room to spare.
    const areas = Array.from({ length: 16 }, (_, i) => ({ id: `a${String(i).padStart(2, "0")}_${"x".repeat(35)}`, state: "not_configured" }));
    const largest = marker({ class: "model_response", records: { readAt: "2026-10-26T06:00:00.000Z", areas } });
    const row = await insert(conv, "assistant", largest);
    const size = (await q<{ size: number }>("select pg_column_size(evidence) as size from chat_messages where id = $1", [row.rows[0].id as string]))[0].size;
    expect(size).toBeLessThan(2048);
    expect(size).toBeGreaterThan(1000);
  });
});

describe("who can write and read it", () => {
  it("lets the person read the marker of their own conversation through the application role (the table-wide grant covers the column)", async () => {
    const conv = await conversation();
    const row = await insert(conv, "assistant", marker({ class: "proposed_change" }));
    const seen = await withUser(conv.owner.id, async (db) => (await db.query<{ evidence: { class: string } }>("select evidence from chat_messages where id = $1", [row.rows[0].id])).rows[0]);
    expect(seen.evidence.class).toBe("proposed_change");
  });

  it("never lets a signed-in person write an assistant or notice row, so nobody can stamp a reply as their own", async () => {
    const conv = await conversation();
    for (const role of ["assistant", "notice"]) {
      await expect(withUser(conv.owner.id, (db) => db.query(
        "insert into chat_messages (conversation_id, org_id, role, content, evidence) values ($1, $2, $3, 'x', $4::jsonb)",
        [conv.conversationId, conv.org.id, role, marker({ class: "completed_action" })],
      )), role).rejects.toThrow(/row-level security|violates/i);
    }
  });

  it("refuses a signed-in person's own message when it carries a marker", async () => {
    const conv = await conversation();
    await expect(withUser(conv.owner.id, (db) => db.query(
      "insert into chat_messages (conversation_id, org_id, role, content, evidence) values ($1, $2, 'user', 'x', $3::jsonb)",
      [conv.conversationId, conv.org.id, marker()],
    ))).rejects.toThrow(/chat_messages_evidence_shape|check constraint/);
  });

  it("gives another workspace's member nothing", async () => {
    const conv = await conversation();
    await insert(conv, "assistant", marker());
    const other = await createOrg({ name: `Other ${uid()}` });
    const stranger = await createUser();
    await addMember(other.id, stranger.id, "owner");
    const rows = await withUser(stranger.id, async (db) => (await db.query("select evidence from chat_messages where conversation_id = $1", [conv.conversationId])).rows);
    expect(rows).toEqual([]);
  });
});

describe("the rollback", () => {
  it("removes the column and its check, is safe to run twice, and the migration can be applied again", async () => {
    const conv = await conversation();
    await insert(conv, "assistant", marker({ class: "approved_write" }));
    await inRolledBackTransaction(async (db) => {
      await run(db, down);
      const present = async () => (await db.query<{ n: number }>(
        "select (select count(*) from information_schema.columns where table_name = 'chat_messages' and column_name = 'evidence')::int + (select count(*) from pg_constraint where conname = 'chat_messages_evidence_shape')::int as n",
      )).rows[0].n;
      expect(await present()).toBe(0);
      await run(db, down);
      expect(await present()).toBe(0);
      // The business columns the row was made of are untouched.
      expect((await db.query("select id, content from chat_messages where conversation_id = $1", [conv.conversationId])).rows).toHaveLength(1);
      await run(db, up);
      expect(await present()).toBe(2);
      await run(db, up);
      expect(await present()).toBe(2);
      expect((await db.query<{ convalidated: boolean }>("select convalidated from pg_constraint where conname = 'chat_messages_evidence_shape'")).rows[0].convalidated).toBe(true);
    });
    // Rolled back: the column is still there.
    expect((await q("select 1 from information_schema.columns where table_name = 'chat_messages' and column_name = 'evidence'")).length).toBe(1);
  });

  it("applies cleanly a second time over a table that already has it", async () => {
    await inRolledBackTransaction(async (db) => {
      await run(db, up);
      await run(db, up);
    });
  });
});

describe("the files", () => {
  it("name their prerequisite and the rollback, and stay LF only", () => {
    expect(up).toContain("0002_workforce");
    expect(up).toContain("supabase/rollbacks/0116_chat_message_evidence.down.sql");
    expect(up).not.toContain("\r");
    expect(down).not.toContain("\r");
  });
});
