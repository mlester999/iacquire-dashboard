import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyOrgRoles, notifyUser } from "@/server/notifications";
import { createStandingAuthorization } from "@/server/approvals/service";
import { assertCan, auditActor, crmWrite, type CrmActor } from "@/server/crm/actor";
import { businessValuePhrase, businessValuesNow, UUID_RE } from "@/server/crm/campaigns/rules";
import { voidApproval } from "@/server/crm/campaigns/state";
import { loadApprovedTemplate, tokenValuesFor, type ApprovedTemplateVersion } from "@/server/crm/message-templates";
import { hasReviewLinkToken } from "@/server/crm/reviews";
import { batchApprovalHash, type BatchBinding } from "@/server/reputation/batch-binding";
import { loadAudience, summarize, type AudienceSummary } from "@/server/reputation/batch-audience";
import {
  BATCH_COLUMNS, lockBatch, notice, pauseBatchWith, refreshBatchCounts, releaseBatchMessages, setBatchNotice, withdrawBatchWork, type BatchRow,
} from "@/server/reputation/batch-state";
import { SURVEYS_NOT_ENABLED_MESSAGE, assertBatchesEnabled, batchesEnabledIn, surveysEnabledIn } from "@/server/reputation/entitlement";
import { reviewIncentiveFindings } from "@/lib/reputation/incentives";
import { criteriaProblem, dayIn, describeCriteria, parseCriteria, type BatchCriteria, type CriteriaNames } from "@/lib/reputation/ask-criteria";
import {
  APPROVAL_DAYS, DEFAULT_RATE_PER_MINUTE, MAX_BATCH_PEOPLE, MAX_OPEN_BATCHES, MAX_RATE_PER_MINUTE, PERSON_FILTERS, isEditableStatus, minutesAtPace, readBatchCounts, reasonLabel,
  type BatchEstimate, type BatchPersonView, type BatchPreview, type BatchResults, type BatchView, type PersonFilter,
} from "@/lib/reputation/batches";
import { isFeedbackScale, isRequestKind, type FeedbackScale, type RequestKind } from "@/lib/reputation/scores";
import { describeMissing, renderMessage, type CustomValueTokenDef } from "@/lib/messaging/tokens";
import { CHANNEL_LABELS, type Channel } from "@/lib/messaging";

// Review request batches: one ask to many customers, approved by the owner and sent at a set pace. The service here prepares a batch, shows exactly who would be asked and
// who would not (and why), binds the owner's approval to the wording, the people, the channel and the pace, and pauses, resumes or cancels it. The scheduler's part is in
// batch-job.ts; the people come from batch-audience.ts.
//
// Rule R2 holds all the way through: who is in a batch is decided by a service that was COMPLETED in a window and nothing else; who is then left out is decided by the same
// reachability and consent rules every review request passes, plus a person's own explicit hold. Nothing in these files reads private answers, escalations or scores
// (tests/reputation-gating-guard.test.ts reads them to keep it so).

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

// ---------------------------------------------------------------------------
// Who may do what
// ---------------------------------------------------------------------------

/** Preparing, changing, pausing and cancelling a batch: owners and managers of the client's own workspace. iAcquire support can look, not touch. */
function requireManager(actor: CrmActor) {
  assertCan(actor, "reviews.manage", "Review request batches are prepared by owners and managers.");
  assertCan(actor, "contacts.view");
  if (actor.kind !== "member" || !actor.userId) {
    throw new AppError("forbidden", "Review request batches are prepared by someone in the client's own workspace. iAcquire support can look but not change them.");
  }
}

/** Approving a batch is the owner's decision: it asks many customers at once. */
function requireOwner(actor: CrmActor) {
  requireManager(actor);
  assertCan(actor, "campaigns.send", "Only the business owner can approve asking many customers at once.");
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

interface ListRow extends BatchRow {
  template_name: string | null;
  created_by_name: string | null;
  requested_by_name: string | null;
  approved_by_name: string | null;
}

const LIST_SELECT = `select ${BATCH_COLUMNS.split(", ").map((c) => `b.${c}`).join(", ")}, t.name as template_name, nullif(uc.full_name, '') as created_by_name,
    nullif(ur.full_name, '') as requested_by_name, nullif(ua.full_name, '') as approved_by_name
  from review_request_batches b
  left join crm_message_templates t on t.id = b.template_id and t.org_id = b.org_id
  left join users uc on uc.id = b.created_by left join users ur on ur.id = b.requested_by left join users ua on ua.id = b.approved_by`;

async function names(db: Queryable, orgId: string): Promise<CriteriaNames> {
  const [calendars, types, pipelines] = await Promise.all([
    db.query<{ id: string; name: string }>("select id, name from crm_calendars where org_id = $1", [orgId]),
    db.query<{ id: string; name: string }>("select id, name from crm_appointment_types where org_id = $1", [orgId]),
    db.query<{ id: string; name: string }>("select id, name from crm_pipelines where org_id = $1", [orgId]),
  ]);
  const map = (r: { rows: Array<{ id: string; name: string }> }) => new Map(r.rows.map((x) => [x.id, x.name]));
  return { calendars: map(calendars), appointmentTypes: map(types), pipelines: map(pipelines) };
}

/** How far the messages of these batches got, from the requests and messages themselves. */
async function resultsFor(db: Queryable, orgId: string, ids: string[]): Promise<Map<string, BatchResults>> {
  const out = new Map<string, BatchResults>();
  if (!ids.length) return out;
  const { rows } = await db.query<{ batch_id: string; sent: string; opened: string; undelivered: string }>(
    `select i.batch_id,
       count(*) filter (where r.status <> 'cancelled' and (r.sent_at is not null or m.status in ('sent', 'delivered', 'read')))::text as sent,
       count(*) filter (where r.opened_at is not null)::text as opened,
       count(*) filter (where r.status = 'failed' or (r.status <> 'cancelled' and m.status in ('failed', 'blocked')))::text as undelivered
     from review_request_batch_items i
     join crm_review_requests r on r.id = i.request_id and r.org_id = i.org_id
     left join conversation_messages m on m.id = r.message_id and m.org_id = r.org_id
     where i.org_id = $1 and i.batch_id = any($2::uuid[]) group by i.batch_id`,
    [orgId, ids],
  );
  for (const r of rows) out.set(r.batch_id, { sent: Number(r.sent), opened: Number(r.opened), undelivered: Number(r.undelivered) });
  return out;
}

function readEstimate(raw: unknown): BatchEstimate | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.eligible !== "number" || typeof o.total !== "number" || typeof o.checkedAt !== "string") return null;
  const excluded: Record<string, number> = {};
  if (typeof o.excluded === "object" && o.excluded !== null) for (const [k, v] of Object.entries(o.excluded as Record<string, unknown>)) if (typeof v === "number") excluded[k] = v;
  return { eligible: o.eligible, total: o.total, excluded, checkedAt: o.checkedAt };
}

function toView(r: ListRow, nm: CriteriaNames, results: BatchResults | undefined): BatchView {
  const parsed = parseCriteria(r.criteria);
  return {
    id: r.id, name: r.name, status: r.status, kind: r.kind, scale: r.scale, channel: r.channel, template: r.template_id ? { id: r.template_id, name: r.template_name ?? "Template" } : null,
    criteria: parsed.ok ? parsed.criteria : null, criteriaText: parsed.ok ? describeCriteria(parsed.criteria, nm) : "These choices can't be read any more. Make a new batch.",
    ratePerMinute: r.rate_per_minute, counts: readBatchCounts(r.counts), results: results ?? { sent: 0, opened: 0, undelivered: 0 }, estimate: readEstimate(r.estimate),
    approved: Boolean(r.approved_hash) && ["approved", "sending", "paused", "completed"].includes(r.status),
    createdAt: iso(r.created_at)!, createdByName: r.created_by_name, requestedByName: r.requested_by_name, requestedAt: iso(r.requested_at), approvedByName: r.approved_by_name,
    approvedAt: iso(r.approved_at), startedAt: iso(r.started_at), completedAt: iso(r.completed_at), updatedAt: iso(r.updated_at)!,
  };
}

/** The workspace's batches, newest first, with how far each got. */
export async function listBatches(actor: CrmActor): Promise<BatchView[]> {
  assertCan(actor, "contacts.view");
  return withSystem(async (db) => {
    const { rows } = await db.query<ListRow>(`${LIST_SELECT} where b.org_id = $1 order by b.created_at desc, b.id limit 100`, [actor.orgId]);
    const [nm, results] = await Promise.all([names(db, actor.orgId), resultsFor(db, actor.orgId, rows.map((r) => r.id))]);
    return rows.map((r) => toView(r, nm, results.get(r.id)));
  });
}

/** Whether the Batches tab shows: batches are switched on for the workspace, or it already has some (they stay visible, and can be paused or cancelled, if the switch goes off). */
export async function batchesStatus(actor: CrmActor): Promise<{ enabled: boolean; any: boolean }> {
  assertCan(actor, "contacts.view");
  return withSystem(async (db) => ({
    enabled: await batchesEnabledIn(db, actor.orgId),
    any: (await db.query("select 1 from review_request_batches where org_id = $1 limit 1", [actor.orgId])).rows.length > 0,
  }));
}

export async function getBatch(actor: CrmActor, id: string): Promise<BatchView> {
  assertCan(actor, "contacts.view");
  if (!UUID_RE.test(id)) throw new AppError("not_found", "Batch not found.");
  return withSystem(async (db) => {
    const r = (await db.query<ListRow>(`${LIST_SELECT} where b.id = $1 and b.org_id = $2`, [id, actor.orgId])).rows[0];
    if (!r) throw new AppError("not_found", "Batch not found.");
    const [nm, results] = await Promise.all([names(db, actor.orgId), resultsFor(db, actor.orgId, [r.id])]);
    return toView(r, nm, results.get(r.id));
  });
}

/** The customers of a batch and what became of each. */
export async function listBatchPeople(actor: CrmActor, id: string, opts: { filter?: PersonFilter; page?: number; pageSize?: number } = {}): Promise<{ rows: BatchPersonView[]; total: number; page: number; pageSize: number }> {
  assertCan(actor, "contacts.view");
  if (!UUID_RE.test(id)) throw new AppError("not_found", "Batch not found.");
  const pageSize = Math.min(100, Math.max(5, opts.pageSize ?? 25));
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const filter: PersonFilter = (PERSON_FILTERS as readonly string[]).includes(opts.filter ?? "") ? (opts.filter as PersonFilter) : "all";
  const status = filter === "waiting" ? "pending" : filter === "asked" ? "queued" : filter === "left_out" ? "excluded" : filter === "failed" ? "failed" : null;
  return withSystem(async (db) => {
    if (!(await db.query("select 1 from review_request_batches where id = $1 and org_id = $2", [id, actor.orgId])).rows.length) throw new AppError("not_found", "Batch not found.");
    const from = `from review_request_batch_items i
      left join contacts c on c.id = i.contact_id and c.org_id = i.org_id and c.deleted_at is null
      left join crm_review_requests r on r.id = i.request_id and r.org_id = i.org_id
      left join conversation_messages m on m.id = r.message_id and m.org_id = r.org_id
      where i.batch_id = $1 and i.org_id = $2 and ($3::text is null or i.status = $3)`;
    const total = Number((await db.query<{ n: string }>(`select count(*)::text as n ${from}`, [id, actor.orgId, status])).rows[0].n);
    const { rows } = await db.query<{
      contact_id: string; name: string | null; status: BatchPersonView["status"]; reason: string | null; fact_at: Date | null; request_status: string | null; opened_at: Date | null; message_status: string | null;
    }>(
      `select i.contact_id, c.display_name as name, i.status, i.reason, i.fact_at, r.status as request_status, r.opened_at, m.status as message_status
       ${from} order by (i.status = 'pending'), i.fact_at desc nulls last, i.contact_id limit $4 offset $5`,
      [id, actor.orgId, status, pageSize, (page - 1) * pageSize],
    );
    return {
      total, page, pageSize,
      rows: rows.map((r) => ({
        contactId: r.contact_id, name: r.name || "Unnamed contact", status: r.status, reason: r.reason, reasonText: reasonLabel(r.reason), factAt: iso(r.fact_at),
        delivery: r.status !== "queued" || !r.request_status ? null
          : r.request_status === "cancelled" ? "withdrawn"
          : r.opened_at ? "opened"
          : r.request_status === "failed" || r.message_status === "failed" || r.message_status === "blocked" ? "failed"
          : ["sent", "delivered", "read"].includes(r.message_status ?? "") ? "sent" : "waiting",
      })),
    };
  });
}

export interface BatchBuilderOptions {
  calendars: Array<{ id: string; name: string }>;
  appointmentTypes: Array<{ id: string; name: string; calendarName: string }>;
  pipelines: Array<{ id: string; name: string }>;
}

/** The calendars, appointment types and pipelines a batch can be narrowed to. */
export async function batchBuilderOptions(actor: CrmActor): Promise<BatchBuilderOptions> {
  assertCan(actor, "contacts.view");
  return withSystem(async (db) => {
    const [calendars, types, pipelines] = await Promise.all([
      db.query<{ id: string; name: string }>("select id, name from crm_calendars where org_id = $1 and archived_at is null order by lower(name)", [actor.orgId]),
      db.query<{ id: string; name: string; calendar_name: string }>(
        `select t.id, t.name, c.name as calendar_name from crm_appointment_types t join crm_calendars c on c.id = t.calendar_id and c.org_id = t.org_id
         where t.org_id = $1 and t.archived_at is null order by lower(c.name), lower(t.name)`,
        [actor.orgId],
      ),
      db.query<{ id: string; name: string }>("select id, name from crm_pipelines where org_id = $1 order by lower(name)", [actor.orgId]),
    ]);
    return { calendars: calendars.rows, appointmentTypes: types.rows.map((t) => ({ id: t.id, name: t.name, calendarName: t.calendar_name })), pipelines: pipelines.rows };
  });
}

// ---------------------------------------------------------------------------
// What an approval would cover
// ---------------------------------------------------------------------------

export interface Assessment {
  org: { id: string; name: string; timezone: string };
  criteria: BatchCriteria | null;
  template: ApprovedTemplateVersion | null;
  binding: BatchBinding | null;
  /** What an approval would cover now; null when the batch can't be read well enough to bind (no usable template or criteria). */
  hash: string | null;
  /** Why it can't be approved as it stands, in plain words (the first one is the one to fix first). */
  problems: string[];
  customValues: CustomValueTokenDef[];
}

/**
 * Everything about a batch that is not a person: the criteria, the template's approved wording and the business values it uses, the channel, the pace. The preview, the request
 * for approval, the approval and the scheduler all call this, so they judge the same thing.
 */
export async function assess(db: Queryable, b: BatchRow, now: Date): Promise<Assessment> {
  const org = (await db.query<{ id: string; name: string; timezone: string }>("select id, name, timezone from organizations where id = $1", [b.org_id])).rows[0];
  const problems: string[] = [];
  const parsed = parseCriteria(b.criteria);
  let criteria: BatchCriteria | null = null;
  if (!parsed.ok) problems.push(parsed.message);
  else {
    criteria = parsed.criteria;
    const late = criteriaProblem(criteria, dayIn(org.timezone, now));
    if (late) problems.push(late);
  }

  const template = b.template_id ? await loadApprovedTemplate(db, b.org_id, { id: b.template_id }) : null;
  let values: Awaited<ReturnType<typeof businessValuesNow>> | null = null;
  if (!template) problems.push("The message template was edited, archived or is no longer approved. Choose an approved template.");
  else {
    if (template.channel !== b.channel) problems.push(`The template is now a ${CHANNEL_LABELS[template.channel]} template, but this batch was prepared for ${CHANNEL_LABELS[b.channel]}.`);
    if (!hasReviewLinkToken(template)) problems.push("The template doesn't contain {{review.link}}, so customers would get no link. Add it to the template and approve it again.");
    if (template.purpose !== "service") problems.push("Review requests are service messages. Choose a template whose purpose is service, not marketing.");
    const wording = reviewIncentiveFindings(`${template.subject ?? ""}\n${template.body}`)[0];
    if (wording) problems.push(`${wording.message} Edit the template and approve it again.`);
    // The business details and configuration values the wording uses are approved with it. One that is empty would reach customers as a gap.
    values = await businessValuesNow(db, b.org_id, template);
    for (const [key, value] of Object.entries(values.values)) {
      if (!value) problems.push(`The message uses ${businessValuePhrase(key, values.customValues)}, which isn't filled in yet.`);
    }
  }
  if (b.kind === "survey" && !(await surveysEnabledIn(db, b.org_id))) problems.push(SURVEYS_NOT_ENABLED_MESSAGE);
  if (b.kind === "review") {
    const links = Number((await db.query<{ n: string }>("select count(*)::text as n from crm_review_destinations where org_id = $1 and active", [b.org_id])).rows[0].n);
    if (!links) problems.push("Add at least one public review link first. Every customer you ask sees the same links.");
  }

  const binding: BatchBinding | null = template && criteria && values
    ? {
        kind: b.kind, scale: b.scale, channel: b.channel, templateId: template.templateId, templateVersion: template.version, templateContentHash: template.contentHash,
        whatsappTemplateId: template.whatsappTemplateId, criteria, ratePerMinute: b.rate_per_minute, businessValues: values.values,
      }
    : null;
  return { org, criteria, template, binding, hash: binding ? batchApprovalHash(binding) : null, problems, customValues: values?.customValues ?? [] };
}

const storedEstimate = (s: AudienceSummary, now: Date): BatchEstimate => ({ eligible: s.eligible, total: s.total, excluded: { ...s.excluded } as Record<string, number>, checkedAt: now.toISOString() });

/** The checks before a batch can go to the owner or be approved: nothing in the way, somebody to ask, not too many, and the fingerprint is the one the person looked at. */
async function readyFor(db: Queryable, b: BatchRow, fingerprint: string, now: Date): Promise<{ a: Assessment; summary: AudienceSummary }> {
  const a = await assess(db, b, now);
  if (!a.criteria || !a.binding || !a.hash || a.problems.length) throw new AppError("invalid_input", `It can't go for approval yet: ${a.problems[0] ?? "check the batch."}`);
  if (a.hash !== fingerprint) throw new AppError("conflict", "Something it would send changed since you looked (the message, the people or the pace). Look at the preview again, then continue.");
  const { people, tooLarge } = await loadAudience(db, b.org_id, a.org.timezone, a.criteria, b.channel, now);
  if (tooLarge) throw new AppError("invalid_input", `More than ${MAX_BATCH_PEOPLE.toLocaleString("en-US")} people match. Narrow the dates or the calendar, or make two batches.`);
  const summary = summarize(people);
  if (!summary.eligible) throw new AppError("invalid_input", "Nobody who matches can be asked right now. Check the dates, or why people were left out.");
  return { a, summary };
}

// ---------------------------------------------------------------------------
// Preparing a batch
// ---------------------------------------------------------------------------

export interface BatchInput {
  name: string;
  templateId: string;
  kind?: RequestKind;
  scale?: FeedbackScale;
  /** Parsed by the criteria schema; anything it does not list is refused. */
  criteria: unknown;
  ratePerMinute?: number;
}

interface Clean {
  name: string;
  templateId: string;
  channel: Channel;
  kind: RequestKind;
  scale: FeedbackScale;
  criteria: BatchCriteria;
  rate: number;
}

async function cleanInput(db: Queryable, actor: CrmActor, input: BatchInput, now: Date): Promise<Clean> {
  const name = String(input.name ?? "").replace(/\s+/g, " ").trim();
  if (!name || name.length > 120) throw new AppError("invalid_input", "Give the batch a name of up to 120 characters.");
  if (input.kind !== undefined && !isRequestKind(input.kind)) throw new AppError("invalid_input", "Choose a review request or a survey.");
  if (input.scale !== undefined && !isFeedbackScale(input.scale)) throw new AppError("invalid_input", "Choose a scale of one to five or zero to ten.");
  const kind: RequestKind = input.kind ?? "review";
  const scale: FeedbackScale = kind === "survey" ? (input.scale ?? "csat5") : "csat5";
  const rate = input.ratePerMinute ?? DEFAULT_RATE_PER_MINUTE;
  if (!Number.isInteger(rate) || rate < 1 || rate > MAX_RATE_PER_MINUTE) throw new AppError("invalid_input", `Choose a pace of 1 to ${MAX_RATE_PER_MINUTE} messages a minute.`);
  const parsed = parseCriteria(input.criteria);
  if (!parsed.ok) throw new AppError("invalid_input", parsed.message);
  const late = criteriaProblem(parsed.criteria, dayIn(actor.timezone, now));
  if (late) throw new AppError("invalid_input", late);
  const c = parsed.criteria;
  // The calendars, appointment types and pipeline named belong to this workspace (a stranger's id is refused, never quietly dropped).
  for (const [table, ids, what] of [["crm_calendars", c.calendarIds, "calendar"], ["crm_appointment_types", c.appointmentTypeIds, "appointment type"], ["crm_pipelines", c.pipelineId ? [c.pipelineId] : undefined, "pipeline"]] as const) {
    if (!ids?.length) continue;
    const n = Number((await db.query<{ n: string }>(`select count(*)::text as n from ${table} where org_id = $1 and id = any($2::uuid[])`, [actor.orgId, ids])).rows[0].n);
    if (n !== ids.length) throw new AppError("not_found", `One of the ${what}s you chose wasn't found. Choose from the list.`);
  }
  if (!UUID_RE.test(input.templateId ?? "")) throw new AppError("invalid_input", "Choose an approved message template.");
  const template = await loadApprovedTemplate(db, actor.orgId, { id: input.templateId });
  if (!template) throw new AppError("invalid_input", "That template isn't approved. Choose an approved message template.");
  if (!hasReviewLinkToken(template)) throw new AppError("invalid_input", "That template doesn't contain {{review.link}}, so customers would get no link.");
  if (template.purpose !== "service") throw new AppError("invalid_input", "Review requests are service messages. Choose a template whose purpose is service.");
  return { name, templateId: template.templateId, channel: template.channel, kind, scale, criteria: c, rate };
}

async function loadOwn(db: Queryable, orgId: string, id: string, lock = true): Promise<BatchRow> {
  if (!UUID_RE.test(id)) throw new AppError("not_found", "Batch not found.");
  const b = lock ? await lockBatch(db, id, orgId) : (await db.query<BatchRow>(`select ${BATCH_COLUMNS} from review_request_batches where id = $1 and org_id = $2`, [id, orgId])).rows[0];
  if (!b) throw new AppError("not_found", "Batch not found.");
  return b;
}

/** A new draft. Nothing is sent and nobody is chosen yet: people are read from the criteria when it is previewed and again when it starts. */
export async function createBatch(actor: CrmActor, input: BatchInput, opts: { now?: Date } = {}): Promise<{ id: string }> {
  requireManager(actor);
  const now = opts.now ?? new Date();
  return crmWrite(actor, async (db) => {
    await assertBatchesEnabled(db, actor.orgId);
    await db.query("select pg_advisory_xact_lock(hashtext('review_request_batches:' || $1))", [actor.orgId]);
    const open = Number((await db.query<{ n: string }>("select count(*)::text as n from review_request_batches where org_id = $1 and status not in ('completed', 'cancelled', 'stopped')", [actor.orgId])).rows[0].n);
    if (open >= MAX_OPEN_BATCHES) throw new AppError("conflict", `A workspace can have ${MAX_OPEN_BATCHES} batches that haven't finished. Finish or cancel one first.`);
    const c = await cleanInput(db, actor, input, now);
    const { rows } = await db.query<{ id: string }>(
      `insert into review_request_batches (org_id, name, kind, scale, channel, template_id, criteria, rate_per_minute, created_by)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9) returning id`,
      [actor.orgId, c.name, c.kind, c.scale, c.channel, c.templateId, JSON.stringify(c.criteria), c.rate, actor.userId],
    );
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "reputation.batch_created", targetType: "review_request_batch", targetId: rows[0].id, result: "success", metadata: { kind: c.kind, channel: c.channel, source: c.criteria.source } }, db);
    return { id: rows[0].id };
  });
}

/**
 * Changes a batch that has not been approved. Changing what the owner would be asked to approve (the message, the people, the channel, the pace) takes a batch that was waiting
 * for the owner back to draft; renaming does not.
 */
export async function updateBatch(actor: CrmActor, id: string, input: BatchInput & { expectedUpdatedAt?: string }, opts: { now?: Date } = {}): Promise<{ returnedToDraft: boolean }> {
  requireManager(actor);
  const now = opts.now ?? new Date();
  return crmWrite(actor, async (db) => {
    await assertBatchesEnabled(db, actor.orgId);
    const b = await loadOwn(db, actor.orgId, id);
    if (!isEditableStatus(b.status)) throw new AppError("conflict", "This batch has been approved or has finished, so it can't be changed. Pause or cancel it, or copy it to start a new one.");
    if (input.expectedUpdatedAt && new Date(input.expectedUpdatedAt).getTime() !== new Date(b.updated_at).getTime()) {
      throw new AppError("conflict", "Someone else changed this batch. Reload to see their changes, then try again.");
    }
    const c = await cleanInput(db, actor, input, now);
    const before = parseCriteria(b.criteria);
    const covered = b.template_id !== c.templateId || b.channel !== c.channel || b.kind !== c.kind || b.scale !== c.scale || b.rate_per_minute !== c.rate
      || !before.ok || JSON.stringify(before.criteria) !== JSON.stringify(c.criteria);
    const back = b.status === "awaiting_approval" && covered;
    await db.query(
      `update review_request_batches set name = $3, kind = $4, scale = $5, channel = $6, template_id = $7, criteria = $8::jsonb, rate_per_minute = $9,
         status = case when $10::boolean then 'draft' else status end, requested_by = case when $10::boolean then null else requested_by end,
         requested_at = case when $10::boolean then null else requested_at end
       where id = $1 and org_id = $2`,
      [id, actor.orgId, c.name, c.kind, c.scale, c.channel, c.templateId, JSON.stringify(c.criteria), c.rate, back],
    );
    if (back) await setBatchNotice(db, b, notice("returned", `${actor.label} changed the batch after it was sent for approval, so it needs asking again.`, now), { waitUntil: null });
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "reputation.batch_updated", targetType: "review_request_batch", targetId: id, result: "success", metadata: { returnedToDraft: back, covered } }, db);
    return { returnedToDraft: back };
  });
}

/** A new draft with the same choices, for a stopped, finished or cancelled batch (or to start from an existing one). Never copies an approval. */
export async function duplicateBatch(actor: CrmActor, id: string): Promise<{ id: string }> {
  requireManager(actor);
  return crmWrite(actor, async (db) => {
    await assertBatchesEnabled(db, actor.orgId);
    const b = await loadOwn(db, actor.orgId, id, false);
    const { rows } = await db.query<{ id: string }>(
      `insert into review_request_batches (org_id, name, kind, scale, channel, template_id, criteria, rate_per_minute, created_by)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9) returning id`,
      [actor.orgId, `Copy of ${b.name}`.slice(0, 120), b.kind, b.scale, b.channel, b.template_id, JSON.stringify(b.criteria), b.rate_per_minute, actor.userId],
    );
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "reputation.batch_duplicated", targetType: "review_request_batch", targetId: rows[0].id, result: "success", metadata: { from: id } }, db);
    return { id: rows[0].id };
  });
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

const SAMPLE = 8;

/**
 * Who would be asked and who would not (with the reason), what the message says, and the fingerprint an approval would cover. Reads only. People are checked again one by one
 * when they are asked, so this is a good account of the moment, not a promise about later.
 */
export async function previewBatch(actor: CrmActor, id: string, opts: { now?: Date } = {}): Promise<BatchPreview> {
  assertCan(actor, "contacts.view");
  const now = opts.now ?? new Date();
  return withSystem(async (db) => {
    const b = await loadOwn(db, actor.orgId, id, false);
    const a = await assess(db, b, now);
    const problems = [...a.problems];
    const audience = { total: 0, eligible: 0, excluded: {} as Record<string, number>, tooLarge: false };
    const sample: BatchPreview["sample"] = { eligible: [], excluded: [] };
    let message: BatchPreview["message"] = null;
    if (a.criteria) {
      const { people, tooLarge } = await loadAudience(db, b.org_id, a.org.timezone, a.criteria, b.channel, now);
      const s = summarize(people);
      audience.total = s.total;
      audience.eligible = s.eligible;
      audience.excluded = { ...s.excluded } as Record<string, number>;
      audience.tooLarge = tooLarge;
      sample.eligible = people.filter((p) => p.outcome === "eligible").slice(0, SAMPLE).map((p) => ({ id: p.contactId, name: p.name }));
      sample.excluded = people.filter((p) => p.outcome !== "eligible").slice(0, SAMPLE).map((p) => ({ id: p.contactId, name: p.name, reason: p.outcome }));
      if (tooLarge) problems.push(`More than ${MAX_BATCH_PEOPLE.toLocaleString("en-US")} people match. Narrow the dates or the calendar, or make two batches.`);
      else if (!s.total) problems.push("Nobody matches these choices. Check the dates and what they are for.");
      else if (!s.eligible) problems.push("Nobody who matches can be asked right now. See why below.");
      const first = people.find((p) => p.outcome === "eligible");
      if (a.template && first) {
        const values = await tokenValuesFor(db, b.org_id, { contactId: first.contactId, senderUserId: actor.userId, timezone: a.org.timezone, now });
        values.values["review.link"] = "[review link]";
        const out = renderMessage({ subject: a.template.subject, body: a.template.body }, values.values, { customValues: values.customValues });
        // A detail missing for one person leaves that person out when they are asked; it is not shown as a problem of the whole batch.
        if (out.ok) message = { subject: out.subject, body: out.body, forName: first.name };
        else if (out.unknown.length || out.missing.some((k) => !k.startsWith("contact."))) problems.push(describeMissing(out.missing.filter((k) => !k.startsWith("contact.")), out.unknown, values.customValues));
      }
    }
    return {
      batchId: b.id, fingerprint: problems.length ? null : a.hash, problems, template: a.template ? { id: a.template.templateId, name: a.template.name, version: a.template.version } : null,
      channel: b.channel, audience, sample, message, minutes: minutesAtPace(audience.eligible, b.rate_per_minute), checkedAt: now.toISOString(), canApprove: problems.length === 0 && Boolean(a.hash),
    };
  });
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

/** A manager asks the owner to approve a batch. What the owner is shown is the fingerprint the manager saw: if anything changed in between, the owner is shown the new one. */
export async function requestBatchApproval(actor: CrmActor, id: string, input: { fingerprint: string }, opts: { now?: Date } = {}): Promise<{ status: "requested" | "already_requested" }> {
  requireManager(actor);
  const now = opts.now ?? new Date();
  return crmWrite(actor, async (db) => {
    await assertBatchesEnabled(db, actor.orgId);
    const b = await loadOwn(db, actor.orgId, id);
    if (b.status === "awaiting_approval") return { status: "already_requested" as const };
    if (b.status !== "draft") throw new AppError("conflict", "Only a draft can be sent to the owner for approval.");
    const { a, summary } = await readyFor(db, b, input.fingerprint, now);
    await db.query("update review_request_batches set status = 'awaiting_approval', requested_by = $3, requested_at = $4, estimate = $5::jsonb where id = $1 and org_id = $2", [
      id, actor.orgId, actor.userId, now.toISOString(), JSON.stringify(storedEstimate(summary, now)),
    ]);
    await notifyOrgRoles(db, actor.orgId, ["owner"], {
      kind: "approval_requested", severity: "info", title: `Review request batch “${b.name.slice(0, 80)}” needs your approval`,
      body: `${summary.eligible.toLocaleString("en-US")} ${summary.eligible === 1 ? "person" : "people"} by ${CHANNEL_LABELS[b.channel]}, at most ${b.rate_per_minute} a minute.`,
      link: `/crm/reviews?tab=batches&batch=${id}`, dedupeKey: `review-batch-approval:${id}:${a.hash!.slice(0, 16)}`,
    });
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "reputation.batch_approval_requested", targetType: "review_request_batch", targetId: id, result: "success", metadata: { hash: a.hash, eligible: summary.eligible } }, db);
    return { status: "requested" as const };
  });
}

/**
 * The owner approves exactly what they were shown. The approval is bound to a hash of the message's approved wording and version, who it is for, the channel and the pace
 * (and the business details the wording uses); the scheduler stops the batch if any of it changes, and the approval lapses after APPROVAL_DAYS if the batch has not finished.
 * Approving does not send anything: the scheduler starts the batch, and every customer is checked again, by the same rules as one review request, as they are asked.
 */
export async function approveBatch(actor: CrmActor, id: string, input: { fingerprint: string }, opts: { now?: Date } = {}): Promise<{ eligible: number; minutes: number }> {
  requireOwner(actor);
  const now = opts.now ?? new Date();
  return crmWrite(actor, async (db) => {
    await assertBatchesEnabled(db, actor.orgId);
    const b = await loadOwn(db, actor.orgId, id);
    if (b.status !== "draft" && b.status !== "awaiting_approval") throw new AppError("conflict", "This batch was already decided.");
    const { a, summary } = await readyFor(db, b, input.fingerprint, now);
    const approvalId = await createStandingAuthorization(db, {
      orgId: actor.orgId, userId: actor.userId!, scopeKey: `review_batch:${id}`, days: APPROVAL_DAYS, title: `Ask ${summary.eligible.toLocaleString("en-US")} customers: “${b.name.slice(0, 80)}”`,
      reason: `The owner approved the wording, the people, the channel and the pace of this review request batch (${a.hash!.slice(0, 12)}).`,
      expectedEffect: `Customers who were served in the chosen dates, agreed to messages on this channel and haven't opted out or been asked in the last 30 days get one message each, at most ${b.rate_per_minute} a minute, outside quiet hours. Anything that changes the approved wording stops the batch.`,
    });
    await db.query(
      `update review_request_batches set status = 'approved', approval_id = $3, approved_hash = $4, approved_binding = $5::jsonb, approved_by = $6, approved_at = $7, estimate = $8::jsonb
       where id = $1 and org_id = $2`,
      [id, actor.orgId, approvalId, a.hash, JSON.stringify(a.binding), actor.userId, now.toISOString(), JSON.stringify(storedEstimate(summary, now))],
    );
    await setBatchNotice(db, b, null, { waitUntil: null });
    if (b.requested_by && b.requested_by !== actor.userId) {
      await notifyUser(db, b.requested_by, actor.orgId, {
        kind: "approval_decided", severity: "success", title: `Review request batch “${b.name.slice(0, 80)}” was approved`, body: "It starts within a minute or two of the next scheduled run.",
        link: `/crm/reviews?tab=batches&batch=${id}`, dedupeKey: `review-batch-decided:${id}:${approvalId}`,
      });
    }
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "reputation.batch_approved", targetType: "review_request_batch", targetId: id, approvalId, result: "success", metadata: { hash: a.hash, eligible: summary.eligible } }, db);
    return { eligible: summary.eligible, minutes: minutesAtPace(summary.eligible, b.rate_per_minute) };
  });
}

/** The owner sends a batch back to its author with a note. Nothing is approved and nothing is sent. */
export async function returnBatch(actor: CrmActor, id: string, note?: string | null, opts: { now?: Date } = {}): Promise<void> {
  requireOwner(actor);
  const now = opts.now ?? new Date();
  const why = String(note ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  await crmWrite(actor, async (db) => {
    const b = await loadOwn(db, actor.orgId, id);
    if (b.status !== "awaiting_approval") throw new AppError("conflict", "This batch isn't waiting for approval.");
    await db.query("update review_request_batches set status = 'draft', requested_by = null, requested_at = null where id = $1 and org_id = $2", [id, actor.orgId]);
    await setBatchNotice(db, b, notice("returned", why ? `The owner sent it back: “${why}”` : "The owner didn't approve it. Change it and ask again.", now), { waitUntil: null });
    if (b.requested_by) {
      await notifyUser(db, b.requested_by, actor.orgId, {
        kind: "approval_decided", severity: "warning", title: `Review request batch “${b.name.slice(0, 80)}” was sent back`, body: why || "The owner didn't approve it.",
        link: `/crm/reviews?tab=batches&batch=${id}`, dedupeKey: `review-batch-returned:${id}:${now.getTime()}`,
      });
    }
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "reputation.batch_returned", targetType: "review_request_batch", targetId: id, result: "success" }, db);
  });
}

// ---------------------------------------------------------------------------
// Pause, resume, cancel
// ---------------------------------------------------------------------------

/** Holds a batch that is approved or sending, and the messages it queued that have not left. Nothing is lost: resuming checks every rule again before they go. */
export async function pauseBatch(actor: CrmActor, id: string, opts: { now?: Date } = {}): Promise<{ held: number }> {
  requireManager(actor);
  const now = opts.now ?? new Date();
  return crmWrite(actor, async (db) => {
    const b = await loadOwn(db, actor.orgId, id);
    if (b.status !== "approved" && b.status !== "sending") throw new AppError("conflict", "Only a batch that is waiting to start or sending can be paused.");
    const held = await pauseBatchWith(db, b, notice("paused", `${actor.label} paused it.`, now), { hold: true, byUserId: actor.userId, notify: false });
    return { held };
  });
}

/** Continues a paused batch. The owner's approval must still stand: the scheduler checks it again before it asks anyone. */
export async function resumeBatch(actor: CrmActor, id: string, opts: { now?: Date } = {}): Promise<{ released: number }> {
  requireManager(actor);
  const now = opts.now ?? new Date();
  return crmWrite(actor, async (db) => {
    await assertBatchesEnabled(db, actor.orgId);
    const b = await loadOwn(db, actor.orgId, id);
    if (b.status !== "paused") throw new AppError("conflict", "This batch isn't paused.");
    if (!b.approved_hash) throw new AppError("conflict", "This batch has no approval to continue under. Copy it and ask the owner to approve the copy.");
    const released = await releaseBatchMessages(db, b, now);
    await db.query("update review_request_batches set status = $3 where id = $1 and org_id = $2", [id, actor.orgId, b.started_at ? "sending" : "approved"]);
    await setBatchNotice(db, b, null, { waitUntil: null });
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "reputation.batch_resumed", targetType: "review_request_batch", targetId: id, approvalId: b.approval_id, result: "success", metadata: { released } }, db);
    return { released };
  });
}

/** Ends a batch that has not finished. Nobody else is asked, and what it queued but has not sent is stopped (messages already sent stay sent). */
export async function cancelBatch(actor: CrmActor, id: string, opts: { now?: Date } = {}): Promise<{ stopped: number }> {
  requireManager(actor);
  const now = opts.now ?? new Date();
  return crmWrite(actor, async (db) => {
    const b = await loadOwn(db, actor.orgId, id);
    if (b.status === "completed" || b.status === "cancelled" || b.status === "stopped") throw new AppError("conflict", "This batch has already ended.");
    await db.query("update review_request_batches set status = 'cancelled', cancelled_by = $3, completed_at = $4 where id = $1 and org_id = $2", [id, actor.orgId, actor.userId, now.toISOString()]);
    if (b.approval_id) await voidApproval(db, b, `${actor.label} cancelled the batch.`, actor.userId);
    const w = await withdrawBatchWork(db, b, "batch_cancelled", "Not sent: the batch was cancelled.");
    await refreshBatchCounts(db, b, { notice: null, waitUntil: null });
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "reputation.batch_cancelled", targetType: "review_request_batch", targetId: id, approvalId: b.approval_id, result: "success", metadata: { waiting: w.waiting, messages: w.messages } }, db);
    return { stopped: w.messages };
  });
}
