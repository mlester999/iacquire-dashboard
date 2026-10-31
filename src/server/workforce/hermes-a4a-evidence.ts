import "server-only";
import { readSystem } from "@/server/db";
import type { AgentRoleKey } from "@/lib/agents";
import { businessMcpToolNamesForRole } from "@/server/workforce/hermes-business-mcp-policy";

/**
 * Evidence for the A4a acceptance (the first supervised, read-only business-tool task): what the database says before and after, written independently of the code under test.
 *
 * Everything here goes through `readSystem`, which accepts only `select` and `with` statements, so this module cannot become a write path. It returns counts, names and ids, never a
 * record's content (no task titles, contact names, messages or approval text). The counts in `readAuthoritativeCounts` are deliberately plain SQL, not `prepareEmployeeEvidence`: an
 * employee's answer is compared against a query that shares no code with the tool that produced it. Operator procedure: docs/hermes-a4a-acceptance-plan-2026-10-31.md.
 */

/**
 * The tables an employee's own live Chat turn and its business read are expected to write: the run, the conversation, the audit trail, tool records and the one-minute tool tokens.
 * This list is checked against what the real handler writes (tests/hermes-business-mcp-capability-matrix.test.ts); any other table with a new, changed or removed row for the
 * workspace during the window is reported as a possible write.
 */
export const EXPECTED_BOOKKEEPING_TABLES: readonly string[] = ["agent_runs", "audit_logs", "chat_conversations", "chat_messages", "crm_agent_tokens", "tool_executions"];

export interface AuthoritativeCounts {
  openTasks: number;
  overdueTasks: number;
  pendingApprovals: number;
  changesRequested: number;
  blockedExecutions: number;
}

export interface TableDelta {
  table: string;
  /** Rows whose created_at is inside the window (0 for a table that has no created_at). */
  created: number;
  /** Rows changed, but not created, inside the window (0 for a table that has no updated_at). */
  updated: number;
  /** Row count now minus the baseline, for this workspace: catches inserts and deletes in any table, whatever its timestamp columns are called. */
  rowDelta: number;
  expected: boolean;
  /** Set when the table could not be read; the check then fails closed. */
  error?: string;
}

export interface RunEvidence {
  found: boolean;
  runId: string;
  role: AgentRoleKey | null;
  purpose: string | null;
  status: string | null;
  hasHermesRun: boolean;
  tools: Array<{ name: string; status: string; count: number }>;
  audit: Array<{ action: string; result: string; tool: string | null; role: string | null; credentialId: string | null; reason: string | null; count: number }>;
}

export interface EvidenceCheck {
  id: string;
  ok: boolean;
  detail: string;
  /** Reported, but does not decide the overall result (real business activity can change the counts during the window). */
  advisory?: boolean;
}

/**
 * The names under which one reviewed business tool shows up in `tool_executions`: its own name, the handler's audit row (`mcp.<tool>`), the CRM tool service's row (`crm.<tool>`) and the
 * name the gateway reports to the chat stream (`mcp__iacquire_business__<tool>`). Anything else in a run's tool records, a built-in such as web search included, is not a reviewed tool.
 */
export function reviewedToolRecordNames(role: AgentRoleKey): Set<string> {
  const names = new Set<string>();
  for (const tool of businessMcpToolNamesForRole(role, false)) for (const form of [tool, `mcp.${tool}`, `crm.${tool}`, `mcp__iacquire_business__${tool}`]) names.add(form);
  return names;
}

const TABLE_NAME = /^[a-z_][a-z0-9_]*$/;
const num = (value: unknown) => Number(value ?? 0);

export async function findInternalAgencyOrgId(): Promise<string | null> {
  return readSystem(async (db) => {
    const { rows } = await db.query<{ id: string }>("select id from organizations where kind = 'agency' order by created_at asc limit 1");
    return rows[0]?.id ?? null;
  });
}

/** The facts an Operations Manager answer is about, counted straight from the tables with no shared code. */
export async function readAuthoritativeCounts(orgId: string): Promise<AuthoritativeCounts> {
  return readSystem(async (db) => {
    const { rows } = await db.query<Record<string, unknown>>(
      `select
         (select count(*) from tasks where org_id = $1 and status in ('open', 'in_progress')) as open_tasks,
         (select count(*) from tasks where org_id = $1 and status in ('open', 'in_progress') and due_at is not null and due_at < now()) as overdue_tasks,
         (select count(*) from approval_requests where org_id = $1 and status = 'pending') as pending_approvals,
         (select count(*) from approval_requests where org_id = $1 and status = 'changes_requested') as changes_requested,
         (select count(*) from approval_requests where org_id = $1 and execution_status = 'blocked') as blocked_executions`,
      [orgId],
    );
    const row = rows[0] ?? {};
    return {
      openTasks: num(row.open_tasks), overdueTasks: num(row.overdue_tasks), pendingApprovals: num(row.pending_approvals),
      changesRequested: num(row.changes_requested), blockedExecutions: num(row.blocked_executions),
    };
  });
}

/** Base tables of the public schema that belong to a workspace (have org_id), and whether they record when a row was created or changed. */
export async function listWorkspaceTables(): Promise<Array<{ table: string; hasCreated: boolean; hasUpdated: boolean }>> {
  return readSystem(async (db) => {
    const { rows } = await db.query<{ table_name: string; has_created: boolean; has_updated: boolean }>(
      `select c.table_name,
              bool_or(c.column_name = 'created_at') as has_created,
              bool_or(c.column_name = 'updated_at') as has_updated
         from information_schema.columns c
         join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
        where c.table_schema = 'public'
        group by c.table_name
       having bool_or(c.column_name = 'org_id')
        order by c.table_name`,
    );
    return rows.filter((row) => TABLE_NAME.test(row.table_name)).map((row) => ({ table: row.table_name, hasCreated: row.has_created, hasUpdated: row.has_updated }));
  });
}

interface TableStats {
  rows: number;
  created: number;
  updated: number;
}

/** One query per table: the workspace's row count and, when `sinceIso` is given, the rows created and the rows changed (but not created) since then. Null when it cannot be read. */
async function readTableStats(table: string, hasCreated: boolean, hasUpdated: boolean, orgId: string, sinceIso: string | null): Promise<TableStats | null> {
  // $2 appears in the statement only when it is used, because Postgres refuses a bound value that nothing refers to.
  const created = sinceIso && hasCreated ? "count(*) filter (where created_at >= $2::timestamptz)" : "0";
  const updated = sinceIso && hasUpdated ? `count(*) filter (where updated_at >= $2::timestamptz${hasCreated ? " and created_at < $2::timestamptz" : ""})` : "0";
  const usesSince = created !== "0" || updated !== "0";
  try {
    return await readSystem(async (db) => {
      const { rows } = await db.query<{ n: number; created: number; updated: number }>(
        `select count(*)::int as n, ${created}::int as created, ${updated}::int as updated from "${table}" where org_id::text = $1::text`,
        usesSince ? [orgId, sinceIso] : [orgId],
      );
      return { rows: num(rows[0]?.n), created: num(rows[0]?.created), updated: num(rows[0]?.updated) };
    });
  } catch {
    return null;
  }
}

/** Row counts of every workspace table for this workspace, now. A table that cannot be counted is null, and then fails the write check closed. */
export async function readRowCounts(orgId: string): Promise<Record<string, number | null>> {
  const counts: Record<string, number | null> = {};
  for (const { table, hasCreated, hasUpdated } of await listWorkspaceTables()) counts[table] = (await readTableStats(table, hasCreated, hasUpdated, orgId, null))?.rows ?? null;
  return counts;
}

/**
 * For every workspace table: rows created and rows changed (but not created) for this workspace since `sinceIso`, and the change in its row count against the baseline. The
 * timestamp columns see an insert or an update in a table that has them; the row count sees an insert or a delete in any table. A table that could not be read is reported, never
 * skipped. An update in a table with no updated_at is the one thing neither can see (the operator procedure says so).
 */
export async function readWriteDeltas(orgId: string, sinceIso: string, baselineCounts: Record<string, number | null> = {}): Promise<TableDelta[]> {
  const deltas: TableDelta[] = [];
  for (const { table, hasCreated, hasUpdated } of await listWorkspaceTables()) {
    const expected = EXPECTED_BOOKKEEPING_TABLES.includes(table);
    const hasBaseline = Object.prototype.hasOwnProperty.call(baselineCounts, table);
    const before = hasBaseline ? baselineCounts[table] : undefined;
    const stats = await readTableStats(table, hasCreated, hasUpdated, orgId, sinceIso);
    if (!stats || (hasBaseline && before === null)) {
      deltas.push({ table, created: 0, updated: 0, rowDelta: 0, expected, error: "could not be read" });
      continue;
    }
    deltas.push({ table, created: stats.created, updated: stats.updated, rowDelta: typeof before === "number" ? stats.rows - before : 0, expected });
  }
  return deltas;
}

/** What one acceptance run left behind: the run, its tool records and the business audit entries since `sinceIso` (names, results and credential ids only). */
export async function readRunEvidence(orgId: string, runId: string, sinceIso: string): Promise<RunEvidence> {
  return readSystem(async (db) => {
    const run = await db.query<{ role_key: AgentRoleKey; purpose: string; status: string; has_hermes_run: boolean }>(
      `select a.role_key, r.purpose, r.status, (r.hermes_run_id is not null) as has_hermes_run
         from agent_runs r join agent_instances a on a.id = r.agent_instance_id
        where r.id = $1 and r.org_id = $2`,
      [runId, orgId],
    );
    const tools = await db.query<{ tool_name: string; status: string; n: number }>(
      "select tool_name, status, count(*)::int as n from tool_executions where run_id = $1 and org_id = $2 group by tool_name, status order by tool_name, status",
      [runId, orgId],
    );
    const audit = await db.query<{ action: string; result: string; tool: string | null; role: string | null; jti: string | null; reason: string | null; n: number }>(
      `select action, result, metadata->>'tool' as tool, metadata->>'role' as role, metadata->>'jti' as jti, metadata->>'reason' as reason, count(*)::int as n
         from audit_logs
        where org_id = $1 and created_at >= $2::timestamptz and action like 'hermes.business_mcp.%'
        group by action, result, metadata->>'tool', metadata->>'role', metadata->>'jti', metadata->>'reason'
        order by action, result, 3`,
      [orgId, sinceIso],
    );
    // The CRM tool service writes its own audit entries (crm.agent_tool.<tool>) and carries the run id in their metadata.
    const crmAudit = await db.query<{ action: string; result: string; tool: string | null; n: number }>(
      `select action, result, metadata->>'tool' as tool, count(*)::int as n
         from audit_logs
        where org_id = $1 and created_at >= $2::timestamptz and action like 'crm.agent_tool.%' and metadata->>'runId' = $3
        group by action, result, metadata->>'tool' order by action, result`,
      [orgId, sinceIso, runId],
    );
    const row = run.rows[0];
    return {
      found: Boolean(row), runId, role: row?.role_key ?? null, purpose: row?.purpose ?? null, status: row?.status ?? null, hasHermesRun: Boolean(row?.has_hermes_run),
      tools: tools.rows.map((entry) => ({ name: entry.tool_name, status: entry.status, count: num(entry.n) })),
      audit: [
        ...audit.rows.map((entry) => ({ action: entry.action, result: entry.result, tool: entry.tool, role: entry.role, credentialId: entry.jti, reason: entry.reason, count: num(entry.n) })),
        ...crmAudit.rows.map((entry) => ({ action: entry.action, result: entry.result, tool: entry.tool, role: null, credentialId: null, reason: null, count: num(entry.n) })),
      ],
    };
  });
}

export interface EvidenceInput {
  role: AgentRoleKey;
  before: AuthoritativeCounts;
  after: AuthoritativeCounts;
  deltas: TableDelta[];
  run: RunEvidence;
  /** The id of the credential installed for this employee (printed by the issuing script); when given, every audit entry must carry it. */
  credentialId?: string;
}

/** Turns the evidence into pass/fail checks. Pure, so it is tested without a database. */
export function evaluateA4aEvidence(input: EvidenceInput): { ok: boolean; checks: EvidenceCheck[] } {
  const { role, run, deltas } = input;
  const checks: EvidenceCheck[] = [];
  const add = (id: string, ok: boolean, detail: string, advisory = false) => checks.push({ id, ok, detail, ...(advisory ? { advisory } : {}) });
  const reviewed = reviewedToolRecordNames(role);

  add("run_found", run.found, run.found ? "the run exists in this workspace" : "no such run in this workspace");
  const otherRole = run.audit.filter((entry) => entry.role && entry.role !== role);
  add("employee_identity", run.role === role && otherRole.length === 0, otherRole.length ? "an audit entry names another employee role" : `run belongs to ${run.role ?? "nothing"}, expected ${role}`);
  add("authenticated_chat_turn", run.purpose === "chat" && run.hasHermesRun && (run.status === "completed" || run.status === "running"), `purpose ${run.purpose}, status ${run.status}, gateway run ${run.hasHermesRun ? "recorded" : "missing"}`);

  const outside = run.tools.filter((entry) => !reviewed.has(entry.name));
  add("only_reviewed_tools", run.tools.length > 0 && outside.length === 0, outside.length ? `unreviewed tool records: ${outside.map((entry) => entry.name).join(", ")}` : `${run.tools.length} tool record kind(s), all in the reviewed list`);
  const completed = run.tools.filter((entry) => entry.status === "completed" && reviewed.has(entry.name));
  add("tool_invocation_recorded", completed.length > 0, completed.length ? `${completed.reduce((sum, entry) => sum + entry.count, 0)} completed reviewed tool call(s)` : "no completed reviewed tool call is recorded");

  const reads = run.audit.filter((entry) => (entry.action === "hermes.business_mcp.read" || entry.action.startsWith("crm.agent_tool.")) && entry.result === "success");
  add("audit_trail", reads.length > 0, reads.length ? `${reads.reduce((sum, entry) => sum + entry.count, 0)} successful business read audit entr(ies)` : "no successful business read audit entry");
  const refused = run.audit.filter((entry) => entry.result !== "success" || entry.action === "hermes.business_mcp.auth_denied");
  add("no_denials", refused.length === 0, refused.length ? `denied or failed: ${refused.map((entry) => `${entry.action}${entry.reason ? `(${entry.reason})` : ""}`).join(", ")}` : "no denied or failed business entry in the window");
  if (input.credentialId) {
    const foreign = run.audit.filter((entry) => entry.credentialId && entry.credentialId !== input.credentialId);
    add("credential_id", foreign.length === 0 && run.audit.some((entry) => entry.credentialId === input.credentialId), foreign.length ? "an audit entry carries another credential id" : "every entry carries the installed credential's id");
  }

  const unexpected = deltas.filter((entry) => !entry.expected && (entry.created > 0 || entry.updated > 0 || entry.rowDelta !== 0));
  const unreadable = deltas.filter((entry) => entry.error);
  add("zero_business_writes", unexpected.length === 0 && unreadable.length === 0,
    unexpected.length || unreadable.length
      ? `${unexpected.map((entry) => `${entry.table} (+${entry.created} new, ${entry.updated} changed, rows ${entry.rowDelta >= 0 ? "+" : ""}${entry.rowDelta})`).join(", ")}${unreadable.length ? ` unreadable: ${unreadable.map((entry) => entry.table).join(", ")}` : ""}`
      : `no row created, changed or removed in ${deltas.filter((entry) => !entry.expected).length} business tables of this workspace`);
  const same = JSON.stringify(input.before) === JSON.stringify(input.after);
  add("facts_stable", same, same ? "the authoritative counts did not change during the window, so one comparison is exact" : "the counts changed during the window (see before and after); compare the answer with the nearer one and say so", true);
  return { ok: checks.filter((check) => !check.advisory).every((check) => check.ok), checks };
}
