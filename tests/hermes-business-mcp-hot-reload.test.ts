// A4a, section 3 item 5 of docs/hermes-a4a-acceptance-plan-2026-10-31.md: does a RUNNING pinned Hermes 0.21.5 gateway (with this repository's catalog overlay) pick up a business MCP entry and a
// credential that are added to a live profile, or does the gateway have to be restarted? The answer decides whether the A4a window includes a restart (which briefly interrupts all six employees'
// Chat) or only edits the profile's `config.yaml` and `.env`.
//
// EVIDENCE ONLY when a pinned runtime is supplied (IACQUIRE_C6_PYTHON, IACQUIRE_C6_HERMES_SOURCE; services/hermes-business-mcp-acceptance/prepare-runtime.mjs builds one); otherwise the file is skipped,
// like the C6 proof it extends. What runs: the real gateway in a disposable home with one profile, the real business MCP handler on loopback over a synthetic in-memory database, no model, no key,
// nothing outside loopback. What is observed is the gateway's own complete tool inventory (the route the application's health check reads), the same facts C6 checks, asked before the entry exists,
// after it was written into the live profile, and after a restart.
import { randomBytes } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AGENCY_HERMES_PROFILE_IDS, type AgentRoleKey } from "@/lib/agents";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { handleHermesBusinessMcp } from "@/server/workforce/hermes-business-mcp";
import { issueConfiguredBusinessMcpCredential } from "@/server/workforce/hermes-business-mcp-credential";
import { businessMcpRuntimeNamesForRole, HERMES_BUSINESS_MCP_TOOLSET } from "@/server/workforce/hermes-business-mcp-policy";
import { connectHermesProfile, createConfigVersion } from "@/server/workforce/service";
import { defaultSettings } from "@/server/workforce/compiler";
import { addMember, agentId, createOrg, createUser } from "./support/fixtures";
import { MCP_TEST_SECRET } from "./support/business-mcp";
import { createHome, disposableRoot, freePort, pinnedRuntimeFromEnv, profileConfigYaml, serveHandler, startGateway, type GatewayHandle, type PinnedRuntime } from "./support/c6-runtime";

const runtime = pinnedRuntimeFromEnv();
const suite = runtime ? describe : describe.skip;
const SAFE_TOOLSETS = ["memory", "session_search", "todo", "vision", "web"];
const ROLE: AgentRoleKey = "operations_manager"; // Zeng: the employee A4a starts with
const PROFILE = AGENCY_HERMES_PROFILE_IDS[ROLE];

type Catalog = { complete: boolean; data: Array<{ name: string; provenance?: { source?: string } }> };

suite("a business MCP entry added to a live profile of a running pinned gateway", () => {
  const rt = runtime as PinnedRuntime;
  const scratch = disposableRoot("iaq-c6-reload-");
  const home = path.join(scratch.root, "hermes-home");
  const rootKey = randomBytes(32).toString("hex");
  const profileKey = randomBytes(32).toString("hex");
  const profileDir = path.join(home, "profiles", PROFILE);
  let mcp: Awaited<ReturnType<typeof serveHandler>>;
  let gateway: GatewayHandle;
  let port = 0;
  let credential = "";
  const expected = [...businessMcpRuntimeNamesForRole(ROLE, false)].sort();

  async function inventory(): Promise<{ complete: boolean; tools: string[] }> {
    const response = await fetch(`${gateway.base}/p/${PROFILE}/v1/tools?platform=api_server`, {
      headers: { Authorization: `Bearer ${profileKey}`, "X-Hermes-Inventory-Challenge": randomBytes(16).toString("hex") },
    });
    expect(response.status).toBe(200);
    const catalog = (await response.json()) as Catalog;
    return { complete: catalog.complete, tools: catalog.data.filter((row) => row.provenance?.source === "mcp").map((row) => row.name).sort() };
  }
  const businessTools = async () => (await inventory()).tools;

  /** Asks the running gateway repeatedly for up to `seconds`; true as soon as the business tools are listed. */
  async function appearsWithin(seconds: number): Promise<boolean> {
    const deadline = Date.now() + seconds * 1000;
    for (;;) {
      if (JSON.stringify(await businessTools()) === JSON.stringify(expected)) return true;
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  beforeAll(async () => {
    port = await freePort();
    mcp = await serveHandler(handleHermesBusinessMcp);
    vi.stubEnv("APP_URL", mcp.url);
    vi.stubEnv("HERMES_BUSINESS_MCP_ENABLED", "true");
    vi.stubEnv("HERMES_BUSINESS_MCP_WRITES_ENABLED", "false");
    vi.stubEnv("HERMES_BUSINESS_MCP_SECRET", MCP_TEST_SECRET);
    resetEnvCache();
    const admin = await createUser({ platformRole: "agency_super_admin", name: "Reload Admin" });
    const agency = await createOrg({ name: "Hot Reload Agency", kind: "agency" });
    await addMember(agency.id, admin.id, "owner");
    const id = await agentId(agency.id, ROLE);
    // The employee as the application knows it in production: an applied configuration and a connected profile, so the business endpoint accepts its credential.
    await withSystem((db) => createConfigVersion(db, { orgId: agency.id, agentId: id, settings: defaultSettings(ROLE), source: "onboarding", userId: admin.id, apply: true }));
    await connectHermesProfile({ agentId: id, baseUrl: `http://127.0.0.1:${port}`, profile: PROFILE, apiKey: profileKey, agencyUserId: admin.id });
    credential = issueConfiguredBusinessMcpCredential({ role: ROLE, agentId: id, orgId: agency.id }).token;
    // The profile as it is in production before A4a: the safe toolsets, no business MCP entry, no business credential, no business toolset.
    await createHome(rt, home, port, [{ name: PROFILE, apiKey: profileKey, credential: null, mcpUrl: null, toolsets: SAFE_TOOLSETS }]);
    gateway = await startGateway(rt, home, port, rootKey);
  }, 600_000);

  afterAll(async () => {
    await gateway?.stop();
    await mcp?.close();
    vi.unstubAllEnvs();
    resetEnvCache();
    // Best effort: on Windows the stopped gateway can keep a file in the disposable folder open for a moment, which is a clean-up problem and not a result.
    try {
      scratch.dispose();
    } catch {
      /* the folder is in the temporary directory and holds only synthetic files */
    }
  }, 120_000);

  it("before the change the running gateway lists no business tool", async () => {
    expect(await businessTools()).toEqual([]);
  });

  it("a running gateway does NOT pick the entry and the credential up from the edited profile: a restart is needed (observed against 0.21.5)", async () => {
    // Exactly what the owner does at the console: add the mcp_servers entry and the toolset to config.yaml, and the credential to .env. No restart, no reload command.
    writeFileSync(path.join(profileDir, "config.yaml"), profileConfigYaml({ mcpUrl: `${mcp.url}/api/internal/hermes-business/mcp`, toolsets: [...SAFE_TOOLSETS, HERMES_BUSINESS_MCP_TOOLSET] }), "utf8");
    appendFileSync(path.join(profileDir, ".env"), `IACQUIRE_BUSINESS_MCP_TOKEN=${credential}\n`, "utf8");
    expect(readFileSync(path.join(profileDir, ".env"), "utf8")).toContain("IACQUIRE_BUSINESS_MCP_TOKEN=");
    const picked = await appearsWithin(20);
    // A characterisation, not a requirement: if a later Hermes version reloads a live profile this turns true, and section 3 item 5 of the A4a plan (the window includes one restart) is to be updated.
    expect(picked, "the running gateway listed the business tools without a restart: the A4a plan's restart step can change").toBe(false);
  }, 120_000);

  it("after a restart the same profile files give the approved tools (the entry and the credential are right)", async () => {
    await gateway.stop();
    gateway = await startGateway(rt, home, port, rootKey);
    const restarted = await inventory();
    expect(restarted.complete).toBe(true);
    expect(restarted.tools).toEqual(expected);
  }, 180_000);
});
