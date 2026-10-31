// A4 preparation, READ-ONLY: what each of the six internal employees can read through the business MCP bridge, exercised through the real handler on SYNTHETIC records (labelled as such;
// nothing here is customer activity, and the fixtures are created for the run). It pins the capability matrix in docs/hermes-d3-c6-results-2026-10-30.md to the code: if a tool, scope or
// snapshot area is added, removed or moved between roles, this fails until the matrix is updated on purpose. It grants nothing and writes nothing but its own fixtures: no message is sent,
// no booking made, no pipeline stage changed, no approval submitted, no lead created by an employee, no autonomous work started.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AGENCY_HERMES_PROFILE_IDS, AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { systemActor } from "@/server/crm/actor";
import { AGENT_TOOLS, ROLE_SCOPES, SCOPE_INFO, type AgentToolName } from "@/server/crm/agent-tools/catalog";
import { createAppointmentType, createCalendar, setHostAvailability } from "@/server/calendars/setup";
import { createContact } from "@/server/crm/contacts";
import { createOpportunity } from "@/server/crm/opportunities";
import { listPipelines } from "@/server/crm/pipelines";
import { loadWorkspace } from "@/server/crm/workspace";
import { handleHermesBusinessMcp } from "@/server/workforce/hermes-business-mcp";
import { issueConfiguredBusinessMcpCredential } from "@/server/workforce/hermes-business-mcp-credential";
import { businessMcpToolNamesForRole, HERMES_BUSINESS_CONTEXT_TOOL } from "@/server/workforce/hermes-business-mcp-policy";
import { connectHermesProfile, createConfigVersion, runHealthCheck } from "@/server/workforce/service";
import { defaultSettings } from "@/server/workforce/compiler";
import { addMember, agentId, createOrg, createUser } from "./support/fixtures";
import { startMockHermes, type MockHermes } from "./support/mock-hermes";
import { MCP_TEST_SECRET } from "./support/business-mcp";
import { readRowCounts, readWriteDeltas } from "@/server/workforce/hermes-a4a-evidence";

const URL = "https://portal.example.test/api/internal/hermes-business/mcp";
const KEYS = Object.fromEntries(AGENT_ROLE_KEYS.map((role) => [role, `matrix-${role}-profile-key-0123456789`])) as Record<AgentRoleKey, string>;
const CREDENTIALS = {} as Record<AgentRoleKey, string>;
const IDS = {} as Record<AgentRoleKey, string>;
const evidence: Record<string, unknown> = {};

/**
 * THE MATRIX, as code. For every employee: the business MCP tools it holds (all reads), the CRM scopes behind them, and the areas of the context snapshot it receives. The documentation
 * (docs/hermes-d3-c6-results-2026-10-30.md, section 3) describes each capability category in terms of these; this table is what keeps the two true.
 */
const MATRIX: Record<AgentRoleKey, { tools: AgentToolName[]; scopes: string[]; snapshotAreas: string[] }> = {
  operations_manager: { tools: ["check_availability", "crm_summary_report", "find_contacts", "get_contact"], scopes: ["contacts:read", "tasks:write", "opportunities:read", "calendar:read", "reports:read"], snapshotAreas: ["work_board", "schedules", "handoffs"] },
  lead_hunter: { tools: ["find_contacts", "get_contact"], scopes: ["contacts:read", "tags:write", "tasks:write"], snapshotAreas: ["leads", "targeting"] },
  appointment_setter: { tools: ["check_availability", "find_contacts", "get_contact", "get_conversation_history"], scopes: ["contacts:read", "contacts:write", "tags:write", "tasks:write", "calendar:read", "appointments:request", "conversations:read", "messages:draft"], snapshotAreas: ["calendar", "appointments"] },
  sales_assistant: { tools: ["check_availability", "find_contacts", "get_contact", "get_conversation_history"], scopes: ["contacts:read", "contacts:write", "tags:write", "tasks:write", "opportunities:read", "opportunities:write", "calendar:read", "conversations:read", "messages:draft"], snapshotAreas: ["pipeline"] },
  crm_manager: { tools: ["crm_summary_report", "find_contacts", "get_contact"], scopes: ["contacts:read", "contacts:write", "tags:write", "tasks:write", "opportunities:read", "opportunities:write", "reports:read"], snapshotAreas: ["crm", "crm_quality", "pipeline"] },
  performance_analyst: { tools: ["crm_summary_report"], scopes: ["opportunities:read", "reports:read"], snapshotAreas: ["performance", "crm", "pipeline", "calendar"] },
};

let mock: MockHermes;
let agency: Awaited<ReturnType<typeof createOrg>>;
let admin: { id: string; email: string };
let contactId = "";
let conversationId = "";
let appointmentTypeId = "";

interface Rpc { status: number; json: { result?: { content?: Array<{ text: string }>; isError?: boolean; tools?: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }> }; error?: unknown } | null }
async function post(role: AgentRoleKey, body: Record<string, unknown>): Promise<Rpc> {
  const response = await handleHermesBusinessMcp(new Request(URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${CREDENTIALS[role]}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "x-forwarded-for": "198.51.100.200" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, ...body }),
  }));
  return { status: response.status, json: (await response.json().catch(() => null)) as Rpc["json"] };
}
const tool = (role: AgentRoleKey, name: string, args: Record<string, unknown> = {}) => post(role, { method: "tools/call", params: { name, arguments: args } });
const text = (rpc: Rpc) => rpc.json?.result?.content?.[0]?.text ?? "";

async function startTurn(role: AgentRoleKey) {
  await withSystem(async (db) => {
    await db.query("update agent_runs set status = 'completed' where agent_instance_id = $1 and status = 'running'", [IDS[role]]);
    const { rows } = await db.query<{ active_config_version_id: string }>("select active_config_version_id from agent_instances where id = $1", [IDS[role]]);
    await db.query(
      `insert into agent_runs (org_id, agent_instance_id, user_id, purpose, idempotency_key, status, started_at, hermes_run_id, config_version_id)
       values ($1, $2, $3, 'chat', $4, 'running', now(), $5, $6)`,
      [agency.id, IDS[role], admin.id, `matrix-${role}-${Math.random().toString(36).slice(2)}`, `run-${Math.random().toString(36).slice(2)}`, rows[0].active_config_version_id],
    );
  });
}

beforeAll(async () => {
  mock = await startMockHermes(Object.fromEntries(AGENT_ROLE_KEYS.map((role) => [AGENCY_HERMES_PROFILE_IDS[role], { key: KEYS[role] }])));
  admin = await createUser({ platformRole: "agency_super_admin", name: "Matrix Admin" });
  agency = await createOrg({ name: "Matrix Agency", kind: "agency" });
  await addMember(agency.id, admin.id, "owner");
  for (const role of AGENT_ROLE_KEYS) {
    IDS[role] = await agentId(agency.id, role);
    await withSystem((db) => createConfigVersion(db, { orgId: agency.id, agentId: IDS[role], settings: defaultSettings(role), source: "onboarding", userId: admin.id, apply: true }));
    await connectHermesProfile({ agentId: IDS[role], baseUrl: mock.url, profile: AGENCY_HERMES_PROFILE_IDS[role], apiKey: KEYS[role], agencyUserId: admin.id });
    expect(await runHealthCheck(IDS[role], { userId: admin.id, kind: "agency" })).toMatchObject({ ok: true, status: "online" });
  }
  vi.stubEnv("HERMES_BUSINESS_MCP_ENABLED", "true");
  vi.stubEnv("HERMES_BUSINESS_MCP_WRITES_ENABLED", "false");
  vi.stubEnv("HERMES_BUSINESS_MCP_SECRET", MCP_TEST_SECRET);
  resetEnvCache();
  for (const role of AGENT_ROLE_KEYS) CREDENTIALS[role] = issueConfiguredBusinessMcpCredential({ role, agentId: IDS[role], orgId: agency.id }).token;

  await withSystem((db) => db.query("insert into leads (org_id, business_name, review_status) values ($1, 'Matrix Synthetic Lead', 'pending')", [agency.id]));
}, 180_000);

/**
 * The internal agency workspace has no CRM until a Super Admin opens it (loadWorkspace creates it only for a signed-in member actor; an employee or a background job cannot). This is what
 * that step does, followed by synthetic CRM records, created by the test and clearly not real: one contact, one conversation, one open deal, one calendar with open hours.
 */
async function bootstrapAgencyCrmWithSyntheticRecords() {
  await withSystem((db) => loadWorkspace(db, agency.id, { allowAgencyBootstrap: true }));
  const system = systemActor({ id: agency.id, name: agency.name, timezone: "UTC" });
  const contact = await createContact(system, { firstName: "Matrix", lastName: "Synthetic", email: "matrix.synthetic@example.test", phone: "+639170000001" });
  contactId = contact.id;
  const pipelines = await listPipelines(system, { ensureDefault: true });
  const pipeline = pipelines[0];
  await createOpportunity(system, { name: "Matrix Synthetic Deal", contactId, pipelineId: pipeline.id });
  const conversation = await withSystem((db) => db.query<{ id: string }>(
    "insert into conversations (org_id, contact_id, channel, thread_key, ai_agent_id, owner_kind) values ($1, $2, 'sms', $3, $4, 'ai') returning id",
    [agency.id, contactId, crypto.randomUUID(), IDS.sales_assistant],
  ));
  conversationId = conversation.rows[0].id;
  await withSystem((db) => db.query("insert into conversation_messages (org_id, conversation_id, direction, author_kind, body, status) values ($1, $2, 'inbound', 'contact', 'Synthetic: is Saturday free?', 'received')", [agency.id, conversationId]));
  await setHostAvailability(system, admin.id, { timezone: "UTC", rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMinute: 0, endMinute: 24 * 60 })) });
  const calendar = await createCalendar(system, { name: "Matrix Visits", assignment: "single", members: [{ userId: admin.id }] });
  appointmentTypeId = (await createAppointmentType(system, calendar.id, { name: "Matrix site visit", durationMinutes: 60, minNoticeMinutes: 60, maxDaysAhead: 30 })).id;
}

afterAll(async () => {
  vi.unstubAllEnvs();
  resetEnvCache();
  await mock.close();
  if (process.env.IACQUIRE_A4_EVIDENCE) {
    mkdirSync(path.dirname(process.env.IACQUIRE_A4_EVIDENCE), { recursive: true });
    writeFileSync(process.env.IACQUIRE_A4_EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  }
});

describe("the read contract of each employee", () => {
  for (const role of AGENT_ROLE_KEYS) {
    it(`${role}: holds exactly the tools and scopes the matrix lists, every one a read`, async () => {
      const expected = [HERMES_BUSINESS_CONTEXT_TOOL, ...MATRIX[role].tools].sort();
      expect([...businessMcpToolNamesForRole(role, false)].sort()).toEqual(expected);
      expect([...ROLE_SCOPES[role]]).toEqual(MATRIX[role].scopes);
      for (const name of MATRIX[role].tools) expect(AGENT_TOOLS[name].kind, `${role}/${name}`).toBe("read");
      const listed = await post(role, { method: "tools/list" });
      expect((listed.json?.result?.tools ?? []).map((entry) => entry.name).sort()).toEqual(expected);
      for (const entry of listed.json?.result?.tools ?? []) expect(entry.annotations?.readOnlyHint, `${role}/${entry.name}`).toBe(true);
      evidence[`tools_${role}`] = { tools: expected, scopes: MATRIX[role].scopes, permissions: [...new Set(MATRIX[role].tools.flatMap((name) => [...AGENT_TOOLS[name].permissions]))].sort() };
    });
  }

  it("offers no write, proposal, approval, send or booking tool to any employee, and keeps the scopes that would allow one behind the approval path", () => {
    const offered = new Set(AGENT_ROLE_KEYS.flatMap((role) => MATRIX[role].tools));
    for (const [name, def] of Object.entries(AGENT_TOOLS)) if (def.kind !== "read") expect(offered.has(name as AgentToolName), name).toBe(false);
    for (const scope of Object.keys(SCOPE_INFO)) expect(typeof scope).toBe("string");
  });
});

describe("observation: the internal agency CRM row is created lazily, and until it exists the reads are empty, never an error", () => {
  const rows = async () => Number((await withSystem((db) => db.query<{ n: number }>("select count(*)::int as n from crm_workspaces where org_id = $1", [agency.id]))).rows[0].n);

  it("answers reads as empty (the snapshot says the same: the internal CRM is native by design), and no read creates the CRM", async () => {
    await startTurn("crm_manager");
    await startTurn("operations_manager");
    expect(await rows()).toBe(0);
    const found = JSON.parse(text(await tool("crm_manager", "find_contacts", { query: "Matrix" }))) as { ok: boolean; result: { contacts: unknown[] } };
    expect(found).toMatchObject({ ok: true, result: { contacts: [] } });
    const summary = JSON.parse(text(await tool("crm_manager", "crm_summary_report"))) as { ok: boolean; result: Record<string, unknown> };
    expect(summary.ok).toBe(true);
    const snapshot = JSON.parse(text(await tool("crm_manager", HERMES_BUSINESS_CONTEXT_TOOL))) as { evidence: { sections: Array<{ id: string; state: string }> } };
    evidence.before_crm_opened = snapshot.evidence.sections.map((section) => `${section.id}:${section.state}`);
    expect(snapshot.evidence.sections.find((section) => section.id === "crm")?.state).toBe("empty");
    expect(await rows()).toBe(0);
  });
});

describe("with the agency CRM opened by a Super Admin", () => {
beforeAll(async () => { await bootstrapAgencyCrmWithSyntheticRecords(); }, 120_000);

describe("what each employee's context snapshot actually returns on synthetic records", () => {
  for (const role of AGENT_ROLE_KEYS) {
    it(`${role}: returns its areas, each with a state, and reads only this workspace`, async () => {
      await startTurn(role);
      const rpc = await tool(role, HERMES_BUSINESS_CONTEXT_TOOL);
      expect(rpc.json?.result?.isError, text(rpc).slice(0, 200)).not.toBe(true);
      const body = JSON.parse(text(rpc)) as { status: string; evidence: { sections: Array<{ id: string; state: string; title: string; records?: unknown[] }> }; internalOperations?: Record<string, unknown> };
      const ids = body.evidence.sections.map((section) => section.id);
      evidence[`snapshot_${role}`] = { status: body.status, areas: body.evidence.sections.map((section) => `${section.id}:${section.state}`), ...(body.internalOperations ? { internalOperations: Object.keys(body.internalOperations).sort() } : {}) };
      for (const area of MATRIX[role].snapshotAreas) expect(ids, `${role} should receive the ${area} area`).toContain(area);
      expect(body.status).toBe("available");
    });
  }

  it("shows each employee only the records of its own role's areas", async () => {
    await startTurn("lead_hunter");
    expect(text(await tool("lead_hunter", HERMES_BUSINESS_CONTEXT_TOOL))).toContain("Matrix Synthetic Lead");
    await startTurn("sales_assistant");
    const sales = text(await tool("sales_assistant", HERMES_BUSINESS_CONTEXT_TOOL));
    expect(sales).toContain("Matrix Synthetic Deal");
    expect(sales).not.toContain("Matrix Synthetic Lead");
  });
});

describe("the read tools, on synthetic records", () => {
  it("find_contacts and get_contact return the synthetic contact to every employee that holds them", async () => {
    for (const role of AGENT_ROLE_KEYS.filter((r) => MATRIX[r].tools.includes("find_contacts"))) {
      await startTurn(role);
      const found = await tool(role, "find_contacts", { query: "Matrix" });
      expect(found.json?.result?.isError, `${role}: ${text(found).slice(0, 160)}`).not.toBe(true);
      expect(JSON.parse(text(found))).toMatchObject({ ok: true, status: "done", tool: "find_contacts" });
      expect(text(found)).toContain("Matrix");
      const one = await tool(role, "get_contact", { contactId });
      expect(JSON.parse(text(one))).toMatchObject({ ok: true, status: "done", tool: "get_contact" });
      evidence[`contacts_${role}`] = "returned";
    }
  });

  it("crm_summary_report returns counts only", async () => {
    for (const role of AGENT_ROLE_KEYS.filter((r) => MATRIX[r].tools.includes("crm_summary_report"))) {
      await startTurn(role);
      const rpc = await tool(role, "crm_summary_report");
      const body = JSON.parse(text(rpc)) as { ok: boolean; result: Record<string, unknown> };
      expect(body.ok, role).toBe(true);
      for (const value of Object.values(body.result)) expect(["number", "object"], `${role}`).toContain(typeof value);
      expect(text(rpc)).not.toContain("matrix.synthetic@example.test");
      evidence[`summary_${role}`] = Object.keys(body.result).sort();
    }
  });

  it("check_availability returns open times from the synthetic calendar for the roles that hold calendar:read", async () => {
    for (const role of AGENT_ROLE_KEYS.filter((r) => MATRIX[r].tools.includes("check_availability"))) {
      await startTurn(role);
      const rpc = await tool(role, "check_availability", { appointmentTypeId, days: 3, limit: 3 });
      const body = JSON.parse(text(rpc)) as { ok: boolean; status: string; result: { slots?: unknown[] } };
      expect(body, role).toMatchObject({ ok: true, status: "done" });
      expect(body.result.slots?.length ?? 0, role).toBeGreaterThan(0);
      evidence[`availability_${role}`] = { slots: body.result.slots?.length };
    }
  });

  it("get_conversation_history returns only conversations the employee itself handles", async () => {
    await startTurn("sales_assistant");
    const own = JSON.parse(text(await tool("sales_assistant", "get_conversation_history", { conversationId }))) as { ok: boolean; result: { messages: Array<{ text: string }> } };
    expect(own.ok).toBe(true);
    expect(own.result.messages.map((message) => message.text)).toEqual(["Synthetic: is Saturday free?"]);
    // The appointment setter holds the tool but this conversation belongs to the sales assistant, so it is not found.
    await startTurn("appointment_setter");
    const other = await tool("appointment_setter", "get_conversation_history", { conversationId });
    expect(JSON.parse(text(other))).toMatchObject({ ok: false, httpStatus: 404 });
    evidence.conversation_isolation = "another employee's conversation is not found";
  });

  it("changes nothing: no message queued, no booking, no approval, no task, no stage move, no new lead", async () => {
    const count = async (sql: string) => Number((await withSystem((db) => db.query<{ n: number }>(sql, [agency.id]))).rows[0].n);
    const before = [
      await count("select count(*)::int as n from conversation_messages where org_id = $1 and status in ('queued','sending','sent','draft')"),
      await count("select count(*)::int as n from appointment_bookings where org_id = $1"),
      await count("select count(*)::int as n from approval_requests where org_id = $1"),
      await count("select count(*)::int as n from tasks where org_id = $1"),
      await count("select count(*)::int as n from leads where org_id = $1"),
    ];
    for (const role of AGENT_ROLE_KEYS) {
      await startTurn(role);
      await tool(role, HERMES_BUSINESS_CONTEXT_TOOL);
      for (const name of MATRIX[role].tools) await tool(role, name, name === "get_contact" ? { contactId } : name === "find_contacts" ? { query: "Matrix" } : name === "get_conversation_history" ? { conversationId } : {});
    }
    const after = [
      await count("select count(*)::int as n from conversation_messages where org_id = $1 and status in ('queued','sending','sent','draft')"),
      await count("select count(*)::int as n from appointment_bookings where org_id = $1"),
      await count("select count(*)::int as n from approval_requests where org_id = $1"),
      await count("select count(*)::int as n from tasks where org_id = $1"),
      await count("select count(*)::int as n from leads where org_id = $1"),
    ];
    expect(after).toEqual(before);
  });

  // The A4a evidence tool (scripts/hermes-a4a-evidence.ts) treats every workspace table outside EXPECTED_BOOKKEEPING_TABLES as a possible write. This is what makes that list true: every
  // tool of every employee, through the real handler, and the only tables with a new, changed or removed row for the workspace are ones the tool expects.
  it("writes only the run's own bookkeeping: every table that gains, changes or loses a row is one the evidence tool expects", async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
    const since = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const baseline = await readRowCounts(agency.id);
    for (const role of AGENT_ROLE_KEYS) {
      await startTurn(role);
      await tool(role, HERMES_BUSINESS_CONTEXT_TOOL);
      for (const name of MATRIX[role].tools) await tool(role, name, name === "get_contact" ? { contactId } : name === "find_contacts" ? { query: "Matrix" } : name === "get_conversation_history" ? { conversationId } : {});
    }
    const deltas = await readWriteDeltas(agency.id, since, baseline);
    const changed = deltas.filter((entry) => entry.created || entry.updated || entry.rowDelta || entry.error);
    expect(changed.filter((entry) => !entry.expected)).toEqual([]);
    // The loop really ran: the audit trail, the tool records and the runs grew.
    for (const table of ["audit_logs", "tool_executions", "agent_runs"]) expect(changed.find((entry) => entry.table === table)?.rowDelta, table).toBeGreaterThan(0);
    evidence.tables_written_by_reads = changed.map((entry) => `${entry.table}:+${entry.rowDelta}`);
  });
});
});
