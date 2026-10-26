import "server-only";
import { requestReassessment } from "@/server/lead-scoring/queue";
import { applyOverrideInTx } from "@/server/lead-scoring/priority";
import { ACTIVE_STATES } from "@/lib/missed-calls/state";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { notifyOrgRoles, notifyUser } from "@/server/notifications";
import type { CrmActor } from "@/server/crm/actor";
import { emitEvent, recordActivity } from "@/server/crm/events";
import { applyContactTags, removeContactTags } from "@/server/crm/tags";
import { createTaskInTx } from "@/server/crm/tasks";
import { assertAssignable } from "@/server/crm/contacts";
import { createOpportunityInTx, moveOpportunityInTx } from "@/server/crm/opportunities";
import { writeFieldValues } from "@/server/crm/fields";
import { assertNativeOwner } from "@/server/crm/workspace";
import { loadApprovedTemplate, tokenValuesFor } from "@/server/crm/message-templates";
import { queueOutreach } from "@/server/messaging/outreach";
import { hasReviewLinkToken, queueReviewRequestInTx, reviewRequestProblem } from "@/server/crm/reviews";
import { contactAddress, getConsent, isSuppressed } from "@/server/messaging/contacts";
import { typedByVisitorAddress } from "@/server/messaging/consent-identity";
import { assignWithRule } from "@/server/crm/assignment";
import { applyConversationAction } from "@/server/messaging/workflow-actions";
import { inboxEnabledFor } from "@/server/messaging/inbox-rollout";
import { enqueueWorkflowWebhook } from "@/server/crm/webhooks";
import { agentLiveRunsVerified, requestAgentTask } from "@/server/crm/agent-tools/tasks";
import { contactMatches, opportunityMatches, repliedSince } from "@/server/crm/workflows/conditions";
import { StepFailure, trimJson, type RunContextData } from "@/server/crm/workflows/engine";
import { addDuration, nextTimeOfDay } from "@/lib/crm/workflow/time";
import { zonedToInstant } from "@/lib/calendars/slots";
import {
  STEP_KINDS, UPDATABLE_FIELDS, durationMinutes,
  type AiTaskConfig, type AssignConfig, type BranchConfig, type ConversationActionConfig, type CreateOpportunityConfig, type CreateTaskConfig, type InternalNoteConfig, type MoveStageConfig,
  type HttpRequestConfig, type SlackMessageConfig, type N8nConfig, type NotifyTeamConfig, type SetPriorityConfig, type RequestReviewConfig, type SendMessageConfig, type TagsConfig, type UpdateFieldConfig, type WaitConfig, type WebhookConfig, type WorkflowStep,
} from "@/lib/crm/workflow/spec";
import { describeMissing, renderMessage, renderTemplate } from "@/lib/messaging/tokens";
import { normalizeContentType } from "@/lib/automation-studio/outbound";
import { slackText, type OutboundCall } from "@/server/automation-studio/outbound";
import { LEAD_STATUS_LABELS, type LeadStatus } from "@/lib/crm/types";
import { RUNTIME_ONLINE_STATUSES } from "@/lib/employee-runtime";

/**
 * One executor per step kind. Each runs inside the step's own transaction (the runner opens it), calls the existing CRM services with
 * the workflow's system actor and causedBy, and returns what happened. In a dry run (a test run) the same checks are made with reads only
 * and the result says what the step would do: nothing is written and nothing leaves iAcquire.
 */

export interface StepContext {
  db: Queryable;
  org: { id: string; name: string; timezone: string };
  workflow: { id: string; name: string };
  version: { id: string; version: number; approvalId: string | null; authorized: boolean };
  run: { id: string; startedVia: string; contactId: string | null; opportunityId: string | null; createdAt: Date; context: RunContextData; triggerEventId: number | null; depth: number };
  actor: CrmActor;
  causedBy: { eventId: number; depth: number } | null;
  /** The effect key of this step visit (a message's dedupe key, a webhook's idempotency key). */
  effectKey: string;
  visit: number;
  now: Date;
  dryRun: boolean;
}

export type StepOutcome =
  | { type: "done"; status: "completed" | "skipped"; result: Record<string, unknown>; next?: string | null; messageId?: string | null; opportunityId?: string | null }
  | { type: "wait"; until: Date; result: Record<string, unknown> }
  | { type: "end"; result: Record<string, unknown> }
  | { type: "external"; call: ExternalCall; result: Record<string, unknown> };

/** An outside call a step asks the runner to make once its claim is recorded: n8n, or a connection (HTTP or Slack). */
export type ExternalCall =
  | { kind: "n8n"; input: { orgId: string; mappingId: string; payload: Record<string, unknown>; idempotencyKey: string } }
  | { kind: "connection"; input: OutboundCall };

const done = (result: Record<string, unknown>, extra: Partial<Extract<StepOutcome, { type: "done" }>> = {}): StepOutcome => ({ type: "done", status: "completed", result, ...extra });
const skipped = (detail: string, extra: Record<string, unknown> = {}): StepOutcome => ({ type: "done", status: "skipped", result: { outcome: "skipped", detail, ...extra } });
const blocked = (reason: string, detail: string, extra: Record<string, unknown> = {}): StepOutcome => ({ type: "done", status: "skipped", result: { outcome: "blocked", reason, detail, ...extra } });
/** What a dry run reports. Nothing ran, so the step row is "skipped" with the outcome it would have had. */
const would = (detail: string, extra: Record<string, unknown> = {}): StepOutcome => ({ type: "done", status: "skipped", result: { dryRun: true, outcome: "would_run", detail, ...extra } });
const wouldSkip = (detail: string, extra: Record<string, unknown> = {}): StepOutcome => ({ type: "done", status: "skipped", result: { dryRun: true, outcome: "would_skip", detail, ...extra } });
/** The employee statuses the automation gate counts as having passed the connection check. */
const AGENT_READY: ReadonlySet<string> = new Set(RUNTIME_ONLINE_STATUSES);

interface ContactRow {
  id: string;
  display_name: string;
  assigned_user_id: string | null;
  email: string | null;
  phone: string | null;
  lead_status: string;
  lead_score: number | null;
  preferred_channel: string | null;
  source: string | null;
  version: number;
}

async function loadContact(db: Queryable, orgId: string, id: string | null, lock = false): Promise<ContactRow | null> {
  if (!id) return null;
  const { rows } = await db.query<ContactRow>(
    `select id, display_name, assigned_user_id, email::text as email, phone, lead_status, lead_score, preferred_channel, source, version
     from contacts where id = $1 and org_id = $2 and deleted_at is null and archived_at is null${lock ? " for update" : ""}`,
    [id, orgId],
  );
  return rows[0] ?? null;
}

interface DealRow {
  id: string;
  name: string;
  contact_id: string | null;
  assigned_user_id: string | null;
  pipeline_ref: string;
  stage_ref: string;
  status: string;
  monetary_value: string | null;
  probability: number | null;
  source: string | null;
  version: number;
  expected_close_date: string | null;
}

async function loadDeal(db: Queryable, orgId: string, id: string | null, lock = false): Promise<DealRow | null> {
  if (!id) return null;
  const { rows } = await db.query<DealRow>(
    `select id, name, contact_id, assigned_user_id, pipeline_ref, stage_ref, status, monetary_value::text, probability, source, version, expected_close_date::text
     from crm_opportunities where id = $1 and org_id = $2 and provider = 'native' and archived_at is null${lock ? " for update" : ""}`,
    [id, orgId],
  );
  return rows[0] ?? null;
}

const NO_CONTACT = "This run has no contact (or the contact was archived), so the step was skipped.";
const NO_DEAL = "This run has no deal to work on, so the step was skipped.";
const NO_CONVERSATION = "This run has no conversation to update, so the step was skipped.";
const NOT_ON_NEW_INBOX = "The new inbox isn't switched on for this workspace, so the conversation was left as it is.";

/** Fills placeholders from the run's contact, leaving out anything that has no value (titles and notes, not customer messages). */
async function renderLoose(sc: StepContext, text: string): Promise<string> {
  if (!text.includes("{{")) return text.trim();
  const values = await tokenValuesFor(sc.db, sc.org.id, { contactId: sc.run.contactId, timezone: sc.org.timezone, now: sc.now });
  return renderTemplate(text, values.values).text.replace(/\s+([,.!?])/g, "$1").replace(/[ \t]{2,}/g, " ").trim();
}

async function namesOf(db: Queryable, orgId: string, table: "crm_tags" | "users", ids: readonly string[]): Promise<string[]> {
  if (!ids.length) return [];
  const sql = table === "crm_tags"
    ? "select name::text as n from crm_tags where org_id = $1 and id = any($2::uuid[]) order by lower(name::text)"
    : "select coalesce(nullif(u.full_name, ''), u.email::text) as n from users u join organization_memberships m on m.user_id = u.id and m.org_id = $1 where u.id = any($2::uuid[])";
  return (await db.query<{ n: string }>(sql, [orgId, ids])).rows.map((r) => r.n);
}

const list = (names: string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/** Steps that send customer messages, call outside systems or ask an AI employee run only under the version's owner approval. */
function assertAuthorized(sc: StepContext) {
  if (!sc.version.authorized) throw new StepFailure("This version can send messages or call outside systems, and an owner hasn't approved it. Request approval, then retry.");
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

/** The date a wait counts from, or null when it is missing. Date-only values are taken as 9:00 in the workspace's time zone. */
async function waitBase(sc: StepContext, c: Extract<WaitConfig, { mode: "until_date" }>): Promise<{ at: Date | null; note?: string }> {
  const nine = (day: string) => new Date(zonedToInstant(day, 9 * 60, sc.org.timezone));
  const { db } = sc;
  const orgId = sc.org.id;
  if (c.source === "appointment_start") {
    const id = sc.run.context.appointmentId;
    if (!id) return { at: null };
    const { rows } = await db.query<{ start_at: Date }>("select start_at from appointment_refs where id = $1 and org_id = $2 and status not in ('cancelled', 'invalid')", [id, orgId]);
    return { at: rows[0] ? new Date(rows[0].start_at) : null };
  }
  if (c.source === "opportunity_close_date") {
    const deal = await loadDeal(db, orgId, sc.run.opportunityId);
    return deal?.expected_close_date ? { at: nine(deal.expected_close_date), note: "The expected close date has no time, so 9:00 in your time zone is used." } : { at: null };
  }
  const entityId = c.source === "contact_field" ? sc.run.contactId : sc.run.opportunityId;
  if (!entityId || !c.fieldId) return { at: null };
  const { rows } = await db.query<{ value_date: string | null; value_ts: Date | null }>(
    "select value_date::text as value_date, value_ts from crm_field_values where org_id = $1 and field_id = $2 and entity_id = $3",
    [orgId, c.fieldId, entityId],
  );
  const v = rows[0];
  if (v?.value_ts) return { at: new Date(v.value_ts) };
  if (v?.value_date) return { at: nine(v.value_date), note: "The field holds a date without a time, so 9:00 in your time zone is used." };
  return { at: null };
}

async function execWait(sc: StepContext, c: WaitConfig): Promise<StepOutcome> {
  let until: Date;
  let note: string | undefined;
  if (c.mode === "duration") until = addDuration(sc.now, c);
  else if (c.mode === "until_time") until = nextTimeOfDay(sc.now, c.time, sc.org.timezone, c.weekdays);
  else {
    const base = await waitBase(sc, c);
    if (!base.at) {
      const detail = c.ifMissing === "end" ? "The date this wait counts from is missing, so the workflow ends here." : "The date this wait counts from is missing, so it carried on straight away.";
      if (sc.dryRun) return c.ifMissing === "end" ? { type: "end", result: { dryRun: true, outcome: "would_end", detail } } : would(detail);
      return c.ifMissing === "end" ? { type: "end", result: { outcome: "date_missing", detail } } : done({ outcome: "date_missing", detail });
    }
    until = addDuration(base.at, c.offset, c.offset.direction);
    note = base.note;
  }
  if (until.getTime() <= sc.now.getTime()) {
    const detail = "That time has already passed, so it carried on straight away.";
    return sc.dryRun ? would(detail, { until: until.toISOString() }) : done({ outcome: "already_passed", until: until.toISOString(), detail });
  }
  if (sc.dryRun) return would(`Would wait until ${until.toISOString()}.`, { until: until.toISOString(), note });
  return { type: "wait", until, result: { until: until.toISOString(), ...(note ? { note } : {}) } };
}

async function execBranch(sc: StepContext, step: WorkflowStep, c: BranchConfig): Promise<StepOutcome> {
  let matched: boolean;
  let detail: string;
  if (c.subject === "contact") {
    const contact = await loadContact(sc.db, sc.org.id, sc.run.contactId);
    if (!contact) {
      matched = false;
      detail = "There is no contact to check, so it took the No path.";
    } else {
      matched = await contactMatches(sc.db, sc.org.id, sc.org.timezone, contact.id, c.filter);
      if (matched && c.reply) {
        const replied = await repliedSince(sc.db, sc.org.id, contact.id, sc.run.createdAt);
        matched = c.reply === "replied" ? replied : !replied;
      }
      detail = matched ? "The contact matches, so it took the Yes path." : "The contact doesn't match, so it took the No path.";
    }
  } else {
    const deal = await loadDeal(sc.db, sc.org.id, sc.run.opportunityId);
    if (!deal) {
      matched = false;
      detail = "There is no deal to check, so it took the No path.";
    } else {
      matched = await opportunityMatches(sc.db, sc.org.id, sc.org.timezone, deal.id, c.filter);
      detail = matched ? "The deal matches, so it took the Yes path." : "The deal doesn't match, so it took the No path.";
    }
  }
  const next = (matched ? step.branches?.yes : step.branches?.no) ?? null;
  return { type: "done", status: "completed", result: { matched, path: matched ? "yes" : "no", detail, ...(sc.dryRun ? { dryRun: true, outcome: matched ? "branch_yes" : "branch_no" } : {}) }, next };
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

async function execTags(sc: StepContext, c: TagsConfig, add: boolean): Promise<StepOutcome> {
  const contact = await loadContact(sc.db, sc.org.id, sc.run.contactId);
  if (!contact) return sc.dryRun ? wouldSkip(NO_CONTACT) : skipped(NO_CONTACT);
  const names = await namesOf(sc.db, sc.org.id, "crm_tags", c.tagIds);
  if (names.length !== new Set(c.tagIds).size) throw new StepFailure("A tag this step uses no longer exists. Edit the workflow and choose the tags again.");
  if (sc.dryRun) {
    const { rows } = await sc.db.query<{ n: string }>("select count(*)::text as n from crm_contact_tags where org_id = $1 and contact_id = $2 and tag_id = any($3::uuid[])", [sc.org.id, contact.id, c.tagIds]);
    const has = Number(rows[0].n);
    if (add && has === c.tagIds.length) return wouldSkip(`${contact.display_name} already has ${list(names)}.`);
    if (!add && has === 0) return wouldSkip(`${contact.display_name} doesn't have ${list(names)}.`);
    return would(`Would ${add ? "add" : "remove"} ${list(names)} ${add ? "to" : "from"} ${contact.display_name}.`);
  }
  await assertNativeOwner(sc.db, sc.org.id, "tags");
  const changed = add
    ? await applyContactTags(sc.db, sc.actor, [contact.id], c.tagIds, "workflow", sc.causedBy)
    : await removeContactTags(sc.db, sc.actor, [contact.id], c.tagIds, sc.causedBy);
  if (!changed) return skipped(add ? `${contact.display_name} already had ${list(names)}.` : `${contact.display_name} didn't have ${list(names)}.`, { changed: 0 });
  return done({ changed, tags: names });
}

async function execAssign(sc: StepContext, c: AssignConfig): Promise<StepOutcome> {
  const { db } = sc;
  const orgId = sc.org.id;
  const entityId = c.subject === "contact" ? sc.run.contactId : sc.run.opportunityId;
  const record = c.subject === "contact" ? await loadContact(db, orgId, entityId, !sc.dryRun) : await loadDeal(db, orgId, entityId, !sc.dryRun);
  if (!record) return sc.dryRun ? wouldSkip(c.subject === "contact" ? NO_CONTACT : NO_DEAL) : skipped(c.subject === "contact" ? NO_CONTACT : NO_DEAL);
  const label = "display_name" in record ? record.display_name : record.name;
  if (c.onlyIfUnassigned && record.assigned_user_id) {
    const detail = `${label} already has an owner, so it was left as it is.`;
    return sc.dryRun ? wouldSkip(detail) : skipped(detail);
  }
  if (c.to === "rule") {
    if (sc.dryRun) {
      const { rows } = await db.query<{ name: string }>("select name from crm_assignment_rules where id = $1 and org_id = $2 and active", [c.ruleId, orgId]);
      return rows[0] ? would(`Would assign ${label} through the rule "${rows[0].name}".`) : wouldSkip("That assignment rule is no longer active.");
    }
    const r = await assignWithRule(db, sc.actor, { ruleId: c.ruleId!, entity: c.subject, entityId: record.id, causedBy: sc.causedBy, now: sc.now });
    if (r.status === "skipped") return skipped(r.reason || "The rule didn't apply.", { ruleId: r.ruleId });
    return done({ outcome: r.status, userId: r.userId, ruleId: r.ruleId, detail: r.reason, duplicate: r.duplicate });
  }
  const userId = c.userId!;
  const person = await assertAssignable(db, orgId, userId).catch((err: unknown) => {
    if (err instanceof AppError) throw new StepFailure("The person this step assigns to is no longer in the workspace or can't see contacts.");
    throw err;
  });
  if (record.assigned_user_id === userId) {
    const detail = `${label} is already assigned to ${person.name}.`;
    return sc.dryRun ? wouldSkip(detail) : skipped(detail);
  }
  if (sc.dryRun) return would(`Would assign ${label} to ${person.name}.`);
  if (c.subject === "contact") {
    await assertNativeOwner(db, orgId, "contacts");
    await db.query("update contacts set assigned_user_id = $3, version = version + 1 where id = $1 and org_id = $2", [record.id, orgId, userId]);
    await emitEvent(db, sc.actor, { type: "contact.assigned", entityType: "contact", entityId: record.id, contactId: record.id, payload: { from: record.assigned_user_id, to: userId, via: "workflow" }, dedupeKey: `contact.assigned:${record.id}:${userId}:${sc.effectKey}`, causedBy: sc.causedBy });
    await recordActivity(db, sc.actor, { kind: "contact.assigned", summary: `Assigned to ${person.name}`, contactId: record.id, metadata: { from: record.assigned_user_id, to: userId, workflowId: sc.workflow.id, runId: sc.run.id } });
    await notifyUser(db, userId, orgId, { kind: "crm_assigned", severity: "info", title: `A contact was assigned to you: ${label}`.slice(0, 200), link: `/crm/contacts/${record.id}`, dedupeKey: `crm-assign:${sc.effectKey}` });
  } else {
    await assertNativeOwner(db, orgId, "opportunities");
    const res = await db.query<{ version: number }>("update crm_opportunities set assigned_user_id = $3, version = version + 1 where id = $1 and org_id = $2 returning version", [record.id, orgId, userId]);
    const deal = record as DealRow;
    await emitEvent(db, sc.actor, { type: "opportunity.updated", entityType: "opportunity", entityId: record.id, contactId: deal.contact_id, payload: { changed: ["ownerId"], via: "workflow" }, dedupeKey: `opportunity.updated:${record.id}:v${res.rows[0].version}`, causedBy: sc.causedBy });
    await recordActivity(db, sc.actor, { kind: "opportunity.assigned", summary: "Deal owner changed", opportunityId: record.id, contactId: deal.contact_id, metadata: { workflowId: sc.workflow.id, runId: sc.run.id } });
    await notifyUser(db, userId, orgId, { kind: "crm_assigned", severity: "info", title: `Deal assigned to you: ${label}`.slice(0, 200), link: `/crm/opportunities/${record.id}`, dedupeKey: `crm-assign:${sc.effectKey}` });
  }
  return done({ userId, assignedTo: person.name });
}

async function execUpdateField(sc: StepContext, c: UpdateFieldConfig): Promise<StepOutcome> {
  const { db } = sc;
  const orgId = sc.org.id;
  const isContact = c.subject === "contact";
  const record = isContact ? await loadContact(db, orgId, sc.run.contactId, !sc.dryRun) : await loadDeal(db, orgId, sc.run.opportunityId, !sc.dryRun);
  if (!record) return sc.dryRun ? wouldSkip(isContact ? NO_CONTACT : NO_DEAL) : skipped(isContact ? NO_CONTACT : NO_DEAL);
  const label = "display_name" in record ? record.display_name : record.name;

  if (c.field.startsWith("cf:")) {
    const fieldId = c.field.slice(3);
    const { rows } = await db.query<{ key: string; label: string }>("select key, label from crm_custom_fields where id = $1 and org_id = $2 and entity = $3 and archived_at is null", [fieldId, orgId, c.subject]);
    if (!rows[0]) throw new StepFailure("The custom field this step sets no longer exists. Edit the workflow.");
    if (sc.dryRun) return would(`Would set ${rows[0].label} on ${label}.`);
    await assertNativeOwner(db, orgId, isContact ? "contacts" : "opportunities");
    const changed = await writeFieldValues(db, sc.actor, c.subject, record.id, { [fieldId]: c.value });
    if (!changed.length) return skipped(`${rows[0].label} already had that value.`);
    const table = isContact ? "contacts" : "crm_opportunities";
    const v = await db.query<{ version: number }>(`update ${table} set version = version + 1 where id = $1 and org_id = $2 returning version`, [record.id, orgId]);
    const contactId = isContact ? record.id : (record as DealRow).contact_id;
    await emitEvent(db, sc.actor, { type: `${c.subject}.updated`, entityType: c.subject, entityId: record.id, contactId, payload: { changed: changed.map((k) => `cf:${k}`), via: "workflow" }, dedupeKey: `${c.subject}.updated:${record.id}:v${v.rows[0].version}`, causedBy: sc.causedBy });
    await recordActivity(db, sc.actor, { kind: `${isContact ? "contact" : "opportunity"}.updated`, summary: `${rows[0].label} updated by a workflow`, contactId, opportunityId: isContact ? null : record.id, metadata: { changed, workflowId: sc.workflow.id, runId: sc.run.id } });
    return done({ field: rows[0].key, changed: true });
  }

  const spec = (UPDATABLE_FIELDS[c.subject] as Record<string, { label: string }>)[c.field];
  if (!spec) throw new StepFailure("This field can't be set by a workflow.");
  const column = c.field === "value" ? "monetary_value" : c.field;
  const current = (record as unknown as Record<string, unknown>)[column];
  const next = typeof c.value === "string" ? c.value.trim() : c.value;
  const same = current === null || current === undefined ? next === null : String(current) === String(next) || Number(current) === next;
  if (same) {
    const detail = `${spec.label} on ${label} already has that value.`;
    return sc.dryRun ? wouldSkip(detail) : skipped(detail);
  }
  if (sc.dryRun) return would(`Would set ${spec.label.toLowerCase()} on ${label} to ${next === null ? "empty" : String(next)}.`);
  await assertNativeOwner(db, orgId, isContact ? "contacts" : "opportunities");
  const table = isContact ? "contacts" : "crm_opportunities";
  const v = await db.query<{ version: number }>(`update ${table} set ${column} = $3, version = version + 1 where id = $1 and org_id = $2 returning version`, [record.id, orgId, next]);
  const camel: Record<string, string> = { lead_status: "leadStatus", lead_score: "leadScore", preferred_channel: "preferredChannel", source: "source", value: "value", probability: "probability" };
  const contactId = isContact ? record.id : (record as DealRow).contact_id;
  await emitEvent(db, sc.actor, { type: `${c.subject}.updated`, entityType: c.subject, entityId: record.id, contactId, payload: { changed: [camel[c.field] ?? c.field], via: "workflow" }, dedupeKey: `${c.subject}.updated:${record.id}:v${v.rows[0].version}`, causedBy: sc.causedBy });
  if (isContact && c.field === "lead_status") {
    await recordActivity(db, sc.actor, { kind: "contact.status_changed", summary: `Lead status changed to ${LEAD_STATUS_LABELS[next as LeadStatus] ?? String(next)}`, contactId: record.id, metadata: { from: current, to: next, workflowId: sc.workflow.id, runId: sc.run.id } });
  } else {
    await recordActivity(db, sc.actor, { kind: isContact ? "contact.updated" : "opportunity.updated", summary: `${spec.label} updated by a workflow`, contactId, opportunityId: isContact ? null : record.id, metadata: { field: c.field, workflowId: sc.workflow.id, runId: sc.run.id } });
  }
  return done({ field: c.field, from: current ?? null, to: next });
}

// ---------------------------------------------------------------------------
// Tasks, notes, team
// ---------------------------------------------------------------------------

async function execCreateTask(sc: StepContext, c: CreateTaskConfig): Promise<StepOutcome> {
  const contact = await loadContact(sc.db, sc.org.id, sc.run.contactId);
  if (c.assignee === "contact_owner" && !contact) return sc.dryRun ? wouldSkip(NO_CONTACT) : skipped(NO_CONTACT);
  const title = (await renderLoose(sc, c.title)) || "Follow up";
  const description = c.description ? await renderLoose(sc, c.description) : null;
  const assigneeId = c.assignee === "user" ? c.userId! : c.assignee === "contact_owner" ? contact?.assigned_user_id ?? null : null;
  const dueAt = c.dueIn ? addDuration(sc.now, c.dueIn) : null;
  const opportunityId = c.linkOpportunity ? sc.run.opportunityId : null;
  if (c.assignee === "user") {
    await assertAssignable(sc.db, sc.org.id, assigneeId!).catch((err: unknown) => {
      if (err instanceof AppError) throw new StepFailure("The person this task is for is no longer in the workspace.");
      throw err;
    });
  }
  if (sc.dryRun) {
    const who = assigneeId ? (await namesOf(sc.db, sc.org.id, "users", [assigneeId]))[0] ?? "a teammate" : "nobody yet";
    return would(`Would create the task "${title}" for ${who}${dueAt ? `, due ${dueAt.toISOString()}` : ""}.`, { title });
  }
  const t = await createTaskInTx(sc.db, sc.actor, { title, description, priority: c.priority, dueAt: dueAt?.toISOString() ?? null, assigneeId, contactId: contact?.id ?? null, opportunityId }, { source: "workflow", causedBy: sc.causedBy });
  return done({ taskId: t.id, title, assigneeId, ...(c.assignee === "contact_owner" && !assigneeId ? { note: "The contact has no owner, so the task is unassigned." } : {}) });
}

async function execNote(sc: StepContext, c: InternalNoteConfig): Promise<StepOutcome> {
  const { db } = sc;
  const isContact = c.subject === "contact";
  const record = isContact ? await loadContact(db, sc.org.id, sc.run.contactId) : await loadDeal(db, sc.org.id, sc.run.opportunityId);
  if (!record) return sc.dryRun ? wouldSkip(isContact ? NO_CONTACT : NO_DEAL) : skipped(isContact ? NO_CONTACT : NO_DEAL);
  const body = (await renderLoose(sc, c.body)).slice(0, 4000);
  if (!body) return sc.dryRun ? wouldSkip("The note would be empty for this record.") : skipped("The note was empty for this record.");
  const label = "display_name" in record ? record.display_name : record.name;
  if (sc.dryRun) return would(`Would add an internal note to ${label}.`);
  const { rows } = await db.query<{ id: string }>("insert into record_notes (org_id, record_type, record_id, body, author_id) values ($1, $2, $3, $4, null) returning id", [sc.org.id, c.subject, record.id, body]);
  const contactId = isContact ? record.id : (record as DealRow).contact_id;
  await recordActivity(db, sc.actor, { kind: "note.added", summary: "Note added by a workflow", contactId: isContact ? record.id : null, opportunityId: isContact ? null : record.id, refType: "note", refId: rows[0].id, metadata: { workflowId: sc.workflow.id, runId: sc.run.id } });
  await emitEvent(db, sc.actor, { type: "note.added", entityType: c.subject, entityId: record.id, contactId, payload: { noteId: rows[0].id, via: "workflow" }, dedupeKey: `note.added:${rows[0].id}`, causedBy: sc.causedBy });
  return done({ noteId: rows[0].id });
}

async function execReassess(sc: StepContext): Promise<StepOutcome> {
  const contact = await loadContact(sc.db, sc.org.id, sc.run.contactId);
  if (!contact) return sc.dryRun ? wouldSkip(NO_CONTACT) : skipped(NO_CONTACT);
  if (sc.dryRun) return would(`Would ask for ${contact.display_name || "the contact"} to be scored again.`);
  await requestReassessment(sc.db, sc.org.id, contact.id, "workflow");
  return done({ detail: "Asked for the lead to be scored again. It is checked within a few minutes, with everything known by then." });
}

async function execSetPriority(sc: StepContext, c: SetPriorityConfig): Promise<StepOutcome> {
  const contact = await loadContact(sc.db, sc.org.id, sc.run.contactId, !sc.dryRun);
  if (!contact) return sc.dryRun ? wouldSkip(NO_CONTACT) : skipped(NO_CONTACT);
  const reason = `Automation "${sc.workflow.name.slice(0, 60)}": ${(await renderLoose(sc, c.reason)).slice(0, 160)}`;
  if (sc.dryRun) return would(`Would mark ${contact.display_name || "the contact"} ${c.label} for ${c.days} day${c.days === 1 ? "" : "s"}.`, { label: c.label });
  const now = new Date();
  const r = await applyOverrideInTx(sc.db, sc.actor, contact.id, { label: c.label, reason, expiresAt: new Date(now.getTime() + c.days * 86_400_000).toISOString() }, now, { keepPeople: true });
  if (!r.applied) return skipped(r.skipped === "person_override" ? "A teammate set this lead's priority by hand, so the workflow left it alone." : NO_CONTACT);
  return done({ label: c.label, days: c.days });
}

async function execRecoveryCheck(sc: StepContext): Promise<StepOutcome> {
  const contact = await loadContact(sc.db, sc.org.id, sc.run.contactId);
  if (!contact) return sc.dryRun ? wouldSkip(NO_CONTACT) : skipped(NO_CONTACT);
  const open = await sc.db.query<{ id: string }>("select id from missed_call_cases where org_id = $1 and contact_id = $2 and state = any($3::text[]) and paused_at is null", [sc.org.id, contact.id, ACTIVE_STATES]);
  if (!open.rows.length) return sc.dryRun ? wouldSkip("This contact has no missed call waiting.") : skipped("This contact has no missed call waiting for a follow-up.");
  if (sc.dryRun) return would("Would ask for the missed call to be looked at now.");
  await sc.db.query("update missed_call_cases set next_action_at = now() where org_id = $1 and id = any($2::uuid[]) and (next_action_at is null or next_action_at > now())", [sc.org.id, open.rows.map((r) => r.id)]);
  return done({ detail: "Asked for the missed call to be looked at now. Consent, opening hours and limits are checked again first.", cases: open.rows.length });
}

async function execNotify(sc: StepContext, c: NotifyTeamConfig): Promise<StepOutcome> {
  const { db } = sc;
  const orgId = sc.org.id;
  const contact = await loadContact(db, orgId, sc.run.contactId);
  if (c.contactOwner && !contact) return sc.dryRun ? wouldSkip(NO_CONTACT) : skipped(NO_CONTACT);
  const title = (await renderLoose(sc, c.title)) || sc.workflow.name;
  const body = c.body ? await renderLoose(sc, c.body) : undefined;
  const userIds = new Set(c.userIds ?? []);
  if (c.contactOwner && contact?.assigned_user_id) userIds.add(contact.assigned_user_id);
  // Only people who are still active members hear about it.
  const members = userIds.size
    ? (await db.query<{ user_id: string }>("select user_id from organization_memberships where org_id = $1 and status = 'active' and user_id = any($2::uuid[])", [orgId, [...userIds]])).rows.map((r) => r.user_id)
    : [];
  if (!members.length && !c.roles?.length) {
    const detail = c.contactOwner ? "The contact has no owner and nobody else was chosen, so nobody was notified." : "Nobody chosen is still in the workspace, so nobody was notified.";
    return sc.dryRun ? wouldSkip(detail) : skipped(detail);
  }
  if (sc.dryRun) return would(`Would notify ${[...(c.roles ?? []).map((r) => (r === "owner" ? "the owner" : "managers")), ...(members.length ? [`${members.length} ${members.length === 1 ? "person" : "people"}`] : [])].join(" and ")}: "${title}".`);
  const link = sc.run.opportunityId ? `/crm/opportunities/${sc.run.opportunityId}` : contact ? `/crm/contacts/${contact.id}` : `/crm/workflows/${sc.workflow.id}/runs/${sc.run.id}`;
  const n = { kind: "system" as const, severity: "info" as const, title, body, link, dedupeKey: `wf-notify:${sc.effectKey}` };
  if (c.roles?.length) await notifyOrgRoles(db, orgId, c.roles, n);
  for (const u of members) await notifyUser(db, u, orgId, n);
  return done({ roles: c.roles ?? [], users: members.length, title });
}

// ---------------------------------------------------------------------------
// Deals
// ---------------------------------------------------------------------------

async function execCreateDeal(sc: StepContext, c: CreateOpportunityConfig): Promise<StepOutcome> {
  const { db } = sc;
  const orgId = sc.org.id;
  const contact = await loadContact(db, orgId, sc.run.contactId);
  if ((c.ownerFromContact || c.skipIfOpenInPipeline) && !contact) return sc.dryRun ? wouldSkip(NO_CONTACT) : skipped(NO_CONTACT);
  const stage = await db.query<{ name: string; kind: string; pipeline: string }>(
    `select s.name, s.kind, p.name as pipeline from crm_pipeline_stages s join crm_pipelines p on p.id = s.pipeline_id and p.org_id = s.org_id
     where s.id = $1 and s.pipeline_id = $2 and s.org_id = $3 and s.archived_at is null and p.archived_at is null`,
    [c.stageId, c.pipelineId, orgId],
  );
  if (!stage.rows[0]) throw new StepFailure("The pipeline stage this step uses no longer exists. Edit the workflow.");
  if (contact && c.skipIfOpenInPipeline) {
    const open = await db.query<{ id: string; name: string }>(
      "select id, name from crm_opportunities where org_id = $1 and contact_id = $2 and pipeline_ref = $3 and provider = 'native' and status = 'open' and archived_at is null order by created_at desc limit 1",
      [orgId, contact.id, c.pipelineId],
    );
    if (open.rows[0]) {
      const detail = `${contact.display_name} already has an open deal in ${stage.rows[0].pipeline} ("${open.rows[0].name}"); the next steps use it.`;
      return sc.dryRun ? wouldSkip(detail) : { type: "done", status: "skipped", result: { outcome: "existing_deal", opportunityId: open.rows[0].id, detail }, opportunityId: open.rows[0].id };
    }
  }
  const name = (await renderLoose(sc, c.name)) || contact?.display_name || "New deal";
  if (sc.dryRun) return would(`Would create the deal "${name}" in ${stage.rows[0].pipeline} → ${stage.rows[0].name}.`);
  const created = await createOpportunityInTx(db, sc.actor, {
    name, pipelineId: c.pipelineId, stageId: c.stageId, contactId: contact?.id ?? null, value: c.value ?? null, ownerId: c.ownerFromContact ? contact?.assigned_user_id ?? null : null,
  }, { via: "workflow", idempotencyKey: sc.effectKey, causedBy: sc.causedBy });
  return { type: "done", status: "completed", result: { opportunityId: created.id, created: created.created, name }, opportunityId: created.id };
}

async function execMoveStage(sc: StepContext, c: MoveStageConfig): Promise<StepOutcome> {
  const { db } = sc;
  const orgId = sc.org.id;
  let deal = await loadDeal(db, orgId, sc.run.opportunityId);
  if (!deal && sc.run.contactId) {
    const { rows } = await db.query<{ id: string }>(
      "select id from crm_opportunities where org_id = $1 and contact_id = $2 and pipeline_ref = $3 and provider = 'native' and status = 'open' and archived_at is null order by created_at desc limit 1",
      [orgId, sc.run.contactId, c.pipelineId],
    );
    deal = await loadDeal(db, orgId, rows[0]?.id ?? null);
  }
  if (!deal) {
    const detail = sc.run.contactId ? "The contact has no open deal in that pipeline, so nothing moved." : NO_DEAL;
    return sc.dryRun ? wouldSkip(detail) : skipped(detail);
  }
  const stage = await db.query<{ name: string; kind: string }>("select name, kind from crm_pipeline_stages where id = $1 and pipeline_id = $2 and org_id = $3 and archived_at is null", [c.stageId, c.pipelineId, orgId]);
  if (!stage.rows[0]) throw new StepFailure("The stage this step moves deals to no longer exists. Edit the workflow.");
  if (deal.stage_ref === c.stageId) {
    const detail = `"${deal.name}" is already in ${stage.rows[0].name}.`;
    return sc.dryRun ? wouldSkip(detail) : { type: "done", status: "skipped", result: { outcome: "skipped", detail, opportunityId: deal.id }, opportunityId: deal.id };
  }
  if (sc.dryRun) return would(`Would move "${deal.name}" to ${stage.rows[0].name}.`);
  const r = await moveOpportunityInTx(db, sc.actor, deal.id, { stageId: c.stageId, lostReason: c.lostReason ?? null }, sc.causedBy);
  return { type: "done", status: "completed", result: { opportunityId: deal.id, stageId: r.stageId, status: r.status, changed: r.changed }, opportunityId: deal.id };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

async function execSendMessage(sc: StepContext, c: SendMessageConfig): Promise<StepOutcome> {
  const { db } = sc;
  const orgId = sc.org.id;
  const contact = await loadContact(db, orgId, sc.run.contactId);
  if (!contact) return sc.dryRun ? wouldSkip(NO_CONTACT) : skipped(NO_CONTACT);
  const template = await loadApprovedTemplate(db, orgId, { id: c.templateId, contentHash: c.contentHash });
  if (!template || template.channel !== c.channel) {
    throw new StepFailure("The message template's approved wording changed (or it is no longer approved) since this workflow was published. Choose the template again and republish.");
  }
  const values = await tokenValuesFor(db, orgId, { contactId: contact.id, timezone: sc.org.timezone, now: sc.now });
  const rendered = renderMessage({ subject: template.subject, body: template.body }, values.values, { customValues: values.customValues });
  if (!rendered.ok) {
    const detail = `${describeMissing(rendered.missing, rendered.unknown, values.customValues)} The message wasn't sent.`;
    return sc.dryRun ? wouldSkip(detail, { reason: "missing_values" }) : blocked("missing_values", detail);
  }
  const channelLabel = c.channel === "sms" ? "SMS" : c.channel === "whatsapp" ? "WhatsApp" : "email";
  if (sc.dryRun) {
    // Read-only checks of the rules the send path applies; the rest (quiet hours, limits, credits) are decided when it sends.
    const address = await contactAddress(db, orgId, contact.id, c.channel);
    if (!address) return wouldSkip(`${contact.display_name} has no ${c.channel === "email" ? "email address" : "phone number"} on file, so it would be blocked.`, { reason: "contact_unreachable" });
    if (await isSuppressed(db, orgId, c.channel, address)) return wouldSkip(`${address} opted out or bounced, so it would be blocked.`, { reason: "suppressed" });
    // A workflow's message is automatic, so it never goes to an address a website visitor typed and nobody has confirmed (evaluateSend refuses it the same way).
    if (await typedByVisitorAddress(db, orgId, contact.id, c.channel, address)) return wouldSkip("The visitor typed this number or address and it has not been confirmed, so it would be blocked.", { reason: "identity_unverified" });
    const consent = await getConsent(db, orgId, contact.id, c.channel, template.purpose);
    if (consent === "revoked") return wouldSkip(`${contact.display_name} withdrew consent on ${channelLabel}, so it would be blocked.`, { reason: "no_consent" });
    if (consent !== "granted") return wouldSkip(`There is no consent on record to send ${contact.display_name} ${template.purpose === "marketing" ? "promotional " : ""}messages on ${channelLabel}, so it would be blocked.`, { reason: "no_consent" });
    // The send path's gate checks the employee it goes out under: included, not paused, passed its connection check.
    const as = (await db.query<{ display_name: string; enabled: boolean; mode: string; status: string }>("select display_name, enabled, mode, status from agent_instances where org_id = $1 and role_key = $2", [orgId, c.sendAs])).rows[0];
    if (!as?.enabled) return wouldSkip("The AI employee this step sends as isn't included in this workspace, so it would be blocked.", { reason: "agent_not_ready" });
    if (as.mode === "paused") return wouldSkip(`${as.display_name} is paused, so nothing would be sent.`, { reason: "automation_paused" });
    if (!AGENT_READY.has(as.status)) return wouldSkip(`${as.display_name} hasn't passed its connection check, so it would be blocked.`, { reason: "agent_not_ready" });
    if (!sc.version.authorized) return wouldSkip("An owner must approve this version before it sends anything.", { reason: "authorization_needed" });
    return would(`Would send the ${channelLabel} template "${template.name}" (v${template.version}) to ${address}, subject to quiet hours, limits and credits when it sends.`, { preview: rendered.body.slice(0, 300) });
  }
  assertAuthorized(sc);
  // This step visit already produced its message (a retry after a later failure, or a run moved back by hand): never a second one.
  const prior = await db.query<{ id: string; status: string }>("select id, status from conversation_messages where org_id = $1 and dedupe_key = $2", [orgId, sc.effectKey]);
  if (prior.rows[0]) return done({ status: prior.rows[0].status, messageId: prior.rows[0].id, duplicate: true, detail: "This step's message was already created; nothing new was sent." }, { messageId: prior.rows[0].id });
  const agent = await db.query<{ id: string }>("select id from agent_instances where org_id = $1 and role_key = $2", [orgId, c.sendAs]);
  const res = await queueOutreach(db, {
    orgId, contactId: contact.id, agentId: agent.rows[0]?.id ?? null, scope: "followup", purpose: template.purpose, body: rendered.body, subject: rendered.subject ?? template.name,
    approvalId: sc.version.approvalId, dedupeKey: sc.effectKey, now: sc.now, disclose: true, businessHoursOnly: c.businessHoursOnly, channel: template.channel,
    templateId: template.whatsappTemplateId,
  });
  if (res.status === "blocked") return blocked(res.reason ?? "blocked", `${res.detail ?? "The message couldn't be sent."} It wasn't sent.`, { messageId: res.messageId ?? null });
  return done({ status: res.status, messageId: res.messageId ?? null, template: template.name, version: template.version, ...(res.status === "draft" ? { detail: res.detail ?? "Held for a person's approval." } : {}) }, { messageId: res.messageId ?? null });
}

/**
 * Asks the run's contact for a review (src/server/crm/reviews.ts): an approved service template with {{review.link}}, sent only when
 * they gave consent to service messages on its channel and haven't been asked recently. The message is a system send acting on the
 * owner's approval of this version, through the same rule chain as every message.
 */
async function execRequestReview(sc: StepContext, c: RequestReviewConfig): Promise<StepOutcome> {
  const { db } = sc;
  const orgId = sc.org.id;
  const contact = await loadContact(db, orgId, sc.run.contactId);
  if (!contact) return sc.dryRun ? wouldSkip(NO_CONTACT) : skipped(NO_CONTACT);
  const template = await loadApprovedTemplate(db, orgId, { id: c.templateId, contentHash: c.contentHash });
  if (!template || template.channel !== c.channel) {
    throw new StepFailure("The review request template's approved wording changed (or it is no longer approved) since this workflow was published. Choose the template again and republish.");
  }
  if (!hasReviewLinkToken(template)) throw new StepFailure("The review request template doesn't contain {{review.link}}, so the customer would get no link. Add it, approve the template again and republish.");
  const channelLabel = c.channel === "sms" ? "SMS" : c.channel === "whatsapp" ? "WhatsApp" : "email";
  if (sc.dryRun) {
    const problem = await reviewRequestProblem(db, orgId, { contactId: contact.id, templateId: c.templateId, contentHash: c.contentHash, kind: c.mode ?? "review", now: sc.now });
    if (problem) return wouldSkip(`${problem.detail} It would be skipped.`, { reason: problem.reason });
    if (!sc.version.authorized) return wouldSkip("An owner must approve this version before it sends anything.", { reason: "authorization_needed" });
    return would(`Would ${c.mode === "survey" ? "send" : "ask"} ${contact.display_name} ${c.mode === "survey" ? "a survey" : "for a review"} with the ${channelLabel} template "${template.name}" (v${template.version}), subject to quiet hours, limits and credits when it sends.`);
  }
  assertAuthorized(sc);
  const r = await queueReviewRequestInTx(db, sc.actor, {
    contactId: contact.id, templateId: c.templateId, contentHash: c.contentHash, businessHoursOnly: c.businessHoursOnly, opportunityId: sc.run.opportunityId,
    appointmentId: typeof sc.run.context.appointmentId === "string" ? sc.run.context.appointmentId : null, kind: c.mode ?? "review", scale: c.scale ?? "csat5",
  }, { via: "workflow", requestedBy: null, dedupeKey: sc.effectKey, causedBy: sc.causedBy, now: sc.now });
  if (r.status === "blocked") return blocked(r.reason, `${r.detail} It wasn't sent.`);
  return done({
    status: "queued", requestId: r.requestId, messageId: r.messageId, template: template.name, version: template.version,
    ...(r.duplicate ? { duplicate: true, detail: "This step's review request was already created; nothing new was sent." } : {}),
  }, { messageId: r.messageId });
}

// ---------------------------------------------------------------------------
// Outside systems and AI
// ---------------------------------------------------------------------------

/** What a webhook or n8n step sends: the workflow, the run, what started it, and (when asked) the contact's basic details and the deal. */
async function outboundPayload(sc: StepContext, includeContact: boolean, maxBytes: number): Promise<Record<string, unknown>> {
  const contact = includeContact ? await loadContact(sc.db, sc.org.id, sc.run.contactId) : null;
  const deal = await loadDeal(sc.db, sc.org.id, sc.run.opportunityId);
  const t = sc.run.context.trigger;
  return {
    workflow: { id: sc.workflow.id, name: sc.workflow.name, version: sc.version.version },
    run: { id: sc.run.id, startedVia: sc.run.startedVia, step: sc.effectKey.split(":").slice(2).join(":") },
    trigger: t ? { type: t.type, eventId: t.eventId ?? null, data: trimJson(t.payload ?? {}, Math.floor(maxBytes / 3)) } : null,
    contact: contact ? { id: contact.id, name: contact.display_name, email: contact.email, phone: contact.phone } : null,
    opportunity: deal ? { id: deal.id, name: deal.name, status: deal.status, value: deal.monetary_value === null ? null : Number(deal.monetary_value), pipelineId: deal.pipeline_ref, stageId: deal.stage_ref } : null,
    ...(sc.run.context.inbound ? { inbound: trimJson(sc.run.context.inbound, Math.floor(maxBytes / 3)) } : {}),
    sentAt: sc.now.toISOString(),
  };
}

async function execWebhook(sc: StepContext, c: WebhookConfig): Promise<StepOutcome> {
  const sub = await sc.db.query<{ name: string; url: string; active: boolean }>("select name, url, active from crm_webhook_subscriptions where id = $1 and org_id = $2", [c.subscriptionId, sc.org.id]);
  if (!sub.rows[0]) throw new StepFailure("The webhook endpoint this step sends to no longer exists. Edit the workflow.");
  if (sc.dryRun) {
    if (!sub.rows[0].active) return wouldSkip(`The webhook "${sub.rows[0].name}" is paused, so the step would fail.`);
    if (!sc.version.authorized) return wouldSkip("An owner must approve this version before it sends anything outside iAcquire.", { reason: "authorization_needed" });
    let host = "";
    try {
      host = new URL(sub.rows[0].url).host;
    } catch {
      host = "its address";
    }
    return would(`Would queue a signed request to "${sub.rows[0].name}" (${host}).`);
  }
  assertAuthorized(sc);
  const payload = await outboundPayload(sc, c.includeContact, 11_000);
  const r = await enqueueWorkflowWebhook(sc.db, { orgId: sc.org.id, subscriptionId: c.subscriptionId, payload, idempotencyKey: sc.effectKey });
  if (r.status === "blocked") throw new StepFailure(r.detail);
  return done({ deliveryId: r.deliveryId, status: r.status, detail: r.detail });
}

async function execN8n(sc: StepContext, c: N8nConfig): Promise<StepOutcome> {
  const m = await sc.db.query<{ status: string; workflow_id: string; template_key: string }>("select status, workflow_id, template_key from automation_template_mappings where id = $1 and org_id = $2", [c.mappingId, sc.org.id]);
  if (!m.rows[0]) throw new StepFailure("The n8n automation this step starts is no longer mapped to this workspace.");
  if (m.rows[0].status !== "verified") throw new StepFailure("The n8n automation this step starts isn't verified any more. Ask your agency to check it, then retry.");
  if (sc.dryRun) {
    if (!sc.version.authorized) return wouldSkip("An owner must approve this version before it starts anything outside iAcquire.", { reason: "authorization_needed" });
    return would(`Would start the n8n automation ${m.rows[0].template_key === "agency-approved" ? m.rows[0].workflow_id : m.rows[0].template_key}.`);
  }
  assertAuthorized(sc);
  const payload = await outboundPayload(sc, c.includeContact, 60_000);
  return { type: "external", call: { kind: "n8n", input: { orgId: sc.org.id, mappingId: c.mappingId, payload, idempotencyKey: sc.effectKey } }, result: { mappingId: c.mappingId } };
}

// ---- Connections (HTTP request, Slack) ----------------------------------------------------------------------------------------------------

interface ConnectionLook {
  name: string;
  kind: string;
  status: string;
  settings: { host?: string; pathPrefix?: string; methods?: string[] };
}

async function loadConnection(sc: StepContext, id: string): Promise<ConnectionLook | null> {
  const exists = (await sc.db.query<{ ok: boolean }>("select to_regclass('public.automation_connections') is not null as ok")).rows[0]?.ok;
  if (!exists) return null;
  return (await sc.db.query<ConnectionLook>("select name, kind, status, settings from automation_connections where id = $1 and org_id = $2", [id, sc.org.id])).rows[0] ?? null;
}

/** Fills placeholders for text sent outside: a value with nothing in it is left out, and the result is not tidied (it may be JSON or a form). */
async function fillOutbound(sc: StepContext, text: string, opts: { encode?: boolean; strict?: boolean } = {}): Promise<string> {
  if (!text.includes("{{")) return text;
  const tv = await tokenValuesFor(sc.db, sc.org.id, { contactId: sc.run.contactId, timezone: sc.org.timezone, now: sc.now });
  const values = opts.encode ? Object.fromEntries(Object.entries(tv.values).map(([k, v]) => [k, typeof v === "string" ? encodeURIComponent(v) : v])) : tv.values;
  const r = renderTemplate(text, values as typeof tv.values, { singleLine: true });
  if (opts.strict && r.missing.length) throw new StepFailure(`The path needs ${r.missing.map((m) => `{{${m}}}`).join(", ")}, which this run doesn't have a value for, so nothing was called.`);
  return r.text;
}

async function fillJson(sc: StepContext, text: string): Promise<string> {
  const walk = async (v: unknown): Promise<unknown> => {
    if (typeof v === "string") return fillOutbound(sc, v);
    if (Array.isArray(v)) return Promise.all(v.map(walk));
    if (v && typeof v === "object") return Object.fromEntries(await Promise.all(Object.entries(v).map(async ([k, x]) => [k, await walk(x)])));
    return v;
  };
  return JSON.stringify(await walk(JSON.parse(text)));
}

async function execHttpRequest(sc: StepContext, c: HttpRequestConfig): Promise<StepOutcome> {
  const conn = await loadConnection(sc, c.connectionId);
  if (!conn || conn.kind !== "http" || conn.status === "revoked") throw new StepFailure("The connection this step uses doesn't exist any more (or was revoked). Edit the workflow.");
  if (!conn.settings.methods?.includes(c.method)) throw new StepFailure(`The connection "${conn.name}" doesn't allow ${c.method} requests. Edit the workflow.`);
  const path = await fillOutbound(sc, c.path, { encode: true, strict: true });
  const query = Object.fromEntries(await Promise.all((c.query ?? []).map(async (q) => [q.name, await fillOutbound(sc, q.value)] as const)));
  let body: string | undefined;
  let contentType: "application/json" | "application/x-www-form-urlencoded" | "text/plain" | undefined;
  if (c.bodyType === "json" && c.body) {
    body = await fillJson(sc, c.body);
    contentType = "application/json";
  } else if (c.bodyType === "text" && c.body) {
    body = await fillOutbound(sc, c.body);
    contentType = "text/plain";
  } else if (c.bodyType === "form") {
    body = new URLSearchParams(await Promise.all((c.form ?? []).map(async (f) => [f.name, await fillOutbound(sc, f.value)] as [string, string]))).toString();
    contentType = "application/x-www-form-urlencoded";
  }
  if (contentType && !normalizeContentType(contentType)) throw new StepFailure("That content type can't be sent.");
  const host = conn.settings.host ?? "";
  const shown = `${host}${conn.settings.pathPrefix ?? ""}${path}`;
  if (sc.dryRun) {
    if (conn.status !== "active") return wouldSkip(`The connection "${conn.name}" ${conn.status === "unverified" ? "hasn't been verified" : "needs attention"}, so the step would wait.`, { reason: "connection_unavailable" });
    if (!sc.version.authorized) return wouldSkip("An owner must approve this version before it calls anything outside iAcquire.", { reason: "authorization_needed" });
    return would(`Would send ${c.method} ${shown} through "${conn.name}"${Object.keys(query).length ? ` with ${Object.keys(query).length} query value${Object.keys(query).length === 1 ? "" : "s"}` : ""}${body !== undefined ? ` and a ${c.bodyType} body` : ""}. Nothing is sent in a test.`, { host, method: c.method });
  }
  assertAuthorized(sc);
  const call: OutboundCall = {
    kind: "http", orgId: sc.org.id, connectionId: c.connectionId, origin: "step", workflowId: sc.workflow.id, runId: sc.run.id, idempotencyKey: sc.effectKey,
    method: c.method, path, query, headers: Object.fromEntries((c.headers ?? []).map((h) => [h.name, h.value])), body, contentType, timeoutSeconds: c.timeoutSeconds, safeToRepeat: c.safeToRepeat === true,
  };
  return { type: "external", call: { kind: "connection", input: call }, result: { connection: conn.name, host, method: c.method } };
}

async function execSlackMessage(sc: StepContext, c: SlackMessageConfig): Promise<StepOutcome> {
  const conn = await loadConnection(sc, c.connectionId);
  if (!conn || conn.kind !== "slack_webhook" || conn.status === "revoked") throw new StepFailure("The Slack connection this step uses doesn't exist any more (or was revoked). Edit the workflow.");
  const text = slackText(await fillOutbound(sc, c.text));
  if (sc.dryRun) {
    if (conn.status !== "active") return wouldSkip(`The Slack connection "${conn.name}" ${conn.status === "unverified" ? "hasn't been verified" : "needs attention"}, so the step would wait.`, { reason: "connection_unavailable" });
    if (!sc.version.authorized) return wouldSkip("An owner must approve this version before it posts anything outside iAcquire.", { reason: "authorization_needed" });
    return would(`Would post to Slack through "${conn.name}": “${text.slice(0, 200)}”. Nothing is posted in a test.`, { preview: text.slice(0, 300) });
  }
  assertAuthorized(sc);
  const call: OutboundCall = { kind: "slack", orgId: sc.org.id, connectionId: c.connectionId, origin: "step", workflowId: sc.workflow.id, runId: sc.run.id, idempotencyKey: sc.effectKey, text };
  return { type: "external", call: { kind: "connection", input: call }, result: { connection: conn.name } };
}

async function execAiTask(sc: StepContext, c: AiTaskConfig, stepKey: string): Promise<StepOutcome> {
  const contact = await loadContact(sc.db, sc.org.id, sc.run.contactId);
  const agent = await sc.db.query<{ display_name: string; enabled: boolean; mode: string; status: string; last_health_ok: boolean | null; hermes_base_url: string | null; hermes_profile: string | null; credential_id: string | null; tool_inventory_contract: string | null; tool_inventory_digest: string | null; tool_inventory_verified_at: Date | null; tool_inventory_expires_at: Date | null; tool_inventory_tool_count: number | null }>(
    `select display_name, enabled, mode, status, last_health_ok, hermes_base_url, hermes_profile, credential_id,
            tool_inventory_contract, tool_inventory_digest, tool_inventory_verified_at, tool_inventory_expires_at, tool_inventory_tool_count
     from agent_instances where org_id = $1 and role_key = $2`,
    [sc.org.id, c.roleKey],
  );
  const name = agent.rows[0]?.display_name ?? c.roleKey;
  if (sc.dryRun) {
    // The checks requestAgentTask makes when the step really runs, in its order, so a test never says "would ask" when it wouldn't.
    const a = agent.rows[0];
    if (!a?.enabled) return wouldSkip(`${name} isn't included in this workspace, so nothing would be asked.`);
    if (a.mode === "paused") return wouldSkip(`${name} is paused, so nothing would be asked.`);
    if (!AGENT_READY.has(a.status)) return wouldSkip(`${name} hasn't passed its connection check, so nothing would be asked.`, { reason: "agent_unavailable" });
    if (!a.hermes_base_url || !a.credential_id) return wouldSkip(`${name} isn't connected to its AI service yet, so nothing would be asked.`, { reason: "agent_unavailable" });
    if (!agentLiveRunsVerified(a)) return wouldSkip(`Live AI employee runs are switched off for now, so nothing would be asked of ${name}.`, { reason: "agent_unavailable" });
    if (!sc.version.authorized) return wouldSkip("An owner must approve this version before it asks an AI employee anything.", { reason: "authorization_needed" });
    return would(`Would ask ${name}${contact ? ` about ${contact.display_name}` : ""}: "${c.instruction.slice(0, 160)}". Its mode (${agent.rows[0].mode.replace("_", " ")}) applies to what it does.`);
  }
  assertAuthorized(sc);
  const r = await requestAgentTask(sc.db, { orgId: sc.org.id, roleKey: c.roleKey, instruction: c.instruction, contactId: contact?.id ?? null, runId: sc.run.id, stepKey: sc.visit > 1 ? `${stepKey}:${sc.visit}` : stepKey });
  if (r.status === "blocked") return blocked("agent_unavailable", r.detail);
  return done({ status: r.status, detail: r.detail, agentRunId: r.agentRunId ?? null });
}

/** Resolves, reopens, prioritises, assigns or pauses the AI on the conversation that started the run (see messaging/workflow-actions.ts). Never sends a message. */
async function execConversationAction(sc: StepContext, c: ConversationActionConfig): Promise<StepOutcome> {
  const conversationId = sc.run.context.conversationId ?? null;
  if (!conversationId) return sc.dryRun ? wouldSkip(NO_CONVERSATION) : skipped(NO_CONVERSATION);
  // A workflow published while the workspace had the new inbox keeps running if the inbox is switched off later: this step then does nothing and says why.
  if (!(await inboxEnabledFor(sc.org.id, sc.db))) return sc.dryRun ? wouldSkip(NOT_ON_NEW_INBOX, { reason: "inbox_not_enabled" }) : blocked("inbox_not_enabled", NOT_ON_NEW_INBOX);
  const r = await applyConversationAction(sc.db, { orgId: sc.org.id, conversationId, config: c, since: sc.run.createdAt, causedBy: sc.causedBy, dryRun: sc.dryRun }).catch((err: unknown) => {
    // A choice made in the workflow that no longer holds (the person left the team) is shown as a failed step, like the task and owner steps.
    if (err instanceof AppError && err.code === "invalid_input") throw new StepFailure(err.message);
    throw err;
  });
  switch (r.result) {
    case "changed": return sc.dryRun ? would(r.would, { conversationId }) : done({ detail: r.did, conversationId, action: c.action, ...r.data });
    case "unchanged": return sc.dryRun ? wouldSkip(r.detail, { conversationId }) : skipped(r.detail, { conversationId });
    case "blocked": return sc.dryRun ? wouldSkip(r.detail, { reason: r.reason, conversationId }) : blocked(r.reason, r.detail, { conversationId });
  }
}

/** Runs (or, in a dry run, describes) one step. Throws StepFailure / AppError for a failure; the runner records it and retries when it can help. */
export async function executeStep(sc: StepContext, step: WorkflowStep): Promise<StepOutcome> {
  const cfg = step.config as never;
  switch (step.kind) {
    case "wait": return execWait(sc, cfg as WaitConfig);
    case "branch": return execBranch(sc, step, cfg as BranchConfig);
    case "add_tag": return execTags(sc, cfg as TagsConfig, true);
    case "remove_tag": return execTags(sc, cfg as TagsConfig, false);
    case "assign": return execAssign(sc, cfg as AssignConfig);
    case "create_task": return execCreateTask(sc, cfg as CreateTaskConfig);
    case "update_field": return execUpdateField(sc, cfg as UpdateFieldConfig);
    case "create_opportunity": return execCreateDeal(sc, cfg as CreateOpportunityConfig);
    case "move_stage": return execMoveStage(sc, cfg as MoveStageConfig);
    case "send_message": return execSendMessage(sc, cfg as SendMessageConfig);
    case "request_review": return execRequestReview(sc, cfg as RequestReviewConfig);
    case "notify_team": return execNotify(sc, cfg as NotifyTeamConfig);
    case "internal_note": return execNote(sc, cfg as InternalNoteConfig);
    case "request_reassessment": return execReassess(sc);
    case "set_priority": return execSetPriority(sc, cfg as SetPriorityConfig);
    case "recovery_check": return execRecoveryCheck(sc);
    case "webhook": return execWebhook(sc, cfg as WebhookConfig);
    case "n8n": return execN8n(sc, cfg as N8nConfig);
    case "http_request": return execHttpRequest(sc, cfg as HttpRequestConfig);
    case "slack_message": return execSlackMessage(sc, cfg as SlackMessageConfig);
    case "ai_task": return execAiTask(sc, cfg as AiTaskConfig, step.key);
    case "conversation_action": return execConversationAction(sc, cfg as ConversationActionConfig);
    case "end": return { type: "end", result: sc.dryRun ? { dryRun: true, outcome: "would_end", detail: "The workflow would end here." } : { detail: "The workflow ended here." } };
  }
  throw new StepFailure(`Unknown step kind ${String((step as { kind: string }).kind)}.`);
}

/** A plain label for a step in logs: its name, or its kind's label. */
export const stepLabel = (step: Pick<WorkflowStep, "kind" | "name"> | null | undefined) => (step ? step.name?.trim() || STEP_KINDS[step.kind]?.label || step.kind : "Step");

export { durationMinutes };
