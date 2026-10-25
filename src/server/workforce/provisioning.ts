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
import { notifyAgency } from "@/server/notifications";
import { AGENT_BY_KEY, type AgentRoleKey } from "@/lib/agents";
import { immutablePolicy, policyVersionFor, ROLE_RESPONSIBILITIES, type WorkforceOrganizationKind } from "@/server/workforce/policy";
import { sanitizeClientText } from "@/server/workforce/compiler";
import { suggestedProfileName } from "@/server/workforce/service";
import { DEFAULT_BLOCKED_TOOLSETS, HERMES_BLOCKABLE_TOOLSETS } from "@/server/workforce/tool-policies";

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

export function buildSoul(role: AgentRoleKey, companyName: string, orgKind: WorkforceOrganizationKind = "client"): string {
  const meta = AGENT_BY_KEY[role];
  const name = sanitizeClientText(companyName, 120) || (orgKind === "agency" ? "iAcquire" : "this client");
  const policyLabel = orgKind === "agency" ? "Internal iAcquire policy" : "iAcquire policy";
  return [
    `# ${meta.name} — ${name}`,
    "",
    `You are the ${meta.name} in ${name}'s dedicated iAcquire AI workforce. ${meta.tagline}`,
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
  role: AgentRoleKey,
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

export function buildConfigYaml(blockedToolsets: readonly string[] = DEFAULT_BLOCKED_TOOLSETS): string {
  const known = new Set(HERMES_BLOCKABLE_TOOLSETS.map((toolset) => toolset.key));
  if (blockedToolsets.some((toolset) => !known.has(toolset as (typeof HERMES_BLOCKABLE_TOOLSETS)[number]["key"]))) {
    throw new AppError("invalid_input", "This Hermes policy contains an unsupported toolset.");
  }
  const disabled = [...new Set(blockedToolsets)];
  const apiToolsets = [...PORTAL_SAFE_TOOLSETS, "no_mcp"];
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
    "",
  ].join("\n");
}

export async function getProvisioningBundle(agentId: string): Promise<ProvisioningBundle> {
  const row = await withSystem(async (db) => {
    const { rows } = await db.query<{ role_key: AgentRoleKey; org_id: string; org_name: string; slug: string; kind: WorkforceOrganizationKind; hermes_profile: string | null; blocked_toolsets: string[] }>(
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
  if (!row) throw new AppError("not_found", "AI employee not found.");
  const profile = row.hermes_profile ?? suggestedProfileName(row.slug, row.role_key);
  const meta = AGENT_BY_KEY[row.role_key];
  const soul = buildSoul(row.role_key, row.org_name, row.kind);
  const soulSha256 = createHash("sha256").update(soul, "utf8").digest("hex");
  return {
    profile,
    soul,
    soulSha256,
    configYaml: row.kind === "client" ? buildConfigYaml(row.blocked_toolsets ?? DEFAULT_BLOCKED_TOOLSETS) : buildConfigYaml(),
    envTemplate: [
      "# ~/.hermes/profiles/" + profile + "/.env  (never paste these values into chat or tickets)",
      "API_SERVER_ENABLED=true",
      "API_SERVER_KEY=<generate on the VPS: openssl rand -hex 32>",
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

/** Opens provisioning requests for enabled employees that don't have a dedicated profile yet. */
export async function requestProvisioning(db: Queryable, orgId: string, requestedBy: string | null) {
  const { rows } = await db.query<{ id: string; role_key: AgentRoleKey }>(
    `insert into agent_provisioning_jobs (org_id, agent_instance_id, kind, requested_by)
     select a.org_id, a.id, 'provision', $2 from agent_instances a
     join organizations o on o.id = a.org_id
     where a.org_id = $1 and a.enabled and a.hermes_profile is null
       and o.kind = 'client' and not o.is_demo and o.status = 'active' and o.onboarding_completed_at is not null
       and exists (
         select 1 from organization_memberships m join users u on u.id = m.user_id
         where m.org_id = o.id and m.role = 'owner' and m.status = 'active' and u.email_verified_at is not null
       )
       and not exists (select 1 from agent_provisioning_jobs j where j.agent_instance_id = a.id and j.kind = 'provision')
     on conflict do nothing
     returning agent_instance_id as id, (select role_key from agent_instances where id = agent_instance_id) as role_key`,
    [orgId, requestedBy],
  );
  if (rows.length) {
    await notifyAgency(db, orgId, {
      kind: "agent_status",
      severity: "info",
      title: `${rows.length} AI employee${rows.length === 1 ? "" : "s"} awaiting provisioning`,
      body: rows.map((r) => AGENT_BY_KEY[r.role_key]?.shortName).filter(Boolean).join(", "),
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
    if (job.kind === "sync") throw new AppError("conflict", "Configuration synchronization is managed by the restricted Hermes worker.");
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
