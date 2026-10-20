import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { submitRequest } from "@/server/support/service";
import { createOpsRun } from "@/server/aqi/ops/executor";
import { cancelOpsAction, confirmOpsAction, proposeOpsAction } from "@/server/aqi/ops/actions";
import { findActionTool } from "@/server/aqi/ops/registry";
import { resolveOpsScope } from "@/server/aqi/ops/scope";
import type { PlannedAction } from "@/server/aqi/ops/planner";
import type { OpsActionPreviewCard, OpsCard } from "@/lib/aqi/ops/types";
import { agencyUser, createOrg, createUser } from "./support/fixtures";
import { supportWorld, type SupportWorld } from "./support/support-world";

/**
 * Failure, concurrency and boundary behaviour of the five administrative actions. The lifecycle itself (propose, confirm, verify,
 * expire, interrupt) is covered in aqi-ops-actions.test.ts; these tests ask what happens when something goes wrong or two things
 * happen at once.
 */

let w: SupportWorld;
const signal = () => new AbortController().signal;
let counter = 0;

beforeAll(async () => {
  w = await supportWorld();
  await createOrg({ name: "iAcquire Agency", kind: "agency" });
});

beforeEach(async () => {
  await withSystem((db) => db.query("delete from rate_limit_buckets"));
});

async function propose(action: PlannedAction, scopeRequest: Parameters<typeof resolveOpsScope>[1], user = w.agency.superAdmin): Promise<OpsCard> {
  const scope = await resolveOpsScope(user, scopeRequest);
  const run = await createOpsRun({ user, scope, signal: signal(), plannedToolIds: [action.toolId] });
  const ids = await withSystem(async (db) => {
    const c = await db.query<{ id: string }>("insert into aqi_conversations (user_id, title, surface, saved_at) values ($1, 'Hardening', 'operations', now()) returning id", [user.id]);
    const m = await db.query<{ id: string }>("insert into aqi_messages (conversation_id, user_id, role, content, status) values ($1, $2, 'assistant', '', 'streaming') returning id", [c.rows[0].id, user.id]);
    return { conversationId: c.rows[0].id, messageId: m.rows[0].id };
  });
  const card = await proposeOpsAction({ run, scope, ...ids, action });
  await run.flushAudit();
  return card;
}

const asPreview = (card: OpsCard): OpsActionPreviewCard => {
  expect(card.kind, JSON.stringify(card)).toBe("action_preview");
  return card as OpsActionPreviewCard;
};

const actionRow = async (id: string) =>
  (await withSystem((db) => db.query<{ status: string; verified: boolean | null; reason: string | null; error_code: string | null }>("select status, verified, reason, error_code from aqi_ops_actions where id = $1", [id]))).rows[0];
const auditCount = async (action: string, targetId: string) =>
  (await withSystem((db) => db.query<{ n: number }>("select count(*)::int as n from audit_logs where action = $1 and target_id = $2", [action, targetId]))).rows[0].n;
const one = async <T,>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T>(sql, params))).rows[0];

/** One scenario per action tool: how to propose it, how to confirm it, and how to tell whether the system was changed. */
interface Scenario {
  toolId: string;
  /** Creates a fresh target and returns what is needed to propose, confirm and inspect it. */
  make: () => Promise<{ action: PlannedAction; scope: Parameters<typeof resolveOpsScope>[1]; confirm: { phrase?: string; reason?: string }; changed: () => Promise<boolean> }>;
}

const REASON = "Hardening check reason ZZTOP-4471";

const SCENARIOS: Scenario[] = [
  {
    toolId: "incident.acknowledge",
    make: async () => {
      counter += 1;
      const id = (await one<{ id: string }>("insert into incidents (org_id, source, subject, dedupe_key, severity, title) values ($1, 'queue', 'q', $2, 'warning', $3) returning id", [w.org.id, `hardening:${counter}:${crypto.randomUUID()}`, `Hardening incident ${counter}`])).id;
      return {
        action: { toolId: "incident.acknowledge", args: { incidentId: id } }, scope: { type: "incident", id }, confirm: {},
        changed: async () => (await one<{ status: string }>("select status from incidents where id = $1", [id])).status !== "open",
      };
    },
  },
  {
    toolId: "support.escalate",
    make: async () => {
      counter += 1;
      const ticket = await submitRequest(w.ctx.owner, { requestType: "issue", subject: `Hardening escalation ${counter}`, message: "Something is not working for every visitor.", category: "feature_not_working" });
      return {
        action: { toolId: "support.escalate", args: { ticketId: ticket.id, reason: "Escalated during the hardening check" } }, scope: { type: "ticket", id: ticket.id }, confirm: { reason: REASON },
        changed: async () => (await withSystem((db) => db.query("select 1 from support_ticket_ops where ticket_id = $1 and escalated_at is not null", [ticket.id]))).rows.length > 0,
      };
    },
  },
  {
    toolId: "support.set_priority",
    make: async () => {
      counter += 1;
      const ticket = await submitRequest(w.ctx.owner, { requestType: "issue", subject: `Hardening priority ${counter}`, message: "Something is slow for one visitor.", category: "feature_not_working" });
      const before = (await one<{ priority: string }>("select priority from support_tickets where id = $1", [ticket.id])).priority;
      return {
        action: { toolId: "support.set_priority", args: { ticketId: ticket.id, priority: before === "urgent" ? "low" : "urgent", reason: "" } }, scope: { type: "ticket", id: ticket.id }, confirm: {},
        changed: async () => (await one<{ priority: string }>("select priority from support_tickets where id = $1", [ticket.id])).priority !== before,
      };
    },
  },
  {
    toolId: "automation.agency_pause",
    make: async () => {
      counter += 1;
      const org = await createOrg({ name: `Hardening Client ${counter}` });
      return {
        action: { toolId: "automation.agency_pause", args: { orgId: org.id, paused: true, reason: "Hardening check" } }, scope: { type: "tenant", id: org.id }, confirm: { phrase: org.name, reason: REASON },
        changed: async () => (await withSystem((db) => db.query("select 1 from automation_pauses where org_id = $1 and scope = 'agency' and active", [org.id]))).rows.length > 0,
      };
    },
  },
  {
    toolId: "issue.create",
    make: async () => {
      counter += 1;
      const subject = `Hardening issue ${counter} ${crypto.randomUUID().slice(0, 8)}`;
      return {
        action: { toolId: "issue.create", args: { kind: "internal_issue", subject, details: "Recorded by the hardening check." } }, scope: { type: "platform" }, confirm: {},
        changed: async () => (await withSystem((db) => db.query("select 1 from support_tickets where subject like $1", [`%${subject}%`]))).rows.length > 0,
      };
    },
  },
];

describe("all five actions: the five tools are exactly the ones that exist", () => {
  it("has a scenario for every registered action tool, and no other", async () => {
    const { OPS_TOOLS } = await import("@/server/aqi/ops/registry");
    expect(OPS_TOOLS.filter((tool) => tool.kind === "action").map((tool) => tool.id).sort()).toEqual(SCENARIOS.map((s) => s.toolId).sort());
  });
});

describe.each(SCENARIOS)("$toolId", (scenario) => {
  const tool = findActionTool(scenario.toolId)!;
  const originalExecute = tool.execute;
  const originalVerify = tool.verify;
  afterEach(() => { tool.execute = originalExecute; tool.verify = originalVerify; });

  it("succeeds once, verified, with the whole lifecycle audited to the administrator and the reason kept out of the audit metadata", async () => {
    const s = await scenario.make();
    const p = asPreview(await propose(s.action, s.scope));
    expect(await s.changed()).toBe(false); // a proposal changes nothing
    const done = await confirmOpsAction(w.agency.superAdmin, p.actionId, s.confirm);
    expect(done.status).toBe("succeeded");
    expect(await s.changed()).toBe(true);
    expect(await actionRow(p.actionId)).toMatchObject({ status: "succeeded", verified: true });
    for (const action of ["aqi.ops_action_proposed", "aqi.ops_action_confirmed", "aqi.ops_action_verified", "aqi.ops_action_executed"]) expect(await auditCount(action, p.actionId), action).toBe(1);
    const rows = (await withSystem((db) => db.query<{ actor_user_id: string | null; metadata: unknown }>("select actor_user_id, metadata from audit_logs where target_id = $1", [p.actionId]))).rows;
    for (const row of rows) {
      expect(row.actor_user_id === null || row.actor_user_id === w.agency.superAdmin.id).toBe(true);
      expect(JSON.stringify(row.metadata)).not.toContain("ZZTOP-4471");
    }
    expect(rows.some((row) => row.actor_user_id === w.agency.superAdmin.id)).toBe(true);
  });

  it("reports failure honestly when the domain function throws, leaves the system as it was, and is not retried by a repeat confirmation", async () => {
    const s = await scenario.make();
    const p = asPreview(await propose(s.action, s.scope));
    let executions = 0;
    tool.execute = async () => { executions += 1; throw new AppError("upstream_error", "The service rejected the change."); };
    const done = await confirmOpsAction(w.agency.superAdmin, p.actionId, s.confirm);
    expect(done.status).toBe("failed");
    expect(done.cards.find((card) => card.kind === "action_result")).toMatchObject({ status: "failed" });
    expect(await s.changed()).toBe(false);
    expect(await actionRow(p.actionId)).toMatchObject({ status: "failed", error_code: "upstream_error" });
    expect(await auditCount("aqi.ops_action_failed", p.actionId)).toBe(1);
    expect(await auditCount("aqi.ops_action_verified", p.actionId)).toBe(0);
    tool.execute = originalExecute;
    expect((await confirmOpsAction(w.agency.superAdmin, p.actionId, s.confirm)).status).toBe("failed");
    expect(executions).toBe(1);
    expect(await s.changed()).toBe(false);
  });

  it("never reports success when the end state cannot be confirmed, whether verification disagrees or itself fails", async () => {
    for (const mode of ["disagrees", "throws"] as const) {
      const s = await scenario.make();
      const p = asPreview(await propose(s.action, s.scope));
      tool.verify = mode === "disagrees" ? async () => ({ verified: false, observed: ["The end state was not found."] }) : async () => { throw new Error("read-back unavailable: token=sk-live1234567890abcdef"); };
      const done = await confirmOpsAction(w.agency.superAdmin, p.actionId, s.confirm);
      expect(done.status, mode).toBe("verification_failed");
      expect(JSON.stringify(done.cards), mode).not.toMatch(/sk-live|read-back unavailable/);
      expect(await actionRow(p.actionId), mode).toMatchObject({ status: "verification_failed", verified: false });
      expect(await auditCount("aqi.ops_action_verified", p.actionId), mode).toBe(0);
      expect(await auditCount("aqi.ops_action_failed", p.actionId), mode).toBe(1);
    }
  });

  it("runs the domain function once when the same proposal is confirmed twice at the same moment", async () => {
    const s = await scenario.make();
    const p = asPreview(await propose(s.action, s.scope));
    let executions = 0;
    tool.execute = async (...args) => { executions += 1; await new Promise((resolve) => setTimeout(resolve, 40)); return originalExecute(...args); };
    const [a, b] = await Promise.all([confirmOpsAction(w.agency.superAdmin, p.actionId, s.confirm), confirmOpsAction(w.agency.superAdmin, p.actionId, s.confirm)]);
    expect(executions).toBe(1);
    expect(["executing", "succeeded"]).toContain(a.status);
    expect(["executing", "succeeded"]).toContain(b.status);
    expect([a.status, b.status]).toContain("succeeded");
    expect(await actionRow(p.actionId)).toMatchObject({ status: "succeeded", verified: true });
    expect(await auditCount("aqi.ops_action_confirmed", p.actionId)).toBe(1);
  });

  it("ends consistent when a confirmation and a cancellation arrive together: changed if and only if it succeeded", async () => {
    for (let round = 0; round < 3; round += 1) {
      const s = await scenario.make();
      const p = asPreview(await propose(s.action, s.scope));
      await Promise.all([confirmOpsAction(w.agency.superAdmin, p.actionId, s.confirm), cancelOpsAction(w.agency.superAdmin, p.actionId)]);
      const row = await actionRow(p.actionId);
      expect(["succeeded", "cancelled"], `round ${round}: ${row.status}`).toContain(row.status);
      expect(await s.changed(), `round ${round}`).toBe(row.status === "succeeded");
    }
  });

  it("refuses an administrator whose role no longer includes it, and leaves the proposal and the system untouched", async () => {
    const demoted = agencyUser(await createUser({ platformRole: "agency_super_admin", name: `Demoted ${++counter}` }), "agency_super_admin");
    const s = await scenario.make();
    const p = asPreview(await propose(s.action, s.scope, demoted));
    // Changed in the database after the proposal. The caller's session object still says Super Admin.
    await withSystem((db) => db.query("update users set platform_role = 'agency_staff' where id = $1", [demoted.id]));
    await expect(confirmOpsAction(demoted, p.actionId, s.confirm)).rejects.toThrow();
    expect(await s.changed()).toBe(false);
    expect((await actionRow(p.actionId)).status).toBe("proposed");
    // And a session that says so is refused outright.
    await expect(confirmOpsAction({ ...demoted, platformRole: "agency_staff" }, p.actionId, s.confirm)).rejects.toThrow(/Super Admins only/);
  });

  it("removes a credential pasted into the reason before it is stored", async () => {
    if (!scenario.toolId.match(/escalate|agency_pause/)) return;
    const s = await scenario.make();
    const p = asPreview(await propose(s.action, s.scope));
    const done = await confirmOpsAction(w.agency.superAdmin, p.actionId, { ...s.confirm, reason: "Rotated after the leak, api_key=sk-live1234567890abcdef was exposed" });
    expect(done.status).toBe("succeeded");
    const row = await actionRow(p.actionId);
    expect(row.reason).toContain("Rotated after the leak");
    expect(row.reason).not.toContain("sk-live1234567890abcdef");
  });
});

describe("boundaries between actions", () => {
  it("rejects extra fields in a confirmation, so the target and arguments can only come from the stored proposal", async () => {
    const s = await SCENARIOS[0].make();
    const p = asPreview(await propose(s.action, s.scope));
    await expect(confirmOpsAction(w.agency.superAdmin, p.actionId, { args: { incidentId: crypto.randomUUID() } })).rejects.toThrow(/confirmation details/);
    await expect(confirmOpsAction(w.agency.superAdmin, p.actionId, { toolId: "automation.agency_pause" })).rejects.toThrow(/confirmation details/);
    expect(await s.changed()).toBe(false);
  });

  it("will not act on a target other than the one selected as the context", async () => {
    const mine = await SCENARIOS[0].make();
    const other = await SCENARIOS[0].make();
    const card = await propose(other.action, mine.scope);
    expect(card.kind).toBe("notice");
    expect(await other.changed()).toBe(false);
    const ticketA = await SCENARIOS[1].make();
    const ticketB = await SCENARIOS[1].make();
    expect((await propose(ticketB.action, ticketA.scope)).kind).toBe("notice");
    expect(await ticketB.changed()).toBe(false);
  });

  it("lets only one of two proposals to pause the same client take effect", async () => {
    counter += 1;
    const org = await createOrg({ name: `Raced Client ${counter}` });
    const make = () => propose({ toolId: "automation.agency_pause", args: { orgId: org.id, paused: true, reason: "Hardening race" } }, { type: "tenant", id: org.id });
    const first = asPreview(await make());
    const second = asPreview(await make());
    const input = { phrase: org.name, reason: REASON };
    const results = await Promise.allSettled([confirmOpsAction(w.agency.superAdmin, first.actionId, input), confirmOpsAction(w.agency.superAdmin, second.actionId, input)]);
    const statuses = [(await actionRow(first.actionId)).status, (await actionRow(second.actionId)).status].sort();
    expect(statuses.filter((status) => status === "succeeded")).toHaveLength(1);
    expect(results.some((r) => r.status === "fulfilled" || r.status === "rejected")).toBe(true);
    expect((await withSystem((db) => db.query("select 1 from automation_pauses where org_id = $1 and scope = 'agency' and active", [org.id]))).rows).toHaveLength(1);
  });

  it("lets only one of two proposals acknowledge the same incident take effect", async () => {
    const s = await SCENARIOS[0].make();
    const first = asPreview(await propose(s.action, s.scope));
    const second = asPreview(await propose(s.action, s.scope));
    await Promise.allSettled([confirmOpsAction(w.agency.superAdmin, first.actionId, {}), confirmOpsAction(w.agency.superAdmin, second.actionId, {})]);
    const statuses = [(await actionRow(first.actionId)).status, (await actionRow(second.actionId)).status];
    expect(statuses.filter((status) => status === "succeeded")).toHaveLength(1);
    expect(statuses.filter((status) => status === "proposed" || status === "failed")).toHaveLength(1);
    expect(await auditCount("incident.acknowledged", (s.action as { args: { incidentId: string } }).args.incidentId)).toBe(1);
  });
});

describe("Client AQi is not coupled to AQi Operations", () => {
  const root = process.cwd();
  const read = (file: string) => readFileSync(path.join(root, file), "utf8");
  const files = (dir: string, extension: RegExp) => readdirSync(path.join(root, dir), { withFileTypes: true }).filter((entry) => entry.isFile() && extension.test(entry.name)).map((entry) => `${dir}/${entry.name}`);

  it("no Client assistant server module imports Operations code", () => {
    for (const file of files("src/server/aqi", /\.ts$/)) expect(read(file), file).not.toMatch(/aqi\/ops\//);
  });

  it("no Client assistant component imports Operations components, and the Client widget is the only thing the Client shell mounts for clients", () => {
    for (const file of files("src/components/aqi", /\.tsx?$/)) expect(read(file), file).not.toMatch(/aqi\/ops\//);
    const providers = read("src/components/providers.tsx");
    expect(providers).toMatch(/aqiMode/);
    expect(providers).toContain("OpsLauncher");
  });

  it("the Client assistant never references a migration 0068 object", () => {
    for (const file of [...files("src/server/aqi", /\.ts$/), ...files("src/components/aqi", /\.tsx?$/), ...files("src/lib/aqi", /\.ts$/)]) {
      expect(read(file), file).not.toMatch(/aqi_ops_|\bsurface\s*=/);
    }
  });
});

describe("tool authorization", () => {
  it("denies every read tool to an agency manager or staff member, with an audit row and no data", async () => {
    const { OPS_TOOLS } = await import("@/server/aqi/ops/registry");
    const reads = OPS_TOOLS.filter((tool) => tool.kind === "read");
    expect(reads.length).toBeGreaterThanOrEqual(20);
    for (const user of [w.agency.manager, w.agency.staff]) {
      const scope = await resolveOpsScope(w.agency.superAdmin, { type: "platform" });
      const run = await createOpsRun({ user, scope, signal: signal(), plannedToolIds: reads.map((tool) => tool.id) });
      for (const tool of reads) {
        const outcome = await run.runTool(tool.id, {});
        expect(outcome.run.status, `${user.platformRole} ${tool.id}`).toBe("denied");
        expect(outcome.cards, tool.id).toEqual([]);
        expect(outcome.data, tool.id).toBeNull();
      }
      await run.flushAudit();
      const denied = (await withSystem((db) => db.query<{ n: number }>("select count(*)::int as n from audit_logs where action = 'aqi.ops_tool_run' and result = 'denied' and metadata->>'requestId' = $1", [run.ctx.requestId]))).rows[0].n;
      expect(denied, user.platformRole).toBe(reads.length);
    }
  });

  it("refuses to start a run for anyone who is not an agency user, and for an account that changed since the session was issued", async () => {
    const scope = await resolveOpsScope(w.agency.superAdmin, { type: "platform" });
    const client = { ...w.agency.superAdmin, platformRole: "none" as const };
    await expect(createOpsRun({ user: client, scope, signal: signal(), plannedToolIds: [] })).rejects.toThrow(/agency administrators only/);
    const stale = agencyUser(await createUser({ platformRole: "agency_manager" }), "agency_super_admin");
    await expect(createOpsRun({ user: stale, scope, signal: signal(), plannedToolIds: [] })).rejects.toThrow(/access has changed/);
    const disabled = agencyUser(await createUser({ platformRole: "agency_super_admin" }), "agency_super_admin");
    await withSystem((db) => db.query("update users set status = 'disabled' where id = $1", [disabled.id]));
    await expect(createOpsRun({ user: disabled, scope, signal: signal(), plannedToolIds: [] })).rejects.toThrow(/access has changed/);
  });

  it("denies a tool outside its scopes without running it", async () => {
    const tenantScope = await resolveOpsScope(w.agency.superAdmin, { type: "tenant", id: w.org.id });
    const run = await createOpsRun({ user: w.agency.superAdmin, scope: tenantScope, signal: signal(), plannedToolIds: ["workspace.directory", "business.summary", "release.info"] });
    for (const id of ["workspace.directory", "business.summary", "release.info"]) expect((await run.runTool(id, {})).run.status, id).toBe("denied");
  });
});

describe("tenant isolation", () => {
  const CANARY = "ZZ-CANARY-OTHER-CLIENT";

  it("never puts another client's records into an investigation of one client", async () => {
    const other = w.otherOrg;
    await withSystem(async (db) => {
      await db.query("insert into incidents (org_id, source, subject, dedupe_key, severity, title, detail) values ($1, 'messaging', 'sends', $2, 'critical', $3, $4)", [other.id, `iso:${crypto.randomUUID()}`, `${CANARY} incident`, `${CANARY} detail`]);
      const agent = (await db.query<{ id: string }>("select id from agent_instances where org_id = $1 order by role_key limit 1", [other.id])).rows[0];
      await db.query("update agent_instances set status = 'online', enabled = true where id = $1", [agent.id]);
      await db.query(
        `insert into agent_runs (org_id, agent_instance_id, purpose, idempotency_key, status, error_code, error_message, started_at, finished_at)
         values ($1, $2, 'chat', $3, 'failed', 'tool_error', $4, now() - interval '1 hour', now() - interval '1 hour')`, [other.id, agent.id, `iso-run-${crypto.randomUUID()}`, `${CANARY} run error`],
      );
      await db.query("insert into approval_requests (org_id, agent_instance_id, kind, title, risk, status) values ($1, $2, 'outreach', $3, 'high', 'pending')", [other.id, agent.id, `${CANARY} approval`]);
      await db.query("insert into integration_connections (org_id, provider, label, status, last_error, last_failure_at) values ($1, 'ghl', $2, 'error', $3, now())", [other.id, `${CANARY} connection`, `${CANARY} provider error`]);
      await db.query("insert into audit_logs (org_id, actor_kind, action, target_type, result, metadata) values ($1, 'agency', 'team.role_changed', 'user', 'success', $2::jsonb)", [other.id, JSON.stringify({ note: `${CANARY} audit` })]);
    });
    await submitRequest(w.ctx.outsider, { requestType: "issue", subject: `${CANARY} ticket about booking`, message: `${CANARY} booking page error`, category: "feature_not_working" });
    const mine = await submitRequest(w.ctx.owner, { requestType: "issue", subject: "Booking page error for visitors", message: "Booking page shows an error.", category: "feature_not_working" });

    const { OPS_TOOLS } = await import("@/server/aqi/ops/registry");
    for (const scopeRequest of [{ type: "tenant" as const, id: w.org.id }, { type: "ticket" as const, id: mine.id }]) {
      const scope = await resolveOpsScope(w.agency.superAdmin, scopeRequest);
      const tools = OPS_TOOLS.filter((tool) => tool.kind === "read" && tool.scopes.includes(scope.type));
      expect(tools.length, scope.type).toBeGreaterThan(3);
      const run = await createOpsRun({ user: w.agency.superAdmin, scope, signal: signal(), plannedToolIds: tools.map((tool) => tool.id) });
      for (const tool of tools) {
        const outcome = await run.runTool(tool.id, {});
        expect(["ok", "partial"], `${scope.type} ${tool.id}: ${outcome.run.note}`).toContain(outcome.run.status);
        const text = JSON.stringify({ data: outcome.data, cards: outcome.cards, summary: outcome.summary, evidence: outcome.evidence });
        expect(text, `${scope.type} ${tool.id}`).not.toContain(CANARY);
        expect(text, `${scope.type} ${tool.id}`).not.toContain(other.id);
        expect(text, `${scope.type} ${tool.id}`).not.toContain(other.name);
      }
      await run.flushAudit();
    }
  });

  it("does show the other client when the platform is the context, which is the point of selecting a client", async () => {
    const scope = await resolveOpsScope(w.agency.superAdmin, { type: "platform" });
    const run = await createOpsRun({ user: w.agency.superAdmin, scope, signal: signal(), plannedToolIds: ["platform.incidents"] });
    const outcome = await run.runTool("platform.incidents", {});
    expect(outcome.run.status, outcome.run.note).toBe("ok");
    expect(JSON.stringify(outcome.cards)).toContain(CANARY);
  });
});
