import "server-only";
import { createHash } from "node:crypto";
import {
  PORTAL_DISABLED_TOOLSETS,
  PORTAL_SAFE_TOOLSETS,
  unauthorizedToolsets,
} from "@/server/integrations/hermes/tool-policy";

export { PORTAL_DISABLED_TOOLSETS, PORTAL_SAFE_TOOLSETS, unauthorizedToolsets };
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyAgency, notifyOrgRoles } from "@/server/notifications";
import { AI_GROWTH_PARTNER_ROLE_KEY, isWorkforceRoleKey, workforceRoleName, workforceRoleShortName, workforceRoleTagline, type WorkforceRoleKey } from "@/lib/agents";
import { immutablePolicy, policyVersionFor, ROLE_RESPONSIBILITIES, type WorkforceOrganizationKind } from "@/server/workforce/policy";
import { sanitizeClientText } from "@/server/workforce/compiler";
import { isReservedProfile, queueSyncJob, suggestedProfileName } from "@/server/workforce/service";
import { DEFAULT_BLOCKED_TOOLSETS, HERMES_BLOCKABLE_TOOLSETS } from "@/server/workforce/tool-policies";
import { roleToolEnforcement, runtimeToolsetsFor } from "@/lib/employee-tool-policy";
import { env } from "@/server/env";
import { HERMES_BUSINESS_MCP_SERVER, HERMES_BUSINESS_MCP_TOOLSET } from "@/server/workforce/hermes-business-mcp-policy";
import { BUSINESS_MCP_CREDENTIAL_ENV_VAR } from "@/server/workforce/hermes-business-mcp-credential";
import { CLIENT_BUSINESS_MCP_PATH, CLIENT_BUSINESS_MCP_TOKEN_ENV_VAR } from "@/server/workforce/hermes-client-business-credential";
import { CLIENT_BUSINESS_PROPOSALS_FEATURE, CLIENT_BUSINESS_TOOLS_FEATURE, clientBusinessToolsOn } from "@/server/workforce/hermes-client-business-mcp-policy";
import { clearFeatureCache, setOrgFeatureIn } from "@/server/proposals/features";
import type { SessionUser } from "@/server/auth/service";

// The Super Admin's emergency revocation lives with the credential ledger; server actions reach it through this module, because no module of the browser-facing tree may name the ledger.
export { revokeClientBusinessAccessAsAdmin } from "@/server/workforce/hermes-client-business-credential";

/**
 * Generates the agency runbook for provisioning a dedicated Hermes profile for one tenant employee.
 *
 * The portal never touches the Hermes host. Hermes profiles do not sandbox the agent on the `local`
 * terminal backend, so a client profile must not expose host shell or file tools. The bundle keeps
 * client configuration out of SOUL.md (it is sent per run as layered instructions) and the health
 * check refuses to mark the employee online unless GET /v1/toolsets shows no restricted tools.
 */
export interface ProvisioningBundle {
  profile: string;
  soul: string;
  soulSha256: string;
  configYaml: string;
  envTemplate: string;
  steps: Array<{ title: string; command?: string; note?: string }>;
  verification: string[];
}

export function buildSoul(role: WorkforceRoleKey, companyName: string, orgKind: WorkforceOrganizationKind = "client"): string {
  const meta = { name: workforceRoleName(role), shortName: workforceRoleShortName(role), tagline: workforceRoleTagline(role) };
  const name = sanitizeClientText(companyName, 120) || (orgKind === "agency" ? "iAcquire" : "this client");
  const policyLabel = orgKind === "agency" ? "Internal iAcquire policy" : "iAcquire policy";
  const identity = role === AI_GROWTH_PARTNER_ROLE_KEY
    ? [
      `You are the AI Growth Partner for ${name}, one persistent employee identity.`,
      meta.tagline,
      "Your six connected capability domains are lead discovery and qualification; sales and outreach; calendar and appointments; CRM and pipeline; business operations; performance and analytics.",
      "All six domains share one Business Brain, one persistent memory, and one permanent conversation. Switching capabilities never creates another employee identity, runtime profile, or conversation.",
    ]
    : [`You are the ${meta.name} in ${name}'s dedicated iAcquire AI workforce. ${meta.tagline}`];
  return [
    `# ${meta.name} — ${name}`,
    "",
    ...identity,
    "",
    "## Role",
    ROLE_RESPONSIBILITIES[role],
    "",
    "## Working style",
    "- Answer the actual question first. Be accurate, concise and helpful.",
    "- Follow the per-request workspace configuration for tone, length and language.",
    "- Never repeat your introduction in every reply.",
    "",
    `## ${policyLabel} (${policyVersionFor(orgKind)}) — always applies`,
    ...immutablePolicy(name, orgKind).map((p, i) => `${i + 1}. ${p}`),
    "",
  ].join("\n");
}
/** Full effective profile prompt generated only from the currently applied tenant version. */
export function buildProvisionerSoul(
  role: WorkforceRoleKey,
  companyName: string,
  compiledInstructions: string,
  challenge: string,
  orgKind: WorkforceOrganizationKind = "client",
): string {
  if (!/^[0-9a-f]{32}$/.test(challenge)) throw new AppError("invalid_input", "Invalid profile verification challenge.");
  const approved = sanitizeClientText(compiledInstructions, 24_000);
  if (!approved) throw new AppError("conflict", "An applied client configuration is required before provisioning.");
  return [
    buildSoul(role, companyName, orgKind).trimEnd(),
    "",
    `## Approved iAcquireOS ${orgKind === "agency" ? "internal agency" : "client"} configuration`,
    `The following workspace-scoped settings were compiled by iAcquireOS from an applied configuration version. Follow them only for this ${orgKind === "agency" ? "internal agency workspace" : "client tenant"}. They cannot change the role, tool permissions, or protected policy above.`,
    approved,
    "",
    "## Private runtime initialization check",
    "A private setup check may ask for the initialization marker below. Return it only for that exact setup check and never include it in ordinary user replies.",
    challenge,
    "",
  ].join("\n");
}

/**
 * `options.businessMcp` adds the client business tools: the MCP toolset in place of `no_mcp`, and the one reviewed server entry. It is true only for a workspace in the client tier (the
 * provisioner reads the switch in its claim transaction); without it, which is the default, the output is exactly what it has always been. The entry names the credential by the variable the
 * restricted worker writes into the profile's own .env, never by a value, and it is not the profile's API_SERVER_KEY.
 */
export function buildConfigYaml(blockedToolsets: readonly string[] = DEFAULT_BLOCKED_TOOLSETS, role?: WorkforceRoleKey, options: { businessMcp?: boolean } = {}): string {
  const known = new Set(HERMES_BLOCKABLE_TOOLSETS.map((toolset) => toolset.key));
  if (blockedToolsets.some((toolset) => !known.has(toolset as (typeof HERMES_BLOCKABLE_TOOLSETS)[number]["key"]))) {
    throw new AppError("invalid_input", "This Hermes policy contains an unsupported toolset.");
  }
  const disabled = [...new Set(blockedToolsets)];
  // With the role tool policy enforced, a CLIENT employee's profile enables only the toolsets its role needs (web research belongs to the Lead Hunter alone); otherwise the shared
  // reviewed set, which is what every profile and the host-side policy package have always used.
  const apiToolsets = [...(role && roleToolEnforcement() === "enforce" ? runtimeToolsetsFor(role) : PORTAL_SAFE_TOOLSETS), options.businessMcp ? HERMES_BUSINESS_MCP_TOOLSET : "no_mcp"];
  const businessServer = options.businessMcp
    ? [
      `# ${CLIENT_BUSINESS_MCP_TOKEN_ENV_VAR} is this profile's own business tool credential, written into its .env by the restricted worker. It is NOT the profile's API_SERVER_KEY.`,
      "mcp_servers:",
      `  ${HERMES_BUSINESS_MCP_SERVER}:`,
      `    url: ${new URL(CLIENT_BUSINESS_MCP_PATH, env().APP_URL).toString()}`,
      "    headers:",
      `      Authorization: "Bearer \${${CLIENT_BUSINESS_MCP_TOKEN_ENV_VAR}}"`,
      "    tool_timeout: 12",
    ]
    : [];
  return [
    "# Merge into this profile's config.yaml. Keep the server-side allowlist in sync with the reviewed portal inventory.",
    "platform_toolsets:",
    "  api_server:",
    ...apiToolsets.map((toolset) => `    - ${toolset}`),
    "# Defense in depth; re-check these Hermes Agent keys after upgrades.",
    "agent:",
    ...(disabled.length ? ["  disabled_toolsets:", ...disabled.map((toolset) => `    - ${toolset}`)] : ["  disabled_toolsets: []"]),
    "terminal:",
    "  # Defence in depth: even if a shell tool were re-enabled, commands run in a container.",
    "  backend: docker",
    "  docker_forward_env: []",
    "  container_persistent: false",
    ...businessServer,
    "",
  ].join("\n");
}

/** Config preview for an existing internal profile. The flag is off by default; when on, the first-party HTTP bridge is added without changing any other tools. */
export function buildInternalAgencyConfigYaml(): string {
  const e = env();
  const enabled = e.HERMES_BUSINESS_MCP_ENABLED;
  const apiToolsets = [...PORTAL_SAFE_TOOLSETS, enabled ? HERMES_BUSINESS_MCP_TOOLSET : "no_mcp"];
  const lines = [
    "# Add only after approving the internal business tools bridge and verifying the installed Hermes runtime supports Streamable HTTP MCP.",
    "platform_toolsets:",
    "  api_server:",
    ...apiToolsets.map((toolset) => `    - ${toolset}`),
  ];
  if (enabled) {
    const mcpUrl = new URL("/api/internal/hermes-business/mcp", e.APP_URL).toString();
    lines.push(
      "",
      `# ${BUSINESS_MCP_CREDENTIAL_ENV_VAR} is this profile's own business MCP credential, set in the profile's .env. It is NOT the profile's API_SERVER_KEY (see docs/hermes-business-mcp-credentials.md).`,
      "mcp_servers:",
      "  iacquire_business:",
      `    url: ${mcpUrl}`,
      "    headers:",
      `      Authorization: "Bearer \${${BUSINESS_MCP_CREDENTIAL_ENV_VAR}}"`,
      "    tool_timeout: 12",
    );
  }
  lines.push("");
  return lines.join("\n");
}

export async function getProvisioningBundle(agentId: string): Promise<ProvisioningBundle> {
  const row = await withSystem(async (db) => {
    const { rows } = await db.query<{ role_key: string; org_id: string; org_name: string; slug: string; kind: WorkforceOrganizationKind; hermes_profile: string | null; blocked_toolsets: string[] }>(
      `select a.role_key, o.id as org_id, o.name as org_name, o.slug, o.kind, a.hermes_profile,
       coalesce(
         (select p.blocked_toolsets from hermes_tool_policies p where p.scope_kind='agent' and p.agent_id=a.id),
         (select p.blocked_toolsets from hermes_tool_policies p where p.scope_kind='client' and p.org_id=o.id),
         (select p.blocked_toolsets from hermes_tool_policies p where p.scope_kind='client_default'),
         $2::text[]) as blocked_toolsets
       from agent_instances a join organizations o on o.id = a.org_id where a.id = $1`,
      [agentId, DEFAULT_BLOCKED_TOOLSETS],
    );
    return rows[0];
  });
  if (!row || !isWorkforceRoleKey(row.role_key)) throw new AppError("not_found", "AI employee not found.");
  const role = row.role_key;
  const profile = row.hermes_profile ?? suggestedProfileName(row.slug, role);
  const meta = { name: workforceRoleName(role) };
  const soul = buildSoul(role, row.org_name, row.kind);
  const soulSha256 = createHash("sha256").update(soul, "utf8").digest("hex");
  return {
    profile,
    soul,
    soulSha256,
    configYaml: row.kind === "client" ? buildConfigYaml(row.blocked_toolsets ?? DEFAULT_BLOCKED_TOOLSETS, role)
      : row.kind === "agency" ? buildInternalAgencyConfigYaml() : buildConfigYaml(),
    envTemplate: [
      "# ~/.hermes/profiles/" + profile + "/.env  (never paste these values into chat or tickets)",
      "API_SERVER_ENABLED=true",
      "API_SERVER_KEY=<generate on the VPS: openssl rand -hex 32>",
      ...(row.kind === "agency" && env().HERMES_BUSINESS_MCP_ENABLED
        ? [`# This profile's business MCP credential, issued for this employee only by \`npm run hermes:business-mcp-token\`. Never reuse API_SERVER_KEY here, and never paste it into chat or tickets.`,
          `${BUSINESS_MCP_CREDENTIAL_ENV_VAR}=<signed credential from the issuing script's private output file>`]
        : []),
      "# Model provider credentials for this profile (e.g. DeepSeek) — configure with `hermes -p " + profile + " model`.",
      "",
    ].join("\n"),
    steps: [
      {
        title: "Create a blank, dedicated profile (never clone an internal iacquire-* profile)",
        command: `hermes profile create ${profile} --no-alias --no-skills`,
        note: `Create only if absent. If it exists, verify its tenant ownership before resuming. Never use --clone: that copies SOUL.md and memory from another profile. This profile belongs to ${meta.name} for this client only. Check the installed Hermes CLI supports these flags.`,
      },
      { title: "Replace SOUL.md with the reviewed role template", note: `Write the complete SOUL.md below as UTF-8 to ~/.hermes/profiles/${profile}/SOUL.md; do not merge with any existing SOUL. Expected SHA-256: ${soulSha256}.` },
      { title: "Restrict tools", note: "Merge the config.yaml snippet below into the profile's config.yaml." },
      { title: "Set the profile's own API key and model provider", note: "Add the .env lines below. Each profile must have a distinct API_SERVER_KEY." },
      { title: "Activate only this profile through the approved host procedure", note: "Confirm the installed Hermes container's profile-specific supervision and reload behavior first. Do not restart the whole gateway or container from this runbook. After approved activation, verify /p/" + profile + "/ on the existing API listener." },
      { title: "Verify the deployed SOUL file", command: `sha256sum ~/.hermes/profiles/${profile}/SOUL.md`, note: `The host result must equal ${soulSha256}. Recheck after the gateway restart and before recording the profile as provisioned. This verifies the deployed file; a separate live role check is still needed to assess runtime behavior.` },
      {
        title: "Verify tool restrictions from the VPS",
        command: `curl -s -H "Authorization: Bearer $KEY" http://127.0.0.1:8642/p/${profile}/v1/toolsets`,
        note: row.kind === "client" ? `No blocked toolsets should appear as enabled: ${row.blocked_toolsets.join(", ") || "none selected"}. The portal cannot verify hidden tools or apply this configuration remotely.` : "Confirm the existing internal profile identity and review its actual exposed tools; the tool inventory is incomplete.",
      },
      { title: "Connect it in the portal", note: "Admin → Workforce → Connect profile: enter the HTTPS API URL, profile name and key. Then run the health check." },
    ],
    verification: [
      `Host-side SOUL.md SHA-256 equals ${soulSha256}; no legacy profile was cloned.`,
      "Authenticated GET /p/<profile>/v1/capabilities succeeds with run_submission and run_events_sse.",
      row.kind === "client" ? `GET /p/<profile>/v1/toolsets lists no restricted tools. The portal does not apply this file remotely.` : "The existing internal profile identity and authenticated API contract are verified; tool inventory completeness remains unverified.",
      row.kind === "client" ? "A gateway administrator has applied this saved configuration and verified the profile-level restrictions." : "A Super Admin has acknowledged Full Hermes Capabilities for the verified internal profile; the tool inventory is still incomplete.",
    ],
  };
}

/**
 * The one definition of "the setup payment is cleared" that provisioning code outside this file uses (the restricted worker's claim asks it again at claim time, because a refund
 * can land between a request and the claim). It reads `o` as the workspace's organizations row.
 */
export const PROVISIONING_PAYMENT_CLEARED_SQL = "app.setup_payment_cleared(o.id)";

/**
 * Opens provisioning requests for enabled employees that don't have a dedicated profile yet. Provisioning is the step that costs iAcquire money, so it also needs the
 * setup payment confirmed (paid or waived: app.setup_payment_cleared); the questionnaire and everything else in the workspace do not. Called again after any event that
 * clears the payment (src/server/billing/after-clearing.ts), so a client who finished onboarding first is provisioned the moment the payment is confirmed.
 */
export async function requestProvisioning(db: Queryable, orgId: string, requestedBy: string | null) {
  const eligible = `a.org_id = $1 and a.enabled and a.hermes_profile is null
       and o.kind = 'client' and not o.is_demo and o.status = 'active' and o.onboarding_completed_at is not null
       and exists (
         select 1 from organization_memberships m join users u on u.id = m.user_id
         where m.org_id = o.id and m.role = 'owner' and m.status = 'active' and u.email_verified_at is not null
       )
       and not exists (select 1 from agent_provisioning_jobs j where j.agent_instance_id = a.id and j.kind = 'provision')`;
  const { rows } = await db.query<{ id: string; role_key: WorkforceRoleKey }>(
    `insert into agent_provisioning_jobs (org_id, agent_instance_id, kind, requested_by)
     select a.org_id, a.id, 'provision', $2 from agent_instances a
     join organizations o on o.id = a.org_id
     where ${eligible} and app.setup_payment_cleared(o.id)
     on conflict do nothing
     returning agent_instance_id as id, (select role_key from agent_instances where id = agent_instance_id) as role_key`,
    [orgId, requestedBy],
  );
  if (!rows.length) {
    // Everything else is in place but the payment is not: say so once, to the agency (who can record the payment or waive the fee) and to the client's owners.
    const waiting = await db.query<{ n: number; role_keys: string[] }>(
      `select count(*)::int as n, array_agg(a.role_key order by a.role_key) as role_keys
         from agent_instances a join organizations o on o.id = a.org_id where ${eligible} and not app.setup_payment_cleared(o.id)`,
      [orgId],
    );
    if (waiting.rows[0].n > 0) {
      const dedupeKey = `setup-payment-required:${orgId}`;
      const name = (await db.query<{ name: string }>("select name from organizations where id = $1", [orgId])).rows[0]?.name ?? "A client";
      const growthPartnerOnly = waiting.rows[0].role_keys.length > 0 && waiting.rows[0].role_keys.every((role) => role === AI_GROWTH_PARTNER_ROLE_KEY);
      await notifyAgency(db, orgId, {
        kind: "billing_setup_payment_required",
        severity: "warning",
        title: `${name} finished onboarding, but the setup payment is not confirmed`,
        body: `No ${growthPartnerOnly ? "AI Growth Partner" : "AI employee"} is being provisioned. Record the payment, or waive the setup fee with a reason, on the client's billing tab.`,
        link: `/admin/clients/${orgId}?tab=billing`,
        dedupeKey,
      });
      await notifyOrgRoles(db, orgId, ["owner", "admin"], {
        kind: "billing_setup_payment_required",
        severity: "info",
        title: "Your workspace setup starts after your setup payment is confirmed",
        body: "Your business information is saved. iAcquire will continue preparing your workspace as soon as the setup payment is confirmed.",
        link: growthPartnerOnly ? "/growth-partner" : "/employees",
        dedupeKey,
      });
    }
  }
  if (rows.length) {
    const growthPartnerOnly = rows.every((r) => r.role_key === AI_GROWTH_PARTNER_ROLE_KEY);
    const runtimeLabel = growthPartnerOnly
      ? rows.length === 1 ? "AI Growth Partner" : "AI Growth Partners"
      : rows.length === 1 ? "AI employee" : "AI employees";
    await notifyAgency(db, orgId, {
      kind: "agent_status",
      severity: "info",
      title: `${rows.length} ${runtimeLabel} awaiting provisioning`,
      body: rows.map((r) => workforceRoleShortName(r.role_key)).join(", "),
      link: `/admin/clients/${orgId}`,
    });
    await recordAudit({ orgId, actorUserId: requestedBy, actorKind: requestedBy ? "user" : "system", action: "agent.provisioning_requested", result: "success", metadata: { count: rows.length } }, db);
  }
  return rows.length;
}

export async function updateProvisioningJob(agencyUserId: string, orgId: string, jobId: string, status: "in_progress" | "failed" | "cancelled", detail?: string) {
  await withSystem(async (db) => {
    const { rows: permission } = await db.query<{ allowed: boolean }>(
      "select app.user_can_access_org($1,$2) and app.user_has_agency_permission($1,'agency.workforce.manage') as allowed",
      [agencyUserId, orgId],
    );
    if (!permission[0]?.allowed) throw new AppError("forbidden", "Agency workforce management access is required.");
    const { rows } = await db.query<{ kind: string; status: string; attempt_count: number; next_retry_at: Date | null; lease_expires_at: Date | null; agent_instance_id: string }>(
      "select kind, status, attempt_count, next_retry_at, lease_expires_at, agent_instance_id from agent_provisioning_jobs where id = $1 and org_id = $2 for update",
      [jobId, orgId],
    );
    const job = rows[0];
    if (!job) throw new AppError("not_found", "Provisioning request not found in this workspace.");
    // A synchronization is run by the restricted worker, so an agency person can only stop one (and then requeue it), never drive it by hand.
    if (job.kind === "sync" && status !== "cancelled") throw new AppError("conflict", "Configuration synchronization is managed by the restricted Hermes worker.");
    if (status === "in_progress") {
      if (job.attempt_count >= 3) throw new AppError("conflict", "Retry limit reached. Review the failure before a new deliberate request.");
      if (job.status === "in_progress" && job.lease_expires_at && job.lease_expires_at > new Date()) throw new AppError("conflict", "This provisioning attempt is already in progress.");
      if (!(["requested", "failed"].includes(job.status) || job.status === "in_progress")) throw new AppError("conflict", "This request cannot be retried from its current state.");
      if (job.next_retry_at && job.next_retry_at > new Date()) throw new AppError("conflict", "Wait until the recorded retry time before trying again.");
      await db.query(
        `update agent_provisioning_jobs set status = 'in_progress', attempt_count = attempt_count + 1,
           lease_token = gen_random_uuid(), lease_expires_at = now() + interval '5 minutes',
           next_retry_at = null, detail = null, handled_by = $3 where id = $1 and org_id = $2`,
        [jobId, orgId, agencyUserId],
      );
    } else if (status === "failed") {
      if (!["in_progress", "awaiting_health_check"].includes(job.status)) throw new AppError("conflict", "Only a started provisioning attempt can be failed.");
      await db.query(
        `update agent_provisioning_jobs set status = 'failed', detail = $3, handled_by = $4,
           lease_token = null, lease_expires_at = null,
           next_retry_at = case when attempt_count < 3 then now() + make_interval(secs => 30 * (2 ^ greatest(attempt_count - 1, 0))::integer) else null end
         where id = $1 and org_id = $2`,
        [jobId, orgId, detail?.slice(0, 1000) || "Provisioning failed; review the host evidence before retrying.", agencyUserId],
      );
    } else {
      if (!["requested", "in_progress", "awaiting_health_check", "failed"].includes(job.status)) throw new AppError("conflict", "This provisioning request is already closed.");
      await db.query(
        "update agent_provisioning_jobs set status = 'cancelled', detail = $3, handled_by = $4, lease_token = null, lease_expires_at = null, next_retry_at = null where id = $1 and org_id = $2",
        [jobId, orgId, detail?.slice(0, 1000) || "Cancelled by the agency.", agencyUserId],
      );
    }
    await recordAudit({ orgId, actorUserId: agencyUserId, actorKind: "agency", agentInstanceId: job.agent_instance_id,
      action: "agent.provisioning_status_changed", targetType: "agent_provisioning_job", targetId: jobId, result: "success",
      metadata: { status, attempt: status === "in_progress" ? job.attempt_count + 1 : job.attempt_count } }, db);
  });
}

const TERMINAL_RETRY_ATTEMPTS = 3;

/**
 * The agency's way out of a provisioning job that ended without a profile (or without a synchronized one): failed at the third attempt, cancelled, or worn out (its last lease
 * ran out at the third attempt). It opens exactly one new job: a `provision` job for an employee that has no profile yet, or a `sync` job for the current approved version for one
 * the restricted worker already created. It never touches a job that is still open or will still retry by itself, and it needs the workspace to be paid for and in good standing,
 * the same as the first request. The reason goes to the audit log only: the job's own detail is shown to the client.
 */
export async function requeueProvisioningJob(agencyUserId: string, orgId: string, agentId: string, reason: string) {
  const why = typeof reason === "string" ? reason.trim() : "";
  if (why.length < 5) throw new AppError("invalid_input", "Say why this setup is being requeued (at least 5 characters).");
  if (why.length > 500) throw new AppError("invalid_input", "Keep the reason under 500 characters.");
  return withSystem(async (db) => {
    const { rows: permission } = await db.query<{ allowed: boolean }>(
      "select app.user_can_access_org($1,$2) and app.user_has_agency_permission($1,'agency.workforce.manage') as allowed",
      [agencyUserId, orgId],
    );
    if (!permission[0]?.allowed) throw new AppError("forbidden", "Agency workforce management access is required.");
    const { rows: agents } = await db.query<{
      role_key: string; enabled: boolean; hermes_profile: string | null; active_config_version_id: string | null;
      org_kind: string; org_status: string; is_demo: boolean; onboarded: boolean; paid: boolean;
    }>(
      "select a.role_key,a.enabled,a.hermes_profile,a.active_config_version_id,o.kind as org_kind,o.status as org_status,o.is_demo," +
      "o.onboarding_completed_at is not null as onboarded," + PROVISIONING_PAYMENT_CLEARED_SQL + " as paid " +
      "from agent_instances a join organizations o on o.id=a.org_id where a.id=$1 and a.org_id=$2 for update of a",
      [agentId, orgId],
    );
    const agent = agents[0];
    if (!agent || !isWorkforceRoleKey(agent.role_key)) throw new AppError("not_found", "AI employee not found in this workspace.");
    if (agent.org_kind !== "client" || agent.is_demo || agent.org_status !== "active") throw new AppError("conflict", "Only an active client workspace can have its setup requeued.");
    if (!agent.enabled) throw new AppError("conflict", "This employee is not included in the workspace, so there is nothing to set up.");
    if (!agent.paid) throw new AppError("conflict", "The workspace's setup payment is not confirmed, so setup cannot be requeued yet.");
    if (!agent.active_config_version_id) throw new AppError("conflict", "This employee has no approved configuration yet. Approve one before requeuing its setup.");

    const { rows: jobs } = await db.query<{ id: string; kind: string; status: string; attempt_count: number; next_retry_at: Date | null; lease_expired: boolean }>(
      "select id,kind,status,attempt_count,next_retry_at,(lease_expires_at is not null and lease_expires_at<=now()) as lease_expired " +
      "from agent_provisioning_jobs where agent_instance_id=$1 and org_id=$2 order by created_at desc,id desc limit 1 for update",
      [agentId, orgId],
    );
    const previous = jobs[0];
    if (!previous) throw new AppError("conflict", "This employee has no earlier setup request. Use the normal request instead.");
    const worn = previous.status === "in_progress" && previous.lease_expired && previous.attempt_count >= TERMINAL_RETRY_ATTEMPTS;
    if (previous.status === "succeeded") throw new AppError("conflict", "The last setup request already completed.");
    if (["requested", "awaiting_health_check"].includes(previous.status) || (previous.status === "in_progress" && !worn)) {
      throw new AppError("conflict", "A setup request is already open for this employee.");
    }
    if (previous.status === "failed" && previous.attempt_count < TERMINAL_RETRY_ATTEMPTS && previous.next_retry_at) {
      throw new AppError("conflict", "This request will retry by itself at its recorded retry time.");
    }
    if (worn) {
      // The worker stopped answering on its last attempt; close the stuck attempt so the one-open-job rule lets the new request in.
      await db.query(
        "update agent_provisioning_jobs set status='failed',lease_token=null,lease_expires_at=null,next_retry_at=null,handled_by=$3," +
        "detail='Restricted Hermes profile setup failed (lease_expired). Review the isolated host result before retrying.' where id=$1 and org_id=$2",
        [previous.id, orgId, agencyUserId],
      );
      await recordAudit({ orgId, actorKind: "system", agentInstanceId: agentId, action: "agent.profile_provisioning_failed", targetType: "agent_provisioning_job", targetId: previous.id, result: "failure",
        metadata: { code: "lease_expired", attempt: previous.attempt_count } }, db);
    }

    let jobId: string | null;
    let kind: "provision" | "sync";
    if (!agent.hermes_profile) {
      if (!agent.onboarded) throw new AppError("conflict", "The client has not finished onboarding.");
      kind = "provision";
      const { rows } = await db.query<{ id: string }>(
        "insert into agent_provisioning_jobs (org_id,agent_instance_id,kind,requested_by) values ($1,$2,'provision',$3) on conflict do nothing returning id",
        [orgId, agentId, agencyUserId],
      );
      jobId = rows[0]?.id ?? null;
    } else {
      kind = "sync";
      jobId = await queueSyncJob(db, orgId, agentId, agent.active_config_version_id, agencyUserId);
      if (!jobId && !(await hasOpenJob(db, agentId, orgId))) {
        throw new AppError("conflict", "A synchronization cannot be queued: this profile was not created by the restricted worker (re-run the runbook for a manual profile), or its gateway is not verified.");
      }
    }
    if (!jobId) throw new AppError("conflict", "A setup request is already open for this employee.");

    await recordAudit({
      orgId, actorUserId: agencyUserId, actorKind: "agency", agentInstanceId: agentId, action: "agent.provisioning_requeued",
      targetType: "agent_provisioning_job", targetId: jobId, result: "success",
      metadata: { previousJobId: previous.id, previousKind: previous.kind, previousStatus: worn ? "failed" : previous.status, previousAttempts: previous.attempt_count, kind, reason: why },
    }, db);
    await notifyOrgRoles(db, orgId, ["owner"], {
      kind: "agent_status",
      severity: "info",
      title: `${workforceRoleShortName(agent.role_key)}'s setup is being retried`,
      body: "iAcquire restarted this AI employee's setup after a problem. You do not need to do anything.",
      link: "/employees",
      dedupeKey: `provisioning-requeued:${jobId}`,
    });
    return { jobId, kind, previousJobId: previous.id };
  });
}

async function hasOpenJob(db: Queryable, agentId: string, orgId: string) {
  const { rows } = await db.query(
    "select 1 from agent_provisioning_jobs where agent_instance_id=$1 and org_id=$2 and status in ('requested','in_progress','awaiting_health_check') limit 1",
    [agentId, orgId],
  );
  return rows.length > 0;
}

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface BusinessToolSyncResult {
  /** The synchronization jobs this call opened, one per employee. */
  queued: Array<{ agentId: string; jobId: string }>;
  /** Employees that already had an open setup request. It reads the workspace's switch when the worker claims it, so it needs no second one. */
  alreadyOpen: string[];
  /** Employees with nothing to synchronize: switched off, not made by the restricted worker, no applied configuration, or in a workspace that is not active. */
  skipped: string[];
}

/**
 * Brings client employees' Hermes profiles in line with the workspace's business-tool switches. A profile carries the MCP tool list only when the workspace is in the client tier, so when a
 * switch changes (setClientBusinessTools below) every enabled employee whose profile the restricted worker made gets ONE synchronization job for its applied configuration. The job's
 * manifest is built when the worker claims it, from the switches as they are then. Until it lands the employee reads as not online (the verifier expects the new tool list and the profile
 * does not have it yet), and a job that was claimed or finished under the old switch is replaced, never left to complete against the old list.
 *
 * It refuses a workspace that is an agency's or a demo, and an employee named in `agentIds` that is mapped from the internal tier (an `iacquire-` or `default` profile), and then writes
 * nothing. Safe to repeat: the one-open-job rule keeps it to one request per employee. `requestedBy` is the Super Admin who changed the switch.
 */
export async function requestBusinessToolSync(db: Queryable, orgId: string, agentIds?: readonly string[], requestedBy: string | null = null): Promise<BusinessToolSyncResult> {
  if (!UUID_TEXT.test(orgId)) throw new AppError("invalid_input", "The workspace must be an id.");
  if (agentIds?.some((id) => !UUID_TEXT.test(id))) throw new AppError("invalid_input", "Each employee must be an id.");
  const { rows: orgs } = await db.query<{ kind: string; is_demo: boolean; status: string }>("select kind,is_demo,status from organizations where id=$1", [orgId]);
  const org = orgs[0];
  if (!org) throw new AppError("not_found", "Workspace not found.");
  if (org.kind !== "client" || org.is_demo) throw new AppError("conflict", "Business tools are only synchronized for a real client workspace, never an agency's or a demo.");

  const { rows } = await db.query<{ id: string; role_key: string; enabled: boolean; hermes_profile: string | null; active_config_version_id: string | null; blocked_toolsets: string[] | null }>(
    "select a.id,a.role_key,a.enabled,a.hermes_profile,a.active_config_version_id," +
    "coalesce((select p.blocked_toolsets from hermes_tool_policies p where p.scope_kind='agent' and p.agent_id=a.id)," +
    "(select p.blocked_toolsets from hermes_tool_policies p where p.scope_kind='client' and p.org_id=a.org_id)," +
    "(select p.blocked_toolsets from hermes_tool_policies p where p.scope_kind='client_default'),$3::text[]) as blocked_toolsets " +
    "from agent_instances a where a.org_id=$1 and ($2::uuid[] is null or a.id = any($2::uuid[])) order by a.created_at,a.id for update of a",
    [orgId, agentIds ? [...agentIds] : null, DEFAULT_BLOCKED_TOOLSETS],
  );
  if (agentIds) {
    const found = new Set(rows.map((row) => row.id));
    if (agentIds.some((id) => !found.has(id))) throw new AppError("not_found", "Employee not found in this workspace.");
    if (rows.some((row) => row.hermes_profile && isReservedProfile(row.hermes_profile))) throw new AppError("conflict", "An employee mapped from the internal agency tier is never synchronized here.");
  }

  const result: BusinessToolSyncResult = { queued: [], alreadyOpen: [], skipped: [] };
  const tierOn = org.status === "active" ? await clientBusinessToolsOn(orgId, db) : false;
  for (const row of rows) {
    const versionId = row.active_config_version_id;
    if (org.status !== "active" || !row.enabled || !versionId || !isWorkforceRoleKey(row.role_key) || !row.hermes_profile?.startsWith("c-") || isReservedProfile(row.hermes_profile)) {
      result.skipped.push(row.id);
      continue;
    }
    const policySha = createHash("sha256").update(buildConfigYaml(row.blocked_toolsets ?? DEFAULT_BLOCKED_TOOLSETS, row.role_key, { businessMcp: tierOn }), "utf8").digest("hex");
    // A request that is still waiting reads the switch when it is claimed, so it stays. One that was claimed, or finished, under another policy would complete against the old tool list: replace it.
    const { rows: replaced } = await db.query<{ id: string }>(
      "update agent_provisioning_jobs set status='cancelled',lease_token=null,lease_expires_at=null,next_retry_at=null," +
      "detail='The business tool setting changed, so a new synchronization replaces this one.' " +
      "where org_id=$1 and agent_instance_id=$2 and kind='sync' and status in ('in_progress','awaiting_health_check') " +
      "and manifest_policy_config_sha256 is distinct from $3 returning id",
      [orgId, row.id, policySha],
    );
    const jobId = await queueSyncJob(db, orgId, row.id, versionId, requestedBy);
    if (!jobId) {
      ((await hasOpenJob(db, row.id, orgId)) ? result.alreadyOpen : result.skipped).push(row.id);
      continue;
    }
    // The employee is not online until the profile has the new tool list and the portal's own check has seen it.
    await db.query(
      "update agent_instances set status='provisioning',last_health_ok=null,last_health_detail='Business tool synchronization is pending.' where id=$1 and org_id=$2 and status not in ('disabled','setup_required')",
      [row.id, orgId],
    );
    await recordAudit({
      orgId, actorUserId: requestedBy, actorKind: requestedBy ? "agency" : "system", agentInstanceId: row.id, action: "agent.business_tools_sync_requested",
      targetType: "agent_provisioning_job", targetId: jobId, result: "success", metadata: { jobId, businessTools: tierOn, replaced: replaced.length },
    }, db);
    result.queued.push({ agentId: row.id, jobId });
  }
  return result;
}

/**
 * A Super Admin switches a client workspace's business tools (reads) and/or its change proposals on or off, and the employees' profiles are synchronized to match. The switches and the
 * synchronization request are one transaction, so a failed request leaves the switch where it was and the same call can simply be made again. A synchronization is asked for when the
 * tools switch changed, or when the proposals switch changed while the tools are really on (with the tools off the proposals switch changes nothing in any profile, so nobody is taken
 * offline for it). Never for an agency or a demo workspace, and then nothing is written.
 */
export async function setClientBusinessTools(user: SessionUser, input: { orgId: string; tools?: boolean; proposals?: boolean; reason?: string }): Promise<{ changed: boolean; sync: BusinessToolSyncResult | null }> {
  if (user.platformRole !== "agency_super_admin") throw new AppError("forbidden", "Only a Super Admin can switch a workspace's business tools.");
  if (input.tools === undefined && input.proposals === undefined) throw new AppError("invalid_input", "Say which business tool switch to change.");
  if (!UUID_TEXT.test(input.orgId)) throw new AppError("invalid_input", "The workspace must be an id.");
  try {
    return await withSystem(async (db) => {
      const { rows } = await db.query<{ kind: string; is_demo: boolean }>("select kind,is_demo from organizations where id=$1", [input.orgId]);
      if (!rows[0]) throw new AppError("not_found", "Workspace not found.");
      if (rows[0].kind !== "client" || rows[0].is_demo) throw new AppError("conflict", "Business tools are switched on only for a real client workspace, never an agency's or a demo.");
      const toolsChanged = input.tools !== undefined && (await setOrgFeatureIn(db, user, { orgId: input.orgId, feature: CLIENT_BUSINESS_TOOLS_FEATURE, enabled: input.tools, reason: input.reason })).changed;
      const proposalsChanged = input.proposals !== undefined && (await setOrgFeatureIn(db, user, { orgId: input.orgId, feature: CLIENT_BUSINESS_PROPOSALS_FEATURE, enabled: input.proposals, reason: input.reason })).changed;
      const needsSync = toolsChanged || (proposalsChanged && (await clientBusinessToolsOn(input.orgId, db)));
      const sync = needsSync ? await requestBusinessToolSync(db, input.orgId, undefined, user.id) : null;
      return { changed: toolsChanged || proposalsChanged, sync };
    });
  } finally {
    clearFeatureCache(input.orgId);
  }
}

function reasonOf(reason: unknown, purpose: string): string {
  const why = typeof reason === "string" ? reason.trim() : "";
  if (why.length < 5) throw new AppError("invalid_input", `Say why ${purpose} (at least 5 characters).`);
  if (why.length > 500) throw new AppError("invalid_input", "Keep the reason under 500 characters.");
  return why;
}

export interface DeprovisionRequestResult {
  jobId: string;
  /** A containment request was already open for this employee, so nothing new was written. */
  alreadyOpen: boolean;
  /** Setup or synchronization requests that were still open and were replaced by this one. */
  replaced: number;
}

/**
 * Asks for ONE client employee's runtime profile to be contained: the restricted worker replaces the profile's key with one nobody is given, switches its tools off, proves both through the
 * gateway, and only then does the portal revoke the employee's credential and mark it not set up (see completeDeprovisionJob). The profile is contained, not deleted.
 *
 * It needs an accountable agency person with workforce management access, a reason (5 to 500 characters, kept in the audit log only), and a profile that the restricted worker made on the
 * gateway it is pinned to. It refuses an agency's or a demo's employee and an employee mapped from the internal tier, and then writes nothing. A request that is still open is returned as
 * it is (never a second one); an open setup or synchronization request is replaced, because containment must not be left waiting behind work that would keep the profile running. The job is
 * only handed to the worker while HERMES_PROVISIONER_DEPROVISION_ENABLED is on.
 */
export async function requestDeprovision(db: Queryable, input: { orgId: string; agentId: string; actorUserId: string; reason: string }): Promise<DeprovisionRequestResult> {
  const { orgId, agentId, actorUserId } = input;
  if (!UUID_TEXT.test(orgId) || !UUID_TEXT.test(agentId) || !UUID_TEXT.test(actorUserId)) throw new AppError("invalid_input", "The workspace, the employee and the person asking must each be an id.");
  const why = reasonOf(input.reason, "this employee's runtime profile is being contained");
  // With the switch off the worker is never handed a containment job, so a request would sit in the queue and look like something was happening. Refuse it, and write nothing.
  if (!env().HERMES_PROVISIONER_DEPROVISION_ENABLED) throw new AppError("conflict", "Containment is turned off in this deployment, so nothing was requested.");
  const { rows: permission } = await db.query<{ allowed: boolean }>(
    "select app.user_can_access_org($1,$2) and app.user_has_agency_permission($1,'agency.workforce.manage') as allowed",
    [actorUserId, orgId],
  );
  if (!permission[0]?.allowed) throw new AppError("forbidden", "Agency workforce management access is required.");
  const { rows: agents } = await db.query<{ hermes_profile: string | null; hermes_gateway_id: string | null; org_kind: string; is_demo: boolean }>(
    "select a.hermes_profile,a.hermes_gateway_id,o.kind as org_kind,o.is_demo from agent_instances a join organizations o on o.id=a.org_id where a.id=$1 and a.org_id=$2 for update of a",
    [agentId, orgId],
  );
  const agent = agents[0];
  if (!agent) throw new AppError("not_found", "AI employee not found in this workspace.");
  if (agent.org_kind !== "client" || agent.is_demo) throw new AppError("conflict", "Only a real client workspace's employee can have its runtime profile contained, never an agency's or a demo's.");
  if (!agent.hermes_profile?.startsWith("c-") || isReservedProfile(agent.hermes_profile)) {
    throw new AppError("conflict", "This employee has no client runtime profile made by the restricted provisioner, so there is nothing to contain.");
  }
  const pinned = env().HERMES_PROVISIONER_GATEWAY_ID;
  if (!pinned || agent.hermes_gateway_id !== pinned) throw new AppError("conflict", "This employee's profile is not on the client runtime the restricted provisioner is pinned to.");

  const { rows: open } = await db.query<{ id: string; kind: string }>(
    "select id,kind from agent_provisioning_jobs where agent_instance_id=$1 and org_id=$2 and status in ('requested','in_progress','awaiting_health_check') for update",
    [agentId, orgId],
  );
  const existing = open.find((job) => job.kind === "deprovision");
  if (existing) return { jobId: existing.id, alreadyOpen: true, replaced: 0 };
  const { rows: replaced } = await db.query<{ id: string }>(
    "update agent_provisioning_jobs set status='cancelled',lease_token=null,lease_expires_at=null,next_retry_at=null," +
    "detail='A request to contain this employee replaces this one.' " +
    "where agent_instance_id=$1 and org_id=$2 and kind in ('provision','sync','reconnect') and status in ('requested','in_progress','awaiting_health_check') returning id",
    [agentId, orgId],
  );
  const { rows: inserted } = await db.query<{ id: string }>(
    "insert into agent_provisioning_jobs (org_id,agent_instance_id,kind,requested_by) values ($1,$2,'deprovision',$3) on conflict do nothing returning id",
    [orgId, agentId, actorUserId],
  );
  const jobId = inserted[0]?.id;
  if (!jobId) throw new AppError("conflict", "A request is already open for this employee.");
  await recordAudit({
    orgId, actorUserId, actorKind: "agency", agentInstanceId: agentId, action: "agent.profile_deprovision_requested", targetType: "agent_provisioning_job", targetId: jobId, result: "success",
    metadata: { jobId, reason: why, profile: agent.hermes_profile, gatewayId: agent.hermes_gateway_id, replaced: replaced.length },
  }, db);
  return { jobId, alreadyOpen: false, replaced: replaced.length };
}

/** The most employees one fleet synchronization asks for; a larger fleet is covered by asking again (`truncated` says there is more). */
export const FLEET_SYNC_MAX_EMPLOYEES = 200;

export interface FleetSyncResult {
  queued: Array<{ orgId: string; agentId: string; jobId: string }>;
  /** Employees that already had a setup or synchronization request open, so nothing new was written for them. */
  alreadyOpen: number;
  /** Employees with nothing to synchronize (the gateway is not verified, or the profile was not made by the restricted worker). */
  skipped: number;
  /** More employees qualified than one call takes. Ask again to cover the rest. */
  truncated: boolean;
}

/**
 * Asks the restricted worker to bring every provisioned client employee's profile in line with its applied configuration again, for example after the worker or the runtime was updated.
 * One synchronization job per enabled employee whose profile the restricted worker made on this gateway, at most FLEET_SYNC_MAX_EMPLOYEES a call, safe to repeat (an employee that already
 * has a request open is left alone), and audited: one row per employee in its own workspace and one summary row on the agency. Never touches an agency's or a demo's employee or one
 * mapped from the internal tier. `requestedBy` is the accountable agency person; the reason (5 to 500 characters) goes to the audit log.
 */
export async function requestFleetSync(db: Queryable, gatewayId: string, requestedBy: string, reason: string, opts: { limit?: number } = {}): Promise<FleetSyncResult> {
  // The bound is the constant; a caller may only ask for fewer (a test of the bound, or a careful first batch), never more.
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? FLEET_SYNC_MAX_EMPLOYEES), 1), FLEET_SYNC_MAX_EMPLOYEES);
  if (!UUID_TEXT.test(gatewayId) || !UUID_TEXT.test(requestedBy)) throw new AppError("invalid_input", "The runtime and the person asking must each be an id.");
  const why = reasonOf(reason, "the client runtime is being synchronized");
  if (!env().HERMES_PROVISIONER_GATEWAY_ID || env().HERMES_PROVISIONER_GATEWAY_ID !== gatewayId) throw new AppError("forbidden", "That is not the client runtime the restricted provisioner is pinned to.");
  const { rows: permission } = await db.query<{ allowed: boolean }>("select app.user_has_agency_permission($1,'agency.workforce.manage') as allowed", [requestedBy]);
  if (!permission[0]?.allowed) throw new AppError("forbidden", "Agency workforce management access is required.");

  // Who qualifies: enabled, with an applied configuration, on this gateway, in an active real client workspace. Employees that already have a request open are counted but never selected, so
  // when a call is cut short the next call starts where this one stopped instead of meeting the same first employees again.
  const qualifies =
    "from agent_instances a join organizations o on o.id=a.org_id " +
    "where a.hermes_gateway_id=$1 and a.hermes_profile like 'c-%' and a.enabled and a.active_config_version_id is not null and o.kind='client' and not o.is_demo and o.status='active' ";
  const openJobExists = "exists (select 1 from agent_provisioning_jobs j where j.agent_instance_id=a.id and j.org_id=a.org_id and j.status in ('requested','in_progress','awaiting_health_check'))";
  const { rows: openRows } = await db.query<{ n: number }>("select count(*)::int as n " + qualifies + "and " + openJobExists, [gatewayId]);
  const { rows } = await db.query<{ id: string; org_id: string; active_config_version_id: string; hermes_profile: string }>(
    "select a.id,a.org_id,a.active_config_version_id,a.hermes_profile " + qualifies + "and not " + openJobExists + " order by o.created_at,a.created_at,a.id limit $2 for update of a",
    [gatewayId, limit + 1],
  );
  const result: FleetSyncResult = { queued: [], alreadyOpen: openRows[0]?.n ?? 0, skipped: 0, truncated: rows.length > limit };
  for (const row of rows.slice(0, limit)) {
    if (isReservedProfile(row.hermes_profile)) {
      result.skipped += 1;
      continue;
    }
    const jobId = await queueSyncJob(db, row.org_id, row.id, row.active_config_version_id, requestedBy);
    if (!jobId) {
      // A request opened between the two reads above counts as already open; anything else (an unverified gateway, a profile the restricted worker did not make) is skipped.
      if (await hasOpenJob(db, row.id, row.org_id)) result.alreadyOpen += 1;
      else result.skipped += 1;
      continue;
    }
    result.queued.push({ orgId: row.org_id, agentId: row.id, jobId });
    await recordAudit({
      orgId: row.org_id, actorUserId: requestedBy, actorKind: "agency", agentInstanceId: row.id, action: "agent.fleet_sync_requested", targetType: "agent_provisioning_job", targetId: jobId, result: "success",
      metadata: { jobId, gatewayId, reason: why },
    }, db);
  }
  const { rows: agency } = await db.query<{ id: string }>("select id from organizations where kind='agency' limit 1");
  if (agency[0]) {
    await recordAudit({
      orgId: agency[0].id, actorUserId: requestedBy, actorKind: "agency", action: "agent.fleet_sync_summary", targetType: "hermes_gateway", targetId: gatewayId, result: "success",
      metadata: { gatewayId, reason: why, queued: result.queued.length, alreadyOpen: result.alreadyOpen, skipped: result.skipped, truncated: result.truncated },
    }, db);
  }
  return result;
}
