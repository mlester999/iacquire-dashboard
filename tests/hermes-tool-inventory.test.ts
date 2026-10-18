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
const SAFE_TOOLSETS = ["memory", "session_search", "todo", "vision", "web"];

let mock: MockHermes;
const conn = () => ({ baseUrl: mock.url, profile: PROFILE, apiKey: KEY });

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

  it("allows a run only after the fresh inventory passes, and never before", async () => {
    const before = mock.requests.filter((request) => request.path === "/v1/runs").length;
    const started = await startRun(conn(), { input: "READY", idempotencyKey: "inventory-approved" });
    expect(started.runId).toMatch(/^run_/);
    expect(mock.requests.filter((request) => request.path === "/v1/runs").length).toBe(before + 1);
    expect(mock.requests.filter((request) => request.path === "/v1/tools").length).toBeGreaterThanOrEqual(2);
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

  it("rejects an expired inventory attestation", async () => {
    mock.setInventory(PROFILE, { expiresAt: new Date(Date.now() - 60_000).toISOString() });
    const err = await failure(verifyToolInventory(conn()));
    expect(err.detail.code).toBe("inventory_expired");
  });

  it("detects an inventory change between two reads", async () => {
    mock.setInventory(PROFILE, { changeAfterFirstRead: SAFE_TOOLS.slice(0, 5) });
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
    await expect(startRun(conn(), { input: "blocked", idempotencyKey: "inventory-unavailable" })).rejects.toBeInstanceOf(ToolInventoryError);
    expect(mock.requests.filter((request) => request.path === "/v1/runs").length).toBe(runsBefore);
  });

  it("reports an old gateway that does not expose GET /v1/tools", async () => {
    mock.setInventory(PROFILE, { advertised: false });
    const err = await failure(verifyToolInventory(conn()));
    expect(err.detail.code).toBe("contract_unavailable");
    expect(err.message).toMatch(/does not expose GET \/v1\/tools/);
    const runsBefore = mock.requests.filter((request) => request.path === "/v1/runs").length;
    await expect(startRun(conn(), { input: "blocked", idempotencyKey: "inventory-contract-missing" })).rejects.toBeInstanceOf(ToolInventoryError);
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
