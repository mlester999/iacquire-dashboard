// C6: does the real, pinned Hermes 0.21.5 gateway (with this repository's catalog overlay) accept the business MCP server configuration, authenticate with the signed credential, discover the
// approved tools, report them in its complete tool inventory with the provenance the application checks, and fail closed when anything is wrong?
//
// This is EVIDENCE ONLY when a pinned runtime is supplied (IACQUIRE_C6_PYTHON and IACQUIRE_C6_HERMES_SOURCE; services/hermes-business-mcp-acceptance/prepare-runtime.mjs builds one). Without it the
// whole file is skipped, and nothing in it is a substitute: the mocked gateway tests elsewhere do not count as compatibility proof. With IACQUIRE_REQUIRE_C6_RUNTIME=1 (CI) a missing runtime FAILS.
//
// What runs: the real Hermes gateway and MCP client in a disposable home with six disposable profiles; the real business MCP handler (the same code the route runs) served on loopback over a
// seeded in-memory database of synthetic workspaces; the application's own tool-inventory verifier (runHealthCheck) pointed at the real gateway. What does not: no model is called, no provider
// key exists in the runtime's environment, no live gateway, profile, credential, customer record or network address outside loopback is touched. The "authenticated read" is Hermes' MCP client and
// tool registry called in-process, which is the code path an agent's tool call takes, not a model-driven run.
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AGENCY_HERMES_PROFILE_IDS, AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { handleHermesBusinessMcp } from "@/server/workforce/hermes-business-mcp";
import { issueBusinessMcpCredentialWithSecret, issueConfiguredBusinessMcpCredential } from "@/server/workforce/hermes-business-mcp-credential";
import { businessMcpRuntimeNamesForRole, HERMES_BUSINESS_MCP_SERVER, HERMES_BUSINESS_MCP_TOOLSET } from "@/server/workforce/hermes-business-mcp-policy";
import { connectHermesProfile, createConfigVersion, runHealthCheck } from "@/server/workforce/service";
import { defaultSettings } from "@/server/workforce/compiler";
import { addMember, agentId, createOrg, createUser } from "./support/fixtures";
import { MCP_TEST_SECRET } from "./support/business-mcp";
import {
  createHome, disposableRoot, freePort, pinnedRuntimeFromEnv, profileConfigYaml, runProbe, serveHandler, startGateway,
  type GatewayHandle, type PinnedRuntime,
} from "./support/c6-runtime";

const runtime = pinnedRuntimeFromEnv();
const required = process.env.IACQUIRE_REQUIRE_C6_RUNTIME === "1";
const suite = runtime ? describe : describe.skip;
const PROBE = path.resolve(import.meta.dirname, "../services/hermes-business-mcp-acceptance/mcp_client_probe.py");
const SAFE_TOOLSETS = ["memory", "session_search", "todo", "vision", "web"];
const ROLE_FOR_SPOT_CHECKS: AgentRoleKey = "lead_hunter";
const evidence: Record<string, unknown> = {};

if (!runtime) {
  describe("pinned Hermes runtime (C6)", () => {
    it(required ? "has a pinned runtime to test against" : "is skipped: no pinned runtime was supplied", () => {
      if (required) throw new Error("IACQUIRE_REQUIRE_C6_RUNTIME=1 but IACQUIRE_C6_PYTHON / IACQUIRE_C6_HERMES_SOURCE are not set, so the compatibility proof did not run.");
    });
  });
}

type Catalog = {
  complete: boolean; contract: string; explicit_config_present: boolean; enabled_toolsets: string[];
  data: Array<{ name: string; provenance?: { source?: string; toolset?: string | null; source_server?: string | null; added_below_explicit_config?: boolean }; available?: boolean }>;
};

suite("business MCP against the real pinned Hermes 0.21.5 gateway", () => {
  const rt = runtime as PinnedRuntime;
  const scratch = disposableRoot();
  const home = path.join(scratch.root, "hermes-home");
  const rootKey = randomBytes(32).toString("hex");
  const PROFILE_KEYS = Object.fromEntries(AGENT_ROLE_KEYS.map((role) => [role, randomBytes(32).toString("hex")])) as Record<AgentRoleKey, string>;
  const CREDENTIALS = {} as Record<AgentRoleKey, string>;
  const IDS = {} as Record<AgentRoleKey, string>;
  let agency: Awaited<ReturnType<typeof createOrg>>;
  let client: Awaited<ReturnType<typeof createOrg>>;
  let clientAgentId = "";
  let admin: { id: string; email: string };
  let mcp: Awaited<ReturnType<typeof serveHandler>>;
  let gateway: GatewayHandle;
  let gatewayPort = 0;

  const profileDir = (role: AgentRoleKey, base = home) => path.join(base, "profiles", AGENCY_HERMES_PROFILE_IDS[role]);
  const expectedNames = (role: AgentRoleKey) => businessMcpRuntimeNamesForRole(role, false);
  const mcpUrl = () => `${mcp.url}/api/internal/hermes-business/mcp`;

  async function inventory(role: AgentRoleKey, base = gateway.base, key = PROFILE_KEYS[role]) {
    const response = await fetch(`${base}/p/${AGENCY_HERMES_PROFILE_IDS[role]}/v1/tools?platform=api_server`, {
      headers: { Authorization: `Bearer ${key}`, "X-Hermes-Inventory-Challenge": randomBytes(16).toString("hex") },
    });
    return { status: response.status, json: (await response.json().catch(() => null)) as Catalog | null };
  }

  /** A running Chat turn for this employee, as the Super Admin, bound to its active configuration (earlier turns are ended first). */
  async function startTurn(role: AgentRoleKey) {
    await withSystem(async (db) => {
      await db.query("update agent_runs set status = 'completed' where agent_instance_id = $1 and status = 'running'", [IDS[role]]);
      const { rows } = await db.query<{ active_config_version_id: string }>("select active_config_version_id from agent_instances where id = $1", [IDS[role]]);
      await db.query(
        `insert into agent_runs (org_id, agent_instance_id, user_id, purpose, idempotency_key, status, started_at, hermes_run_id, config_version_id)
         values ($1, $2, $3, 'chat', $4, 'running', now(), $5, $6)`,
        [agency.id, IDS[role], admin.id, `c6-${role}-${Math.random().toString(36).slice(2)}`, `run-${Math.random().toString(36).slice(2)}`, rows[0].active_config_version_id],
      );
    });
  }
  const endTurns = (role: AgentRoleKey) => withSystem((db) => db.query("update agent_runs set status = 'completed' where agent_instance_id = $1 and status = 'running'", [IDS[role]]));

  async function counts() {
    return withSystem(async (db) => {
      const out: Record<string, number> = {};
      for (const table of ["crm_agent_tokens", "approval_requests", "agent_runs", "leads", "contacts", "tasks", "crm_opportunities", "conversations"]) {
        out[table] = Number((await db.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0].n);
      }
      return out;
    });
  }

  /** A single-profile Hermes home for the probe: the lead hunter's profile files with a different credential, or none. */
  function probeHome(name: string, credential: string | null, url: string | null = mcpUrl()): string {
    const dir = path.join(scratch.root, `probe-${name}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "config.yaml"), profileConfigYaml({ mcpUrl: url, toolsets: [...SAFE_TOOLSETS, HERMES_BUSINESS_MCP_TOOLSET] }), "utf8");
    writeFileSync(path.join(dir, ".env"), `API_SERVER_ENABLED=true\nAPI_SERVER_KEY=${PROFILE_KEYS[ROLE_FOR_SPOT_CHECKS]}\n${credential ? `IACQUIRE_BUSINESS_MCP_TOKEN=${credential}\n` : ""}`, { encoding: "utf8", mode: 0o600 });
    return dir;
  }

  /** Points the lead hunter at another gateway, as an administrator would when connecting a profile, and re-runs the application's health check against it. */
  async function healthAgainst(base: string) {
    await connectHermesProfile({ agentId: IDS.lead_hunter, baseUrl: base, profile: AGENCY_HERMES_PROFILE_IDS.lead_hunter, apiKey: PROFILE_KEYS.lead_hunter, agencyUserId: admin.id });
    return runHealthCheck(IDS.lead_hunter, { userId: admin.id, kind: "agency" });
  }

  /** A second business MCP server on loopback, optionally altering what `tools/list` returns, for fault injection. Authentication and records are still the real handler's. */
  function faultyServer(mutate: ((tools: Array<Record<string, unknown>>) => Array<Record<string, unknown>>) | null, status?: number) {
    return serveHandler(async (request) => {
      if (status) return new Response("unavailable", { status });
      const body = await request.clone().text();
      const response = await handleHermesBusinessMcp(request);
      if (!mutate || response.status !== 200 || !/"method"\s*:\s*"tools\/list"/.test(body)) return response;
      const json = (await response.json()) as { result?: { tools?: Array<Record<string, unknown>> } };
      if (json.result?.tools) json.result.tools = mutate(json.result.tools);
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      return new Response(JSON.stringify(json), { status: 200, headers });
    });
  }

  async function faultGateway(label: string, server: Awaited<ReturnType<typeof serveHandler>>) {
    const faultHome = path.join(scratch.root, `fault-${label}`);
    const port = await freePort();
    await createHome(rt, faultHome, port, [{
      name: AGENCY_HERMES_PROFILE_IDS.lead_hunter, apiKey: PROFILE_KEYS.lead_hunter, credential: CREDENTIALS.lead_hunter,
      mcpUrl: `${server.url}/api/internal/hermes-business/mcp`, toolsets: [...SAFE_TOOLSETS, HERMES_BUSINESS_MCP_TOOLSET],
    }]);
    return { gateway: await startGateway(rt, faultHome, port, rootKey), port };
  }

  beforeAll(async () => {
    gatewayPort = await freePort();
    mcp = await serveHandler(handleHermesBusinessMcp);
    vi.stubEnv("APP_URL", mcp.url);
    vi.stubEnv("HERMES_BUSINESS_MCP_ENABLED", "true");
    vi.stubEnv("HERMES_BUSINESS_MCP_WRITES_ENABLED", "false");
    vi.stubEnv("HERMES_BUSINESS_MCP_SECRET", MCP_TEST_SECRET);
    resetEnvCache();

    admin = await createUser({ platformRole: "agency_super_admin", name: "C6 Admin" });
    agency = await createOrg({ name: "C6 Agency", kind: "agency" });
    client = await createOrg({ name: "C6 Client" });
    clientAgentId = await agentId(client.id, "lead_hunter");
    await addMember(agency.id, admin.id, "owner");
    await withSystem(async (db) => {
      await db.query("insert into leads (org_id, business_name, review_status) values ($1, 'C6 Agency Lead', 'pending')", [agency.id]);
      await db.query("insert into leads (org_id, business_name, review_status) values ($1, 'C6 Client Secret Lead', 'pending')", [client.id]);
    });
    for (const role of AGENT_ROLE_KEYS) {
      IDS[role] = await agentId(agency.id, role);
      await withSystem((db) => createConfigVersion(db, { orgId: agency.id, agentId: IDS[role], settings: defaultSettings(role), source: "onboarding", userId: admin.id, apply: true }));
      await connectHermesProfile({ agentId: IDS[role], baseUrl: `http://127.0.0.1:${gatewayPort}`, profile: AGENCY_HERMES_PROFILE_IDS[role], apiKey: PROFILE_KEYS[role], agencyUserId: admin.id });
      CREDENTIALS[role] = issueConfiguredBusinessMcpCredential({ role, agentId: IDS[role], orgId: agency.id }).token;
    }
    await createHome(rt, home, gatewayPort, AGENT_ROLE_KEYS.map((role) => ({
      name: AGENCY_HERMES_PROFILE_IDS[role], apiKey: PROFILE_KEYS[role], credential: CREDENTIALS[role], mcpUrl: mcpUrl(), toolsets: [...SAFE_TOOLSETS, HERMES_BUSINESS_MCP_TOOLSET],
    })));
    gateway = await startGateway(rt, home, gatewayPort, rootKey);
  }, 600_000);

  afterAll(async () => {
    await gateway?.stop();
    await mcp?.close();
    if (process.env.IACQUIRE_C6_EVIDENCE) {
      mkdirSync(path.dirname(process.env.IACQUIRE_C6_EVIDENCE), { recursive: true });
      writeFileSync(process.env.IACQUIRE_C6_EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    }
    vi.unstubAllEnvs();
    resetEnvCache();
    scratch.dispose();
  }, 120_000);

  it("runs the pinned version with the catalog overlay", async () => {
    const response = await fetch(`${gateway.base}/health`);
    const health = (await response.json()) as { version: string; platform: string };
    const report = await runProbe(rt, PROBE, profileDir("lead_hunter"));
    evidence.runtime = { hermes: health.version, mcpSdk: report.hermes.mcp_sdk, python: report.hermes.python, platform: process.platform };
    expect(health.version).toBe("0.21.5");
    expect(report.hermes.version).toBe("0.21.5");
  });

  describe("1-2. Hermes' own MCP client accepts the configuration and discovers the approved tools", () => {
    for (const role of AGENT_ROLE_KEYS) {
      it(`${role}: authenticates with its own credential and discovers exactly its approved tools, in the mcp-iacquire_business toolset`, async () => {
        const report = await runProbe(rt, PROBE, profileDir(role));
        evidence[`discovery_${role}`] = { tools: report.discovered.map((tool) => tool.name).sort(), toolsets: [...new Set(report.discovered.map((tool) => tool.toolset))] };
        expect(report.ok, JSON.stringify(report.warnings)).toBe(true);
        expect(report.discovered.map((tool) => tool.name).sort()).toEqual([...expectedNames(role)].sort());
        expect(new Set(report.discovered.map((tool) => tool.toolset))).toEqual(new Set([HERMES_BUSINESS_MCP_TOOLSET]));
      });
    }
  });

  describe("3. the gateway's complete tool inventory reports correct source, server, toolset and names", () => {
    for (const role of AGENT_ROLE_KEYS) {
      it(`${role}: source mcp, server ${HERMES_BUSINESS_MCP_SERVER}, toolset ${HERMES_BUSINESS_MCP_TOOLSET}, exactly the approved names, nothing unreviewed`, async () => {
        const { status, json } = await inventory(role);
        expect(status).toBe(200);
        expect(json).toMatchObject({ contract: "hermes.api_server.tool_catalog.v1", complete: true, explicit_config_present: true });
        const rows = json!.data;
        const business = rows.filter((row) => row.provenance?.source === "mcp");
        evidence[`inventory_${role}`] = { complete: json!.complete, enabled_toolsets: json!.enabled_toolsets, tools: rows.map((row) => row.name).sort() };
        expect(business.map((row) => row.name).sort()).toEqual([...expectedNames(role)].sort());
        for (const row of business) {
          expect(row.provenance).toMatchObject({ source: "mcp", toolset: HERMES_BUSINESS_MCP_TOOLSET, source_server: HERMES_BUSINESS_MCP_SERVER });
          expect(row.available).not.toBe(false);
        }
        // The real gateway also lists the configured MCP server under its own name; it is an alias for the same server (see assertCatalogPolicy), never a second toolset with tools of its own.
        expect([...json!.enabled_toolsets].sort()).toEqual([...SAFE_TOOLSETS, HERMES_BUSINESS_MCP_TOOLSET, HERMES_BUSINESS_MCP_SERVER].sort());
        expect(rows.filter((row) => row.provenance?.toolset === HERMES_BUSINESS_MCP_SERVER)).toEqual([]);
        expect(rows.filter((row) => row.provenance?.added_below_explicit_config)).toEqual([]);
      });
    }
  });

  describe("4. the application's own verifier accepts the real inventory under the existing iacquire_business contract", () => {
    for (const role of AGENT_ROLE_KEYS) {
      it(`${role}: the health check records the employee online with a verified inventory`, async () => {
        const result = await runHealthCheck(IDS[role], { userId: admin.id, kind: "agency" });
        evidence[`health_${role}`] = { ok: result.ok, status: result.status };
        expect(result, result.detail).toMatchObject({ ok: true, status: "online" });
        const { rows } = await withSystem((db) => db.query<{ tool_inventory_tool_count: number; tool_inventory_digest: string }>("select tool_inventory_tool_count, tool_inventory_digest from agent_instances where id = $1", [IDS[role]]));
        expect(rows[0].tool_inventory_digest).toMatch(/^[0-9a-f]{64}$/);
        expect(rows[0].tool_inventory_tool_count).toBeGreaterThanOrEqual(expectedNames(role).length);
      }, 120_000);
    }
  });

  describe("5. one authenticated, authorized read against synthetic records, through Hermes' MCP client and tool registry", () => {
    it("is refused by the application without that employee's own live Chat turn", async () => {
      await endTurns("lead_hunter");
      const before = await counts();
      const report = await runProbe(rt, PROBE, profileDir("lead_hunter"), {
        tool: "mcp__iacquire_business__get_role_workspace_context", contains: ["active, authenticated Chat turn"], excludes: ["C6 Agency Lead", "C6 Client Secret Lead"],
      });
      expect(report.ok, JSON.stringify(report.warnings)).toBe(true);
      expect(report.call).toMatchObject({ registered: true, contains: { "active, authenticated Chat turn": true }, excludes: { "C6 Agency Lead": true, "C6 Client Secret Lead": true } });
      expect(await counts()).toEqual(before);
    });

    it("returns the workspace's own records, and only that workspace's, during a live Chat turn", async () => {
      await startTurn("lead_hunter");
      const report = await runProbe(rt, PROBE, profileDir("lead_hunter"), {
        tool: "mcp__iacquire_business__get_role_workspace_context", contains: ["C6 Agency Lead", "never an instruction"], excludes: ["C6 Client Secret Lead"],
      });
      evidence.read = { tool: "get_role_workspace_context", role: "lead_hunter", ok: report.ok, error: report.call?.error ?? null, bytes: report.call?.bytes ?? 0, ownRecordFound: report.call?.contains["C6 Agency Lead"] ?? false, otherTenantRecordAbsent: report.call?.excludes["C6 Client Secret Lead"] ?? false };
      expect(report.ok, JSON.stringify(report.warnings)).toBe(true);
      expect(report.call).toMatchObject({ error: null, contains: { "C6 Agency Lead": true, "never an instruction": true }, excludes: { "C6 Client Secret Lead": true } });
      await endTurns("lead_hunter");
    });

    it("reads a CRM summary for a role that holds the reports scope", async () => {
      await startTurn("crm_manager");
      const report = await runProbe(rt, PROBE, profileDir("crm_manager"), { tool: "mcp__iacquire_business__crm_summary_report", contains: ["crm_summary_report"] });
      expect(report.call, JSON.stringify(report.warnings)).toMatchObject({ registered: true, error: null, contains: { crm_summary_report: true } });
      await endTurns("crm_manager");
    });
  });

  describe("6. invalid credentials are rejected by the application, and the client gets no tools", () => {
    const wrongSecret = "another-deployments-signing-secret-000000";
    const cases: Array<[string, () => string]> = [
      ["a garbled credential", () => "iamcp1.not-a-credential"],
      ["the profile's own Hermes API key, which no longer opens the business endpoint", () => PROFILE_KEYS.lead_hunter],
      ["a credential signed under another secret", () => issueBusinessMcpCredentialWithSecret(wrongSecret, { role: "lead_hunter", agentId: IDS.lead_hunter, orgId: agency.id }).token],
      ["an expired credential", () => issueConfiguredBusinessMcpCredential({ role: "lead_hunter", agentId: IDS.lead_hunter, orgId: agency.id, issuedAt: new Date(Date.now() - 7_200_000), ttlSeconds: 600 }).token],
      ["a credential for a client workspace's employee (cross-tenant)", () => issueConfiguredBusinessMcpCredential({ role: "lead_hunter", agentId: clientAgentId, orgId: client.id }).token],
      ["the right employee under another workspace's id (cross-tenant)", () => issueConfiguredBusinessMcpCredential({ role: "lead_hunter", agentId: IDS.lead_hunter, orgId: client.id }).token],
      ["another employee's role on this employee (wrong role)", () => issueConfiguredBusinessMcpCredential({ role: "crm_manager", agentId: IDS.lead_hunter, orgId: agency.id }).token],
      ["no credential at all", () => ""],
    ];
    for (const [label, make] of cases) {
      it(`${label}: no tools are registered and the endpoint answered 401 with no side effect`, async () => {
        const before = await counts();
        const requestsBefore = mcp.requests.length;
        const report = await runProbe(rt, PROBE, probeHome(label.replace(/[^a-z]+/gi, "-").slice(0, 24), make() || null));
        const seen = mcp.requests.slice(requestsBefore);
        evidence[`invalid_${label.slice(0, 40)}`] = { tools: report.discovered.length, endpointStatuses: [...new Set(seen.map((request) => request.status))] };
        expect(report.discovered).toEqual([]);
        expect(seen.some((request) => request.status === 200)).toBe(false);
        expect(seen.some((request) => request.status === 401 || request.status === 429)).toBe(true);
        expect(await counts()).toEqual(before);
      }, 240_000);
    }
  });

  describe("7. tools outside the role are unavailable and refused", () => {
    it("registers no tool the role does not hold, so a call to one is an unknown tool, not a request", async () => {
      const before = await counts();
      for (const tool of ["crm_summary_report", "update_contact", "create_task", "request_appointment", "prepare_message", "request_send_approval"]) {
        const report = await runProbe(rt, PROBE, profileDir("lead_hunter"), { tool: `mcp__iacquire_business__${tool}`, arguments: {} });
        expect(report.call, tool).toMatchObject({ registered: false });
        expect(report.call?.error, tool).toMatch(/Unknown tool/);
      }
      expect(await counts()).toEqual(before);
    }, 300_000);
  });

  describe("8. no unexpected administrative or system tools", () => {
    it("lists, for every employee, only the reviewed built-in tools plus its own business tools", async () => {
      const forbidden = /terminal|shell|exec|file|browser|code|cron|delegate|kanban|computer|image_gen|skill|connect|tool_search|patch|process|write|delete/i;
      for (const role of AGENT_ROLE_KEYS) {
        const { json } = await inventory(role);
        const names = json!.data.map((row) => row.name);
        const builtIn = names.filter((name) => !name.startsWith("mcp__"));
        evidence[`builtin_${role}`] = builtIn.sort();
        expect(builtIn.filter((name) => forbidden.test(name)), role).toEqual([]);
        expect(json!.data.every((row) => [...SAFE_TOOLSETS, HERMES_BUSINESS_MCP_TOOLSET].includes(row.provenance?.toolset ?? "")), role).toBe(true);
        expect(names.filter((name) => name.startsWith("mcp__") && !name.startsWith("mcp__iacquire_business__")), role).toEqual([]);
        expect(names.filter((name) => name.startsWith("mcp__") && forbidden.test(name.replace("mcp__iacquire_business__", ""))), role).toEqual([]);
      }
    });
  });

  describe("9. a failed, partial, extended or incompatible inventory fails closed in the application", () => {
    // Hermes allows one gateway per host (a host-wide lock), so the main gateway is stopped before each faulty one starts. Nothing after this point needs it.
    beforeAll(async () => { await gateway.stop(); });

    it("failed discovery: the MCP service is down, and the application refuses to mark the employee online", async () => {
      const down = await faultyServer(null, 503);
      const { gateway: faulty, port } = await faultGateway("down", down);
      try {
        const result = await healthAgainst(`http://127.0.0.1:${port}`);
        evidence.fault_unavailable = { ok: result.ok, status: result.status, detail: result.detail.slice(0, 220) };
        expect(result.ok).toBe(false);
        expect(result.status).not.toBe("online");
      } finally { await faulty.stop(); await down.close(); }
    }, 300_000);

    it("partial inventory: a tool is missing from tools/list, and the application refuses", async () => {
      const partial = await faultyServer((tools) => tools.filter((tool) => tool.name !== "find_contacts"));
      const { gateway: faulty, port } = await faultGateway("partial", partial);
      try {
        const result = await healthAgainst(`http://127.0.0.1:${port}`);
        evidence.fault_partial = { ok: result.ok, status: result.status, detail: result.detail.slice(0, 220) };
        expect(result.ok).toBe(false);
        expect(result.detail).toMatch(/find_contacts|missing|incomplete/i);
      } finally { await faulty.stop(); await partial.close(); }
    }, 300_000);

    it("an extra tool: the server offers a tool the role does not hold, and the application refuses", async () => {
      const extra = await faultyServer((tools) => [...tools, { name: "shell_exec", description: "not reviewed", inputSchema: { type: "object", properties: { command: { type: "string" } } } }]);
      const { gateway: faulty, port } = await faultGateway("extra", extra);
      try {
        const result = await healthAgainst(`http://127.0.0.1:${port}`);
        evidence.fault_extra_tool = { ok: result.ok, status: result.status, detail: result.detail.slice(0, 220) };
        expect(result.ok).toBe(false);
        expect(result.detail).toMatch(/shell_exec|unapproved|outside|unsafe/i);
      } finally { await faulty.stop(); await extra.close(); }
    }, 300_000);

    it("an incompatible schema: a tool's input schema is not a JSON Schema object, and the application does not mark the employee online with it", async () => {
      const bad = await faultyServer((tools) => tools.map((tool) => (tool.name === "get_contact" ? { ...tool, inputSchema: { type: "not-a-real-type", properties: 7 } } : tool)));
      const { gateway: faulty, port } = await faultGateway("schema", bad);
      try {
        const result = await healthAgainst(`http://127.0.0.1:${port}`);
        evidence.fault_incompatible_schema = { ok: result.ok, status: result.status, detail: result.detail.slice(0, 220) };
        // Whether Hermes drops the tool or repairs its schema, the outcome must be one of two safe ones: refused, or accepted only with the tool intact under the reviewed name.
        if (result.ok) {
          const { rows } = await withSystem((db) => db.query<{ tool_inventory_snapshot: { tools: Array<{ name: string }> } }>("select tool_inventory_snapshot from agent_instances where id = $1", [IDS.lead_hunter]));
          expect(rows[0].tool_inventory_snapshot.tools.map((tool) => tool.name)).toContain("mcp__iacquire_business__get_contact");
        } else {
          expect(result.status).not.toBe("online");
        }
      } finally { await faulty.stop(); await bad.close(); }
    }, 300_000);
  });

  describe("control: the gateway without the catalog overlay", () => {
    // Read at collection time, which also happens when the suite is skipped, so it must tolerate there being no runtime.
    const baseline = runtime?.baselineSource ?? null;
    (baseline ? it : it.skip)("has no complete-inventory contract, and the application refuses to mark the employee online", async () => {
      const server = await faultyServer(null);
      const faultHome = path.join(scratch.root, "fault-baseline");
      const port = await freePort();
      await createHome(rt, faultHome, port, [{
        name: AGENCY_HERMES_PROFILE_IDS.lead_hunter, apiKey: PROFILE_KEYS.lead_hunter, credential: CREDENTIALS.lead_hunter, mcpUrl: `${server.url}/api/internal/hermes-business/mcp`, toolsets: [...SAFE_TOOLSETS, HERMES_BUSINESS_MCP_TOOLSET],
      }]);
      const unpatched = await startGateway(rt, faultHome, port, rootKey, baseline!);
      try {
        const direct = await inventory("lead_hunter", unpatched.base);
        const result = await healthAgainst(unpatched.base);
        evidence.control_unpatched = { inventoryStatus: direct.status, ok: result.ok, status: result.status };
        expect(direct.status).toBe(404);
        expect(result.ok).toBe(false);
        expect(result.status).not.toBe("online");
      } finally { await unpatched.stop(); await server.close(); }
    }, 300_000);
  });

  it("leaves no credential, key or secret in the evidence it records", () => {
    const text = JSON.stringify(evidence);
    expect(text).not.toMatch(/iamcp1\./);
    expect(text).not.toContain(MCP_TEST_SECRET);
    for (const key of [rootKey, ...Object.values(PROFILE_KEYS), ...Object.values(CREDENTIALS)]) expect(text).not.toContain(key);
  });
});
