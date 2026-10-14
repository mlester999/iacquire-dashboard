import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyAgency } from "@/server/notifications";
import { AGENT_BY_KEY, type AgentRoleKey } from "@/lib/agents";
import { immutablePolicy, POLICY_VERSION, ROLE_RESPONSIBILITIES } from "@/server/workforce/policy";
import { sanitizeClientText } from "@/server/workforce/compiler";
import { suggestedProfileName } from "@/server/workforce/service";

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
  configYaml: string;
  envTemplate: string;
  steps: Array<{ title: string; command?: string; note?: string }>;
  verification: string[];
}

export function buildSoul(role: AgentRoleKey, companyName: string): string {
  const meta = AGENT_BY_KEY[role];
  const name = sanitizeClientText(companyName, 120) || "this client";
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
    "- Follow the per-request client configuration for tone, length and language.",
    "- Never repeat your introduction in every reply.",
    "",
    `## iAcquire policy (${POLICY_VERSION}) — always applies`,
    ...immutablePolicy(name).map((p, i) => `${i + 1}. ${p}`),
    "",
  ].join("\n");
}

export function buildConfigYaml(): string {
  return [
    "# Merge into this profile's config.yaml. Keys verified against Hermes Agent docs",
    "# (agent.disabled_toolsets; terminal backend security). Re-check after Hermes upgrades.",
    "agent:",
    "  disabled_toolsets:",
    "    - terminal",
    "    - file",
    "    - code_execution",
    "    - browser",
    "    - computer_use",
    "    - cronjob",
    "    - delegation",
    "    - connections",
    "    - catalog",
    "    - kanban",
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
    const { rows } = await db.query<{ role_key: AgentRoleKey; org_name: string; slug: string; kind: string; hermes_profile: string | null }>(
      `select a.role_key, o.name as org_name, o.slug, o.kind, a.hermes_profile
       from agent_instances a join organizations o on o.id = a.org_id where a.id = $1`,
      [agentId],
    );
    return rows[0];
  });
  if (!row) throw new AppError("not_found", "AI employee not found.");
  const profile = row.hermes_profile ?? suggestedProfileName(row.slug, row.role_key);
  const meta = AGENT_BY_KEY[row.role_key];
  return {
    profile,
    soul: buildSoul(row.role_key, row.org_name),
    configYaml: buildConfigYaml(),
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
        command: `hermes profile create ${profile} --description "${meta.name} for ${sanitizeClientText(row.org_name, 80).replace(/"/g, "")}"`,
        note: "A blank profile has its own empty memory, sessions and state. --clone would copy SOUL.md and MEMORY.md from the source profile.",
      },
      { title: "Write SOUL.md", note: `Save the SOUL.md below to ~/.hermes/profiles/${profile}/SOUL.md.` },
      { title: "Restrict tools", note: "Merge the config.yaml snippet below into the profile's config.yaml." },
      { title: "Set the profile's own API key and model provider", note: "Add the .env lines below. Each profile must have a distinct API_SERVER_KEY." },
      { title: "Reload the multiplexed gateway", command: "hermes gateway restart", note: "The profile is then served under /p/" + profile + "/ on the existing API listener." },
      {
        title: "Verify tool restrictions from the VPS",
        command: `curl -s -H "Authorization: Bearer $KEY" http://127.0.0.1:8642/p/${profile}/v1/toolsets`,
        note: "No terminal, file, code, browser, cron, delegation or connection tools should be listed as enabled.",
      },
      { title: "Connect it in the portal", note: "Admin → Workforce → Connect profile: enter the HTTPS API URL, profile name and key. Then run the health check." },
    ],
    verification: [
      "Authenticated GET /p/<profile>/v1/capabilities succeeds with run_submission and run_events_sse.",
      "GET /p/<profile>/v1/toolsets lists no restricted tools (the portal enforces this).",
      "The employee's configuration has been applied in the portal.",
    ],
  };
}

/** Opens provisioning requests for enabled employees that don't have a dedicated profile yet. */
export async function requestProvisioning(db: Queryable, orgId: string, requestedBy: string | null) {
  const { rows } = await db.query<{ id: string; role_key: AgentRoleKey }>(
    `insert into agent_provisioning_jobs (org_id, agent_instance_id, kind, requested_by)
     select a.org_id, a.id, 'provision', $2 from agent_instances a
     where a.org_id = $1 and a.enabled and a.hermes_profile is null
       and not exists (select 1 from agent_provisioning_jobs j where j.agent_instance_id = a.id
                       and j.status in ('requested', 'in_progress', 'awaiting_health_check'))
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

export async function updateProvisioningJob(agencyUserId: string, jobId: string, status: "in_progress" | "failed" | "cancelled", detail?: string) {
  await withSystem(async (db) => {
    const res = await db.query(
      "update agent_provisioning_jobs set status = $2, detail = $3, handled_by = $4 where id = $1 and status in ('requested', 'in_progress', 'awaiting_health_check')",
      [jobId, status, detail?.slice(0, 1000) ?? null, agencyUserId],
    );
    if (!res.rowCount) throw new AppError("conflict", "This provisioning request is already closed.");
  });
}
