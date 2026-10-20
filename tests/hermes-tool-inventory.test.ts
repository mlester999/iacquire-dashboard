import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startRun } from "@/server/integrations/hermes/client";
import {
  TOOL_INVENTORY_CONTRACT,
  ToolInventoryError,
  inventoryColumns,
  toolInventoryDiagnostic,
  toolInventoryReady,
  verifyToolInventory,
} from "@/server/integrations/hermes/inventory";
import { startMockHermes, type MockHermes, type MockInventoryTool } from "./support/mock-hermes";

const PROFILE = "c-inventory-test";
const KEY = "i".repeat(40);
const SAFE_TOOLS: MockInventoryTool[] = [
  { name: "memory", toolset: "memory" },
  { name: "session_search", toolset: "session_search" },
  { name: "todo_list", toolset: "todo" },
  { name: "vision_analyze", toolset: "vision" },
  { name: "web_search", toolset: "web" },
  { name: "web_extract", toolset: "web" },
];
const WITHOUT_VISION = SAFE_TOOLS.filter((tool) => tool.name !== "vision_analyze");
const SAFE_TOOLSETS = ["memory", "session_search", "todo", "vision", "web"];

let mock: MockHermes;
const conn = () => ({ baseUrl: mock.url, profile: PROFILE, apiKey: KEY });
/** A connection as a health-checked employee has it: the digest the last health check recorded. */
async function recordedConn() {
  const { digest } = await verifyToolInventory(conn(), { stabilityReads: 2 });
  return { ...conn(), expectedToolInventoryDigest: digest };
}

async function failure(promise: Promise<unknown>): Promise<ToolInventoryError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ToolInventoryError);
    return err as ToolInventoryError;
  }
  throw new Error("expected the inventory check to fail closed");
}

beforeAll(async () => {
  mock = await startMockHermes({ [PROFILE]: { key: KEY } });
});
afterAll(() => mock.close());
beforeEach(() => mock.setInventory(PROFILE, null));

describe("complete runtime tool inventory", () => {
  it("accepts the reviewed allowlist and records a stable digest", async () => {
    const snapshot = await verifyToolInventory(conn(), { stabilityReads: 2 });
    expect(snapshot.toolCount).toBe(6);
    expect(snapshot.tools.map((tool) => tool.name)).toEqual([
      "memory",
      "session_search",
      "todo_list",
      "vision_analyze",
      "web_extract",
      "web_search",
    ]);
    expect(snapshot.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.attestation).toBe("challenge_bound_authenticated_catalog");
  });

  it("accepts a profile without vision credentials, because vision_analyze is optional", async () => {
    mock.setInventory(PROFILE, { tools: WITHOUT_VISION });
    const snapshot = await verifyToolInventory(conn(), { stabilityReads: 2 });
    expect(snapshot.tools.map((tool) => tool.name)).toEqual(["memory", "session_search", "todo_list", "web_extract", "web_search"]);
  });

  it("accepts both the flat live row shape and a function-wrapped row", async () => {
    const flat = await verifyToolInventory(conn(), { stabilityReads: 2 });
    mock.setInventory(PROFILE, { functionWrapped: true });
    const wrapped = await verifyToolInventory(conn(), { stabilityReads: 2 });
    expect(wrapped.digest).toBe(flat.digest);
  });

  it("allows a run only after the fresh inventory passes, and never before", async () => {
    const recorded = await recordedConn();
    const before = mock.requests.filter((request) => request.path === "/v1/runs").length;
    const toolReadsBefore = mock.requests.filter((request) => request.path === "/v1/tools").length;
    const started = await startRun(recorded, { input: "READY", idempotencyKey: "inventory-approved" });
    expect(started.runId).toMatch(/^run_/);
    expect(mock.requests.filter((request) => request.path === "/v1/runs").length).toBe(before + 1);
    expect(mock.requests.filter((request) => request.path === "/v1/tools").length - toolReadsBefore).toBe(2);
  });

  it("refuses a run when no health check ever recorded a digest, before any gateway request", async () => {
    const requestsBefore = mock.requests.length;
    const err = await failure(startRun(conn(), { input: "never checked", idempotencyKey: "inventory-not-recorded" }));
    expect(err.detail.code).toBe("inventory_not_recorded");
    expect(err.message).toMatch(/health check first/);
    expect(mock.requests).toHaveLength(requestsBefore);
    // The live catalog would pass, so the digest is the only thing standing between this connection and a run.
    await expect(verifyToolInventory(conn(), { stabilityReads: 2 })).resolves.toMatchObject({ toolCount: 6 });
    await failure(verifyToolInventory(conn(), { purpose: "run", expectedDigest: null }));
    await failure(verifyToolInventory(conn(), { purpose: "run", expectedDigest: "" }));
  });

  it("refuses a run whose live inventory no longer matches the recorded digest, before /v1/runs", async () => {
    const recorded = await recordedConn();
    mock.setInventory(PROFILE, { tools: WITHOUT_VISION });
    const runsBefore = mock.requests.filter((request) => request.path === "/v1/runs").length;
    const err = await failure(startRun(recorded, { input: "changed", idempotencyKey: "inventory-run-changed" }));
    expect(err.detail.code).toBe("inventory_changed");
    expect(mock.requests.filter((request) => request.path === "/v1/runs").length).toBe(runsBefore);
  });

  it("rejects an undeclared plugin/release-backfill tool", async () => {
    mock.setInventory(PROFILE, {
      tools: [...SAFE_TOOLS, { name: "bfl_flux", toolset: "web", source: "recently_shipped", addedBelowExplicitConfig: true }],
    });
    const err = await failure(verifyToolInventory(conn()));
    expect(err.detail.code).toBe("inventory_unsafe");
    expect(err.message).toMatch(/added below the explicit profile allowlist/);
    expect(err.message).toContain("bfl_flux");
  });

  it("rejects a plugin toolset enabled outside the explicit allowlist", async () => {
    mock.setInventory(PROFILE, {
      tools: [...SAFE_TOOLS, { name: "spotify_search", toolset: "spotify", source: "configurable" }],
      enabledToolsets: [...SAFE_TOOLSETS, "spotify"],
    });
    const err = await failure(verifyToolInventory(conn()));
    expect(err.detail.code).toBe("inventory_unsafe");
    expect(err.message).toMatch(/not allowed: spotify/);
  });

  it("rejects MCP tools even when their server is disconnected", async () => {
    mock.setInventory(PROFILE, {
      tools: [...SAFE_TOOLS, { name: "mcp__audit__inspect", toolset: "mcp-audit", source: "mcp", sourceServer: "audit", available: false }],
    });
    const err = await failure(verifyToolInventory(conn()));
    expect(err.detail.code).toBe("inventory_unsafe");
    expect(err.message).toMatch(/MCP tool/);
    expect(err.message).toContain("mcp__audit__inspect");
  });

  it("rejects Tool Search bridge and connector access", async () => {
    mock.setInventory(PROFILE, { tools: [...SAFE_TOOLS, { name: "tool_search", toolset: "web" }] });
    let err = await failure(verifyToolInventory(conn()));
    expect(err.detail.code).toBe("inventory_unsafe");
    expect(err.message).toMatch(/Tool Search\/connector access/);

    mock.setInventory(PROFILE, { tools: [...SAFE_TOOLS, { name: "manage_connections", toolset: "web" }] });
    err = await failure(verifyToolInventory(conn()));
    expect(err.detail.code).toBe("inventory_unsafe");
    expect(err.message).toMatch(/Tool Search\/connector access/);
  });

  it("rejects a deferred tool that is outside the reviewed set", async () => {
    mock.setInventory(PROFILE, { tools: [...SAFE_TOOLS, { name: "image_generate", toolset: "image_gen" }] });
    const err = await failure(verifyToolInventory(conn()));
    expect(err.detail.code).toBe("inventory_unsafe");
    expect(err.message).toMatch(/unreviewed toolsets/);
  });

  it("requires an explicit server-enforced profile allowlist", async () => {
    mock.setInventory(PROFILE, { explicitConfigPresent: false });
    const err = await failure(verifyToolInventory(conn()));
    expect(err.detail.code).toBe("allowlist_missing");
    expect(err.message).toMatch(/platform_toolsets\.api_server/);
  });

  it("rejects an incomplete or empty catalog", async () => {
    mock.setInventory(PROFILE, { tools: [] });
    let err = await failure(verifyToolInventory(conn()));
    expect(err.message).toMatch(/tool catalog was empty/);

    mock.setInventory(PROFILE, { tools: [{ name: "memory", toolset: "memory", source: "unresolved" }] });
    err = await failure(verifyToolInventory(conn()));
    expect(err.detail.code).toBe("inventory_incomplete");
    expect(err.message).toMatch(/could not be resolved/);
  });

  it("rejects an inventory the gateway does not certify as complete", async () => {
    mock.setInventory(PROFILE, { complete: false, incompleteReason: "MCP server 'audit' has never completed discovery" });
    const err = await failure(verifyToolInventory(conn()));
    expect(err.detail.code).toBe("inventory_incomplete");
    expect(err.message).toMatch(/reported that its runtime tool catalog is incomplete/);
    expect(err.message).toMatch(/audit/);
  });

  it("rejects a catalog bound to a different challenge", async () => {
    mock.setInventory(PROFILE, { challengeOverride: "a-different-request" });
    const err = await failure(verifyToolInventory(conn()));
    expect(err.detail.code).toBe("inventory_incomplete");
    expect(err.message).toMatch(/echoed a different inventory challenge/);
  });

  it("requires the gateway to echo the challenge, so a response cannot be replayed or served stale", async () => {
    mock.setInventory(PROFILE, { echoChallenge: false });
    const err = await failure(verifyToolInventory(conn()));
    expect(err.detail.code).toBe("inventory_incomplete");
    expect(err.message).toMatch(/did not echo the inventory challenge/);
    const runsBefore = mock.requests.filter((request) => request.path === "/v1/runs").length;
    await failure(startRun({ ...conn(), expectedToolInventoryDigest: "a".repeat(64) }, { input: "no echo", idempotencyKey: "inventory-no-echo" }));
    expect(mock.requests.filter((request) => request.path === "/v1/runs").length).toBe(runsBefore);
  });

  it("requires the gateway to name the tool-catalog contract", async () => {
    mock.setInventory(PROFILE, { contract: null });
    let err = await failure(verifyToolInventory(conn()));
    expect(err.detail.code).toBe("inventory_incomplete");
    expect(err.message).toMatch(/did not identify the supported tool-catalog contract/);

    mock.setInventory(PROFILE, { contract: "hermes.api_server.tool_catalog.v0" });
    err = await failure(verifyToolInventory(conn()));
    expect(err.message).toMatch(/did not identify the supported tool-catalog contract/);
  });

  it("requires all five reviewed tools and names the missing ones", async () => {
    for (const required of ["memory", "session_search", "todo_list", "web_extract", "web_search"]) {
      mock.setInventory(PROFILE, { tools: SAFE_TOOLS.filter((tool) => tool.name !== required) });
      const err = await failure(verifyToolInventory(conn()));
      expect(err.detail.code).toBe("inventory_incomplete");
      expect(err.message).toMatch(/missing required reviewed tool/);
      expect(err.detail.tools).toEqual([required]);
    }
  });

  it("rejects a reviewed-looking extra tool that is not one of the five required tools or vision_analyze", async () => {
    mock.setInventory(PROFILE, { tools: [...SAFE_TOOLS, { name: "clarify", toolset: "web" }] });
    const err = await failure(verifyToolInventory(conn()));
    expect(err.detail.code).toBe("inventory_unsafe");
    expect(err.message).toMatch(/outside the reviewed client allowlist: clarify/);
  });

  it("rejects a repeated tool name and a row without its parameters schema", async () => {
    mock.setInventory(PROFILE, { tools: [...SAFE_TOOLS, { name: "memory", toolset: "memory" }] });
    let err = await failure(verifyToolInventory(conn()));
    expect(err.detail.code).toBe("inventory_incomplete");
    expect(err.message).toMatch(/invalid or duplicate tool name/);

    mock.setInventory(PROFILE, { tools: SAFE_TOOLS.map((tool) => (tool.name === "memory" ? { ...tool, omitParameters: true } : tool)) });
    err = await failure(verifyToolInventory(conn()));
    expect(err.detail.code).toBe("inventory_incomplete");
    expect(err.message).toMatch(/parameters schema/);
  });

  it("rejects an expired inventory attestation", async () => {
    mock.setInventory(PROFILE, { expiresAt: new Date(Date.now() - 60_000).toISOString() });
    const err = await failure(verifyToolInventory(conn()));
    expect(err.detail.code).toBe("inventory_expired");
  });

  it("detects an inventory change between two reads", async () => {
    mock.setInventory(PROFILE, { changeAfterFirstRead: WITHOUT_VISION });
    const err = await failure(verifyToolInventory(conn(), { stabilityReads: 2 }));
    expect(err.detail.code).toBe("inventory_changed");
    expect(err.message).toMatch(/between two consecutive reads/);
  });

  it("refuses a digest that no longer matches the last health check", async () => {
    const err = await failure(verifyToolInventory(conn(), { expectedDigest: "0".repeat(64) }));
    expect(err.detail.code).toBe("inventory_changed");
    expect(err.message).toMatch(/no longer matches the last verified check/);
  });

  it("reports an unavailable inventory service and refuses the run before /v1/runs", async () => {
    mock.setInventory(PROFILE, { status: 503 });
    const err = await failure(verifyToolInventory(conn()));
    expect(err.detail.code).toBe("inventory_unavailable");
    const runsBefore = mock.requests.filter((request) => request.path === "/v1/runs").length;
    await expect(startRun({ ...conn(), expectedToolInventoryDigest: "a".repeat(64) }, { input: "blocked", idempotencyKey: "inventory-unavailable" })).rejects.toBeInstanceOf(ToolInventoryError);
    expect(mock.requests.filter((request) => request.path === "/v1/runs").length).toBe(runsBefore);
  });

  it("reports an old gateway that does not expose GET /v1/tools", async () => {
    mock.setInventory(PROFILE, { advertised: false });
    const err = await failure(verifyToolInventory(conn()));
    expect(err.detail.code).toBe("contract_unavailable");
    expect(err.message).toMatch(/does not expose GET \/v1\/tools/);
    const runsBefore = mock.requests.filter((request) => request.path === "/v1/runs").length;
    await expect(startRun({ ...conn(), expectedToolInventoryDigest: "a".repeat(64) }, { input: "blocked", idempotencyKey: "inventory-contract-missing" })).rejects.toBeInstanceOf(ToolInventoryError);
    expect(mock.requests.filter((request) => request.path === "/v1/runs").length).toBe(runsBefore);
  });
});

describe("persisted inventory readiness", () => {
  const base = {
    last_health_ok: true,
    tool_inventory_contract: TOOL_INVENTORY_CONTRACT,
    tool_inventory_digest: "a".repeat(64),
    tool_inventory_verified_at: new Date(Date.now() - 1000),
    tool_inventory_expires_at: new Date(Date.now() + 60_000),
    tool_inventory_tool_count: 6,
  };

  it("accepts a fresh verified snapshot", () => {
    expect(toolInventoryReady(base)).toBe(true);
    expect(toolInventoryDiagnostic({ ...base, tool_inventory_detail: null })).toMatch(/Complete inventory verified: 6 tools/);
  });

  it("refuses a stale attestation", () => {
    const stale = { ...base, tool_inventory_expires_at: new Date(Date.now() - 1) };
    expect(toolInventoryReady(stale)).toBe(false);
    expect(toolInventoryDiagnostic({ ...stale, tool_inventory_detail: null })).toMatch(/expired/);
  });

  it("refuses an attestation after a failed health check", () => {
    expect(toolInventoryReady({ ...base, last_health_ok: false })).toBe(false);
  });

  it("round-trips the compact stored snapshot", () => {
    const columns = inventoryColumns(
      {
        contract: TOOL_INVENTORY_CONTRACT,
        profile: PROFILE,
        digest: "b".repeat(64),
        fetchedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        enabledToolsets: SAFE_TOOLSETS,
        explicitConfigPresent: true,
        tools: SAFE_TOOLS.map((tool) => ({ name: tool.name, toolset: tool.toolset!, source: "configurable" as const, sourceServer: null, available: null })),
        toolCount: SAFE_TOOLS.length,
        attestation: "challenge_bound_authenticated_catalog",
        serverContract: "hermes.api_server.capabilities",
      },
      "verified",
    );
    expect(columns.toolInventoryDigest).toBe("b".repeat(64));
    expect(columns.toolInventorySnapshot).toMatchObject({ toolCount: 6, contract: TOOL_INVENTORY_CONTRACT });
    expect(toolInventoryReady({
      last_health_ok: true,
      tool_inventory_contract: columns.toolInventoryContract,
      tool_inventory_digest: columns.toolInventoryDigest,
      tool_inventory_verified_at: columns.toolInventoryVerifiedAt,
      tool_inventory_expires_at: columns.toolInventoryExpiresAt,
      tool_inventory_tool_count: columns.toolInventoryToolCount,
    })).toBe(true);
  });
});
