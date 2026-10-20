import "server-only";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { notifyOrgRoles } from "@/server/notifications";
import type { CrmEventRow } from "@/server/crm/events";
import { contactMatches } from "@/server/crm/workflows/conditions";
import { LIVE_RUN_STATUSES, isPremiumVersion, isRetryable, iso, notifyWorkflowProblem, trimJson, versionAuthorized, type RunContextData, type StartedVia } from "@/server/crm/workflows/engine";
import { studioEntitlement } from "@/server/automation-studio/entitlement";
import { addStudioUsage, admitStudioRun } from "@/server/automation-studio/usage";
import { FilterError, countConditions } from "@/lib/crm/filters";
import { isEventTrigger, type TriggerConfig, type WorkflowStep } from "@/lib/crm/workflow/spec";

/**
 * Starting runs. Every start goes through createRun: one run per workflow and triggering event (the database refuses a second, also when a
 * newer version was published between two deliveries of the event), the
 * workflow's hourly limit (a run over the limit is recorded as not started, so it shows in the log), the re-entry rule, and the run's
 * starting point (the first step, visit 1). Nothing here gates on pauses: pauses are checked when each step runs.
 */

export interface ActiveVersion {
  workflow_id: string;
  workflow_name: string;
  hourly_run_limit: number;
  version_id: string;
  trigger_config: TriggerConfig;
  steps: WorkflowStep[];
  effects: string[];
  premium_features: string[];
  content_hash: string;
  approved_hash: string | null;
  approval_id: string | null;
  approval_status: string | null;
  approval_expires_at: Date | null;
  published_at: Date;
  approved_at: Date | null;
}

const ACTIVE_VERSIONS = `
  select w.id as workflow_id, w.name as workflow_name, w.hourly_run_limit, v.id as version_id, v.trigger_config, v.steps, v.effects, v.premium_features, v.content_hash,
         v.approved_hash, v.approval_id, a.status as approval_status, a.expires_at as approval_expires_at, v.published_at, v.approved_at
  from crm_workflows w
  join crm_workflow_versions v on v.id = w.published_version_id and v.org_id = w.org_id
  left join approval_requests a on a.id = v.approval_id and a.org_id = v.org_id
  where w.org_id = $1 and w.status = 'active' and v.trigger_config->>'type' = $2
  order by w.created_at, w.id`;

export async function activeVersionsFor(db: Queryable, orgId: string, triggerType: string): Promise<ActiveVersion[]> {
  return (await db.query<ActiveVersion>(ACTIVE_VERSIONS, [orgId, triggerType])).rows;
}

const authorized = (v: ActiveVersion, now: Date) =>
  versionAuthorized(v, v.approval_status ? { status: v.approval_status, expires_at: v.approval_expires_at } : null, now);

export interface CreateRunInput {
  orgId: string;
  workflowId: string;
  workflowName: string;
  hourlyRunLimit: number;
  versionId: string;
  steps: WorkflowStep[];
  startedVia: StartedVia;
  triggerEventId?: number | null;
  contactId?: string | null;
  opportunityId?: string | null;
  depth?: number;
  context?: RunContextData;
  reentry?: TriggerConfig["reentry"];
  /** The version belongs to the Automation Studio plan: the workspace's plan and limits are checked, and the run is metered. */
  premium?: boolean;
  now: Date;
}

export type CreateRunResult = { status: "created"; runId: string } | { status: "duplicate" | "limited" | "skipped"; runId: string | null; reason: string };

/** Creates a run (queued at the first step). Serializes with other starts of the same workflow so the hourly limit is exact. */
export async function createRun(db: Queryable, input: CreateRunInput): Promise<CreateRunResult> {
  const entry = input.steps[0]?.key;
  if (!entry) return { status: "skipped", runId: null, reason: "The workflow has no steps." };
  await db.query("select 1 from crm_workflows where id = $1 and org_id = $2 for update", [input.workflowId, input.orgId]);
  if (input.triggerEventId) {
    // Per workflow, not per version: an event delivered again after a new version was published doesn't start the workflow twice.
    const dup = await db.query<{ id: string }>("select id from crm_workflow_runs where workflow_id = $1 and trigger_event_id = $2", [input.workflowId, input.triggerEventId]);
    if (dup.rows[0]) return { status: "duplicate", runId: dup.rows[0].id, reason: "This event already started this workflow." };
  }
  if (input.contactId && input.reentry && input.reentry !== "always" && input.startedVia !== "test") {
    const statuses = input.reentry === "once" ? null : LIVE_RUN_STATUSES;
    const { rows } = await db.query(
      `select 1 from crm_workflow_runs where org_id = $1 and workflow_id = $2 and contact_id = $3 and started_via <> 'test'
         and coalesce(context->>'outcome', '') not in ('rate_limited', 'quota_exceeded') and ($4::text[] is null or status = any($4::text[])) limit 1`,
      [input.orgId, input.workflowId, input.contactId, statuses],
    );
    if (rows[0]) return { status: "skipped", runId: null, reason: input.reentry === "once" ? "This contact already went through this workflow." : "This contact is already in this workflow." };
  }
  const base: RunContextData = { ...(input.context ?? {}), visit: { key: entry, n: 1 }, visits: { [entry]: 1 }, executed: 0 };
  /** A run that wasn't started, recorded as cancelled with why, so it shows in the log (and a redelivered event doesn't try again). */
  const recordRefused = async (outcome: "rate_limited" | "quota_exceeded", reason: string) =>
    (await db.query<{ id: string }>(
      `insert into crm_workflow_runs (org_id, workflow_id, version_id, trigger_event_id, started_via, contact_id, opportunity_id, status, current_step, depth, context, last_error, finished_at, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, 'cancelled', null, $8, $9, $10, $11, $11)
       on conflict (workflow_id, trigger_event_id) where trigger_event_id is not null do nothing returning id`,
      [input.orgId, input.workflowId, input.versionId, input.triggerEventId ?? null, input.startedVia, input.contactId ?? null, input.opportunityId ?? null, Math.min(20, input.depth ?? 0),
        JSON.stringify({ ...base, outcome }), reason, input.now.toISOString()],
    )).rows[0]?.id ?? null;
  if (input.premium && input.startedVia !== "test") {
    // Automation Studio workflows run only while the workspace has the plan, and within its fair-use limits. Workflows from the CRM screens never get here.
    const ent = await studioEntitlement(db, input.orgId, input.now);
    if (!ent.entitled) {
      await addStudioUsage(db, input.orgId, "runs_refused", 1, { at: input.now });
      return { status: "skipped", runId: null, reason: `Not started: ${ent.reason}` };
    }
    const admission = await admitStudioRun(db, input.orgId, input.now);
    if (!admission.allowed) {
      await addStudioUsage(db, input.orgId, "runs_refused", 1, { at: input.now });
      return { status: "limited", runId: await recordRefused("quota_exceeded", admission.detail), reason: admission.detail };
    }
  }
  if (input.startedVia !== "test") {
    const { rows } = await db.query<{ n: string }>(
      `select count(*)::text as n from crm_workflow_runs where workflow_id = $1 and org_id = $2 and created_at > $3::timestamptz - interval '1 hour'
         and started_via <> 'test' and coalesce(context->>'outcome', '') not in ('rate_limited', 'quota_exceeded')`,
      [input.workflowId, input.orgId, input.now.toISOString()],
    );
    if (Number(rows[0].n) >= input.hourlyRunLimit) {
      const reason = `Not started: this workflow reached its limit of ${input.hourlyRunLimit} runs an hour.`;
      const limitedId = await recordRefused("rate_limited", reason);
      if (limitedId) {
        await notifyWorkflowProblem(db, { orgId: input.orgId, workflowId: input.workflowId, workflowName: input.workflowName, runId: limitedId, title: `Workflow "${input.workflowName}" reached its hourly limit`, body: `${reason} Check what is starting it so often, or raise the limit in the workflow's settings.`, now: input.now });
      }
      return { status: "limited", runId: limitedId, reason };
    }
  }
  const created = await db.query<{ id: string }>(
    `insert into crm_workflow_runs (org_id, workflow_id, version_id, trigger_event_id, started_via, contact_id, opportunity_id, status, current_step, next_run_at, depth, context, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, 'queued', $8, $9, $10, $11, $9)
     on conflict (workflow_id, trigger_event_id) where trigger_event_id is not null do nothing returning id`,
    [input.orgId, input.workflowId, input.versionId, input.triggerEventId ?? null, input.startedVia, input.contactId ?? null, input.opportunityId ?? null, entry, input.now.toISOString(),
      Math.min(20, input.depth ?? 0), JSON.stringify(base)],
  );
  if (!created.rows[0]) return { status: "duplicate", runId: null, reason: "This event already started this workflow." };
  if (input.premium && input.startedVia !== "test") await addStudioUsage(db, input.orgId, "runs_started", 1, { at: input.now });
  return { status: "created", runId: created.rows[0].id };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const str = (v: unknown) => (typeof v === "string" ? v : null);

/** The records an event carries, for the run: contact, deal, appointment, task, conversation. */
async function eventRecords(db: Queryable, e: CrmEventRow): Promise<{ contactId: string | null; opportunityId: string | null; appointmentId: string | null; taskId: string | null; conversationId: string | null }> {
  const out = { contactId: e.contactId, opportunityId: null as string | null, appointmentId: null as string | null, taskId: null as string | null, conversationId: null as string | null };
  if (e.entityType === "opportunity") {
    out.opportunityId = e.entityId;
    if (!out.contactId && e.entityId) out.contactId = (await db.query<{ contact_id: string | null }>("select contact_id from crm_opportunities where id = $1 and org_id = $2", [e.entityId, e.orgId])).rows[0]?.contact_id ?? null;
  } else if (e.entityType === "appointment") out.appointmentId = e.entityId;
  else if (e.entityType === "task" && e.entityId) {
    out.taskId = e.entityId;
    const t = (await db.query<{ contact_id: string | null; opportunity_id: string | null }>("select contact_id, opportunity_id from tasks where id = $1 and org_id = $2", [e.entityId, e.orgId])).rows[0];
    out.contactId = out.contactId ?? t?.contact_id ?? null;
    out.opportunityId = t?.opportunity_id ?? null;
  } else if (e.entityType === "conversation") out.conversationId = e.entityId;
  // A form submission's deal (when the form creates one), so deal steps can act on it.
  else if (e.entityType === "form") out.opportunityId = str(e.payload?.opportunityId);
  // A review request asked about a deal or an appointment: the run gets them too (the contact rides on the event itself).
  else if (e.entityType === "review_request") {
    out.opportunityId = str(e.payload?.opportunityId);
    out.appointmentId = str(e.payload?.appointmentId);
  }
  return out;
}

/** Whether an event passes a trigger's filters. Lookups read the record as it is now, which is when the run starts. */
export async function triggerMatches(db: Queryable, e: CrmEventRow, t: TriggerConfig, records: { contactId: string | null; opportunityId: string | null; appointmentId: string | null; taskId: string | null }, timezone: string): Promise<boolean> {
  const f = t.filters ?? {};
  const p = e.payload ?? {};
  if (f.tagIds?.length && !f.tagIds.includes(str(p.tagId) ?? "")) return false;
  if (f.formIds?.length && !f.formIds.includes((e.entityType === "form" ? e.entityId : null) ?? str(p.formId) ?? "")) return false;
  if (f.createdVia?.length && !(f.createdVia as string[]).includes(str(p.via) ?? "")) return false;
  // Records brought across by the GoHighLevel migration never start a workflow unless the trigger names that source itself. The import
  // already marks its events dispatched (quietMigratedEvents, the same two payload keys); this is the second layer, for any other path that
  // ever emits them.
  if ((str(p.via) === "ghl_migration" || str(p.source) === "ghl_migration") && !(f.createdVia as string[] | undefined)?.includes("ghl_migration")) return false;
  if (f.changedFields?.length) {
    const changed = Array.isArray(p.changed) ? p.changed.map(String) : [];
    if (!f.changedFields.some((k) => changed.includes(k))) return false;
  }
  if (f.channels?.length && !(f.channels as string[]).includes(str(p.channel) ?? "")) return false;
  if (f.callStatuses?.length && !(f.callStatuses as string[]).includes(str(p.status) ?? "")) return false;
  if (f.callDirections?.length && !(f.callDirections as string[]).includes(str(p.direction) ?? "")) return false;
  if (f.consentPurpose && str(p.purpose) !== f.consentPurpose) return false;
  if (f.consentStatus && str(p.status) !== f.consentStatus) return false;
  if (e.type === "conversation.message_received" && f.ignoreOptOutKeywords !== false && (p.keyword === "stop" || p.keyword === "start")) return false;
  if (f.assigneeIds?.length) {
    let assignee = e.type === "contact.assigned" ? str(p.to) : str(p.assigneeId);
    if (!assignee && records.taskId) assignee = (await db.query<{ a: string | null }>("select assigned_user_id as a from tasks where id = $1 and org_id = $2", [records.taskId, e.orgId])).rows[0]?.a ?? null;
    if (!assignee || !f.assigneeIds.includes(assignee)) return false;
  }
  if (f.pipelineId || f.stageIds?.length || f.fromStageIds?.length) {
    let pipelineId = str(p.pipelineId);
    let stageId = e.type === "opportunity.stage_changed" ? str(p.toStageId) : str(p.stageId);
    if ((!pipelineId || !stageId) && records.opportunityId) {
      const o = (await db.query<{ pipeline_ref: string | null; stage_ref: string | null }>("select pipeline_ref, stage_ref from crm_opportunities where id = $1 and org_id = $2", [records.opportunityId, e.orgId])).rows[0];
      pipelineId ??= o?.pipeline_ref ?? null;
      stageId ??= o?.stage_ref ?? null;
    }
    if (f.pipelineId && pipelineId !== f.pipelineId) return false;
    if (f.stageIds?.length && !f.stageIds.includes(stageId ?? "")) return false;
    if (f.fromStageIds?.length && !f.fromStageIds.includes(str(p.fromStageId) ?? "")) return false;
  }
  if (f.calendarIds?.length || f.appointmentTypeIds?.length) {
    let calendarId = str(p.calendarId);
    let typeId = str(p.appointmentTypeId);
    if ((!calendarId || !typeId) && records.appointmentId) {
      const a = (await db.query<{ calendar_ref: string | null; appointment_type_id: string | null }>("select calendar_ref, appointment_type_id from appointment_refs where id = $1 and org_id = $2", [records.appointmentId, e.orgId])).rows[0];
      calendarId ??= a?.calendar_ref ?? null;
      typeId ??= a?.appointment_type_id ?? null;
    }
    if (f.calendarIds?.length && !f.calendarIds.includes(calendarId ?? "")) return false;
    if (f.appointmentTypeIds?.length && !f.appointmentTypeIds.includes(typeId ?? "")) return false;
  }
  if (t.contactFilter && countConditions(t.contactFilter)) {
    if (!records.contactId) return false;
    if (!(await contactMatches(db, e.orgId, timezone, records.contactId, t.contactFilter))) return false;
  }
  return true;
}

export interface StartForEventResult {
  created: number;
  limited: number;
  skipped: number;
}

/**
 * Dispatcher subscriber: starts every active workflow whose trigger matches this event, in the event's own transaction. A workflow
 * version that would message customers or call outside systems without a standing owner approval is not started (it can't be active
 * that way; this is a second check). Workspaces whose automations belong to GoHighLevel start nothing natively.
 */
export async function startRunsForEvent(db: Queryable, e: CrmEventRow, now = new Date()): Promise<StartForEventResult> {
  const out: StartForEventResult = { created: 0, limited: 0, skipped: 0 };
  if (!isEventTrigger(e.type)) return out;
  const versions = await activeVersionsFor(db, e.orgId, e.type);
  if (!versions.length) return out;
  const ws = await db.query<{ mode: string; provider: string | null }>(
    "select w.mode, p.provider from crm_workspaces w left join crm_capability_providers p on p.org_id = w.org_id and p.capability = 'workflows' where w.org_id = $1",
    [e.orgId],
  );
  const owner = ws.rows[0] ? (ws.rows[0].mode === "hybrid" ? (ws.rows[0].provider ?? "native") : ws.rows[0].mode) : "native";
  if (owner !== "native") return out;
  const org = (await db.query<{ timezone: string }>("select timezone from organizations where id = $1", [e.orgId])).rows[0];
  const records = await eventRecords(db, e);
  if (records.contactId) {
    // Archived or deleted contacts leave automations.
    const c = await db.query("select 1 from contacts where id = $1 and org_id = $2 and deleted_at is null and archived_at is null", [records.contactId, e.orgId]);
    if (!c.rows[0]) return out;
  }
  for (const v of versions) {
    if (!authorized(v, now)) {
      out.skipped += 1;
      continue;
    }
    const t = v.trigger_config;
    // Each workflow on its own savepoint: one whose trigger filter stopped working (a custom field or choice it checks was removed) is
    // skipped and its owners told, without holding back the other workflows or the event.
    await db.query("savepoint crm_workflow_start");
    let r: CreateRunResult | null = null;
    try {
      if (await triggerMatches(db, e, t, records, org?.timezone ?? "UTC")) {
        r = await createRun(db, {
          orgId: e.orgId, workflowId: v.workflow_id, workflowName: v.workflow_name, hourlyRunLimit: v.hourly_run_limit, versionId: v.version_id, steps: v.steps, startedVia: "event",
          triggerEventId: e.id, contactId: records.contactId, opportunityId: records.opportunityId, depth: e.depth, reentry: t.reentry, premium: isPremiumVersion(v), now,
          context: {
            trigger: { type: e.type, eventId: e.id, payload: trimJson(e.payload, 4000) },
            appointmentId: records.appointmentId, taskId: records.taskId, conversationId: records.conversationId ?? str(e.payload?.conversationId),
          },
        });
      }
      await db.query("release savepoint crm_workflow_start");
    } catch (err) {
      await db.query("rollback to savepoint crm_workflow_start");
      await db.query("release savepoint crm_workflow_start");
      // A passing problem (a lock timeout, a lost connection) retries the whole event, which is safe: run creation is idempotent.
      if (!brokenTrigger(err)) throw err;
      out.skipped += 1;
      await notifyBrokenTrigger(db, e.orgId, v, err);
      continue;
    }
    if (!r) continue;
    if (r.status === "created") out.created += 1;
    else if (r.status === "limited") out.limited += 1;
    else if (r.status === "skipped") out.skipped += 1;
  }
  return out;
}

/** An error that trying the same event again can't fix: the filter no longer compiles, or the query it builds fails on the data. */
function brokenTrigger(err: unknown): boolean {
  if (err instanceof FilterError) return true;
  if (err instanceof AppError) return !isRetryable(err);
  const code = (err as { code?: unknown })?.code;
  return typeof code === "string" && /^(22|42)/.test(code);
}

/** Owners and managers hear once per version that its trigger filter stopped working (the version can't start until it is fixed). */
async function notifyBrokenTrigger(db: Queryable, orgId: string, v: ActiveVersion, err: unknown) {
  const why = err instanceof FilterError || err instanceof AppError ? ` (${err.message.replace(/\.$/, "")})` : "";
  await notifyOrgRoles(db, orgId, ["owner", "admin"], {
    kind: "crm_workflow_failed",
    severity: "warning",
    title: `Workflow "${v.workflow_name}" can't check its trigger`.slice(0, 200),
    body: `It didn't start because its trigger filter no longer works${why}. Edit the filter and publish the workflow again. Other workflows aren't affected.`.slice(0, 900),
    link: `/crm/workflows/${v.workflow_id}`,
    dedupeKey: `crm-wf-trigger-broken:${v.version_id}`,
  });
}

export { authorized as activeVersionAuthorized, iso };
