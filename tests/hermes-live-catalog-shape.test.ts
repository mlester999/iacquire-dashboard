// The deployed gateway returns the flat, documented `hermes.api_server.tool_catalog.v1` shape, not the
// OpenAI-style `{ type: "function", function: {...} }` wrapper. This pins that live shape (including the
// challenge echo, required contract fields and two stable reads) against a literal HTTP response, so a
// future refactor of the mock helper cannot hide a real compatibility break.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyToolInventory } from "@/server/integrations/hermes/inventory";
import type { HermesConnection } from "@/server/integrations/hermes/client";

const PROFILE = "c-live-shape-audit";
const KEY = "l".repeat(40);
const TOOLSETS = ["memory", "session_search", "todo", "vision", "web"];
const TOOLS = [
  { name: "memory", toolset: "memory" },
  { name: "session_search", toolset: "session_search" },
  { name: "todo_list", toolset: "todo" },
  { name: "web_search", toolset: "web" },
  { name: "web_extract", toolset: "web" },
  { name: "vision_analyze", toolset: "vision" },
];

type Row = (typeof TOOLS)[number];
const requests: Array<{ method: string; path: string; challenge: string | null; queryChallenge: string | null; cacheControl: string | null }> = [];
let server: http.Server;
let baseUrl: string;
let tools: Row[] = TOOLS;
let advertiseToolsEndpoint = true;
let toolsEndpoint: unknown = ["GET", "/v1/tools"];
let echoChallenge = true;
let completeCatalog = true;
let omitNativeMetadata = false;

/** Exactly the row the patched gateway emits: flat schema plus provenance; `available` only on MCP rows. */
function liveRow(tool: Row) {
  return {
    name: tool.name,
    description: `Reviewed ${tool.name} tool.`,
    parameters: { type: "object", properties: {} },
    provenance: {
      source: "configurable",
      toolset: tool.toolset,
      requested_toolsets: [tool.toolset],
      source_server: null,
      added_below_explicit_config: false,
    },
  };
}

function body(challenge: string | null) {
  const catalog = {
    object: "list",
    platform: "api_server",
    explicit_config_present: true,
    enabled_toolsets: TOOLSETS,
    data: tools.map(liveRow),
  };
  if (omitNativeMetadata) return catalog;
  return {
    ...catalog,
    contract: "hermes.api_server.tool_catalog.v1",
    complete: completeCatalog,
    incomplete_reason: null,
    challenge: echoChallenge ? challenge : null,
    generated_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 120_000).toISOString(),
  };
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const match = url.pathname.match(/^\/p\/([^/]+)(\/.*)$/);
    const profile = match ? decodeURIComponent(match[1]) : null;
    const path = match ? match[2] : url.pathname;
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(json));
    };
    if (profile !== PROFILE || req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: "unauthorized" });
    if (req.method === "GET" && path === "/v1/capabilities") {
      return send(200, {
        object: "hermes.api_server.capabilities",
        platform: "hermes-agent",
        model: PROFILE,
        auth: { type: "bearer", required: true },
        features: { run_submission: true, run_status: true, run_events_sse: true },
        endpoints: advertiseToolsEndpoint ? { tools: toolsEndpoint } : {},
      });
    }
    if (req.method === "GET" && path === "/v1/tools") {
      const raw = req.headers["x-hermes-inventory-challenge"];
      const challenge = Array.isArray(raw) ? raw[0] : raw ?? null;
      requests.push({
        method: "GET",
        path,
        challenge,
        queryChallenge: url.searchParams.get("inventory_challenge"),
        cacheControl: typeof req.headers["cache-control"] === "string" ? req.headers["cache-control"] : null,
      });
      return send(200, body(challenge));
    }
    return send(404, { error: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const conn = (): HermesConnection => ({ baseUrl, profile: PROFILE, apiKey: KEY });

describe("the deployed live catalog shape", () => {
  it("verifies the documented flat rows and binds both reads to distinct challenges", async () => {
    requests.length = 0;
    tools = TOOLS;
    const snapshot = await verifyToolInventory(conn(), { stabilityReads: 2 });

    expect(snapshot.contract).toBe("hermes.api_server.tool_catalog.v1");
    expect(snapshot.attestation).toBe("challenge_bound_authenticated_catalog");
    expect(snapshot.toolCount).toBe(6);
    expect(snapshot.tools.map((tool) => tool.name)).toEqual([
      "memory",
      "session_search",
      "todo_list",
      "vision_analyze",
      "web_extract",
      "web_search",
    ]);
    expect(snapshot.tools.every((tool) => tool.source === "configurable" && tool.available === null)).toBe(true);

    expect(requests.map((request) => request.path)).toEqual(["/v1/tools", "/v1/tools"]);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
    const challenges = requests.map((request) => request.challenge);
    expect(challenges.every((challenge) => typeof challenge === "string" && challenge.length > 10)).toBe(true);
    expect(new Set(challenges).size).toBe(2);
    expect(requests.map((request) => request.queryChallenge)).toEqual(challenges);
    expect(requests.every((request) => request.cacheControl?.includes("no-store"))).toBe(true);
  });

  it("still accepts the live shape without vision credentials because vision_analyze is optional", async () => {
    requests.length = 0;
    tools = TOOLS.filter((tool) => tool.name !== "vision_analyze");
    const snapshot = await verifyToolInventory(conn(), { stabilityReads: 2 });
    expect(snapshot.tools.map((tool) => tool.name)).toEqual(["memory", "session_search", "todo_list", "web_extract", "web_search"]);
  });

  it("produces the same digest for the same catalog across independent verifications", async () => {
    tools = TOOLS;
    const first = await verifyToolInventory(conn(), { stabilityReads: 2 });
    const second = await verifyToolInventory(conn(), { stabilityReads: 2 });
    expect(second.digest).toBe(first.digest);
  });

  it("rejects an advertised resolver route when it omits the native completeness contract", async () => {
    omitNativeMetadata = true;
    try {
      await expect(verifyToolInventory(conn(), { stabilityReads: 2 })).rejects.toMatchObject({ code: "inventory_incomplete" });
    } finally {
      omitNativeMetadata = false;
    }
  });

  it("requires the authenticated capabilities response to advertise GET /v1/tools", async () => {
    advertiseToolsEndpoint = false;
    try {
      await expect(verifyToolInventory(conn(), { stabilityReads: 2 })).rejects.toMatchObject({ code: "contract_unavailable" });
    } finally {
      advertiseToolsEndpoint = true;
    }
  });

  it("accepts Hermes v0.22.3's exact object-form tools endpoint descriptor", async () => {
    toolsEndpoint = { method: "GET", path: "/v1/tools" };
    try {
      const snapshot = await verifyToolInventory(conn(), { stabilityReads: 2 });
      expect(snapshot.contract).toBe("hermes.api_server.tool_catalog.v1");
      expect(snapshot.toolCount).toBe(6);
    } finally {
      toolsEndpoint = ["GET", "/v1/tools"];
    }
  });

  it("rejects malformed object-form tools endpoint descriptors", async () => {
    try {
      for (const endpoint of [
        { method: "POST", path: "/v1/tools" },
        { method: "GET", path: "/v1/tools", extra: true },
        { method: "GET", path: "/v1/toolsets" },
      ]) {
        toolsEndpoint = endpoint;
        await expect(verifyToolInventory(conn(), { stabilityReads: 2 })).rejects.toMatchObject({ code: "contract_unavailable" });
      }
    } finally {
      toolsEndpoint = ["GET", "/v1/tools"];
    }
  });

  it("requires an exact challenge echo and a complete catalog", async () => {
    echoChallenge = false;
    try {
      await expect(verifyToolInventory(conn(), { stabilityReads: 2 })).rejects.toMatchObject({ code: "inventory_incomplete" });
    } finally {
      echoChallenge = true;
    }
    completeCatalog = false;
    try {
      await expect(verifyToolInventory(conn(), { stabilityReads: 2 })).rejects.toMatchObject({ code: "inventory_incomplete" });
    } finally {
      completeCatalog = true;
    }
  });
});
