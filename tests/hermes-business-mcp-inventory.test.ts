// The application's tool-inventory verifier on the business MCP path, against the mocked gateway. MOCKED: these tests pin the verifier's decisions (what it accepts and refuses when the business
// bridge is on for an internal employee) and are NOT evidence that a real Hermes behaves this way; that is tests/hermes-business-mcp-pinned-runtime.test.ts. One decision here exists because the
// pinned runtime showed the real gateway reports a configured MCP server under its own name as well as its toolset.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRoleKey } from "@/lib/agents";
import { resetEnvCache } from "@/server/env";
import { ToolInventoryError, verifyToolInventory } from "@/server/integrations/hermes/inventory";
import { businessMcpRuntimeNamesForRole, HERMES_BUSINESS_MCP_SERVER, HERMES_BUSINESS_MCP_TOOLSET } from "@/server/workforce/hermes-business-mcp-policy";
import { startMockHermes, type MockHermes, type MockInventoryTool } from "./support/mock-hermes";
import { MCP_TEST_SECRET } from "./support/business-mcp";

const PROFILE = "iacquire-lead-hunter";
const KEY = "m".repeat(40);
const SAFE_TOOLS: MockInventoryTool[] = [
  { name: "memory", toolset: "memory" },
  { name: "session_search", toolset: "session_search" },
  { name: "todo_list", toolset: "todo" },
  { name: "web_search", toolset: "web" },
  { name: "web_extract", toolset: "web" },
];
const SAFE_TOOLSETS = ["memory", "session_search", "todo", "vision", "web"];
const business = (role: AgentRoleKey): MockInventoryTool[] =>
  businessMcpRuntimeNamesForRole(role, false).map((name) => ({ name, toolset: HERMES_BUSINESS_MCP_TOOLSET, source: "mcp", sourceServer: HERMES_BUSINESS_MCP_SERVER }));

let mock: MockHermes;
const conn = (roleKey: AgentRoleKey = "lead_hunter") => ({ baseUrl: mock.url, profile: PROFILE, apiKey: KEY, orgKind: "agency" as const, roleKey });

async function failure(promise: Promise<unknown>): Promise<ToolInventoryError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ToolInventoryError);
    return error as ToolInventoryError;
  }
  throw new Error("expected the inventory check to fail closed");
}

beforeAll(async () => {
  mock = await startMockHermes({ [PROFILE]: { key: KEY } });
});
afterAll(() => mock.close());
beforeEach(() => {
  vi.stubEnv("HERMES_BUSINESS_MCP_ENABLED", "true");
  vi.stubEnv("HERMES_BUSINESS_MCP_WRITES_ENABLED", "false");
  vi.stubEnv("HERMES_BUSINESS_MCP_SECRET", MCP_TEST_SECRET);
  resetEnvCache();
  mock.setInventory(PROFILE, null);
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

describe("the verifier with the business bridge on for an internal employee", () => {
  const set = (inventory: Parameters<MockHermes["setInventory"]>[1]) => mock.setInventory(PROFILE, inventory);

  it("accepts exactly the role's business tools in the business toolset, with or without the server-name alias the real gateway adds", async () => {
    set({ tools: [...SAFE_TOOLS, ...business("lead_hunter")], enabledToolsets: [...SAFE_TOOLSETS, HERMES_BUSINESS_MCP_TOOLSET] });
    const plain = await verifyToolInventory(conn(), { stabilityReads: 2 });
    set({ tools: [...SAFE_TOOLS, ...business("lead_hunter")], enabledToolsets: [...SAFE_TOOLSETS, HERMES_BUSINESS_MCP_TOOLSET, HERMES_BUSINESS_MCP_SERVER] });
    const aliased = await verifyToolInventory(conn(), { stabilityReads: 2 });
    expect(plain.tools.filter((tool) => tool.source === "mcp").map((tool) => tool.name).sort()).toEqual([...businessMcpRuntimeNamesForRole("lead_hunter", false)].sort());
    expect(aliased.toolCount).toBe(plain.toolCount);
  });

  it("accepts each of the six roles' own tool lists", async () => {
    for (const role of ["operations_manager", "appointment_setter", "sales_assistant", "crm_manager", "performance_analyst"] as const) {
      set({ tools: [...SAFE_TOOLS, ...business(role)], enabledToolsets: [...SAFE_TOOLSETS, HERMES_BUSINESS_MCP_TOOLSET, HERMES_BUSINESS_MCP_SERVER] });
      expect((await verifyToolInventory(conn(role), { stabilityReads: 2 })).toolCount, role).toBe(SAFE_TOOLS.length + business(role).length);
    }
  });

  it("allows the alias only for the business bridge: with the bridge off it is an unreviewed toolset", async () => {
    vi.stubEnv("HERMES_BUSINESS_MCP_ENABLED", "false");
    resetEnvCache();
    set({ tools: SAFE_TOOLS, enabledToolsets: [...SAFE_TOOLSETS, HERMES_BUSINESS_MCP_SERVER] });
    expect((await failure(verifyToolInventory(conn()))).detail.code).toBe("inventory_unsafe");
  });

  it("allows the alias and nothing else: any other extra toolset is refused", async () => {
    for (const extra of ["terminal", "file", "browser", "iacquire_business_admin", "mcp-other_server"]) {
      set({ tools: [...SAFE_TOOLS, ...business("lead_hunter")], enabledToolsets: [...SAFE_TOOLSETS, HERMES_BUSINESS_MCP_TOOLSET, HERMES_BUSINESS_MCP_SERVER, extra] });
      const error = await failure(verifyToolInventory(conn()));
      expect(error.detail.code, extra).toBe("inventory_unsafe");
      expect(error.message).toContain(extra);
    }
  });

  it("does not let a tool hide behind the alias: a row whose toolset is the server name is refused", async () => {
    set({ tools: [...SAFE_TOOLS, ...business("lead_hunter").map((tool, i) => (i === 0 ? { ...tool, toolset: HERMES_BUSINESS_MCP_SERVER } : tool))], enabledToolsets: [...SAFE_TOOLSETS, HERMES_BUSINESS_MCP_TOOLSET, HERMES_BUSINESS_MCP_SERVER] });
    expect((await failure(verifyToolInventory(conn()))).detail.code).toBe("inventory_unsafe");
  });

  it("refuses a tool the role does not hold, a write tool while writes are off, and another role's whole list", async () => {
    const withExtra = (name: string) => [...SAFE_TOOLS, ...business("lead_hunter"), { name: `mcp__${HERMES_BUSINESS_MCP_SERVER}__${name}`, toolset: HERMES_BUSINESS_MCP_TOOLSET, source: "mcp" as const, sourceServer: HERMES_BUSINESS_MCP_SERVER }];
    for (const name of ["shell_exec", "update_contact", "crm_summary_report", "create_task"]) {
      set({ tools: withExtra(name), enabledToolsets: [...SAFE_TOOLSETS, HERMES_BUSINESS_MCP_TOOLSET] });
      const error = await failure(verifyToolInventory(conn()));
      expect(error.detail.code, name).toBe("inventory_unsafe");
      expect(error.message).toContain(name);
    }
    set({ tools: [...SAFE_TOOLS, ...business("crm_manager")], enabledToolsets: [...SAFE_TOOLSETS, HERMES_BUSINESS_MCP_TOOLSET] });
    expect((await failure(verifyToolInventory(conn("lead_hunter")))).detail.code).toBe("inventory_unsafe");
  });

  it("refuses a missing business tool, and a business tool the gateway cannot currently reach", async () => {
    const tools = business("lead_hunter");
    set({ tools: [...SAFE_TOOLS, ...tools.slice(1)], enabledToolsets: [...SAFE_TOOLSETS, HERMES_BUSINESS_MCP_TOOLSET] });
    expect((await failure(verifyToolInventory(conn()))).detail.code).toBe("inventory_incomplete");
    set({ tools: [...SAFE_TOOLS, ...tools.map((tool, i) => (i === 0 ? { ...tool, available: false } : tool))], enabledToolsets: [...SAFE_TOOLSETS, HERMES_BUSINESS_MCP_TOOLSET] });
    expect((await failure(verifyToolInventory(conn()))).detail.code).toBe("inventory_incomplete");
  });

  it("refuses a business tool reported from the wrong server, the wrong toolset, or a source that is not MCP", async () => {
    const tools = business("lead_hunter");
    const variants: Array<[string, Partial<MockInventoryTool>]> = [
      ["server", { sourceServer: "another_server" }],
      ["toolset", { toolset: "memory" }],
      ["source", { source: "configurable", sourceServer: null }],
    ];
    for (const [label, change] of variants) {
      set({ tools: [...SAFE_TOOLS, ...tools.map((tool, i) => (i === 0 ? { ...tool, ...change } : tool))], enabledToolsets: [...SAFE_TOOLSETS, HERMES_BUSINESS_MCP_TOOLSET] });
      await failure(verifyToolInventory(conn())).catch((error: unknown) => { throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`); });
    }
  });

  it("refuses an incomplete catalog and an empty one, however many business tools it lists", async () => {
    set({ tools: [...SAFE_TOOLS, ...business("lead_hunter")], enabledToolsets: [...SAFE_TOOLSETS, HERMES_BUSINESS_MCP_TOOLSET], complete: false, incompleteReason: "MCP server 'iacquire_business' is enabled but has never completed tool discovery" });
    expect((await failure(verifyToolInventory(conn()))).detail.code).toBe("inventory_incomplete");
    set({ tools: [], enabledToolsets: [...SAFE_TOOLSETS, HERMES_BUSINESS_MCP_TOOLSET] });
    expect((await failure(verifyToolInventory(conn()))).detail.code).toBe("inventory_incomplete");
  });

  it("refuses any MCP tool when the bridge is off", async () => {
    vi.stubEnv("HERMES_BUSINESS_MCP_ENABLED", "false");
    resetEnvCache();
    set({ tools: [...SAFE_TOOLS, ...business("lead_hunter")], enabledToolsets: [...SAFE_TOOLSETS, HERMES_BUSINESS_MCP_TOOLSET] });
    expect((await failure(verifyToolInventory(conn()))).detail.code).toBe("inventory_unsafe");
  });
});
