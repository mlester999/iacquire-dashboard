import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AGENT_ROLE_KEYS, AGENCY_HERMES_PROFILE_IDS } from "@/lib/agents";
import { withSystem } from "@/server/db";
import { listAllAgents } from "@/server/admin/queries";
import { connectAgencyHermesProfile, testAgencyHermesProfile, testAllAgencyHermesProfiles } from "@/server/workforce/agency";
import { ensureAgencyWorkforceRegistry, listClientWorkforceSummaries } from "@/server/workforce/agency-registry";
import { listIntegrationManager, saveIntegrationConnection, testIntegrationConnection } from "@/server/integrations/manager";
import { connectHermesProfile } from "@/server/workforce/service";
import { addMember, agencyUser, createOrg, createUser } from "./support/fixtures";
import { startMockHermes, type MockHermes } from "./support/mock-hermes";

const PROFILE_KEYS = Object.fromEntries(AGENT_ROLE_KEYS.map((role) => [AGENCY_HERMES_PROFILE_IDS[role], `synthetic-${role}-profile-key-0123456789`])) as Record<string, string>;
let mock: MockHermes;
let admin: ReturnType<typeof agencyUser>;
let staff: ReturnType<typeof agencyUser>;
let agencyOrgId: string;
let clientOrg: Awaited<ReturnType<typeof createOrg>>;
let otherClientOrg: Awaited<ReturnType<typeof createOrg>>;
let salesAgentId: string;
let gatewayId: string;

beforeAll(async () => {
  mock = await startMockHermes(Object.fromEntries(Object.entries(PROFILE_KEYS).map(([key, apiKey]) => [key, { key: apiKey }])));
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

    await ensureAgencyWorkforceRegistry(admin);
    const { rows: persisted } = await withSystem((db) => db.query<{ hermes_profile: string | null; hermes_gateway_id: string | null; status: string }>(
      "select hermes_profile,hermes_gateway_id,status from agent_instances where id=$1",
      [salesAgentId],
    ));
    expect(persisted[0]).toMatchObject({ hermes_profile: AGENCY_HERMES_PROFILE_IDS.sales_assistant, hermes_gateway_id: gatewayId, status: "provisioning" });
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
