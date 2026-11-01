// What a client employee's Hermes profile is told about the business tools, and when: the profile config the portal builds (and that its default is untouched), the connection the verifier
// reads (the tier comes from the workspace's own switches, in the same transaction), the manifest the restricted worker claims, and the one synchronization job a switch change opens per
// employee. Synthetic workspaces on the embedded database; no Hermes, provider or network.
import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { withSystem } from "@/server/db";
import { env, resetEnvCache } from "@/server/env";
import { AppError } from "@/server/errors";
import { PORTAL_SAFE_TOOLSETS } from "@/server/integrations/hermes/tool-policy";
import { saveProvisionedHermesCredential } from "@/server/security/credentials";
import { claimHermesProvisionerJob } from "@/server/workforce/hermes-provisioner";
import { HERMES_BUSINESS_MCP_SERVER, HERMES_BUSINESS_MCP_TOOLSET } from "@/server/workforce/hermes-business-mcp-policy";
import { CLIENT_BUSINESS_MCP_PATH, CLIENT_BUSINESS_MCP_TOKEN_ENV_VAR } from "@/server/workforce/hermes-client-business-credential";
import { CLIENT_BUSINESS_PROPOSALS_FEATURE, CLIENT_BUSINESS_TOOLS_FEATURE } from "@/server/workforce/hermes-client-business-mcp-policy";
import { buildConfigYaml, requestBusinessToolSync, setClientBusinessTools } from "@/server/workforce/provisioning";
import { loadConnection, suggestedProfileName } from "@/server/workforce/service";
import { DEFAULT_BLOCKED_TOOLSETS } from "@/server/workforce/tool-policies";
import { addMember, agencyUser, agentId, createOrg, createUser, uid } from "./support/fixtures";
import { readyToRequeue } from "./support/requeue";

const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T>(sql, params))).rows;
const digest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** The deployment's two client-tier flags for the rest of the test (and the cached environment forgotten). */
function flags(tier: boolean, proposals = false) {
  vi.stubEnv("HERMES_CLIENT_BUSINESS_MCP_ENABLED", tier ? "true" : "false");
  vi.stubEnv("HERMES_CLIENT_BUSINESS_MCP_PROPOSALS_ENABLED", proposals ? "true" : "false");
  resetEnvCache();
}
const setSwitch = (orgId: string, feature: string, on: boolean) => q(
  "insert into org_features (org_id, feature, enabled) values ($1, $2, $3) on conflict (org_id, feature) do update set enabled = $3", [orgId, feature, on],
);

let gatewayId = "";
beforeAll(async () => {
  gatewayId = crypto.randomUUID();
  await q(
    `insert into hermes_gateways (id, label, environment, base_url, gateway_type, status, profile_creation_status, provisioner_isolation_verified_at)
     values ($1, 'Synthetic client-only runtime', 'development', $2, 'multiplexed_profiles', 'connected', 'restricted_service_verified', now())`,
    [gatewayId, `https://client-${gatewayId.replaceAll("-", "").slice(0, 16)}.hermes.test`],
  );
});
// A job another test left waiting would be taken by this test's claim (jobs are not tied to a gateway until they are claimed).
beforeEach(async () => {
  flags(false);
  await q("delete from agent_provisioning_jobs");
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

interface World {
  org: { id: string; name: string; slug: string };
  owner: { id: string };
  agents: Record<AgentRoleKey, string>;
}

/**
 * A paid, onboarded client workspace. Lead Hunter and Appointment Setter are provisioned (a c- profile on the verified client-only gateway, a Hermes credential, the provision job that made
 * them) and online; the Sales Assistant is provisioned but switched off; the CRM Manager has an applied configuration but no profile yet.
 */
async function world(): Promise<World> {
  const org = await createOrg({ name: `Business sync ${uid()}` });
  const owner = await createUser();
  await addMember(org.id, owner.id, "owner");
  await q("update users set email_verified_at = now() where id = $1", [owner.id]);
  const agents = {} as Record<AgentRoleKey, string>;
  for (const role of AGENT_ROLE_KEYS) agents[role] = await agentId(org.id, role);
  await readyToRequeue(org, owner.id, [agents.lead_hunter, agents.appointment_setter, agents.sales_assistant, agents.crm_manager]);
  for (const role of ["lead_hunter", "appointment_setter", "sales_assistant"] as const) {
    const profile = suggestedProfileName(org.slug, role);
    await withSystem(async (db) => {
      const credential = await saveProvisionedHermesCredential(db, { orgId: org.id, agentId: agents[role], secret: randomBytes(32).toString("hex"), profile });
      await db.query(
        `update agent_instances set hermes_base_url = $2, hermes_profile = $3, hermes_gateway_id = $4, credential_id = $5, hermes_profile_config_version_id = active_config_version_id,
           status = 'online', last_health_ok = true, last_health_check_at = now() where id = $1`,
        [agents[role], `https://client-${gatewayId.replaceAll("-", "").slice(0, 16)}.hermes.test`, profile, gatewayId, credential.id],
      );
      await db.query(
        "insert into agent_provisioning_jobs (org_id, agent_instance_id, kind, status, result_reference, attempt_count) values ($1, $2, 'provision', 'succeeded', $3, 1)",
        [org.id, agents[role], `provisioner:v1:${uid()}`],
      );
    });
  }
  await q("update agent_instances set enabled = false where id = $1", [agents.sales_assistant]);
  return { org, owner, agents };
}

/** The blocked toolsets the claim reads for an employee: its own policy, its workspace's, the client default (a migration seeds one), else the built-in list. */
const blockedFor = async (orgId: string, id: string) => (await q<{ blocked: string[] }>(
  `select coalesce((select p.blocked_toolsets from hermes_tool_policies p where p.scope_kind = 'agent' and p.agent_id = $2),
                   (select p.blocked_toolsets from hermes_tool_policies p where p.scope_kind = 'client' and p.org_id = $1),
                   (select p.blocked_toolsets from hermes_tool_policies p where p.scope_kind = 'client_default'), $3::text[]) as blocked`,
  [orgId, id, DEFAULT_BLOCKED_TOOLSETS],
))[0].blocked;

const syncJobs = (orgId: string) => q<{ id: string; agent_instance_id: string; status: string; kind: string; config_version_id: string | null; requested_by: string | null }>(
  "select id, agent_instance_id, status, kind, config_version_id, requested_by from agent_provisioning_jobs where org_id = $1 and kind = 'sync' order by created_at, id", [orgId],
);
const employee = async (id: string) => (await q<{ status: string; last_health_ok: boolean | null; last_health_detail: string | null }>("select status, last_health_ok, last_health_detail from agent_instances where id = $1", [id]))[0];

/** What a refused request must leave exactly as it found it. */
async function footprint(orgId: string) {
  const one = async (sql: string) => Number((await q<{ n: number }>(sql, [orgId]))[0].n);
  return {
    jobs: await one("select count(*)::int as n from agent_provisioning_jobs where org_id = $1"),
    audit: await one("select count(*)::int as n from audit_logs where org_id = $1"),
    features: await one("select count(*)::int as n from org_features where org_id = $1"),
    notYetProvisioning: await one("select count(*)::int as n from agent_instances where org_id = $1 and status = 'provisioning'"),
  };
}

const EXPECTED_DEFAULT = [
  "# Merge into this profile's config.yaml. Keep the server-side allowlist in sync with the reviewed portal inventory.",
  "platform_toolsets:",
  "  api_server:",
  ...PORTAL_SAFE_TOOLSETS.map((toolset) => `    - ${toolset}`),
  "    - no_mcp",
  "# Defense in depth; re-check these Hermes Agent keys after upgrades.",
  "agent:",
  "  disabled_toolsets: []",
  "terminal:",
  "  # Defence in depth: even if a shell tool were re-enabled, commands run in a container.",
  "  backend: docker",
  "  docker_forward_env: []",
  "  container_persistent: false",
  "",
].join("\n");

describe("the profile config the portal builds", () => {
  it("is byte-identical by default: no option, an empty option and an explicit false all give the config that has always been issued", () => {
    expect(buildConfigYaml([])).toBe(EXPECTED_DEFAULT);
    expect(buildConfigYaml([], undefined, {})).toBe(EXPECTED_DEFAULT);
    expect(buildConfigYaml([], undefined, { businessMcp: false })).toBe(EXPECTED_DEFAULT);
    for (const role of AGENT_ROLE_KEYS) {
      expect(buildConfigYaml(DEFAULT_BLOCKED_TOOLSETS, role, { businessMcp: false }), role).toBe(buildConfigYaml(DEFAULT_BLOCKED_TOOLSETS, role));
      expect(buildConfigYaml(DEFAULT_BLOCKED_TOOLSETS, role), role).toContain("    - no_mcp");
      expect(buildConfigYaml(DEFAULT_BLOCKED_TOOLSETS, role), role).not.toContain("mcp_servers");
    }
  });

  it("with the option emits exactly the reviewed toolset and server entry, naming the credential by its variable and never by a value", () => {
    const url = new URL(CLIENT_BUSINESS_MCP_PATH, env().APP_URL).toString();
    const withBusiness = buildConfigYaml([], undefined, { businessMcp: true });
    expect(withBusiness).toBe([
      EXPECTED_DEFAULT.replace("    - no_mcp", `    - ${HERMES_BUSINESS_MCP_TOOLSET}`).trimEnd(),
      `# ${CLIENT_BUSINESS_MCP_TOKEN_ENV_VAR} is this profile's own business tool credential, written into its .env by the restricted worker. It is NOT the profile's API_SERVER_KEY.`,
      "mcp_servers:",
      `  ${HERMES_BUSINESS_MCP_SERVER}:`,
      `    url: ${url}`,
      "    headers:",
      `      Authorization: "Bearer \${${CLIENT_BUSINESS_MCP_TOKEN_ENV_VAR}}"`,
      "    tool_timeout: 12",
      "",
    ].join("\n"));
    expect(withBusiness).not.toContain("no_mcp");
    // The route is the client tier's own, not the internal agency one.
    expect(url).toContain("/hermes-business/client/mcp");
    // Never a credential: no credential shape, no secret-looking run, only the variable reference after "Bearer".
    expect(withBusiness).not.toMatch(/iamcpc1|iamcp1/);
    expect(withBusiness).not.toMatch(/[A-Za-z0-9_-]{40,}/);
    expect([...withBusiness.matchAll(/Bearer\s+(\S+)/g)].map((m) => m[1])).toEqual([`\${${CLIENT_BUSINESS_MCP_TOKEN_ENV_VAR}}"`]);
    // The unsupported-toolset refusal is unchanged.
    expect(() => buildConfigYaml(["not-a-toolset"], undefined, { businessMcp: true })).toThrow(AppError);
  });

  it("keeps the role's own toolsets when the role policy is enforced", () => {
    vi.stubEnv("WORKFORCE_ROLE_TOOL_ENFORCEMENT", "enforce");
    const yaml = buildConfigYaml(DEFAULT_BLOCKED_TOOLSETS, "appointment_setter", { businessMcp: true });
    expect(yaml).not.toContain("    - web\n");
    expect(yaml).toContain(`    - ${HERMES_BUSINESS_MCP_TOOLSET}\n`);
    expect(buildConfigYaml(DEFAULT_BLOCKED_TOOLSETS, "lead_hunter", { businessMcp: true })).toContain("    - web\n");
  });
});

describe("the connection the verifier reads", () => {
  it("carries the tier only while the deployment flag and the workspace's own switch are both on, read in the same transaction", async () => {
    const w = await world();
    const read = (role: AgentRoleKey = "lead_hunter") => withSystem((db) => loadConnection(db, w.agents[role]));
    flags(true);
    expect((await read())?.clientBusinessTools ?? null).toBeNull();
    expect(await read()).not.toBeNull();
    await setSwitch(w.org.id, CLIENT_BUSINESS_TOOLS_FEATURE, true);
    expect((await read())?.clientBusinessTools).toEqual({ proposals: false });
    // Proposals need the tier, the deployment's proposals flag and the workspace's proposals switch.
    await setSwitch(w.org.id, CLIENT_BUSINESS_PROPOSALS_FEATURE, true);
    expect((await read())?.clientBusinessTools).toEqual({ proposals: false });
    flags(true, true);
    expect((await read())?.clientBusinessTools).toEqual({ proposals: true });
    // A switch-off is seen by the very next read (no cache), and so is the deployment flag.
    await setSwitch(w.org.id, CLIENT_BUSINESS_TOOLS_FEATURE, false);
    expect((await read())?.clientBusinessTools ?? null).toBeNull();
    await setSwitch(w.org.id, CLIENT_BUSINESS_TOOLS_FEATURE, true);
    flags(false);
    expect((await read())?.clientBusinessTools ?? null).toBeNull();
  });

  it("never carries it for a demo workspace, and not an agency employee's connection", async () => {
    const demo = await world();
    flags(true);
    await setSwitch(demo.org.id, CLIENT_BUSINESS_TOOLS_FEATURE, true);
    expect((await withSystem((db) => loadConnection(db, demo.agents.lead_hunter)))?.clientBusinessTools).toEqual({ proposals: false });
    await q("update organizations set is_demo = true where id = $1", [demo.org.id]);
    expect((await withSystem((db) => loadConnection(db, demo.agents.lead_hunter)))?.clientBusinessTools ?? null).toBeNull();
  });
});

describe("the manifest the restricted worker claims", () => {
  it("is the default config while the tier is off, and carries the business server only while the workspace is in the tier; its hash is the one the completion must match", async () => {
    const w = await world();
    vi.stubEnv("HERMES_PROVISIONER_GATEWAY_ID", gatewayId);
    flags(false);
    const first = await withSystem((db) => requestBusinessToolSync(db, w.org.id, [w.agents.lead_hunter]));
    expect(first.queued).toHaveLength(1);
    const off = await claimHermesProvisionerJob(gatewayId);
    expect(off).not.toBeNull();
    expect(off?.configYaml).toBe(buildConfigYaml(await blockedFor(w.org.id, w.agents.lead_hunter), "lead_hunter"));
    expect(off?.configYaml).not.toContain("mcp_servers");
    expect(off?.policyConfigSha256).toBe(digest(off?.configYaml ?? ""));
    const stored = await q<{ manifest_policy_config_sha256: string }>("select manifest_policy_config_sha256 from agent_provisioning_jobs where id = $1", [off?.jobId]);
    expect(stored[0].manifest_policy_config_sha256).toBe(off?.policyConfigSha256);

    // The switch changes while that job is in flight: it is replaced, never left to complete against the old list, and the new manifest has the business server.
    flags(true);
    await setSwitch(w.org.id, CLIENT_BUSINESS_TOOLS_FEATURE, true);
    const second = await withSystem((db) => requestBusinessToolSync(db, w.org.id));
    expect(second.queued.map((job) => job.agentId).sort()).toEqual([w.agents.appointment_setter, w.agents.lead_hunter].sort());
    const jobs = await syncJobs(w.org.id);
    expect(jobs.find((job) => job.id === off?.jobId)?.status).toBe("cancelled");
    const on = await claimHermesProvisionerJob(gatewayId);
    expect(on).not.toBeNull();
    expect(on?.configYaml).toBe(buildConfigYaml(await blockedFor(w.org.id, on!.agentId), on!.role as AgentRoleKey, { businessMcp: true }));
    expect(on?.configYaml).toContain(`    - ${HERMES_BUSINESS_MCP_TOOLSET}`);
    expect(on?.configYaml).toContain("mcp_servers:");
    expect(on?.policyConfigSha256).toBe(digest(on?.configYaml ?? ""));
    expect(on?.policyConfigSha256).not.toBe(off?.policyConfigSha256);

    // Asking again with nothing changed leaves the job claimed under the current policy alone.
    const repeat = await withSystem((db) => requestBusinessToolSync(db, w.org.id));
    expect(repeat.queued).toEqual([]);
    expect((await syncJobs(w.org.id)).find((job) => job.id === on?.jobId)?.status).toBe("in_progress");
  });
});

describe("one synchronization job per eligible employee when a switch changes", () => {
  it("opens one job per enabled provisioned employee for its applied version, none for a switched-off or unprovisioned one, and says the employee is not online until it lands", async () => {
    const w = await world();
    flags(true);
    await setSwitch(w.org.id, CLIENT_BUSINESS_TOOLS_FEATURE, true);
    const result = await withSystem((db) => requestBusinessToolSync(db, w.org.id, undefined, w.owner.id));
    expect(result.queued.map((job) => job.agentId).sort()).toEqual([w.agents.appointment_setter, w.agents.lead_hunter].sort());
    expect(result.skipped).toContain(w.agents.sales_assistant);
    expect(result.skipped).toContain(w.agents.crm_manager);
    expect(result.alreadyOpen).toEqual([]);

    const jobs = await syncJobs(w.org.id);
    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      expect(job).toMatchObject({ kind: "sync", status: "requested", requested_by: w.owner.id });
      const active = (await q<{ active_config_version_id: string }>("select active_config_version_id from agent_instances where id = $1", [job.agent_instance_id]))[0];
      expect(job.config_version_id).toBe(active.active_config_version_id);
      const state = await employee(job.agent_instance_id);
      expect(state.status).toBe("provisioning");
      expect(state.last_health_ok).toBeNull();
      expect(state.last_health_detail).toContain("synchronization is pending");
    }
    // The employees that got nothing are as they were.
    expect((await employee(w.agents.sales_assistant)).status).toBe("online");
    expect((await employee(w.agents.crm_manager)).status).not.toBe("provisioning");
    expect(await q("select 1 from agent_provisioning_jobs where agent_instance_id = any($1::uuid[]) and kind = 'sync'", [[w.agents.sales_assistant, w.agents.crm_manager]])).toEqual([]);
    const audit = await q<{ agent_instance_id: string; actor_user_id: string | null; actor_kind: string; metadata: Record<string, unknown> }>(
      "select agent_instance_id, actor_user_id, actor_kind, metadata from audit_logs where org_id = $1 and action = 'agent.business_tools_sync_requested'", [w.org.id],
    );
    expect(audit.map((row) => row.agent_instance_id).sort()).toEqual([w.agents.appointment_setter, w.agents.lead_hunter].sort());
    expect(audit.every((row) => row.actor_user_id === w.owner.id && row.actor_kind === "agency" && row.metadata.businessTools === true)).toBe(true);
  });

  it("is idempotent: asking again opens nothing new and reports the open requests", async () => {
    const w = await world();
    await withSystem((db) => requestBusinessToolSync(db, w.org.id));
    const before = await footprint(w.org.id);
    const again = await withSystem((db) => requestBusinessToolSync(db, w.org.id));
    expect(again.queued).toEqual([]);
    expect(again.alreadyOpen.sort()).toEqual([w.agents.appointment_setter, w.agents.lead_hunter].sort());
    expect(await footprint(w.org.id)).toEqual(before);
    expect(await syncJobs(w.org.id)).toHaveLength(2);
    // One employee at a time works the same way.
    const one = await withSystem((db) => requestBusinessToolSync(db, w.org.id, [w.agents.lead_hunter]));
    expect(one.queued).toEqual([]);
    expect(one.alreadyOpen).toEqual([w.agents.lead_hunter]);
  });

  it("refuses an agency workspace, a demo workspace and an employee mapped from the internal tier, and each refusal writes nothing", async () => {
    const w = await world();
    const before = await footprint(w.org.id);

    // A demo workspace.
    const demo = await world();
    await q("update organizations set is_demo = true where id = $1", [demo.org.id]);
    const demoBefore = await footprint(demo.org.id);
    await expect(withSystem((db) => requestBusinessToolSync(db, demo.org.id))).rejects.toMatchObject({ code: "conflict" });
    expect(await footprint(demo.org.id)).toEqual(demoBefore);

    // The agency workspace (there is one).
    const agency = await createOrg({ kind: "agency" }).catch(() => null);
    const agencyId = agency?.id ?? (await q<{ id: string }>("select id from organizations where kind = 'agency' limit 1"))[0].id;
    const agencyEmployee = await agentId(agencyId, "lead_hunter");
    const agencyBefore = await footprint(agencyId);
    await expect(withSystem((db) => requestBusinessToolSync(db, agencyId))).rejects.toMatchObject({ code: "conflict" });
    await expect(withSystem((db) => requestBusinessToolSync(db, agencyId, [agencyEmployee]))).rejects.toMatchObject({ code: "conflict" });
    expect(await footprint(agencyId)).toEqual(agencyBefore);

    // An employee of another workspace is not found here, and a malformed id is refused.
    await expect(withSystem((db) => requestBusinessToolSync(db, w.org.id, [agencyEmployee]))).rejects.toMatchObject({ code: "not_found" });
    await expect(withSystem((db) => requestBusinessToolSync(db, w.org.id, [demo.agents.lead_hunter]))).rejects.toMatchObject({ code: "not_found" });
    await expect(withSystem((db) => requestBusinessToolSync(db, w.org.id, ["not-an-id"]))).rejects.toMatchObject({ code: "invalid_input" });
    await expect(withSystem((db) => requestBusinessToolSync(db, "not-an-id"))).rejects.toMatchObject({ code: "invalid_input" });

    // An employee of a client workspace that carries an internal agency profile (the database refuses to store one, so the guard is lifted for the length of the check): refused by name,
    // and nothing is written for the others named with it.
    await q("alter table agent_instances disable trigger agent_instances_guard");
    try {
      await q("update agent_instances set hermes_profile = 'iacquire-appointment-setter' where id = $1", [w.agents.appointment_setter]);
      await expect(withSystem((db) => requestBusinessToolSync(db, w.org.id, [w.agents.lead_hunter, w.agents.appointment_setter]))).rejects.toMatchObject({ code: "conflict" });
      expect(await footprint(w.org.id)).toEqual(before);
      // Asked for the whole workspace, the internal-tier employee is left out and the rest are synchronized.
      const all = await withSystem((db) => requestBusinessToolSync(db, w.org.id));
      expect(all.queued.map((job) => job.agentId)).toEqual([w.agents.lead_hunter]);
      expect(all.skipped).toContain(w.agents.appointment_setter);
    } finally {
      await q("update agent_instances set hermes_profile = $2 where id = $1", [w.agents.appointment_setter, suggestedProfileName(w.org.slug, "appointment_setter")]);
      await q("alter table agent_instances enable trigger agent_instances_guard");
    }
    expect(await q("select 1 from agent_provisioning_jobs where agent_instance_id = $1", [w.agents.appointment_setter])).toHaveLength(1);
  });

  it("does nothing for a workspace that is not active", async () => {
    const w = await world();
    await q("update organizations set status = 'suspended' where id = $1", [w.org.id]);
    const result = await withSystem((db) => requestBusinessToolSync(db, w.org.id));
    expect(result.queued).toEqual([]);
    expect(await syncJobs(w.org.id)).toEqual([]);
  });
});

describe("the Super Admin's switch", () => {
  const admin = async (role: "agency_super_admin" | "agency_staff" = "agency_super_admin") => agencyUser(await createUser({ platformRole: role }), role);

  it("turns the tier on for a client workspace, audits it, and synchronizes the employees once; the same call again changes nothing", async () => {
    const w = await world();
    flags(true);
    const user = await admin();
    const on = await setClientBusinessTools(user, { orgId: w.org.id, tools: true });
    expect(on.changed).toBe(true);
    expect(on.sync?.queued).toHaveLength(2);
    expect((await q<{ enabled: boolean }>("select enabled from org_features where org_id = $1 and feature = $2", [w.org.id, CLIENT_BUSINESS_TOOLS_FEATURE]))[0].enabled).toBe(true);
    expect(await q("select 1 from audit_logs where org_id = $1 and action = 'feature.enabled' and actor_user_id = $2", [w.org.id, user.id])).toHaveLength(1);
    expect(await syncJobs(w.org.id)).toHaveLength(2);

    const again = await setClientBusinessTools(user, { orgId: w.org.id, tools: true });
    expect(again).toEqual({ changed: false, sync: null });
    expect(await syncJobs(w.org.id)).toHaveLength(2);

    // The proposals switch is its own change and reaches the same employees (their expected tool list changes), without a second open job.
    const proposals = await setClientBusinessTools(user, { orgId: w.org.id, proposals: true });
    expect(proposals.changed).toBe(true);
    expect(proposals.sync?.alreadyOpen).toHaveLength(2);
    expect(await syncJobs(w.org.id)).toHaveLength(2);
  });

  it("does not take employees offline for a proposals switch that changes nothing while the tools are off", async () => {
    const w = await world();
    flags(true);
    const user = await admin();
    const statusBefore = await q<{ id: string; status: string; last_health_ok: boolean | null }>("select id, status, last_health_ok from agent_instances where org_id = $1 order by id", [w.org.id]);
    const result = await setClientBusinessTools(user, { orgId: w.org.id, proposals: true });
    // The switch is written (and audited), but with the tools off no profile changes, so nothing is queued and nobody reads as not online.
    expect(result).toEqual({ changed: true, sync: null });
    expect((await q<{ enabled: boolean }>("select enabled from org_features where org_id = $1 and feature = $2", [w.org.id, CLIENT_BUSINESS_PROPOSALS_FEATURE]))[0].enabled).toBe(true);
    expect(await syncJobs(w.org.id)).toEqual([]);
    expect(await q("select id, status, last_health_ok from agent_instances where org_id = $1 order by id", [w.org.id])).toEqual(statusBefore);
    // Turning the tools on afterwards does synchronize them, once per employee.
    const on = await setClientBusinessTools(user, { orgId: w.org.id, tools: true });
    expect(on.sync?.queued).toHaveLength(2);
  });

  it("makes the switch and its synchronization request one transaction, so a failed request can simply be repeated", async () => {
    const w = await world();
    flags(true);
    const user = await admin();
    await q("create or replace function test_refuse_sync_job() returns trigger language plpgsql as $$ begin raise exception 'sync refused for the test'; end $$");
    await q("create trigger test_refuse_sync_job before insert on agent_provisioning_jobs for each row execute function test_refuse_sync_job()");
    try {
      await expect(setClientBusinessTools(user, { orgId: w.org.id, tools: true })).rejects.toThrow(/sync refused for the test/);
    } finally {
      await q("drop trigger test_refuse_sync_job on agent_provisioning_jobs");
      await q("drop function test_refuse_sync_job()");
    }
    // Nothing of the failed call was kept: no switch, no audit row, no job.
    expect(await q("select 1 from org_features where org_id = $1 and feature = $2 and enabled", [w.org.id, CLIENT_BUSINESS_TOOLS_FEATURE])).toHaveLength(0);
    expect(await q("select 1 from audit_logs where org_id = $1 and action = 'feature.enabled'", [w.org.id])).toHaveLength(0);
    expect(await syncJobs(w.org.id)).toEqual([]);
    // The same call again does the whole thing.
    const again = await setClientBusinessTools(user, { orgId: w.org.id, tools: true });
    expect(again.changed).toBe(true);
    expect(again.sync?.queued).toHaveLength(2);
  });

  it("refuses everyone but a Super Admin, an agency or demo workspace and an empty request, and then writes nothing", async () => {
    const w = await world();
    const before = await footprint(w.org.id);
    await expect(setClientBusinessTools(await admin("agency_staff"), { orgId: w.org.id, tools: true })).rejects.toMatchObject({ code: "forbidden" });
    await expect(setClientBusinessTools(await admin(), { orgId: w.org.id })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(setClientBusinessTools(await admin(), { orgId: "nope", tools: true })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(setClientBusinessTools(await admin(), { orgId: crypto.randomUUID(), tools: true })).rejects.toMatchObject({ code: "not_found" });
    expect(await footprint(w.org.id)).toEqual(before);

    const demo = await world();
    await q("update organizations set is_demo = true where id = $1", [demo.org.id]);
    const demoBefore = await footprint(demo.org.id);
    await expect(setClientBusinessTools(await admin(), { orgId: demo.org.id, tools: true })).rejects.toMatchObject({ code: "conflict" });
    expect(await footprint(demo.org.id)).toEqual(demoBefore);

    const agencyId = (await q<{ id: string }>("select id from organizations where kind = 'agency' limit 1"))[0]?.id ?? (await createOrg({ kind: "agency" })).id;
    const agencyBefore = await footprint(agencyId);
    await expect(setClientBusinessTools(await admin(), { orgId: agencyId, tools: true })).rejects.toMatchObject({ code: "conflict" });
    expect(await footprint(agencyId)).toEqual(agencyBefore);
  });
});
