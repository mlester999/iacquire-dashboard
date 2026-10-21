// Automation Studio foundation hardening: migration 0069 and its rollback in an isolated database (down, up again, and every refusal), usage
// metering of failures, retries and queued runs, tenant isolation of the new tables, and the entitlement gate on the one write path that does not
// go through the workflow services (applying a Blueprint). Every workflow only creates internal tasks; nothing leaves the machine.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/crm/workflows/executors", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/server/crm/workflows/executors")>();
  return { ...mod, executeStep: vi.fn(mod.executeStep) };
});

import { withSystem, withUser } from "@/server/db";
import { createContact } from "@/server/crm/contacts";
import { crmEventDispatch } from "@/server/crm/dispatch";
import { executeStep } from "@/server/crm/workflows/executors";
import { StepFailure } from "@/server/crm/workflows/engine";
import { createWorkflow, publishWorkflow, setWorkflowStatus } from "@/server/crm/workflows/definitions";
import { processWorkflowRuns } from "@/server/crm/workflows/runner";
import { updateRecord } from "@/server/crm/blueprints/native-io/write";
import { studioUsageSnapshot } from "@/server/automation-studio/usage";
import { WORKFLOW_LIMITS, type WorkflowDefinition, type WorkflowStep } from "@/lib/crm/workflow/spec";
import { uid } from "./support/fixtures";
import { crmOrg, type CrmOrg } from "./support/crm";

const UP = readFileSync("supabase/migrations/0069_automation_studio_foundation.sql", "utf8");
const DOWN = readFileSync("supabase/rollbacks/0069_automation_studio_foundation.down.sql", "utf8");
const UP_70 = readFileSync("supabase/migrations/0070_automation_studio_conversations.sql", "utf8");
const DOWN_70 = readFileSync("supabase/rollbacks/0070_automation_studio_conversations.down.sql", "utf8");
const UP_71 = readFileSync("supabase/migrations/0071_automation_studio_plan_lookup.sql", "utf8");
const DOWN_71 = readFileSync("supabase/rollbacks/0071_automation_studio_plan_lookup.down.sql", "utf8");
class Done extends Error {}
const DAY = 86_400_000;
const execMock = vi.mocked(executeStep);
const realExecuteStep = (await vi.importActual<typeof import("@/server/crm/workflows/executors")>("@/server/crm/workflows/executors")).executeStep;
// (A block body: a beforeEach that returns a function has that function run as its cleanup.)
beforeEach(() => {
  execMock.mockReset();
  execMock.mockImplementation(realExecuteStep);
});

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
type Tx = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };
const run = async (db: Tx, sql: string) => {
  for (const stmt of statements(sql)) await db.query(stmt);
};

// ---------------------------------------------------------------------------
// Migration 0069
// ---------------------------------------------------------------------------

describe("migration 0069 in an isolated database", () => {
  const shape = async (db: Tx) => {
    const q = async (sql: string) => (await db.query(sql)).rows;
    return {
      workflowColumns: (await q("select column_name from information_schema.columns where table_name = 'crm_workflows' and column_name in ('origin', 'entitlement_paused_at') order by 1")).map((r) => r.column_name),
      versionColumns: (await q("select column_name from information_schema.columns where table_name = 'crm_workflow_versions' and column_name = 'premium_features'")).length,
      planColumns: (await q("select column_name from information_schema.columns where table_name = 'maintenance_subscriptions' and column_name in ('past_due_since', 'grace_ends_at', 'expired_at', 'last_payment_verified_at', 'last_payment_verified_by', 'paid_through_on')")).length,
      tables: (await q("select table_name from information_schema.tables where table_name in ('automation_studio_usage', 'automation_studio_limits') order by 1")).map((r) => r.table_name),
      statusCheck: String((await q("select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'maintenance_subscriptions_status_check'"))[0]?.d ?? ""),
      frozen: String((await q("select pg_get_triggerdef(oid) as d from pg_trigger where tgname = 'crm_workflow_versions_frozen'"))[0]?.d ?? ""),
      openPlanIndex: String((await q("select indexdef from pg_indexes where indexname = 'maintenance_one_open_plan'"))[0]?.indexdef ?? ""),
    };
  };

  it("rolls back to exactly the previous schema and applies again, with nothing left behind either way", async () => {
    let applied: Awaited<ReturnType<typeof shape>> | null = null;
    let rolledBack: Awaited<ReturnType<typeof shape>> | null = null;
    let reapplied: Awaited<ReturnType<typeof shape>> | null = null;
    await expect(
      withSystem(async (db) => {
        applied = await shape(db);
        await run(db, DOWN);
        rolledBack = await shape(db);
        await run(db, UP);
        reapplied = await shape(db);
        throw new Done();
      }),
    ).rejects.toBeInstanceOf(Done);

    expect(applied).toMatchObject({ workflowColumns: ["entitlement_paused_at", "origin"], versionColumns: 1, planColumns: 6, tables: ["automation_studio_limits", "automation_studio_usage"] });
    expect(applied!.statusCheck).toMatch(/past_due/);
    expect(applied!.statusCheck).toMatch(/expired/);
    expect(applied!.frozen).toMatch(/premium_features/);
    expect(applied!.openPlanIndex).toMatch(/past_due/);

    // The rollback removes everything it added and restores the earlier plan states, trigger and index.
    expect(rolledBack).toMatchObject({ workflowColumns: [], versionColumns: 0, planColumns: 0, tables: [] });
    expect(rolledBack!.statusCheck).not.toMatch(/past_due|expired/);
    expect(rolledBack!.statusCheck).toMatch(/cancel_requested/);
    expect(rolledBack!.frozen).not.toMatch(/premium_features/);
    expect(rolledBack!.frozen).toMatch(/content_hash/);
    expect(rolledBack!.openPlanIndex).not.toMatch(/past_due/);

    // Applying it again lands on the same schema as the first time.
    expect(reapplied).toEqual(applied);
    // And the real database was not changed by any of it.
    const still = await withSystem(async (db) => (await db.query("select 1 from information_schema.tables where table_name = 'automation_studio_usage'")).rows.length);
    expect(still).toBe(1);
  });

  it("applies to a database that already holds workflows and plans, changing none of them", async () => {
    const o = await crmOrg();
    const sub = (await withSystem((db) =>
      db.query<{ id: string }>(
        "insert into maintenance_subscriptions (org_id, status, monthly_price_cents, monthly_request_allowance, terms_version, accepted_by, activated_at, billing_start_on) values ($1, 'active', 29900, 4, 't', $2, now(), current_date) returning id",
        [o.org.id, o.people.owner.id],
      ),
    )).rows[0].id;
    const { id } = await createWorkflow(o.actor("owner"), { name: `Existing ${uid()}`, definition: taskDef() });
    await publishWorkflow(o.actor("owner"), id);
    await expect(
      withSystem(async (db) => {
        const before = (await db.query("select w.id, w.name, w.status, w.draft, v.content_hash, v.effects from crm_workflows w join crm_workflow_versions v on v.workflow_id = w.id where w.id = $1", [id])).rows;
        await run(db, DOWN);
        await run(db, UP);
        const after = (await db.query("select w.id, w.name, w.status, w.draft, v.content_hash, v.effects from crm_workflows w join crm_workflow_versions v on v.workflow_id = w.id where w.id = $1", [id])).rows;
        expect(after).toEqual(before);
        expect((await db.query("select origin from crm_workflows where id = $1", [id])).rows[0]).toEqual({ origin: "crm" });
        expect((await db.query("select status from maintenance_subscriptions where id = $1", [sub])).rows[0]).toEqual({ status: "active" });
        throw new Done();
      }),
    ).rejects.toBeInstanceOf(Done);
  });

  describe("refuses to roll back while anything exists that only this migration can hold", () => {
    const refused = async (setup: (db: Tx, o: CrmOrg) => Promise<void>) => {
      const o = await crmOrg();
      await expect(
        withSystem(async (db) => {
          await setup(db, o);
          await run(db, DOWN);
          throw new Done();
        }),
      ).rejects.toThrow(/Rollback refused/);
    };
    const workflow = async (db: Tx, o: CrmOrg, origin = "crm") =>
      (await db.query("insert into crm_workflows (org_id, key, name, draft, origin) values ($1, $2, 'W', '{}'::jsonb, $3) returning id", [o.org.id, `w-${uid()}`, origin])).rows[0].id as string;
    const plan = async (db: Tx, o: CrmOrg, cols: string, vals: string) =>
      db.query(`insert into maintenance_subscriptions (org_id, status, monthly_price_cents, monthly_request_allowance, terms_version, accepted_by, activated_at, billing_start_on, ${cols}) values ($1, $3, 29900, 4, 't', $2, now(), current_date, ${vals})`, [o.org.id, o.people.owner.id, "active"]);

    it("a workflow built in Automation Studio", () => refused(async (db, o) => void (await workflow(db, o, "studio"))));
    it("a version that uses premium features", () =>
      refused(async (db, o) => {
        const w = await workflow(db, o);
        await db.query("insert into crm_workflow_versions (org_id, workflow_id, version, trigger_config, steps, content_hash, premium_features) values ($1, $2, 1, '{\"type\":\"contact.created\"}', '[]', $3, '{studio_workflow}')", [o.org.id, w, "b".repeat(64)]);
      }));
    it("a plan with payment-lifecycle history", () => refused(async (db, o) => void (await plan(db, o, "last_payment_verified_at", "now()"))));
    it("a plan that is past due", () =>
      refused(async (db, o) => void (await db.query(
        "insert into maintenance_subscriptions (org_id, status, monthly_price_cents, monthly_request_allowance, terms_version, accepted_by, activated_at, billing_start_on, past_due_since, grace_ends_at) values ($1, 'past_due', 29900, 4, 't', $2, now(), current_date, now(), now() + interval '3 days')",
        [o.org.id, o.people.owner.id],
      ))));
    it("usage counters", () => refused(async (db, o) => void (await db.query("insert into automation_studio_usage (org_id, period_month, metric, quantity) values ($1, '2026-10-01', 'runs_started', 1)", [o.org.id]))));
    it("a workspace's own limits", () => refused(async (db, o) => void (await db.query("insert into automation_studio_limits (org_id, monthly_runs) values ($1, 10)", [o.org.id]))));
  });
});

const taskDef = (title = "Follow up"): WorkflowDefinition => ({
  trigger: { type: "contact.created" },
  steps: [{ key: "task", kind: "create_task", config: { title, priority: "normal", assignee: "none" }, next: null }] as WorkflowStep[],
});

// ---------------------------------------------------------------------------
// Metering of failures, retries and queued runs
// ---------------------------------------------------------------------------

async function grantPlan(o: CrmOrg) {
  await withSystem((db) =>
    db.query(
      "insert into maintenance_subscriptions (org_id, status, monthly_price_cents, monthly_request_allowance, terms_version, accepted_by, activated_at, billing_start_on) values ($1, 'active', 29900, 4, 'test', $2, now() - interval '30 days', current_date - 30)",
      [o.org.id, o.people.owner.id],
    ),
  );
}
async function premiumWorkflow(o: CrmOrg, definition = taskDef()) {
  const actor = o.actor("owner");
  const { id } = await createWorkflow(actor, { name: `Meter ${uid()}`, definition, origin: "studio" });
  await publishWorkflow(actor, id);
  await setWorkflowStatus(actor, id, "active");
  return id;
}
const usage = (o: CrmOrg) => withSystem((db) => studioUsageSnapshot(db, o.org.id)).then((u) => Object.fromEntries(Object.entries(u.counters).map(([k, v]) => [k, v.quantity])) as Record<string, number>);
const runRow = async (workflowId: string) => (await withSystem((db) => db.query<{ status: string; attempts: number; last_error: string | null }>("select status, attempts, last_error from crm_workflow_runs where workflow_id = $1", [workflowId]))).rows[0];

describe("usage metering of failures and retries", () => {
  async function oneRun() {
    const o = await crmOrg();
    await grantPlan(o);
    const w = await premiumWorkflow(o);
    await createContact(o.actor("owner"), { firstName: "Lead", lastName: uid() });
    for (let i = 0; i < 5; i++) if (!(await crmEventDispatch()).claimed) break;
    return { o, w };
  }
  const failRetryably = () => {
    throw new StepFailure("The outside service is busy.", { retryable: true });
  };

  it("counts a retryable failure and its retry once each, and the step only when it finally ran", async () => {
    const { o, w } = await oneRun();
    execMock.mockImplementationOnce(failRetryably);
    const t0 = new Date();
    await processWorkflowRuns({ now: t0 });
    expect(await runRow(w)).toMatchObject({ status: "queued", attempts: 1 });
    expect(await usage(o)).toMatchObject({ runs_started: 1, step_failures: 1, step_retries: 1, steps_executed: 0 });
    await processWorkflowRuns({ now: new Date(t0.getTime() + 2 * 60_000) });
    expect(await runRow(w)).toMatchObject({ status: "completed" });
    expect(await usage(o)).toMatchObject({ runs_started: 1, step_failures: 1, step_retries: 1, steps_executed: 1 });
  });

  it("counts every failed attempt of a run that is given up, and one fewer retry than attempts", async () => {
    const { o, w } = await oneRun();
    execMock.mockImplementation(failRetryably);
    for (let i = 0; i < WORKFLOW_LIMITS.maxAttempts + 2; i++) await processWorkflowRuns({ now: new Date(Date.now() + (i + 1) * DAY) });
    expect(await runRow(w)).toMatchObject({ status: "dead", attempts: WORKFLOW_LIMITS.maxAttempts });
    expect(await usage(o)).toMatchObject({ runs_started: 1, step_failures: WORKFLOW_LIMITS.maxAttempts, step_retries: WORKFLOW_LIMITS.maxAttempts - 1, steps_executed: 0 });
  });

  it("counts a failure that retrying cannot fix once, and no retry", async () => {
    const { o, w } = await oneRun();
    execMock.mockImplementationOnce(() => {
      throw new StepFailure("The tag was deleted.");
    });
    await processWorkflowRuns({});
    expect(await runRow(w)).toMatchObject({ status: "failed" });
    expect(await usage(o)).toMatchObject({ step_failures: 1, step_retries: 0, steps_executed: 0 });
  });

  it("counts queued and waiting runs toward the runs-in-progress figure, and finished ones not", async () => {
    const o = await crmOrg();
    await grantPlan(o);
    await premiumWorkflow(o, {
      trigger: { type: "contact.created" },
      steps: [
        { key: "pause", kind: "wait", config: { mode: "duration", amount: 1, unit: "days" }, next: "task" },
        { key: "task", kind: "create_task", config: { title: "After", priority: "normal", assignee: "none" }, next: null },
      ] as WorkflowStep[],
    });
    for (let i = 0; i < 3; i++) await createContact(o.actor("owner"), { firstName: "Lead", lastName: uid() });
    for (let i = 0; i < 5; i++) if (!(await crmEventDispatch()).claimed) break;
    const live = async () => (await withSystem((db) => studioUsageSnapshot(db, o.org.id))).lines.find((l) => l.key === "maxLiveRuns")!.used;
    expect(await live()).toBe(3); // queued
    await processWorkflowRuns({});
    expect(await live()).toBe(3); // waiting
    await processWorkflowRuns({ now: new Date(Date.now() + 2 * DAY) });
    expect(await live()).toBe(0); // completed
    expect((await usage(o)).steps_executed).toBe(6);
  });

  it("counts a workspace's work against its own figures only", async () => {
    const a = await oneRun();
    const b = await oneRun();
    await processWorkflowRuns({});
    expect(await usage(a.o)).toMatchObject({ runs_started: 1, steps_executed: 1 });
    expect(await usage(b.o)).toMatchObject({ runs_started: 1, steps_executed: 1 });
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

describe("tenant isolation of the new tables", () => {
  it("shows a workspace's counters and limits only to people who can see its automations", async () => {
    const a = await crmOrg();
    const b = await crmOrg();
    await withSystem(async (db) => {
      await db.query("insert into automation_studio_usage (org_id, period_month, metric, quantity) values ($1, '2026-10-01', 'runs_started', 7), ($2, '2026-10-01', 'runs_started', 9)", [a.org.id, b.org.id]);
      await db.query("insert into automation_studio_limits (org_id, monthly_runs) values ($1, 11), ($2, 13)", [a.org.id, b.org.id]);
    });
    const seen = (userId: string) =>
      withUser(userId, async (db) => ({
        usage: (await db.query<{ org_id: string; quantity: string }>("select org_id, quantity::text from automation_studio_usage")).rows,
        limits: (await db.query<{ org_id: string; monthly_runs: number }>("select org_id, monthly_runs from automation_studio_limits")).rows,
      }));
    const ownerA = await seen(a.people.owner.id);
    expect(ownerA.usage).toEqual([{ org_id: a.org.id, quantity: "7" }]);
    expect(ownerA.limits).toEqual([{ org_id: a.org.id, monthly_runs: 11 }]);
    const managerB = await seen(b.people.manager.id);
    expect(managerB.usage).toEqual([{ org_id: b.org.id, quantity: "9" }]);
    // Someone in the workspace without "See automations" sees nothing, and nobody can write.
    expect(await seen(a.people.viewer.id)).toEqual({ usage: [], limits: [] });
    await expect(withUser(a.people.owner.id, (db) => db.query("update automation_studio_usage set quantity = 0 where org_id = $1", [a.org.id]))).rejects.toThrow();
    await expect(withUser(a.people.owner.id, (db) => db.query("insert into automation_studio_limits (org_id, monthly_runs) values ($1, 1)", [b.org.id]))).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Migration 0070 and the conversation tables
// ---------------------------------------------------------------------------

describe("migration 0070 (conversations and change history)", () => {
  const tables = async (db: Tx) => (await db.query("select table_name from information_schema.tables where table_name in ('automation_studio_messages', 'automation_studio_changes') order by 1")).rows.map((r) => String(r.table_name));
  const loose = async (db: Tx, orgId: string) =>
    (await db.query("insert into crm_workflows (org_id, key, name, draft, origin) values ($1, $2, 'W', '{}'::jsonb, 'studio') returning id", [orgId, `w-${uid()}`])).rows[0].id as string;
  const message = (db: Tx, orgId: string, workflowId: string, content: string) =>
    db.query("insert into automation_studio_messages (org_id, workflow_id, role, content) values ($1, $2, 'user', $3) returning id", [orgId, workflowId, content]);

  it("rolls back and applies again, leaving the real database as it was", async () => {
    const seen: Array<string[]> = [];
    await expect(
      withSystem(async (db) => {
        seen.push(await tables(db));
        await run(db, DOWN_70);
        seen.push(await tables(db));
        await run(db, UP_70);
        seen.push(await tables(db));
        throw new Done();
      }),
    ).rejects.toBeInstanceOf(Done);
    expect(seen).toEqual([["automation_studio_changes", "automation_studio_messages"], [], ["automation_studio_changes", "automation_studio_messages"]]);
    expect(await withSystem((db) => tables(db))).toHaveLength(2);
  });

  it("refuses to roll back while a conversation or a change exists", async () => {
    const o = await crmOrg();
    await expect(withSystem(async (db) => { await message(db, o.org.id, await loose(db, o.org.id), "Hello"); await run(db, DOWN_70); throw new Done(); })).rejects.toThrow(/Rollback refused/);
    await expect(
      withSystem(async (db) => {
        const w = await loose(db, o.org.id);
        await db.query("insert into automation_studio_changes (org_id, workflow_id, seq, source, label, definition, revision) values ($1, $2, 1, 'manual', 'Started', '{}'::jsonb, 1)", [o.org.id, w]);
        await run(db, DOWN_70);
        throw new Done();
      }),
    ).rejects.toThrow(/Rollback refused/);
  });

  it("keeps a workspace's conversation and history to people who can see its automations, and lets no one write them from outside the server", async () => {
    const a = await crmOrg();
    const b = await crmOrg();
    await withSystem(async (db) => {
      await message(db, a.org.id, await loose(db, a.org.id), "Mine");
      await message(db, b.org.id, await loose(db, b.org.id), "Theirs");
    });
    const seen = (userId: string) => withUser(userId, async (db) => (await db.query<{ content: string }>("select content from automation_studio_messages order by id")).rows.map((r) => r.content));
    expect(await seen(a.people.owner.id)).toEqual(["Mine"]);
    expect(await seen(b.people.manager.id)).toEqual(["Theirs"]);
    expect(await seen(a.people.viewer.id)).toEqual([]);
    await expect(withUser(a.people.owner.id, (db) => db.query("update automation_studio_messages set content = 'x'"))).rejects.toThrow();
    await expect(withUser(a.people.owner.id, (db) => db.query("delete from automation_studio_messages"))).rejects.toThrow();
  });

  it("deletes a workflow's conversation and history with it, and nothing else's", async () => {
    const o = await crmOrg();
    await withSystem(async (db) => {
      const w1 = await loose(db, o.org.id);
      const w2 = await loose(db, o.org.id);
      await message(db, o.org.id, w1, "One");
      await message(db, o.org.id, w2, "Two");
      await db.query("insert into automation_studio_changes (org_id, workflow_id, seq, source, label, definition, revision) values ($1, $2, 1, 'manual', 'Started', '{}'::jsonb, 1)", [o.org.id, w1]);
      await db.query("delete from crm_workflows where id = $1", [w1]);
      expect((await db.query("select content from automation_studio_messages where org_id = $1", [o.org.id])).rows).toEqual([{ content: "Two" }]);
      expect((await db.query("select 1 from automation_studio_changes where org_id = $1", [o.org.id])).rows).toEqual([]);
    });
  });
});

describe("migration 0071 (the shell's plan lookup)", () => {
  const present = async (db: Tx) => (await db.query("select to_regprocedure('app.automation_studio_plan(uuid)') is not null as present")).rows[0].present;

  it("rolls back to nothing and applies again", async () => {
    const seen: unknown[] = [];
    await expect(withSystem(async (db) => { seen.push(await present(db)); await run(db, DOWN_71); seen.push(await present(db)); await run(db, UP_71); seen.push(await present(db)); throw new Done(); })).rejects.toBeInstanceOf(Done);
    expect(seen).toEqual([true, false, true]);
  });

  it("answers only for people who can see the workspace's automations, and with nothing beyond the plan's four facts", async () => {
    const a = await crmOrg();
    const b = await crmOrg();
    await grantPlan(a);
    await grantPlan(b);
    const lookup = (userId: string, orgId: string) => withUser(userId, async (db) => (await db.query<{ p: Record<string, unknown> | null }>("select app.automation_studio_plan($1) as p", [orgId])).rows[0].p);
    const mine = await lookup(a.people.owner.id, a.org.id);
    expect(Object.keys(mine!).sort()).toEqual(["created_at", "grace_ends_at", "id", "paid_through_on", "status"]);
    expect(mine!.status).toBe("active");
    expect(await lookup(a.people.owner.id, b.org.id)).toBeNull();
    expect(await lookup(a.people.viewer.id, a.org.id)).toBeNull();
    // The table's own grants are unchanged: the lifecycle columns still can't be read directly.
    await expect(withUser(a.people.owner.id, (db) => db.query("select grace_ends_at from maintenance_subscriptions"))).rejects.toThrow(/permission denied/);
  });
});

// ---------------------------------------------------------------------------
// Applying a Blueprint does not get around the plan
// ---------------------------------------------------------------------------

describe("Blueprints and the plan", () => {
  it("won't change the working copy of a workflow built in Automation Studio once the plan has lapsed", async () => {
    const o = await crmOrg();
    await grantPlan(o);
    const id = await premiumWorkflow(o);
    const entry = { type: "workflow", id, name: "W", parentId: null, archived: false, meta: {}, record: {} } as never;
    const record = { key: "w", name: "Changed by a Blueprint", description: null, folderId: null, hourlyRunLimit: 100, draft: taskDef("From a Blueprint") } as never;
    const ctx = (db: Tx) => ({ db: db as never, orgId: o.org.id, userId: null, listOwnerId: o.people.owner.id, reportOwnerId: null, defaultCallingCode: null });

    // With the plan it is allowed (the draft changes, nothing is published or switched on).
    await withSystem(async (db) => {
      await updateRecord(ctx(db), entry, record);
      expect(((await db.query<{ name: string }>("select name from crm_workflows where id = $1", [id])).rows[0]).name).toBe("Changed by a Blueprint");
    });
    await withSystem((db) => db.query("update maintenance_subscriptions set status = 'expired', expired_at = now() where org_id = $1", [o.org.id]));
    await expect(withSystem((db) => updateRecord(ctx(db), entry, { ...(record as object), name: "Changed again" } as never))).rejects.toMatchObject({ code: "plan_required" });
    expect(((await withSystem((db) => db.query<{ name: string }>("select name from crm_workflows where id = $1", [id]))).rows[0]).name).toBe("Changed by a Blueprint");
  });

  it("still updates a CRM workflow without any plan", async () => {
    const o = await crmOrg();
    const actor = o.actor("owner");
    const { id } = await createWorkflow(actor, { name: `Core ${uid()}`, definition: taskDef() });
    const entry = { type: "workflow", id, name: "W", parentId: null, archived: false, meta: {}, record: {} } as never;
    const record = { key: "w", name: "Core, changed", description: null, folderId: null, hourlyRunLimit: 100, draft: taskDef("Core change") } as never;
    await withSystem(async (db) => {
      await updateRecord({ db: db as never, orgId: o.org.id, userId: null, listOwnerId: o.people.owner.id, reportOwnerId: null, defaultCallingCode: null }, entry, record);
      expect(((await db.query<{ name: string }>("select name from crm_workflows where id = $1", [id])).rows[0]).name).toBe("Core, changed");
    });
  });
});
