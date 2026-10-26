import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AGENCY_HERMES_PROFILE_IDS } from "@/lib/agents";
import { withSystem } from "@/server/db";
import { saveIntegrationConnection } from "@/server/integrations/manager";
import { deriveEmployeeReadiness, internalAcknowledgementIsCurrent, internalIdentityIsCurrent } from "@/lib/workforce-readiness";
import { recommendedSettings } from "@/lib/role-playbooks";
import { createResearchRequest } from "@/server/leads/service";
import { connectAgencyHermesProfile, testAgencyHermesProfile } from "@/server/workforce/agency";
import { ensureAgencyWorkforceRegistry } from "@/server/workforce/agency-registry";
import { createConfigVersion, getAgentByRole, runHealthCheck } from "@/server/workforce/service";
import { acknowledgeInternalFullCapabilities } from "@/server/workforce/tool-policies";
import { permissionsFor, roleHasPermission } from "@/lib/permissions";
import type { OrgContext } from "@/server/tenancy/context";
import type { SessionUser } from "@/server/auth/service";
import { addMember, agencyUser, createUser } from "./support/fixtures";
import { startMockHermes, type MockHermes } from "./support/mock-hermes";

const KEY = "l".repeat(40);
const PROFILE = AGENCY_HERMES_PROFILE_IDS.lead_hunter;

let mock: MockHermes;
let admin: SessionUser;
let agencyOrgId: string;
let hunterId: string;

function researchScript() {
  const output = `\`\`\`json
{"leads":[
  {"business_name":"Sandbox Realty One","website":"https://sandbox-realty-one.example","industry":"Real estate agency","location":"Miami, FL","evidence":[{"url":"https://sandbox-realty-one.example/about","observed_at":"2026-10-21T00:00:00Z","summary":"Independent Miami agency with a public team page."}],"buying_signals":["Public booking page"],"qualification_summary":"Independent agency in Miami with a verifiable public website.","score":{"service_fit":24,"problem_evidence":16,"buying_intent":9,"market_fit":14,"source_quality":9}},
  {"business_name":"Sandbox Realty Two","website":"https://sandbox-realty-two.example","industry":"Real estate agency","location":"Miami, FL","evidence":[{"url":"https://sandbox-realty-two.example/contact","observed_at":"2026-10-21T00:00:00Z","summary":"Public contact page lists a Miami office."}],"buying_signals":[],"qualification_summary":"Independent agency with verifiable public contact details.","score":{"service_fit":21,"problem_evidence":12,"buying_intent":6,"market_fit":12,"source_quality":8}}
]}
\`\`\``;
  return { steps: [{ tool: "web_search" }, { tool: "web_extract" }, { delta: output }], output };
}

function agencyContext(): OrgContext {
  const membership = {
    orgId: agencyOrgId,
    name: "iAcquire",
    slug: "iacquire",
    kind: "agency" as const,
    status: "active" as const,
    role: "owner" as const,
    isDemo: false,
    onboardingCompletedAt: new Date().toISOString(),
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

async function waitForSettled(jobId: string, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { rows } = await withSystem((db) =>
      db.query<{ status: string; result_count: number; failure_code: string | null; failure_message: string | null }>(
        "select status, result_count, failure_code, failure_message from ai_work_jobs where id = $1",
        [jobId],
      ),
    );
    if (rows[0] && ["completed", "failed", "cancelled", "blocked"].includes(rows[0].status)) return rows[0];
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("Lead Hunter research job did not settle");
}

beforeAll(async () => {
  mock = await startMockHermes({
    [PROFILE]: {
      key: KEY,
      respond: (input) => (/research request/i.test(input) ? researchScript() : { steps: [{ delta: "Sandbox response." }], output: "Sandbox response." }),
    },
  });
  admin = agencyUser(await createUser({ platformRole: "agency_super_admin" }), "agency_super_admin");
  agencyOrgId = await ensureAgencyWorkforceRegistry(admin);
  // A durable job is re-authorized for its requester when a worker claims it (work-runner requesterGate), as the agency owner who really asks for research is a member of the agency workspace.
  await addMember(agencyOrgId, admin.id, "owner");
  await withSystem(async (db) => {
    await db.query("insert into usage_limits (org_id) values ($1) on conflict (org_id) do nothing", [agencyOrgId]);
    await db.query("insert into billing_accounts (org_id) values ($1) on conflict (org_id) do nothing", [agencyOrgId]);
  });
  const gatewayId = await saveIntegrationConnection(admin, null, {
    provider: "hermes",
    label: "Synthetic Lead Hunter activation gateway",
    environment: "development",
    config: { baseUrl: mock.url, gatewayType: "multiplexed_profiles" },
  }) as string;
  hunterId = (await withSystem((db) => db.query<{ id: string }>(
    "select id from agent_instances where org_id=$1 and role_key='lead_hunter'",
    [agencyOrgId],
  ))).rows[0].id;
  const mapped = await connectAgencyHermesProfile(admin, {
    agentId: hunterId,
    gatewayId,
    profile: PROFILE,
    apiKey: KEY,
    confirmedExistingProfile: true,
  });
  expect(mapped).toMatchObject({ status: "verified", identityVerified: true, apiContractVerified: true });
}, 60000);

afterAll(() => mock.close());

describe("Lead Hunter genuine 6/6 activation", () => {
  it("applies the complete role configuration, verifies identity/inventory, acknowledges, and reaches 6/6", async () => {
    const applied = await withSystem((db) =>
      createConfigVersion(db, {
        orgId: agencyOrgId,
        agentId: hunterId,
        settings: recommendedSettings("lead_hunter"),
        source: "agency",
        userId: admin.id,
        apply: true,
      }),
    );
    expect(applied?.status).toBe("applied");

    const health = await runHealthCheck(hunterId, { userId: admin.id, kind: "agency" });
    expect(health).toMatchObject({ ok: true, status: "online" });

    await testAgencyHermesProfile(admin, hunterId);
    const active = (await withSystem((db) => db.query<{ active_config_version_id: string }>(
      "select active_config_version_id from agent_instances where id=$1",
      [hunterId],
    ))).rows[0].active_config_version_id;
    await acknowledgeInternalFullCapabilities(admin, [{ agentId: hunterId, expectedActiveConfigVersionId: active }]);

    const agent = await getAgentByRole(admin.id, agencyOrgId, "lead_hunter");
    expect(agent).not.toBeNull();
    expect(agent!.hermes_profile).toBe(PROFILE);
    expect(agent!.hermes_profile).not.toBe(AGENCY_HERMES_PROFILE_IDS.operations_manager);
    expect(agent!.active_config_version_id).toBeTruthy();
    expect(agent!.tool_inventory_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(agent!.credential_ready).toBe(true);

    const evidence = await withSystem(async (db) => {
      const { rows } = await db.query<{
        profile_check_status: string | null; profile_check_profile_id: string | null; profile_check_gateway_id: string | null;
        identity_verified: boolean | null; api_contract_verified: boolean | null; tool_permissions_status: string | null; checked_at: Date | null;
        acknowledged_at: Date | null; acknowledged_profile: string | null; acknowledged_policy_id: string | null; internal_policy_id: string | null;
        acknowledged_config_version_id: string | null; acknowledged_inventory_digest: string | null; agent_policy_override_id: string | null;
      }>(
        `select c.status as profile_check_status,c.profile_id as profile_check_profile_id,c.gateway_id as profile_check_gateway_id,
                c.identity_verified,c.api_contract_verified,c.tool_permissions_status,c.checked_at,
                ack.acknowledged_at,ack.verified_profile as acknowledged_profile,ack.policy_id as acknowledged_policy_id,
                ack_policy.id as internal_policy_id,
                ack_history.policy_snapshot->>'activeConfigVersionId' as acknowledged_config_version_id,
                ack_history.policy_snapshot->>'inventoryDigest' as acknowledged_inventory_digest,
                agent_policy.id as agent_policy_override_id
           from agent_instances a
           left join agency_hermes_profile_checks c on c.agent_instance_id=a.id and c.org_id=a.org_id
           left join hermes_tool_policy_acknowledgements ack on ack.agent_id=a.id
           left join hermes_tool_policies ack_policy on ack_policy.id=ack.policy_id and ack_policy.scope_kind='internal_agency' and ack_policy.name='Full Hermes Capabilities'
           left join hermes_tool_policies agent_policy on agent_policy.scope_kind='agent' and agent_policy.agent_id=a.id
           left join lateral (
             select h.policy_snapshot from hermes_tool_policy_history h
             where h.agent_id=a.id and h.action='full_capabilities_acknowledged'
             order by h.occurred_at desc,h.id desc limit 1
           ) ack_history on true
          where a.id=$1 and a.org_id=$2`,
        [hunterId, agencyOrgId],
      );
      return rows[0];
    });
    const identityEvidence = {
      expectedProfile: PROFILE,
      savedProfile: agent!.hermes_profile,
      savedGatewayId: agent!.hermes_gateway_id,
      checkedProfile: evidence?.profile_check_profile_id ?? null,
      checkedGatewayId: evidence?.profile_check_gateway_id ?? null,
      checkStatus: evidence?.profile_check_status ?? null,
      identityVerified: evidence?.identity_verified ?? null,
      apiContractVerified: evidence?.api_contract_verified ?? null,
      toolPermissionsStatus: evidence?.tool_permissions_status ?? null,
      checkedAt: evidence?.checked_at ?? null,
      configAppliedAt: agent!.config_applied_at,
    };
    const identityCurrent = internalIdentityIsCurrent(identityEvidence);
    const acknowledgementCurrent = internalAcknowledgementIsCurrent({
      ...identityEvidence,
      acknowledgedAt: evidence?.acknowledged_at ?? null,
      acknowledgedProfile: evidence?.acknowledged_profile ?? null,
      acknowledgedPolicyId: evidence?.acknowledged_policy_id ?? null,
      expectedPolicyId: evidence?.internal_policy_id ?? null,
      activeConfigVersionId: agent!.active_config_version_id,
      acknowledgedConfigVersionId: evidence?.acknowledged_config_version_id ?? null,
      inventoryDigest: agent!.tool_inventory_digest,
      acknowledgedInventoryDigest: evidence?.acknowledged_inventory_digest ?? null,
      credentialReady: agent!.credential_ready,
      hasAgentPolicyOverride: Boolean(evidence?.agent_policy_override_id),
    });
    expect(identityCurrent).toBe(true);
    expect(acknowledgementCurrent).toBe(true);

    const readiness = deriveEmployeeReadiness({
      displayName: agent!.display_name,
      enabled: agent!.enabled,
      status: agent!.status,
      configVersion: agent!.config_version,
      lastHealthCheckAt: agent!.last_health_check_at?.toISOString() ?? null,
      lastHealthOk: agent!.last_health_ok,
      lastHealthDetail: agent!.last_health_detail,
      inventoryContract: agent!.tool_inventory_contract,
      inventoryDigest: agent!.tool_inventory_digest,
      inventoryVerifiedAt: agent!.tool_inventory_verified_at?.toISOString() ?? null,
      inventoryExpiresAt: agent!.tool_inventory_expires_at?.toISOString() ?? null,
      inventoryToolCount: agent!.tool_inventory_tool_count,
      credentialCurrent: agent!.credential_ready,
      identityCurrent,
      acknowledgementCurrent,
      isAgencyEmployee: true,
      taskExecuting: false,
    });
    expect(readiness.completed).toBe(6);
    expect(readiness.total).toBe(6);
    expect(readiness.stage).toBe("ready");
    expect(readiness.chatAvailable).toBe(true);
  }, 60000);

  it("performs a real sandbox research job from the activated internal employee", async () => {
    const created = await createResearchRequest(agencyContext(), {
      prompt: "Find 2 independent real estate agencies in Miami that could benefit from our AI automation services. Research them and prepare them for my review.",
      campaignType: "business",
    });
    expect(created.jobId).toBeTruthy();
    const job = await waitForSettled(created.jobId!);
    expect(job.status, `Research job ended ${job.status}: ${job.failure_code ?? "no failure code"} ${job.failure_message ?? "no failure detail"}`).toBe("completed");
    expect(job.result_count).toBe(2);
    const { rows } = await withSystem((db) =>
      db.query<{ business_name: string; evidence: unknown; org_id: string }>(
        "select business_name, evidence, org_id from leads where research_request_id = $1 order by business_name",
        [created.requestId],
      ),
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.org_id === agencyOrgId)).toBe(true);
    expect(rows[0].business_name).toBe("Sandbox Realty One");
    expect(Array.isArray(rows[0].evidence) && rows[0].evidence.length > 0).toBe(true);
    const { rows: runRows } = await withSystem((db) =>
      db.query<{ status: string; purpose: string; total_tokens: number | null }>(
        "select status, purpose, total_tokens from agent_runs where org_id=$1 and agent_instance_id=$2 order by started_at desc limit 1",
        [agencyOrgId, hunterId],
      ),
    );
    expect(runRows[0]).toMatchObject({ status: "completed", purpose: "lead_research" });
    expect(runRows[0].total_tokens).toBe(59);
  }, 60000);
});
