// The documented activation sequence must be enforced by code, in order:
//   1. apply an initial configuration (no health check can make an unconfigured employee online);
//   2. run the health check (online + recorded inventory digest);
//   3. run the profile check, then the Super Admin acknowledgement;
//   4. only then does a run pass the gate.
// A later profile check invalidates the acknowledgement again. Every refusal happens before /v1/runs.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AGENCY_HERMES_PROFILE_IDS } from "@/lib/agents";
import { withSystem } from "@/server/db";
import { AgentRunNotReadyError, startAgentRun } from "@/server/integrations/hermes/client";
import { saveIntegrationConnection } from "@/server/integrations/manager";
import { agencyUser, createUser } from "./support/fixtures";
import { startMockHermes, type MockHermes } from "./support/mock-hermes";
import { defaultSettings } from "@/server/workforce/compiler";
import {
  connectAgencyHermesProfile,
  testAgencyHermesProfile,
} from "@/server/workforce/agency";
import { ensureAgencyWorkforceRegistry } from "@/server/workforce/agency-registry";
import { acknowledgeInternalFullCapabilities } from "@/server/workforce/tool-policies";
import { createConfigVersion, runHealthCheck } from "@/server/workforce/service";

const KEY = "s".repeat(40);
const PROFILE = AGENCY_HERMES_PROFILE_IDS.sales_assistant;

let mock: MockHermes;
let admin: ReturnType<typeof agencyUser>;
let agencyOrgId: string;
let agentId: string;

const connection = () => ({ baseUrl: mock.url, profile: PROFILE, apiKey: KEY });
const runAttempt = () => startAgentRun(agentId, agencyOrgId, connection(), {
  input: "activation sequence check",
  idempotencyKey: `activation-${crypto.randomUUID()}`,
});
const runsSent = () => mock.requests.filter((request) => request.path === "/v1/runs").length;

beforeAll(async () => {
  mock = await startMockHermes({ [PROFILE]: { key: KEY } });
  admin = agencyUser(await createUser({ platformRole: "agency_super_admin" }), "agency_super_admin");
  agencyOrgId = await ensureAgencyWorkforceRegistry(admin);
  const gatewayId = await saveIntegrationConnection(admin, null, {
    provider: "hermes",
    label: "Synthetic activation-sequence gateway",
    environment: "development",
    config: { baseUrl: mock.url, gatewayType: "multiplexed_profiles" },
  }) as string;
  agentId = (await withSystem((db) => db.query<{ id: string }>(
    "select id from agent_instances where org_id=$1 and role_key='sales_assistant'",
    [agencyOrgId],
  ))).rows[0].id;
  const mapped = await connectAgencyHermesProfile(admin, {
    agentId,
    gatewayId,
    profile: PROFILE,
    apiKey: KEY,
    confirmedExistingProfile: true,
  });
  expect(mapped).toMatchObject({ status: "verified", identityVerified: true, apiContractVerified: true });
}, 60000);

afterAll(() => mock.close());

describe("the documented activation sequence", () => {
  it("cannot go online before a configuration is applied", async () => {
    const health = await runHealthCheck(agentId, { userId: admin.id, kind: "agency" });
    expect(health).toMatchObject({ ok: false, status: "setup_required" });
    expect(health.detail).toMatch(/configuration hasn't been applied/);
    const { rows } = await withSystem((db) => db.query<{ status: string; active_config_version_id: string | null }>(
      "select status, active_config_version_id from agent_instances where id=$1",
      [agentId],
    ));
    expect(rows[0]).toMatchObject({ status: "setup_required", active_config_version_id: null });

    // Applying the initial configuration makes it eligible, but it still has not passed a health check.
    await withSystem((db) => createConfigVersion(db, {
      orgId: agencyOrgId,
      agentId,
      settings: defaultSettings("sales_assistant"),
      source: "agency",
      userId: admin.id,
      apply: true,
    }));
    const runsBefore = runsSent();
    await expect(runAttempt()).rejects.toBeInstanceOf(AgentRunNotReadyError);
    await expect(runAttempt()).rejects.toThrow(/hasn't passed its connection and tool-inventory check/);
    expect(runsSent()).toBe(runsBefore);
  });

  it("goes online only after the health check records a verified inventory digest", async () => {
    const health = await runHealthCheck(agentId, { userId: admin.id, kind: "agency" });
    expect(health).toMatchObject({ ok: true, status: "online" });
    const { rows } = await withSystem((db) => db.query<{ status: string; active_config_version_id: string | null; tool_inventory_digest: string | null }>(
      "select status, active_config_version_id, tool_inventory_digest from agent_instances where id=$1",
      [agentId],
    ));
    expect(rows[0].status).toBe("online");
    expect(rows[0].active_config_version_id).toBeTruthy();
    expect(rows[0].tool_inventory_digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("still refuses a run until the profile check and Super Admin acknowledgement are current", async () => {
    const runsBefore = runsSent();
    await expect(runAttempt()).rejects.toThrow(/current Hermes identity, API contract and permission verification/);
    expect(runsSent()).toBe(runsBefore);

    await testAgencyHermesProfile(admin, agentId);
    const activeConfigVersionId = (await withSystem((db) => db.query<{ active_config_version_id: string }>(
      "select active_config_version_id from agent_instances where id=$1",
      [agentId],
    ))).rows[0].active_config_version_id;
    await acknowledgeInternalFullCapabilities(admin, [{ agentId, expectedActiveConfigVersionId: activeConfigVersionId }]);
    await expect(runAttempt()).resolves.toMatchObject({ runId: expect.stringMatching(/^run_/) });
    expect(runsSent()).toBe(runsBefore + 1);
  });

  it("invalidates the acknowledgement after a new profile check and blocks the next run", async () => {
    await testAgencyHermesProfile(admin, agentId);
    const runsBefore = runsSent();
    await expect(runAttempt()).rejects.toThrow(/Super Admin acknowledgement for its current identity/);
    expect(runsSent()).toBe(runsBefore);
  });
});
