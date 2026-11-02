// Migration 0118: the audit trail stays append-only, with ONE exception. While a purge of a departed client's data has declared itself (iaq.purge, which only offboarding sets), an audit row
// may lose its pointer to an employee that is being deleted, and nothing else about it may change. Without that, deleting a provisioned client's employees was refused by the database
// ("audit_logs is append-only") and the whole deletion stopped. The rollback restores the unconditional rule. Each case that changes the rule runs in a transaction that is rolled back.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withSystem, type Queryable } from "@/server/db";
import { recordAudit } from "@/server/audit";
import { agentId, createOrg, uid } from "./support/fixtures";

class Done extends Error {}
const up = readFileSync("supabase/migrations/0118_audit_logs_purge_detach.sql", "utf8");
const down = readFileSync("supabase/rollbacks/0118_audit_logs_purge_detach.down.sql", "utf8");

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
async function inRolledBackTransaction(body: (db: Queryable) => Promise<void>) {
  await expect(withSystem(async (db) => {
    await body(db);
    throw new Done();
  })).rejects.toBeInstanceOf(Done);
}
const attempt = async (db: Queryable, sql: string, params: unknown[] = []) => {
  await db.query("savepoint attempt");
  try {
    await db.query(sql, params);
    await db.query("release savepoint attempt");
    return "allowed";
  } catch (error) {
    await db.query("rollback to savepoint attempt");
    return String((error as Error).message);
  }
};

/** A workspace with one employee and one audit row that names it. */
async function workspace() {
  const org = await createOrg({ name: `Audit Detach ${uid()}` });
  const agent = await agentId(org.id, "lead_hunter");
  await recordAudit({ orgId: org.id, actorKind: "system", agentInstanceId: agent, action: "test.audit_detach", targetType: "test", targetId: "row-1", result: "success", metadata: { note: "kept" } });
  const row = (await withSystem((db) => db.query<{ id: string }>("select id from audit_logs where org_id = $1 and action = 'test.audit_detach'", [org.id]))).rows[0];
  return { org, agent, auditId: row.id };
}

describe("the audit trail is append-only, with one narrow exception", () => {
  it("refuses every update and delete when no purge has declared itself", async () => {
    const w = await workspace();
    await inRolledBackTransaction(async (db) => {
      expect(await attempt(db, "update audit_logs set agent_instance_id = null where id = $1", [w.auditId])).toMatch(/append-only/);
      expect(await attempt(db, "update audit_logs set action = 'tampered' where id = $1", [w.auditId])).toMatch(/append-only/);
      expect(await attempt(db, "delete from audit_logs where id = $1", [w.auditId])).toMatch(/append-only/);
    });
  });

  it("with a purge declared, allows only detaching the employee pointer, and nothing else", async () => {
    const w = await workspace();
    await inRolledBackTransaction(async (db) => {
      await db.query("select set_config('iaq.purge', 'on', true)");
      // Any other column, a delete, or pointing at another employee is still refused.
      expect(await attempt(db, "update audit_logs set action = 'tampered' where id = $1", [w.auditId])).toMatch(/append-only/);
      expect(await attempt(db, "update audit_logs set agent_instance_id = null, metadata = '{}'::jsonb where id = $1", [w.auditId])).toMatch(/append-only/);
      expect(await attempt(db, "update audit_logs set agent_instance_id = null, result = 'failure' where id = $1", [w.auditId])).toMatch(/append-only/);
      expect(await attempt(db, "delete from audit_logs where id = $1", [w.auditId])).toMatch(/append-only/);
      const other = (await db.query<{ id: string }>("select id from agent_instances where org_id = $1 and id <> $2 limit 1", [w.org.id, w.agent])).rows[0].id;
      expect(await attempt(db, "update audit_logs set agent_instance_id = $2 where id = $1", [w.auditId, other])).toMatch(/append-only/);
      // The one allowed change.
      expect(await attempt(db, "update audit_logs set agent_instance_id = null where id = $1", [w.auditId])).toBe("allowed");
      const kept = (await db.query<{ action: string; result: string; metadata: { note: string }; agent_instance_id: string | null }>("select action, result, metadata, agent_instance_id from audit_logs where id = $1", [w.auditId])).rows[0];
      expect(kept).toEqual({ action: "test.audit_detach", result: "success", metadata: { note: "kept" }, agent_instance_id: null });
      // And once detached it cannot be pointed anywhere again.
      expect(await attempt(db, "update audit_logs set agent_instance_id = $2 where id = $1", [w.auditId, w.agent])).toMatch(/append-only/);
    });
  });

  it("lets a purge delete the employee and keeps its audit rows, and refuses the deletion without a purge", async () => {
    const w = await workspace();
    await inRolledBackTransaction(async (db) => {
      expect(await attempt(db, "delete from agent_instances where id = $1", [w.agent])).toMatch(/append-only/);
      await db.query("select set_config('iaq.purge', 'on', true)");
      expect(await attempt(db, "delete from agent_instances where id = $1", [w.agent])).toBe("allowed");
      const kept = (await db.query<{ agent_instance_id: string | null; action: string }>("select agent_instance_id, action from audit_logs where id = $1", [w.auditId])).rows;
      expect(kept).toEqual([{ agent_instance_id: null, action: "test.audit_detach" }]);
    });
  });

  it("is restored to the unconditional rule by the rollback, and can be applied again", async () => {
    const w = await workspace();
    await inRolledBackTransaction(async (db) => {
      await run(db, down);
      await db.query("select set_config('iaq.purge', 'on', true)");
      expect(await attempt(db, "update audit_logs set agent_instance_id = null where id = $1", [w.auditId])).toMatch(/append-only/);
      expect(await attempt(db, "delete from agent_instances where id = $1", [w.agent])).toMatch(/append-only/);
      await run(db, up);
      expect(await attempt(db, "update audit_logs set agent_instance_id = null where id = $1", [w.auditId])).toBe("allowed");
    });
  });
});
