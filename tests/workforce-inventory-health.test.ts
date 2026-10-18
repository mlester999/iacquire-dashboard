import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { createConfigVersion, connectHermesProfile, runHealthCheck } from "@/server/workforce/service";
import { defaultSettings } from "@/server/workforce/compiler";
import { addMember, agentId, createOrg, createUser } from "./support/fixtures";
import { startMockHermes, type MockHermes, type MockInventoryTool } from "./support/mock-hermes";

const KEY = "h".repeat(40);
const PROFILE = "c-health-inventory-sales-assistant";
const SAFE_TOOLS: MockInventoryTool[] = [
  { name: "memory", toolset: "memory" },
  { name: "session_search", toolset: "session_search" },
  { name: "todo_list", toolset: "todo" },
  { name: "vision_analyze", toolset: "vision" },
  { name: "web_search", toolset: "web" },
  { name: "web_extract", toolset: "web" },
];

let mock: MockHermes;
let org: Awaited<ReturnType<typeof createOrg>>;
let owner: { id: string };
let admin: { id: string };
let sales: string;

beforeAll(async () => {
  mock = await startMockHermes({ [PROFILE]: { key: KEY } });
  org = await createOrg({ name: "Inventory Health Co" });
  owner = await createUser();
  admin = await createUser({ platformRole: "agency_super_admin" });
  await addMember(org.id, owner.id, "owner");
  sales = await agentId(org.id, "sales_assistant");
  await withSystem((db) =>
    createConfigVersion(db, { orgId: org.id, agentId: sales, settings: defaultSettings("sales_assistant"), source: "onboarding", userId: owner.id, apply: true }),
  );
});
afterAll(() => mock.close());

describe("health check and persisted inventory attestation", () => {
  it("records a verified inventory and only goes online after it passes", async () => {
    await connectHermesProfile({ agentId: sales, baseUrl: mock.url, profile: PROFILE, apiKey: KEY, agencyUserId: admin.id });
    const result = await runHealthCheck(sales, { userId: admin.id, kind: "agency" });
    expect(result).toMatchObject({ ok: true, status: "online" });
    expect(result.detail).toMatch(/complete runtime tool inventory verified/);
    const { rows } = await withSystem((db) =>
      db.query<{ last_health_ok: boolean; tool_inventory_contract: string; tool_inventory_digest: string; tool_inventory_tool_count: number; tool_inventory_expires_at: Date }>(
        "select last_health_ok, tool_inventory_contract, tool_inventory_digest, tool_inventory_tool_count, tool_inventory_expires_at from agent_instances where id = $1",
        [sales],
      ),
    );
    expect(rows[0]).toMatchObject({ last_health_ok: true, tool_inventory_contract: "hermes.api_server.tool_catalog.v1", tool_inventory_tool_count: 6 });
    expect(rows[0].tool_inventory_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(new Date(rows[0].tool_inventory_expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("requires one confirmation health check after the inventory changes", async () => {
    mock.setInventory(PROFILE, { tools: [...SAFE_TOOLS, { name: "clarify", toolset: "web" }] });
    const changed = await runHealthCheck(sales, { userId: admin.id, kind: "agency" });
    expect(changed).toMatchObject({ ok: false, status: "provisioning" });
    expect(changed.detail).toMatch(/no longer matches the last verified check/);
    expect(changed.detail).toMatch(/run the health check again/);

    const confirmed = await runHealthCheck(sales, { userId: admin.id, kind: "agency" });
    expect(confirmed).toMatchObject({ ok: true, status: "online" });
  });

  it("clears readiness and reports an unsafe inventory", async () => {
    mock.setInventory(PROFILE, { tools: [...SAFE_TOOLS, { name: "terminal", toolset: "terminal" }] });
    const result = await runHealthCheck(sales, { userId: admin.id, kind: "agency" });
    expect(result).toMatchObject({ ok: false, status: "error" });
    expect(result.detail).toMatch(/unreviewed toolsets|outside the reviewed client allowlist/);
    const { rows } = await withSystem((db) =>
      db.query<{ last_health_ok: boolean; tool_inventory_contract: string | null; tool_inventory_digest: string | null; tool_inventory_detail: string }>(
        "select last_health_ok, tool_inventory_contract, tool_inventory_digest, tool_inventory_detail from agent_instances where id = $1",
        [sales],
      ),
    );
    expect(rows[0].last_health_ok).toBe(false);
    expect(rows[0].tool_inventory_contract).toBeNull();
    expect(rows[0].tool_inventory_digest).toBeNull();
    expect(rows[0].tool_inventory_detail).toMatch(/unreviewed toolsets/);
  });

  it("reports an unavailable inventory service without claiming readiness", async () => {
    mock.setInventory(PROFILE, { status: 503 });
    const result = await runHealthCheck(sales, { userId: admin.id, kind: "agency" });
    expect(result).toMatchObject({ ok: false, status: "offline" });
    expect(result.detail).toMatch(/complete tool inventory could not be read/);
    const { rows } = await withSystem((db) => db.query<{ last_health_ok: boolean }>("select last_health_ok from agent_instances where id = $1", [sales]));
    expect(rows[0].last_health_ok).toBe(false);
  });
});
