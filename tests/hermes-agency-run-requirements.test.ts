// An internal agency employee may start a run only while EVERY requirement holds. Starting from a fully activated
// employee, each requirement is removed on its own: the run must be refused, no POST /v1/runs may be sent, and putting
// the requirement back must restore the employee. (The activation order itself is covered by
// hermes-activation-sequence.test.ts; this proves each requirement is independently load-bearing.)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AGENCY_HERMES_PROFILE_IDS } from "@/lib/agents";
import { withSystem } from "@/server/db";
import { startAgentRun, type HermesConnection } from "@/server/integrations/hermes/client";
import { ToolInventoryError } from "@/server/integrations/hermes/inventory";
import { saveIntegrationConnection } from "@/server/integrations/manager";
import { connectAgencyHermesProfile, testAgencyHermesProfile } from "@/server/workforce/agency";
import { ensureAgencyWorkforceRegistry } from "@/server/workforce/agency-registry";
import { defaultSettings } from "@/server/workforce/compiler";
import { createConfigVersion, loadConnection, runHealthCheck } from "@/server/workforce/service";
import { acknowledgeInternalFullCapabilities } from "@/server/workforce/tool-policies";
import { agencyUser, createOrg, createUser } from "./support/fixtures";
import { startMockHermes, type MockHermes, type MockInventoryTool } from "./support/mock-hermes";

const KEY = "r".repeat(40);
const PROFILE = AGENCY_HERMES_PROFILE_IDS.operations_manager;
const SAFE_TOOLS: MockInventoryTool[] = [
  { name: "memory", toolset: "memory" },
  { name: "session_search", toolset: "session_search" },
  { name: "todo_list", toolset: "todo" },
  { name: "vision_analyze", toolset: "vision" },
  { name: "web_search", toolset: "web" },
  { name: "web_extract", toolset: "web" },
];

let mock: MockHermes;
let admin: ReturnType<typeof agencyUser>;
let agencyOrgId: string;
let clientOrgId: string;
let agentId: string;
let configVersionId: string;
let digest: string;

const sql = (text: string, params: unknown[] = []) => withSystem((db) => db.query(text, params));
const runsSent = () => mock.requests.filter((request) => request.path === "/v1/runs").length;
let heldConnection: HermesConnection | null = null;
const attempt = async (orgId = agencyOrgId) => {
  const conn = heldConnection ?? (await withSystem((db) => loadConnection(db, agentId)))!;
  return startAgentRun(agentId, orgId, conn, { input: "requirement matrix probe", idempotencyKey: `matrix-${crypto.randomUUID()}` });
};
const acknowledge = async () => {
  await testAgencyHermesProfile(admin, agentId);
  const activeConfigVersionId = (await sql("select active_config_version_id from agent_instances where id=$1", [agentId])).rows[0].active_config_version_id as string;
  await acknowledgeInternalFullCapabilities(admin, [{ agentId, expectedActiveConfigVersionId: activeConfigVersionId }]);
};

/** Removes one requirement, proves the run is refused with nothing sent to /v1/runs, then restores it. */
async function without(remove: () => Promise<void>, restore: () => Promise<void>, refusal: RegExp | ((err: unknown) => void), options: { gatewayUntouched?: boolean } = {}) {
  const runsBefore = runsSent();
  const requestsBefore = mock.requests.length;
  await remove();
  try {
    const err = await attempt().then(() => null, (e: unknown) => e);
    expect(err, "the run must be refused").not.toBeNull();
    if (typeof refusal === "function") refusal(err);
    else expect((err as Error).message).toMatch(refusal);
    expect(runsSent()).toBe(runsBefore);
    if (options.gatewayUntouched) expect(mock.requests).toHaveLength(requestsBefore);
    else expect(mock.requests.slice(requestsBefore).every((request) => request.method === "GET")).toBe(true);
  } finally {
    await restore();
  }
}

beforeAll(async () => {
  mock = await startMockHermes({ [PROFILE]: { key: KEY } });
  admin = agencyUser(await createUser({ platformRole: "agency_super_admin" }), "agency_super_admin");
  clientOrgId = (await createOrg({ name: "Requirement Matrix Client" })).id;
  agencyOrgId = await ensureAgencyWorkforceRegistry(admin);
  const gatewayId = await saveIntegrationConnection(admin, null, {
    provider: "hermes",
    label: "Synthetic requirement-matrix gateway",
    environment: "development",
    config: { baseUrl: mock.url, gatewayType: "multiplexed_profiles" },
  }) as string;
  agentId = (await sql("select id from agent_instances where org_id=$1 and role_key='operations_manager'", [agencyOrgId])).rows[0].id as string;
  await connectAgencyHermesProfile(admin, { agentId, gatewayId, profile: PROFILE, apiKey: KEY, confirmedExistingProfile: true });
  await withSystem((db) => createConfigVersion(db, { orgId: agencyOrgId, agentId, settings: defaultSettings("operations_manager"), source: "agency", userId: admin.id, apply: true }));
  expect(await runHealthCheck(agentId, { userId: admin.id, kind: "agency" })).toMatchObject({ ok: true, status: "online" });
  await acknowledge();
  const row = (await sql("select active_config_version_id as config, tool_inventory_digest as digest from agent_instances where id=$1", [agentId])).rows[0] as { config: string; digest: string };
  configVersionId = row.config;
  digest = row.digest;
}, 60000);
afterAll(() => mock.close());

describe("a fully activated internal employee", () => {
  it("runs (against the mock gateway) only because every requirement holds", async () => {
    const before = runsSent();
    await expect(attempt()).resolves.toMatchObject({ runId: expect.stringMatching(/^run_/) });
    expect(runsSent()).toBe(before + 1);
  });

  it("is refused when it is disabled", () =>
    without(
      async () => void (await sql("update agent_instances set enabled=false where id=$1", [agentId])),
      async () => void (await sql("update agent_instances set enabled=true where id=$1", [agentId])),
      /isn't enabled/,
      { gatewayUntouched: true },
    ));

  it("is refused when it is not online", () =>
    without(
      async () => void (await sql("update agent_instances set status='provisioning' where id=$1", [agentId])),
      async () => void (await sql("update agent_instances set status='online' where id=$1", [agentId])),
      /hasn't passed its connection and tool-inventory check/,
      { gatewayUntouched: true },
    ));

  it("is refused without an applied configuration", () =>
    without(
      async () => void (await sql("update agent_instances set active_config_version_id=null where id=$1", [agentId])),
      async () => void (await sql("update agent_instances set active_config_version_id=$2 where id=$1", [agentId, configVersionId])),
      /no applied configuration/,
      { gatewayUntouched: true },
    ));

  it("is refused without a recorded inventory digest", () =>
    without(
      async () => void (await sql("update agent_instances set tool_inventory_digest=null where id=$1", [agentId])),
      async () => void (await sql("update agent_instances set tool_inventory_digest=$2 where id=$1", [agentId, digest])),
      /no verified tool inventory on record/,
      { gatewayUntouched: true },
    ));

  it("is refused when it is presented under another workspace", async () => {
    const requestsBefore = mock.requests.length;
    await expect(attempt(clientOrgId)).rejects.toMatchObject({ kind: "not_found" });
    expect(mock.requests).toHaveLength(requestsBefore);
  });

  it("is refused without the Super Admin acknowledgement", () =>
    without(
      async () => void (await sql("delete from hermes_tool_policy_acknowledgements where agent_id=$1", [agentId])),
      acknowledge,
      /Super Admin acknowledgement for its current identity/,
      { gatewayUntouched: true },
    ));

  it("is refused when its identity check is not verified", () =>
    without(
      async () => void (await sql("update agency_hermes_profile_checks set status='identity_mismatch', identity_verified=false, api_contract_verified=false, verified_at=null where agent_instance_id=$1", [agentId])),
      acknowledge,
      /current Hermes identity, API contract and permission verification/,
      { gatewayUntouched: true },
    ));

  it("is refused when the credential it holds is no longer the saved, unrevoked one", () =>
    without(
      async () => {
        // A connection built before the revocation (an in-flight caller) must not outlive it.
        heldConnection = (await withSystem((db) => loadConnection(db, agentId)))!;
        await sql("update integration_credentials set revoked_at=now() where id=(select credential_id from agent_instances where id=$1)", [agentId]);
      },
      async () => {
        heldConnection = null;
        await sql("update integration_credentials set revoked_at=null where id=(select credential_id from agent_instances where id=$1)", [agentId]);
      },
      /saved Hermes credential is missing or revoked/,
      { gatewayUntouched: true },
    ));

  it("is refused when the key it presents is not the saved one", () =>
    without(
      async () => {
        heldConnection = { ...(await withSystem((db) => loadConnection(db, agentId)))!, apiKey: "rotated-but-unsaved-synthetic-key-012345" };
      },
      async () => void (heldConnection = null),
      /current identity check and Super Admin full-capabilities acknowledgement/,
      { gatewayUntouched: true },
    ));

  it("is refused when the live inventory drifts from the recorded digest", () =>
    without(
      async () => mock.setInventory(PROFILE, { tools: SAFE_TOOLS.filter((tool) => tool.name !== "vision_analyze") }),
      async () => mock.setInventory(PROFILE, null),
      (err) => {
        expect(err).toBeInstanceOf(ToolInventoryError);
        expect((err as ToolInventoryError).detail.code).toBe("inventory_changed");
      },
    ));

  it("is refused when the live catalog exposes an unreviewed tool", () =>
    without(
      async () => mock.setInventory(PROFILE, { tools: [...SAFE_TOOLS, { name: "terminal", toolset: "terminal" }], enabledToolsets: ["memory", "session_search", "todo", "vision", "web", "terminal"] }),
      async () => mock.setInventory(PROFILE, null),
      (err) => {
        expect(err).toBeInstanceOf(ToolInventoryError);
        expect((err as ToolInventoryError).detail.code).toBe("inventory_unsafe");
      },
    ));

  it("runs again once every requirement is back", async () => {
    const before = runsSent();
    await expect(attempt()).resolves.toMatchObject({ runId: expect.stringMatching(/^run_/) });
    expect(runsSent()).toBe(before + 1);
  });
});
