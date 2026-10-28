import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/server/env";
import { handleHermesBusinessMcp } from "@/server/workforce/hermes-business-mcp";

const previousEnabled = process.env.HERMES_BUSINESS_MCP_ENABLED;
const previousWrites = process.env.HERMES_BUSINESS_MCP_WRITES_ENABLED;

beforeAll(() => {
  process.env.HERMES_BUSINESS_MCP_ENABLED = "false";
  process.env.HERMES_BUSINESS_MCP_WRITES_ENABLED = "false";
  resetEnvCache();
});

afterAll(() => {
  if (previousEnabled === undefined) delete process.env.HERMES_BUSINESS_MCP_ENABLED;
  else process.env.HERMES_BUSINESS_MCP_ENABLED = previousEnabled;
  if (previousWrites === undefined) delete process.env.HERMES_BUSINESS_MCP_WRITES_ENABLED;
  else process.env.HERMES_BUSINESS_MCP_WRITES_ENABLED = previousWrites;
  resetEnvCache();
});

describe("internal Hermes business MCP route", () => {
  it("returns not found before reading credentials or business data while disabled", async () => {
    const response = await handleHermesBusinessMcp(new Request("https://portal.example.test/api/internal/hermes-business/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }));
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
