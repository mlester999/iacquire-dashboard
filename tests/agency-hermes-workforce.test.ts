import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AGENT_ROLE_KEYS, AGENCY_HERMES_PROFILE_IDS } from "@/lib/agents";
import { permissionsFor, roleHasPermission } from "@/lib/permissions";
import { withServiceRole, withSystem } from "@/server/db";
import { listAgencyAgents, listAllAgents } from "@/server/admin/queries";
import { updateAgencyUserPermission } from "@/server/admin/team";
import {
  connectAgencyHermesProfile,
  getAgencyProfileHistory,
  reviewAgencyHermesToolPermissions,
  testAgencyHermesProfile,
  testAllAgencyHermesProfiles,
} from "@/server/workforce/agency";
import { ensureAgencyWorkforceRegistry, listClientWorkforceSummaries } from "@/server/workforce/agency-registry";
import { listIntegrationManager, saveIntegrationConnection, testIntegrationConnection } from "@/server/integrations/manager";
import { connectHermesProfile, createConfigVersion, runHealthCheck } from "@/server/workforce/service";
import { defaultSettings } from "@/server/workforce/compiler";
import { listHermesGateways } from "@/server/integrations/hermes/gateways";
import { acknowledgeInternalFullCapabilities, getHermesToolPolicyView } from "@/server/workforce/tool-policies";
import { AgentRunNotReadyError, startAgentRun } from "@/server/integrations/hermes/client";
import { sendChatMessage } from "@/server/chat/service";
import type { OrgContext } from "@/server/tenancy/context";
import { addMember, agencyUser, agentId, createOrg, createUser } from "./support/fixtures";
import { startMockHermes, type MockHermes } from "./support/mock-hermes";

const PROFILE_KEYS = Object.fromEntries(AGENT_ROLE_KEYS.map((role) => [AGENCY_HERMES_PROFILE_IDS[role], `synthetic-${role}-profile-key-0123456789`])) as Record<string, string>;
const CLIENT_TEST_PROFILE = "client-test-profile";
const CLIENT_TEST_KEY = "synthetic-client-profile-key-012345";
let mock: MockHermes;
let admin: ReturnType<typeof agencyUser>;
let staff: ReturnType<typeof agencyUser>;
let agencyOrgId: string;
let clientOrg: Awaited<ReturnType<typeof createOrg>>;
let otherClientOrg: Awaited<ReturnType<typeof createOrg>>;
let salesAgentId: string;
let gatewayId: string;

async function acknowledgementTargets(agentIds: string[]) {
  const { rows } = await withSystem((db) => db.query<{ agent_id: string; active_config_version_id: string | null }>(
    "select id as agent_id,active_config_version_id from agent_instances where id=any($1::uuid[])",
    [agentIds],
  ));
  return rows.flatMap((row) => row.active_config_version_id
    ? [{ agentId: row.agent_id, expectedActiveConfigVersionId: row.active_config_version_id }]
    : []);
}

function internalContextForAdmin(): OrgContext {
  const membership = {
    orgId: agencyOrgId,
    name: "iAcquire test agency",
    slug: "iacquire-test-agency",
    kind: "agency" as const,
    status: "active" as const,
    role: "owner" as const,
    isDemo: false,
    onboardingCompletedAt: null,
    timezone: "UTC",
  };
  return {
    user: admin,
    org: membership,
    role: "owner",
    permissions: permissionsFor("owner"),
    can: (permission) => roleHasPermission("owner", permission),
    memberships: [membership],
  };
}

async function waitForMockRequest(startIndex: number, method: string, path: string, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (mock.requests.slice(startIndex).some((request) => request.method === method && request.path === path)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Mock Hermes did not receive " + method + " " + path);
}

async function waitForAssistantMessage(messageId: string, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { rows } = await withSystem((db) =>
      db.query<{ status: string }>("select status from chat_messages where id=$1", [messageId]),
    );
    if (rows[0] && rows[0].status !== "streaming") return rows[0].status;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("assistant message did not settle");
}

beforeAll(async () => {
  const profiles = Object.fromEntries(Object.entries(PROFILE_KEYS).map(([key, apiKey]) => [key, { key: apiKey }])) as Record<string, { key: string }>;
  profiles[CLIENT_TEST_PROFILE] = { key: CLIENT_TEST_KEY };
  mock = await startMockHermes(profiles);
  const adminUser = await createUser({ platformRole: "agency_super_admin" });
  admin = agencyUser(adminUser, "agency_super_admin");
  staff = agencyUser(await createUser({ platformRole: "agency_staff" }), "agency_staff");
  const agency = await withSystem(async (db) => {
    const { rows } = await db.query<{ id: string }>(
      "insert into organizations (name,slug,kind,status) values ('iAcquire test agency','iacquire-test-agency','agency','active') returning id",
    );
    await db.query("insert into company_profiles (org_id) values ($1)", [rows[0].id]);
    return rows[0];
  });
  agencyOrgId = agency.id;
  await withSystem((db) => db.query(
    "insert into organization_memberships (org_id,user_id,role) values ($1,$2,'owner') on conflict (org_id,user_id) do update set role='owner'",
    [agencyOrgId, admin.id],
  ));
  clientOrg = await createOrg({ name: "Separated client workforce" });
  otherClientOrg = await createOrg({ name: "Unassigned client workforce" });
  await withSystem((db) => db.query("insert into staff_assignments (org_id,user_id) values ($1,$2)", [clientOrg.id, staff.id]));
  await addMember(clientOrg.id, (await createUser()).id, "owner");
  gatewayId = await saveIntegrationConnection(admin, null, {
    provider: "hermes",
    label: "Synthetic iAcquire test gateway",
    environment: "development",
    config: { baseUrl: mock.url, gatewayType: "multiplexed_profiles" },
  }) as string;
});

afterAll(async () => mock.close());

describe("agency Hermes workforce isolation", () => {
  it("uses the exact approved mapping for all six original Hermes identities", () => {
    expect(AGENCY_HERMES_PROFILE_IDS).toEqual({
      operations_manager: "iacquire-operations-manager",
      lead_hunter: "iacquire-lead-hunter",
      appointment_setter: "iacquire-appointment-setter",
      sales_assistant: "iacquire-sales-assistant",
      crm_manager: "iacquire-crm-manager",
      performance_analyst: "iacquire-analyst",
    });
  });

  it("repairs a missing agency registry idempotently without adding agency identities to clients", async () => {
    await expect(ensureAgencyWorkforceRegistry(staff)).rejects.toMatchObject({ code: "forbidden" });
    expect(await ensureAgencyWorkforceRegistry(admin)).toBe(agencyOrgId);
    const { rows: initial } = await withSystem((db) => db.query<{ role_key: string; display_name: string; hermes_profile: string | null }>(
      "select role_key,display_name,hermes_profile from agent_instances where org_id=$1 order by role_key",
      [agencyOrgId],
    ));
    expect(initial.map((row) => row.role_key)).toEqual([...AGENT_ROLE_KEYS].sort());
    expect(initial.every((row) => row.hermes_profile === null)).toBe(true);
    expect(initial.some((row) => row.hermes_profile === "default")).toBe(false);
    expect((await listAllAgents(admin)).every((agent) => agent.org_kind === "client")).toBe(true);

    const { rows: clientRows } = await withSystem((db) => db.query<{ count: number }>(
      "select count(*)::int as count from agent_instances where org_id=$1",
      [clientOrg.id],
    ));
    expect(clientRows[0].count).toBe(AGENT_ROLE_KEYS.length);

    salesAgentId = (await withSystem((db) => db.query<{ id: string }>(
      "select id from agent_instances where org_id=$1 and role_key='sales_assistant'",
      [agencyOrgId],
    ))).rows[0].id;
    const mapped = await connectAgencyHermesProfile(admin, {
      agentId: salesAgentId,
      gatewayId,
      profile: AGENCY_HERMES_PROFILE_IDS.sales_assistant,
      apiKey: PROFILE_KEYS[AGENCY_HERMES_PROFILE_IDS.sales_assistant],
      confirmedExistingProfile: true,
    });
    expect(mapped).toMatchObject({ status: "verified", identityVerified: true, apiContractVerified: true });

    const previousCredential = await withSystem(async (db) => {
      const { rows } = await db.query<{ credential_id: string }>("select credential_id from agent_instances where id=$1", [salesAgentId]);
      return (await db.query<{ id: string; revoked_at: Date | null }>("select id,revoked_at from integration_credentials where id=$1", [rows[0].credential_id])).rows[0];
    });
    const invalidCandidate = "synthetic-invalid-replacement-key-0123456789";
    const requestStart = mock.requests.length;
    await expect(connectAgencyHermesProfile(admin, {
      agentId: salesAgentId,
      gatewayId,
      profile: AGENCY_HERMES_PROFILE_IDS.sales_assistant,
      apiKey: invalidCandidate,
      confirmedExistingProfile: true,
    })).rejects.toThrow("Hermes rejected the candidate profile key");
    expect(mock.requests.slice(requestStart)).toEqual([{ method: "GET", path: "/v1/capabilities", profile: AGENCY_HERMES_PROFILE_IDS.sales_assistant }]);
    const afterRejectedCandidate = await withServiceRole(async (db) => {
      const { rows } = await db.query<{ credential_id: string }>("select credential_id from agent_instances where id=$1", [salesAgentId]);
      return (await db.query<{ id: string; revoked_at: Date | null }>("select id,revoked_at from integration_credentials where id=$1", [rows[0].credential_id])).rows[0];
    });
    expect(afterRejectedCandidate).toEqual(previousCredential);
    expect(JSON.stringify(mapped)).not.toContain(invalidCandidate);

    await ensureAgencyWorkforceRegistry(admin);
    const { rows: persisted } = await withSystem((db) => db.query<{ hermes_profile: string | null; hermes_gateway_id: string | null; status: string }>(
      "select hermes_profile,hermes_gateway_id,status from agent_instances where id=$1",
      [salesAgentId],
    ));
    expect(persisted[0]).toMatchObject({ hermes_profile: AGENCY_HERMES_PROFILE_IDS.sales_assistant, hermes_gateway_id: gatewayId, status: "provisioning" });

    const workforce = await listAgencyAgents(admin);
    expect(workforce).toHaveLength(AGENT_ROLE_KEYS.length);
    expect(workforce.find((agent) => agent.id === salesAgentId)?.has_credential).toBe(true);
    const gateways = await withServiceRole(listHermesGateways);
    expect(gateways.find((gateway) => gateway.id === gatewayId)?.id).toBe(gatewayId);
    const history = await getAgencyProfileHistory(admin, salesAgentId);
    expect(history.map((event) => event.action)).toContain("connected");
    expect(history.map((event) => event.action)).toContain("profile_checked");
    expect(JSON.stringify(history)).not.toContain(PROFILE_KEYS[AGENCY_HERMES_PROFILE_IDS.sales_assistant]);
    await expect(getAgencyProfileHistory(staff, salesAgentId)).rejects.toMatchObject({ code: "forbidden" });
    const reviewStart = mock.requests.length;
    const toolReview = await reviewAgencyHermesToolPermissions(admin, salesAgentId);
    expect(toolReview).toMatchObject({
      roleKey: "sales_assistant",
      profile: AGENCY_HERMES_PROFILE_IDS.sales_assistant,
      inventoryComplete: true,
      restrictedTools: [],
    });
    expect(toolReview.toolsets.map(({ name }) => name)).toEqual(["web", "memory", "session_search", "todo", "vision"]);
    expect(mock.requests.slice(reviewStart).map(({ method, path }) => [method, path])).toEqual([
      ["GET", "/v1/toolsets"], ["GET", "/v1/capabilities"], ["GET", "/v1/tools"], ["GET", "/v1/tools"],
    ]);
    expect(JSON.stringify(toolReview)).not.toContain(PROFILE_KEYS[AGENCY_HERMES_PROFILE_IDS.sales_assistant]);
    await expect(reviewAgencyHermesToolPermissions(staff, salesAgentId)).rejects.toMatchObject({ code: "forbidden" });
    await expect(listAgencyAgents(staff)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("requires Super Admin, checks the exact existing profile read-only, and keeps Test All separate from client employees", async () => {
    await expect(testAgencyHermesProfile(staff, salesAgentId)).rejects.toMatchObject({ code: "forbidden" });
    await expect(connectAgencyHermesProfile(staff, {
      agentId: salesAgentId,
      gatewayId,
      profile: AGENCY_HERMES_PROFILE_IDS.sales_assistant,
      apiKey: PROFILE_KEYS[AGENCY_HERMES_PROFILE_IDS.sales_assistant],
      confirmedExistingProfile: true,
    })).rejects.toMatchObject({ code: "forbidden" });
    const before = mock.requests.length;
    const result = await testAgencyHermesProfile(admin, salesAgentId);
    expect(result).toMatchObject({
      roleKey: "sales_assistant",
      profile: "iacquire-sales-assistant",
      status: "verified",
      mapped: true,
      identityVerified: true,
      apiContractVerified: true,
    });
    expect(result.detail).not.toContain(PROFILE_KEYS[result.profile]);
    const profileRequests = mock.requests.slice(before);
    expect(profileRequests.length).toBeGreaterThan(0);
    expect(profileRequests.every((request) => request.method === "GET" && request.profile === result.profile)).toBe(true);

    const all = await testAllAgencyHermesProfiles(admin);
    expect(all).toMatchObject({ mapped: 1, verified: 1, notConfigured: AGENT_ROLE_KEYS.length - 1, failed: 0 });
    expect(all.results.map((row) => row.roleKey).sort()).toEqual([...AGENT_ROLE_KEYS].sort());
    expect(all.results.every((row) => row.profile === AGENCY_HERMES_PROFILE_IDS[row.roleKey])).toBe(true);
    expect(all.results.find((row) => row.roleKey === "sales_assistant")?.status).toBe("verified");
    expect(JSON.stringify(all)).not.toContain(PROFILE_KEYS[AGENCY_HERMES_PROFILE_IDS.sales_assistant]);
    expect(mock.requests.every((request) => request.method === "GET")).toBe(true);

    const { rows: clientAgent } = await withSystem((db) => db.query<{ id: string; status: string; hermes_profile: string | null }>(
      "select id,status,hermes_profile from agent_instances where org_id=$1 and role_key='sales_assistant'",
      [clientOrg.id],
    ));
    expect(clientAgent[0]).toMatchObject({ status: "setup_required", hermes_profile: null });
  });

  it("filters client workforce summaries through staff assignments and keeps the gateway test profile-independent", async () => {
    const otherSales = (await withSystem((db) => db.query<{ id: string }>(
      "select id from agent_instances where org_id=$1 and role_key='sales_assistant'",
      [otherClientOrg.id],
    ))).rows[0].id;
    await connectHermesProfile({
      agentId: otherSales,
      gatewayId,
      profile: "synthetic-other-client-profile",
      apiKey: "synthetic-other-client-profile-key-012345",
      agencyUserId: admin.id,
    });

    const staffClients = await listClientWorkforceSummaries(staff);
    expect(staffClients.map((client) => client.id)).toEqual([clientOrg.id]);
    const adminClients = await listClientWorkforceSummaries(admin);
    expect(adminClients.map((client) => client.id).sort()).toEqual([clientOrg.id, otherClientOrg.id].sort());
    const staffManager = await listIntegrationManager(staff, clientOrg.id);
    expect(staffManager.hermesGateways.every((gateway) => gateway.mappedProfileCount === 0 && gateway.clientMappedProfileCount === 0)).toBe(true);
    expect(JSON.stringify(staffManager)).not.toContain("synthetic-other-client-profile");

    await updateAgencyUserPermission(admin, {
      userId: staff.id,
      permission: "agency.workforce.view",
      effect: "deny",
    });
    await expect(listClientWorkforceSummaries(staff)).rejects.toMatchObject({ code: "forbidden" });

    const { rows: checkCountBefore } = await withSystem((db) => db.query<{ count: number }>(
      "select count(*)::int as count from agency_hermes_profile_checks where agent_instance_id=$1",
      [salesAgentId],
    ));
    const requestStart = mock.requests.length;
    const result = await testIntegrationConnection(admin, null, "hermes", gatewayId);
    expect(result).toMatchObject({ status: "connected", capabilities: { gatewayHealthVerified: true, profileChecksRun: 0 } });
    expect(mock.requests.slice(requestStart)).toEqual([{ method: "GET", path: "/health", profile: null }]);
    const { rows: checkCountAfter } = await withSystem((db) => db.query<{ count: number }>(
      "select count(*)::int as count from agency_hermes_profile_checks where agent_instance_id=$1",
      [salesAgentId],
    ));
    expect(checkCountAfter[0].count).toBe(checkCountBefore[0].count);
  });

  it("refuses to map an iAcquire identity to a client employee", async () => {
    const { rows } = await withSystem((db) => db.query<{ id: string }>(
      "select id from agent_instances where org_id=$1 and role_key='sales_assistant'",
      [clientOrg.id],
    ));
    await expect(connectAgencyHermesProfile(admin, {
      agentId: rows[0].id,
      gatewayId,
      profile: AGENCY_HERMES_PROFILE_IDS.sales_assistant,
      apiKey: PROFILE_KEYS[AGENCY_HERMES_PROFILE_IDS.sales_assistant],
      confirmedExistingProfile: true,
    })).rejects.toMatchObject({ code: "not_found" });
  });

  it("requires a current acknowledgement and active saved credentials for internal runs", async () => {
    await ensureAgencyWorkforceRegistry(admin);
    const { rows: agents } = await withSystem((db) => db.query<{ id: string; role_key: typeof AGENT_ROLE_KEYS[number] }>(
      "select id,role_key from agent_instances where org_id=$1 order by role_key",
      [agencyOrgId],
    ));
    expect(agents.map((agent) => agent.role_key).sort()).toEqual([...AGENT_ROLE_KEYS].sort());

    for (const agent of agents) {
      const profile = AGENCY_HERMES_PROFILE_IDS[agent.role_key];
      await connectAgencyHermesProfile(admin, {
        agentId: agent.id,
        gatewayId,
        profile,
        apiKey: PROFILE_KEYS[profile],
        confirmedExistingProfile: true,
      });
    }

    const agentIds = agents.map((agent) => agent.id);
    const unconfiguredTargets = agentIds.map((agentId) => ({ agentId, expectedActiveConfigVersionId: crypto.randomUUID() }));
    await expect(acknowledgeInternalFullCapabilities(staff, unconfiguredTargets)).rejects.toMatchObject({ code: "forbidden" });
    await expect(acknowledgeInternalFullCapabilities(admin, unconfiguredTargets)).rejects.toMatchObject({ code: "conflict" });
    const clientEmployeeId = await agentId(clientOrg.id, "sales_assistant");
    await expect(acknowledgeInternalFullCapabilities(admin, [{ agentId: clientEmployeeId, expectedActiveConfigVersionId: crypto.randomUUID() }]))
      .rejects.toMatchObject({ code: "not_found" });

    for (const agent of agents) {
      await withSystem((db) => createConfigVersion(db, {
        orgId: agencyOrgId,
        agentId: agent.id,
        settings: defaultSettings(agent.role_key),
        source: "agency",
        userId: admin.id,
        apply: true,
      }));
      expect(await runHealthCheck(agent.id, { userId: admin.id, kind: "agency" })).toMatchObject({ ok: true, status: "online" });
    }

    const initialView = await getHermesToolPolicyView(admin);
    expect(initialView.agents.find((agent) => agent.id === agentIds[0])).toMatchObject({
      identityMapped: false,
      canAcknowledgeFullCapabilities: true,
      inventoryCurrent: true,
    });
    const currentTargets = await acknowledgementTargets(agentIds);
    await withSystem((db) => db.query(
      "update integration_credentials set revoked_at=now() where id=(select credential_id from agent_instances where id=$1)",
      [agentIds[0]],
    ));
    const ineligiblePolicyProfile = (await getHermesToolPolicyView(admin)).agents.find((agent) => agent.id === agentIds[0]);
    expect(ineligiblePolicyProfile).toMatchObject({ identityMapped: false, canAcknowledgeFullCapabilities: false });
    await expect(acknowledgeInternalFullCapabilities(admin, currentTargets)).rejects.toMatchObject({ code: "conflict" });
    await withSystem((db) => db.query(
      "update integration_credentials set revoked_at=null where id=(select credential_id from agent_instances where id=$1)",
      [agentIds[0]],
    ));
    await withSystem((db) => db.query("update agent_instances set enabled=false where id=$1", [agentIds[0]]));
    await expect(acknowledgeInternalFullCapabilities(admin, currentTargets)).rejects.toMatchObject({ code: "conflict" });
    await withSystem((db) => db.query("update agent_instances set enabled=true where id=$1", [agentIds[0]]));

    const selectedAgent = agents.find((agent) => agent.role_key === "sales_assistant")!;
    const selectedProfile = AGENCY_HERMES_PROFILE_IDS.sales_assistant;
    const initialAckAuditCount = (await withSystem((db) => db.query<{ count: number }>(
      "select count(*)::int as count from audit_logs where action='workforce.full_capabilities_acknowledged' and agent_instance_id=$1",
      [selectedAgent.id],
    ))).rows[0].count;
    // Vision is optional. Removing it creates a different, still reviewed digest; the first health check must
    // record the change and keep the acknowledgement blocked until a second explicit check confirms it.
    mock.setInventory(selectedProfile, { tools: [
      { name: "memory", toolset: "memory" },
      { name: "session_search", toolset: "session_search" },
      { name: "todo_list", toolset: "todo" },
      { name: "web_search", toolset: "web" },
      { name: "web_extract", toolset: "web" },
    ] });
    const selectedTarget = currentTargets.find((target) => target.agentId === selectedAgent.id)!;
    await expect(acknowledgeInternalFullCapabilities(admin, [selectedTarget])).rejects.toMatchObject({ code: "conflict" });
    expect((await withSystem((db) => db.query<{ count: number }>(
      "select count(*)::int as count from audit_logs where action='workforce.full_capabilities_acknowledged' and agent_instance_id=$1",
      [selectedAgent.id],
    ))).rows[0].count).toBe(initialAckAuditCount);
    expect((await getHermesToolPolicyView(admin)).agents.find((agent) => agent.id === selectedAgent.id)).toMatchObject({
      fullCapabilitiesAcknowledged: false,
      canAcknowledgeFullCapabilities: false,
      inventoryCurrent: false,
    });
    expect(await runHealthCheck(selectedAgent.id, { userId: admin.id, kind: "agency" })).toMatchObject({ ok: true, status: "online" });

    const fiveToolInventory = [
      { name: "memory", toolset: "memory" },
      { name: "session_search", toolset: "session_search" },
      { name: "todo_list", toolset: "todo" },
      { name: "web_search", toolset: "web" },
      { name: "web_extract", toolset: "web" },
    ];
    mock.setInventory(selectedProfile, { tools: fiveToolInventory, delayMs: 250 });
    const raceRequestStart = mock.requests.length;
    const raceAcknowledgement = acknowledgeInternalFullCapabilities(admin, [selectedTarget]);
    let enteredDiagnostic = false;
    for (let attempt = 0; attempt < 100 && !enteredDiagnostic; attempt += 1) {
      enteredDiagnostic = mock.requests.slice(raceRequestStart).some((request) => request.method === "GET" && request.path === "/v1/tools");
      if (!enteredDiagnostic) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(enteredDiagnostic).toBe(true);
    await withSystem((db) => createConfigVersion(db, {
      orgId: agencyOrgId,
      agentId: selectedAgent.id,
      settings: defaultSettings("sales_assistant"),
      source: "agency",
      userId: admin.id,
      apply: true,
    }));
    await expect(raceAcknowledgement).rejects.toMatchObject({ code: "conflict" });
    expect((await withSystem((db) => db.query<{ count: number }>(
      "select count(*)::int as count from audit_logs where action='workforce.full_capabilities_acknowledged' and agent_instance_id=$1",
      [selectedAgent.id],
    ))).rows[0].count).toBe(initialAckAuditCount);
    mock.setInventory(selectedProfile, { tools: fiveToolInventory });
    expect(await runHealthCheck(selectedAgent.id, { userId: admin.id, kind: "agency" })).toMatchObject({ ok: true, status: "online" });
    const currentTargetsAfterRace = await acknowledgementTargets(agentIds);

    await withSystem((db) => db.query("update agent_instances set tool_inventory_expires_at=now()-interval '1 second' where id=$1", [selectedAgent.id]));
    const acknowledgementRequestStart = mock.requests.length;
    const policyBeforeAck = (await withSystem((db) => db.query<{ allowed_capabilities: string[]; blocked_toolsets: string[]; approval_mode: string }>(
      "select allowed_capabilities,blocked_toolsets,approval_mode from hermes_tool_policies where scope_kind='internal_agency' and name='Full Hermes Capabilities'",
    ))).rows[0];
    await acknowledgeInternalFullCapabilities(admin, currentTargetsAfterRace);
    expect(mock.requests.slice(acknowledgementRequestStart).some((request) => request.method === "POST" && request.path === "/v1/runs")).toBe(false);
    const policyAfterAck = (await withSystem((db) => db.query<{ allowed_capabilities: string[]; blocked_toolsets: string[]; approval_mode: string }>(
      "select allowed_capabilities,blocked_toolsets,approval_mode from hermes_tool_policies where scope_kind='internal_agency' and name='Full Hermes Capabilities'",
    ))).rows[0];
    expect(policyAfterAck).toEqual(policyBeforeAck);

    const evidence = await withSystem(async (db) => {
      const { rows } = await db.query<{ policy_snapshot: Record<string, unknown>; active_config_version_id: string; tool_inventory_digest: string }>(
        `select h.policy_snapshot,a.active_config_version_id,a.tool_inventory_digest
           from hermes_tool_policy_history h join agent_instances a on a.id=h.agent_id
          where h.agent_id=$1 and h.action='full_capabilities_acknowledged'
          order by h.occurred_at desc,h.id desc limit 1`,
        [selectedAgent.id],
      );
      return rows[0];
    });
    expect(evidence.policy_snapshot).toMatchObject({
      activeConfigVersionId: evidence.active_config_version_id,
      inventoryDigest: evidence.tool_inventory_digest,
      inventoryContract: "hermes.api_server.tool_catalog.v1",
      inventoryToolCount: 5,
      identityCheckedAt: expect.any(String),
      inventoryVerifiedAt: expect.any(String),
    });
    expect(evidence.policy_snapshot).not.toHaveProperty("inventoryCompleteness", "unverified");
    const auditEvidence = await withSystem((db) => db.query<{ metadata: Record<string, unknown> }>(
      `select metadata from audit_logs
        where action='workforce.full_capabilities_acknowledged' and target_id=$1
        order by created_at desc limit 1`,
      [selectedAgent.id],
    ));
    expect(auditEvidence.rows[0]?.metadata).toMatchObject({
      activeConfigVersionId: evidence.active_config_version_id,
      inventoryDigest: evidence.tool_inventory_digest,
      modelRunSubmitted: false,
    });

    const view = await getHermesToolPolicyView(admin);
    const internalProfiles = view.agents.filter((agent) => agent.orgKind === "agency");
    expect(internalProfiles).toHaveLength(AGENT_ROLE_KEYS.length);
    expect(internalProfiles.every((agent) => agent.identityMapped && agent.fullCapabilitiesAcknowledged)).toBe(true);
    expect(view.internalDefault.acknowledgedFullCapabilities).toBe(true);
    const workforceCards = await listAgencyAgents(admin);
    expect(workforceCards).toHaveLength(AGENT_ROLE_KEYS.length);
    expect(workforceCards.every((agent) => agent.full_capabilities_acknowledged)).toBe(true);

    const connection = {
      baseUrl: mock.url,
      profile: AGENCY_HERMES_PROFILE_IDS.sales_assistant,
      apiKey: PROFILE_KEYS[AGENCY_HERMES_PROFILE_IDS.sales_assistant],
    };
    const startRequest = () => startAgentRun(selectedAgent.id, agencyOrgId, connection, {
      input: "synthetic acknowledged internal run",
      idempotencyKey: `acknowledged-${crypto.randomUUID()}`,
    });

    const wrongKeyRequestStart = mock.requests.length;
    await expect(startAgentRun(selectedAgent.id, agencyOrgId, { ...connection, apiKey: "rotated-but-unsaved-synthetic-key-012345" }, {
      input: "synthetic stale credential run",
      idempotencyKey: `stale-credential-${crypto.randomUUID()}`,
    })).rejects.toMatchObject({ kind: "bad_response" });
    expect(mock.requests).toHaveLength(wrongKeyRequestStart);

    // The acknowledgement is bound to the profile, policy, applied configuration and inventory digest, not to the time of the last check: a re-check that finds the same things keeps it.
    await testAgencyHermesProfile(admin, selectedAgent.id);
    const keptAcknowledgementView = await getHermesToolPolicyView(admin);
    expect(keptAcknowledgementView.agents.find((agent) => agent.id === selectedAgent.id)).toMatchObject({
      identityMapped: true,
      canAcknowledgeFullCapabilities: true,
      fullCapabilitiesAcknowledged: true,
    });
    // A newly applied configuration is a new identity to acknowledge, however fresh the checks are: that is the stale state the refusals below need.
    await withSystem((db) => createConfigVersion(db, {
      orgId: agencyOrgId,
      agentId: selectedAgent.id,
      settings: defaultSettings("sales_assistant"),
      source: "agency",
      userId: admin.id,
      apply: true,
    }));
    expect(await runHealthCheck(selectedAgent.id, { userId: admin.id, kind: "agency" })).toMatchObject({ ok: true, status: "online" });
    await testAgencyHermesProfile(admin, selectedAgent.id);
    const staleAcknowledgementView = await getHermesToolPolicyView(admin);
    expect(staleAcknowledgementView.agents.find((agent) => agent.id === selectedAgent.id)).toMatchObject({
      identityMapped: true,
      canAcknowledgeFullCapabilities: true,
      fullCapabilitiesAcknowledged: false,
    });
    expect(staleAcknowledgementView.internalDefault.acknowledgedFullCapabilities).toBe(false);
    const staleCheckRequestStart = mock.requests.length;
    await expect(startRequest()).rejects.toMatchObject({ reason: "acknowledgement_required" });
    expect(mock.requests).toHaveLength(staleCheckRequestStart);

    const internalMembership = {
      orgId: agencyOrgId,
      name: "iAcquire test agency",
      slug: "iacquire-test-agency",
      kind: "agency" as const,
      status: "active" as const,
      role: "owner" as const,
      isDemo: false,
      onboardingCompletedAt: null,
      timezone: "UTC",
    };
    const internalCtx: OrgContext = {
      user: admin,
      org: internalMembership,
      role: "owner",
      permissions: permissionsFor("owner"),
      can: (permission) => roleHasPermission("owner", permission),
      memberships: [internalMembership],
    };
    const beforeChatQueue = await withSystem(async (db) => {
      const { rows } = await db.query<{ messages: number; runs: number }>(
        `select
           (select count(*)::int from chat_messages m join chat_conversations c on c.id=m.conversation_id where c.agent_instance_id=$1) as messages,
           (select count(*)::int from agent_runs where agent_instance_id=$1) as runs`,
        [selectedAgent.id],
      );
      return rows[0];
    });
    const noProviderRequestStart = mock.requests.length;
    await expect(sendChatMessage(internalCtx, {
      agentRole: "sales_assistant",
      content: "This must not queue while the acknowledgement is stale.",
      clientMessageId: crypto.randomUUID(),
    })).rejects.toMatchObject({ code: "agent_unavailable" });
    expect(mock.requests).toHaveLength(noProviderRequestStart);
    const afterChatQueue = await withSystem(async (db) => {
      const { rows } = await db.query<{ messages: number; runs: number }>(
        `select
           (select count(*)::int from chat_messages m join chat_conversations c on c.id=m.conversation_id where c.agent_instance_id=$1) as messages,
           (select count(*)::int from agent_runs where agent_instance_id=$1) as runs`,
        [selectedAgent.id],
      );
      return rows[0];
    });
    expect(afterChatQueue).toEqual(beforeChatQueue);

    await acknowledgeInternalFullCapabilities(admin, await acknowledgementTargets([selectedAgent.id]));
    expect((await getHermesToolPolicyView(admin)).agents.find((agent) => agent.id === selectedAgent.id)?.fullCapabilitiesAcknowledged).toBe(true);

    const runStart = mock.requests.length;
    const result = await startRequest();
    expect(result.runId).toBeTruthy();
    expect(mock.requests.slice(runStart).map(({ method, path }) => [method, path])).toEqual([
      ["GET", "/v1/capabilities"], ["GET", "/v1/models"], ["GET", "/v1/capabilities"],
      ["GET", "/v1/tools"], ["GET", "/v1/tools"], ["POST", "/v1/runs"],
    ]);

    const revokeRequestStart = mock.requests.length;
    await withSystem(async (db) => {
      await db.query("update integration_credentials set revoked_at=now() where id=(select credential_id from agent_instances where id=$1)", [selectedAgent.id]);
      await db.query("update credential_references set revoked_at=now() where id=(select credential_reference_id from integration_credentials where id=(select credential_id from agent_instances where id=$1))", [selectedAgent.id]);
    });
    const revokedView = await getHermesToolPolicyView(admin);
    expect(revokedView.agents.find((agent) => agent.id === selectedAgent.id)).toMatchObject({
      canAcknowledgeFullCapabilities: false,
      fullCapabilitiesAcknowledged: false,
    });
    await expect(startRequest()).rejects.toMatchObject({ kind: "bad_response" });
    expect(mock.requests).toHaveLength(revokeRequestStart);
    await withSystem(async (db) => {
      await db.query("update credential_references set revoked_at=null where id=(select credential_reference_id from integration_credentials where id=(select credential_id from agent_instances where id=$1))", [selectedAgent.id]);
      await db.query("update integration_credentials set revoked_at=null where id=(select credential_id from agent_instances where id=$1)", [selectedAgent.id]);
    });
  });

  it("refreshes an expired internal inventory before chat persistence without repeating acknowledgement", async () => {
    const profile = AGENCY_HERMES_PROFILE_IDS.sales_assistant;
    const tools = [
      { name: "memory", toolset: "memory" },
      { name: "session_search", toolset: "session_search" },
      { name: "todo_list", toolset: "todo" },
      { name: "web_search", toolset: "web" },
      { name: "web_extract", toolset: "web" },
    ];
    const before = (await withSystem((db) => db.query<{
      digest: string; expires_at: Date; acknowledged_at: Date; acknowledgements: number; messages: number; runs: number;
    }>(
      "select a.tool_inventory_digest as digest,a.tool_inventory_expires_at as expires_at,ack.acknowledged_at,(select count(*)::int from hermes_tool_policy_history h where h.agent_id=a.id and h.action='full_capabilities_acknowledged') as acknowledgements,(select count(*)::int from chat_messages m join chat_conversations c on c.id=m.conversation_id where c.agent_instance_id=a.id and m.role='user') as messages,(select count(*)::int from agent_runs r where r.agent_instance_id=a.id) as runs from agent_instances a join hermes_tool_policy_acknowledgements ack on ack.agent_id=a.id where a.id=$1",
      [salesAgentId],
    ))).rows[0];
    expect(before.digest).toMatch(/^[0-9a-f]{64}$/);
    expect((await getHermesToolPolicyView(admin)).agents.find((agent) => agent.id === salesAgentId)?.fullCapabilitiesAcknowledged).toBe(true);
    await withSystem((db) => db.query("update agent_instances set tool_inventory_expires_at=now()-interval '1 second' where id=$1", [salesAgentId]));
    mock.setInventory(profile, { tools, delayMs: 150 });
    const clientMessageId = crypto.randomUUID();
    const requestStart = mock.requests.length;
    try {
      const sending = sendChatMessage(internalContextForAdmin(), {
        agentRole: "sales_assistant",
        content: "Synthetic chat verifies the internal inventory refresh path",
        clientMessageId,
      });
      await waitForMockRequest(requestStart, "GET", "/v1/tools");
      const duringPreflight = (await withSystem((db) => db.query<{ message_exists: boolean; run_count: number }>(
        "select exists(select 1 from chat_messages where client_message_id=$1 and role='user') as message_exists,(select count(*)::int from agent_runs where agent_instance_id=$2) as run_count",
        [clientMessageId, salesAgentId],
      ))).rows[0];
      expect(duringPreflight).toEqual({ message_exists: false, run_count: before.runs });

      const sent = await sending;
      expect(await waitForAssistantMessage(sent.assistantMessageId)).toBe("complete");
      const after = (await withSystem((db) => db.query<{
        digest: string; expires_at: Date; acknowledged_at: Date; acknowledgements: number; status: string; last_health_ok: boolean;
      }>(
        "select a.tool_inventory_digest as digest,a.tool_inventory_expires_at as expires_at,ack.acknowledged_at,(select count(*)::int from hermes_tool_policy_history h where h.agent_id=a.id and h.action='full_capabilities_acknowledged') as acknowledgements,a.status,a.last_health_ok from agent_instances a join hermes_tool_policy_acknowledgements ack on ack.agent_id=a.id where a.id=$1",
        [salesAgentId],
      ))).rows[0];
      expect(after).toMatchObject({
        digest: before.digest,
        acknowledged_at: before.acknowledged_at,
        acknowledgements: before.acknowledgements,
        status: "online",
        last_health_ok: true,
      });
      expect(new Date(after.expires_at).getTime()).toBeGreaterThan(Date.now());
      const requests = mock.requests.slice(requestStart);
      const runSubmission = requests.findIndex((request) => request.method === "POST" && request.path === "/v1/runs");
      expect(runSubmission).toBeGreaterThan(-1);
      expect(requests.slice(0, runSubmission).filter((request) => request.method === "GET" && request.path === "/v1/tools").length).toBeGreaterThanOrEqual(4);
      expect(requests.some((request) => request.method === "GET" && request.path === "/v1/models" && request.profile === profile)).toBe(true);
    } finally {
      mock.setInventory(profile, { tools });
    }
  });

  it("rejects changed internal inventory before chat persistence and invalidates the old acknowledgement", async () => {
    const profile = AGENCY_HERMES_PROFILE_IDS.sales_assistant;
    const before = (await withSystem((db) => db.query<{ digest: string; messages: number; runs: number }>(
      "select a.tool_inventory_digest as digest,(select count(*)::int from chat_messages m join chat_conversations c on c.id=m.conversation_id where c.agent_instance_id=a.id and m.role='user') as messages,(select count(*)::int from agent_runs r where r.agent_instance_id=a.id) as runs from agent_instances a where a.id=$1",
      [salesAgentId],
    ))).rows[0];
    const clientMessageId = crypto.randomUUID();
    const requestStart = mock.requests.length;
    mock.setInventory(profile, { tools: [
      { name: "memory", toolset: "memory" },
      { name: "session_search", toolset: "session_search" },
      { name: "todo_list", toolset: "todo" },
      { name: "vision_analyze", toolset: "vision" },
      { name: "web_search", toolset: "web" },
      { name: "web_extract", toolset: "web" },
    ] });
    await withSystem((db) => db.query("update agent_instances set tool_inventory_expires_at=now()-interval '1 second' where id=$1", [salesAgentId]));
    await expect(sendChatMessage(internalContextForAdmin(), {
      agentRole: "sales_assistant",
      content: "This must not persist after inventory drift",
      clientMessageId,
    })).rejects.toMatchObject({ code: "agent_unavailable" });

    const requests = mock.requests.slice(requestStart);
    expect(requests.some((request) => request.method === "GET" && request.path === "/v1/tools" && request.profile === profile)).toBe(true);
    expect(requests.some((request) => request.method === "POST" && request.path === "/v1/runs")).toBe(false);
    const after = (await withSystem((db) => db.query<{ digest: string; status: string; last_health_ok: boolean; messages: number; runs: number }>(
      "select a.tool_inventory_digest as digest,a.status,a.last_health_ok,(select count(*)::int from chat_messages m join chat_conversations c on c.id=m.conversation_id where c.agent_instance_id=a.id and m.role='user') as messages,(select count(*)::int from agent_runs r where r.agent_instance_id=a.id) as runs from agent_instances a where a.id=$1",
      [salesAgentId],
    ))).rows[0];
    expect(after).toMatchObject({ status: "provisioning", last_health_ok: false, messages: before.messages, runs: before.runs });
    expect(after.digest).not.toBe(before.digest);
    expect((await getHermesToolPolicyView(admin)).agents.find((agent) => agent.id === salesAgentId)?.fullCapabilitiesAcknowledged).toBe(false);
  });

  it("keeps client live runs blocked when the gateway cannot prove a complete tool inventory", async () => {
    const { rows } = await withSystem((db) => db.query<{ id: string; role_key: typeof AGENT_ROLE_KEYS[number] }>(
      "select id,role_key from agent_instances where org_id=$1 order by role_key limit 1",
      [clientOrg.id],
    ));
    const clientConnection = { baseUrl: mock.url, profile: CLIENT_TEST_PROFILE, apiKey: CLIENT_TEST_KEY };
    const clientRequest = () => startAgentRun(rows[0].id, clientOrg.id, clientConnection, { input: "synthetic client request", idempotencyKey: `blocked-client-${crypto.randomUUID()}` });
    // A client employee that never passed a health check is refused by the readiness gate before any gateway request.
    await expect(clientRequest()).rejects.toBeInstanceOf(AgentRunNotReadyError);
    await connectHermesProfile({ agentId: rows[0].id, baseUrl: mock.url, profile: CLIENT_TEST_PROFILE, apiKey: CLIENT_TEST_KEY, agencyUserId: admin.id });
    // Online and configured with a recorded digest, the only thing left to stop it is the gateway's inventory contract.
    await withSystem((db) => createConfigVersion(db, { orgId: clientOrg.id, agentId: rows[0].id, settings: defaultSettings(rows[0].role_key), source: "onboarding", userId: admin.id, apply: true }));
    await withSystem((db) => db.query("update agent_instances set status='online', last_health_ok=true, tool_inventory_digest=$2 where id=$1", [rows[0].id, "a".repeat(64)]));
    const requestsStart = mock.requests.length;
    mock.setInventory(CLIENT_TEST_PROFILE, { advertised: false });
    try {
      await expect(clientRequest()).rejects.toMatchObject({ kind: "bad_response" });
      const requests = mock.requests.slice(requestsStart);
      expect(requests.map(({ method, path }) => [method, path])).toEqual([["GET", "/v1/capabilities"]]);
      expect(requests.some(({ path }) => path === "/v1/runs")).toBe(false);
    } finally {
      mock.setInventory(CLIENT_TEST_PROFILE, null);
      await withSystem((db) => db.query("update agent_instances set status='setup_required', last_health_ok=null, tool_inventory_digest=null where id=$1", [rows[0].id]));
    }
  });

  it("rejects out-of-scope, default and unmapped profile verification rows at the database boundary", async () => {
    const { rows: clientAgent } = await withSystem((db) => db.query<{ id: string }>(
      "select id from agent_instances where org_id=$1 and role_key='sales_assistant'",
      [clientOrg.id],
    ));
    await expect(withSystem((db) => db.query(
      `insert into agency_hermes_profile_checks
         (org_id,agent_instance_id,profile_id,status,detail,checked_by)
       values($1,$2,'default','not_configured','synthetic wrong profile',$3)`,
      [agencyOrgId, salesAgentId, admin.id],
    ))).rejects.toThrow(/agency_profile_check_identity_mismatch/);
    await expect(withSystem((db) => db.query(
      `insert into agency_hermes_profile_checks
         (org_id,agent_instance_id,status,identity_verified,api_contract_verified,detail,checked_by)
       values($1,$2,'verified',true,true,'synthetic missing identity',$3)`,
      [agencyOrgId, salesAgentId, admin.id],
    ))).rejects.toThrow(/agency_profile_check_missing_identity_or_gateway/);
    await expect(withSystem((db) => db.query(
      `insert into agency_hermes_profile_checks
         (org_id,agent_instance_id,status,detail,checked_by)
       values($1,$2,'not_configured','synthetic client row',$3)`,
      [clientOrg.id, clientAgent[0].id, admin.id],
    ))).rejects.toThrow(/agency_profile_check_wrong_scope/);
  });
});
