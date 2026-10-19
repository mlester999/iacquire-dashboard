import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AGENT_ROLE_KEYS, AGENCY_HERMES_PROFILE_IDS } from "@/lib/agents";
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
import { addMember, agencyUser, createOrg, createUser } from "./support/fixtures";
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
    await expect(acknowledgeInternalFullCapabilities(staff, agentIds)).rejects.toMatchObject({ code: "forbidden" });
    await withSystem((db) => db.query(
      "update integration_credentials set revoked_at=now() where id=(select credential_id from agent_instances where id=$1)",
      [agentIds[0]],
    ));
    const ineligiblePolicyProfile = (await getHermesToolPolicyView(admin)).agents.find((agent) => agent.id === agentIds[0]);
    expect(ineligiblePolicyProfile).toMatchObject({ identityMapped: true, canAcknowledgeFullCapabilities: false });
    await expect(acknowledgeInternalFullCapabilities(admin, agentIds)).rejects.toMatchObject({ code: "conflict" });
    await withSystem((db) => db.query(
      "update integration_credentials set revoked_at=null where id=(select credential_id from agent_instances where id=$1)",
      [agentIds[0]],
    ));
    await withSystem((db) => db.query("update agent_instances set enabled=false where id=$1", [agentIds[0]]));
    await expect(acknowledgeInternalFullCapabilities(admin, agentIds)).rejects.toMatchObject({ code: "conflict" });
    await withSystem((db) => db.query("update agent_instances set enabled=true where id=$1", [agentIds[0]]));
    await acknowledgeInternalFullCapabilities(admin, agentIds);

    const view = await getHermesToolPolicyView(admin);
    const internalProfiles = view.agents.filter((agent) => agent.orgKind === "agency");
    expect(internalProfiles).toHaveLength(AGENT_ROLE_KEYS.length);
    expect(internalProfiles.every((agent) => agent.identityMapped && agent.fullCapabilitiesAcknowledged)).toBe(true);
    expect(view.internalDefault.acknowledgedFullCapabilities).toBe(true);
    const workforceCards = await listAgencyAgents(admin);
    expect(workforceCards).toHaveLength(AGENT_ROLE_KEYS.length);
    expect(workforceCards.every((agent) => agent.full_capabilities_acknowledged)).toBe(true);

    const selectedAgent = agents.find((agent) => agent.role_key === "sales_assistant")!;
    const connection = {
      baseUrl: mock.url,
      profile: AGENCY_HERMES_PROFILE_IDS.sales_assistant,
      apiKey: PROFILE_KEYS[AGENCY_HERMES_PROFILE_IDS.sales_assistant],
    };
    const startRequest = () => startAgentRun(selectedAgent.id, agencyOrgId, connection, {
      input: "synthetic acknowledged internal run",
      idempotencyKey: `acknowledged-${crypto.randomUUID()}`,
    });

    // Mapped, identity-checked and even acknowledged, but never health-checked: still `provisioning`, so no run starts and
    // nothing reaches the gateway.
    const provisioningRequestStart = mock.requests.length;
    await expect(startRequest()).rejects.toBeInstanceOf(AgentRunNotReadyError);
    expect(mock.requests).toHaveLength(provisioningRequestStart);
    // What a Super Admin does to bring it live: apply an initial configuration in the agency workspace, then run the health check.
    await withSystem((db) => createConfigVersion(db, { orgId: agencyOrgId, agentId: selectedAgent.id, settings: defaultSettings("sales_assistant"), source: "agency", userId: admin.id, apply: true }));
    expect(await runHealthCheck(selectedAgent.id, { userId: admin.id, kind: "agency" })).toMatchObject({ ok: true, status: "online" });

    const wrongKeyRequestStart = mock.requests.length;
    await expect(startAgentRun(selectedAgent.id, agencyOrgId, { ...connection, apiKey: "rotated-but-unsaved-synthetic-key-012345" }, {
      input: "synthetic stale credential run",
      idempotencyKey: `stale-credential-${crypto.randomUUID()}`,
    })).rejects.toMatchObject({ kind: "bad_response" });
    expect(mock.requests).toHaveLength(wrongKeyRequestStart);

    await testAgencyHermesProfile(admin, selectedAgent.id);
    const staleAcknowledgementView = await getHermesToolPolicyView(admin);
    expect(staleAcknowledgementView.agents.find((agent) => agent.id === selectedAgent.id)).toMatchObject({
      identityMapped: true,
      canAcknowledgeFullCapabilities: true,
      fullCapabilitiesAcknowledged: false,
    });
    expect(staleAcknowledgementView.internalDefault.acknowledgedFullCapabilities).toBe(false);
    const staleCheckRequestStart = mock.requests.length;
    await expect(startRequest()).rejects.toMatchObject({ kind: "bad_response" });
    expect(mock.requests).toHaveLength(staleCheckRequestStart);

    await acknowledgeInternalFullCapabilities(admin, [selectedAgent.id]);
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

  it("keeps client live runs blocked when the gateway cannot prove a complete tool inventory", async () => {
    const { rows } = await withSystem((db) => db.query<{ id: string; role_key: typeof AGENT_ROLE_KEYS[number] }>(
      "select id,role_key from agent_instances where org_id=$1 order by role_key limit 1",
      [clientOrg.id],
    ));
    const requestsStart = mock.requests.length;
    const clientConnection = { baseUrl: mock.url, profile: CLIENT_TEST_PROFILE, apiKey: CLIENT_TEST_KEY };
    const clientRequest = () => startAgentRun(rows[0].id, clientOrg.id, clientConnection, { input: "synthetic client request", idempotencyKey: `blocked-client-${crypto.randomUUID()}` });
    // A client employee that never passed a health check is refused by the readiness gate before any gateway request.
    await expect(clientRequest()).rejects.toBeInstanceOf(AgentRunNotReadyError);
    expect(mock.requests).toHaveLength(requestsStart);
    // Online and configured with a recorded digest, the only thing left to stop it is the gateway's inventory contract.
    await withSystem((db) => createConfigVersion(db, { orgId: clientOrg.id, agentId: rows[0].id, settings: defaultSettings(rows[0].role_key), source: "onboarding", userId: admin.id, apply: true }));
    await withSystem((db) => db.query("update agent_instances set status='online', last_health_ok=true, tool_inventory_digest=$2 where id=$1", [rows[0].id, "a".repeat(64)]));
    mock.setInventory(CLIENT_TEST_PROFILE, { advertised: false });
    try {
      await expect(clientRequest()).rejects.toMatchObject({ kind: "bad_response" });
      const requests = mock.requests.slice(requestsStart);
      expect(requests.map(({ method, path }) => [method, path])).toEqual([["GET", "/v1/capabilities"], ["GET", "/v1/tools"]]);
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
