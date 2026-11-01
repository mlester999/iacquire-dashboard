import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { hasDbErrorCode } from "@/server/diagnostics";
import { recordAudit } from "@/server/audit";
import type { OrgContext } from "@/server/tenancy/context";
import { assertCan, memberActor, type CrmActor } from "@/server/crm/actor";
import { updateWorkspaceSettingsIn } from "@/server/crm/workspace";
import { createPipeline, lockDefaultPipeline, retireUntouchedDefaultPipeline, untouchedDefaultPipelineId } from "@/server/crm/pipelines";
import { loadAnswerRows, toStored } from "@/server/onboarding/answers";
import { confirmedAnswers } from "@/lib/onboarding/engine";
import { regionDefaultsForTimezone, type RegionDefaults } from "@/lib/onboarding/region-defaults";
import { PIPELINE_DRAFT_DESCRIPTION, PIPELINE_DRAFT_NAME, planPipelineStages, type PipelineStagePlan } from "@/lib/onboarding/pipeline-draft";

// Two optional refinements of a new client's workspace that come from what the client already told us: the currency and phone country that go with their time zone, and their own
// sales steps as a pipeline. Both are drafts the client confirms. Nothing in this file runs by itself, and nothing is written until a person with the right permission asks for it
// (the launch checklist's buttons, in a later package). They only ever add: a value the client or an agency person set is never replaced, and no existing pipeline or stage is edited
// or deleted. The fact readers say what is on offer; the two apply functions re-read the same facts under the same rules before writing, so a replay or a stale screen changes nothing.

const AUDIT = { region: "onboarding.region_defaults_applied", pipeline: "onboarding.pipeline_stages_applied", pipelineFailed: "onboarding.pipeline_stages_failed" } as const;

/** The workspace's starting values: the database default currency and no calling code. Anything else was set by a person. */
const DEFAULT_CURRENCY = "USD";

/** An active pipeline cap the CRM enforces (insertPipeline); checked first so a refusal is a plain answer and the starting pipeline is never retired for nothing. */
const MAX_ACTIVE_PIPELINES = 25;

const trim = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

// ---------------------------------------------------------------------------
// Currency and phone country
// ---------------------------------------------------------------------------

export type RegionDefaultsFact =
  /** The time zone is missing, shared by several countries or unknown to the table: nothing to suggest. */
  | { state: "no_suggestion" }
  /** The suggestion can be confirmed: the workspace still has the starting values and has no deals, proposals or invoices. */
  | { state: "offer"; timezone: string; defaults: RegionDefaults }
  /** The workspace already uses exactly these values. */
  | { state: "matches"; timezone: string; defaults: RegionDefaults }
  /** Closed for good: a person changed a value ("edited"), or money records already exist in the current currency ("has_records"). */
  | { state: "closed"; reason: "edited" | "has_records"; timezone: string; defaults: RegionDefaults };

/** Whether the workspace has any deal, proposal or invoice (archived or void ones too: their amounts were written in the current currency). */
async function hasMoneyRecords(db: Queryable, orgId: string): Promise<boolean> {
  const { rows } = await db.query<{ found: boolean }>(
    `select (exists (select 1 from crm_opportunities where org_id = $1)
          or exists (select 1 from customer_invoices where org_id = $1)
          or exists (select 1 from proposals where org_id = $1)) as found`,
    [orgId],
  );
  return rows[0]?.found === true;
}

/** What the time zone suggests for this workspace and whether it may still be confirmed. Reads only this workspace's own rows. */
export async function regionDefaultsFact(db: Queryable, orgId: string): Promise<RegionDefaultsFact> {
  const answers = confirmedAnswers(toStored(await loadAnswerRows(db, orgId)));
  const org = (await db.query<{ timezone: string }>("select timezone from organizations where id = $1", [orgId])).rows[0];
  const timezone = trim(answers["a.timezone"]) || trim(org?.timezone);
  const defaults = regionDefaultsForTimezone(timezone);
  if (!defaults) return { state: "no_suggestion" };
  const ws = (await db.query<{ default_currency: string; default_calling_code: string | null }>("select default_currency, default_calling_code from crm_workspaces where org_id = $1", [orgId])).rows[0];
  const currency = ws?.default_currency ?? DEFAULT_CURRENCY;
  const callingCode = ws?.default_calling_code ?? null;
  if (currency === defaults.currency && callingCode === defaults.callingCode) return { state: "matches", timezone, defaults };
  if (currency !== DEFAULT_CURRENCY || callingCode !== null) return { state: "closed", reason: "edited", timezone, defaults };
  if (await hasMoneyRecords(db, orgId)) return { state: "closed", reason: "has_records", timezone, defaults };
  return { state: "offer", timezone, defaults };
}

export type RegionConfirmOutcome =
  | { state: "applied"; defaults: RegionDefaults }
  | { state: "unchanged"; reason: "already_matches" }
  | { state: "refused"; reason: "no_suggestion" | "edited" | "has_records" };

function clientActor(ctx: OrgContext): CrmActor {
  if (ctx.org.kind !== "client") throw new AppError("forbidden", "Workspace setup applies to a client workspace.");
  return memberActor(ctx);
}

/**
 * Applies the currency and phone country that go with the workspace's time zone, because the client confirmed it. Only while the workspace still has its starting values and no deal,
 * proposal or invoice exists (the same rules the fact reader states); otherwise it changes nothing and says why. Goes through the CRM's own settings update, which validates and
 * audits the change, and writes one more audit row that records where the values came from. A second call finds the values in place and does nothing.
 */
export async function confirmRegionDefaults(ctx: OrgContext): Promise<RegionConfirmOutcome> {
  const actor = clientActor(ctx);
  // The same permission the settings update itself asks for, checked first so a person who may not change settings learns nothing about what would have changed.
  if (!actor.can("workspace.manage_profile") && !actor.can("crm.provider.manage")) assertCan(actor, "workspace.manage_profile");
  // Read, decide, write and audit in one transaction under a lock of its own: two presses at the same moment must not both see "offer" and each write and audit it, and a deal
  // created in the gap between the read and the write must not be missed.
  return withSystem(async (db): Promise<RegionConfirmOutcome> => {
    await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`onboarding-region:${ctx.org.orgId}`]);
    const fact = await regionDefaultsFact(db, ctx.org.orgId);
    if (fact.state === "no_suggestion") return { state: "refused", reason: "no_suggestion" };
    if (fact.state === "matches") return { state: "unchanged", reason: "already_matches" };
    if (fact.state === "closed") return { state: "refused", reason: fact.reason };
    await updateWorkspaceSettingsIn(db, actor, { defaultCurrency: fact.defaults.currency, defaultCallingCode: fact.defaults.callingCode });
    await recordAudit({
      orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: AUDIT.region, targetType: "crm_workspace", targetId: ctx.org.orgId, result: "success",
      metadata: { timezone: fact.timezone, currency: fact.defaults.currency, callingCode: fact.defaults.callingCode, country: fact.defaults.country },
    }, db);
    return { state: "applied", defaults: fact.defaults };
  });
}

// ---------------------------------------------------------------------------
// Sales steps as a pipeline
// ---------------------------------------------------------------------------

export type PipelineStagesFact =
  /** The sales-process answer is missing or is not a clean list of steps. */
  | { state: "no_plan" }
  /** Done: this was applied before, or a pipeline with these stages (or this name) already exists. */
  | { state: "applied"; pipelineId: string | null }
  /** The workspace cannot take it: its pipelines live in another system, or it already has the most pipelines allowed. */
  | { state: "blocked"; reason: "not_native" | "too_many_pipelines"; plan: PipelineStagePlan }
  /** Can be applied. `makesDefault`: the new pipeline would become the default, because the workspace has no pipeline or its only pipeline is the untouched starting one. */
  | { state: "offer"; plan: PipelineStagePlan; makesDefault: boolean; replacesStartingPipeline: boolean };

async function alreadyApplied(db: Queryable, orgId: string, plan: PipelineStagePlan): Promise<{ pipelineId: string | null } | null> {
  const pipes = (await db.query<{ id: string; name: string }>("select id, name from crm_pipelines where org_id = $1 and provider = 'native' and archived_at is null", [orgId])).rows;
  const stages = pipes.length
    ? (await db.query<{ pipeline_id: string; name: string }>(
        "select pipeline_id, name from crm_pipeline_stages where org_id = $1 and archived_at is null and pipeline_id = any($2::uuid[]) order by position", [orgId, pipes.map((p) => p.id)],
      )).rows
    : [];
  const wanted = plan.stages.map((s) => s.name.toLowerCase()).join("\n");
  // The name counts as well as the stages: a client who renamed or reshaped the draft still has it, and a second one would only be a duplicate.
  const found = pipes.find((p) => p.name.toLowerCase() === PIPELINE_DRAFT_NAME.toLowerCase() || stages.filter((s) => s.pipeline_id === p.id).map((s) => s.name.toLowerCase()).join("\n") === wanted);
  if (found) return { pipelineId: found.id };
  // Applied once and archived by the client afterwards: their decision, not something to offer again.
  const before = await db.query("select 1 from audit_logs where org_id = $1 and action = $2 limit 1", [orgId, AUDIT.pipeline]);
  return before.rows.length ? { pipelineId: null } : null;
}

/** Whether the sales-process answer can become a pipeline here, and whether the new pipeline would also become the default. Reads only this workspace's own rows. */
export async function pipelineStagesFact(db: Queryable, orgId: string): Promise<PipelineStagesFact> {
  const plan = planPipelineStages(confirmedAnswers(toStored(await loadAnswerRows(db, orgId))));
  if (!plan) return { state: "no_plan" };
  const done = await alreadyApplied(db, orgId, plan);
  if (done) return { state: "applied", pipelineId: done.pipelineId };

  // The same owner rule as the CRM's own write path (assertNativeOwner), read-only here: a workspace whose pipelines live in GoHighLevel is never written to.
  const owner = (await db.query<{ mode: string; provider: string | null }>(
    `select w.mode, p.provider from crm_workspaces w left join crm_capability_providers p on p.org_id = w.org_id and p.capability = 'pipelines' where w.org_id = $1`, [orgId],
  )).rows[0];
  if (owner && (owner.mode === "hybrid" ? (owner.provider ?? "native") : owner.mode) !== "native") return { state: "blocked", reason: "not_native", plan };
  const active = Number((await db.query<{ n: string }>("select count(*)::text as n from crm_pipelines where org_id = $1 and provider = 'native' and archived_at is null", [orgId])).rows[0].n);
  if (active >= MAX_ACTIVE_PIPELINES) return { state: "blocked", reason: "too_many_pipelines", plan };
  const starting = await untouchedDefaultPipelineId(db, orgId);
  return { state: "offer", plan, makesDefault: active === 0 || starting !== null, replacesStartingPipeline: starting !== null };
}

export type PipelineStagesOutcome =
  | { state: "created"; pipelineId: string; stages: number; madeDefault: boolean; retiredStartingPipelineId: string | null }
  | { state: "unchanged"; reason: "already_applied"; pipelineId: string | null }
  | { state: "refused"; reason: "no_plan" | "not_native" | "too_many_pipelines" };

/** Puts back the starting pipeline that was archived to make room for the new default when the new pipeline could not be created. Best effort: the board creates a starting pipeline itself if this fails. */
async function restoreStartingPipeline(orgId: string, pipelineId: string): Promise<void> {
  try {
    await withSystem(async (db) => {
      await lockDefaultPipeline(db, orgId);
      await db.query(
        `update crm_pipelines set archived_at = null,
           is_default = not exists (select 1 from crm_pipelines d where d.org_id = $2 and d.provider = 'native' and d.archived_at is null and d.is_default)
         where id = $1 and org_id = $2 and provider = 'native' and archived_at is not null`,
        [pipelineId, orgId],
      );
    });
  } catch {
    console.warn("[iacquire] the starting pipeline could not be put back after the sales-process pipeline failed; the board creates one on its next visit.");
  }
}

/**
 * Adds the client's sales steps as a new pipeline "Your sales process", because the client asked for it. It goes through the CRM's own createPipeline (permission, workspace owner and
 * name rules, audit) and never edits or deletes an existing pipeline or stage. The new pipeline becomes the default only when the workspace has no pipeline, or its only pipeline is the
 * untouched starting one (no deal, nothing from a Blueprint, form or workflow, no stage edited): that one is archived in the same step. A pipeline anybody has used stays the default.
 * A second call, or one that races the first, finds the pipeline and changes nothing.
 */
export async function applyPipelineStagesFromAnswers(ctx: OrgContext): Promise<PipelineStagesOutcome> {
  const actor = clientActor(ctx);
  assertCan(actor, "pipelines.manage");
  const orgId = ctx.org.orgId;

  // Decide and retire the unused starting pipeline under the lock every default-pipeline change takes. createPipeline opens its own transaction, so it cannot run inside this one.
  const decision = await withSystem(async (db) => {
    await lockDefaultPipeline(db, orgId);
    const fact = await pipelineStagesFact(db, orgId);
    if (fact.state !== "offer") return { fact, retired: null };
    return { fact, retired: fact.replacesStartingPipeline ? await retireUntouchedDefaultPipeline(db, orgId) : null };
  });
  const fact = decision.fact;
  if (fact.state === "no_plan") return { state: "refused", reason: "no_plan" };
  if (fact.state === "blocked") return { state: "refused", reason: fact.reason };
  if (fact.state === "applied") return { state: "unchanged", reason: "already_applied", pipelineId: fact.pipelineId };

  const retired = decision.retired;
  let pipelineId: string;
  try {
    ({ id: pipelineId } = await createPipeline(actor, {
      name: PIPELINE_DRAFT_NAME, description: PIPELINE_DRAFT_DESCRIPTION, stages: fact.plan.stages.map((s) => ({ name: s.name, kind: s.kind })), isDefault: fact.makesDefault,
    }));
  } catch (err) {
    // A second request that ran at the same moment may have created it first (the database allows one active pipeline of a name): then this one is simply a replay.
    const raced = (err instanceof AppError && err.code === "conflict") || hasDbErrorCode(err, "23505");
    const now = raced ? await withSystem((db) => pipelineStagesFact(db, orgId)) : null;
    if (now?.state === "applied") return { state: "unchanged", reason: "already_applied", pipelineId: now.pipelineId };
    if (retired) await restoreStartingPipeline(orgId, retired);
    await recordAudit({
      orgId, actorUserId: ctx.user.id, actorKind: "user", action: AUDIT.pipelineFailed, targetType: "organization", targetId: orgId, result: "failure",
      metadata: { reason: err instanceof AppError ? err.message.slice(0, 200) : "An unexpected error stopped it.", restoredStartingPipeline: Boolean(retired) },
    }).catch(() => undefined);
    throw err;
  }

  const madeDefault = (await withSystem((db) => db.query<{ is_default: boolean }>("select is_default from crm_pipelines where id = $1 and org_id = $2", [pipelineId, orgId]))).rows[0]?.is_default === true;
  await recordAudit({
    orgId, actorUserId: ctx.user.id, actorKind: "user", action: AUDIT.pipeline, targetType: "crm_pipeline", targetId: pipelineId, result: "success",
    metadata: { from: fact.plan.from, stages: fact.plan.stages.length, madeDefault, retiredStartingPipelineId: retired },
  });
  return { state: "created", pipelineId, stages: fact.plan.stages.length, madeDefault, retiredStartingPipelineId: retired };
}
