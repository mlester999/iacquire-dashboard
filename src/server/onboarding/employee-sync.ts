import "server-only";
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyOrgRoles } from "@/server/notifications";
import { AI_GROWTH_PARTNER_ROLE_KEY, AGENT_BY_KEY, isAgentRoleKey, isWorkforceRoleKey, workforceRoleName, type AgentRoleKey, type WorkforceRoleKey } from "@/lib/agents";
import { agentSettingsSchema, type AgentSettings, type OnboardingData } from "@/lib/agent-settings";
import { confirmedAnswers, planScope, toKnowledgeSections, toLegacyData } from "@/lib/onboarding/engine";
import { parseProfileSnapshot, type ProfileKey, type ProfileValues } from "@/lib/onboarding/business-profile";
import type { Answers } from "@/lib/onboarding/types";
import type { SessionUser } from "@/server/auth/service";
import type { OrgContext } from "@/server/tenancy/context";
import { compileAgentConfig, defaultSettings, detectRiskFlags, sanitizeClientText, summarizeSettings } from "@/server/workforce/compiler";
import { createConfigVersion, currentSettings, isReservedProfile, loadCompanyContext, queueSyncJob } from "@/server/workforce/service";
import { PROVISIONING_PAYMENT_CLEARED_SQL, requestProvisioning } from "@/server/workforce/provisioning";
import { writeKnowledgeTextTx } from "@/server/knowledge/write";
import { revokeClientBusinessCredentialsForAgent } from "@/server/workforce/hermes-client-business-credential";
import { answerTimes, loadAnswerRows, toStored, type AnswerRow } from "@/server/onboarding/answers";
import { appliedThrough, lockOnboardingRow, type SnapshotRow } from "@/server/onboarding/profile-sync";
import { buildEmployeeSettings, manualOverridesFromHistory, mergeBusinessUpdate, type GeneratedSettings } from "@/server/onboarding/employee-generator";
import { syncGrowthPartnerBusinessBrainFromProfile } from "@/server/ai-growth-partner/service";

// The one place that decides what an AI employee's configuration is, from the client's answers. Four callers share it: a questionnaire submission (applyOnboarding in
// ./service.ts), an employee added to the plan after the client finished (applyRolePlanChange), a business-information edit made outside the questionnaire
// (refreshEmployeesFromWorkspace), and the question "is every employee running what the answers say" (employeeSyncState). Nothing here sends a message, books anyone or turns a
// customer-facing feature on; an employee stays "Setup required" until its Hermes profile passes its own checks.

export interface GeneratedEmployee {
  role: WorkforceRoleKey;
  name: string;
  summary: string;
  configStatus: string;
  agentStatus: string;
}

/** Who a new configuration version is attributed to. `actorKind` follows the person: agency staff, or the client's own member. */
export interface EmployeeActor {
  orgId: string;
  userId: string;
  actorKind: "agency" | "user";
}

const actorOf = (ctx: Pick<OrgContext, "org" | "user">): EmployeeActor => ({
  orgId: ctx.org.orgId,
  userId: ctx.user.id,
  actorKind: ctx.org.kind === "agency" || ctx.user.platformRole !== "none" ? "agency" : "user",
});

/** What a submission knows beyond the legacy data: whether it is the first one, and the model-written preferences when there were any. */
export interface AnswerBasis {
  firstSubmission: boolean;
  generated: Record<AgentRoleKey, GeneratedSettings> | null;
}

interface AgentRef {
  id: string;
  role_key: string;
  status: string;
  active_config_version_id: string | null;
  enabled?: boolean;
}

/** Shown to the client as the job's own detail, and how a re-enabled employee recognises a request this module cancelled (an agency's own cancellation is never reopened). */
export const PLAN_REMOVED_DETAIL = "Removed from the plan.";

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

// ---------------------------------------------------------------------------
// From answers: one employee, and all of them
// ---------------------------------------------------------------------------

/**
 * Builds or updates ONE employee's configuration from the answers and records it as a version. A first configuration is the generated (or deterministic) settings plus the client's
 * role answers; a later one merges the business facts into the employee's current settings and keeps every field the client changed. Nothing is written when the result equals
 * what the employee already runs, or what is already waiting for review.
 */
export async function ensureEmployeeConfigFromAnswers(
  db: Queryable,
  who: EmployeeActor,
  input: { role: AgentRoleKey; agent: AgentRef; data: OnboardingData; basis?: AnswerBasis; changeRequest?: string },
): Promise<GeneratedEmployee> {
  const { role, agent, data, basis } = input;
  const orgId = who.orgId;
  const answers = Object.fromEntries(
    AGENT_BY_KEY[role].questions
      .map((q) => [q.id, sanitizeClientText(data.workforce.answers[role]?.[q.id] ?? "", 1000)] as const)
      .filter(([, v]) => v),
  );
  let settings = basis ? (basis.generated?.[role]?.settings ?? buildEmployeeSettings(role, data)) : defaultSettings(role, data.communication);
  if (agent.active_config_version_id) {
    // Keep manual changes to every preference. Refresh the compiled company context and only
    // replace role answers that still equal the prior onboarding-generated value.
    const current = (await currentSettings(db, agent.id, orgId)).settings;
    const { rows: priorRows } = await db.query<{ settings: unknown }>(
      `select settings from agent_config_versions where agent_instance_id = $1 and org_id = $2 and source = 'onboarding'
       and applied_at is not null
       order by version desc limit 1`,
      [agent.id, orgId],
    );
    const prior = priorRows[0] ? agentSettingsSchema.safeParse(priorRows[0].settings) : null;
    const { rows: history } = await db.query<{ source: string; settings: unknown }>(
      `select source, settings from agent_config_versions
       where agent_instance_id = $1 and org_id = $2 and applied_at is not null
       order by version`,
      [agent.id, orgId],
    );
    const { rows: pendingManual } = await db.query<{ source: string; settings: unknown }>(
      `select source, settings from agent_config_versions
       where agent_instance_id = $1 and org_id = $2 and status = 'pending_agency_review' and source <> 'onboarding'
       order by version desc limit 1`,
      [agent.id, orgId],
    );
    const pendingEdit = pendingManual[0] ? agentSettingsSchema.safeParse(pendingManual[0].settings) : null;
    const latest = pendingEdit?.success ? pendingEdit.data : current;
    const provenance = pendingEdit?.success ? [...history, pendingManual[0]] : history;
    settings = prior?.success ? mergeBusinessUpdate(role, latest, prior.data, data, manualOverridesFromHistory(provenance)) : latest;
  } else {
    if (basis && !basis.firstSubmission) {
      const { rows: priorPending } = await db.query<{ settings: unknown }>(
        `select settings from agent_config_versions
         where agent_instance_id = $1 and org_id = $2 and source = 'onboarding' and status = 'pending_agency_review'
         order by version desc limit 1`,
        [agent.id, orgId],
      );
      const held = priorPending[0] ? agentSettingsSchema.safeParse(priorPending[0].settings) : null;
      if (held?.success) settings = mergeBusinessUpdate(role, held.data, held.data, data);
    }
    settings = agentSettingsSchema.parse({ ...settings, roleAnswers: { ...settings.roleAnswers, ...answers } });
  }
  if (agent.active_config_version_id) {
    const { rows: activeRows } = await db.query<{ version: number; settings: unknown; compiled_instructions: string; default_tools: string[] }>(
      `select v.version, v.settings, v.compiled_instructions, r.default_tools
       from agent_config_versions v join agent_instances a on a.id = v.agent_instance_id
       join agent_roles r on r.key = a.role_key
       where v.id = $1 and v.org_id = $2`,
      [agent.active_config_version_id, orgId],
    );
    const active = activeRows[0];
    const activeSettings = active ? agentSettingsSchema.safeParse(active.settings) : null;
    if (active && activeSettings?.success && isDeepStrictEqual(settings, activeSettings.data)) {
      const company = await loadCompanyContext(db, orgId);
      const refreshed = compileAgentConfig({ role, settings, company, version: Number(active.version), allowedTools: active.default_tools });
      if (refreshed.instructions === active.compiled_instructions) {
        return { role, name: AGENT_BY_KEY[role].name, summary: refreshed.summary, configStatus: "unchanged", agentStatus: agent.status };
      }
    }
  }
  if (basis) {
    const { rows: pendingRows } = await db.query<{ version: number; settings: unknown; compiled_instructions: string; summary: string; default_tools: string[] }>(
      `select v.version, v.settings, v.compiled_instructions, v.summary, r.default_tools
       from agent_config_versions v join agent_instances a on a.id = v.agent_instance_id
       join agent_roles r on r.key = a.role_key
       where v.agent_instance_id = $1 and v.org_id = $2 and v.source = 'onboarding' and v.status = 'pending_agency_review'
       order by v.version desc limit 1`,
      [agent.id, orgId],
    );
    const pending = pendingRows[0];
    const parsedPending = pending ? agentSettingsSchema.safeParse(pending.settings) : null;
    if (pending && parsedPending?.success && isDeepStrictEqual(settings, parsedPending.data)) {
      const company = await loadCompanyContext(db, orgId);
      const refreshed = compileAgentConfig({ role, settings, company, version: Number(pending.version), allowedTools: pending.default_tools });
      if (refreshed.instructions === pending.compiled_instructions) {
        return { role, name: AGENT_BY_KEY[role].name, summary: pending.summary, configStatus: "unchanged", agentStatus: agent.status };
      }
    }
  }
  const v = await createConfigVersion(db, {
    orgId,
    agentId: agent.id,
    settings,
    source: "onboarding",
    changeRequest: input.changeRequest ?? (basis && !basis.firstSubmission
      ? "Synchronized confirmed business changes; existing employee style preserved."
      : basis?.generated?.[role]?.source === "safe_defaults"
        ? "Safe deterministic defaults used; AI preference generation was unavailable or invalid."
        : basis?.generated?.[role]?.fallbackFields?.length
          ? `AI generated safe role preferences; protected role-template defaults restored for ${basis.generated[role].fallbackFields.join(", ")}.`
        : "Generated from confirmed onboarding and protected role templates."),
    actorKind: who.actorKind,
    userId: who.userId,
    apply: true,
  });
  return { role, name: AGENT_BY_KEY[role].name, summary: v.summary, configStatus: v.status, agentStatus: agent.status };
}

/** The selected employees, one after another, from the answers a submission just confirmed. */
function growthPartnerSettingsFromOnboarding(data: OnboardingData): AgentSettings {
  const settings = defaultSettings(AI_GROWTH_PARTNER_ROLE_KEY, data.communication);
  const targetCustomers = [...new Set(sanitizeClientText(data.business.idealCustomers, 1000).split(/\n+/).map((value) => value.trim()).filter(Boolean))].join("\n");
  const selectedGoals = [
    ...data.goals.selected.map((goal) => sanitizeClientText(goal, 80)).filter(Boolean),
    sanitizeClientText(data.goals.other, 200),
  ].filter(Boolean);
  const requestedBehavior = data.communication.aiBehavior ?? "answer_handoff";
  const personalityApproach = requestedBehavior === "answer_book"
    ? "practical and proactive about permitted routine work and scheduling"
    : requestedBehavior === "draft_only"
      ? "careful and review-led, preparing work for people to approve"
      : "responsive and collaborative, with clear handoffs for decisions and customer commitments";
  const behaviorPreference = requestedBehavior === "answer_book"
    ? "The client prefers routine answers, lead qualification and booking when the calendar connection, permissions, availability and approval rules allow. This preference grants no permission."
    : requestedBehavior === "draft_only"
      ? "The client prefers draft-only behavior: prepare work for review and never send or make customer-facing changes automatically."
      : "The client prefers answers followed by a handoff; do not book or follow up without a person. This preference grants no permission."
  return agentSettingsSchema.parse({
    ...settings,
    personality: `A steady, accountable AI Growth Partner with a ${settings.tone} voice and ${settings.replyLength} replies in ${settings.language}. It is ${personalityApproach}. Across all six capabilities, it stays helpful, curious, evidence-led, transparent about uncertainty, and bounded by current permissions.`,
    characterTraits: "Reliable, organized, thoughtful, transparent about uncertainty, and calm under pressure.",
    communicationStyle: `Use a ${settings.tone} tone, ${settings.replyLength} replies, and ${settings.language}. Apply any approved brand voice and prefer clear, plain language.`,
    responseBehavior: "Answer directly. Distinguish confirmed facts from unknowns. Report an action as complete only after its authorized service confirms the persisted result.",
    operatingProcedures: "Use the active Business Brain and tenant-scoped application services. Check current permissions and approval state before every write. Preserve duplicate checks, idempotency, and audit history.",
    proactiveResponsibilities: `Work toward the client's selected goals through enabled sources, configured schedules, and permitted internal tasks. ${behaviorPreference} Keep external communication behind the required approval.`,
    reportingBehavior: "Report verified outcomes with evidence, current status, blockers, pending approvals, and next steps through the permanent conversation or Work Board.",
    responsibilities: "Coordinate six internal capability domains as one AI Growth Partner: lead discovery and qualification; sales support; calendar and appointments; CRM and pipeline; business operations; performance and analytics.",
    goals: selectedGoals.length
      ? `Work toward these client-selected objectives: ${selectedGoals.join("; ")}. Treat them as targets, never guaranteed outcomes.`
      : "Help the client acquire customers through accurate, approved work and report measured results.",
    targetCustomers,
    companyRules: data.communication.companyRules,
    neverPromise: data.communication.neverPromise,
    escalateWhen: data.communication.escalateWhen,
  });
}

const GROWTH_PARTNER_ONBOARDING_FIELDS = [
  "tone", "replyLength", "language", "personality", "communicationStyle", "targetCustomers", "companyRules", "neverPromise", "escalateWhen", "goals", "proactiveResponsibilities",
] as const;

/** Updates only Growth Partner fields that still match the last onboarding version; client-written settings remain theirs. */
function mergeGrowthPartnerBusinessUpdate(
  current: AgentSettings,
  previousOnboarding: AgentSettings,
  data: OnboardingData,
  manualOverrides: ReadonlySet<string>,
): AgentSettings {
  const fresh = growthPartnerSettingsFromOnboarding(data);
  const next: AgentSettings = { ...current, roleAnswers: { ...current.roleAnswers } };
  for (const field of GROWTH_PARTNER_ONBOARDING_FIELDS) {
    if (!manualOverrides.has(field) && current[field] === previousOnboarding[field]) {
      (next as unknown as Record<string, string>)[field] = fresh[field];
    }
  }
  return agentSettingsSchema.parse(next);
}

/** Keeps the single Growth Partner configuration aligned with newly confirmed onboarding answers. */
async function ensureGrowthPartnerConfigFromAnswers(
  db: Queryable,
  who: EmployeeActor,
  input: { agent: AgentRef; data: OnboardingData },
): Promise<GeneratedEmployee> {
  const { agent, data } = input;
  const orgId = who.orgId;
  const pendingRows = await db.query<{ version: number; settings: unknown; summary: string; source: string }>(
    `select v.version, v.settings, v.summary, v.source
     from agent_config_versions v where v.agent_instance_id = $1 and v.org_id = $2 and v.status = 'pending_agency_review'
     order by v.version desc limit 1`,
    [agent.id, orgId],
  );
  const pending = pendingRows.rows[0];
  const parsedPending = pending ? agentSettingsSchema.safeParse(pending.settings) : null;
  if (pending && pending.source !== "onboarding") {
    return { role: AI_GROWTH_PARTNER_ROLE_KEY, name: workforceRoleName(AI_GROWTH_PARTNER_ROLE_KEY), summary: pending.summary, configStatus: "unchanged", agentStatus: agent.status };
  }

  let settings = growthPartnerSettingsFromOnboarding(data);
  if (agent.active_config_version_id) {
    const current = (await currentSettings(db, agent.id, orgId)).settings;
    const { rows: appliedHistory } = await db.query<{ source: string; settings: unknown }>(
      `select source, settings from agent_config_versions
       where agent_instance_id = $1 and org_id = $2 and applied_at is not null order by version`,
      [agent.id, orgId],
    );
    const { rows: priorRows } = await db.query<{ settings: unknown }>(
      `select settings from agent_config_versions where agent_instance_id = $1 and org_id = $2 and source = 'onboarding'
       and applied_at is not null order by version desc limit 1`,
      [agent.id, orgId],
    );
    const prior = priorRows[0] ? agentSettingsSchema.safeParse(priorRows[0].settings) : null;
    const { rows: pendingManualRows } = await db.query<{ source: string; settings: unknown }>(
      `select source, settings from agent_config_versions where agent_instance_id = $1 and org_id = $2
       and status = 'pending_agency_review' and source <> 'onboarding' order by version desc limit 1`,
      [agent.id, orgId],
    );
    const pendingManual = pendingManualRows[0] ? agentSettingsSchema.safeParse(pendingManualRows[0].settings) : null;
    const base = pendingManual?.success ? pendingManual.data : current;
    const history = pendingManual?.success ? [...appliedHistory, pendingManualRows[0]] : appliedHistory;
    settings = prior?.success
      ? mergeGrowthPartnerBusinessUpdate(base, prior.data, data, manualOverridesFromHistory(history))
      : base;
  } else if (pending && parsedPending?.success) {
    settings = mergeGrowthPartnerBusinessUpdate(parsedPending.data, parsedPending.data, data, new Set());
  }

  if (pending && parsedPending?.success && isDeepStrictEqual(settings, parsedPending.data)) {
    return { role: AI_GROWTH_PARTNER_ROLE_KEY, name: workforceRoleName(AI_GROWTH_PARTNER_ROLE_KEY), summary: pending.summary, configStatus: "unchanged", agentStatus: agent.status };
  }
  if (agent.active_config_version_id) {
    const { rows: activeRows } = await db.query<{ settings: unknown }>(
      `select v.settings from agent_config_versions v where v.id = $1 and v.org_id = $2`,
      [agent.active_config_version_id, orgId],
    );
    const active = activeRows[0];
    const activeSettings = active ? agentSettingsSchema.safeParse(active.settings) : null;
    if (activeSettings?.success && isDeepStrictEqual(settings, activeSettings.data) && !pending) {
      return { role: AI_GROWTH_PARTNER_ROLE_KEY, name: workforceRoleName(AI_GROWTH_PARTNER_ROLE_KEY), summary: summarizeSettings(AI_GROWTH_PARTNER_ROLE_KEY, settings), configStatus: "unchanged", agentStatus: agent.status };
    }
  }

  const config = await createConfigVersion(db, {
    orgId,
    agentId: agent.id,
    settings,
    source: "onboarding",
    changeRequest: agent.active_config_version_id
      ? "Synchronized newly confirmed business preferences; the client's Growth Partner settings were preserved."
      : "Prepared the unified AI Growth Partner from confirmed company setup.",
    actorKind: who.actorKind,
    userId: who.userId,
    apply: true,
  });
  return { role: AI_GROWTH_PARTNER_ROLE_KEY, name: workforceRoleName(AI_GROWTH_PARTNER_ROLE_KEY), summary: config.summary, configStatus: config.status, agentStatus: agent.status };
}
export async function syncEmployeesFromAnswers(
  db: Queryable,
  who: EmployeeActor,
  input: { data: OnboardingData; selected: readonly AgentRoleKey[]; basis?: AnswerBasis },
): Promise<GeneratedEmployee[]> {
  const out: GeneratedEmployee[] = [];
  const { rows: agents } = await db.query<AgentRef>(
    "select id, role_key, status, active_config_version_id, enabled from agent_instances where org_id = $1",
    [who.orgId],
  );
  for (const role of input.selected) {
    const agent = agents.find((a) => a.role_key === role);
    if (!agent) continue;
    out.push(await ensureEmployeeConfigFromAnswers(db, who, { role, agent, data: input.data, basis: input.basis }));
  }

  const growthPartner = agents.find((agent) => agent.role_key === AI_GROWTH_PARTNER_ROLE_KEY);
  if (growthPartner?.enabled && growthPartner.status !== "disabled") {
    const result = await ensureGrowthPartnerConfigFromAnswers(db, who, { agent: growthPartner, data: input.data });
    if (result.configStatus !== "unchanged") out.push(result);
  }
  return out;
}

/**
 * Enabled employees of this workspace that have no applied configuration and nothing waiting for review: what a submission has to build even when no answer changed (an employee
 * added to the plan after the last submission, or one whose earlier build failed).
 */
export async function hasUnconfiguredEnabledEmployee(db: Queryable, orgId: string): Promise<boolean> {
  const { rows } = await db.query(
    `select 1 from agent_instances a
      where a.org_id = $1 and a.enabled and a.active_config_version_id is null
        and not exists (select 1 from agent_config_versions v where v.agent_instance_id = a.id and v.org_id = a.org_id and v.status = 'pending_agency_review')
      limit 1`,
    [orgId],
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Knowledge seeded from answers
// ---------------------------------------------------------------------------

/**
 * Knowledge: writes what onboarding owns; never overwrites text that someone edited in the Knowledge Center. It goes through the same writer as every other knowledge edit, so
 * a flagged seed waits in pending_content while the approved text stays in use, and every seeded version is kept in the section's history.
 */
export async function seedKnowledgeFromAnswers(
  db: Queryable,
  who: Pick<EmployeeActor, "orgId" | "userId">,
  answers: Answers,
  knowledge: { written: string[]; kept: string[] },
): Promise<void> {
  for (const { section, content } of toKnowledgeSections(answers)) {
    const text = sanitizeClientText(content, 12000);
    if (!text) continue;
    const flagged = detectRiskFlags(text).length > 0;
    const { rows } = await db.query<{ content: string; seeded_hash: string | null; pending_content: string | null }>(
      "select content, seeded_hash, pending_content from company_knowledge where org_id = $1 and section = $2",
      [who.orgId, section],
    );
    const current = rows[0];
    if (current && current.content === text && current.pending_content === null) continue;
    if (current && current.seeded_hash !== sha256(current.content)) {
      knowledge.kept.push(section);
      continue;
    }
    if (current?.pending_content != null) {
      // A flagged edit is already waiting. Do not queue the same text again, and do not replace one a person wrote.
      if (flagged && current.pending_content === text) continue;
      const { rows: held } = await db.query<{ source: string }>(
        "select source from company_knowledge_revisions where org_id = $1 and section = $2 and review_status = 'held' order by version desc limit 1",
        [who.orgId, section],
      );
      if (held[0] && held[0].source !== "onboarding") {
        knowledge.kept.push(section);
        continue;
      }
    }
    await writeKnowledgeTextTx(db, { orgId: who.orgId, section, text, userId: who.userId, source: "onboarding", seededHash: sha256(text), emptySeededHash: sha256("") });
    knowledge.written.push(section);
  }
}

// ---------------------------------------------------------------------------
// What the questionnaire has waiting
// ---------------------------------------------------------------------------

/** The questionnaire's row without taking its lock (a reader must not hold up a submission). */
async function readOnboardingRow(db: Queryable, orgId: string): Promise<SnapshotRow> {
  const { rows } = await db.query<{ status: "draft" | "submitted"; submitted_at: Date | null; submitted_snapshot: unknown }>(
    "select status, submitted_at, submitted_snapshot from onboarding_responses where org_id = $1",
    [orgId],
  );
  const r = rows[0];
  return { snapshot: r ? parseProfileSnapshot(r.submitted_snapshot) : null, status: r?.status ?? null, submittedAt: r?.submitted_at ? new Date(r.submitted_at) : null };
}

/** The same rule getOnboardingSession uses for "changes not yet approved": an answer saved after everything that is known to be in the live workspace. */
function answersWaiting(row: SnapshotRow, rows: AnswerRow[]): boolean {
  if (!row.submittedAt) return false;
  const newest = Object.values(answerTimes(rows)).reduce((n, t) => Math.max(n, t), 0);
  return newest > appliedThrough(row);
}

// ---------------------------------------------------------------------------
// Keeping the employees in step with the workspace
// ---------------------------------------------------------------------------

export interface RefreshResult {
  /** New attributed versions that are now applied. */
  updated: AgentRoleKey[];
  /** A new version was made but it is waiting for iAcquire's review: it is NOT what the employee runs. */
  held: AgentRoleKey[];
  unchanged: AgentRoleKey[];
  /** Whether the single partner runtime or its active Business Brain was refreshed. */
  growthPartner: { updated: boolean; held: boolean };
  knowledge: { written: string[]; kept: string[] };
}

const EMPTY_REFRESH = (): RefreshResult => ({ updated: [], held: [], unchanged: [], growthPartner: { updated: false, held: false }, knowledge: { written: [], kept: [] } });

/**
 * Recompiles one employee from its current settings and the workspace's live company context, and makes a new attributed version only when the instructions differ. The settings
 * are passed through untouched, so every field the client changed stays theirs.
 */
async function refreshOneEmployee(db: Queryable, who: EmployeeActor, agent: AgentRef, changeRequest: string, company: Awaited<ReturnType<typeof loadCompanyContext>>): Promise<"updated" | "held" | "unchanged"> {
  if (!agent.active_config_version_id || !isWorkforceRoleKey(agent.role_key)) return "unchanged";
  const { rows } = await db.query<{ version: number; settings: unknown; compiled_instructions: string; default_tools: string[] }>(
    `select v.version, v.settings, v.compiled_instructions, r.default_tools
     from agent_config_versions v join agent_instances a on a.id = v.agent_instance_id join agent_roles r on r.key = a.role_key
     where v.id = $1 and v.org_id = $2`,
    [agent.active_config_version_id, who.orgId],
  );
  const active = rows[0];
  const settings = active ? agentSettingsSchema.safeParse(active.settings) : null;
  if (!active || !settings?.success) return "unchanged";
  const compiled = compileAgentConfig({ role: agent.role_key, settings: settings.data, company, version: Number(active.version), allowedTools: active.default_tools });
  if (compiled.instructions === active.compiled_instructions) return "unchanged";
  const v = await createConfigVersion(db, {
    orgId: who.orgId,
    agentId: agent.id,
    settings: settings.data,
    source: "onboarding",
    changeRequest: changeRequest.slice(0, 1000),
    actorKind: who.actorKind,
    userId: who.userId,
    apply: true,
  });
  return v.status === "applied" ? "updated" : "held";
}

/**
 * A change to the business information made outside the questionnaire (Settings) reaches the employees: each enabled, configured employee is recompiled against the live company
 * context and gets a new version only when its instructions differ. Settings are never touched, so overrides are unaffected. The knowledge sections the answers seed are written
 * again only when the questionnaire has nothing waiting for approval, so an unapproved answer edit is never applied from here. Client workspaces only; an agency or demo workspace
 * changes nothing. Run it as the system, after the edit committed.
 */
export async function refreshEmployeesFromWorkspace(
  db: Queryable,
  ctx: Pick<OrgContext, "org" | "user">,
  opts: { reason: string; keys: readonly ProfileKey[]; profile?: ProfileValues },
): Promise<RefreshResult> {
  const who = actorOf(ctx);
  const result = EMPTY_REFRESH();
  if (!opts.keys.length) return result;
  const org = (await db.query<{ kind: string; is_demo: boolean }>("select kind, is_demo from organizations where id = $1", [who.orgId])).rows[0];
  if (!org || org.kind !== "client" || org.is_demo) return result;

  const change = `${opts.reason.trim().slice(0, 200)}: ${opts.keys.join(", ")}`;
  const company = await loadCompanyContext(db, who.orgId);
  const { rows: agents } = await db.query<AgentRef>(
    `select a.id, a.role_key, a.status, a.active_config_version_id from agent_instances a join agent_roles r on r.key = a.role_key
      where a.org_id = $1 and a.enabled and a.active_config_version_id is not null order by r.sort_order`,
    [who.orgId],
  );
  for (const agent of agents) {
    if (!isWorkforceRoleKey(agent.role_key)) continue;
    const state = await refreshOneEmployee(db, who, agent, change, company);
    if (agent.role_key === AI_GROWTH_PARTNER_ROLE_KEY) {
      if (state === "updated") result.growthPartner.updated = true;
      if (state === "held") result.growthPartner.held = true;
    } else if (isAgentRoleKey(agent.role_key)) {
      result[state].push(agent.role_key);
    }
  }

  const profileValues = opts.profile ?? await (async (): Promise<ProfileValues | null> => {
    const { rows } = await db.query<{
      name: string; industry: string | null; website: string | null; region: string | null; timezone: string;
      description: string | null; services: string | null; ideal_customers: string | null; brand_color: string | null;
    }>(
      `select o.name, o.industry, o.website, o.region, o.timezone,
              p.description, p.services, p.ideal_customers, p.brand_color
       from organizations o left join company_profiles p on p.org_id = o.id where o.id = $1`,
      [who.orgId],
    );
    const row = rows[0];
    return row ? {
      name: row.name,
      industry: row.industry ?? "",
      website: row.website ?? "",
      region: row.region ?? "",
      timezone: row.timezone,
      description: row.description ?? "",
      services: row.services ?? "",
      idealCustomers: row.ideal_customers ?? "",
      brandColor: row.brand_color ?? "",
    } : null;
  })();
  if (profileValues) {
    const brain = await syncGrowthPartnerBusinessBrainFromProfile(db, {
      orgId: who.orgId,
      actorUserId: who.userId,
      actorKind: who.actorKind,
      changed: opts.keys,
      values: profileValues,
    });
    if (brain.status === "updated") result.growthPartner.updated = true;
    if (brain.status === "held") result.growthPartner.held = true;
  }

  const row = await readOnboardingRow(db, who.orgId);
  const rows = await loadAnswerRows(db, who.orgId);
  if (row.status === "submitted" && !answersWaiting(row, rows)) {
    const scope = planScope(await enabledRolesOf(db, who.orgId));
    await seedKnowledgeFromAnswers(db, who, confirmedAnswers(toStored(rows), scope), result.knowledge);
  }
  return result;
}

async function enabledRolesOf(db: Queryable, orgId: string): Promise<AgentRoleKey[]> {
  const { rows } = await db.query<{ role_key: string }>(
    "select a.role_key from agent_instances a join agent_roles r on r.key = a.role_key where a.org_id = $1 and a.enabled order by r.sort_order",
    [orgId],
  );
  return rows.map((a) => a.role_key).filter(isAgentRoleKey);
}

export type EmployeeSyncStatus = "in_sync" | "held" | "behind";

export interface EmployeeSyncRow {
  role: AgentRoleKey;
  state: EmployeeSyncStatus;
  /** Plain words for the person who has to act, or null when the employee is in step. */
  reason: string | null;
}

/**
 * Does each enabled employee run what the workspace says? `in_sync`: yes. `held`: no, and a new version made for exactly that is waiting for iAcquire's review. `behind`: no, and
 * nothing is waiting for it (a version that was rejected or replaced, or a change that no version has picked up). Compared against the approved answers, and against the live
 * company context; while the questionnaire has edits waiting for approval only the company context counts, because those answers are not what the workspace runs on yet. A client
 * that has not submitted yet has nothing to compare. Reads only.
 */
export async function employeeSyncState(db: Queryable, orgId: string): Promise<EmployeeSyncRow[]> {
  const org = (await db.query<{ kind: string; is_demo: boolean; onboarded: boolean }>(
    "select kind, is_demo, onboarding_completed_at is not null as onboarded from organizations where id = $1",
    [orgId],
  )).rows[0];
  if (!org || org.kind !== "client" || org.is_demo || !org.onboarded) return [];

  const questionnaire = await readOnboardingRow(db, orgId);
  const answerRows = await loadAnswerRows(db, orgId);
  const waiting = answersWaiting(questionnaire, answerRows);
  const enabledRoles = await enabledRolesOf(db, orgId);
  const data = toLegacyData(confirmedAnswers(toStored(answerRows), planScope(enabledRoles)), enabledRoles);
  const company = await loadCompanyContext(db, orgId);

  const { rows: agents } = await db.query<AgentRef>(
    `select a.id, a.role_key, a.status, a.active_config_version_id from agent_instances a join agent_roles r on r.key = a.role_key
      where a.org_id = $1 and a.enabled order by r.sort_order`,
    [orgId],
  );
  const out: EmployeeSyncRow[] = [];
  for (const agent of agents) {
    if (!isAgentRoleKey(agent.role_key)) continue;
    const role = agent.role_key;
    const { rows: pending } = await db.query<{ n: number }>(
      "select count(*)::int as n from agent_config_versions where agent_instance_id = $1 and org_id = $2 and source = 'onboarding' and status = 'pending_agency_review'",
      [agent.id, orgId],
    );
    const hasPending = pending[0].n > 0;
    if (!agent.active_config_version_id) {
      out.push(hasPending
        ? { role, state: "held", reason: "Its first configuration is waiting for iAcquire's review." }
        : { role, state: "behind", reason: "It has no configuration yet." });
      continue;
    }
    const { rows: activeRows } = await db.query<{ version: number; settings: unknown; compiled_instructions: string; default_tools: string[] }>(
      `select v.version, v.settings, v.compiled_instructions, r.default_tools from agent_config_versions v
       join agent_instances a on a.id = v.agent_instance_id join agent_roles r on r.key = a.role_key where v.id = $1 and v.org_id = $2`,
      [agent.active_config_version_id, orgId],
    );
    const active = activeRows[0];
    const activeSettings = active ? agentSettingsSchema.safeParse(active.settings) : null;
    if (!active || !activeSettings?.success) {
      out.push({ role, state: "behind", reason: "Its configuration could not be read." });
      continue;
    }
    let target: AgentSettings = activeSettings.data;
    if (!waiting) {
      const { rows: priorRows } = await db.query<{ settings: unknown }>(
        "select settings from agent_config_versions where agent_instance_id = $1 and org_id = $2 and source = 'onboarding' and applied_at is not null order by version desc limit 1",
        [agent.id, orgId],
      );
      const prior = priorRows[0] ? agentSettingsSchema.safeParse(priorRows[0].settings) : null;
      const { rows: history } = await db.query<{ source: string; settings: unknown }>(
        "select source, settings from agent_config_versions where agent_instance_id = $1 and org_id = $2 and applied_at is not null order by version",
        [agent.id, orgId],
      );
      if (prior?.success) target = mergeBusinessUpdate(role, activeSettings.data, prior.data, data, manualOverridesFromHistory(history));
    }
    const settingsDiffer = !isDeepStrictEqual(target, activeSettings.data);
    const instructionsDiffer = compileAgentConfig({ role, settings: target, company, version: Number(active.version), allowedTools: active.default_tools }).instructions !== active.compiled_instructions;
    if (!settingsDiffer && !instructionsDiffer) {
      out.push({ role, state: "in_sync", reason: null });
    } else if (hasPending) {
      out.push({ role, state: "held", reason: "An update to match your business information is waiting for iAcquire's review." });
    } else {
      out.push({ role, state: "behind", reason: settingsDiffer ? "Your approved answers have changed and this employee has not been updated." : "Your business information has changed and this employee has not been updated." });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// A plan change: an employee added to, or removed from, a client's plan
// ---------------------------------------------------------------------------

export interface PlanChangeResult {
  /** False when the call changed nothing at all (the plan already said so, and everything that follows from it is in place). */
  changed: boolean;
  enabled: boolean;
  /** built: a new configuration from the confirmed answers. held: built, waiting for iAcquire's review. existing: it already had one. waiting_for_client: not built until the client approves the answers they changed. not_needed: the client has not finished the questionnaire, so its submission builds it. */
  configuration: "built" | "held" | "existing" | "waiting_for_client" | "not_needed" | "removed";
  /** requested: a provisioning request opened for this employee now. already_open: one was open. waiting_for_payment, not_ready: none is opened (the setup payment, or a configuration, is missing). not_applicable: removed, or it already has a profile. */
  provisioning: "requested" | "already_open" | "waiting_for_payment" | "not_ready" | "not_applicable";
  /** A synchronization job is open for the employee's profile after this call (it is on an older version than the one the client approved). */
  syncQueued: boolean;
  /** Provisioning and synchronization requests this call cancelled. */
  cancelledJobs: number;
  /** Requests the worker has already started: they run to their lease and are not interrupted. */
  runningJobs: number;
}

const OPEN_JOB_SQL = "agent_instance_id = $1 and org_id = $2 and kind = $3 and status in ('requested', 'in_progress', 'awaiting_health_check')";

async function hasOpenJob(db: Queryable, agentId: string, orgId: string, kind: "provision" | "sync"): Promise<boolean> {
  const { rows } = await db.query(`select 1 from agent_provisioning_jobs where ${OPEN_JOB_SQL} limit 1`, [agentId, orgId, kind]);
  return rows.length > 0;
}

/** The person provisioning and the work runner hold accountable for work the system starts: the workspace's owner who can be reached (active, with a verified email). */
async function accountableOwnerOf(db: Queryable, orgId: string): Promise<string | null> {
  const { rows } = await db.query<{ user_id: string }>(
    `select m.user_id from organization_memberships m join users u on u.id = m.user_id
      where m.org_id = $1 and m.role = 'owner' and m.status = 'active' and u.status = 'active' and u.email_verified_at is not null
      order by m.created_at, m.user_id limit 1`,
    [orgId],
  );
  return rows[0]?.user_id ?? null;
}

/** A re-enabled employee whose earlier setup request was cancelled by a plan change gets a new one (requestProvisioning skips an employee that ever had a request). */
async function reopenPlanCancelledProvisioning(db: Queryable, orgId: string, agentId: string, requestedBy: string): Promise<boolean> {
  const { rows } = await db.query(
    `insert into agent_provisioning_jobs (org_id, agent_instance_id, kind, requested_by)
     select a.org_id, a.id, 'provision', $3 from agent_instances a join organizations o on o.id = a.org_id
      where a.id = $2 and a.org_id = $1 and a.enabled and a.hermes_profile is null and a.active_config_version_id is not null
        and o.kind = 'client' and not o.is_demo and o.status = 'active' and o.onboarding_completed_at is not null
        and ${PROVISIONING_PAYMENT_CLEARED_SQL}
        and exists (select 1 from organization_memberships m join users u on u.id = m.user_id
                     where m.org_id = o.id and m.role = 'owner' and m.status = 'active' and u.email_verified_at is not null)
        and exists (select 1 from agent_provisioning_jobs j where j.agent_instance_id = a.id and j.kind = 'provision' and j.status = 'cancelled' and j.detail = $4)
        and not exists (select 1 from agent_provisioning_jobs j where j.agent_instance_id = a.id and j.kind = 'provision' and j.status <> 'cancelled')
     on conflict do nothing
     returning id`,
    [orgId, agentId, requestedBy, PLAN_REMOVED_DETAIL],
  );
  return rows.length > 0;
}

interface PlanAgentRow {
  id: string;
  role_key: string;
  display_name: string;
  enabled: boolean;
  status: string;
  hermes_profile: string | null;
  hermes_profile_config_version_id: string | null;
  active_config_version_id: string | null;
  org_kind: string;
  is_demo: boolean;
  onboarded: boolean;
}

/**
 * Adds an employee to, or removes one from, a CLIENT workspace's plan, and does the work that follows from it. Super Admin only, with a reason. Anything else (a wrong
 * workspace, an agency or demo workspace, an employee mapped from iAcquire's internal tier) is refused before anything is written.
 *
 * Enabling: once the client has finished the questionnaire, an employee with no applied configuration gets one built, deterministically, from the CONFIRMED answers (a first version
 * of source `onboarding`, reviewed for risk like any other), unless the client has changed answers they have not approved yet; then provisioning is requested with the workspace's
 * owner as the accountable person (idempotent, and still waiting for the setup payment). An employee that already has a profile on an older version is brought up to the
 * approved one with one synchronization job. Disabling: requests that were only requested (or failed) are cancelled with a recorded reason; a request the worker has already
 * started runs to its lease. Every outcome is reported as it is: a queued request is not a working employee. Calling it again changes nothing.
 */
export async function applyRolePlanChange(
  db: Queryable,
  input: { orgId: string; agentId: string; enabled: boolean; actor: Pick<SessionUser, "id" | "platformRole">; reason: string },
): Promise<PlanChangeResult> {
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < 5) throw new AppError("invalid_input", "Say why the plan is changing (at least 5 characters).");
  if (reason.length > 500) throw new AppError("invalid_input", "Keep the reason under 500 characters.");
  if (input.actor.platformRole !== "agency_super_admin") throw new AppError("forbidden", "Only super admins can change plan features.");
  const { orgId, agentId, enabled } = input;

  // The questionnaire row first, then the employee: the order a submission takes, so the two cannot wait for each other.
  const questionnaire = await lockOnboardingRow(db, orgId);
  const { rows } = await db.query<PlanAgentRow>(
    `select a.id, a.role_key, a.display_name, a.enabled, a.status, a.hermes_profile, a.hermes_profile_config_version_id, a.active_config_version_id,
            o.kind as org_kind, o.is_demo, o.onboarding_completed_at is not null as onboarded
       from agent_instances a join organizations o on o.id = a.org_id where a.id = $1 and a.org_id = $2 for update of a`,
    [agentId, orgId],
  );
  const agent = rows[0];
  if (!agent || !isAgentRoleKey(agent.role_key)) throw new AppError("not_found", "AI employee not found.");
  if (agent.org_kind !== "client" || agent.is_demo) throw new AppError("conflict", "Plan changes that set an employee up apply to client workspaces only.");
  if (agent.hermes_profile && isReservedProfile(agent.hermes_profile)) throw new AppError("conflict", "This employee is mapped to one of iAcquire's own profiles, so it is not changed from a client's plan.");
  const role = agent.role_key;
  const label = AGENT_BY_KEY[role].shortName;
  const base: PlanChangeResult = { changed: false, enabled, configuration: "existing", provisioning: "not_applicable", syncQueued: false, cancelledJobs: 0, runningJobs: 0 };

  if (!enabled) {
    if (!agent.enabled) return { ...base, configuration: "removed" };
    await db.query("update agent_instances set enabled = false, status = 'disabled' where id = $1 and org_id = $2", [agentId, orgId]);
    const cancelled = await db.query(
      `update agent_provisioning_jobs set status = 'cancelled', detail = $3, lease_token = null, lease_expires_at = null, next_retry_at = null
        where agent_instance_id = $1 and org_id = $2 and kind in ('provision', 'sync') and status in ('requested', 'failed')`,
      [agentId, orgId, PLAN_REMOVED_DETAIL],
    );
    const running = await db.query(
      "select 1 from agent_provisioning_jobs where agent_instance_id = $1 and org_id = $2 and kind in ('provision', 'sync') and status = 'in_progress'",
      [agentId, orgId],
    );
    // The employee's business-tool credential ends with its place in the plan; it is issued again when the employee is added back and its profile is synchronized.
    await revokeClientBusinessCredentialsForAgent(db, orgId, agentId, "plan_role_removed");
    const result: PlanChangeResult = { ...base, changed: true, configuration: "removed", cancelledJobs: cancelled.rowCount ?? 0, runningJobs: running.rows.length };
    await recordAudit({
      orgId, actorUserId: input.actor.id, actorKind: "agency", agentInstanceId: agentId, action: "agent.disabled", targetType: "agent_instance", targetId: agentId, result: "success",
      metadata: { reason, planChange: true, cancelledJobs: result.cancelledJobs, runningJobs: result.runningJobs },
    }, db);
    await notifyOrgRoles(db, orgId, ["owner", "admin"], {
      kind: "agent_status",
      severity: "info",
      title: `${label} is no longer part of your plan`,
      body: "Its setup was stopped and it will not take new work. Your conversations, knowledge and settings are kept, and it can be added back.",
      link: "/employees",
      dedupeKey: `plan-role-removed:${agentId}:${crypto.randomUUID()}`,
    });
    return result;
  }

  let flipped = false;
  if (!agent.enabled) {
    await db.query(
      "update agent_instances set enabled = true, status = case when hermes_profile is null then 'setup_required' else 'provisioning' end where id = $1 and org_id = $2",
      [agentId, orgId],
    );
    flipped = true;
  }
  const result: PlanChangeResult = { ...base, changed: flipped, configuration: "not_needed" };
  const who: EmployeeActor = { orgId, userId: input.actor.id, actorKind: "agency" };
  let activeVersionId = agent.active_config_version_id;

  if (agent.onboarded) {
    const ref: AgentRef = { id: agentId, role_key: role, status: agent.status, active_config_version_id: activeVersionId };
    if (activeVersionId) {
      result.configuration = "existing";
      // An employee that sat out while the business information changed catches up before its profile is judged against the approved version.
      if (flipped) {
        const company = await loadCompanyContext(db, orgId);
        const refreshed = await refreshOneEmployee(db, who, ref, `${reason.slice(0, 200)}: employee added back to the plan`, company);
        if (refreshed !== "unchanged") result.changed = true;
        // A catch-up version that needs review is not the configuration the employee runs: it keeps its approved one, and the person is told the newer one is waiting.
        if (refreshed === "held") result.configuration = "held";
        activeVersionId = (await db.query<{ active_config_version_id: string | null }>("select active_config_version_id from agent_instances where id = $1 and org_id = $2", [agentId, orgId])).rows[0]?.active_config_version_id ?? activeVersionId;
      }
    } else {
      const answerRows = await loadAnswerRows(db, orgId);
      const enabledNow = await enabledRolesOf(db, orgId);
      const confirmed = confirmedAnswers(toStored(answerRows), planScope(enabledNow));
      const { rows: heldRows } = await db.query("select 1 from agent_config_versions where agent_instance_id = $1 and org_id = $2 and status = 'pending_agency_review' limit 1", [agentId, orgId]);
      if (heldRows.length) {
        result.configuration = "held";
      } else if (answersWaiting(questionnaire, answerRows) || typeof confirmed["a.business_name"] !== "string" || !String(confirmed["a.business_name"]).trim()) {
        // Answers the client changed and has not approved are not what the workspace runs on, and with no confirmed answers there is nothing to build from. The client's next
        // submission builds it (a submission no longer treats an unconfigured employee as unchanged).
        result.configuration = "waiting_for_client";
      } else {
        const built = await ensureEmployeeConfigFromAnswers(db, who, {
          role,
          agent: ref,
          data: toLegacyData(confirmed, enabledNow),
          basis: { firstSubmission: false, generated: null },
          changeRequest: "Added to the plan after onboarding; configured from the client's confirmed answers.",
        });
        result.configuration = built.configStatus === "applied" ? "built" : built.configStatus === "unchanged" ? "existing" : "held";
        if (built.configStatus !== "unchanged") result.changed = true;
        activeVersionId = (await db.query<{ active_config_version_id: string | null }>("select active_config_version_id from agent_instances where id = $1 and org_id = $2", [agentId, orgId])).rows[0]?.active_config_version_id ?? null;
      }
    }

    if (!agent.hermes_profile && activeVersionId) {
      const wasOpen = await hasOpenJob(db, agentId, orgId, "provision");
      const owner = await accountableOwnerOf(db, orgId);
      if (owner) {
        await requestProvisioning(db, orgId, owner);
        await reopenPlanCancelledProvisioning(db, orgId, agentId, owner);
      }
      const isOpen = await hasOpenJob(db, agentId, orgId, "provision");
      const paid = (await db.query<{ paid: boolean }>(`select ${PROVISIONING_PAYMENT_CLEARED_SQL} as paid from organizations o where o.id = $1`, [orgId])).rows[0]?.paid === true;
      result.provisioning = wasOpen ? "already_open" : isOpen ? "requested" : paid ? "not_ready" : "waiting_for_payment";
      if (!wasOpen && isOpen) result.changed = true;
    } else if (agent.hermes_profile && agent.hermes_profile_config_version_id && activeVersionId && agent.hermes_profile_config_version_id !== activeVersionId) {
      const queued = await queueSyncJob(db, orgId, agentId, activeVersionId, input.actor.id);
      result.syncQueued = Boolean(queued) || (await hasOpenJob(db, agentId, orgId, "sync"));
      if (queued) result.changed = true;
    }
  }

  if (result.changed) {
    await recordAudit({
      orgId, actorUserId: input.actor.id, actorKind: "agency", agentInstanceId: agentId, action: flipped ? "agent.enabled" : "agent.plan_change_resumed", targetType: "agent_instance", targetId: agentId, result: "success",
      metadata: { reason, planChange: true, configuration: result.configuration, provisioning: result.provisioning, syncQueued: result.syncQueued },
    }, db);
  }
  if (flipped) {
    const heldNote = result.configuration === "held" ? " Its newest configuration is waiting for iAcquire's review; until then it uses the one already approved." : "";
    const next = result.provisioning === "requested" || result.provisioning === "already_open"
      ? `iAcquire is setting it up. It will show as ready once its own checks pass.${heldNote}`
      : result.provisioning === "waiting_for_payment"
        ? `Setup starts as soon as your setup payment is confirmed.${heldNote}`
        : result.configuration === "waiting_for_client"
          ? "It will be set up once you approve the company changes you made."
          : result.configuration === "held"
            ? "Its configuration is waiting for iAcquire's review."
            : "It will show as ready once setup and its own checks pass.";
    await notifyOrgRoles(db, orgId, ["owner", "admin"], {
      kind: "agent_status",
      severity: "info",
      title: `${label} was added to your plan`,
      body: next,
      link: "/setup",
      dedupeKey: `plan-role-added:${agentId}:${crypto.randomUUID()}`,
    });
  }
  return result;
}
