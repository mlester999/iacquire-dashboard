import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import {
  EXPECTED_BOOKKEEPING_TABLES, evaluateA4aEvidence, findInternalAgencyOrgId, listWorkspaceTables, readAuthoritativeCounts, readRowCounts, readRunEvidence, readWriteDeltas,
  reviewedToolRecordNames, type AuthoritativeCounts, type EvidenceInput, type RunEvidence, type TableDelta,
} from "@/server/workforce/hermes-a4a-evidence";
import { businessMcpToolNamesForRole } from "@/server/workforce/hermes-business-mcp-policy";
import { agentId, createOrg } from "./support/fixtures";

// A4a evidence: the read-only before/after comparison for the first supervised business-tool task. These tests check the checks themselves (so a real run cannot pass by accident)
// and the queries (against a seeded database), and that the module can only read.

const root = path.resolve(__dirname, "..");
const source = readFileSync(path.join(root, "src/server/workforce/hermes-a4a-evidence.ts"), "utf8");
const script = readFileSync(path.join(root, "scripts/hermes-a4a-evidence.ts"), "utf8");

const COUNTS: AuthoritativeCounts = { openTasks: 3, overdueTasks: 1, pendingApprovals: 2, changesRequested: 0, blockedExecutions: 0 };
const GOOD_RUN: RunEvidence = {
  found: true, runId: "11111111-1111-4111-8111-111111111111", role: "operations_manager", purpose: "chat", status: "completed", hasHermesRun: true,
  tools: [{ name: "mcp__iacquire_business__get_role_workspace_context", status: "completed", count: 1 }, { name: "mcp.get_role_workspace_context", status: "completed", count: 1 }],
  audit: [{ action: "hermes.business_mcp.read", result: "success", tool: "get_role_workspace_context", role: "operations_manager", credentialId: "0123456789abcdef", reason: null, count: 1 }],
};
const QUIET: TableDelta[] = [
  { table: "audit_logs", created: 2, updated: 0, rowDelta: 2, expected: true }, { table: "agent_runs", created: 1, updated: 1, rowDelta: 1, expected: true },
  { table: "tasks", created: 0, updated: 0, rowDelta: 0, expected: false }, { table: "approval_requests", created: 0, updated: 0, rowDelta: 0, expected: false },
];
const input = (over: Partial<EvidenceInput> = {}): EvidenceInput => ({ role: "operations_manager", before: COUNTS, after: COUNTS, deltas: QUIET, run: GOOD_RUN, credentialId: "0123456789abcdef", ...over });
const failing = (result: ReturnType<typeof evaluateA4aEvidence>) => result.checks.filter((check) => !check.ok && !check.advisory).map((check) => check.id);

describe("A4a evidence: the checks", () => {
  it("passes a clean supervised read: the right employee, reviewed tools only, an audit trail, no write outside the bookkeeping tables", () => {
    const result = evaluateA4aEvidence(input());
    expect(failing(result)).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.checks.map((check) => check.id)).toEqual([
      "run_found", "employee_identity", "authenticated_chat_turn", "only_reviewed_tools", "tool_invocation_recorded", "audit_trail", "no_denials", "credential_id", "zero_business_writes", "facts_stable",
    ]);
  });

  it("fails when the run is missing, belongs to another employee, or is not an authenticated Chat turn", () => {
    expect(failing(evaluateA4aEvidence(input({ run: { ...GOOD_RUN, found: false, role: null, purpose: null, status: null, hasHermesRun: false } })))).toEqual(expect.arrayContaining(["run_found", "employee_identity", "authenticated_chat_turn"]));
    expect(failing(evaluateA4aEvidence(input({ run: { ...GOOD_RUN, role: "lead_hunter" } })))).toContain("employee_identity");
    expect(failing(evaluateA4aEvidence(input({ run: { ...GOOD_RUN, purpose: "health_check" } })))).toContain("authenticated_chat_turn");
    expect(failing(evaluateA4aEvidence(input({ run: { ...GOOD_RUN, hasHermesRun: false } })))).toContain("authenticated_chat_turn");
    expect(failing(evaluateA4aEvidence(input({ run: { ...GOOD_RUN, status: "failed" } })))).toContain("authenticated_chat_turn");
    expect(failing(evaluateA4aEvidence(input({ run: { ...GOOD_RUN, audit: [{ ...GOOD_RUN.audit[0], role: "sales_assistant" }] } })))).toContain("employee_identity");
  });

  it("fails on any tool record outside the reviewed business tools, built-ins and write tools included", () => {
    for (const name of ["web_search", "web_extract", "todo_list", "memory", "terminal", "update_contact", "mcp__iacquire_business__create_task", "crm.request_appointment"]) {
      const result = evaluateA4aEvidence(input({ run: { ...GOOD_RUN, tools: [...GOOD_RUN.tools, { name, status: "completed", count: 1 }] } }));
      expect(failing(result), name).toContain("only_reviewed_tools");
      expect(result.checks.find((check) => check.id === "only_reviewed_tools")?.detail).toContain(name);
    }
  });

  it("requires a completed reviewed tool call and a successful audit entry", () => {
    expect(failing(evaluateA4aEvidence(input({ run: { ...GOOD_RUN, tools: [] } })))).toEqual(expect.arrayContaining(["only_reviewed_tools", "tool_invocation_recorded"]));
    expect(failing(evaluateA4aEvidence(input({ run: { ...GOOD_RUN, tools: GOOD_RUN.tools.map((entry) => ({ ...entry, status: "failed" })) } })))).toContain("tool_invocation_recorded");
    expect(failing(evaluateA4aEvidence(input({ run: { ...GOOD_RUN, audit: [] } })))).toEqual(expect.arrayContaining(["audit_trail", "credential_id"]));
  });

  it("fails on any denied or failed business entry, and on a credential refusal in the window", () => {
    expect(failing(evaluateA4aEvidence(input({ run: { ...GOOD_RUN, audit: [...GOOD_RUN.audit, { action: "hermes.business_mcp.read", result: "denied", tool: "get_role_workspace_context", role: "operations_manager", credentialId: "0123456789abcdef", reason: "membership", count: 1 }] } })))).toContain("no_denials");
    expect(failing(evaluateA4aEvidence(input({ run: { ...GOOD_RUN, audit: [...GOOD_RUN.audit, { action: "hermes.business_mcp.auth_denied", result: "success", tool: null, role: "operations_manager", credentialId: "0123456789abcdef", reason: "expired", count: 1 }] } })))).toContain("no_denials");
    expect(failing(evaluateA4aEvidence(input({ run: { ...GOOD_RUN, audit: [...GOOD_RUN.audit, { action: "crm.agent_tool.find_contacts", result: "denied", tool: "find_contacts", role: null, credentialId: null, reason: null, count: 1 }] } })))).toContain("no_denials");
  });

  it("fails when an audit entry carries a credential id other than the installed one", () => {
    expect(failing(evaluateA4aEvidence(input({ credentialId: "ffffffffffffffff" })))).toContain("credential_id");
    expect(failing(evaluateA4aEvidence(input({ credentialId: undefined })))).toEqual([]);
  });

  it("fails on a new or changed row in any table outside the expected bookkeeping tables, and on a table it could not read", () => {
    const created = evaluateA4aEvidence(input({ deltas: [...QUIET, { table: "approval_requests", created: 1, updated: 0, rowDelta: 1, expected: false }] }));
    expect(failing(created)).toContain("zero_business_writes");
    expect(created.checks.find((check) => check.id === "zero_business_writes")?.detail).toContain("approval_requests (+1 new, 0 changed, rows +1)");
    expect(failing(evaluateA4aEvidence(input({ deltas: [...QUIET, { table: "contacts", created: 0, updated: 2, rowDelta: 0, expected: false }] })))).toContain("zero_business_writes");
    expect(failing(evaluateA4aEvidence(input({ deltas: [...QUIET, { table: "leads", created: 0, updated: 0, rowDelta: 0, expected: false, error: "could not be read" }] })))).toContain("zero_business_writes");
    // A table with no timestamp columns is still seen, by its row count: an insert (+) or a delete (-).
    for (const rowDelta of [1, -1]) {
      const result = evaluateA4aEvidence(input({ deltas: [...QUIET, { table: "contacts", created: 0, updated: 0, rowDelta, expected: false }] }));
      expect(failing(result), String(rowDelta)).toContain("zero_business_writes");
      expect(result.checks.find((check) => check.id === "zero_business_writes")?.detail).toContain(`contacts (+0 new, 0 changed, rows ${rowDelta > 0 ? "+" : ""}${rowDelta})`);
    }
    // The bookkeeping tables may grow, shrink or change without failing the run.
    expect(failing(evaluateA4aEvidence(input({ deltas: [...QUIET, { table: "tool_executions", created: 0, updated: 3, rowDelta: -2, expected: true }] })))).toEqual([]);
  });

  it("reports changed counts as a note without failing the run, because real activity can move them", () => {
    const result = evaluateA4aEvidence(input({ after: { ...COUNTS, openTasks: 4 } }));
    expect(result.ok).toBe(true);
    const note = result.checks.find((check) => check.id === "facts_stable");
    expect(note).toMatchObject({ ok: false, advisory: true });
  });

  it("knows each reviewed tool under its four record names, and no write tool or built-in", () => {
    const names = reviewedToolRecordNames("operations_manager");
    for (const tool of businessMcpToolNamesForRole("operations_manager", false)) for (const form of [tool, `mcp.${tool}`, `crm.${tool}`, `mcp__iacquire_business__${tool}`]) expect(names.has(form), form).toBe(true);
    for (const forbidden of ["web_search", "web_extract", "memory", "todo_list", "update_contact", "create_task", "request_appointment", "prepare_message"]) {
      expect([...names].some((name) => name.endsWith(forbidden)), forbidden).toBe(false);
    }
  });

  it("keeps the expected bookkeeping tables to the run, the conversation, the audit trail, tool records and one-minute tool tokens", () => {
    expect([...EXPECTED_BOOKKEEPING_TABLES].sort()).toEqual(["agent_runs", "audit_logs", "chat_conversations", "chat_messages", "crm_agent_tokens", "tool_executions"]);
  });
});

describe("A4a evidence: the module can only read, and never shows a record", () => {
  it("uses readSystem only, never a transaction helper, and contains no data-changing statement", () => {
    expect(source).toContain('import { readSystem } from "@/server/db";');
    expect(source).not.toMatch(/\bwithSystem\b|\bwithTenant\b|\bwithServiceRole\b/);
    const sql = [...source.matchAll(/`([^`]*\b(?:select|with)\b[^`]*)`|"((?:select|with) [^"]*)"/gi)].map((m) => m[1] ?? m[2]).join("\n");
    expect(sql.length).toBeGreaterThan(500);
    expect(sql).not.toMatch(/\b(insert\s+into|update\s+[a-z_"]+\s+set|delete\s+from|drop\s+|alter\s+table|truncate|create\s+(table|index|function))\b/i);
  });

  it("selects counts, names, ids and verdicts, never a title, name, message or note", () => {
    for (const column of ["title", "full_name", "first_name", "last_name", "email", "phone", "body", "notes", "description"]) {
      expect(source, column).not.toMatch(new RegExp(`\\b(?:select|,)\\s+[a-z_.]*${column}\\b`, "i"));
    }
    expect(script).not.toMatch(/console\.log\([^)]*(title|email|phone|body)\b/);
    expect(script).toContain('flag: "wx"');
  });

  it("is a read-only command: no import of a write path, no environment value printed", () => {
    expect(script).not.toMatch(/withSystem|DATABASE_URL|process\.env\./);
    expect(script).toContain("readAuthoritativeCounts");
  });
});

describe("A4a evidence: the queries, on a seeded database", () => {
  let agency: Awaited<ReturnType<typeof createOrg>>;
  let other: Awaited<ReturnType<typeof createOrg>>;
  const run = (sql: string, params: unknown[] = []) => withSystem((db) => db.query(sql, params));
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  /** The start of an acceptance window, with a clear gap on both sides so nothing seeded before it (or created right after) is misjudged. */
  const windowStart = async () => { await pause(40); const since = new Date().toISOString(); await pause(40); return since; };

  beforeAll(async () => {
    agency = await createOrg({ kind: "agency", name: "A4a Evidence Agency" });
    other = await createOrg({ kind: "client", name: "A4a Evidence Client" });
    await run("insert into tasks (org_id, title, status, due_at, completed_at) values ($1, 'T open overdue', 'open', now() - interval '2 days', null), ($1, 'T open', 'open', now() + interval '2 days', null), ($1, 'T done', 'done', null, now()), ($2, 'T other workspace', 'open', null, null)", [agency.id, other.id]);
    await run("insert into approval_requests (org_id, kind, title, status) values ($1, 'crm_update', 'A pending', 'pending'), ($1, 'crm_update', 'A pending 2', 'pending'), ($2, 'crm_update', 'A other workspace', 'pending')", [agency.id, other.id]);
  }, 120_000);

  it("finds the internal agency workspace", async () => {
    expect(await findInternalAgencyOrgId()).toBe(agency.id);
  });

  it("counts the facts straight from the tables, for the one workspace", async () => {
    expect(await readAuthoritativeCounts(agency.id)).toEqual({ openTasks: 2, overdueTasks: 1, pendingApprovals: 2, changesRequested: 0, blockedExecutions: 0 });
    expect(await readAuthoritativeCounts(other.id)).toMatchObject({ openTasks: 1, pendingApprovals: 1 });
  });

  it("lists workspace tables that record when a row was created or changed, and leaves the rest out", async () => {
    const tables = (await listWorkspaceTables()).map((entry) => entry.table);
    // Every workspace table is listed (a run or tool table that has no created_at is still counted by rows); only tables without org_id are left out.
    for (const expected of ["tasks", "approval_requests", "audit_logs", "agent_runs", "tool_executions", "agent_instances"]) expect(tables, expected).toContain(expected);
    expect(tables).not.toContain("organizations");
    expect(tables.every((name) => /^[a-z_][a-z0-9_]*$/.test(name))).toBe(true);
  });

  it("sees a created, changed or removed row anywhere in the workspace, ignores other workspaces, and calls the audit trail expected", async () => {
    const since = await windowStart();
    const baseline = await readRowCounts(agency.id);
    const changes = (deltas: Awaited<ReturnType<typeof readWriteDeltas>>) => deltas.filter((entry) => !entry.expected && (entry.created || entry.updated || entry.rowDelta));
    expect(changes(await readWriteDeltas(agency.id, since, baseline))).toEqual([]);
    await run("insert into audit_logs (org_id, actor_kind, action, result, metadata) values ($1, 'agent', 'hermes.business_mcp.read', 'success', '{}'::jsonb)", [agency.id]);
    await run("insert into tasks (org_id, title) values ($1, 'T created in another workspace')", [other.id]);
    let deltas = await readWriteDeltas(agency.id, since, baseline);
    expect(deltas.find((entry) => entry.table === "audit_logs")).toMatchObject({ created: 1, rowDelta: 1, expected: true });
    expect(changes(deltas)).toEqual([]);
    // A row created in this workspace is a write, seen by its timestamp and by its row count.
    await run("insert into tasks (org_id, title) values ($1, 'T created in the window')", [agency.id]);
    deltas = await readWriteDeltas(agency.id, since, baseline);
    expect(deltas.find((entry) => entry.table === "tasks")).toMatchObject({ created: 1, rowDelta: 1, expected: false });
    expect(evaluateA4aEvidence(input({ deltas })).checks.find((check) => check.id === "zero_business_writes")).toMatchObject({ ok: false });
    // A row changed (not created) in the window is a write too.
    await run("update approval_requests set reason = 'changed in the window', updated_at = now() where org_id = $1 and title = 'A pending'", [agency.id]);
    deltas = await readWriteDeltas(agency.id, since, baseline);
    expect(deltas.find((entry) => entry.table === "approval_requests")?.updated).toBeGreaterThanOrEqual(1);
    // A row removed is a write, even though no timestamp shows it: the count against the baseline does.
    await run("delete from tasks where org_id = $1 and title = 'T open'", [agency.id]);
    deltas = await readWriteDeltas(agency.id, since, baseline);
    expect(deltas.find((entry) => entry.table === "tasks")).toMatchObject({ rowDelta: 0 });
    await run("delete from tasks where org_id = $1 and title = 'T created in the window'", [agency.id]);
    expect(deltas.find((entry) => entry.table === "tasks")).toBeDefined();
    deltas = await readWriteDeltas(agency.id, since, baseline);
    expect(deltas.find((entry) => entry.table === "tasks")).toMatchObject({ rowDelta: -1 });
    // A table with no created_at is still counted: a run is a bookkeeping table (expected), but its row is seen.
    const employee = await agentId(agency.id, "crm_manager");
    await run("insert into agent_runs (org_id, agent_instance_id, purpose, idempotency_key, status) values ($1, $2, 'chat', $3, 'queued')", [agency.id, employee, `a4a-delta-${Date.now()}`]);
    expect((await readWriteDeltas(agency.id, since, baseline)).find((entry) => entry.table === "agent_runs")).toMatchObject({ rowDelta: 1, expected: true });
    // Rows older than the window are not counted, and a missing baseline entry is not mistaken for a change.
    const future = new Date(Date.now() + 60_000).toISOString();
    expect((await readWriteDeltas(agency.id, future, await readRowCounts(agency.id))).filter((entry) => entry.created || entry.updated || entry.rowDelta)).toEqual([]);
  });

  it("reads one run's tool records and audit entries, as names, results and ids only", async () => {
    const employee = await agentId(agency.id, "operations_manager");
    const since = await windowStart();
    const baselineForRun = await readRowCounts(agency.id);
    const runRow = await run("insert into agent_runs (org_id, agent_instance_id, purpose, hermes_run_id, idempotency_key, status) values ($1, $2, 'chat', 'hermes-run-1', $3, 'completed') returning id", [agency.id, employee, `a4a-evidence-${Date.now()}`]);
    const runId = (runRow.rows[0] as { id: string }).id;
    await run("insert into tool_executions (run_id, org_id, tool_name, label, status) values ($1, $2, 'mcp.get_role_workspace_context', 'Reading iAcquire workspace information', 'completed'), ($1, $2, 'crm.find_contacts', 'Find contacts', 'completed')", [runId, agency.id]);
    await run("insert into audit_logs (org_id, actor_kind, agent_instance_id, action, target_type, target_id, result, metadata) values ($1, 'agent', $2, 'hermes.business_mcp.read', 'agent_run', $3, 'success', $4::jsonb)", [agency.id, employee, runId, JSON.stringify({ tool: "get_role_workspace_context", role: "operations_manager", jti: "0123456789abcdef", sections: "work_board:empty" })]);
    await run("insert into audit_logs (org_id, actor_kind, agent_instance_id, action, result, metadata) values ($1, 'agent', $2, 'crm.agent_tool.find_contacts', 'success', $3::jsonb)", [agency.id, employee, JSON.stringify({ tool: "find_contacts", runId })]);
    const evidence = await readRunEvidence(agency.id, runId, since);
    expect(evidence).toMatchObject({ found: true, role: "operations_manager", purpose: "chat", status: "completed", hasHermesRun: true });
    expect(evidence.tools).toEqual([{ name: "crm.find_contacts", status: "completed", count: 1 }, { name: "mcp.get_role_workspace_context", status: "completed", count: 1 }]);
    expect(evidence.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "hermes.business_mcp.read", result: "success", tool: "get_role_workspace_context", credentialId: "0123456789abcdef" }),
      expect.objectContaining({ action: "crm.agent_tool.find_contacts", result: "success", tool: "find_contacts" }),
    ]));
    expect(JSON.stringify(evidence)).not.toContain("work_board");
    expect((await readRunEvidence(other.id, runId, since)).found).toBe(false);
    const verdict = evaluateA4aEvidence(input({ run: evidence, deltas: (await readWriteDeltas(agency.id, since, baselineForRun)).map((entry) => ({ ...entry, created: entry.expected ? entry.created : 0, updated: entry.expected ? entry.updated : 0 })) }));
    expect(failing(verdict)).toEqual([]);
  });
});
