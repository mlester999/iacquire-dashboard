import "server-only";
import { withServiceRole, withSystem, withUser, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { resolveCredential, saveCredential } from "@/server/security/credentials";
import { validateIntegrationEndpoint } from "@/server/integrations/safety";
import { loadHermesAccessCredentials } from "@/server/integrations/hermes/gateways";
import { AGENT_BY_KEY, AGENT_ROLE_KEYS, isAgentRoleKey, type AgentRoleKey, type AgentStatus } from "@/lib/agents";
import { agentSettingsSchema, aiPreferencesSchema, type AgentSettings } from "@/lib/agent-settings";
import { compileAgentConfig, defaultSettings, type CompanyContext } from "@/server/workforce/compiler";
import {
  classifyConfigChange,
  decisionFromRiskFlags,
  type ConfigActorKind,
  type ConfigDecision,
  type ConfigOrgKind,
  type ConfigSource,
} from "@/lib/config-review";
import { getCapabilities, getToolsets, getProfileModels, HermesError, restrictedToolsIn, type HermesConnection } from "@/server/integrations/hermes/client";
import {
  inventoryColumns,
  ToolInventoryError,
  verifyToolInventory,
  type ToolInventorySnapshot,
} from "@/server/integrations/hermes/inventory";
import { notifyAgency, notifyOrgRoles, notifyUser } from "@/server/notifications";
import { employeeKnowledgeContext } from "@/server/workforce/knowledge";
import { buildHeldConfigReview, type HeldConfigRow } from "@/server/workforce/reviews";

export interface AgentInstanceRow {
  id: string;
  org_id: string;
  role_key: AgentRoleKey;
  display_name: string;
  enabled: boolean;
  status: AgentStatus;
  mode: "autonomous" | "approval_required" | "paused";
  active_config_version_id: string | null;
  last_health_check_at: Date | null;
  last_health_ok: boolean | null;
  last_health_detail: string | null;
  default_tools: string[];
  summary: string | null;
  config_version: number | null;
  config_applied_at: Date | null;
  hermes_profile: string | null;
  hermes_base_url: string | null;
  tool_inventory_digest: string | null;
  tool_inventory_tool_count: number | null;
  tool_inventory_verified_at: Date | null;
}

const RESERVED_PROFILES = new Set([
  "default",
  "iacquire-operations-manager",
  "iacquire-lead-hunter",
  "iacquire-appointment-setter",
  "iacquire-sales-assistant",
  "iacquire-crm-manager",
  "iacquire-analyst",
]);

export function isReservedProfile(profile: string) {
  return RESERVED_PROFILES.has(profile) || profile.startsWith("iacquire-");
}

/** Suggested per-tenant profile name, e.g. "c-acme-dental-lead-hunter". */
export function suggestedProfileName(orgSlug: string, role: AgentRoleKey) {
  return `c-${orgSlug}-${role.replace(/_/g, "-")}`.slice(0, 63).replace(/-+$/, "");
}

export async function ensureAgentInstances(orgId: string, db: Queryable) {
  for (const key of AGENT_ROLE_KEYS) {
    await db.query(
      `insert into agent_instances (org_id, role_key, display_name) values ($1, $2, $3)
       on conflict (org_id, role_key) do nothing`,
      [orgId, key, AGENT_BY_KEY[key].shortName],
    );
  }
}

const AGENT_SELECT = `
  select a.id, a.org_id, a.role_key, a.display_name, a.enabled, a.status, a.mode, a.active_config_version_id,
         a.last_health_check_at, a.last_health_ok, a.last_health_detail, a.hermes_profile, a.hermes_base_url,
         a.tool_inventory_digest, a.tool_inventory_tool_count, a.tool_inventory_verified_at, r.default_tools,
         v.summary, v.version as config_version, v.applied_at as config_applied_at
  from agent_instances a
  join agent_roles r on r.key = a.role_key
  left join agent_config_versions v on v.id = a.active_config_version_id`;

export async function listAgents(userId: string, orgId: string): Promise<AgentInstanceRow[]> {
  return withUser(userId, async (db) => {
    const { rows } = await db.query<AgentInstanceRow>(`${AGENT_SELECT} where a.org_id = $1 order by r.sort_order`, [orgId]);
    return rows;
  });
}

export async function getAgentByRole(userId: string, orgId: string, role: AgentRoleKey): Promise<AgentInstanceRow | null> {
  return withUser(userId, async (db) => {
    const { rows } = await db.query<AgentInstanceRow>(`${AGENT_SELECT} where a.org_id = $1 and a.role_key = $2`, [orgId, role]);
    return rows[0] ?? null;
  });
}

export async function listConfigVersions(userId: string, agentId: string) {
  return withUser(userId, async (db) => {
    const { rows } = await db.query<{
      id: string;
      version: number;
      summary: string;
      status: string;
      source: string;
      change_request: string | null;
      risk_flags: string[];
      policy_version: string | null;
      created_at: Date;
      applied_at: Date | null;
      decided_at: Date | null;
      settings: unknown;
      created_by: string | null;
      decided_by: string | null;
      created_by_name: string | null;
      decided_by_name: string | null;
    }>(
      `select v.id, v.version, v.summary, v.status, v.source, v.change_request, v.risk_flags, v.policy_version,
              v.created_at, v.applied_at, v.decided_at, v.settings, v.created_by, v.decided_by,
              u.full_name as created_by_name, d.full_name as decided_by_name
       from agent_config_versions v
       left join users u on u.id = v.created_by
       left join users d on d.id = v.decided_by
       where v.agent_instance_id = $1 order by v.version desc limit 50`,
      [agentId],
    );
    // Old versions can predate a setting added to the schema. A version whose snapshot no longer parses
    // is still shown (its metadata and summary are real), but it is never fed to the diff renderer.
    return rows.map((row) => {
      const parsed = agentSettingsSchema.safeParse(row.settings);
      return { ...row, settings: parsed.success ? parsed.data : null };
    });
  });
}

// ---------------------------------------------------------------------------
// Configuration versions
// ---------------------------------------------------------------------------

export async function loadCompanyContext(db: Queryable, orgId: string): Promise<CompanyContext> {
  const { rows } = await db.query<{
    name: string;
    industry: string | null;
    website: string | null;
    description: string | null;
    services: string | null;
    ideal_customers: string | null;
    operating_area: string | null;
    goals: string[] | null;
  }>(
    `select o.name, o.industry, o.website, p.description, p.services, p.ideal_customers, p.operating_area, p.goals
     from organizations o left join company_profiles p on p.org_id = o.id where o.id = $1`,
    [orgId],
  );
  const r = rows[0];
  if (!r) throw new AppError("not_found", "Workspace not found.");
  return {
    companyName: r.name,
    industry: r.industry ?? "",
    website: r.website ?? "",
    description: r.description ?? "",
    services: r.services ?? "",
    idealCustomers: r.ideal_customers ?? "",
    operatingArea: r.operating_area ?? "",
    goals: r.goals ?? [],
  };
}

export async function currentSettings(db: Queryable, agentId: string, orgId: string): Promise<{ role: AgentRoleKey; settings: AgentSettings; tools: string[] }> {
  const { rows } = await db.query<{ role_key: AgentRoleKey; settings: AgentSettings | null; default_tools: string[]; ai_preferences: unknown }>(
    `select a.role_key, v.settings, r.default_tools, p.ai_preferences
     from agent_instances a join agent_roles r on r.key = a.role_key
     left join agent_config_versions v on v.id = a.active_config_version_id
     left join company_profiles p on p.org_id = a.org_id
     where a.id = $1 and a.org_id = $2`,
    [agentId, orgId],
  );
  const r = rows[0];
  if (!r) throw new AppError("not_found", "AI employee not found.");
  const prefs = aiPreferencesSchema.safeParse(r.ai_preferences ?? {});
  const settings = r.settings ? agentSettingsSchema.parse(r.settings) : defaultSettings(r.role_key, prefs.success ? prefs.data : undefined);
  return { role: r.role_key, settings, tools: r.default_tools };
}

/**
 * Settings for the Configure screen. A saved version that has not been applied yet is the
 * version the user is editing; falling back to defaults here would silently discard their draft.
 * The approval preference is always pinned to the currently applied value (or the conservative
 * default) because it is not wired into runtime approval decisions yet.
 */
export async function editableSettings(
  db: Queryable,
  agentId: string,
  orgId: string,
): Promise<{ role: AgentRoleKey; settings: AgentSettings; tools: string[]; pendingVersion: number | null; origin: "pending" | "active" | "default" }> {
  const { rows } = await db.query<{
    role_key: AgentRoleKey;
    default_tools: string[];
    ai_preferences: unknown;
    active_settings: AgentSettings | null;
    pending_settings: AgentSettings | null;
    pending_version: number | null;
  }>(
    `select a.role_key, r.default_tools, p.ai_preferences,
            active.settings as active_settings,
            pending.settings as pending_settings, pending.version as pending_version
     from agent_instances a
     join agent_roles r on r.key = a.role_key
     left join company_profiles p on p.org_id = a.org_id
     left join agent_config_versions active on active.id = a.active_config_version_id
     left join lateral (
       select v.settings, v.version from agent_config_versions v
       where v.agent_instance_id = a.id and v.status = 'pending_agency_review'
       order by v.version desc limit 1
     ) pending on true
     where a.id = $1 and a.org_id = $2`,
    [agentId, orgId],
  );
  const row = rows[0];
  if (!row) throw new AppError("not_found", "AI employee not found.");
  const prefs = aiPreferencesSchema.safeParse(row.ai_preferences ?? {});
  const active = row.active_settings ? agentSettingsSchema.safeParse(row.active_settings) : null;
  const pending = row.pending_settings ? agentSettingsSchema.safeParse(row.pending_settings) : null;
  const fallback = defaultSettings(row.role_key, prefs.success ? prefs.data : undefined);
  const base = pending?.success ? pending.data : active?.success ? active.data : fallback;
  const fixedApproval = active?.success ? active.data.approvalPreference : fallback.approvalPreference;
  const settings = agentSettingsSchema.parse({ ...base, approvalPreference: fixedApproval });
  return {
    role: row.role_key,
    settings,
    tools: row.default_tools,
    pendingVersion: pending?.success ? Number(row.pending_version) : null,
    origin: pending?.success ? "pending" : active?.success ? "active" : "default",
  };
}

/**
 * Creates a new configuration version.
 *
 * The decision is risk-based:
 * - AUTO_APPLY: routine changes apply after server validation.
 * - REVIEW_REQUIRED: sensitive changes are stored as `pending_agency_review` and need a person.
 * - BLOCKED: privileged, cross-tenant or secret-seeking instructions never create a version.
 *
 * The same validator runs for clients and agency Super Admins. Actor kind only changes routing
 * and attribution, never whether a blocked change is allowed.
 */
export async function createConfigVersion(
  db: Queryable,
  input: {
    orgId: string;
    agentId: string;
    settings: AgentSettings;
    source: ConfigSource;
    actorKind?: ConfigActorKind;
    changeRequest?: string;
    userId: string | null;
    apply: boolean;
  },
) {
  const { rows: agentRows } = await db.query<{
    role_key: string;
    default_tools: string[];
    org_kind: ConfigOrgKind;
    active_settings: AgentSettings | null;
  }>(
    `select a.role_key, r.default_tools, o.kind as org_kind, active.settings as active_settings
     from agent_instances a
     join agent_roles r on r.key = a.role_key
     join organizations o on o.id = a.org_id
     left join agent_config_versions active on active.id = a.active_config_version_id
     where a.id = $1 and a.org_id = $2`,
    [input.agentId, input.orgId],
  );
  const agent = agentRows[0];
  if (!agent || !isAgentRoleKey(agent.role_key)) throw new AppError("not_found", "AI employee not found.");
  const orgKind: ConfigOrgKind = agent.org_kind === "agency" ? "agency" : "client";
  const previousParsed = agent.active_settings ? agentSettingsSchema.safeParse(agent.active_settings) : null;
  const previousSettings = previousParsed?.success ? previousParsed.data : null;
  const actorKind: ConfigActorKind = input.actorKind ?? (input.source === "agency" ? "agency" : "user");

  const parsedInput = agentSettingsSchema.parse(input.settings);
  // This preference is presented in the UI but is not consulted by the runtime approval gate.
  // Pin it to the applied value (or the conservative default) so it cannot imply protection
  // the platform does not currently enforce.
  const fixedApproval = previousSettings?.approvalPreference ?? "always";
  if (parsedInput.approvalPreference !== fixedApproval) {
    throw new AppError("invalid_input", "The approval preference is fixed by iAcquire's platform approval policy and can't be changed here.");
  }
  // Clients may only disable tools from their role's default set.
  const settings = agentSettingsSchema.parse({
    ...parsedInput,
    disabledTools: parsedInput.disabledTools.filter((tool) => agent.default_tools.includes(tool)),
    approvalPreference: fixedApproval,
  });
  const company = await loadCompanyContext(db, input.orgId);
  const classification = classifyConfigChange({
    role: agent.role_key,
    previous: previousSettings,
    next: settings,
    source: input.source,
    actorKind,
    orgKind,
    company,
  });
  const { rows: vrows } = await db.query<{ next: number }>(
    "select coalesce(max(version), 0) + 1 as next from agent_config_versions where agent_instance_id = $1",
    [input.agentId],
  );
  const version = Number(vrows[0].next);
  // The version number is part of the compiled prompt, so compile after allocating it.
  const compiled = compileAgentConfig({
    role: agent.role_key,
    settings,
    company,
    version,
    allowedTools: agent.default_tools,
  });
  const compiledDecision = decisionFromRiskFlags(compiled.riskFlags);
  const decision: ConfigDecision =
    classification.decision === "blocked" || compiledDecision === "blocked"
      ? "blocked"
      : classification.decision === "review_required" || compiledDecision === "review_required"
        ? "review_required"
        : "auto_apply";
  if (decision === "blocked") {
    const detail = classification.reasons.find((reason) => reason.severity === "block")?.detail
      ?? "This change contains content that platform security does not allow.";
    throw new AppError("forbidden", `This change is blocked: ${detail}`);
  }

  const riskFlags = [...new Set([...classification.riskFlags, ...compiled.riskFlags])].sort();
  // An agency-authored draft is already a review artefact for the setup process; keep it a draft
  // instead of putting it into the pending queue as a second review step.
  const agencyDraft = input.source === "agency" && !input.apply;
  const held = decision === "review_required" && !agencyDraft;
  const status = held ? "pending_agency_review" : input.apply ? "applied" : "draft";
  const { rows } = await db.query<{ id: string }>(
    `insert into agent_config_versions (org_id, agent_instance_id, version, settings, summary, compiled_instructions,
       policy_version, risk_flags, source, change_request, status, created_by, applied_at, decided_by, decided_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
       case when $11 = 'applied' then now() end, case when $11 = 'applied' then $12::uuid end, case when $11 = 'applied' then now() end)
     returning id`,
    [
      input.orgId, input.agentId, version, JSON.stringify(compiled.settings), compiled.summary, compiled.instructions,
      compiled.policyVersion, riskFlags, input.source, input.changeRequest ?? null, status, input.userId,
    ],
  );
  const versionId = rows[0].id;
  if (status === "applied") await activateVersion(db, input.orgId, input.agentId, versionId, compiled.settings.displayName);

  const actor = input.userId
    ? (await db.query<{ role: string | null; platform_role: string | null }>(
        `select m.role, u.platform_role from users u
         left join organization_memberships m on m.user_id = u.id and m.org_id = $2
         where u.id = $1`,
        [input.userId, input.orgId],
      )).rows[0]
    : undefined;
  await recordAudit(
    {
      orgId: input.orgId,
      actorUserId: input.userId,
      actorKind,
      agentInstanceId: input.agentId,
      action: "agent.config_version_created",
      targetType: "agent_config_version",
      targetId: versionId,
      result: "success",
      metadata: {
        version,
        status,
        source: input.source,
        riskFlags,
        reviewDecision: decision,
        riskFields: [...new Set(classification.reasons.map((reason) => reason.field))].slice(0, 20),
        actorKind,
        actorRole: actor?.role ?? null,
        actorPlatformRole: actor?.platform_role ?? null,
        orgKind,
      },
    },
    db,
  );
  if (held) {
    const { rows: orgRows } = await db.query<{ name: string; kind: string }>("select name, kind from organizations where id = $1", [input.orgId]);
    const org = orgRows[0];
    const reason = classification.reasons[0];
    if (org?.kind === "client") {
      // The client gets a confirmation that their change is safe but held. The actionable review notice
      // goes to the agency reviewers who can actually access this tenant — not back to the client, and
      // not to every agency user regardless of scope. The existing agency review screen is the link.
      await notifyOrgRoles(db, input.orgId, ["owner", "admin"], {
        kind: "agent_status",
        severity: "warning",
        title: `${AGENT_BY_KEY[agent.role_key].shortName} update is waiting for iAcquire review`,
        body: `${reason ? `The change was held for review: ${reason.label.toLowerCase()}. ` : "Part of the new instructions needs a person's review. "}iAcquire will review it before it's applied.`,
        link: `/employees/${AGENT_BY_KEY[agent.role_key].slug}`,
        dedupeKey: `config-review-client:${versionId}`,
      });
      await notifyAgency(db, input.orgId, {
        kind: "approval_requested",
        severity: "warning",
        title: `${org.name}: ${AGENT_BY_KEY[agent.role_key].shortName} configuration v${version} needs review`,
        body: reason?.detail ?? "This version was held because part of the change may affect safety rules. Review the proposed settings before it can be applied.",
        link: `/admin/clients/${input.orgId}?tab=reviews`,
        dedupeKey: `config-review-agency:${versionId}`,
      });
    }
    // An internal agency workspace has no separate reviewer to notify. Sending the client-facing
    // "waiting for iAcquire review" message to the same Super Admin would be misleading; the held
    // version remains visible in Version history, the review queue and the audit log.
  }
  return {
    versionId,
    version,
    status,
    summary: compiled.summary,
    riskFlags,
    decision,
    reasons: classification.reasons.map(({ match: _match, ...reason }) => reason),
  };
}

async function activateVersion(db: Queryable, orgId: string, agentId: string, versionId: string, displayName: string) {
  await db.query(
    `update agent_config_versions set status = 'superseded'
     where agent_instance_id = $1 and status = 'applied' and id <> $2`,
    [agentId, versionId],
  );
  await db.query(
    "update agent_config_versions set status = 'applied', applied_at = coalesce(applied_at, now()) where id = $1 and org_id = $2",
    [versionId, orgId],
  );
  await db.query("update agent_instances set active_config_version_id = $2, display_name = $3 where id = $1 and org_id = $4", [
    agentId,
    versionId,
    displayName,
    orgId,
  ]);
}

/** Applies a draft version after its approval was granted. */
export async function applyDraftVersion(db: Queryable, orgId: string, versionId: string, userId: string) {
  const { rows } = await db.query<{ agent_instance_id: string; settings: AgentSettings }>(
    `update agent_config_versions set decided_by = $3, decided_at = now()
     where id = $1 and org_id = $2 and status in ('draft', 'pending_approval')
     returning agent_instance_id, settings`,
    [versionId, orgId, userId],
  );
  const v = rows[0];
  if (!v) throw new AppError("conflict", "This configuration was already applied or replaced.");
  await activateVersion(db, orgId, v.agent_instance_id, versionId, agentSettingsSchema.parse(v.settings).displayName);
}

/** Agency review of a held version. Blocked content can never be approved. */
export async function decideHeldVersion(
  db: Queryable,
  input: { orgId: string; versionId: string; approve: boolean; agencyUserId: string; decisionNote?: string },
) {
  const { rows } = await db.query<HeldConfigRow>(
    `select v.id, v.org_id, o.name as org_name, o.kind as org_kind, v.agent_instance_id,
            a.role_key, a.display_name as agent_name, v.version, v.settings, v.summary, v.source, v.risk_flags,
            v.change_request, v.created_at, v.created_by, u.full_name as created_by_name,
            u.platform_role as created_by_platform_role, membership.role as created_by_org_role,
            previous.settings as previous_settings
     from agent_config_versions v
     join agent_instances a on a.id = v.agent_instance_id
     join organizations o on o.id = v.org_id
     left join users u on u.id = v.created_by
     left join organization_memberships membership on membership.user_id = v.created_by and membership.org_id = v.org_id
     left join lateral (
       select p.settings from agent_config_versions p
       where p.agent_instance_id = v.agent_instance_id and p.version < v.version and p.status = 'applied'
       order by p.version desc limit 1
     ) previous on true
     where v.id = $1 and v.org_id = $2 and v.status = 'pending_agency_review'`,
    [input.versionId, input.orgId],
  );
  const version = rows[0];
  if (!version) throw new AppError("conflict", "This version has already been reviewed.");
  const review = buildHeldConfigReview(version);
  if (review.decision === "blocked") {
    throw new AppError("forbidden", "This version contains blocked content and can't be approved. Reject it and ask the submitter to revise it.");
  }
  if (input.approve) {
    const { rows: current } = await db.query<{ version: number | null }>(
      `select active.version from agent_instances a
       left join agent_config_versions active on active.id = a.active_config_version_id
       where a.id = $1 and a.org_id = $2`,
      [version.agent_instance_id, input.orgId],
    );
    if (current[0]?.version != null && Number(current[0].version) > Number(version.version)) {
      throw new AppError("conflict", "A newer configuration has already been applied. Reject this stale version and ask for a fresh change instead of overwriting the newer settings.");
    }
  }
  const note = String(input.decisionNote ?? "").trim().slice(0, 300) || (input.approve ? "Approved after review." : "Rejected after review.");
  const { rows: updated } = await db.query<{ id: string; agent_instance_id: string; settings: AgentSettings }>(
    `update agent_config_versions set status = $2, decided_by = $3, decided_at = now()
     where id = $1 and org_id = $4 and status = 'pending_agency_review'
     returning id, agent_instance_id, settings`,
    [input.versionId, input.approve ? "applied" : "rejected", input.agencyUserId, input.orgId],
  );
  const decided = updated[0];
  if (!decided) throw new AppError("conflict", "This version has already been reviewed.");
  if (input.approve) await activateVersion(db, input.orgId, decided.agent_instance_id, decided.id, agentSettingsSchema.parse(decided.settings).displayName);

  await recordAudit(
    {
      orgId: input.orgId,
      actorUserId: input.agencyUserId,
      actorKind: "agency",
      agentInstanceId: decided.agent_instance_id,
      action: input.approve ? "agent.config_review_approved" : "agent.config_review_rejected",
      targetType: "agent_config_version",
      targetId: decided.id,
      result: "success",
      metadata: {
        version: version.version,
        source: version.source,
        decision: input.approve ? "approved" : "rejected",
        note,
        riskFlags: version.risk_flags,
        severity: review.severity,
      },
    },
    db,
  );

  const slug = isAgentRoleKey(version.role_key) ? AGENT_BY_KEY[version.role_key].slug : "operations-manager";
  if (version.org_kind === "client") {
    const label = isAgentRoleKey(version.role_key) ? AGENT_BY_KEY[version.role_key].shortName : "Configuration";
    await notifyOrgRoles(db, input.orgId, ["owner", "admin"], {
      kind: "approval_decided",
      severity: input.approve ? "success" : "warning",
      title: input.approve ? `${label} configuration v${version.version} approved and applied` : `${label} configuration v${version.version} was not approved`,
      body: input.approve
        ? `The change is now active. ${label} will use it from the next message.`
        : "The previous configuration stays active. You can adjust the change and submit it again.",
      link: `/employees/${slug}?tab=history`,
      dedupeKey: `config-decision:${decided.id}`,
    });
  } else if (version.created_by && version.created_by !== input.agencyUserId) {
    await notifyUser(db, version.created_by, input.orgId, {
      kind: "approval_decided",
      severity: input.approve ? "success" : "warning",
      title: input.approve ? "Your configuration update was approved" : "Your configuration update needs changes",
      body: note,
      link: `/employees/${slug}?tab=history`,
      dedupeKey: `config-decision:${decided.id}`,
    });
  }
}

export async function rollbackToVersion(
  db: Queryable,
  input: { orgId: string; agentId: string; versionId: string; userId: string; actorKind?: ConfigActorKind },
) {
  const { rows } = await db.query<{ settings: AgentSettings; version: number; status: string }>(
    "select settings, version, status from agent_config_versions where id = $1 and agent_instance_id = $2 and org_id = $3",
    [input.versionId, input.agentId, input.orgId],
  );
  const target = rows[0];
  if (!target) throw new AppError("not_found", "That version wasn't found.");
  if (target.status === "rejected" || target.status === "pending_agency_review") {
    throw new AppError("invalid_input", "Only previously applied versions can be restored.");
  }
  // Historical versions may carry the old, unenforced approval preference. Restore everything else,
  // but keep the currently pinned value so rollback cannot reintroduce a stale policy toggle.
  const current = await currentSettings(db, input.agentId, input.orgId);
  return createConfigVersion(db, {
    orgId: input.orgId,
    agentId: input.agentId,
    settings: agentSettingsSchema.parse({ ...target.settings, approvalPreference: current.settings.approvalPreference }),
    source: "rollback",
    actorKind: input.actorKind,
    changeRequest: `Restore version ${target.version}`,
    userId: input.userId,
    apply: true,
  });
}

export interface RunInstructions {
  instructions: string;
  versionId: string | null;
  knowledgeEntryIds: string[];
  knowledgeDocumentIds: string[];
  knowledgeTruncated: boolean;
}

/**
 * Layered run instructions: the employee configuration, then approved company and employee knowledge, then the
 * immutable agency policy last so later context can never overshadow it.
 */
export async function composeRunInstructions(
  db: Queryable,
  orgId: string,
  agentId: string,
  compiledInstructions: string,
  versionId: string | null,
): Promise<RunInstructions> {
  const knowledge = await employeeKnowledgeContext(db, orgId, agentId);
  // The agency policy must stay last so it is never overshadowed by later context.
  const [head, policy] = splitPolicy(compiledInstructions);
  return {
    instructions: [head, knowledge.block, policy].filter(Boolean).join("\n\n"),
    versionId,
    knowledgeEntryIds: knowledge.entryIds,
    knowledgeDocumentIds: knowledge.documentIds,
    knowledgeTruncated: knowledge.truncated,
  };
}

/** Run-time instructions for the employee's currently applied configuration. */
export async function buildRunInstructions(db: Queryable, orgId: string, agentId: string): Promise<RunInstructions> {
  const { rows } = await db.query<{ compiled_instructions: string | null; id: string | null }>(
    `select v.compiled_instructions, v.id from agent_instances a
     left join agent_config_versions v on v.id = a.active_config_version_id
     where a.id = $1 and a.org_id = $2`,
    [agentId, orgId],
  );
  const base = rows[0];
  if (!base?.compiled_instructions) throw new AppError("agent_unavailable", "This employee hasn't been configured yet.");
  return composeRunInstructions(db, orgId, agentId, base.compiled_instructions, base.id);
}

/**
 * Compiles a candidate configuration without storing or applying it. Used by the draft test environment, so testing a
 * change can never modify the live employee.
 */
export async function compileDraftConfig(
  db: Queryable,
  orgId: string,
  agentId: string,
  settings: AgentSettings,
): Promise<{ compiled: ReturnType<typeof compileAgentConfig>; version: number }> {
  const { rows } = await db.query<{ role_key: string; default_tools: string[] }>(
    "select a.role_key, r.default_tools from agent_instances a join agent_roles r on r.key = a.role_key where a.id = $1 and a.org_id = $2",
    [agentId, orgId],
  );
  const agent = rows[0];
  if (!agent || !isAgentRoleKey(agent.role_key)) throw new AppError("not_found", "AI employee not found.");
  const { rows: versionRows } = await db.query<{ next: number }>(
    "select coalesce(max(version), 0) + 1 as next from agent_config_versions where agent_instance_id = $1",
    [agentId],
  );
  const version = Number(versionRows[0]?.next ?? 1);
  const compiled = compileAgentConfig({
    role: agent.role_key,
    settings,
    company: await loadCompanyContext(db, orgId),
    version,
    allowedTools: agent.default_tools,
  });
  return { compiled, version };
}

function splitPolicy(compiled: string): [string, string] {
  const marker = "## Agency policy";
  const idx = compiled.indexOf(marker);
  return idx === -1 ? [compiled, ""] : [compiled.slice(0, idx).trimEnd(), compiled.slice(idx)];
}

// ---------------------------------------------------------------------------
// Hermes connection and health
// ---------------------------------------------------------------------------

export function validateHermesBaseUrl(raw: string): string {
  return validateIntegrationEndpoint(raw, ["hermes-api.iacquire.online"]);
}

async function loadPersistedInventoryDigest(db: Queryable, agentId: string): Promise<string | null> {
  try {
    await db.query("savepoint tool_inventory_digest_lookup");
    const { rows } = await db.query<{ tool_inventory_digest: string | null }>(
      "select tool_inventory_digest from agent_instances where id = $1",
      [agentId],
    );
    await db.query("release savepoint tool_inventory_digest_lookup");
    return rows[0]?.tool_inventory_digest ?? null;
  } catch {
    // Migration 0059 may not be applied yet. Roll back only this lookup so the caller's
    // transaction stays usable; no persisted digest is fail-closed.
    try {
      await db.query("rollback to savepoint tool_inventory_digest_lookup");
    } catch {
      /* the savepoint itself may be unavailable; the caller will still fail closed */
    }
    return null;
  }
}

/** Whether the additive inventory-attestation columns from migration 0059 are present. */
export async function toolInventorySchemaReady(db: Queryable): Promise<boolean> {
  try {
    const { rows } = await db.query(
      "select 1 from information_schema.columns where table_schema = 'public' and table_name = 'agent_instances' and column_name = 'tool_inventory_digest' limit 1",
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

export async function loadConnection(db: Queryable, agentId: string): Promise<HermesConnection | null> {
  const { rows } = await db.query<{ org_id:string; credential_id:string|null; hermes_gateway_id:string|null; hermes_base_url: string | null; hermes_profile: string | null; ciphertext: string | null; revoked_at: Date | null }>(
    `select a.org_id,a.credential_id,a.hermes_gateway_id,a.hermes_base_url,a.hermes_profile,c.ciphertext,c.revoked_at
     from agent_instances a left join integration_credentials c on c.id = a.credential_id
     where a.id = $1`,
    [agentId],
  );
  const r = rows[0];
  if (!r?.hermes_base_url || !r.ciphertext || r.revoked_at) return null;
  if (!r.credential_id) return null;
  const apiKey = await resolveCredential(db,r.credential_id,r.org_id,"hermes");
  if (!apiKey) return null;
  const access = await loadHermesAccessCredentials(db, r.hermes_gateway_id);
  const expectedToolInventoryDigest = await loadPersistedInventoryDigest(db, agentId);
  return { baseUrl: r.hermes_base_url, profile: r.hermes_profile, apiKey, expectedToolInventoryDigest, ...(access ?? {}) };
}

/** Server-only profile connection for a trusted service check. Credentials are never serialized to a client. */
export async function loadHermesConnectionForAgent(agentId: string): Promise<HermesConnection | null> {
  return withServiceRole((db) => loadConnection(db, agentId));
}

/** Agency-only: attach a Hermes profile endpoint and its per-profile API key to a tenant employee. */
export async function connectHermesProfile(input: {
  agentId: string;
  baseUrl?: string;
  profile: string;
  apiKey: string;
  agencyUserId: string;
  gatewayId?: string;
}) {
  let baseUrl = input.baseUrl ? validateHermesBaseUrl(input.baseUrl) : "";
  const profile = input.profile.trim();
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(profile)) throw new AppError("invalid_input", "Profile names use lowercase letters, numbers, dashes and underscores.");
  const apiKey = input.apiKey.trim();
  if (apiKey.length < 24) throw new AppError("invalid_input", "The profile API key looks too short. Use the profile's own API_SERVER_KEY.");
  return withSystem(async (db) => {
    const { rows } = await db.query<{ org_id: string; kind: string; role_key: string }>(
      "select a.org_id, o.kind, a.role_key from agent_instances a join organizations o on o.id = a.org_id where a.id = $1",
      [input.agentId],
    );
    const agent = rows[0];
    if (!agent) throw new AppError("not_found", "AI employee not found.");
    let gatewayId: string | null = null;
    if (input.gatewayId) {
      const { rows: gatewayRows } = await db.query<{ id: string; base_url: string; gateway_type: string }>(
        "select id,base_url,gateway_type from hermes_gateways where id=$1 and status <> 'disconnected'",
        [input.gatewayId],
      );
      const gateway = gatewayRows[0];
      if (!gateway) throw new AppError("not_found", "Approved Hermes gateway not found.");
      const registeredBaseUrl = validateHermesBaseUrl(gateway.base_url);
      if (baseUrl && registeredBaseUrl !== baseUrl) throw new AppError("invalid_input", "The profile URL must match its selected gateway.");
      baseUrl = registeredBaseUrl;
      gatewayId = gateway.id;
      if (gateway.gateway_type === "single_profile") {
        const { rows: mapped } = await db.query<{ count: number }>(
          "select count(*)::int as count from agent_instances where hermes_gateway_id=$1 and id<>$2 and hermes_profile is not null",
          [gateway.id, input.agentId],
        );
        if (mapped[0]?.count) throw new AppError("conflict", "This gateway is registered for one profile and cannot serve another workforce employee.");
      }
    } else {
      if (!baseUrl) throw new AppError("invalid_input", "Choose an approved Hermes gateway.");
      const { rows: gatewayRows } = await db.query<{ id: string }>(
        "select id from hermes_gateways where rtrim(base_url,'/')=rtrim($1,'/') and status <> 'disconnected'",
        [baseUrl],
      );
      gatewayId = gatewayRows[0]?.id ?? null;
      if (!gatewayId && process.env.NODE_ENV !== "test") throw new AppError("invalid_input", "Select an iAcquire-registered Hermes gateway before mapping this profile.");
    }
    if (agent.kind === "client" && isReservedProfile(profile)) {
      throw new AppError("invalid_input", "Internal iAcquire profiles can't be assigned to client workspaces. Provision a dedicated profile.");
    }
    const { rows: dupe } = await db.query("select 1 from agent_instances where hermes_base_url = $1 and hermes_profile = $2 and id <> $3", [
      baseUrl,
      profile,
      input.agentId,
    ]);
    if (dupe.length) throw new AppError("conflict", "That Hermes profile already backs another employee. Each employee needs its own profile.");
    const {rows:old}=await db.query<{credential_id:string|null}>("select credential_id from agent_instances where id=$1",[input.agentId]);
    const cred = await saveCredential(db,{orgId:agent.org_id,provider:"hermes",label:`Hermes profile ${profile}`,secret:apiKey,actorId:input.agencyUserId,replaces:old[0]?.credential_id});
    const inventorySchema = await toolInventorySchemaReady(db);
    if (inventorySchema) {
      await db.query(
        `update agent_instances set hermes_base_url = $2, hermes_profile = $3, credential_id = $4, hermes_gateway_id = $5,
           status = 'provisioning', last_health_ok = null, last_health_detail = 'Awaiting first health check',
           tool_inventory_contract = null, tool_inventory_digest = null, tool_inventory_verified_at = null,
           tool_inventory_expires_at = null, tool_inventory_tool_count = null,
           tool_inventory_snapshot = '{}'::jsonb, tool_inventory_detail = null
         where id = $1`,
        [input.agentId, baseUrl, profile, cred.id, gatewayId],
      );
    } else {
      await db.query(
        `update agent_instances set hermes_base_url = $2, hermes_profile = $3, credential_id = $4, hermes_gateway_id = $5,
           status = 'provisioning', last_health_ok = null, last_health_detail = 'Awaiting first health check'
         where id = $1`,
        [input.agentId, baseUrl, profile, cred.id, gatewayId],
      );
    }
    await db.query(
      `update agent_provisioning_jobs set status = 'awaiting_health_check', handled_by = $2
       where agent_instance_id = $1 and status in ('requested', 'in_progress')`,
      [input.agentId, input.agencyUserId],
    );
    await recordAudit(
      {
        orgId: agent.org_id,
        actorUserId: input.agencyUserId,
        actorKind: "agency",
        agentInstanceId: input.agentId,
        action: "agent.hermes_connected",
        targetType: "agent_instance",
        targetId: input.agentId,
        result: "success",
        metadata: { profile, host: new URL(baseUrl).host, gatewayId },
      },
      db,
    );
  });
}

export interface HealthResult {
  ok: boolean;
  status: AgentStatus;
  detail: string;
}

const HEALTH_DETAIL: Record<string, string> = {
  unreachable: "Hermes could not be reached.",
  auth_failed: "Hermes rejected this profile's API key.",
  not_found: "The profile route wasn't found. Check the profile name and multiplex gateway.",
  timeout: "Hermes did not respond in time.",
  rate_limited: "Hermes is busy (concurrent-run limit reached).",
  bad_response: "Hermes returned an unexpected response.",
  upstream: "Hermes reported a server error.",
};

/**
 * Refreshes an AI employee's connection status when the last check is stale. Called from the chat
 * page after its response, so the first message does not pay the provider round trips itself.
 */
export async function refreshAgentHealthIfStale(agentId: string, userId: string): Promise<void> {
  const { rows } = await withSystem((db) =>
    db.query<{ last_health_check_at: Date | null }>("select last_health_check_at from agent_instances where id = $1", [agentId]),
  );
  const checkedAt = rows[0]?.last_health_check_at ? new Date(rows[0].last_health_check_at).getTime() : 0;
  if (Date.now() - checkedAt <= 10 * 60 * 1000) return;
  await runHealthCheck(agentId, { userId, kind: "system" }).catch(() => undefined);
}

/**
 * A health check rewrites the employee's status, inventory attestation and integration status, so an
 * agency actor needs the same management permission and client scope as every other workforce write.
 * The check runs before the credential is resolved (which itself appends an audit row) and before any
 * gateway request. `system` calls are internal refresh paths; a client user may not drive this action.
 */
async function assertCanRunHealthCheck(db: Queryable, agentOrgId: string, actor: { userId: string | null; kind: "agency" | "system" | "user" }) {
  if (actor.kind === "system") return;
  if (actor.kind === "user") {
    throw new AppError("forbidden", "Only an agency manager or Super Admin can run a health check.");
  }
  if (!actor.userId) throw new AppError("forbidden", "An agency identity is required to run a health check.");
  const { rows } = await db.query<{ allowed: boolean }>(
    "select app.user_can_access_org($1,$2) and app.user_has_agency_permission($1,'agency.workforce.manage') as allowed",
    [actor.userId, agentOrgId],
  );
  if (rows[0]?.allowed !== true) {
    throw new AppError("forbidden", "Your agency role or client scope does not allow running a health check.");
  }
}

/** Performs a real authenticated capabilities check and records the outcome. */
export async function runHealthCheck(
  agentId: string,
  actor: { userId: string | null; kind: "agency" | "system" | "user" },
  opts: { skipSetupSync?: boolean } = {},
): Promise<HealthResult> {
  const { conn, orgId, enabled, hasConfig, previousInventoryDigest } = await withSystem(async (db) => {
    const { rows } = await db.query<{ org_id: string; enabled: boolean; active_config_version_id: string | null }>(
      "select org_id, enabled, active_config_version_id from agent_instances where id = $1",
      [agentId],
    );
    if (!rows[0]) throw new AppError("not_found", "AI employee not found.");
    await assertCanRunHealthCheck(db, rows[0].org_id, actor);
    return {
      conn: await loadConnection(db, agentId),
      orgId: rows[0].org_id,
      enabled: rows[0].enabled,
      hasConfig: Boolean(rows[0].active_config_version_id),
      previousInventoryDigest: await loadPersistedInventoryDigest(db, agentId),
    };
  });

  let result: HealthResult;
  let inventory: { snapshot: ToolInventorySnapshot | null; detail: string | null } = { snapshot: null, detail: null };
  if (!enabled) result = { ok: false, status: "disabled", detail: "This employee isn't enabled for the workspace." };
  else if (!conn) result = { ok: false, status: "setup_required", detail: "No dedicated Hermes profile is connected yet." };
  else {
    try {
      const caps = await getCapabilities(conn);
      const identity=await getProfileModels(conn);
      // Fail closed: an employee only goes online when its tool exposure can be verified as safe.
      let restricted: string[] | null = null;
      try {
        restricted = restrictedToolsIn(await getToolsets(conn));
      } catch {
        restricted = null;
      }
      if (!conn.profile || !identity.includes(conn.profile) || caps.contract !== "hermes.api_server.capabilities" || !caps.authenticated) {
        result = { ok:false,status:"error",detail:"The gateway did not verify the intended profile identity and authenticated Hermes API contract." };
      } else if (!caps.supportsRuns) {
        result = { ok: false, status: "error", detail: "This Hermes version doesn't advertise run submission." };
      } else if (!caps.supportsEvents && !caps.supportsStatus) {
        result = { ok: false, status: "error", detail: "This Hermes version doesn't advertise run events or a run-status endpoint." };
      } else if (restricted === null) {
        result = { ok: false, status: "error", detail: "Couldn't verify the profile's tool restrictions (GET /v1/toolsets)." };
      } else if (restricted.length) {
        const sample = restricted.slice(0, 8).join(", ");
        result = {
          ok: false,
          status: "error",
          detail: `Profile exposes ${restricted.length} restricted or unreviewed tool${restricted.length === 1 ? "" : "s"}: ${sample}${restricted.length > 8 ? ", …" : ""}. Disable them in the Hermes profile before going live.`,
        };
      } else {
        try {
          // A health check reads the catalog twice so an inventory that is changing under us
          // cannot be recorded as a stable attestation.
          const snapshot = await verifyToolInventory(conn, {
            expectedDigest: previousInventoryDigest,
            stabilityReads: 2,
            purpose: "health",
          });
          inventory = {
            snapshot,
            detail: `Complete runtime inventory verified: ${snapshot.toolCount} tool${snapshot.toolCount === 1 ? "" : "s"} across ${snapshot.enabledToolsets.length} reviewed toolsets (digest ${snapshot.digest.slice(0, 12)}…).`,
          };
          if (!hasConfig) {
            result = {
              ok: false,
              status: "setup_required",
              detail: `${inventory.detail} The employee configuration hasn't been applied yet, so it can't go online. A Super Admin needs to save an initial configuration for this employee in its own workspace (AI Employees, open the employee, save its settings), then run the health check again.`,
            };
          } else {
            result = {
              ok: true,
              status: "online",
              detail: `Profile identity, API capabilities and the complete runtime tool inventory verified (${snapshot.toolCount} reviewed tools; no plugin, MCP, connector or Tool Search bridge access)${
                caps.supportsEvents ? "" : " · streaming not supported; the full response arrives when complete"
              }${caps.supportsStop ? "" : " · stop not supported"}`,
            };
          }
        } catch (err) {
          if (!(err instanceof ToolInventoryError)) throw err;
          inventory = { snapshot: err.detail.snapshot ?? null, detail: err.message };
          if (err.detail.code === "inventory_changed" && err.detail.snapshot) {
            // Record the newly observed safe snapshot, but stay provisioning for one explicit
            // confirmation check. This is the review gate for an unexpected inventory change.
            result = {
              ok: false,
              status: "provisioning",
              detail: `${err.message} The newly observed inventory has been recorded; review it and run the health check again to confirm.`,
            };
          } else if (err.detail.code === "inventory_changed") {
            result = { ok: false, status: "provisioning", detail: `${err.message} No inventory change was recorded.` };
          } else {
            const code = err.detail.code;
            result = {
              ok: false,
              status: code === "contract_unavailable" ? "setup_required" : code === "inventory_unavailable" ? "offline" : "error",
              detail: `${err.message} Live runs stay blocked.`,
            };
          }
        }
      }
    } catch (err) {
      const kind = err instanceof HermesError ? err.kind : "unreachable";
      result = { ok: false, status: kind === "auth_failed" || kind === "not_found" ? "error" : "offline", detail: HEALTH_DETAIL[kind] ?? "Health check failed." };
    }
  }

  const columns = inventoryColumns(inventory.snapshot, inventory.detail);
  const schemaReady = await withSystem((db) => toolInventorySchemaReady(db));
  if (!schemaReady && inventory.snapshot) {
    result = {
      ok: false,
      status: "setup_required",
      detail: `${result.detail} Migration 0059 (tool-inventory attestation) is not applied, so the verified inventory cannot be persisted; live runs stay blocked.`,
    };
  }
  await withSystem(async (db) => {
    const { rows } = await db.query<{ status: AgentStatus }>("select status from agent_instances where id = $1", [agentId]);
    const previous = rows[0]?.status;
    if (schemaReady) {
      await db.query(
        `update agent_instances set status = $2, last_health_check_at = now(), last_health_ok = $3, last_health_detail = $4,
           tool_inventory_contract = $5, tool_inventory_digest = $6, tool_inventory_verified_at = $7,
           tool_inventory_expires_at = $8, tool_inventory_tool_count = $9, tool_inventory_snapshot = $10::jsonb,
           tool_inventory_detail = $11
         where id = $1`,
        [
          agentId,
          result.status,
          result.ok,
          result.detail,
          columns.toolInventoryContract,
          columns.toolInventoryDigest,
          columns.toolInventoryVerifiedAt,
          columns.toolInventoryExpiresAt,
          columns.toolInventoryToolCount,
          JSON.stringify(columns.toolInventorySnapshot),
          columns.toolInventoryDetail,
        ],
      );
    } else {
      await db.query(
        "update agent_instances set status = $2, last_health_check_at = now(), last_health_ok = $3, last_health_detail = $4 where id = $1",
        [agentId, result.status, result.ok, result.detail],
      );
    }
    if (result.ok) {
      await db.query(
        "update agent_provisioning_jobs set status = 'succeeded' where agent_instance_id = $1 and status = 'awaiting_health_check'",
        [agentId],
      );
    }
    await db.query(
      `insert into integration_status (org_id, provider, status, detail, last_checked_at)
       values ($1, 'hermes', $2, $3, now())
       on conflict (coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid), provider)
       do update set status = excluded.status, detail = excluded.detail, last_checked_at = now(), updated_at = now()`,
      [orgId, result.ok ? "connected" : conn ? "error" : "not_configured", result.detail],
    );
    if (previous && previous !== result.status && (previous === "online" || result.status === "online")) {
      const { rows: a } = await db.query<{ role_key: AgentRoleKey }>("select role_key from agent_instances where id = $1", [agentId]);
      const meta = a[0] ? AGENT_BY_KEY[a[0].role_key] : null;
      if (meta) {
        await notifyOrgRoles(db, orgId, ["owner", "admin"], {
          kind: result.ok ? "agent_status" : "integration_disconnected",
          severity: result.ok ? "success" : "warning",
          title: result.ok ? `${meta.shortName} is online` : `${meta.shortName} is ${result.status === "offline" ? "offline" : "unavailable"}`,
          body: result.detail,
          link: `/employees/${meta.slug}`,
        });
      }
    }
    await recordAudit(
      {
        orgId,
        actorUserId: actor.userId,
        actorKind: actor.kind,
        agentInstanceId: agentId,
        action: "agent.health_check",
        targetType: "agent_instance",
        targetId: agentId,
        result: result.ok ? "success" : "failure",
        metadata: {
          status: result.status,
          inventoryContract: inventory.snapshot?.contract ?? null,
          inventoryDigest: inventory.snapshot?.digest ?? null,
          inventoryToolCount: inventory.snapshot?.toolCount ?? null,
          inventoryVerified: Boolean(inventory.snapshot),
          inventoryDetail: inventory.detail?.slice(0, 300) ?? null,
        },
      },
      db,
    );
  });
  // Let the client's setup checklist react to the recorded outcome (it never contacts Hermes itself).
  if (!opts.skipSetupSync) {
    try {
      const { reconcileSetupAutomation } = await import("@/server/setup/automation");
      await reconcileSetupAutomation(orgId);
    } catch {
      if (process.env.NODE_ENV !== "test") console.error("[iacquire] setup sync after health check failed");
    }
  }
  return result;
}

/** Marks an employee offline after a live failure, without waiting for the next health check. */
export async function markAgentDegraded(agentId: string, detail: string) {
  await withSystem((db) =>
    db.query(
      "update agent_instances set status = 'offline', last_health_ok = false, last_health_detail = $2, last_health_check_at = now() where id = $1 and status in ('online', 'busy')",
      [agentId, detail.slice(0, 500)],
    ),
  );
}
