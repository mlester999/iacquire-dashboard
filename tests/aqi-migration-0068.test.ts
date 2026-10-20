import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { createUser } from "./support/fixtures";

const DOWN = readFileSync("supabase/rollbacks/0068_aqi_operations.down.sql", "utf8");
class Done extends Error {}

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

  it("creates the supporting indexes", async () => {
    const indexes = await withSystem((db) => db.query<{ indexname: string }>(
      "select indexname from pg_indexes where indexname in ('audit_logs_action_created_idx', 'appointment_reminders_org_updated_idx', 'crm_webhook_deliveries_org_created_idx', 'aqi_conversations_surface_idx', 'aqi_ops_briefings_dedupe_idx')",
    ));
    expect(indexes.rows).toHaveLength(5);
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
