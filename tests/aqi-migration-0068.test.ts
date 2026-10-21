import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { createUser } from "./support/fixtures";

const UP = readFileSync("supabase/migrations/0068_aqi_operations.sql", "utf8");
const DOWN = readFileSync("supabase/rollbacks/0068_aqi_operations.down.sql", "utf8");
class Done extends Error {}

/** Every index the migration creates, on existing tables and on its own. The rollback must remove all of them. */
const ALL_NEW_INDEXES = [
  "aqi_conversations_surface_idx", "aqi_conversations_ops_retention_idx", "audit_logs_action_created_idx", "appointment_reminders_org_updated_idx",
  "crm_webhook_deliveries_org_created_idx", "aqi_ops_actions_idempotency_idx", "aqi_ops_actions_user_idx", "aqi_ops_actions_org_idx", "aqi_ops_actions_open_idx",
  "aqi_ops_actions_one_executing_idx", "aqi_ops_actions_conversation_idx", "aqi_ops_actions_message_idx", "aqi_ops_actions_confirmed_by_idx", "aqi_ops_briefings_dedupe_idx",
  "aqi_ops_briefings_recipient_idx", "aqi_ops_briefings_created_idx",
] as const;

function statements(sql: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let inside = false;
  for (const raw of sql.split("\n")) {
    const line = raw.replace("\r", "");
    if (!inside && (line.trim() === "" || line.trim().startsWith("--"))) continue;
    current.push(line);
    if (line.split("$$").length % 2 === 0) inside = !inside;
    if (!inside && line.trimEnd().endsWith(";")) {
      out.push(current.join("\n"));
      current = [];
    }
  }
  return out;
}
const runDown = async (db: { query: (sql: string, params?: unknown[]) => Promise<unknown> }) => {
  for (const statement of statements(DOWN)) await db.query(statement);
};

describe("migration 0068 AQi Operations", () => {
  it("adds the conversation surface with a safe default for existing and new Client conversations", async () => {
    const column = await withSystem((db) => db.query<{ column_default: string; is_nullable: string }>(
      "select column_default, is_nullable from information_schema.columns where table_name = 'aqi_conversations' and column_name = 'surface'",
    ));
    expect(column.rows[0]).toMatchObject({ is_nullable: "NO" });
    expect(column.rows[0].column_default).toContain("assistant");
    const user = await createUser();
    const row = await withUser(user.id, async (db) => (await db.query<{ surface: string }>("insert into aqi_conversations (user_id, title) values ($1, 'Client style chat') returning surface", [user.id])).rows[0]);
    expect(row.surface).toBe("assistant");
    await expect(withSystem((db) => db.query("insert into aqi_conversations (user_id, surface) values ($1, 'other')", [user.id]))).rejects.toThrow();
  });

  it("creates the new tables with row-level security on and no access for the application role", async () => {
    for (const table of ["aqi_ops_actions", "aqi_ops_briefing_settings", "aqi_ops_briefings"]) {
      const rls = await withSystem((db) => db.query<{ relrowsecurity: boolean }>("select relrowsecurity from pg_class where relname = $1 and relkind = 'r'", [table]));
      expect(rls.rows[0]?.relrowsecurity, table).toBe(true);
      const grants = await withSystem((db) => db.query<{ privilege_type: string }>("select privilege_type from information_schema.role_table_grants where table_name = $1 and grantee = 'iaq_app_user'", [table]));
      expect(grants.rows, table).toHaveLength(0);
      const policies = await withSystem((db) => db.query("select 1 from pg_policies where tablename = $1", [table]));
      expect(policies.rows, table).toHaveLength(0);
    }
    const user = await createUser();
    await expect(withUser(user.id, (db) => db.query("select * from aqi_ops_actions"))).rejects.toThrow(/permission denied|row-level/i);
  });

  it("makes a successful action impossible without a verification, and an action id unique per requester and key", async () => {
    const user = await createUser({ platformRole: "agency_super_admin" });
    const insert = (status: string, verified: boolean | null, key: string) => withSystem((db) => db.query(
      `insert into aqi_ops_actions (requested_by, tool_id, scope_type, risk, approval, status, verified, idempotency_key)
       values ($1, 'incident.acknowledge', 'incident', 'low', 'confirm', $2, $3, $4)`, [user.id, status, verified, key],
    ));
    await expect(insert("succeeded", null, "key-aaaaaaaa")).rejects.toThrow();
    await expect(insert("succeeded", false, "key-bbbbbbbb")).rejects.toThrow();
    await expect(insert("verification_failed", true, "key-cccccccc")).rejects.toThrow();
    await insert("succeeded", true, "key-dddddddd");
    await expect(insert("proposed", null, "key-dddddddd")).rejects.toThrow(/duplicate|unique/i);
    await expect(withSystem((db) => db.query("insert into aqi_ops_actions (requested_by, tool_id, scope_type, risk, approval, idempotency_key) values ($1, 'Not A Tool', 'platform', 'low', 'confirm', 'key-eeeeeeee')", [user.id]))).rejects.toThrow();
  });

  it("lets only one action per tool and target execute at a time", async () => {
    const user = await createUser({ platformRole: "agency_super_admin" });
    const incident = crypto.randomUUID();
    const insert = (key: string, args: Record<string, string>, tool = "incident.acknowledge", status = "executing") => withSystem((db) => db.query(
      `insert into aqi_ops_actions (requested_by, tool_id, scope_type, risk, approval, status, args, idempotency_key)
       values ($1, $2, 'incident', 'low', 'confirm', $3, $4::jsonb, $5)`, [user.id, tool, status, JSON.stringify(args), key],
    ));
    await insert("exec-key-aaaaaaaa", { incidentId: incident });
    await expect(insert("exec-key-bbbbbbbb", { incidentId: incident })).rejects.toThrow(/duplicate|unique/i);
    await insert("exec-key-cccccccc", { incidentId: crypto.randomUUID() }); // another target
    await insert("exec-key-dddddddd", { ticketId: incident }, "support.escalate"); // another tool
    await insert("exec-key-eeeeeeee", { incidentId: incident }, "incident.acknowledge", "proposed"); // a proposal does not hold the target
    await withSystem((db) => db.query("update aqi_ops_actions set status = 'succeeded', verified = true where idempotency_key = 'exec-key-aaaaaaaa'"));
    await insert("exec-key-ffffffff", { incidentId: incident }); // free again once the first has finished
    await withSystem((db) => db.query("delete from aqi_ops_actions where requested_by = $1", [user.id]));
  });

  it("creates the supporting indexes", async () => {
    const indexes = await withSystem((db) => db.query<{ indexname: string }>(
      `select indexname from pg_indexes where indexname in (${ALL_NEW_INDEXES.map((name) => `'${name}'`).join(", ")})`,
    ));
    expect(indexes.rows.map((row) => row.indexname).sort()).toEqual([...ALL_NEW_INDEXES].sort());
  });

  it("indexes every foreign key on the new tables, so deleting a conversation, message or user never scans them", async () => {
    const unindexedSql = `select c.conrelid::regclass::text as table_name, string_agg(a.attname, ',' order by k.ord) as columns
         from pg_constraint c
         cross join lateral unnest(c.conkey) with ordinality as k(attnum, ord)
         join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
        where c.contype = 'f' and c.conrelid::regclass::text in ('aqi_ops_actions', 'aqi_ops_briefing_settings', 'aqi_ops_briefings')
          and not exists (
            select 1 from pg_index i
             where i.indrelid = c.conrelid and (i.indkey::int2[])[0:cardinality(c.conkey) - 1] = c.conkey)
        group by c.oid, c.conrelid`;
    expect((await withSystem((db) => db.query(unindexedSql))).rows).toEqual([]);
    // Negative control: the same query does notice a missing index.
    let control: unknown[] = [];
    await expect(withSystem(async (db) => {
      await db.query("drop index aqi_ops_actions_message_idx");
      control = (await db.query(unindexedSql)).rows;
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
    expect(control).toEqual([{ table_name: "aqi_ops_actions", columns: "message_id" }]);
  });

  it("is safe to apply in the application's transactional runner: fail-fast locking and no concurrent index", () => {
    const code = UP.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    expect(code).toMatch(/set local lock_timeout\s*=\s*'\d+s'/i);
    expect(code).not.toMatch(/concurrently/i); // the runner wraps each file in a transaction, where this is an error
    expect(code).not.toMatch(/\b(drop|truncate)\b/i); // additive only
    expect(code).not.toMatch(/\bdelete from\b|\bupdate\b\s+\w+\s+set/i); // no data is rewritten
    for (const statement of code.split(";").map((s) => s.trim()).filter(Boolean)) {
      if (/^create (unique )?(index|table)\b/i.test(statement)) expect(statement, statement.slice(0, 80)).toMatch(/^create (unique )?(index|table) if not exists\b/i);
    }
    // The hosted-scale escape hatch is documented where the operator will read it.
    expect(UP).toMatch(/create index concurrently if not exists audit_logs_action_created_idx/);
  });

  it("can be undone and applied again", async () => {
    const counts = async (db: { query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> }) =>
      (await db.query<{ n: number }>(`select count(*)::int as n from pg_indexes where indexname in (${ALL_NEW_INDEXES.map((name) => `'${name}'`).join(", ")})`)).rows[0].n;
    let report: Record<string, number> = {};
    await expect(withSystem(async (db) => {
      await db.query("delete from aqi_ops_actions");
      await db.query("delete from aqi_conversations where surface = 'operations'");
      await runDown(db);
      const afterDown = await counts(db);
      for (const statement of statements(UP)) await db.query(statement);
      report = { afterDown, afterUp: await counts(db) };
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
    expect(report).toEqual({ afterDown: 0, afterUp: ALL_NEW_INDEXES.length });
  });

  it("rolls back cleanly when no operations data exists, and refuses when it does", async () => {
    let report: Record<string, unknown> = {};
    // Other test files run in separate databases, but this one may already hold rows: clear them inside the probe.
    await expect(withSystem(async (db) => {
      await db.query("delete from aqi_ops_actions");
      await db.query("delete from aqi_conversations where surface = 'operations'");
      await runDown(db);
      report = {
        actions: (await db.query("select to_regclass('public.aqi_ops_actions')::text as t")).rows[0],
        surface: (await db.query("select count(*)::int as n from information_schema.columns where table_name = 'aqi_conversations' and column_name = 'surface'")).rows[0],
        index: (await db.query("select count(*)::int as n from pg_indexes where indexname = 'audit_logs_action_created_idx'")).rows[0],
      };
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
    expect(report).toEqual({ actions: { t: null }, surface: { n: 0 }, index: { n: 0 } });

    const user = await createUser({ platformRole: "agency_super_admin" });
    await withSystem((db) => db.query("delete from aqi_ops_actions"));
    await withSystem((db) => db.query("insert into aqi_conversations (user_id, surface) values ($1, 'operations')", [user.id]));
    await expect(withSystem((db) => runDown(db))).rejects.toThrow(/operations conversations exist/);
    await withSystem((db) => db.query("delete from aqi_conversations where user_id = $1", [user.id]));
    await withSystem((db) => db.query(
      "insert into aqi_ops_actions (requested_by, tool_id, scope_type, risk, approval, idempotency_key) values ($1, 'incident.acknowledge', 'incident', 'low', 'confirm', 'key-ffffffff')", [user.id],
    ));
    await expect(withSystem((db) => runDown(db))).rejects.toThrow(/aqi_ops_actions has rows/);
    await withSystem((db) => db.query("delete from aqi_ops_actions where requested_by = $1", [user.id]));
  });
});
