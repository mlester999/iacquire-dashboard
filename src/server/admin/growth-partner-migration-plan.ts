import "server-only";
import { randomUUID } from "node:crypto";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { canonicalJson } from "@/lib/invoices/hash";
import { validateBusinessHours, type BusinessHours } from "@/lib/messaging";
import { capabilityDefinition } from "@/lib/workforce-capabilities";
import { validateWorkforceScheduleRule, type WorkforceScheduleRule } from "@/lib/workforce-schedule-recurrence";
import { activateGrowthPartnerBusinessBrainVersionInTransaction } from "@/server/ai-growth-partner/service";
import { recordAudit } from "@/server/audit";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { sha256 } from "@/server/security/crypto";
import type { OrgContext } from "@/server/tenancy/context";

const ITEM_LIMIT = 100;
const STAGE_ACTOR_ERROR = "Only a Super Admin with workforce management access to this workspace can prepare a plan.";
const OWNER_ERROR = "An active workspace owner is required to review a migration plan.";
const STALE_ERROR = "The workspace changed after this plan was prepared. Refresh the migration preview.";

interface SourceSnapshot {
  id: string;
  source_type: "employee_note" | "reference_document";
  source_record_id: string;
  source_version: string;
  source_role_key: AgentRoleKey | null;
  status: "approved" | "pending_review" | "rejected";
}

interface ScheduleSnapshot {
  id: string;
  legacy_role: AgentRoleKey;
  capability: string;
  cadence: string;
  interval_minutes: number;
  timezone: string;
  enabled: boolean;
  next_run_at: string;
  due: boolean;
  recurrence_rule: unknown;
  business_hours: unknown;
  settings_digest: string;
}

interface TenantSnapshot {
  org_id: string;
  kind: string;
  status: string;
  is_demo: boolean;
  partner_id: string | null;
  partner_status: string | null;
  runtime_agent_instance_id: string | null;
  current_version: number | null;
  brain: { id: string; version: number; source: string } | null;
  legacy: Array<{ id: string; role_key: AgentRoleKey; enabled: boolean; active_config_version_id: string | null; binding_digest: string }>;
  schedules: ScheduleSnapshot[];
  sources: SourceSnapshot[];
  company_knowledge: Array<{ id: string; section: string; version: number; pending_review: boolean }>;
  recorded_conversation: boolean;
  existing_runtime: boolean;
  config_reviews: number;
  open_work: number;
  open_approvals: number;
  permission_digest: string;
}

export interface MigrationPlanManifest {
  retainedProfiles: Array<{ role: AgentRoleKey; enabled: boolean; hasAppliedConfiguration: boolean }>;
  businessBrain: { id: string; version: number; source: string; active: boolean };
  companyKnowledge: Array<{ section: string; version: number }>;
  reviewedSources: Array<{ id: string; type: SourceSnapshot["source_type"]; previousRole: AgentRoleKey | null }>;
  schedules: Array<{
    id: string;
    legacyRole: AgentRoleKey;
    capabilityLabel: string;
    targetCapability: string | null;
    disposition: "propose_disabled_replacement" | "retain_legacy" | "keep_paused";
    timezone: string;
    cadence: string;
    intervalMinutes: number;
    recurrence: WorkforceScheduleRule | null;
    nextRunAt: string;
  }>;
}

export type MigrationPlanStatus = "pending_review" | "approved" | "declined" | "withdrawn" | "superseded";
export interface MigrationPlan {
  id: string;
  digest: string;
  status: MigrationPlanStatus;
  manifest: MigrationPlanManifest;
  stagedAt: string;
  ownerDecisionAt: string | null;
}
export type MigrationPlanPreview =
  | { status: "blocked"; blockers: string[] }
  | { status: "ready"; digest: string; manifest: MigrationPlanManifest };

interface PlanRow {
  id: string;
  partner_id: string;
  plan_digest: string;
  status: MigrationPlanStatus;
  manifest: MigrationPlanManifest;
  staged_at: Date;
  owner_decided_at: Date | null;
  owner_decided_by: string | null;
  owner_decision_digest: string | null;
}
const PLAN_COLUMNS = "id, partner_id, plan_digest, status, manifest, staged_at, owner_decided_at, owner_decided_by, owner_decision_digest";

interface ReplacementSchedule {
  candidateScheduleId: string;
  legacyScheduleId: string;
  capability: string;
  cadence: string;
  intervalMinutes: number;
  timezone: string;
  recurrence: WorkforceScheduleRule | null;
  businessHours: BusinessHours;
  nextRunAt: string;
  enabled: false;
}

interface PreparationRow {
  candidate_runtime_id: string;
  brain_version: number;
  previous_brain_version: number | null;
  replacement_schedules: ReplacementSchedule[];
  prepared_at: Date;
  withdrawn_at: Date | null;
}

const PREPARATION_COLUMNS = "candidate_runtime_id, brain_version, previous_brain_version, replacement_schedules, prepared_at, withdrawn_at";

async function assertStageActor(db: Queryable, orgId: string, userId: string) {
  const { rows } = await db.query(
    `select 1 from users where id = $2 and status = 'active' and platform_role = 'agency_super_admin'
       and app.user_can_access_org($2, $1) and app.user_has_agency_permission($2, 'agency.workforce.manage') for share`,
    [orgId, userId],
  );
  if (!rows.length) throw new AppError("forbidden", STAGE_ACTOR_ERROR);
}

async function assertReviewActor(db: Queryable, ctx: OrgContext) {
  if (ctx.role !== "owner" || !ctx.can("approvals.decide_high") || ctx.org.kind !== "client") throw new AppError("forbidden", OWNER_ERROR);
  const { rows } = await db.query(
    `select 1 from organization_memberships m join users u on u.id = m.user_id and u.status = 'active'
      where m.org_id = $1 and m.user_id = $2 and m.role = 'owner' and m.status = 'active' for share of m, u`,
    [ctx.org.orgId, ctx.user.id],
  );
  if (!rows.length) throw new AppError("forbidden", OWNER_ERROR);
}

async function readSnapshot(db: Queryable, orgId: string): Promise<TenantSnapshot> {
  // A single database snapshot covers all evidence. SQL fingerprints private binding and schedule values
  // in place. Neither the stored plan nor the response carries credentials, prompts, or customer content.
  const { rows } = await db.query<TenantSnapshot>(
    `select o.id as org_id, o.kind, o.status, o.is_demo, p.id as partner_id, p.status as partner_status,
            p.runtime_agent_instance_id, p.current_version,
            (select jsonb_build_object('id', v.id, 'version', v.version, 'source', v.source)
               from ai_growth_partner_versions v where v.org_id = o.id and v.partner_id = p.id
               order by v.version desc limit 1) as brain,
            coalesce((select jsonb_agg(to_jsonb(a) order by a.role_key) from (
              select a.id, a.role_key, a.enabled, a.active_config_version_id,
                     encode(sha256(convert_to(jsonb_build_array(a.hermes_profile, a.hermes_base_url, a.hermes_gateway_id,
                       a.credential_id, c.revoked_at, a.mode)::text, 'UTF8')), 'hex') as binding_digest
                from agent_instances a left join integration_credentials c on c.id = a.credential_id and c.org_id = a.org_id
               where a.org_id = o.id and a.role_key = any($2::text[])
            ) a), '[]'::jsonb) as legacy,
            coalesce((select jsonb_agg(to_jsonb(s) order by s.id) from (
              select s.id, a.role_key as legacy_role, s.capability, s.enabled, s.cadence, s.interval_minutes, s.timezone,
                     s.next_run_at::text as next_run_at, (s.enabled and s.next_run_at <= now()) as due, s.recurrence_rule, s.business_hours,
                     encode(sha256(convert_to(jsonb_build_array(s.payload, s.business_hours, s.last_run_at, s.last_job_id)::text, 'UTF8')), 'hex') as settings_digest
                from ai_work_schedules s join agent_instances a on a.id = s.agent_instance_id and a.org_id = s.org_id
               where s.org_id = o.id and a.role_key = any($2::text[]) order by s.id limit $3
            ) s), '[]'::jsonb) as schedules,
            coalesce((select jsonb_agg(to_jsonb(k) order by k.id) from (
              select id, source_type, source_record_id, source_version, source_role_key, status
                from ai_growth_partner_legacy_knowledge where org_id = o.id and partner_id = p.id
                order by id limit $3
            ) k), '[]'::jsonb) as sources,
            coalesce((select jsonb_agg(to_jsonb(k) order by k.id) from (
              select id, section, version, (review_status <> 'approved' or pending_content is not null) as pending_review
                from company_knowledge where org_id = o.id order by id limit $3
            ) k), '[]'::jsonb) as company_knowledge,
            exists (select 1 from chat_conversations c where c.org_id = o.id and c.growth_partner_id = p.id and c.deleted_at is null) as recorded_conversation,
            exists (select 1 from agent_instances a where a.org_id = o.id and a.role_key = 'growth_partner') as existing_runtime,
            (select count(*)::int from agent_config_versions v join agent_instances a on a.id = v.agent_instance_id and a.org_id = v.org_id
              where v.org_id = o.id and a.role_key = any($2::text[]) and v.status in ('pending_approval', 'pending_agency_review')) as config_reviews,
            (select count(*)::int from ai_work_jobs j join agent_instances a on a.id = j.agent_instance_id and a.org_id = j.org_id
              where j.org_id = o.id and a.role_key = any($2::text[]) and j.status in ('queued', 'running', 'waiting_for_approval', 'blocked')) as open_work,
            (select count(*)::int from approval_requests r where r.org_id = o.id
              and ((r.status = 'pending' and (r.expires_at is null or r.expires_at > now())) or r.status = 'changes_requested'
                or r.execution_status in ('queued', 'running', 'blocked'))) as open_approvals,
            encode(sha256(convert_to(jsonb_build_array(
              (select jsonb_agg(jsonb_build_array(f.feature, f.enabled) order by f.feature) from org_features f where f.org_id = o.id),
              (select jsonb_agg(jsonb_build_array(m.user_id, m.permission, m.effect) order by m.user_id, m.permission)
                 from member_permission_overrides m where m.org_id = o.id)
            )::text, 'UTF8')), 'hex') as permission_digest
       from organizations o left join ai_growth_partners p on p.org_id = o.id where o.id = $1`,
    [orgId, AGENT_ROLE_KEYS, ITEM_LIMIT + 1],
  );
  if (!rows[0]) throw new AppError("not_found", "Client workspace not found.");
  return rows[0];
}

function validTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function preview(snapshot: TenantSnapshot): MigrationPlanPreview {
  const blockers: string[] = [];
  if (snapshot.kind !== "client" || snapshot.status !== "active" || snapshot.is_demo) blockers.push("Choose an active client workspace.");
  if (new Set(snapshot.legacy.map((profile) => profile.role_key)).size !== AGENT_ROLE_KEYS.length || snapshot.legacy.length !== AGENT_ROLE_KEYS.length) {
    blockers.push("Reconcile the six retained profiles.");
  }
  if (!snapshot.partner_id || snapshot.partner_status !== "migration_required" || snapshot.runtime_agent_instance_id
    || snapshot.recorded_conversation || snapshot.existing_runtime) {
    blockers.push("Prepare an unbound migration identity and resolve conflicting runtime or conversation records.");
  }
  if (!snapshot.brain) blockers.push("Save a Business Brain version for owner review before staging the plan.");
  if ([snapshot.schedules, snapshot.sources, snapshot.company_knowledge].some((rows) => rows.length > ITEM_LIMIT)) {
    blockers.push("The migration record exceeds the supported review size. Review this workspace separately.");
  }
  if (snapshot.config_reviews || snapshot.sources.some((source) => source.status === "pending_review")
    || snapshot.company_knowledge.some((source) => source.pending_review)) {
    blockers.push("Resolve retained configuration and knowledge reviews.");
  }
  if (snapshot.open_work || snapshot.open_approvals) blockers.push("Resolve open work and outstanding approvals before staging a migration plan.");

  const enabledTargets = new Set<string>();
  const schedules = snapshot.schedules.map((row): MigrationPlanManifest["schedules"][number] => {
    const definition = capabilityDefinition(row.capability);
    const supported = Boolean(definition?.allowedRoles.includes("growth_partner") && definition.workBoardAction && definition.risk === "read_only");
    const rule = validateWorkforceScheduleRule(row.recurrence_rule);
    const nextRun = new Date(row.next_run_at);
    if (!Number.isFinite(nextRun.getTime())) blockers.push("Review an invalid next occurrence on a saved schedule.");
    if (row.enabled && row.recurrence_rule !== null && !rule) blockers.push("Review the invalid recurrence on an enabled schedule.");
    if (row.enabled && supported) {
      if (!validTimeZone(row.timezone)) blockers.push("Review the invalid time zone on an enabled schedule.");
      if (row.due) blockers.push("Resolve an enabled schedule that is already due before proposing a replacement.");
      if (enabledTargets.has(row.capability)) blockers.push("More than one enabled schedule maps to the same Growth Partner capability.");
      enabledTargets.add(row.capability);
    }
    return {
      id: row.id,
      legacyRole: row.legacy_role,
      capabilityLabel: definition?.label ?? "Unrecognized capability",
      targetCapability: row.enabled && supported ? row.capability : null,
      disposition: !row.enabled ? "keep_paused" : supported ? "propose_disabled_replacement" : "retain_legacy",
      timezone: row.timezone,
      cadence: rule?.kind ?? row.cadence,
      intervalMinutes: row.interval_minutes,
      recurrence: rule,
      nextRunAt: Number.isFinite(nextRun.getTime()) ? nextRun.toISOString() : row.next_run_at,
    };
  });
  if (blockers.length || !snapshot.brain) return { status: "blocked", blockers: [...new Set(blockers)] };
  const manifest: MigrationPlanManifest = {
    retainedProfiles: snapshot.legacy.map((profile) => ({
      role: profile.role_key, enabled: profile.enabled, hasAppliedConfiguration: Boolean(profile.active_config_version_id),
    })),
    businessBrain: { ...snapshot.brain, active: snapshot.brain.version === snapshot.current_version },
    companyKnowledge: snapshot.company_knowledge.map((source) => ({ section: source.section, version: source.version })),
    reviewedSources: snapshot.sources.filter((source) => source.status === "approved").map((source) => ({
      id: source.id, type: source.source_type, previousRole: source.source_role_key,
    })),
    schedules,
  };
  // The v1 plan digest already fingerprints business hours in settings_digest.
  const reviewedSnapshot = {
    ...snapshot,
    schedules: snapshot.schedules.map(({ business_hours: _hours, ...schedule }) => schedule),
  };
  return { status: "ready", digest: sha256(canonicalJson({ v: 1, snapshot: reviewedSnapshot, manifest })), manifest };
}

function planView(row: PlanRow): MigrationPlan {
  return {
    id: row.id, digest: row.plan_digest, status: row.status, manifest: row.manifest,
    stagedAt: new Date(row.staged_at).toISOString(),
    ownerDecisionAt: row.owner_decided_at ? new Date(row.owner_decided_at).toISOString() : null,
  };
}

async function latestPlan(db: Queryable, orgId: string): Promise<PlanRow | null> {
  const { rows } = await db.query<PlanRow>(
    `select ${PLAN_COLUMNS} from ai_growth_partner_migration_plans where org_id = $1 and status <> 'superseded'
      order by (status in ('pending_review', 'approved')) desc, staged_at desc, id desc limit 1`,
    [orgId],
  );
  return rows[0] ?? null;
}

async function lockTenant(db: Queryable, orgId: string) {
  const { rows } = await db.query("select id from organizations where id = $1 for no key update", [orgId]);
  if (!rows.length) throw new AppError("not_found", "Client workspace not found.");
}

async function findPlan(db: Queryable, orgId: string, planId: string) {
  const { rows } = await db.query<PlanRow>(
    `select ${PLAN_COLUMNS} from ai_growth_partner_migration_plans where org_id = $1 and id = $2`,
    [orgId, planId],
  );
  if (!rows[0]) throw new AppError("not_found", "Migration plan not found.");
  return rows[0];
}

async function findPreparation(db: Queryable, orgId: string, planId: string): Promise<PreparationRow | null> {
  const { rows } = await db.query<PreparationRow>(
    `select ${PREPARATION_COLUMNS} from ai_growth_partner_migration_preparations where org_id = $1 and plan_id = $2`,
    [orgId, planId],
  );
  return rows[0] ?? null;
}

function currentPlanEvidence(snapshot: TenantSnapshot, plan: PlanRow, preparation: PreparationRow | null) {
  if (snapshot.partner_id !== plan.partner_id) return false;
  // Preparation itself changes the Brain pointer. Compare the other evidence to its reviewed state.
  if (preparation) {
    if (preparation.withdrawn_at || snapshot.current_version !== preparation.brain_version) return false;
    snapshot = { ...snapshot, current_version: preparation.previous_brain_version };
  }
  const proposal = preview(snapshot);
  return proposal.status === "ready" && proposal.digest === plan.plan_digest
    && canonicalJson(proposal.manifest) === canonicalJson(plan.manifest);
}

function materializeReplacementSchedules(snapshot: TenantSnapshot, plan: PlanRow): ReplacementSchedule[] {
  const proposed = plan.manifest.schedules.filter((schedule) => schedule.disposition === "propose_disabled_replacement");
  const hours = new Map(snapshot.schedules.map((schedule) => [schedule.id, validateBusinessHours(schedule.business_hours)]));
  return proposed.map((schedule) => {
    const businessHours = hours.get(schedule.id);
    if (!businessHours || !schedule.targetCapability) throw new AppError("conflict", "Review the saved schedule and its business hours before preparing a replacement.");
    return {
      candidateScheduleId: randomUUID(),
      legacyScheduleId: schedule.id,
      capability: schedule.targetCapability,
      cadence: schedule.cadence,
      intervalMinutes: schedule.intervalMinutes,
      timezone: schedule.timezone,
      recurrence: schedule.recurrence,
      businessHours,
      nextRunAt: schedule.nextRunAt,
      enabled: false,
    };
  });
}

function preparationView(row: PreparationRow) {
  return {
    candidateRuntimeId: row.candidate_runtime_id,
    brainVersion: row.brain_version,
    replacementScheduleCount: row.replacement_schedules.length,
    preparedAt: new Date(row.prepared_at).toISOString(),
    withdrawnAt: row.withdrawn_at ? new Date(row.withdrawn_at).toISOString() : null,
  };
}

/** Applies an exact owner-approved preparation under Super Admin workspace scope. */
export async function prepareApprovedMigrationPlan(orgId: string, actorUserId: string, input: { planId: string; digest: string }) {
  return withSystem(async (db) => {
    await assertStageActor(db, orgId, actorUserId);
    await lockTenant(db, orgId);
    const plan = await findPlan(db, orgId, input.planId);
    if (plan.status !== "approved" || !plan.owner_decided_by || plan.owner_decision_digest !== input.digest
      || plan.plan_digest !== input.digest) {
      throw new AppError("conflict", "Only the current, owner-approved migration plan can be prepared.");
    }
    const owner = (await db.query(
      `select 1 from organization_memberships m join users u on u.id = m.user_id
        where m.org_id = $1 and m.user_id = $2 and m.role = 'owner' and m.status = 'active' and u.status = 'active'
        for share of m, u`,
      [orgId, plan.owner_decided_by],
    )).rows[0];
    if (!owner) throw new AppError("conflict", "The original approver is no longer an active workspace owner. Obtain a new review.");

    await db.query("select id from ai_growth_partners where org_id = $1 and id = $2 for update", [orgId, plan.partner_id]);
    const preparation = await findPreparation(db, orgId, plan.id);
    const snapshot = await readSnapshot(db, orgId);
    if (!currentPlanEvidence(snapshot, plan, preparation)) throw new AppError("conflict", STALE_ERROR);
    if (preparation) return preparationView(preparation);

    const replacementSchedules = materializeReplacementSchedules(snapshot, plan);
    await activateGrowthPartnerBusinessBrainVersionInTransaction(db, orgId, plan.owner_decided_by, {
      expectedCurrentVersion: snapshot.current_version,
      expectedVersionId: plan.manifest.businessBrain.id,
      version: plan.manifest.businessBrain.version,
    });
    const created = (await db.query<PreparationRow>(
      `insert into ai_growth_partner_migration_preparations
         (org_id, plan_id, partner_id, brain_version, previous_brain_version, replacement_schedules, prepared_by)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7) returning ${PREPARATION_COLUMNS}`,
      [orgId, plan.id, plan.partner_id, plan.manifest.businessBrain.version, snapshot.current_version, JSON.stringify(replacementSchedules), actorUserId],
    )).rows[0];
    await recordAudit({
      orgId, actorUserId, actorKind: "agency", action: "ai_growth_partner.migration_plan_prepared",
      targetType: "migration_plan", targetId: plan.id, result: "success",
      metadata: { planDigest: plan.plan_digest, ...preparationView(created) },
    }, db);
    return preparationView(created);
  });
}

async function withdrawPreparation(db: Queryable, orgId: string, plan: PlanRow, actorUserId: string) {
  const preparation = await findPreparation(db, orgId, plan.id);
  if (!preparation || preparation.withdrawn_at) return;
  // Restore only the pointer installed by this preparation, and only while still unbound.
  const restored = preparation.previous_brain_version !== preparation.brain_version && (await db.query(
    `update ai_growth_partners set current_version = $4
      where org_id = $1 and id = $2 and current_version = $3 and status = 'migration_required'
        and runtime_agent_instance_id is null`,
    [orgId, plan.partner_id, preparation.brain_version, preparation.previous_brain_version],
  )).rowCount > 0;
  await db.query(
    "update ai_growth_partner_migration_preparations set withdrawn_at = now() where org_id = $1 and plan_id = $2",
    [orgId, plan.id],
  );
  await recordAudit({
    orgId, actorUserId, actorKind: "user", action: "ai_growth_partner.migration_preparation_withdrawn",
    targetType: "migration_plan", targetId: plan.id, result: "success",
    metadata: { planDigest: plan.plan_digest, previousBrainRestored: restored },
  }, db);
}

function planInspection(snapshot: TenantSnapshot, plan: PlanRow, preparation: PreparationRow | null) {
  const reviewable = plan.status === "pending_review" || plan.status === "approved";
  return {
    ...planView(plan),
    currentEvidence: reviewable && currentPlanEvidence(snapshot, plan, preparation),
    preparation: preparation ? preparationView(preparation) : null,
  };
}

export type MigrationPlanInspection = ReturnType<typeof planInspection>;

export async function previewMigrationPlan(orgId: string, userId: string) {
  return withSystem(async (db) => {
    await assertStageActor(db, orgId, userId);
    const snapshot = await readSnapshot(db, orgId);
    const current = await latestPlan(db, orgId);
    const preparation = current ? await findPreparation(db, orgId, current.id) : null;
    return { proposal: preview(snapshot), current: current ? planInspection(snapshot, current, preparation) : null };
  });
}

export async function stageMigrationPlan(orgId: string, userId: string, expectedDigest: string): Promise<MigrationPlan> {
  return withSystem(async (db) => {
    await assertStageActor(db, orgId, userId);
    await lockTenant(db, orgId);
    const snapshot = await readSnapshot(db, orgId);
    const proposal = preview(snapshot);
    if (proposal.status !== "ready" || proposal.digest !== expectedDigest) throw new AppError("conflict", STALE_ERROR);

    const current = await latestPlan(db, orgId);
    const active = current && (current.status === "pending_review" || current.status === "approved") ? current : null;
    if (active?.plan_digest === proposal.digest) return planView(active);
    if (active && await findPreparation(db, orgId, active.id)) {
      throw new AppError("conflict", "The owner must withdraw the previous preparation before replacing the plan.");
    }

    const id = randomUUID();
    if (active) {
      await db.query(
        "update ai_growth_partner_migration_plans set status = 'superseded', closed_at = now(), superseded_by = $3 where org_id = $1 and id = $2",
        [orgId, active.id, id],
      );
      await recordAudit({
        orgId, actorUserId: userId, actorKind: "agency", action: "ai_growth_partner.migration_plan_superseded",
        targetType: "migration_plan", targetId: active.id, result: "success", metadata: { planDigest: active.plan_digest, replacedBy: id },
      }, db);
    }
    const created = (await db.query<PlanRow>(
      `insert into ai_growth_partner_migration_plans (id, org_id, partner_id, manifest, plan_digest, staged_by)
       values ($1, $2, $3, $4::jsonb, $5, $6) returning ${PLAN_COLUMNS}`,
      [id, orgId, snapshot.partner_id, JSON.stringify(proposal.manifest), proposal.digest, userId],
    )).rows[0];
    await recordAudit({
      orgId, actorUserId: userId, actorKind: "agency", action: "ai_growth_partner.migration_plan_staged",
      targetType: "migration_plan", targetId: id, result: "success", metadata: { planDigest: proposal.digest },
    }, db);
    return planView(created);
  });
}

export async function readOwnerMigrationPlan(ctx: OrgContext) {
  return withSystem(async (db) => {
    await assertReviewActor(db, ctx);
    const current = await latestPlan(db, ctx.org.orgId);
    if (!current) return null;
    const preparation = await findPreparation(db, ctx.org.orgId, current.id);
    return planInspection(await readSnapshot(db, ctx.org.orgId), current, preparation);
  });
}

export async function decideMigrationPlan(
  ctx: OrgContext, input: { planId: string; digest: string; decision: "approved" | "declined" | "withdrawn" },
): Promise<MigrationPlan> {
  return withSystem(async (db) => {
    const orgId = ctx.org.orgId;
    await assertReviewActor(db, ctx);
    await lockTenant(db, orgId);
    const plan = await findPlan(db, orgId, input.planId);
    if (plan.plan_digest !== input.digest) throw new AppError("conflict", STALE_ERROR);
    const replay = plan.status === input.decision;
    const withdraw = input.decision === "withdrawn";
    if (!replay && plan.status !== (withdraw ? "approved" : "pending_review")) {
      throw new AppError("conflict", "This migration plan is no longer open for that decision.");
    }
    if (input.decision === "approved") {
      const preparation = await findPreparation(db, orgId, plan.id);
      if (!currentPlanEvidence(await readSnapshot(db, orgId), plan, preparation)) throw new AppError("conflict", STALE_ERROR);
    }
    if (replay) return planView(plan);
    if (withdraw) await withdrawPreparation(db, orgId, plan, ctx.user.id);
    const updated = (await db.query<PlanRow>(
      `update ai_growth_partner_migration_plans set status = $3,
                owner_decision = case when $3 = 'withdrawn' then owner_decision else $3 end,
                owner_decided_by = case when $3 = 'withdrawn' then owner_decided_by else $4 end,
                owner_decided_at = case when $3 = 'withdrawn' then owner_decided_at else now() end,
                owner_decision_digest = case when $3 = 'withdrawn' then owner_decision_digest else plan_digest end,
                closed_at = case when $3 = 'approved' then null else now() end
        where org_id = $1 and id = $2 returning ${PLAN_COLUMNS}`,
      [orgId, input.planId, input.decision, ctx.user.id],
    )).rows[0];
    await recordAudit({
      orgId, actorUserId: ctx.user.id, actorKind: "user", action: `ai_growth_partner.migration_plan_${input.decision}`,
      targetType: "migration_plan", targetId: plan.id, result: "success", metadata: { planDigest: plan.plan_digest },
    }, db);
    return planView(updated);
  });
}
