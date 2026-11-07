import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AI_GROWTH_PARTNER_ROLE_KEY } from "@/lib/agents";
import { ROLE_ABILITIES } from "@/lib/employee-tool-policy";
import { withSystem } from "@/server/db";
import { createConfigVersion, ensureGrowthPartnerRuntime, suggestedProfileName } from "@/server/workforce/service";
import { defaultSettings } from "@/server/workforce/compiler";
import { employeeAbilities } from "@/server/workforce/abilities";
import { clientToolGate } from "@/server/workforce/hermes-client-business-mcp-gate";
import { clientBusinessMcpRuntimeNamesForRole, CLIENT_BUSINESS_PROPOSALS_FEATURE, CLIENT_BUSINESS_TOOLS_FEATURE } from "@/server/workforce/hermes-client-business-mcp-policy";
import { HERMES_BUSINESS_MCP_SERVER, HERMES_BUSINESS_MCP_TOOLSET } from "@/server/workforce/hermes-business-mcp-policy";
import { formatClientCredential, generateClientCredentialSecret, hashClientSecret, registerClientBusinessCredential } from "@/server/workforce/hermes-client-business-credential";
import { handleHermesClientBusinessMcp } from "@/server/workforce/hermes-client-business-mcp";
import { decideApproval } from "@/server/approvals/service";
import { getWorkspace } from "@/server/crm/workspace";
import { createContact } from "@/server/crm/contacts";
import { clearSetupPayment } from "./support/billing";
import { crmOrg } from "./support/crm";
import { ctxFor } from "./support/fixtures";
import { makeRuntimeReady } from "./support/runtime-ready";
import { resetEnvCache } from "@/server/env";
import { setClientProposals, sharedGateway } from "./support/client-business-mcp";

const UP = readFileSync("supabase/migrations/0132_growth_partner_crm_update_ability.sql", "utf8");
const DOWN = readFileSync("supabase/rollbacks/0132_growth_partner_crm_update_ability.down.sql", "utf8");
const TOOLS_BEFORE = [
  "tasks.read", "research.public_web", "leads.stage_for_review", "calendar.read_availability", "appointments.read", "appointments.request_change",
  "calendar.booking_rules.update", "calendar.create", "crm.read", "crm.read_opportunities", "crm.contacts.create", "drafts.create", "analytics.read",
];
const TOOLS_AFTER = [...TOOLS_BEFORE, "crm.request_update"];
const CLIENT_MCP_URL = "https://portal.example.test/api/internal/hermes-business/client/mcp";

class RollbackProbe extends Error {}

function statements(sql: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let inside = false;
  for (const raw of sql.split("\n")) {
    const line = raw.replace("\r", "");
    if (!inside && (line.trim() === "" || line.trim().startsWith("--"))) continue;
    current.push(line);
    if (line.split("$$").length % 2 === 0) inside = !inside;
    if (!inside && line.trimEnd().endsWith(";")) {
      out.push(current.join("\n"));
      current = [];
    }
  }
  return out;
}

async function run(sql: string, db: { query: (query: string, params?: unknown[]) => Promise<unknown> }) {
  for (const statement of statements(sql)) await db.query(statement);
}

describe("migration 0132 Growth Partner CRM update ability", () => {
  it("adds only the reviewed switch and safely applies, rolls back and reapplies", async () => {
    expect(ROLE_ABILITIES.growth_partner).toContain("crm.request_update");
    const current = await withSystem((db) => db.query<{ default_tools: string[] }>("select default_tools from agent_roles where key = 'growth_partner'"));
    expect(current.rows[0].default_tools).toEqual(TOOLS_AFTER);

    let report: Record<string, unknown> = {};
    await expect(withSystem(async (db) => {
      await run(DOWN, db);
      const rolledBack = (await db.query<{ default_tools: string[] }>("select default_tools from agent_roles where key = 'growth_partner'")).rows[0].default_tools;
      await run(UP, db);
      const reapplied = (await db.query<{ default_tools: string[] }>("select default_tools from agent_roles where key = 'growth_partner'")).rows[0].default_tools;
      report = { rolledBack, reapplied };
      throw new RollbackProbe();
    })).rejects.toBeInstanceOf(RollbackProbe);
    expect(report).toEqual({ rolledBack: TOOLS_BEFORE, reapplied: TOOLS_AFTER });

    await expect(withSystem(async (db) => {
      await db.query("update agent_roles set default_tools = default_tools || '[\"workspace.custom\"]'::jsonb where key = 'growth_partner'");
      await run(DOWN, db);
    })).rejects.toThrow(/refusing_to_roll_back_0132_custom_growth_partner_default_tools/);
  });
});

interface PartnerHarness {
  org: { id: string; slug: string; name: string };
  owner: { id: string; email: string };
  agentId: string;
  credential: string;
  contactId: string;
}

describe("Growth Partner CRM Allowed actions enforcement", () => {
  let partner: PartnerHarness;

  beforeAll(async () => {
    setClientProposals(true);
    const tenant = await crmOrg({ name: "Growth Partner CRM ability acceptance" });
    await clearSetupPayment(tenant.org.id);
    const gateway = await sharedGateway();
    const runtimeId = await withSystem((db) => ensureGrowthPartnerRuntime(tenant.org.id, db));
    await makeRuntimeReady(runtimeId, tenant.org.id, tenant.people.owner.id);
    const profile = suggestedProfileName(tenant.org.slug, AI_GROWTH_PARTNER_ROLE_KEY);
    const secret = generateClientCredentialSecret();
    const crm = await getWorkspace(tenant.actor("owner"));
    const contact = await createContact(tenant.actor("owner"), { firstName: "Synthetic", lastName: "Roofing Prospect", phone: "+14075550101" });

    const registered = await withSystem(async (db) => {
      await db.query("insert into org_features (org_id, feature, enabled) values ($1, $2, true) on conflict (org_id, feature) do update set enabled = true", [tenant.org.id, CLIENT_BUSINESS_TOOLS_FEATURE]);
      await db.query("insert into org_features (org_id, feature, enabled) values ($1, $2, true) on conflict (org_id, feature) do update set enabled = true", [tenant.org.id, CLIENT_BUSINESS_PROPOSALS_FEATURE]);
      const fingerprint = crypto.randomBytes(8).toString("hex");
      const ref = await db.query<{ id: string }>(
        "insert into credential_references (org_id, provider, store, vault_secret_id, label, fingerprint) values ($1, 'hermes', 'test_memory', gen_random_uuid(), $2, $3) returning id",
        [tenant.org.id, `Hermes profile ${profile}`, fingerprint],
      );
      const credentialRow = await db.query<{ id: string }>(
        "insert into integration_credentials (org_id, provider, label, ciphertext, fingerprint, credential_reference_id) values ($1, 'hermes', 'fixture', $2, $3, $4) returning id",
        [tenant.org.id, `vault-ref:${ref.rows[0].id}`, fingerprint, ref.rows[0].id],
      );
      await db.query("update agent_instances set credential_id = $2, hermes_base_url = $3, hermes_profile = $4, hermes_gateway_id = $5 where id = $1", [runtimeId, credentialRow.rows[0].id, gateway.baseUrl, profile, gateway.id]);
      await createConfigVersion(db, { orgId: tenant.org.id, agentId: runtimeId, settings: defaultSettings(AI_GROWTH_PARTNER_ROLE_KEY), source: "onboarding", userId: tenant.people.owner.id, apply: true });
      await db.query("update agent_instances set tool_inventory_snapshot = $2::jsonb, tool_inventory_expires_at = now() + interval '20 minutes' where id = $1", [runtimeId, JSON.stringify({ tools: clientBusinessMcpRuntimeNamesForRole(AI_GROWTH_PARTNER_ROLE_KEY, { proposals: true }).map((name) => ({ name, toolset: HERMES_BUSINESS_MCP_TOOLSET, source: "mcp", sourceServer: HERMES_BUSINESS_MCP_SERVER, available: true })) })]);
      return registerClientBusinessCredential(db, { orgId: tenant.org.id, agentId: runtimeId, profile, secretSha256: hashClientSecret(secret) });
    });
    expect(crm.orgId).toBe(tenant.org.id);
    partner = { org: tenant.org, owner: tenant.people.owner, agentId: runtimeId, credential: formatClientCredential(registered.id, secret), contactId: contact.id };
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    resetEnvCache();
  });

  async function switchOff(abilities: readonly string[]) {
    await withSystem(async (db) => {
      const v = await db.query<{ id: string }>(
        `insert into agent_config_versions (org_id, agent_instance_id, version, settings, summary, compiled_instructions, policy_version, source, status)
         values ($1, $2, (select coalesce(max(version), 0) + 1 from agent_config_versions where agent_instance_id = $2), $3, 'test ability switch', '# config', 'test', 'onboarding', 'applied') returning id`,
        [partner.org.id, partner.agentId, JSON.stringify({ ...defaultSettings(AI_GROWTH_PARTNER_ROLE_KEY), disabledTools: abilities })],
      );
      await db.query("update agent_instances set active_config_version_id = $2 where id = $1", [partner.agentId, v.rows[0].id]);
    });
  }

  async function startTurn() {
    return withSystem(async (db) => {
      await db.query("update agent_runs set status = 'completed' where agent_instance_id = $1 and status = 'running'", [partner.agentId]);
      const config = (await db.query<{ active_config_version_id: string }>("select active_config_version_id from agent_instances where id = $1", [partner.agentId])).rows[0].active_config_version_id;
      const runId = crypto.randomUUID();
      await db.query(
        `insert into agent_runs (org_id, agent_instance_id, user_id, purpose, idempotency_key, status, started_at, hermes_run_id, config_version_id)
         values ($1, $2, $3, 'chat', $4, 'running', now(), $5, $6)`,
        [partner.org.id, partner.agentId, partner.owner.id, `growth-partner-crm-${runId}`, `run-${runId}`, config],
      );
      return runId;
    });
  }

  async function callApi() {
    const request = new Request(CLIENT_MCP_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${partner.credential}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "x-forwarded-for": "198.51.100.27" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "update_contact", arguments: { contactId: partner.contactId, changes: { leadScore: 73 }, reason: "Synthetic acceptance" } } }),
    });
    const response = await handleHermesClientBusinessMcp(request);
    return { response, body: JSON.parse(await response.text()) as { result?: { content?: Array<{ text: string }> } } };
  }

  it("enforces the CRM switch on direct API calls and blocks an earlier approval if the owner switches it off", async () => {
    await switchOff(["crm.request_update"]);
    expect((await withSystem((db) => employeeAbilities(db, partner.org.id, partner.agentId, AI_GROWTH_PARTNER_ROLE_KEY)))?.has("crm.request_update")).toBe(false);
    await startTurn();
    const approvalsBefore = Number((await withSystem((db) => db.query<{ n: number }>("select count(*)::int as n from approval_requests where org_id = $1", [partner.org.id]))).rows[0].n);
    const tokensBefore = Number((await withSystem((db) => db.query<{ n: number }>("select count(*)::int as n from crm_agent_tokens where agent_instance_id = $1 and revoked_at is null", [partner.agentId]))).rows[0].n);
    const rejected = await callApi();
    expect(rejected.response.status).toBe(200);
    const rejectedText = rejected.body.result?.content?.[0]?.text ?? "";
    expect(rejectedText).toMatch(/CRM updates are switched off/);
    expect(Number((await withSystem((db) => db.query<{ n: number }>("select count(*)::int as n from approval_requests where org_id = $1", [partner.org.id]))).rows[0].n)).toBe(approvalsBefore);
    expect(Number((await withSystem((db) => db.query<{ n: number }>("select count(*)::int as n from crm_agent_tokens where agent_instance_id = $1 and revoked_at is null", [partner.agentId]))).rows[0].n)).toBe(tokensBefore);

    await switchOff([]);
    await startTurn();
    const accepted = await callApi();
    const acceptedText = accepted.body.result?.content?.[0]?.text ?? "";
    const proposal = JSON.parse(acceptedText) as { status?: string; approvalId?: string };
    expect(proposal).toMatchObject({ status: "pending_approval", approvalId: expect.any(String) });
    const scoreBefore = (await withSystem((db) => db.query<{ lead_score: number | null }>("select lead_score from contacts where id = $1 and org_id = $2", [partner.contactId, partner.org.id]))).rows[0].lead_score;
    await switchOff(["crm.request_update"]);
    const outcome = await decideApproval(ctxFor(partner.owner, partner.org, "owner"), proposal.approvalId!, "approve");
    expect(outcome.outcome).toMatchObject({ status: "blocked", detail: expect.stringMatching(/CRM updates are switched off/) });
    expect((await withSystem((db) => db.query<{ lead_score: number | null }>("select lead_score from contacts where id = $1 and org_id = $2", [partner.contactId, partner.org.id]))).rows[0].lead_score).toBe(scoreBefore);
    expect((await withSystem((db) => db.query<{ execution_status: string }>("select execution_status from approval_requests where id = $1 and org_id = $2", [proposal.approvalId, partner.org.id]))).rows[0].execution_status).toBe("blocked");
    const audit = await withSystem((db) => db.query<{ result: string }>("select result from audit_logs where org_id = $1 and approval_id = $2 and action = 'crm.agent_tool.update_contact'", [partner.org.id, proposal.approvalId]));
    expect(audit.rows.map((row) => row.result)).toContain("denied");
  });

  it("keeps the live API gate tenant-scoped while the switch is on in another workspace", async () => {
    const other = await crmOrg({ name: "GP CRM isolation" });
    await clearSetupPayment(other.org.id);
    const runtimeId = await withSystem((db) => ensureGrowthPartnerRuntime(other.org.id, db));
    await getWorkspace(other.actor("owner"));
    await withSystem(async (db) => {
      await db.query("insert into org_features (org_id, feature, enabled) values ($1, $2, true) on conflict (org_id, feature) do update set enabled = true", [other.org.id, CLIENT_BUSINESS_TOOLS_FEATURE]);
      await db.query("insert into org_features (org_id, feature, enabled) values ($1, $2, true) on conflict (org_id, feature) do update set enabled = true", [other.org.id, CLIENT_BUSINESS_PROPOSALS_FEATURE]);
      await createConfigVersion(db, { orgId: other.org.id, agentId: runtimeId, settings: defaultSettings(AI_GROWTH_PARTNER_ROLE_KEY), source: "onboarding", userId: other.people.owner.id, apply: true });
    });
    const otherAllowed = await withSystem((db) => clientToolGate(db, { orgId: other.org.id, agentId: runtimeId, roleKey: AI_GROWTH_PARTNER_ROLE_KEY, tool: "update_contact" }));
    expect(otherAllowed).toEqual({ ok: true });
  });
});
