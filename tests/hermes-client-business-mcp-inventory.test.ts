// The inventory verifier for a CLIENT employee's profile on the business MCP path, against the mocked gateway, and the endpoint's own check of the recorded inventory before it accepts a turn.
// MOCKED: these tests pin the application's decisions (what it accepts and refuses when a client workspace is in the client tier) and are NOT evidence that a real Hermes reports what the
// mock reports; the internal tier's twin is tests/hermes-business-mcp-inventory.test.ts and the pinned runtime proof is tests/hermes-business-mcp-pinned-runtime.test.ts.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { requiredRuntimeToolsFor, RUNTIME_TOOL_ROLES, runtimeToolsetsFor } from "@/lib/employee-tool-policy";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { ToolInventoryError, verifyToolInventory } from "@/server/integrations/hermes/inventory";
import { businessMcpRuntimeNamesForRole, HERMES_BUSINESS_MCP_SERVER, HERMES_BUSINESS_MCP_TOOLSET } from "@/server/workforce/hermes-business-mcp-policy";
import { clientBusinessMcpRuntimeNamesForRole } from "@/server/workforce/hermes-client-business-mcp-policy";
import { startMockHermes, type MockHermes, type MockInventoryTool } from "./support/mock-hermes";
import { MCP_TEST_SECRET } from "./support/business-mcp";
import { callBody, endClientTurns, postClient, provisionedClient, recordBusinessInventory, refused, setClientTier, startClientTurn, toolText, type ClientTenant } from "./support/client-business-mcp";

const PROFILE = "c-inventory-client";
const KEY = "c".repeat(40);
// The suite runs the role tool policy in report mode (vitest.config.ts), so a client profile is held to the shared reviewed set unless a test turns enforcement on.
const SAFE_TOOLS: MockInventoryTool[] = [
  { name: "memory", toolset: "memory" },
  { name: "session_search", toolset: "session_search" },
  { name: "todo_list", toolset: "todo" },
  { name: "web_search", toolset: "web" },
  { name: "web_extract", toolset: "web" },
];
const SAFE_TOOLSETS = ["memory", "session_search", "todo", "vision", "web"];
const mcpRow = (name: string): MockInventoryTool => ({ name, toolset: HERMES_BUSINESS_MCP_TOOLSET, source: "mcp", sourceServer: HERMES_BUSINESS_MCP_SERVER });
const business = (role: AgentRoleKey, proposals = false): MockInventoryTool[] => clientBusinessMcpRuntimeNamesForRole(role, { proposals }).map(mcpRow);
const ON = { proposals: false } as const;

let mock: MockHermes;
const conn = (roleKey: AgentRoleKey = "crm_manager", clientBusinessTools: { proposals: boolean } | null | undefined = ON) => ({
  baseUrl: mock.url, profile: PROFILE, apiKey: KEY, orgKind: "client" as const, roleKey, ...(clientBusinessTools === undefined ? {} : { clientBusinessTools }),
});
const set = (inventory: Parameters<MockHermes["setInventory"]>[1]) => mock.setInventory(PROFILE, inventory);
const withBridge = (tools: MockInventoryTool[], extraToolsets: string[] = []) => ({ tools: [...SAFE_TOOLS, ...tools], enabledToolsets: [...SAFE_TOOLSETS, HERMES_BUSINESS_MCP_TOOLSET, ...extraToolsets] });

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
beforeEach(() => mock.setInventory(PROFILE, null));
afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

describe("the verifier for a client profile in the client tier", () => {
  it("accepts exactly the role's reviewed tools in the business toolset, with or without the server-name alias the real gateway adds, for each of the six roles", async () => {
    for (const role of AGENT_ROLE_KEYS) {
      set(withBridge(business(role)));
      const plain = await verifyToolInventory(conn(role), { stabilityReads: 2 });
      set(withBridge(business(role), [HERMES_BUSINESS_MCP_SERVER]));
      const aliased = await verifyToolInventory(conn(role), { stabilityReads: 2 });
      expect(plain.tools.filter((tool) => tool.source === "mcp").map((tool) => tool.name).sort(), role).toEqual(clientBusinessMcpRuntimeNamesForRole(role));
      expect(aliased.toolCount, role).toBe(plain.toolCount);
    }
  });

  it("accepts the role's change proposals only when the proposals phase is on, and then requires them", async () => {
    // crm_manager may propose changes (create_task and others); the performance analyst has none.
    const reads = business("crm_manager");
    const withProposals = business("crm_manager", true);
    expect(withProposals.length).toBeGreaterThan(reads.length);
    set(withBridge(withProposals));
    expect((await verifyToolInventory(conn("crm_manager", { proposals: true }), { stabilityReads: 2 })).toolCount).toBe(SAFE_TOOLS.length + withProposals.length);
    // Proposals off: a proposal tool in the profile is a write tool the phase does not allow.
    const off = await failure(verifyToolInventory(conn("crm_manager", { proposals: false })));
    expect(off.detail.code).toBe("inventory_unsafe");
    expect(off.message).toContain("create_task");
    // Proposals on: a profile that still lists the reads alone is missing what the phase requires.
    set(withBridge(reads));
    expect((await failure(verifyToolInventory(conn("crm_manager", { proposals: true })))).detail.code).toBe("inventory_incomplete");
    // A role without proposals has the same list either way.
    set(withBridge(business("performance_analyst")));
    expect((await verifyToolInventory(conn("performance_analyst", { proposals: true }))).toolCount).toBe(SAFE_TOOLS.length + business("performance_analyst").length);
  });

  it("refuses every MCP tool while the tier is off for the workspace (no switch, a null switch), exactly as before the tier existed", async () => {
    set(withBridge(business("crm_manager")));
    const { clientBusinessTools: _switch, ...withoutSwitch } = conn("crm_manager");
    expect("clientBusinessTools" in withoutSwitch).toBe(false);
    for (const off of [withoutSwitch, conn("crm_manager", null)]) {
      const error = await failure(verifyToolInventory(off));
      expect(error.detail.code).toBe("inventory_unsafe");
      expect(error.message).toContain(HERMES_BUSINESS_MCP_TOOLSET);
    }
    // And the alias is no excuse: with the tier off it is an unreviewed toolset.
    set({ tools: SAFE_TOOLS, enabledToolsets: [...SAFE_TOOLSETS, HERMES_BUSINESS_MCP_SERVER] });
    expect((await failure(verifyToolInventory(conn("crm_manager", null)))).detail.code).toBe("inventory_unsafe");
    // A profile with no MCP tool at all is fine with the tier off, as it always was.
    set({ tools: SAFE_TOOLS, enabledToolsets: SAFE_TOOLSETS });
    expect((await verifyToolInventory(conn("crm_manager", null))).toolCount).toBe(SAFE_TOOLS.length);
  });

  it("does not let a switch on a connection that is not a client's (an agency employee, a connection with no role) open the client list", async () => {
    set(withBridge(business("crm_manager")));
    const agency = { ...conn("crm_manager"), orgKind: "agency" as const };
    // The internal tier's own flag is off in this run, and its list is not the client list: the client switch changes nothing for an agency employee.
    expect((await failure(verifyToolInventory(agency))).detail.code).toBe("inventory_unsafe");
    const roleless = { baseUrl: mock.url, profile: PROFILE, apiKey: KEY, orgKind: "client" as const, clientBusinessTools: ON };
    expect((await failure(verifyToolInventory(roleless))).detail.code).toBe("inventory_unsafe");
  });

  it("refuses another role's list, a tool the role does not hold, a write tool while proposals are off, and a missing tool", async () => {
    // Another role's list: the appointment setter's tools are not the CRM manager's. (A shorter list that is a subset is a different failure, the next case.)
    set(withBridge(business("appointment_setter")));
    expect((await failure(verifyToolInventory(conn("crm_manager")))).detail.code).toBe("inventory_unsafe");
    for (const name of ["shell_exec", "update_contact", "create_task", "request_appointment", "prepare_message", "request_send_approval"]) {
      set(withBridge([...business("crm_manager"), mcpRow(`mcp__${HERMES_BUSINESS_MCP_SERVER}__${name}`)]));
      const error = await failure(verifyToolInventory(conn("crm_manager")));
      expect(error.detail.code, name).toBe("inventory_unsafe");
      expect(error.message).toContain(name);
    }
    // The tools a client is never offered are refused even with the proposals phase on.
    for (const name of ["request_appointment", "prepare_message", "request_send_approval"]) {
      set(withBridge([...business("crm_manager", true), mcpRow(`mcp__${HERMES_BUSINESS_MCP_SERVER}__${name}`)]));
      expect((await failure(verifyToolInventory(conn("crm_manager", { proposals: true })))).detail.code, name).toBe("inventory_unsafe");
    }
    set(withBridge(business("crm_manager").slice(1)));
    expect((await failure(verifyToolInventory(conn("crm_manager")))).detail.code).toBe("inventory_incomplete");
  });

  it("refuses a business tool reported from the wrong server, the wrong toolset or a source that is not MCP, and one the gateway cannot reach", async () => {
    const tools = business("crm_manager");
    const variants: Array<[string, Partial<MockInventoryTool>, string]> = [
      ["server", { sourceServer: "another_server" }, "inventory_unsafe"],
      ["toolset", { toolset: "memory" }, "inventory_unsafe"],
      ["source", { source: "configurable", sourceServer: null }, "inventory_unsafe"],
      ["unreachable", { available: false }, "inventory_incomplete"],
    ];
    for (const [label, change, code] of variants) {
      set(withBridge(tools.map((tool, index) => (index === 0 ? { ...tool, ...change } : tool))));
      expect((await failure(verifyToolInventory(conn("crm_manager")))).detail.code, label).toBe(code);
    }
    // Another server's toolset next to the reviewed one is an unreviewed toolset.
    set(withBridge(tools, ["mcp-other_server"]));
    expect((await failure(verifyToolInventory(conn("crm_manager")))).detail.code).toBe("inventory_unsafe");
  });

  it("gives inventory_changed when the digest recorded by the last check no longer matches, and when two reads disagree", async () => {
    set(withBridge(business("crm_manager")));
    const first = await verifyToolInventory(conn("crm_manager"), { stabilityReads: 2 });
    expect(await verifyToolInventory(conn("crm_manager"), { expectedDigest: first.digest, purpose: "run" })).toMatchObject({ digest: first.digest });
    // The profile gains an optional reviewed tool: the digest differs from the recorded one.
    set({ tools: [...SAFE_TOOLS, { name: "vision_analyze", toolset: "vision" }, ...business("crm_manager")], enabledToolsets: [...SAFE_TOOLSETS, HERMES_BUSINESS_MCP_TOOLSET] });
    const changed = await failure(verifyToolInventory(conn("crm_manager"), { expectedDigest: first.digest, purpose: "run" }));
    expect(changed.detail.code).toBe("inventory_changed");
    expect(changed.detail.observedDigest).not.toBe(first.digest);
    // Two consecutive reads that disagree are refused too.
    set({ ...withBridge(business("crm_manager")), changeAfterFirstRead: [...SAFE_TOOLS, { name: "vision_analyze", toolset: "vision" }, ...business("crm_manager")] });
    expect((await failure(verifyToolInventory(conn("crm_manager"), { stabilityReads: 2 }))).detail.code).toBe("inventory_changed");
  });

  it("holds a client profile to its role's own toolsets as well when the role policy is enforced", async () => {
    vi.stubEnv("WORKFORCE_ROLE_TOOL_ENFORCEMENT", "enforce");
    const role: AgentRoleKey = "appointment_setter";
    const own = requiredRuntimeToolsFor(role).map((name) => ({ name, toolset: RUNTIME_TOOL_ROLES[name].toolset }));
    const enabledToolsets = [...runtimeToolsetsFor(role), HERMES_BUSINESS_MCP_TOOLSET];
    set({ tools: [...own, ...business(role)], enabledToolsets });
    expect((await verifyToolInventory(conn(role))).toolCount).toBe(own.length + business(role).length);
    // The Lead Hunter's research tools do not belong to this role even when the business list is right.
    set({ tools: [...own, ...SAFE_TOOLS.filter((tool) => tool.name.startsWith("web_")), ...business(role)], enabledToolsets: [...enabledToolsets, "web"] });
    expect((await failure(verifyToolInventory(conn(role)))).detail.code).toBe("inventory_unsafe");
  });

  it("leaves the internal tier exactly as it was: its own list, its own flag", async () => {
    vi.stubEnv("HERMES_BUSINESS_MCP_ENABLED", "true");
    vi.stubEnv("HERMES_BUSINESS_MCP_WRITES_ENABLED", "false");
    vi.stubEnv("HERMES_BUSINESS_MCP_SECRET", MCP_TEST_SECRET);
    resetEnvCache();
    const internal = (role: AgentRoleKey): MockInventoryTool[] => businessMcpRuntimeNamesForRole(role, false).map(mcpRow);
    set(withBridge(internal("lead_hunter")));
    const agency = { baseUrl: mock.url, profile: PROFILE, apiKey: KEY, orgKind: "agency" as const, roleKey: "lead_hunter" as const };
    expect((await verifyToolInventory(agency)).toolCount).toBe(SAFE_TOOLS.length + internal("lead_hunter").length);
    // A client switch on an agency connection does not change its list.
    expect((await verifyToolInventory({ ...agency, clientBusinessTools: ON })).toolCount).toBe(SAFE_TOOLS.length + internal("lead_hunter").length);
  });
});

// ---------------------------------------------------------------------------
// The endpoint's own check: a turn is accepted only against a recorded inventory with exactly the role's tools.
// ---------------------------------------------------------------------------

let tenants: { a: ClientTenant; b: ClientTenant } | null = null;
beforeAll(async () => {
  tenants = {
    a: await provisionedClient({ name: "Inventory Roofing", timezone: "America/Chicago", tag: "Inventoried", phone: "+13125550141", crm: false }),
    b: await provisionedClient({ name: "Inventory Dental", timezone: "Asia/Manila", tag: "Inventoryb", phone: "+639171234541", crm: false }),
  };
}, 240_000);

const readContext = (t: ClientTenant, role: AgentRoleKey) => postClient(t.credentials[role], callBody("get_role_workspace_context"));

/** Records an inventory snapshot for the length of one check and puts the fixture's own back. */
async function withSnapshot<T>(t: ClientTenant, role: AgentRoleKey, snapshot: unknown, run: () => Promise<T>): Promise<T> {
  const id = t.agents[role];
  const before = (await withSystem((db) => db.query<{ s: unknown }>("select tool_inventory_snapshot as s from agent_instances where id = $1", [id]))).rows[0].s;
  await withSystem((db) => db.query("update agent_instances set tool_inventory_snapshot = $2::jsonb where id = $1", [id, JSON.stringify(snapshot)]));
  try {
    return await run();
  } finally {
    await withSystem((db) => db.query("update agent_instances set tool_inventory_snapshot = $2::jsonb where id = $1", [id, JSON.stringify(before)]));
  }
}

describe("a turn is accepted only against the recorded inventory of exactly the role's tools", () => {
  beforeEach(() => setClientTier(true));
  afterEach(async () => {
    if (tenants) for (const t of [tenants.a, tenants.b]) for (const role of AGENT_ROLE_KEYS) await endClientTurns(t, role);
  });

  const snapshotOf = (tools: MockInventoryTool[]) => ({ tools: tools.map((tool) => ({ name: tool.name, toolset: tool.toolset ?? "", source: tool.source ?? "configurable", sourceServer: tool.sourceServer ?? null, available: true })) });

  it("answers a read when the recorded inventory holds the role's reads, and also when it holds its reads and proposals", async () => {
    const { a } = tenants!;
    await startClientTurn(a, "crm_manager", a.owner.id);
    expect(refused(await readContext(a, "crm_manager"))).toBe(false);
    await recordBusinessInventory(a.agents.crm_manager, "crm_manager", true);
    expect(refused(await readContext(a, "crm_manager"))).toBe(false);
    await recordBusinessInventory(a.agents.crm_manager, "crm_manager", false);
    expect(refused(await readContext(a, "crm_manager"))).toBe(false);
  });

  it("refuses the turn for a profile that was verified before the tier was on (no business tools recorded), an empty record, or one that only lists native tools", async () => {
    const { a } = tenants!;
    await startClientTurn(a, "crm_manager", a.owner.id);
    for (const [label, snapshot] of [["empty", {}], ["native tools only", snapshotOf(SAFE_TOOLS)], ["not a list", { tools: "none" }]] as const) {
      await withSnapshot(a, "crm_manager", snapshot, async () => {
        const read = await readContext(a, "crm_manager");
        expect(refused(read), label).toBe(true);
        expect(toolText(read), label).toContain("active, authenticated Chat turn");
        const call = await postClient(a.credentials.crm_manager, callBody("find_contacts", { query: "anyone" }));
        expect(refused(call), label).toBe(true);
        expect(toolText(call), label).toContain("active, authenticated Chat turn");
      });
    }
    expect(refused(await readContext(a, "crm_manager"))).toBe(false);
  });

  it("refuses another role's list, an extra tool, a missing tool, and a tool from the wrong server, toolset or source", async () => {
    const { a } = tenants!;
    await startClientTurn(a, "lead_hunter", a.owner.id);
    const own = business("lead_hunter");
    const cases: Array<[string, MockInventoryTool[]]> = [
      ["another role's list", business("performance_analyst")],
      ["an extra tool", [...own, mcpRow(`mcp__${HERMES_BUSINESS_MCP_SERVER}__crm_summary_report`)]],
      ["an unreviewed write", [...own, mcpRow(`mcp__${HERMES_BUSINESS_MCP_SERVER}__update_contact`)]],
      ["a missing tool", own.slice(1)],
      ["the wrong server", own.map((tool, index) => (index === 0 ? { ...tool, sourceServer: "another_server" } : tool))],
      ["the wrong toolset", own.map((tool, index) => (index === 0 ? { ...tool, toolset: "memory" } : tool))],
      ["a source that is not MCP", own.map((tool, index) => (index === 0 ? { ...tool, source: "configurable" as const, sourceServer: null } : tool))],
      ["a second server's tool next to the reviewed ones", [...own, { name: "mcp__other__thing", toolset: "mcp-other", source: "mcp", sourceServer: "other" }]],
    ];
    for (const [label, tools] of cases) {
      await withSnapshot(a, "lead_hunter", snapshotOf([...SAFE_TOOLS, ...tools]), async () => {
        expect(refused(await readContext(a, "lead_hunter")), label).toBe(true);
      });
    }
    expect(refused(await readContext(a, "lead_hunter"))).toBe(false);
  });

  it("is per employee: one employee's unrecorded inventory does not stop another employee, or another workspace", async () => {
    const { a, b } = tenants!;
    await startClientTurn(a, "crm_manager", a.owner.id);
    await startClientTurn(a, "performance_analyst", a.owner.id);
    await startClientTurn(b, "crm_manager", b.owner.id);
    await withSnapshot(a, "crm_manager", {}, async () => {
      expect(refused(await readContext(a, "crm_manager"))).toBe(true);
      expect(refused(await readContext(a, "performance_analyst"))).toBe(false);
      expect(refused(await readContext(b, "crm_manager"))).toBe(false);
    });
  });
});
