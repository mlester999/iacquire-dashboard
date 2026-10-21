import fs from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";

// Counts the SQL statements each tool sends. pingDb talks to the driver directly and is added by hand where it applies.
const counter = vi.hoisted(() => ({ n: 0 }));
vi.mock("@/server/db", async (original) => {
  const actual = await original<typeof import("@/server/db")>();
  type Q = import("@/server/db").Queryable;
  const wrap = (db: Q): Q => ({ query: ((sql: string, params?: unknown[]) => { counter.n += 1; return db.query(sql, params); }) as Q["query"] });
  return {
    ...actual,
    readSystem: <T,>(fn: (db: Q) => Promise<T>) => actual.readSystem((db) => fn(wrap(db))),
    withSystem: <T,>(fn: (db: Q) => Promise<T>) => actual.withSystem((db) => fn(wrap(db))),
    withUser: <T,>(id: string, fn: (db: Q) => Promise<T>, o?: { statementTimeout?: string }) => actual.withUser(id, (db) => fn(wrap(db)), o),
  };
});

import { withSystem } from "@/server/db";
import { createOpsRun, OPS_LIMITS } from "@/server/aqi/ops/executor";
import { findReadTool, OPS_TOOLS } from "@/server/aqi/ops/registry";
import { resolveOpsScope } from "@/server/aqi/ops/scope";
import { PLATFORM_SCOPE, type OpsScope } from "@/lib/aqi/ops/types";
import { createOrg } from "./support/fixtures";
import { supportWorld, type SupportWorld } from "./support/support-world";

let w: SupportWorld;
let tenant: OpsScope;
const ORGS = 60;

beforeAll(async () => {
  w = await supportWorld();
  for (let i = 0; i < ORGS; i += 1) await createOrg({ name: `Perf Client ${i}` });
  tenant = await resolveOpsScope(w.agency.superAdmin, { type: "tenant", id: w.org.id });
  await withSystem(async (db) => {
    const owner = w.people.owner.id;
    await db.query(
      `insert into support_tickets (org_id, created_by, subject, category, priority, status, request_type)
       select (select id from organizations where name = 'Perf Client ' || (g % ${ORGS})), $1, 'Customers cannot save contact notes number ' || g, 'general',
              (array['low','normal','high','urgent'])[1 + g % 4], 'open', 'support'
         from generate_series(1, 600) g`,
      [owner],
    );
    await db.query(
      `insert into incidents (org_id, source, subject, dedupe_key, severity, title)
       select (select id from organizations where name = 'Perf Client ' || (g % ${ORGS})), 'queue', 'q', 'perf:' || g, (array['info','warning','critical'])[1 + g % 3], 'Perf incident ' || g
         from generate_series(1, 400) g`,
    );
    await db.query(
      `insert into agent_runs (org_id, agent_instance_id, purpose, idempotency_key, status, error_code, started_at, finished_at)
       select a.org_id, a.id, 'chat', 'perf-run-' || row_number() over (), (array['completed','failed','completed'])[1 + (row_number() over ()) % 3]::text, null, now() - interval '2 hours', now() - interval '2 hours'
         from agent_instances a cross join generate_series(1, 5)`,
    );
    await db.query(
      `insert into approval_requests (org_id, kind, title, risk, status, created_at)
       select (select id from organizations where name = 'Perf Client ' || (g % ${ORGS})), 'outreach', 'Perf approval ' || g, 'medium', 'pending', now() - (g || ' minutes')::interval from generate_series(1, 300) g`,
    );
    await db.query(
      `insert into audit_logs (actor_kind, action, result, ip_hash, created_at)
       select 'system', (array['auth.login','team.role_changed','data.exported'])[1 + g % 3], (array['success','failure'])[1 + g % 2], 'hash-' || (g % 40), now() - (g % 20000 || ' seconds')::interval from generate_series(1, 6000) g`,
    );
  });
}, 300_000);

const BUDGET: Record<string, number> = {
  "platform.health": 6, "platform.incidents": 2, "platform.jobs": 3, "workspace.directory": 2, "workspace.find": 1, "workspace.summary": 4, "workforce.status": 2, "workforce.runs": 2,
  "workforce.approvals": 2, "support.queue": 8, "support.ticket": 10, "support.duplicates": 2, "support.draft_reply": 12, "security.events": 3, "business.summary": 14, "business.client_costs": 2,
  "integrations.status": 4, "integrations.trace": 2, "release.info": 3, "product.requests": 2, "briefing.compose": 14, "aqi.telemetry": 3,
};

describe("AQi Operations stays light as data grows", () => {
  const rows: Array<{ tool: string; ms: number; statements: number; bytes: number; cards: number }> = [];

  it("bounds the statements, time and payload of every read tool on a database with hundreds of records", async () => {
    const ticket = await resolveOpsScope(w.agency.superAdmin, { type: "ticket", id: (await withSystem((db) => db.query<{ id: string }>("select id from support_tickets limit 1"))).rows[0].id });
    for (const tool of OPS_TOOLS.filter((t) => t.kind === "read")) {
      const scope = tool.scopes.includes("platform") ? PLATFORM_SCOPE : tool.scopes.includes("tenant") ? tenant : ticket;
      const run = await createOpsRun({ user: w.agency.superAdmin, scope, signal: new AbortController().signal, plannedToolIds: [tool.id] });
      counter.n = 0;
      const outcome = await run.runTool(tool.id, tool.id === "workspace.find" ? { names: ["Perf Client 7"] } : {});
      const statements = counter.n + (tool.id === "platform.health" || tool.id === "briefing.compose" ? 1 : 0);
      await run.flushAudit();
      expect(["ok", "partial"], `${tool.id}: ${outcome.run.note}`).toContain(outcome.run.status);
      const bytes = JSON.stringify({ data: outcome.data, cards: outcome.cards, summary: outcome.summary }).length;
      rows.push({ tool: tool.id, ms: outcome.run.durationMs ?? 0, statements, bytes, cards: outcome.cards.length });
      expect(statements, `${tool.id} sent ${statements} statements`).toBeLessThanOrEqual(BUDGET[tool.id] ?? 4);
      expect(bytes, `${tool.id} returned ${bytes} bytes`).toBeLessThan(70_000);
      expect(outcome.run.durationMs ?? 0, `${tool.id} took ${outcome.run.durationMs} ms`).toBeLessThan(4_000);
    }
    if (process.env.AQI_OPS_PERF_REPORT) fs.writeFileSync(process.env.AQI_OPS_PERF_REPORT, JSON.stringify({ orgs: ORGS + 2, tickets: 600, incidents: 400, approvals: 300, auditRows: 6000, rows }, null, 2));
  }, 240_000);

  it("paginates: lists are capped and say how many more exist", async () => {
    const queue = await createOpsRun({ user: w.agency.superAdmin, scope: PLATFORM_SCOPE, signal: new AbortController().signal, plannedToolIds: ["support.queue", "workforce.status", "platform.incidents", "workforce.approvals", "workspace.directory"] });
    const support = await queue.runTool("support.queue", { limit: 8 });
    const card = support.cards.find((c) => c.kind === "tickets");
    expect(card && card.kind === "tickets" && card.total).toBeGreaterThan(500);
    expect(card && card.kind === "tickets" && card.rows.length).toBe(8);
    const employees = await queue.runTool("workforce.status", { limit: 12 });
    const empCard = employees.cards[0];
    expect(empCard.kind === "employees" && empCard.rows.length).toBe(12);
    expect(empCard.kind === "employees" && empCard.truncated).toBe(true);
    const incidents = await queue.runTool("platform.incidents", { limit: 10 });
    const inc = incidents.cards[0];
    expect(inc.kind === "incidents" && inc.rows.length).toBe(10);
    expect(inc.kind === "incidents" && inc.truncated).toBe(true);
    const approvals = await queue.runTool("workforce.approvals", { limit: 10 });
    expect(JSON.stringify(approvals.data)).toContain('"total":300');
    const directory = await queue.runTool("workspace.directory", { limit: 15 });
    const table = directory.cards[0];
    expect(table.kind === "table" && table.rows.length).toBe(15);
    expect(table.kind === "table" && table.truncated).toBe(true);
    // Asking for more than the cap is refused rather than silently honoured.
    expect((await queue.runTool("support.queue", { limit: 500 })).run.status).toBe("error");
  });

  it("limits concurrency, times a slow check out, and isolates one failing check from the rest", async () => {
    const tool = findReadTool("platform.jobs")!;
    const originalRun = tool.run;
    const originalTimeout = tool.timeoutMs;
    let active = 0;
    let peak = 0;
    tool.run = async (...args) => { active += 1; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 60)); try { return await originalRun(...args); } finally { active -= 1; } };
    try {
      const run = await createOpsRun({ user: w.agency.superAdmin, scope: PLATFORM_SCOPE, signal: new AbortController().signal, plannedToolIds: ["platform.jobs"] });
      const results = await Promise.all(Array.from({ length: 8 }, () => run.runTool("platform.jobs", {})));
      expect(results.every((r) => r.run.status === "ok" || r.run.status === "partial")).toBe(true);
      expect(peak).toBeLessThanOrEqual(OPS_LIMITS.concurrentTools);

      tool.run = () => new Promise(() => undefined);
      (tool as { timeoutMs: number }).timeoutMs = 150;
      const started = Date.now();
      const slow = await run.runTool("platform.jobs", {});
      expect(slow.run.status).toBe("timeout");
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(slow.cards).toHaveLength(0);

      tool.run = async () => { throw new Error("boom: token=sk-live1234567890abcdef"); };
      const [broken, healthy] = await Promise.all([run.runTool("platform.jobs", {}), createOpsRun({ user: w.agency.superAdmin, scope: PLATFORM_SCOPE, signal: new AbortController().signal, plannedToolIds: ["release.info"] }).then((r) => r.runTool("release.info", {}))]);
      expect(broken.run.status).toBe("error");
      expect(JSON.stringify(broken)).not.toMatch(/sk-live|boom/);
      expect(healthy.run.status).toBe("ok");
    } finally {
      tool.run = originalRun;
      (tool as { timeoutMs: number }).timeoutMs = originalTimeout;
    }
  });

  it("caps tool runs per turn", () => {
    expect(OPS_LIMITS.toolsPerTurn).toBe(6);
    expect(OPS_LIMITS.concurrentTools).toBe(2);
  });
});
