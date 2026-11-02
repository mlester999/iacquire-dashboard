// Two client tenants on ONE real, pinned Hermes 0.21.5 gateway (with this repository's catalog overlay): do their profiles keep separate identities, keys, credentials, tools and records, does
// each employee see exactly its role's reviewed business tools and nothing else, and what does a running gateway do when a profile's tools or key change?
//
// This is EVIDENCE ONLY when a pinned runtime is supplied (IACQUIRE_C6_PYTHON and IACQUIRE_C6_HERMES_SOURCE; services/hermes-business-mcp-acceptance/prepare-runtime.mjs builds one), like the C6
// proof it extends: without one the whole file is skipped, and with IACQUIRE_REQUIRE_C6_RUNTIME=1 (CI) a missing runtime FAILS.
//
// What runs: the real Hermes gateway in a disposable home with one profile per entitled employee of two synthetic clients (six for the first, two for the second, which did not buy the
// rest), each profile configured exactly as the portal configures it (buildConfigYaml) with a credential of its own; the real CLIENT business MCP handler (the same code the route runs)
// served on loopback over a synthetic database of two workspaces whose records carry different tags; the application's own health check; and Hermes' own MCP client and tool registry
// called in-process, which is the code path an agent's tool call takes (not a model-driven run). What does not: no model is called, no provider key exists in the runtime's environment, and
// nothing outside loopback is touched.
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { handleHermesClientBusinessMcp } from "@/server/workforce/hermes-client-business-mcp";
import { revokeClientBusinessCredentialsForAgent } from "@/server/workforce/hermes-client-business-credential";
import { CLIENT_NEVER_OFFERED_TOOLS, clientBusinessMcpRuntimeNamesForRole } from "@/server/workforce/hermes-client-business-mcp-policy";
import { HERMES_BUSINESS_MCP_SERVER, HERMES_BUSINESS_MCP_TOOLSET } from "@/server/workforce/hermes-business-mcp-policy";
import { buildConfigYaml } from "@/server/workforce/provisioning";
import { DEFAULT_BLOCKED_TOOLSETS } from "@/server/workforce/tool-policies";
import { suggestedProfileName } from "@/server/workforce/service";
import { createHome, disposableRoot, freePort, pinnedRuntimeFromEnv, runProbe, serveHandler, startGateway, type GatewayHandle, type PinnedRuntime } from "./support/c6-runtime";
import { provisionedClient, recordBusinessInventory, setClientTier, startClientTurn, type ClientTenant } from "./support/client-business-mcp";
import { makeRuntimeReady } from "./support/runtime-ready";

const runtime = pinnedRuntimeFromEnv();
const required = process.env.IACQUIRE_REQUIRE_C6_RUNTIME === "1";
const suite = runtime ? describe : describe.skip;
const PROBE = path.resolve(import.meta.dirname, "../services/hermes-business-mcp-acceptance/mcp_client_probe.py");
const TOOL = (name: string) => `mcp__${HERMES_BUSINESS_MCP_SERVER}__${name}`;
const evidence: Record<string, unknown> = {};

if (!runtime) {
  describe("pinned Hermes runtime, client tier", () => {
    it(required ? "has a pinned runtime to test against" : "is skipped: no pinned runtime was supplied", () => {
      if (required) throw new Error("IACQUIRE_REQUIRE_C6_RUNTIME=1 but IACQUIRE_C6_PYTHON / IACQUIRE_C6_HERMES_SOURCE are not set, so the client-tier proof did not run.");
    });
  });
}

/** Removes the disposable folder; on Windows a file the stopped gateway held can still be locked for a moment, and the folder holds only synthetic files in the temp directory. */
function disposeQuietly(folder: { dispose(): void }) {
  try {
    folder.dispose();
  } catch {
    /* left in the temporary directory */
  }
}

type Catalog = {
  complete: boolean; contract: string; enabled_toolsets: string[];
  data: Array<{ name: string; provenance?: { source?: string; toolset?: string | null; source_server?: string | null }; available?: boolean }>;
};

interface Member { tenant: ClientTenant; role: AgentRoleKey; profile: string; apiKey: string }

suite("client business tools against the real pinned Hermes 0.21.5 gateway: two tenants on one gateway", () => {
  const rt = runtime as PinnedRuntime;
  const scratch = disposableRoot("iaq-client-c6-");
  const home = path.join(scratch.root, "hermes-home");
  const rootKey = randomBytes(32).toString("hex");
  let alpha: ClientTenant;
  let beta: ClientTenant;
  const members: Member[] = [];
  let mcp: Awaited<ReturnType<typeof serveHandler>>;
  let gateway: GatewayHandle;
  let port = 0;

  const member = (tenant: ClientTenant, role: AgentRoleKey) => members.find((m) => m.tenant === tenant && m.role === role) as Member;
  const profileDir = (m: Member, base = home) => path.join(base, "profiles", m.profile);
  /**
   * A live Chat turn for the employee, with its runtime readiness and recorded tool inventory refreshed first: a turn is accepted only against a recent health check and a still-valid
   * inventory proof, and the fixture's expire while a long proof runs.
   */
  async function liveTurn(tenant: ClientTenant, role: AgentRoleKey) {
    await makeRuntimeReady(tenant.agents[role], tenant.org.id, tenant.owner.id);
    await recordBusinessInventory(tenant.agents[role], role);
    await startClientTurn(tenant, role, tenant.owner.id);
  }
  const configFor = (role: AgentRoleKey) => buildConfigYaml(DEFAULT_BLOCKED_TOOLSETS, role, { businessMcp: true });

  async function inventory(profile: string, key: string, base = gateway.base) {
    const response = await fetch(`${base}/p/${profile}/v1/tools?platform=api_server`, { headers: { Authorization: `Bearer ${key}`, "X-Hermes-Inventory-Challenge": randomBytes(16).toString("hex") } });
    return { status: response.status, json: (await response.json().catch(() => null)) as Catalog | null };
  }

  /** A single-profile Hermes home for the probe: this employee's real profile configuration with the credential given (its own, another tenant's, a revoked one, or none). */
  function probeHome(label: string, m: Member, credential: string | null): string {
    const dir = path.join(scratch.root, `probe-${label}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "config.yaml"), configFor(m.role), "utf8");
    writeFileSync(path.join(dir, ".env"), `API_SERVER_ENABLED=true\nAPI_SERVER_KEY=${m.apiKey}\n${credential ? `IACQUIRE_BUSINESS_MCP_TOKEN=${credential}\n` : ""}`, { encoding: "utf8", mode: 0o600 });
    return dir;
  }

  beforeAll(async () => {
    port = await freePort();
    mcp = await serveHandler(handleHermesClientBusinessMcp);
    vi.stubEnv("APP_URL", mcp.url);
    // Production enforces the role tool policy (a profile carries only its role's toolsets); the test environment only reports it, so it is switched on here.
    vi.stubEnv("WORKFORCE_ROLE_TOOL_ENFORCEMENT", "enforce");
    setClientTier(true);
    alpha = await provisionedClient({ name: "Pinned Alpha Roofing", timezone: "America/Chicago", tag: "Alphaville", phone: "+13125550101" });
    // The second client bought two employees: the other four are switched off and have no profile on the gateway.
    beta = await provisionedClient({ name: "Pinned Beta Dental", timezone: "Europe/London", tag: "Betatown", phone: "+442071230101", entitled: ["lead_hunter", "crm_manager"] });
    for (const [tenant, roles] of [[alpha, AGENT_ROLE_KEYS], [beta, ["lead_hunter", "crm_manager"] as AgentRoleKey[]]] as const) {
      for (const role of roles) members.push({ tenant, role, profile: suggestedProfileName(tenant.org.slug, role), apiKey: randomBytes(32).toString("hex") });
    }
    await createHome(rt, home, port, members.map((m) => ({ name: m.profile, apiKey: m.apiKey, credential: m.tenant.credentials[m.role], mcpUrl: null, toolsets: [] })));
    // Each profile is configured exactly as the portal configures it for its role, with the business tool entry that points at the client route.
    for (const m of members) writeFileSync(path.join(profileDir(m), "config.yaml"), configFor(m.role), "utf8");
    gateway = await startGateway(rt, home, port, rootKey);
  }, 900_000);

  afterAll(async () => {
    await gateway?.stop();
    await mcp?.close();
    if (process.env.IACQUIRE_C6_EVIDENCE) {
      const target = process.env.IACQUIRE_C6_EVIDENCE.replace(/\.json$/, "-client.json");
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    }
    vi.unstubAllEnvs();
    resetEnvCache();
    disposeQuietly(scratch);
  }, 120_000);

  it("runs the pinned version, with eight profiles for two clients: six for the first and only the two the second bought", async () => {
    const health = (await (await fetch(`${gateway.base}/health`)).json()) as { version: string };
    expect(health.version).toBe("0.21.5");
    expect(members).toHaveLength(8);
    const profiles = members.map((m) => m.profile);
    expect(new Set(profiles).size).toBe(8);
    expect(profiles.every((p) => p.startsWith("c-") && !p.startsWith("iacquire-"))).toBe(true);
    // Nothing exists on the gateway for an employee the second client did not buy, and its employees are locked in the portal.
    const locked = AGENT_ROLE_KEYS.filter((r) => r !== "lead_hunter" && r !== "crm_manager");
    for (const role of locked) {
      expect(profiles).not.toContain(suggestedProfileName(beta.org.slug, role));
      expect((await withSystem((db) => db.query("select 1 from agent_instances where id = $1 and not enabled", [beta.agents[role]]))).rows).toHaveLength(1);
    }
    evidence.profiles = { alpha: AGENT_ROLE_KEYS.length, beta: 2, distinct: new Set(profiles).size };
  });

  describe("every profile has its own identity, keys and credential", () => {
    it("has distinct API keys and distinct business tool credentials, none shared between roles or between clients", () => {
      expect(new Set(members.map((m) => m.apiKey)).size).toBe(members.length);
      expect(new Set(members.map((m) => m.tenant.credentials[m.role])).size).toBe(members.length);
      expect(new Set(members.map((m) => m.tenant.credentialIds[m.role])).size).toBe(members.length);
    });

    it("answers each profile only to its own API key: another profile's key, another client's key and no key are all refused", async () => {
      const a = member(alpha, "lead_hunter");
      const b = member(beta, "lead_hunter");
      const own = await inventory(a.profile, a.apiKey);
      expect(own.status).toBe(200);
      for (const [label, key] of [["another client's key", b.apiKey], ["a sibling's key", member(alpha, "crm_manager").apiKey], ["no key", ""], ["the wrong key", randomBytes(32).toString("hex")]] as const) {
        const response = await inventory(a.profile, key);
        expect([401, 403], `${label}: ${response.status}`).toContain(response.status);
      }
      evidence.keyIsolation = { own: own.status, crossClient: (await inventory(a.profile, b.apiKey)).status };
    });
  });

  describe("every profile carries exactly its role's reviewed tools", () => {
    for (const [client, roles] of [["alpha", AGENT_ROLE_KEYS], ["beta", ["lead_hunter", "crm_manager"] as AgentRoleKey[]]] as const) {
      for (const role of roles) {
        it(`${client} ${role}: source mcp, server ${HERMES_BUSINESS_MCP_SERVER}, toolset ${HERMES_BUSINESS_MCP_TOOLSET}, exactly the role's read tools, nothing it was not given`, async () => {
          const m = member(client === "alpha" ? alpha : beta, role);
          const { status, json } = await inventory(m.profile, m.apiKey);
          expect(status).toBe(200);
          expect(json).toMatchObject({ contract: "hermes.api_server.tool_catalog.v1", complete: true });
          const rows = json!.data;
          const business = rows.filter((row) => row.provenance?.source === "mcp");
          expect(business.map((row) => row.name).sort()).toEqual([...clientBusinessMcpRuntimeNamesForRole(role)].sort());
          for (const row of business) expect(row.provenance).toMatchObject({ source: "mcp", toolset: HERMES_BUSINESS_MCP_TOOLSET, source_server: HERMES_BUSINESS_MCP_SERVER });
          // Nothing that could reach a customer or book a calendar without a person, in any phase; and no write or proposal tool while the proposals phase is off.
          for (const never of CLIENT_NEVER_OFFERED_TOOLS) expect(rows.map((row) => row.name)).not.toContain(TOOL(never));
          // Role-specific tools: web research belongs to the Lead Hunter alone.
          const web = rows.filter((row) => row.provenance?.toolset === "web" || /^web_/.test(row.name));
          expect(web.length > 0, `${role} web tools: ${JSON.stringify(web.map((row) => ({ name: row.name, provenance: row.provenance, available: row.available })))}`).toBe(role === "lead_hunter");
          evidence[`inventory_${client}_${role}`] = { tools: rows.map((row) => row.name).sort(), toolsets: [...json!.enabled_toolsets].sort() };
        });
      }
    }
  });

  describe("an authenticated read through Hermes' own MCP client reaches the client's own records and no one else's", () => {
    it("is refused by the application without that employee's own live Chat turn", async () => {
      const a = member(alpha, "lead_hunter");
      const report = await runProbe(rt, PROBE, probeHome("noturn", a, alpha.credentials.lead_hunter), {
        tool: TOOL("get_role_workspace_context"), contains: ["active, authenticated Chat turn"], excludes: [alpha.tag, beta.tag],
      });
      expect(report.ok, JSON.stringify(report.warnings)).toBe(true);
      expect(report.call).toMatchObject({ registered: true, contains: { "active, authenticated Chat turn": true }, excludes: { [alpha.tag]: true, [beta.tag]: true } });
    });

    it("returns each client's own contact during its live Chat turn, and never the other client's", async () => {
      const a = member(alpha, "lead_hunter");
      const b = member(beta, "lead_hunter");
      await liveTurn(alpha, "lead_hunter");
      await liveTurn(beta, "lead_hunter");
      const forAlpha = await runProbe(rt, PROBE, probeHome("alpha", a, alpha.credentials.lead_hunter), { tool: TOOL("find_contacts"), arguments: { query: alpha.tag }, contains: [alpha.tag], excludes: [beta.tag] });
      const forBeta = await runProbe(rt, PROBE, probeHome("beta", b, beta.credentials.lead_hunter), { tool: TOOL("find_contacts"), arguments: { query: beta.tag }, contains: [beta.tag], excludes: [alpha.tag] });
      expect(forAlpha.call, JSON.stringify(forAlpha.warnings)).toMatchObject({ registered: true, contains: { [alpha.tag]: true }, excludes: { [beta.tag]: true } });
      expect(forBeta.call, JSON.stringify(forBeta.warnings)).toMatchObject({ registered: true, contains: { [beta.tag]: true }, excludes: { [alpha.tag]: true } });
      evidence.reads = { alpha: forAlpha.call?.bytes, beta: forBeta.call?.bytes };
    });

    it("lets a credential read only its own client: the second client's credential, asked for the first client's contact, finds nothing of it", async () => {
      const b = member(beta, "lead_hunter");
      await liveTurn(beta, "lead_hunter");
      const asked = await runProbe(rt, PROBE, probeHome("beta-asks-alpha", b, beta.credentials.lead_hunter), { tool: TOOL("find_contacts"), arguments: { query: alpha.tag }, excludes: [alpha.tag, "Alphaville Prospect"] });
      expect(asked.call, JSON.stringify(asked.warnings)).toMatchObject({ registered: true, excludes: { [alpha.tag]: true, "Alphaville Prospect": true } });
    });

    it("gives each role its own tools: the CRM Manager reads its client's deals, the Lead Hunter has no deal tool to call", async () => {
      const crm = member(alpha, "crm_manager");
      await liveTurn(alpha, "crm_manager");
      const deals = await runProbe(rt, PROBE, probeHome("alpha-crm", crm, alpha.credentials.crm_manager), { tool: TOOL("list_opportunities"), contains: [alpha.dealName], excludes: [beta.dealName] });
      expect(deals.call, JSON.stringify(deals.warnings)).toMatchObject({ registered: true, contains: { [alpha.dealName]: true }, excludes: { [beta.dealName]: true } });
      const hunter = member(alpha, "lead_hunter");
      const missing = await runProbe(rt, PROBE, probeHome("alpha-hunter-deals", hunter, alpha.credentials.lead_hunter), { tool: TOOL("list_opportunities"), excludes: [alpha.dealName] });
      expect(missing.call?.registered).toBe(false);
    });

    it("has no way to act without a person: a proposal, a message or a booking tool is not registered for any role", async () => {
      const a = member(alpha, "appointment_setter");
      for (const name of ["request_appointment", "prepare_message", "request_send_approval", "create_task", "update_contact"]) {
        const report = await runProbe(rt, PROBE, probeHome(`blocked-${name}`, a, alpha.credentials.appointment_setter), { tool: TOOL(name), excludes: [alpha.tag] });
        expect(report.call?.registered, name).toBe(false);
      }
    });

    it("is refused for an employee the plan does not include: its credential still exists but the employee is switched off", async () => {
      const profileFiles = member(beta, "lead_hunter");
      // The second client never bought the Appointment Setter, so it is switched off and has no profile. Its credential is presented from another employee's profile files.
      const report = await runProbe(rt, PROBE, probeHome("locked", profileFiles, beta.credentials.appointment_setter));
      expect(report.discovered, JSON.stringify(report.warnings)).toEqual([]);
    });

    it("ends at once when the portal revokes the credential, with no change to the gateway", async () => {
      const crm = member(beta, "crm_manager");
      await liveTurn(beta, "crm_manager");
      const before = await runProbe(rt, PROBE, probeHome("beta-crm-before", crm, beta.credentials.crm_manager), { tool: TOOL("list_opportunities"), contains: [beta.dealName] });
      expect(before.call?.contains, JSON.stringify(before.call)).toMatchObject({ [beta.dealName]: true });
      await withSystem((db) => revokeClientBusinessCredentialsForAgent(db, beta.org.id, beta.agents.crm_manager, "test_revoked"));
      const after = await runProbe(rt, PROBE, probeHome("beta-crm-after", crm, beta.credentials.crm_manager));
      expect(after.discovered, "a revoked credential discovers nothing").toEqual([]);
    });
  });
});

/** Polls until `check` returns true or `ms` have passed; returns whether it ever did. */
async function within(ms: number, check: () => Promise<boolean>): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (await check()) return true;
    if (Date.now() > end) return false;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
}

suite("what a running gateway does when a client profile's business tools or key change", () => {
  const rt = runtime as PinnedRuntime;
  const scratch = disposableRoot("iaq-client-reload-");
  const home = path.join(scratch.root, "hermes-home");
  const rootKey = randomBytes(32).toString("hex");
  const HOLD_MS = 60_000; // a change that is NOT picked up must stay unseen for twice the profile watcher's 30-second rescan
  const WAIT_MS = 90_000; // a change that IS picked up is waited for up to three rescans
  let tenant: ClientTenant;
  let mcp: Awaited<ReturnType<typeof serveHandler>>;
  let gateway: GatewayHandle;
  let port = 0;
  const role: AgentRoleKey = "crm_manager";
  let profile = "";
  let keyOne = randomBytes(32).toString("hex");
  const keyTwo = randomBytes(32).toString("hex");
  const observed: Record<string, unknown> = {};

  const dir = () => path.join(home, "profiles", profile);
  const names = (json: Catalog | null) => (json?.data ?? []).filter((row) => row.provenance?.source === "mcp").map((row) => row.name).sort();
  const wanted = () => [...clientBusinessMcpRuntimeNamesForRole(role)].sort();
  async function tools(key: string) {
    const response = await fetch(`${gateway.base}/p/${profile}/v1/tools?platform=api_server`, { headers: { Authorization: `Bearer ${key}`, "X-Hermes-Inventory-Challenge": randomBytes(16).toString("hex") } });
    return { status: response.status, business: names((await response.json().catch(() => null)) as Catalog | null) };
  }
  const writeProfile = (config: string, key: string, credential: string | null) => {
    writeFileSync(path.join(dir(), "config.yaml"), config, "utf8");
    writeFileSync(path.join(dir(), ".env"), `API_SERVER_ENABLED=true\nAPI_SERVER_KEY=${key}\n${credential ? `IACQUIRE_BUSINESS_MCP_TOKEN=${credential}\n` : ""}`, { encoding: "utf8", mode: 0o600 });
  };
  async function restart() {
    await gateway.stop();
    gateway = await startGateway(rt, home, port, rootKey);
  }

  beforeAll(async () => {
    port = await freePort();
    mcp = await serveHandler(handleHermesClientBusinessMcp);
    vi.stubEnv("APP_URL", mcp.url);
    vi.stubEnv("WORKFORCE_ROLE_TOOL_ENFORCEMENT", "enforce");
    setClientTier(true);
    tenant = await provisionedClient({ name: "Reload Roofing", timezone: "America/Chicago", tag: "Reloadville", phone: "+13125550102" });
    profile = suggestedProfileName(tenant.org.slug, role);
    // The profile starts the way a first provision leaves it: no business tool entry, no credential (the tier is delivered by a later synchronization).
    await createHome(rt, home, port, [{ name: profile, apiKey: keyOne, credential: null, mcpUrl: null, toolsets: [] }]);
    writeProfile(buildConfigYaml(DEFAULT_BLOCKED_TOOLSETS, role, { businessMcp: false }), keyOne, null);
    gateway = await startGateway(rt, home, port, rootKey);
  }, 900_000);

  afterAll(async () => {
    await gateway?.stop();
    await mcp?.close();
    if (process.env.IACQUIRE_C6_EVIDENCE) {
      const target = process.env.IACQUIRE_C6_EVIDENCE.replace(/\.json$/, "-reload.json");
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, `${JSON.stringify(observed, null, 2)}\n`, "utf8");
    }
    vi.unstubAllEnvs();
    resetEnvCache();
    disposeQuietly(scratch);
  }, 120_000);

  it("installing the tier into a live profile is not picked up by the running gateway; a restart loads it", async () => {
    expect((await tools(keyOne)).business).toEqual([]);
    writeProfile(buildConfigYaml(DEFAULT_BLOCKED_TOOLSETS, role, { businessMcp: true }), keyOne, tenant.credentials[role]);
    // The gateway connects a profile's MCP servers when it loads the profile, so a server added to a loaded profile is not connected until the gateway restarts.
    const pickedUp = await within(HOLD_MS, async () => (await tools(keyOne)).business.length > 0);
    observed.installWithoutRestart = pickedUp ? "loaded" : "not loaded";
    await restart();
    const after = await tools(keyOne);
    observed.installAfterRestart = after.business.length === wanted().length ? "loaded" : after.business;
    // A characterisation, not a requirement: if a later Hermes version loads a new server into a live profile this turns true and the rollout's restart step can change.
    expect(pickedUp, "the running gateway loaded the business tools without a restart: the restart step of the rollout can change").toBe(false);
    expect(after.business).toEqual(wanted());
  }, 300_000);

  it("removing the tier from a live profile IS picked up by the running gateway: the business tools leave its inventory without a restart", async () => {
    writeProfile(buildConfigYaml(DEFAULT_BLOCKED_TOOLSETS, role, { businessMcp: false }), keyOne, null);
    const dropped = await within(WAIT_MS, async () => (await tools(keyOne)).business.length === 0);
    observed.removeWithoutRestart = dropped ? "removed" : "still listed";
    expect(dropped, "the running gateway still listed the business tools after the profile dropped them: switching the tier off then needs a restart too").toBe(true);
    await restart();
    const after = await tools(keyOne);
    observed.removeAfterRestart = after.business.length === 0 ? "removed" : after.business;
    expect(after.business).toEqual([]);
  }, 300_000);

  it("a NEW profile created with the tier already in its configuration is discovered by the running gateway but has no business tools until the gateway restarts", async () => {
    const other = suggestedProfileName(tenant.org.slug, "lead_hunter");
    const otherKey = randomBytes(32).toString("hex");
    const otherDir = path.join(home, "profiles", other);
    await createHome(rt, home, port, [{ name: other, apiKey: otherKey, credential: tenant.credentials.lead_hunter, mcpUrl: null, toolsets: [] }]);
    writeFileSync(path.join(otherDir, "config.yaml"), buildConfigYaml(DEFAULT_BLOCKED_TOOLSETS, "lead_hunter", { businessMcp: true }), "utf8");
    const response = async () => {
      const r = await fetch(`${gateway.base}/p/${other}/v1/tools?platform=api_server`, { headers: { Authorization: `Bearer ${otherKey}`, "X-Hermes-Inventory-Challenge": randomBytes(16).toString("hex") } });
      return { status: r.status, business: names((await r.json().catch(() => null)) as Catalog | null) };
    };
    // The profile watcher finds the new profile within its rescan, so the profile answers; but a profile's MCP servers are connected when the gateway starts, not when a profile appears.
    const found = await within(WAIT_MS, async () => (await response()).status === 200);
    const before = found ? (await response()).business : [];
    const expected = [...clientBusinessMcpRuntimeNamesForRole("lead_hunter")].sort();
    await restart();
    const after = await response();
    observed.newProfileWithoutRestart = { discovered: found, businessToolsBeforeRestart: before.length, businessToolsAfterRestart: after.business.length, expected: expected.length };
    expect(found, "the running gateway did not discover the new profile").toBe(true);
    // A characterisation, not a requirement: if a later Hermes connects a new profile's servers when it appears, a new client's first provision can carry the tier and needs no restart.
    expect(before, "a new profile's MCP server was connected without a restart: a first provision could carry the tier").toEqual([]);
    expect(after.business).toEqual(expected);
  }, 400_000);

  it("replacing a profile's API key and switching its tools off (what containment does) IS applied by the running gateway: the old key is refused and the new one works without a restart", async () => {
    writeProfile(buildConfigYaml(DEFAULT_BLOCKED_TOOLSETS, role, { businessMcp: true }), keyOne, tenant.credentials[role]);
    await restart();
    expect((await tools(keyOne)).business).toEqual(wanted());
    // What the worker's revoke does: a key nobody is given, the tools-off policy, no credential.
    writeProfile(buildConfigYaml(DEFAULT_BLOCKED_TOOLSETS, role, { businessMcp: false }), keyTwo, null);
    const applied = await within(WAIT_MS, async () => (await tools(keyOne)).status === 401 && (await tools(keyTwo)).status === 200);
    const oldNow = await tools(keyOne);
    const newNow = await tools(keyTwo);
    observed.containWithoutRestart = { applied, oldKeyStatus: oldNow.status, newKeyStatus: newNow.status, toolsListedWithNewKey: newNow.business.length };
    expect(applied, "containment was not applied by the running gateway: it needs a restart, and the worker's revoke must say so").toBe(true);
    expect(newNow.business).toEqual([]);
    await restart();
    const oldAfter = await tools(keyOne);
    const newAfter = await tools(keyTwo);
    observed.containAfterRestart = { oldKeyStatus: oldAfter.status, newKeyStatus: newAfter.status, tools: newAfter.business.length };
    // After a restart, whatever the running gateway did: the old key is refused, the new one works, and no business tool remains.
    expect(oldAfter.status).toBe(401);
    expect(newAfter.status).toBe(200);
    expect(newAfter.business).toEqual([]);
    keyOne = keyTwo;
  }, 400_000);
});
