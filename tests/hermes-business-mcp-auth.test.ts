// D3: the business MCP endpoint's authentication and authorization, driven through the real handler against a seeded database (synthetic workspaces; a local stand-in for the Hermes
// gateway; no network). Every refusal here is also checked for side effects: a request that is refused must create no token, approval, run, tool record or business record.
//
// What these prove: the signed credential opens the endpoint and nothing else; the Hermes profile API key no longer does; a credential for the wrong employee, role, workspace or
// profile, an altered, expired, revoked or rotated-out one, and one whose employee is switched off, are all refused; and holding a valid credential is still not enough to read anything
// without that employee's own live Chat turn, run by a Super Admin who still belongs to the workspace.
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENCY_HERMES_PROFILE_IDS, AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { verifyAgentToolToken } from "@/server/crm/agent-tools/tokens";
import { callAgentTool } from "@/server/crm/agent-tools/service";
import { handleHermesBusinessMcp } from "@/server/workforce/hermes-business-mcp";
import { issueBusinessMcpCredentialWithSecret, issueConfiguredBusinessMcpCredential } from "@/server/workforce/hermes-business-mcp-credential";
import { internalEmployeesForCredentials, writeCredentialFiles } from "@/server/workforce/hermes-business-mcp-issue";
import { businessMcpToolNamesForRole } from "@/server/workforce/hermes-business-mcp-policy";
import { getProvisioningBundle } from "@/server/workforce/provisioning";
import { connectHermesProfile, createConfigVersion, runHealthCheck } from "@/server/workforce/service";
import { defaultSettings } from "@/server/workforce/compiler";
import { addMember, agentId, createOrg, createUser } from "./support/fixtures";
import { startMockHermes, type MockHermes } from "./support/mock-hermes";
import { MCP_TEST_PREVIOUS_SECRET, MCP_TEST_SECRET } from "./support/business-mcp";

const URL = "https://portal.example.test/api/internal/hermes-business/mcp";
// The profile API keys connect the employees to the stand-in gateway. They are a different thing from the signed credentials, and the endpoint must refuse them.
const PROFILE_KEYS = Object.fromEntries(AGENT_ROLE_KEYS.map((role) => [role, `synthetic-${role}-profile-key-0123456789`])) as Record<AgentRoleKey, string>;
const CREDENTIALS = {} as Record<AgentRoleKey, string>;
const IDS = {} as Record<AgentRoleKey, string>;

let mock: MockHermes;
let agency: Awaited<ReturnType<typeof createOrg>>;
let client: Awaited<ReturnType<typeof createOrg>>;
let admin: { id: string; email: string };
let staff: { id: string; email: string };

interface Rpc {
  status: number;
  text: string;
  json: { result?: { content?: Array<{ text: string }>; isError?: boolean; tools?: Array<{ name: string }> }; error?: { code: number; message: string } } | null;
  headers: Headers;
}

let ipSequence = 10;
const nextIp = () => `203.0.113.${(ipSequence += 1)}`;

async function post(token: string | null | undefined, body: Record<string, unknown> = { jsonrpc: "2.0", id: 1, method: "tools/list" }, ip = nextIp()): Promise<Rpc> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "x-forwarded-for": ip };
  if (token !== null && token !== undefined) headers.Authorization = `Bearer ${token}`;
  const response = await handleHermesBusinessMcp(new Request(URL, { method: "POST", headers, body: JSON.stringify(body) }));
  const text = await response.text();
  let json: Rpc["json"] = null;
  try { json = JSON.parse(text) as Rpc["json"]; } catch { /* a plain-text refusal */ }
  return { status: response.status, text, json, headers: response.headers };
}

const call = (name: string, args: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } });
const toolText = (rpc: Rpc) => rpc.json?.result?.content?.[0]?.text ?? "";
const refused = (rpc: Rpc) => rpc.json?.result?.isError === true || rpc.json?.error !== undefined;

/** Everything a refused request must leave exactly as it found it. */
async function sideEffects() {
  return withSystem(async (db) => {
    const counts: Record<string, number> = {};
    for (const table of ["crm_agent_tokens", "approval_requests", "tool_executions", "agent_runs", "leads", "contacts", "tasks", "crm_opportunities", "conversations", "notifications"]) {
      counts[table] = Number((await db.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0].n);
    }
    counts.mcp_audit = Number((await db.query<{ n: number }>("select count(*)::int as n from audit_logs where action like 'hermes.business_mcp.%' or action like 'crm.agent_tool%'")).rows[0].n);
    return counts;
  });
}

async function auditRows(action: string) {
  const { rows } = await withSystem((db) => db.query<{ org_id: string | null; result: string; metadata: Record<string, unknown>; ip_hash: string | null; agent_instance_id: string | null }>(
    "select org_id, result, metadata, ip_hash, agent_instance_id from audit_logs where action = $1 order by id", [action],
  ));
  return rows;
}

/** A running Chat turn for this employee, as the person, bound to the employee's active configuration. Earlier turns are ended first. */
async function startTurn(role: AgentRoleKey, userId: string, options: { purpose?: string; ageMinutes?: number } = {}) {
  await withSystem(async (db) => {
    await db.query("update agent_runs set status = 'completed' where agent_instance_id = $1 and status = 'running'", [IDS[role]]);
    const { rows } = await db.query<{ active_config_version_id: string }>("select active_config_version_id from agent_instances where id = $1", [IDS[role]]);
    await db.query(
      `insert into agent_runs (org_id, agent_instance_id, user_id, purpose, idempotency_key, status, started_at, hermes_run_id, config_version_id)
       values ($1, $2, $3, $4, $5, 'running', now() - ($6 || ' minutes')::interval, $7, $8)`,
      [agency.id, IDS[role], userId, options.purpose ?? "chat", `auth-test-${role}-${Math.random().toString(36).slice(2)}`, String(options.ageMinutes ?? 0), `run-${Math.random().toString(36).slice(2)}`, rows[0].active_config_version_id],
    );
  });
}

const endTurns = (role: AgentRoleKey) => withSystem((db) => db.query("update agent_runs set status = 'completed' where agent_instance_id = $1 and status = 'running'", [IDS[role]]));

/** Changes a row for the length of one check and always puts it back. */
async function temporarily<T>(change: string, restore: string, params: unknown[], run: () => Promise<T>): Promise<T> {
  await withSystem((db) => db.query(change, params));
  try {
    return await run();
  } finally {
    await withSystem((db) => db.query(restore, params));
  }
}

const sign = (role: AgentRoleKey, over: Partial<Parameters<typeof issueBusinessMcpCredentialWithSecret>[1]> = {}, secret = MCP_TEST_SECRET) =>
  issueBusinessMcpCredentialWithSecret(secret, { role, agentId: IDS[role], orgId: agency.id, ...over });

beforeAll(async () => {
  mock = await startMockHermes(Object.fromEntries(AGENT_ROLE_KEYS.map((role) => [AGENCY_HERMES_PROFILE_IDS[role], { key: PROFILE_KEYS[role] }])));
  admin = await createUser({ platformRole: "agency_super_admin", name: "Auth Admin" });
  staff = await createUser({ platformRole: "agency_staff", name: "Auth Staff" });
  agency = await createOrg({ name: "Auth Agency", kind: "agency" });
  client = await createOrg({ name: "Auth Client" });
  await addMember(agency.id, admin.id, "owner");
  await addMember(agency.id, staff.id, "owner");
  await withSystem(async (db) => {
    await db.query("insert into leads (org_id, business_name, review_status) values ($1, 'Auth Only Lead', 'pending')", [agency.id]);
    await db.query("insert into leads (org_id, business_name, review_status) values ($1, 'Client Secret Lead', 'pending')", [client.id]);
  });
  for (const role of AGENT_ROLE_KEYS) {
    IDS[role] = await agentId(agency.id, role);
    await withSystem((db) => createConfigVersion(db, { orgId: agency.id, agentId: IDS[role], settings: defaultSettings(role), source: "onboarding", userId: admin.id, apply: true }));
    await connectHermesProfile({ agentId: IDS[role], baseUrl: mock.url, profile: AGENCY_HERMES_PROFILE_IDS[role], apiKey: PROFILE_KEYS[role], agencyUserId: admin.id });
    expect(await runHealthCheck(IDS[role], { userId: admin.id, kind: "agency" })).toMatchObject({ ok: true, status: "online" });
  }
  vi.stubEnv("HERMES_BUSINESS_MCP_ENABLED", "true");
  vi.stubEnv("HERMES_BUSINESS_MCP_WRITES_ENABLED", "false");
  vi.stubEnv("HERMES_BUSINESS_MCP_SECRET", MCP_TEST_SECRET);
  resetEnvCache();
  for (const role of AGENT_ROLE_KEYS) CREDENTIALS[role] = issueConfiguredBusinessMcpCredential({ role, agentId: IDS[role], orgId: agency.id }).token;
}, 120_000);

beforeEach(async () => {
  // The per-employee call limit is 60 a minute; this file makes more than that in total, so every check starts with empty counters.
  await withSystem((db) => db.query("delete from rate_limit_buckets"));
});

afterEach(() => {
  vi.stubEnv("HERMES_BUSINESS_MCP_ENABLED", "true");
  vi.stubEnv("HERMES_BUSINESS_MCP_SECRET", MCP_TEST_SECRET);
  vi.stubEnv("HERMES_BUSINESS_MCP_SECRET_PREVIOUS", "");
  vi.stubEnv("HERMES_BUSINESS_MCP_REVOKED_TOKEN_IDS", "");
  resetEnvCache();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  resetEnvCache();
  await mock.close();
});

describe("the signed credential opens the endpoint for its own employee", () => {
  it("answers tools/list for every employee with exactly that role's read tools and nothing administrative", async () => {
    for (const role of AGENT_ROLE_KEYS) {
      const rpc = await post(CREDENTIALS[role]);
      expect(rpc.status, role).toBe(200);
      const names = (rpc.json?.result?.tools ?? []).map((tool) => tool.name).sort();
      expect(names, role).toEqual([...businessMcpToolNamesForRole(role, false)].sort());
      // Reads only: nothing that writes, sends, books, approves or administers.
      expect(names.filter((name) => /write|create|update|delete|apply|remove|move|request|prepare|send|approve|admin|exec|shell|file|terminal|browser/i.test(name)), role).toEqual([]);
    }
  });

  it("is off, with a plain 404, when the switch is off, whatever credential is presented", async () => {
    vi.stubEnv("HERMES_BUSINESS_MCP_ENABLED", "false");
    resetEnvCache();
    const before = await sideEffects();
    const rpc = await post(CREDENTIALS.crm_manager);
    expect(rpc.status).toBe(404);
    expect(await sideEffects()).toEqual(before);
  });
});

describe("what does not open the endpoint (and changes nothing)", () => {
  const unsigned: Array<[string, () => string | null]> = [
    ["no credential at all", () => null],
    ["an empty credential", () => ""],
    ["a Hermes profile API key, which used to open this endpoint", () => PROFILE_KEYS.crm_manager],
    ["a 64-character hexadecimal key", () => "a".repeat(64)],
    ["a credential under another secret", () => sign("crm_manager", {}, "another-deployments-signing-secret-000000").token],
    ["a credential with another employee's role grafted on", () => CREDENTIALS.crm_manager.replace("crm_manager", "lead_hunter")],
    ["a credential with a longer life grafted on", () => CREDENTIALS.crm_manager.split(".").map((part, i) => (i === 5 ? String(Number(part) + 86_400) : part)).join(".")],
    ["a credential cut short", () => CREDENTIALS.crm_manager.slice(0, -4)],
    ["a credential with an extra part", () => `${CREDENTIALS.crm_manager}.x`],
    ["a very long value", () => "x".repeat(20_000)],
  ];

  for (const [label, token] of unsigned) {
    it(`refuses ${label}, with no detail, no log entry and no side effect`, async () => {
      const before = await sideEffects();
      const value = token();
      const rpc = await post(value);
      expect(rpc.status).toBe(401);
      expect(rpc.headers.get("www-authenticate")).toMatch(/^Bearer realm=/);
      expect(rpc.headers.get("cache-control")).toBe("no-store");
      expect(rpc.text).toBe("Unauthorized");
      // A request nobody can attribute is only counted. It writes no log entry of its own.
      expect(await sideEffects()).toEqual(before);
      expect(await auditRows("hermes.business_mcp.auth_denied")).toHaveLength(0);
    });
  }

  it("is the same for a valid profile key as the gateway sees it: the key is real, yet the business endpoint will not take it", async () => {
    const gateway = await fetch(`${mock.url}/p/${AGENCY_HERMES_PROFILE_IDS.crm_manager}/v1/capabilities`, { headers: { Authorization: `Bearer ${PROFILE_KEYS.crm_manager}` } });
    expect(gateway.status).toBe(200);
    expect((await post(PROFILE_KEYS.crm_manager)).status).toBe(401);
  });

  it("gives a refused caller nothing it could use: no credential, secret or key in any answer", async () => {
    for (const token of [null, PROFILE_KEYS.crm_manager, CREDENTIALS.crm_manager.slice(0, -2)]) {
      const rpc = await post(token);
      for (const secret of [MCP_TEST_SECRET, MCP_TEST_PREVIOUS_SECRET, PROFILE_KEYS.crm_manager, CREDENTIALS.crm_manager]) expect(rpc.text).not.toContain(secret);
    }
  });

  it("slows a client address that keeps failing, and still serves a valid credential from it", async () => {
    const ip = "198.51.100.77";
    const statuses: number[] = [];
    for (let i = 0; i < 32; i += 1) statuses.push((await post("not-a-credential", undefined, ip)).status);
    expect(statuses.slice(0, 30).every((status) => status === 401)).toBe(true);
    expect(statuses.slice(30)).toEqual([429, 429]);
    const limited = await post("not-a-credential", undefined, ip);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    // A good credential is never counted against the address that is failing.
    expect((await post(CREDENTIALS.crm_manager, undefined, ip)).status).toBe(200);
  });
});

describe("a credential this server signed but cannot honour is refused and recorded", () => {
  it("expired: refused, and the refusal is audited against the employee's workspace with the credential's id only", async () => {
    const before = (await sideEffects()).tool_executions;
    const issued = sign("crm_manager", { issuedAt: new Date(Date.now() - 3_600_000), ttlSeconds: 600 });
    const rpc = await post(issued.token);
    expect(rpc.status).toBe(401);
    const rows = await auditRows("hermes.business_mcp.auth_denied");
    const row = rows.find((entry) => entry.metadata.jti === issued.claims.credentialId)!;
    expect(row).toMatchObject({ org_id: agency.id, result: "denied", agent_instance_id: IDS.crm_manager, metadata: { reason: "expired", role: "crm_manager" } });
    expect(JSON.stringify(row)).not.toContain(issued.token);
    expect(JSON.stringify(row)).not.toContain(MCP_TEST_SECRET);
    expect((await sideEffects()).tool_executions).toBe(before);
  });

  it("ended by its id: refused and audited, while the employee's other credential keeps working", async () => {
    const revoked = sign("sales_assistant");
    const other = sign("sales_assistant");
    expect((await post(revoked.token)).status).toBe(200);
    vi.stubEnv("HERMES_BUSINESS_MCP_REVOKED_TOKEN_IDS", revoked.claims.credentialId);
    resetEnvCache();
    expect((await post(revoked.token)).status).toBe(401);
    expect((await auditRows("hermes.business_mcp.auth_denied")).some((row) => row.metadata.reason === "revoked" && row.metadata.jti === revoked.claims.credentialId)).toBe(true);
    expect((await post(other.token)).status).toBe(200);
  });

  it("rotation: the previous secret works while listed, a new credential works throughout, and removing the previous secret ends the old ones", async () => {
    const old = sign("appointment_setter", {}, MCP_TEST_PREVIOUS_SECRET);
    const fresh = sign("appointment_setter");
    expect((await post(old.token)).status).toBe(401); // not yet listed
    vi.stubEnv("HERMES_BUSINESS_MCP_SECRET_PREVIOUS", MCP_TEST_PREVIOUS_SECRET);
    resetEnvCache();
    expect((await post(old.token)).status).toBe(200);
    expect((await post(fresh.token)).status).toBe(200);
    vi.stubEnv("HERMES_BUSINESS_MCP_SECRET_PREVIOUS", "");
    resetEnvCache();
    expect((await post(old.token)).status).toBe(401);
    expect((await post(fresh.token)).status).toBe(200);
  });

  it("rotating the current secret ends every credential the old one signed", async () => {
    const before = CREDENTIALS.lead_hunter;
    vi.stubEnv("HERMES_BUSINESS_MCP_SECRET", MCP_TEST_PREVIOUS_SECRET);
    resetEnvCache();
    expect((await post(before)).status).toBe(401);
  });

  it("wrong employee for the role (a real employee id under another role): refused as an employee that is not active", async () => {
    const mismatched = sign("crm_manager", { agentId: IDS.lead_hunter });
    const rpc = await post(mismatched.token);
    expect(rpc.status).toBe(401);
    expect((await auditRows("hermes.business_mcp.auth_denied")).some((row) => row.metadata.reason === "employee_not_active" && row.metadata.jti === mismatched.claims.credentialId)).toBe(true);
  });

  it("another workspace: a client's employee, the right employee with another workspace's id, and a workspace that does not exist", async () => {
    // The database allows one agency workspace only (organizations_single_agency), so "another tenant" means a client workspace, and it refuses to let a client's
    // employee carry an internal profile name at all (reserved_hermes_profile), so the profile check is a second line of defence behind it.
    const clientAgent = await agentId(client.id, "lead_hunter");
    await expect(withSystem((db) => db.query("update agent_instances set hermes_profile = $2, hermes_base_url = 'http://other-gateway.test' where id = $1", [clientAgent, AGENCY_HERMES_PROFILE_IDS.lead_hunter])))
      .rejects.toThrow(/reserved_hermes_profile/);
    const cases = [
      sign("lead_hunter", { agentId: clientAgent, orgId: client.id }),
      sign("lead_hunter", { agentId: IDS.lead_hunter, orgId: client.id }),
      sign("lead_hunter", { agentId: clientAgent, orgId: agency.id }),
      sign("lead_hunter", { orgId: "99999999-9999-4999-8999-999999999999" }),
    ];
    await startTurn("lead_hunter", admin.id);
    const before = await sideEffects();
    for (const issued of cases) {
      const rpc = await post(issued.token, call("get_role_workspace_context"));
      expect(rpc.status).toBe(401);
      expect(rpc.text).not.toMatch(/Auth Only Lead|Client Secret Lead/);
    }
    // Only the audit entries for the refusals themselves differ; nothing was read, issued, created or changed.
    const after = await sideEffects();
    expect({ ...after, mcp_audit: 0 }).toEqual({ ...before, mcp_audit: 0 });
    await endTurns("lead_hunter");
  });

  it("a switched-off or unready employee: disabled, workspace suspended, Hermes credential revoked, profile re-mapped", async () => {
    const id = IDS.operations_manager;
    const cred = CREDENTIALS.operations_manager;
    expect((await post(cred)).status).toBe(200);
    await temporarily("update agent_instances set enabled = false where id = $1", "update agent_instances set enabled = true where id = $1", [id], async () => {
      expect((await post(cred)).status).toBe(401);
    });
    await temporarily("update organizations set status = 'suspended' where id = $1", "update organizations set status = 'active' where id = $1", [agency.id], async () => {
      expect((await post(cred)).status).toBe(401);
    });
    await temporarily(
      "update integration_credentials set revoked_at = now() where id = (select credential_id from agent_instances where id = $1)",
      "update integration_credentials set revoked_at = null where id = (select credential_id from agent_instances where id = $1)", [id],
      async () => { expect((await post(cred)).status).toBe(401); },
    );
    await temporarily("update agent_instances set hermes_profile = 'iacquire-lead-hunter-copy' where id = $1", `update agent_instances set hermes_profile = '${AGENCY_HERMES_PROFILE_IDS.operations_manager}' where id = $1`, [id], async () => {
      expect((await post(cred)).status).toBe(401);
    });
    expect((await post(cred)).status).toBe(200);
  });
});

describe("a valid credential alone reads nothing: the employee's own live Chat turn is still required", () => {
  const contextRead = (role: AgentRoleKey) => post(CREDENTIALS[role], call("get_role_workspace_context"));

  it("refuses without a turn, and a refusal creates no token, approval or record", async () => {
    await endTurns("lead_hunter");
    const before = await sideEffects();
    const rpc = await contextRead("lead_hunter");
    expect(rpc.status).toBe(200);
    expect(refused(rpc)).toBe(true);
    expect(toolText(rpc)).toMatch(/active, authenticated Chat turn/);
    expect(toolText(rpc)).not.toMatch(/Auth Only Lead/);
    const after = await sideEffects();
    expect({ ...after, tool_executions: 0, mcp_audit: 0 }).toEqual({ ...before, tool_executions: 0, mcp_audit: 0 });
  });

  it("refuses another employee's turn, a turn of another kind, one that is too old, two at once, and one started on an older configuration", async () => {
    await startTurn("crm_manager", admin.id);
    expect(refused(await contextRead("lead_hunter"))).toBe(true);

    await startTurn("lead_hunter", admin.id, { purpose: "lead_research" });
    expect(refused(await contextRead("lead_hunter"))).toBe(true);

    await startTurn("lead_hunter", admin.id, { ageMinutes: 25 });
    expect(refused(await contextRead("lead_hunter"))).toBe(true);

    await startTurn("lead_hunter", admin.id);
    await withSystem((db) => db.query(
      `insert into agent_runs (org_id, agent_instance_id, user_id, purpose, idempotency_key, status, started_at, hermes_run_id, config_version_id)
       select org_id, agent_instance_id, user_id, purpose, idempotency_key || '-twin', status, started_at, hermes_run_id || '-twin', config_version_id
         from agent_runs where agent_instance_id = $1 and status = 'running'`, [IDS.lead_hunter],
    ));
    expect(refused(await contextRead("lead_hunter"))).toBe(true);

    await startTurn("lead_hunter", admin.id);
    expect(refused(await contextRead("lead_hunter"))).toBe(false);
    const newer = await withSystem(async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into agent_config_versions (org_id, agent_instance_id, version, settings, summary, compiled_instructions, policy_version, source, status)
         values ($1, $2, (select coalesce(max(version), 0) + 1 from agent_config_versions where agent_instance_id = $2), '{}', 's', '# newer', 'p', 'onboarding', 'applied') returning id`, [agency.id, IDS.lead_hunter],
      );
      const previous = await db.query<{ active_config_version_id: string }>("select active_config_version_id from agent_instances where id = $1", [IDS.lead_hunter]);
      await db.query("update agent_instances set active_config_version_id = $2 where id = $1", [IDS.lead_hunter, rows[0].id]);
      return previous.rows[0].active_config_version_id;
    });
    expect(refused(await contextRead("lead_hunter"))).toBe(true);
    await withSystem((db) => db.query("update agent_instances set active_config_version_id = $2 where id = $1", [IDS.lead_hunter, newer]));
    await endTurns("lead_hunter");
    await endTurns("crm_manager");
  });

  it("refuses when the employee's inventory proof has expired or its connection check no longer passes", async () => {
    await startTurn("sales_assistant", admin.id);
    expect(refused(await post(CREDENTIALS.sales_assistant, call("get_role_workspace_context")))).toBe(false);
    await temporarily("update agent_instances set tool_inventory_expires_at = now() - interval '1 minute' where id = $1", "update agent_instances set tool_inventory_expires_at = now() + interval '1 hour' where id = $1", [IDS.sales_assistant], async () => {
      expect(refused(await post(CREDENTIALS.sales_assistant, call("get_role_workspace_context")))).toBe(true);
    });
    await temporarily("update agent_instances set last_health_ok = false where id = $1", "update agent_instances set last_health_ok = true where id = $1", [IDS.sales_assistant], async () => {
      expect(refused(await post(CREDENTIALS.sales_assistant, call("get_role_workspace_context")))).toBe(true);
    });
    await temporarily("update agent_instances set status = 'offline' where id = $1", "update agent_instances set status = 'online' where id = $1", [IDS.sales_assistant], async () => {
      expect(refused(await post(CREDENTIALS.sales_assistant, call("get_role_workspace_context")))).toBe(true);
    });
    await endTurns("sales_assistant");
  });

  it("refuses when the person running the turn is not an iAcquire Super Admin, for the context tool and for a CRM tool alike", async () => {
    await startTurn("crm_manager", staff.id);
    const before = await sideEffects();
    const context = await post(CREDENTIALS.crm_manager, call("get_role_workspace_context"));
    const summary = await post(CREDENTIALS.crm_manager, call("crm_summary_report"));
    for (const rpc of [context, summary]) {
      expect(refused(rpc)).toBe(true);
      expect(toolText(rpc)).toMatch(/Super Admin/);
    }
    const after = await sideEffects();
    // No tool token was ever issued for the staff member's turn.
    expect(after.crm_agent_tokens).toBe(before.crm_agent_tokens);
    expect(after.approval_requests).toBe(before.approval_requests);
    await endTurns("crm_manager");
  });

  it("refuses when the person lost their membership after the turn began", async () => {
    const temp = await createUser({ platformRole: "agency_super_admin", name: "Short Lived" });
    await addMember(agency.id, temp.id, "owner");
    await startTurn("performance_analyst", temp.id);
    expect(refused(await contextRead("performance_analyst"))).toBe(false);
    await withSystem((db) => db.query("update organization_memberships set status = 'revoked' where org_id = $1 and user_id = $2", [agency.id, temp.id]));
    expect(refused(await contextRead("performance_analyst"))).toBe(true);
    expect(refused(await post(CREDENTIALS.performance_analyst, call("crm_summary_report")))).toBe(true);
    await endTurns("performance_analyst");
  });

  it("a captured request replayed after its turn has ended is refused", async () => {
    await startTurn("lead_hunter", admin.id);
    const captured = call("get_role_workspace_context");
    const first = await post(CREDENTIALS.lead_hunter, captured);
    expect(refused(first)).toBe(false);
    expect(toolText(first)).toContain("Auth Only Lead");
    await endTurns("lead_hunter");
    const replay = await post(CREDENTIALS.lead_hunter, captured);
    expect(refused(replay)).toBe(true);
    expect(toolText(replay)).not.toContain("Auth Only Lead");
  });

  it("reads one workspace only, for the role it was issued for", async () => {
    await startTurn("lead_hunter", admin.id);
    const rpc = await contextRead("lead_hunter");
    expect(refused(rpc)).toBe(false);
    expect(toolText(rpc)).toContain("Auth Only Lead");
    expect(toolText(rpc)).not.toContain("Client Secret Lead");
    await endTurns("lead_hunter");
  });
});

describe("tools: only the role's read tools exist, and a refused call does nothing", () => {
  it("does not offer a tool outside the role, and a call to one is refused without side effects", async () => {
    await startTurn("performance_analyst", admin.id);
    const before = await sideEffects();
    for (const name of ["find_contacts", "get_contact", "update_contact", "create_task", "request_appointment", "prepare_message", "request_send_approval", "check_availability"]) {
      const rpc = await post(CREDENTIALS.performance_analyst, call(name, { query: "x", contactId: "00000000-0000-4000-8000-000000000000" }));
      expect(refused(rpc), name).toBe(true);
    }
    expect(await sideEffects()).toEqual(before);
    await endTurns("performance_analyst");
  });

  it("does not offer a write tool while writes are off, even to the employees that hold write scopes", async () => {
    await startTurn("appointment_setter", admin.id);
    const before = await sideEffects();
    for (const name of ["update_contact", "apply_tag", "create_task", "request_appointment"]) {
      const rpc = await post(CREDENTIALS.appointment_setter, call(name, { contactId: "00000000-0000-4000-8000-000000000000", changes: { city: "x" }, reason: "none" }));
      expect(refused(rpc), name).toBe(true);
    }
    expect(await sideEffects()).toEqual(before);
    await endTurns("appointment_setter");
  });

  it("answers an authorized read for the role's own scope on synthetic records, and records it", async () => {
    await startTurn("crm_manager", admin.id);
    const rpc = await post(CREDENTIALS.crm_manager, call("crm_summary_report"));
    expect(refused(rpc)).toBe(false);
    expect(JSON.parse(toolText(rpc))).toMatchObject({ ok: true, status: "done", tool: "crm_summary_report" });
    const rows = await auditRows("crm.agent_tool.crm_summary_report");
    expect(rows.at(-1)).toMatchObject({ org_id: agency.id, result: "success", agent_instance_id: IDS.crm_manager });
    // The one-minute tool token that carried the call is gone again.
    const live = await withSystem((db) => db.query<{ n: number }>("select count(*)::int as n from crm_agent_tokens where agent_instance_id = $1 and revoked_at is null", [IDS.crm_manager]));
    expect(live.rows[0].n).toBe(0);
    await endTurns("crm_manager");
  });

  it("honours the employee's operating mode and the agency-wide pause for tool calls, and the Chat rule for the context snapshot", async () => {
    await startTurn("crm_manager", admin.id);
    await temporarily("update agent_instances set mode = 'paused' where id = $1", "update agent_instances set mode = 'approval_required' where id = $1", [IDS.crm_manager], async () => {
      const tool = await post(CREDENTIALS.crm_manager, call("crm_summary_report"));
      expect(refused(tool)).toBe(true);
      expect(toolText(tool)).toMatch(/paused/i);
      // Private Chat stays available to a paused employee (src/server/automation/gate.ts), and the snapshot is the Chat snapshot.
      expect(refused(await post(CREDENTIALS.crm_manager, call("get_role_workspace_context")))).toBe(false);
    });
    await withSystem((db) => db.query("insert into automation_pauses (org_id, scope, active, set_at) values ($1, 'agency', true, now()) on conflict (org_id, scope) do update set active = true", [agency.id]));
    try {
      const tool = await post(CREDENTIALS.crm_manager, call("crm_summary_report"));
      expect(refused(tool)).toBe(true);
      expect(toolText(tool)).toMatch(/paused/i);
    } finally {
      await withSystem((db) => db.query("update automation_pauses set active = false where org_id = $1 and scope = 'agency'", [agency.id]));
    }
    expect(refused(await post(CREDENTIALS.crm_manager, call("crm_summary_report")))).toBe(false);
    await endTurns("crm_manager");
  });
});

describe("the operator script's core issues credentials that work, and keeps them off the screen and out of the database", () => {
  it("reads the six internal employees from the database and writes one private file each that opens the endpoint for exactly that employee", async () => {
    const employees = await withSystem((db) => internalEmployeesForCredentials(db));
    expect(employees.map((employee) => employee.role)).toEqual([...AGENT_ROLE_KEYS]);
    for (const employee of employees) expect(employee).toMatchObject({ agentId: IDS[employee.role], orgId: agency.id });

    const directory = mkdtempSync(path.join(tmpdir(), "iaq-mcp-"));
    try {
      const summaries = writeCredentialFiles(MCP_TEST_SECRET, employees, { outDir: directory, days: 30 });
      expect(summaries).toHaveLength(6);
      expect(JSON.stringify(summaries)).not.toMatch(/iamcp1\./);
      expect(readdirSync(directory).sort()).toEqual(AGENT_ROLE_KEYS.map((role) => `${AGENCY_HERMES_PROFILE_IDS[role]}.env`).sort());
      for (const summary of summaries) {
        const line = readFileSync(summary.file, "utf8");
        expect(line).toMatch(/^IACQUIRE_BUSINESS_MCP_TOKEN=iamcp1\.[A-Za-z0-9_.-]+\n$/);
        if (process.platform !== "win32") expect(statSync(summary.file).mode & 0o077).toBe(0);
        const token = line.slice("IACQUIRE_BUSINESS_MCP_TOKEN=".length).trim();
        const rpc = await post(token);
        expect(rpc.status, summary.role).toBe(200);
        expect(new Date(summary.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(30 * 86_400_000);
        // It opens the endpoint for its own employee only: this credential's tools are that role's tools.
        expect((rpc.json?.result?.tools ?? []).map((tool) => tool.name).sort()).toEqual([...businessMcpToolNamesForRole(summary.role, false)].sort());
      }
      // A second run never replaces a file that is already there.
      expect(() => writeCredentialFiles(MCP_TEST_SECRET, employees.slice(0, 1), { outDir: directory })).toThrow(/EEXIST/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("issues nothing for an employee the database does not map to an internal profile", async () => {
    await temporarily("update agent_instances set hermes_profile = 'iacquire-not-mapped' where id = $1", `update agent_instances set hermes_profile = '${AGENCY_HERMES_PROFILE_IDS.crm_manager}' where id = $1`, [IDS.crm_manager], async () => {
      const employees = await withSystem((db) => internalEmployeesForCredentials(db));
      expect(employees.map((employee) => employee.role)).not.toContain("crm_manager");
      expect(employees).toHaveLength(5);
    });
  });
});

describe("the credential opens nothing else", () => {
  it("is not a tool token: the CRM tool API refuses it and it never reaches a tool", async () => {
    const credential = CREDENTIALS.crm_manager;
    expect(await withSystem((db) => verifyAgentToolToken(db, credential))).toBeNull();
    const reply = await callAgentTool({ token: credential, tool: "crm_summary_report", ipHash: "test", readArgs: async () => ({}) });
    expect(reply).toMatchObject({ ok: false, httpStatus: 401, code: "unauthorized" });
  });

  it("is not a Hermes credential: the gateway stand-in refuses it for the profile it was issued for", async () => {
    for (const role of AGENT_ROLE_KEYS) {
      const response = await fetch(`${mock.url}/p/${AGENCY_HERMES_PROFILE_IDS[role]}/v1/capabilities`, { headers: { Authorization: `Bearer ${CREDENTIALS[role]}` } });
      expect(response.status, role).toBe(401);
    }
  });

  it("is never written into the application's tables or logs", async () => {
    await startTurn("lead_hunter", admin.id);
    await post(CREDENTIALS.lead_hunter, call("get_role_workspace_context"));
    await endTurns("lead_hunter");
    const dump = await withSystem(async (db) => {
      const parts: string[] = [];
      for (const [table, columns] of [["audit_logs", "action, metadata::text, target_id"], ["tool_executions", "tool_name, label"], ["integration_credentials", "label, fingerprint"], ["notifications", "title, body"]] as const) {
        const { rows } = await db.query<Record<string, string>>(`select ${columns} from ${table}`);
        parts.push(JSON.stringify(rows));
      }
      return parts.join("\n");
    });
    for (const role of AGENT_ROLE_KEYS) {
      expect(dump).not.toContain(CREDENTIALS[role]);
      expect(dump).not.toContain(CREDENTIALS[role].split(".")[7]);
    }
    expect(dump).not.toContain(MCP_TEST_SECRET);
    expect(dump).not.toContain("iamcp1.");
  });

  it("is placed in the profile's own environment by the provisioning runbook, as a placeholder, with no credential or secret in it", async () => {
    const bundle = await getProvisioningBundle(IDS.lead_hunter);
    expect(bundle.envTemplate).toContain("IACQUIRE_BUSINESS_MCP_TOKEN=<");
    expect(bundle.envTemplate).toContain("API_SERVER_KEY=<");
    expect(bundle.configYaml).toContain('Authorization: "Bearer ${IACQUIRE_BUSINESS_MCP_TOKEN}"');
    for (const text of [bundle.envTemplate, bundle.configYaml, JSON.stringify(bundle.steps)]) {
      expect(text).not.toContain(MCP_TEST_SECRET);
      expect(text).not.toMatch(/iamcp1\./);
      expect(text).not.toContain(PROFILE_KEYS.lead_hunter);
    }
  });
});
