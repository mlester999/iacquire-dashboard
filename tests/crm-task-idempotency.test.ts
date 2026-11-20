import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { createContact } from "@/server/crm/contacts";
import { createTask, createTaskInTx } from "@/server/crm/tasks";
import { crmOrg, eventsFor, type CrmOrg } from "./support/crm";

const UP = readFileSync("supabase/migrations/0137_task_idempotency_key.sql", "utf8");
const DOWN = readFileSync("supabase/rollbacks/0137_task_idempotency_key.down.sql", "utf8");
class Done extends Error {}

function statements(sql: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let inside = false;
  for (const raw of sql.split("\n")) {
    const line = raw.replace("\r", "");
    if (!inside && (!line.trim() || line.trim().startsWith("--"))) continue;
    current.push(line);
    if (line.split("$$").length % 2 === 0) inside = !inside;
    if (!inside && line.trimEnd().endsWith(";")) {
      out.push(current.join("\n"));
      current = [];
    }
  }
  return out;
}

async function run(db: { query: (sql: string, params?: unknown[]) => Promise<unknown> }, sql: string) {
  for (const statement of statements(sql)) await db.query(statement);
}

let a: CrmOrg;
beforeAll(async () => { a = await crmOrg({ name: "Task Idempotency Co" }); });

describe("CRM task idempotency", () => {
  it("returns the existing task for the same key without repeating its event, activity or notification", async () => {
    const owner = a.actor("owner");
    const contact = await createContact(owner, { firstName: "Keyed", lastName: "Task" });
    const key = `test:${crypto.randomUUID()}`;
    const input = {
      title: "Call the prospect tomorrow", contactId: contact.id, assigneeId: a.people.sales.id,
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    };

    const first = await createTask(owner, input, { idempotencyKey: key });
    const retry = await createTask(owner, input, { idempotencyKey: key });

    expect(retry.id).toBe(first.id);
    expect(await withSystem(async (db) => ({
      tasks: (await db.query("select id from tasks where org_id = $1 and idempotency_key = $2", [a.org.id, key])).rows.length,
      activities: (await db.query("select id from crm_activities where org_id = $1 and ref_type = 'task' and ref_id = $2", [a.org.id, first.id])).rows.length,
      notifications: (await db.query("select id from notifications where org_id = $1 and user_id = $2 and kind = 'crm_assigned' and link = $3", [a.org.id, a.people.sales.id, `/crm/tasks?task=${first.id}`])).rows.length,
    }))).toEqual({ tasks: 1, activities: 1, notifications: 1 });
    expect((await eventsFor(a.org.id, "task.created")).filter((event) => event.entity_id === first.id)).toHaveLength(1);
  });

  it("collapses concurrent calls with one key and keeps distinct or null keys independent", async () => {
    const owner = a.actor("owner");
    const key = `parallel:${crypto.randomUUID()}`;
    const parallelInput = { title: "Parallel task" };
    const parallel = await Promise.all([
      createTaskInTxCall(owner, parallelInput, key),
      createTaskInTxCall(owner, parallelInput, key),
    ]);
    expect(new Set(parallel.map((result) => result.id)).size).toBe(1);
    expect(parallel.filter((result) => result.created)).toHaveLength(1);
    expect((await eventsFor(a.org.id, "task.created")).filter((event) => event.entity_id === parallel[0].id)).toHaveLength(1);

    const keyed = await Promise.all([
      createTaskInTxCall(owner, { title: "Independent keyed task" }, `different:${crypto.randomUUID()}`),
      createTaskInTxCall(owner, { title: "Independent keyed task" }, `different:${crypto.randomUUID()}`),
    ]);
    expect(new Set(keyed.map((result) => result.id)).size).toBe(2);

    const unkeyed = await Promise.all([
      withSystem((db) => createTaskInTx(db, owner, { title: "Unkeyed task" })),
      withSystem((db) => createTaskInTx(db, owner, { title: "Unkeyed task" })),
    ]);
    expect(new Set(unkeyed.map((result) => result.id)).size).toBe(2);
  });

  it("applies and rolls back migration 0137 in an isolated transaction", async () => {
    let result: { columnAfterUp: number; indexAfterUp: number; columnAfterDown: number } | undefined;
    await expect(withSystem(async (db) => {
      await db.query("drop index if exists tasks_org_idempotency_key");
      await db.query("alter table tasks drop column if exists idempotency_key");
      await run(db, UP);
      const columnAfterUp = (await db.query("select 1 from information_schema.columns where table_name = 'tasks' and column_name = 'idempotency_key'")).rows.length;
      const indexAfterUp = (await db.query("select 1 from pg_indexes where indexname = 'tasks_org_idempotency_key' and indexdef like '%WHERE (idempotency_key IS NOT NULL)%'")).rows.length;
      await run(db, DOWN);
      const columnAfterDown = (await db.query("select 1 from information_schema.columns where table_name = 'tasks' and column_name = 'idempotency_key'")).rows.length;
      result = { columnAfterUp, indexAfterUp, columnAfterDown };
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
    expect(result).toEqual({ columnAfterUp: 1, indexAfterUp: 1, columnAfterDown: 0 });
  });

  it("refuses migration 0137 rollback while a task key is stored", async () => {
    const actor = a.actor("owner");
    await expect(withSystem(async (db) => {
      await db.query("drop index if exists tasks_org_idempotency_key");
      await db.query("alter table tasks drop column if exists idempotency_key");
      await run(db, UP);
      await createTaskInTx(db, actor, { title: "Retained keyed task" }, { idempotencyKey: "rollback-retained-key" });
      await run(db, DOWN);
    })).rejects.toThrow(/Rollback refused: task idempotency keys exist/);
  });
});

function createTaskInTxCall(actor: ReturnType<CrmOrg["actor"]>, input: { title: string }, idempotencyKey: string) {
  return withSystem((db) => createTaskInTx(db, actor, input, { idempotencyKey }));
}
