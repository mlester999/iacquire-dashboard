import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { createOrg, createUser } from "./support/fixtures";

const UP = readFileSync("supabase/migrations/0065_support_requests.sql", "utf8");
const DOWN = readFileSync("supabase/rollbacks/0065_support_requests.down.sql", "utf8");
class Done extends Error {}

/** Splits SQL into whole statements while keeping dollar-quoted bodies intact. */
function statements(sql: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let inDollarBody = false;
  for (const raw of sql.split("\n")) {
    const line = raw.replace("\r", "");
    if (!inDollarBody && (line.trim() === "" || line.trim().startsWith("--"))) continue;
    current.push(line);
    if (line.split("$$").length % 2 === 0) inDollarBody = !inDollarBody;
    if (!inDollarBody && line.trimEnd().endsWith(";")) {
      out.push(current.join("\n"));
      current = [];
    }
  }
  return out;
}

const exists = (db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }, sql: string, params: unknown[] = []) => db.query(sql, params).then((r) => r.rows.length > 0);
async function run(db: { query: (sql: string) => Promise<unknown> }, sql: string) {
  for (const statement of statements(sql)) await db.query(statement);
}

describe("migration 0065 rollback", () => {
  it("restores the earlier support schema, keeps requests and messages, and can be applied again", async () => {
    const org = await createOrg();
    const user = await createUser();
    await expect(withSystem(async (db) => {
      const t = (await db.query<{ id: string }>(
        "insert into support_tickets (org_id, created_by, subject, category, status, request_type, feedback_stage) values ($1, $2, 'Feedback to roll back', 'improvement', 'new', 'feedback', 'received') returning id", [org.id, user.id],
      )).rows[0];
      const kept = (await db.query<{ id: string }>("insert into support_tickets (org_id, created_by, subject, category, status) values ($1, $2, 'Plain request to keep', 'billing', 'open') returning id", [org.id, user.id])).rows[0];
      await db.query("insert into support_messages (ticket_id, org_id, author_kind, body, internal) values ($1, $2, 'client', 'kept message', false), ($1, $2, 'agency', 'kept note', true)", [kept.id, org.id]);
      await db.query("insert into notifications (user_id, kind, title) values ($1, 'support_status', 'to be removed'), ($1, 'support_reply', 'to be kept')", [user.id]);

      await run(db, DOWN);

      // The new objects are gone.
      for (const table of ["support_ticket_events", "support_ticket_ops", "support_ticket_links", "support_settings", "support_notification_rules", "support_notification_log"]) {
        expect(await exists(db, "select 1 from pg_class where relname = $1 and relnamespace = 'public'::regnamespace", [table]), table).toBe(false);
      }
      expect(await exists(db, "select 1 from information_schema.columns where table_name = 'support_tickets' and column_name in ('request_type', 'diagnostics', 'idempotency_key', 'feedback_stage')")).toBe(false);
      expect(await exists(db, "select 1 from information_schema.columns where table_name = 'support_attachments' and column_name in ('message_id', 'status', 'expires_at')")).toBe(false);
      expect(await exists(db, "select 1 from pg_proc where proname = 'support_ticket_guard'")).toBe(false);
      expect(await exists(db, "select 1 from pg_policies where policyname in ('support_tickets_member_scope', 'support_messages_ticket_scope', 'support_attachments_ticket_scope')")).toBe(false);
      expect(await exists(db, "select 1 from role_permissions where permission = 'support.view_all' or permission like 'agency.support.%' and permission not in ('agency.support.view', 'agency.support.manage')")).toBe(false);

      // Requests and messages survive; the new status and category are converted to ones the earlier schema allows.
      expect((await db.query<{ status: string; category: string }>("select status, category from support_tickets where id = $1", [t.id])).rows[0]).toEqual({ status: "open", category: "general" });
      expect((await db.query<{ status: string; category: string }>("select status, category from support_tickets where id = $1", [kept.id])).rows[0]).toEqual({ status: "open", category: "billing" });
      expect((await db.query("select 1 from support_messages where ticket_id = $1", [kept.id])).rows).toHaveLength(2);
      expect((await db.query<{ title: string }>("select title from notifications where user_id = $1", [user.id])).rows.map((r) => r.title)).toEqual(["to be kept"]);
      await expect(db.query("savepoint s1")).resolves.toBeTruthy();
      await expect(db.query("insert into support_tickets (org_id, created_by, subject, status) values ($1, $2, 'bad status', 'new')", [org.id, user.id])).rejects.toThrow();
      await db.query("rollback to savepoint s1");

      // And it can be applied again on the rolled-back schema.
      await run(db, UP);
      expect(await exists(db, "select 1 from support_settings")).toBe(true);
      expect((await db.query<{ n: number }>("select count(*)::int as n from support_notification_rules")).rows[0].n).toBe(11);
      expect((await db.query<{ request_type: string }>("select request_type from support_tickets where id = $1", [kept.id])).rows[0].request_type).toBe("support");
      expect(await exists(db, "select 1 from role_permissions where permission = 'support.view_all' and role = 'owner'")).toBe(true);
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
  });

  it("leaves the migration file safe to read: no destructive statements against existing data", () => {
    // The up migration never drops a table, a column or a row of existing data; it only re-creates check constraints with a superset.
    expect(UP).not.toMatch(/\bdrop\s+table\b/i);
    expect(UP).not.toMatch(/\bdrop\s+column\b/i);
    expect(UP).not.toMatch(/\bdelete\s+from\b/i);
    expect(UP).not.toMatch(/\btruncate\b/i);
    const drops = [...UP.matchAll(/drop constraint (\w+)/gi)].map((m) => m[1]);
    expect(drops.sort()).toEqual([
      "agency_user_permission_overrides_permission_check", "invitation_agency_permission_overrides_permission_check", "notifications_kind_check",
      "support_tickets_category_check", "support_tickets_status_check",
    ]);
  });
});
