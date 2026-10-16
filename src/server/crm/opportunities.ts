import "server-only";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyUser } from "@/server/notifications";
import { assertCan, auditActor, crmRead, crmWrite, eventActor, type CrmActor } from "@/server/crm/actor";
import { assertNativeOwner } from "@/server/crm/workspace";
import { emitEvent, recordActivity } from "@/server/crm/events";
import { ensureDefaultPipeline, type StageKind } from "@/server/crm/pipelines";
import { assertAssignable } from "@/server/crm/contacts";
import { readFieldValues, writeFieldValues, type RecordFieldValue } from "@/server/crm/fields";

export type OpportunityStatus = "open" | "won" | "lost";

export interface OpportunityInput {
  name: string;
  pipelineId?: string | null;
  stageId?: string | null;
  contactId?: string | null;
  companyId?: string | null;
  value?: number | null;
  currency?: string | null;
  ownerId?: string | null;
  expectedCloseDate?: string | null;
  source?: string | null;
  probability?: number | null;
  description?: string | null;
  tagIds?: string[];
  customFields?: Record<string, unknown>;
}

export type OpportunityVia = "manual" | "import" | "form" | "booking" | "api" | "agent" | "workflow" | "ghl_migration";

function checkValue(v: number | null | undefined) {
  if (v === null || v === undefined) return null;
  if (!Number.isFinite(v) || v < 0 || v >= 1e12) throw new AppError("invalid_input", "The deal value must be zero or more.");
  return Math.round(v * 100) / 100;
}

function checkDate(d: string | null | undefined) {
  if (!d) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) throw new AppError("invalid_input", "Expected close date must be a date like 2026-11-30.");
  return d;
}

async function resolveStage(db: Queryable, orgId: string, pipelineId: string, stageId: string | null | undefined) {
  const { rows } = await db.query<{ id: string; kind: StageKind; name: string; pipeline_id: string }>(
    `select id, kind, name, pipeline_id from crm_pipeline_stages where org_id = $1 and pipeline_id = $2 and archived_at is null and ($3::uuid is null or id = $3) order by position limit 1`,
    [orgId, pipelineId, stageId ?? null],
  );
  if (!rows[0]) throw new AppError("not_found", stageId ? "That stage isn't in this pipeline." : "This pipeline has no stages.");
  return rows[0];
}

async function assertContactAndCompany(db: Queryable, orgId: string, contactId?: string | null, companyId?: string | null) {
  if (contactId) {
    const c = await db.query("select 1 from contacts where id = $1 and org_id = $2 and deleted_at is null", [contactId, orgId]);
    if (!c.rows.length) throw new AppError("not_found", "Contact not found.");
  }
  if (companyId) {
    const c = await db.query("select 1 from crm_companies where id = $1 and org_id = $2 and deleted_at is null", [companyId, orgId]);
    if (!c.rows.length) throw new AppError("not_found", "Company not found.");
  }
}

async function addHistory(db: Queryable, actor: CrmActor, e: { opportunityId: string; fromStage: string | null; toStage: string; fromStatus: OpportunityStatus | null; toStatus: OpportunityStatus; since: Date | null }) {
  const who = eventActor(actor);
  const { rows } = await db.query<{ id: string }>(
    `insert into crm_opportunity_history (org_id, opportunity_id, from_stage, to_stage, from_status, to_status, seconds_in_previous, actor_kind, actor_user_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [actor.orgId, e.opportunityId, e.fromStage, e.toStage, e.fromStatus, e.toStatus, e.since ? Math.max(0, Math.round((Date.now() - new Date(e.since).getTime()) / 1000)) : null, who.kind === "api" ? "api" : who.kind, actor.kind === "member" || actor.kind === "agency" ? actor.userId : null],
  );
  return rows[0].id;
}

/** Creates a deal inside the caller's transaction. With an idempotency key, a retry returns the deal it already made. */
export async function createOpportunityInTx(db: Queryable, actor: CrmActor, input: OpportunityInput, opts: { via: OpportunityVia; idempotencyKey?: string; causedBy?: { eventId: number; depth: number } | null }): Promise<{ id: string; created: boolean }> {
  await assertNativeOwner(db, actor.orgId, "opportunities");
  if (opts.idempotencyKey) {
    const existing = await db.query<{ id: string }>("select id from crm_opportunities where org_id = $1 and idempotency_key = $2", [actor.orgId, opts.idempotencyKey]);
    if (existing.rows[0]) return { id: existing.rows[0].id, created: false };
  }
  const name = input.name.replace(/\s+/g, " ").trim();
  if (!name || name.length > 200) throw new AppError("invalid_input", "Give the deal a name of up to 200 characters.");
  const pipelineId = input.pipelineId ?? (await ensureDefaultPipeline(db, actor));
  const pipe = await db.query("select 1 from crm_pipelines where id = $1 and org_id = $2 and provider = 'native' and archived_at is null", [pipelineId, actor.orgId]);
  if (!pipe.rows.length) throw new AppError("not_found", "Pipeline not found.");
  const stage = await resolveStage(db, actor.orgId, pipelineId, input.stageId);
  if (stage.kind !== "open") throw new AppError("invalid_input", "New deals start in an open stage.");
  await assertContactAndCompany(db, actor.orgId, input.contactId, input.companyId);
  if (input.ownerId) await assertAssignable(db, actor.orgId, input.ownerId);
  const ws = await db.query<{ default_currency: string }>("select default_currency from crm_workspaces where org_id = $1", [actor.orgId]);
  const currency = (input.currency ?? ws.rows[0]?.default_currency ?? "USD").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new AppError("invalid_input", "Use a three-letter currency code.");
  if (input.probability !== undefined && input.probability !== null && (!Number.isInteger(input.probability) || input.probability < 0 || input.probability > 100)) throw new AppError("invalid_input", "Probability is a whole number from 0 to 100.");
  const contactLabel = input.contactId ? (await db.query<{ n: string }>("select display_name as n from contacts where id = $1", [input.contactId])).rows[0]?.n ?? null : null;
  const { rows } = await db.query<{ id: string }>(
    `insert into crm_opportunities (org_id, provider, name, status, pipeline_ref, stage_ref, stage_name, contact_id, company_id, contact_label, monetary_value, currency, assigned_user_id,
       expected_close_date, source, probability, description, created_by, created_via, stage_entered_at, idempotency_key, synced_at)
     values ($1, 'native', $2, 'open', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, now(), $18, now()) returning id`,
    [
      actor.orgId, name, pipelineId, stage.id, stage.name, input.contactId ?? null, input.companyId ?? null, contactLabel, checkValue(input.value), currency, input.ownerId ?? null,
      checkDate(input.expectedCloseDate), input.source?.trim().slice(0, 120) || opts.via, input.probability ?? null, input.description?.trim().slice(0, 2000) || null,
      actor.kind === "member" || actor.kind === "agency" ? actor.userId : null, opts.via, opts.idempotencyKey ?? null,
    ],
  );
  const id = rows[0].id;
  await addHistory(db, actor, { opportunityId: id, fromStage: null, toStage: stage.id, fromStatus: null, toStatus: "open", since: null });
  if (input.tagIds?.length) await setOpportunityTagsInTx(db, actor, id, input.tagIds);
  if (input.customFields && Object.keys(input.customFields).length) await writeFieldValues(db, actor, "opportunity", id, input.customFields, { enforceRequired: opts.via === "manual", isNew: true });
  await emitEvent(db, actor, { type: "opportunity.created", entityType: "opportunity", entityId: id, contactId: input.contactId ?? null, payload: { pipelineId, stageId: stage.id, value: checkValue(input.value), currency, via: opts.via }, dedupeKey: `opportunity.created:${id}`, causedBy: opts.causedBy });
  await recordActivity(db, actor, { kind: "opportunity.created", summary: `Deal created in ${stage.name}`, opportunityId: id, contactId: input.contactId ?? null, companyId: input.companyId ?? null });
  if (input.ownerId && input.ownerId !== actor.userId) await notifyUser(db, input.ownerId, actor.orgId, { kind: "crm_assigned", severity: "info", title: `New deal assigned to you: ${name}`, link: `/crm/opportunities/${id}`, dedupeKey: `crm-opp-assigned:${id}:${input.ownerId}` });
  return { id, created: true };
}

export async function createOpportunity(actor: CrmActor, input: OpportunityInput, opts: { idempotencyKey?: string } = {}): Promise<{ id: string }> {
  assertCan(actor, "opportunities.edit");
  if (input.ownerId && input.ownerId !== actor.userId) assertCan(actor, "contacts.assign", "Assigning deals to someone else needs the assign permission.");
  return crmWrite(actor, async (db) => {
    const r = await createOpportunityInTx(db, actor, input, { via: actor.kind === "agent" ? "agent" : actor.kind === "api" ? "api" : "manual", idempotencyKey: opts.idempotencyKey });
    if (r.created) await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.opportunity_created", targetType: "crm_opportunity", targetId: r.id, result: "success" }, db);
    return { id: r.id };
  });
}

async function setOpportunityTagsInTx(db: Queryable, actor: CrmActor, id: string, tagIds: string[]) {
  const ok = await db.query<{ n: string }>("select count(*)::text as n from crm_tags where org_id = $1 and id = any($2::uuid[])", [actor.orgId, tagIds]);
  if (Number(ok.rows[0].n) !== new Set(tagIds).size) throw new AppError("not_found", "One of these tags no longer exists.");
  await db.query("insert into crm_opportunity_tags (org_id, opportunity_id, tag_id, added_by) select $1, $2, t, $4 from unnest($3::uuid[]) t on conflict do nothing", [actor.orgId, id, tagIds, actor.userId]);
}

export async function setOpportunityTags(actor: CrmActor, id: string, input: { add?: string[]; remove?: string[] }): Promise<void> {
  assertCan(actor, "opportunities.edit");
  await crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "opportunities");
    const o = await db.query("select 1 from crm_opportunities where id = $1 and org_id = $2 and provider = 'native' and archived_at is null", [id, actor.orgId]);
    if (!o.rows.length) throw new AppError("not_found", "Deal not found.");
    if (input.add?.length) await setOpportunityTagsInTx(db, actor, id, input.add);
    if (input.remove?.length) await db.query("delete from crm_opportunity_tags where org_id = $1 and opportunity_id = $2 and tag_id = any($3::uuid[])", [actor.orgId, id, input.remove]);
  });
}

// ---------------------------------------------------------------------------
// Moving between stages
// ---------------------------------------------------------------------------

export interface MoveResult {
  changed: boolean;
  status: OpportunityStatus;
  stageId: string;
  version: number;
}

/**
 * Moves a deal to a stage, transactionally. Reaching a won or lost stage closes it with that outcome (a lost deal needs a reason); moving a
 * closed deal back to an open stage reopens it, which needs the reopen permission. Moving to the stage it is already in changes nothing and
 * records no event, so a double drop or a retried request can never trigger an automation twice.
 */
export async function moveOpportunity(actor: CrmActor, id: string, input: { stageId: string; lostReason?: string | null; expectedVersion?: number }, causedBy?: { eventId: number; depth: number } | null): Promise<MoveResult> {
  assertCan(actor, "opportunities.edit");
  return crmWrite(actor, (db) => moveOpportunityInTx(db, actor, id, input, causedBy));
}

export async function moveOpportunityInTx(db: Queryable, actor: CrmActor, id: string, input: { stageId: string; lostReason?: string | null; expectedVersion?: number }, causedBy?: { eventId: number; depth: number } | null): Promise<MoveResult> {
  await assertNativeOwner(db, actor.orgId, "opportunities");
  const { rows } = await db.query<{ id: string; status: OpportunityStatus; stage_ref: string; pipeline_ref: string; version: number; stage_entered_at: Date; contact_id: string | null; company_id: string | null; name: string; monetary_value: string | null; currency: string }>(
    "select id, status, stage_ref, pipeline_ref, version, stage_entered_at, contact_id, company_id, name, monetary_value::text, currency from crm_opportunities where id = $1 and org_id = $2 and provider = 'native' and archived_at is null for update",
    [id, actor.orgId],
  );
  const o = rows[0];
  if (!o) throw new AppError("not_found", "Deal not found.");
  if (input.expectedVersion !== undefined && o.version !== input.expectedVersion) throw new AppError("conflict", "Someone else moved or changed this deal. Refresh the board and try again.");
  if (o.stage_ref === input.stageId) return { changed: false, status: o.status, stageId: o.stage_ref, version: o.version };
  const stage = await db.query<{ id: string; kind: StageKind; name: string; pipeline_id: string }>("select id, kind, name, pipeline_id from crm_pipeline_stages where id = $1 and org_id = $2 and archived_at is null", [input.stageId, actor.orgId]);
  const s = stage.rows[0];
  if (!s) throw new AppError("not_found", "Stage not found.");
  const pipe = await db.query("select 1 from crm_pipelines where id = $1 and org_id = $2 and archived_at is null", [s.pipeline_id, actor.orgId]);
  if (!pipe.rows.length) throw new AppError("not_found", "That pipeline is archived.");
  const toStatus: OpportunityStatus = s.kind === "won" ? "won" : s.kind === "lost" ? "lost" : "open";
  if (o.status !== "open" && toStatus === "open") assertCan(actor, "opportunities.reopen", "Reopening a closed deal needs the reopen permission.");
  const lostReason = input.lostReason?.trim().slice(0, 300) || null;
  if (toStatus === "lost" && (!lostReason || lostReason.length < 3)) throw new AppError("invalid_input", "Say why this deal was lost (at least a few words).");
  const upd = await db.query<{ version: number }>(
    `update crm_opportunities set stage_ref = $3, pipeline_ref = $4, stage_name = $5, status = $6, stage_entered_at = now(),
       closed_at = case when $6 = 'open' then null when status = 'open' then now() else closed_at end,
       lost_reason = case when $6 = 'lost' then $7 when $6 = 'open' then null else lost_reason end, version = version + 1
     where id = $1 and org_id = $2 returning version`,
    [id, actor.orgId, s.id, s.pipeline_id, s.name, toStatus, lostReason],
  );
  const historyId = await addHistory(db, actor, { opportunityId: id, fromStage: o.stage_ref, toStage: s.id, fromStatus: o.status, toStatus, since: o.stage_entered_at });
  const ev = await emitEvent(db, actor, {
    type: "opportunity.stage_changed", entityType: "opportunity", entityId: id, contactId: o.contact_id,
    payload: { fromStageId: o.stage_ref, toStageId: s.id, toStageName: s.name, pipelineId: s.pipeline_id, fromStatus: o.status, toStatus }, dedupeKey: `opportunity.stage_changed:${id}:${historyId}`, causedBy,
  });
  if (toStatus !== o.status) {
    const type = toStatus === "won" ? "opportunity.won" : toStatus === "lost" ? "opportunity.lost" : "opportunity.reopened";
    await emitEvent(db, actor, { type, entityType: "opportunity", entityId: id, contactId: o.contact_id, payload: { value: o.monetary_value === null ? null : Number(o.monetary_value), currency: o.currency, lostReason }, dedupeKey: `${type}:${id}:${historyId}`, causedBy: ev.id ? { eventId: ev.id, depth: causedBy ? causedBy.depth + 1 : 0 } : causedBy });
  }
  const summary = toStatus === "won" ? `Deal won: ${o.name}` : toStatus === "lost" ? `Deal lost: ${o.name}` : o.status !== "open" ? `Deal reopened in ${s.name}` : `Moved to ${s.name}`;
  await recordActivity(db, actor, { kind: toStatus === "open" ? (o.status === "open" ? "opportunity.moved" : "opportunity.reopened") : `opportunity.${toStatus}`, summary, opportunityId: id, contactId: o.contact_id, companyId: o.company_id });
  return { changed: true, status: toStatus, stageId: s.id, version: upd.rows[0].version };
}

/** Closes a deal as won or lost: it moves to the pipeline's Won or Lost stage when there is one; otherwise it keeps its stage. */
export async function closeOpportunity(actor: CrmActor, id: string, outcome: "won" | "lost", input: { lostReason?: string | null } = {}): Promise<MoveResult> {
  assertCan(actor, "opportunities.edit");
  return crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "opportunities");
    const o = await db.query<{ pipeline_ref: string; status: OpportunityStatus; stage_ref: string; version: number; stage_entered_at: Date; contact_id: string | null; company_id: string | null; name: string }>(
      "select pipeline_ref, status, stage_ref, version, stage_entered_at, contact_id, company_id, name from crm_opportunities where id = $1 and org_id = $2 and provider = 'native' and archived_at is null for update",
      [id, actor.orgId],
    );
    if (!o.rows[0]) throw new AppError("not_found", "Deal not found.");
    if (o.rows[0].status === outcome) return { changed: false, status: outcome, stageId: o.rows[0].stage_ref, version: o.rows[0].version };
    if (o.rows[0].status !== "open") assertCan(actor, "opportunities.reopen", "Changing the outcome of a closed deal needs the reopen permission.");
    const target = await db.query<{ id: string }>("select id from crm_pipeline_stages where org_id = $1 and pipeline_id = $2 and kind = $3 and archived_at is null limit 1", [actor.orgId, o.rows[0].pipeline_ref, outcome]);
    if (target.rows[0]) return moveOpportunityInTx(db, actor, id, { stageId: target.rows[0].id, lostReason: input.lostReason });
    const lostReason = input.lostReason?.trim().slice(0, 300) || null;
    if (outcome === "lost" && (!lostReason || lostReason.length < 3)) throw new AppError("invalid_input", "Say why this deal was lost (at least a few words).");
    const upd = await db.query<{ version: number }>(
      "update crm_opportunities set status = $3, closed_at = now(), lost_reason = case when $3 = 'lost' then $4 else lost_reason end, version = version + 1 where id = $1 and org_id = $2 returning version",
      [id, actor.orgId, outcome, lostReason],
    );
    const historyId = await addHistory(db, actor, { opportunityId: id, fromStage: o.rows[0].stage_ref, toStage: o.rows[0].stage_ref, fromStatus: o.rows[0].status, toStatus: outcome, since: o.rows[0].stage_entered_at });
    await emitEvent(db, actor, { type: `opportunity.${outcome}`, entityType: "opportunity", entityId: id, contactId: o.rows[0].contact_id, payload: { lostReason }, dedupeKey: `opportunity.${outcome}:${id}:${historyId}` });
    await recordActivity(db, actor, { kind: `opportunity.${outcome}`, summary: outcome === "won" ? `Deal won: ${o.rows[0].name}` : `Deal lost: ${o.rows[0].name}`, opportunityId: id, contactId: o.rows[0].contact_id, companyId: o.rows[0].company_id });
    return { changed: true, status: outcome, stageId: o.rows[0].stage_ref, version: upd.rows[0].version };
  });
}

export async function reopenOpportunity(actor: CrmActor, id: string, stageId?: string | null): Promise<MoveResult> {
  assertCan(actor, "opportunities.reopen", "Reopening a closed deal needs the reopen permission.");
  return crmWrite(actor, async (db) => {
    const o = await db.query<{ pipeline_ref: string; status: OpportunityStatus }>("select pipeline_ref, status from crm_opportunities where id = $1 and org_id = $2 and provider = 'native' and archived_at is null", [id, actor.orgId]);
    if (!o.rows[0]) throw new AppError("not_found", "Deal not found.");
    if (o.rows[0].status === "open") throw new AppError("conflict", "This deal is already open.");
    const target = stageId
      ? await resolveStage(db, actor.orgId, o.rows[0].pipeline_ref, stageId)
      : (await db.query<{ id: string; kind: StageKind }>("select id, kind from crm_pipeline_stages where org_id = $1 and pipeline_id = $2 and kind = 'open' and archived_at is null order by position desc limit 1", [actor.orgId, o.rows[0].pipeline_ref])).rows[0];
    if (!target || target.kind !== "open") throw new AppError("invalid_input", "Choose an open stage to reopen the deal in.");
    const cur = await db.query<{ stage_ref: string }>("select stage_ref from crm_opportunities where id = $1", [id]);
    if (cur.rows[0].stage_ref === target.id) {
      // Closed without moving (no Won/Lost stage): reopen in place.
      await db.query("update crm_opportunities set status = 'open', closed_at = null, lost_reason = null, version = version + 1 where id = $1 and org_id = $2", [id, actor.orgId]);
      await addHistory(db, actor, { opportunityId: id, fromStage: target.id, toStage: target.id, fromStatus: o.rows[0].status, toStatus: "open", since: null });
      await emitEvent(db, actor, { type: "opportunity.reopened", entityType: "opportunity", entityId: id, dedupeKey: `opportunity.reopened:${id}:${Date.now()}` });
      const v = await db.query<{ version: number }>("select version from crm_opportunities where id = $1", [id]);
      return { changed: true, status: "open" as const, stageId: target.id, version: v.rows[0].version };
    }
    return moveOpportunityInTx(db, actor, id, { stageId: target.id });
  });
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

export async function updateOpportunity(actor: CrmActor, id: string, patch: Partial<Omit<OpportunityInput, "pipelineId" | "stageId" | "tagIds">>, expectedVersion?: number): Promise<{ version: number }> {
  assertCan(actor, "opportunities.edit");
  return crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "opportunities");
    const { rows } = await db.query<{ version: number; assigned_user_id: string | null; name: string; contact_id: string | null; company_id: string | null; monetary_value: string | null }>(
      "select version, assigned_user_id, name, contact_id, company_id, monetary_value::text from crm_opportunities where id = $1 and org_id = $2 and provider = 'native' and archived_at is null for update",
      [id, actor.orgId],
    );
    const o = rows[0];
    if (!o) throw new AppError("not_found", "Deal not found.");
    if (expectedVersion !== undefined && o.version !== expectedVersion) throw new AppError("conflict", "Someone else changed this deal while you were editing. Reload and try again.");
    if ("ownerId" in patch && patch.ownerId !== o.assigned_user_id) {
      if (patch.ownerId !== actor.userId) assertCan(actor, "contacts.assign", "Assigning deals to someone else needs the assign permission.");
      if (patch.ownerId) await assertAssignable(db, actor.orgId, patch.ownerId);
    }
    await assertContactAndCompany(db, actor.orgId, patch.contactId, patch.companyId);
    const name = patch.name !== undefined ? patch.name.replace(/\s+/g, " ").trim() : o.name;
    if (!name || name.length > 200) throw new AppError("invalid_input", "Give the deal a name of up to 200 characters.");
    const currency = patch.currency !== undefined && patch.currency !== null ? patch.currency.toUpperCase() : null;
    if (currency && !/^[A-Z]{3}$/.test(currency)) throw new AppError("invalid_input", "Use a three-letter currency code.");
    if (patch.probability !== undefined && patch.probability !== null && (!Number.isInteger(patch.probability) || patch.probability < 0 || patch.probability > 100)) throw new AppError("invalid_input", "Probability is a whole number from 0 to 100.");
    const contactLabel = patch.contactId ? (await db.query<{ n: string }>("select display_name as n from contacts where id = $1", [patch.contactId])).rows[0]?.n ?? null : null;
    const res = await db.query<{ version: number }>(
      `update crm_opportunities set name = $3,
         monetary_value = case when $4::boolean then $5::numeric else monetary_value end,
         currency = coalesce($6, currency),
         assigned_user_id = case when $7::boolean then $8::uuid else assigned_user_id end,
         expected_close_date = case when $9::boolean then $10::date else expected_close_date end,
         source = case when $11::boolean then $12 else source end,
         probability = case when $13::boolean then $14::int else probability end,
         description = case when $15::boolean then $16 else description end,
         contact_id = case when $17::boolean then $18::uuid else contact_id end,
         contact_label = case when $17::boolean then $19 else contact_label end,
         company_id = case when $20::boolean then $21::uuid else company_id end,
         version = version + 1
       where id = $1 and org_id = $2 returning version`,
      [
        id, actor.orgId, name, "value" in patch, checkValue(patch.value), currency, "ownerId" in patch, patch.ownerId ?? null,
        "expectedCloseDate" in patch, checkDate(patch.expectedCloseDate), "source" in patch, patch.source?.trim().slice(0, 120) || null,
        "probability" in patch, patch.probability ?? null, "description" in patch, patch.description?.trim().slice(0, 2000) || null,
        "contactId" in patch, patch.contactId ?? null, contactLabel, "companyId" in patch, patch.companyId ?? null,
      ],
    );
    if (patch.customFields && Object.keys(patch.customFields).length) await writeFieldValues(db, actor, "opportunity", id, patch.customFields, { enforceRequired: true });
    const changed = Object.keys(patch);
    await emitEvent(db, actor, { type: "opportunity.updated", entityType: "opportunity", entityId: id, contactId: patch.contactId ?? o.contact_id, payload: { changed }, dedupeKey: `opportunity.updated:${id}:v${res.rows[0].version}` });
    if ("ownerId" in patch && patch.ownerId !== o.assigned_user_id) {
      await recordActivity(db, actor, { kind: "opportunity.assigned", summary: patch.ownerId ? "Deal owner changed" : "Deal unassigned", opportunityId: id, contactId: o.contact_id });
      if (patch.ownerId && patch.ownerId !== actor.userId) await notifyUser(db, patch.ownerId, actor.orgId, { kind: "crm_assigned", severity: "info", title: `Deal assigned to you: ${name}`, link: `/crm/opportunities/${id}`, dedupeKey: `crm-opp-assigned:${id}:${patch.ownerId}:${res.rows[0].version}` });
    } else if ("value" in patch && String(checkValue(patch.value)) !== String(o.monetary_value === null ? null : Number(o.monetary_value))) {
      await recordActivity(db, actor, { kind: "opportunity.value_changed", summary: "Deal value changed", opportunityId: id, contactId: o.contact_id });
    }
    return { version: res.rows[0].version };
  });
}

export async function archiveOpportunities(actor: CrmActor, ids: string[]): Promise<{ changed: number }> {
  assertCan(actor, "opportunities.delete");
  return crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "opportunities");
    const res = await db.query<{ id: string }>("update crm_opportunities set archived_at = now(), version = version + 1 where org_id = $1 and id = any($2::uuid[]) and provider = 'native' and archived_at is null returning id", [actor.orgId, ids.slice(0, 2000)]);
    for (const r of res.rows) await emitEvent(db, actor, { type: "opportunity.archived", entityType: "opportunity", entityId: r.id, dedupeKey: `opportunity.archived:${r.id}` });
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.opportunities_archived", targetType: "crm_opportunity", targetId: ids.length === 1 ? ids[0] : `${ids.length} deals`, result: "success", metadata: { changed: res.rows.length } }, db);
    return { changed: res.rows.length };
  });
}

/** Moves or reassigns several deals at once. Each one is moved through the same transactional rules as a single drag. */
export async function bulkMoveOpportunities(actor: CrmActor, ids: string[], stageId: string): Promise<{ changed: number }> {
  assertCan(actor, "opportunities.edit");
  if (ids.length > 1) assertCan(actor, "contacts.bulk", "Changing many deals at once needs the bulk-edit permission.");
  return crmWrite(actor, async (db) => {
    let changed = 0;
    for (const id of ids.slice(0, 500)) if ((await moveOpportunityInTx(db, actor, id, { stageId })).changed) changed++;
    return { changed };
  });
}

// ---------------------------------------------------------------------------
// Reading: board, table, detail
// ---------------------------------------------------------------------------

export interface OpportunityCard {
  id: string;
  name: string;
  status: OpportunityStatus;
  stageId: string;
  pipelineId: string;
  value: number | null;
  currency: string;
  contact: { id: string; name: string } | null;
  company: { id: string; name: string } | null;
  owner: { id: string; name: string } | null;
  expectedCloseDate: string | null;
  stageEnteredAt: string;
  daysInStage: number;
  tags: Array<{ id: string; name: string; color: string }>;
  version: number;
  openTasks: number;
}

type CardRow = {
  id: string; name: string; status: OpportunityStatus; stage_ref: string; pipeline_ref: string; monetary_value: string | null; currency: string; contact_id: string | null; contact_name: string | null;
  company_id: string | null; company_name: string | null; assigned_user_id: string | null; owner_name: string | null; expected_close_date: string | null; stage_entered_at: Date; version: number; open_tasks: string;
};

const CARD_SELECT = `
  select o.id, o.name, o.status, o.stage_ref, o.pipeline_ref, o.monetary_value::text, o.currency, o.contact_id, c.display_name as contact_name, o.company_id, co.name as company_name,
         o.assigned_user_id, nullif(u.full_name, '') as owner_name, o.expected_close_date::text, o.stage_entered_at, o.version,
         (select count(*) from tasks t where t.org_id = o.org_id and t.opportunity_id = o.id and t.status in ('open', 'in_progress'))::text as open_tasks
  from crm_opportunities o
  left join contacts c on c.id = o.contact_id and c.deleted_at is null
  left join crm_companies co on co.id = o.company_id and co.deleted_at is null
  left join users u on u.id = o.assigned_user_id`;

async function toCards(db: Queryable, orgId: string, rows: CardRow[]): Promise<OpportunityCard[]> {
  const ids = rows.map((r) => r.id);
  const tags = ids.length
    ? await db.query<{ opportunity_id: string; id: string; name: string; color: string }>("select ot.opportunity_id, t.id, t.name::text as name, t.color from crm_opportunity_tags ot join crm_tags t on t.id = ot.tag_id where ot.org_id = $1 and ot.opportunity_id = any($2::uuid[])", [orgId, ids])
    : { rows: [] };
  const byOpp = new Map<string, OpportunityCard["tags"]>();
  for (const t of tags.rows) byOpp.set(t.opportunity_id, [...(byOpp.get(t.opportunity_id) ?? []), { id: t.id, name: t.name, color: t.color }]);
  return rows.map((r) => ({
    id: r.id, name: r.name, status: r.status, stageId: r.stage_ref, pipelineId: r.pipeline_ref, value: r.monetary_value === null ? null : Number(r.monetary_value), currency: r.currency,
    contact: r.contact_id && r.contact_name !== null ? { id: r.contact_id, name: r.contact_name || "Unnamed contact" } : null,
    company: r.company_id && r.company_name ? { id: r.company_id, name: r.company_name } : null,
    owner: r.assigned_user_id ? { id: r.assigned_user_id, name: r.owner_name ?? "Teammate" } : null,
    expectedCloseDate: r.expected_close_date, stageEnteredAt: new Date(r.stage_entered_at).toISOString(), daysInStage: Math.floor((Date.now() - new Date(r.stage_entered_at).getTime()) / 86_400_000),
    tags: byOpp.get(r.id) ?? [], version: r.version, openTasks: Number(r.open_tasks),
  }));
}

export interface BoardColumn {
  stage: { id: string; name: string; kind: StageKind; probability: number | null; color: string | null };
  cards: OpportunityCard[];
  count: number;
  totals: Array<{ currency: string; value: number }>;
  truncated: boolean;
}

/** The Kanban board for one pipeline. Closed columns only show deals closed in the last 30 days by default, so the board stays quick. */
export async function getBoard(actor: CrmActor, pipelineId: string, opts: { search?: string; ownerId?: string | null; mine?: boolean; closedDays?: number } = {}): Promise<BoardColumn[]> {
  assertCan(actor, "sales.view");
  return crmRead(actor, async (db) => {
    const stages = await db.query<{ id: string; name: string; kind: StageKind; probability: number | null; color: string | null }>(
      "select s.id, s.name, s.kind, s.probability, s.color from crm_pipeline_stages s join crm_pipelines p on p.id = s.pipeline_id and p.archived_at is null where s.org_id = $1 and s.pipeline_id = $2 and s.archived_at is null order by s.position",
      [actor.orgId, pipelineId],
    );
    if (!stages.rows.length) throw new AppError("not_found", "Pipeline not found.");
    const params: unknown[] = [actor.orgId, pipelineId];
    const where = ["o.org_id = $1", "o.pipeline_ref = $2", "o.provider = 'native'", "o.archived_at is null"];
    params.push(Math.max(1, Math.min(3650, opts.closedDays ?? 30)));
    where.push(`(o.status = 'open' or o.closed_at > now() - make_interval(days => $${params.length}))`);
    if (opts.mine && actor.userId) {
      params.push(actor.userId);
      where.push(`o.assigned_user_id = $${params.length}`);
    } else if (opts.ownerId) {
      params.push(opts.ownerId);
      where.push(`o.assigned_user_id = $${params.length}`);
    }
    const term = opts.search?.trim().toLowerCase().slice(0, 80);
    if (term) {
      params.push(`%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
      where.push(`(lower(o.name) like $${params.length} escape '\\' or lower(coalesce(c.display_name, '')) like $${params.length} escape '\\' or lower(coalesce(co.name, '')) like $${params.length} escape '\\')`);
    }
    const counts = await db.query<{ stage_ref: string; currency: string; n: string; total: string | null }>(
      `select o.stage_ref, o.currency, count(*)::text as n, sum(o.monetary_value)::text as total from crm_opportunities o
       left join contacts c on c.id = o.contact_id left join crm_companies co on co.id = o.company_id where ${where.join(" and ")} group by 1, 2`,
      params,
    );
    const { rows } = await db.query<CardRow & { rn: string }>(
      `select * from (${CARD_SELECT} where ${where.join(" and ")}) x order by x.stage_entered_at desc limit 2000`,
      params,
    );
    const cards = await toCards(db, actor.orgId, rows);
    return stages.rows.map((s) => {
      const stageCards = cards.filter((c) => c.stageId === s.id);
      const stageCounts = counts.rows.filter((c) => c.stage_ref === s.id);
      const count = stageCounts.reduce((acc, c) => acc + Number(c.n), 0);
      return {
        stage: s,
        cards: stageCards.slice(0, 200),
        count,
        totals: stageCounts.filter((c) => c.total !== null).map((c) => ({ currency: c.currency, value: Number(c.total) })),
        truncated: count > Math.min(200, stageCards.length),
      };
    });
  });
}

export interface OpportunityQuery {
  pipelineId?: string | null;
  stageId?: string | null;
  status?: OpportunityStatus | "all";
  ownerId?: string | null;
  contactId?: string | null;
  companyId?: string | null;
  search?: string;
  sort?: { by?: "name" | "value" | "created_at" | "updated_at" | "expected_close_date" | "stage_entered_at"; dir?: "asc" | "desc" };
  page?: number;
  pageSize?: number;
}

export async function listOpportunities(actor: CrmActor, q: OpportunityQuery = {}): Promise<{ rows: Array<OpportunityCard & { pipelineName: string; stageName: string; createdAt: string; updatedAt: string; closedAt: string | null; lostReason: string | null }>; total: number; page: number; pageSize: number }> {
  assertCan(actor, "sales.view");
  const pageSize = Math.min(100, Math.max(1, q.pageSize ?? 25));
  const page = Math.max(1, q.page ?? 1);
  return crmRead(actor, async (db) => {
    const params: unknown[] = [actor.orgId];
    const where = ["o.org_id = $1", "o.provider = 'native'", "o.archived_at is null"];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace("?", `$${params.length}`));
    };
    if (q.pipelineId) add("o.pipeline_ref = ?", q.pipelineId);
    if (q.stageId) add("o.stage_ref = ?", q.stageId);
    if (q.status && q.status !== "all") add("o.status = ?", q.status);
    if (q.ownerId) add("o.assigned_user_id = ?", q.ownerId);
    if (q.contactId) add("o.contact_id = ?", q.contactId);
    if (q.companyId) add("o.company_id = ?", q.companyId);
    const term = q.search?.trim().toLowerCase().slice(0, 80);
    if (term) {
      params.push(`%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
      const n = `$${params.length}`;
      where.push(`(lower(o.name) like ${n} escape '\\' or exists (select 1 from contacts c2 where c2.id = o.contact_id and c2.deleted_at is null and lower(c2.display_name) like ${n} escape '\\') or exists (select 1 from crm_companies co2 where co2.id = o.company_id and co2.deleted_at is null and lower(co2.name) like ${n} escape '\\'))`);
    }
    const order = { name: "lower(o.name)", value: "o.monetary_value", created_at: "o.created_at", updated_at: "o.updated_at", expected_close_date: "o.expected_close_date", stage_entered_at: "o.stage_entered_at" }[q.sort?.by ?? "updated_at"] ?? "o.updated_at";
    const dir = q.sort?.dir === "asc" ? "asc" : "desc";
    const total = Number((await db.query<{ n: string }>(`select count(*)::text as n from crm_opportunities o where ${where.join(" and ")}`, params)).rows[0].n);
    const listSelect = CARD_SELECT.replace("select o.id,", "select o.created_at, o.updated_at, o.closed_at, o.lost_reason, p.name as pipeline_name, s.name as stage_name, o.id,") +
      " join crm_pipelines p on p.id = o.pipeline_ref join crm_pipeline_stages s on s.id = o.stage_ref";
    const { rows } = await db.query<CardRow & { pipeline_name: string; stage_name: string; created_at: Date; updated_at: Date; closed_at: Date | null; lost_reason: string | null }>(
      `${listSelect} where ${where.join(" and ")} order by ${order} ${dir} nulls last, o.id limit ${pageSize} offset ${(page - 1) * pageSize}`,
      params,
    );
    const cards = await toCards(db, actor.orgId, rows);
    return {
      rows: cards.map((c, i) => ({ ...c, pipelineName: rows[i].pipeline_name, stageName: rows[i].stage_name, createdAt: new Date(rows[i].created_at).toISOString(), updatedAt: new Date(rows[i].updated_at).toISOString(), closedAt: rows[i].closed_at ? new Date(rows[i].closed_at!).toISOString() : null, lostReason: rows[i].lost_reason })),
      total,
      page,
      pageSize,
    };
  });
}

export interface OpportunityDetail extends OpportunityCard {
  pipelineName: string;
  stageName: string;
  stageKind: StageKind;
  source: string | null;
  probability: number | null;
  stageProbability: number | null;
  description: string | null;
  lostReason: string | null;
  createdVia: string | null;
  createdAt: string;
  closedAt: string | null;
  fields: RecordFieldValue[];
  history: Array<{ at: string; fromStage: string | null; toStage: string | null; toStatus: OpportunityStatus; actor: string | null; secondsInPrevious: number | null }>;
}

export async function getOpportunityDetail(actor: CrmActor, id: string): Promise<OpportunityDetail> {
  assertCan(actor, "sales.view");
  return crmRead(actor, async (db) => {
    const { rows } = await db.query<CardRow & { pipeline_name: string; stage_name: string; stage_kind: StageKind; source: string | null; probability: number | null; stage_probability: number | null; description: string | null; lost_reason: string | null; created_via: string | null; created_at: Date; closed_at: Date | null }>(
      `select x.*, p.name as pipeline_name, s.name as stage_name, s.kind as stage_kind, s.probability as stage_probability from (
         ${CARD_SELECT.replace("select o.id,", "select o.source, o.probability, o.description, o.lost_reason, o.created_via, o.created_at, o.closed_at, o.id,")}
         where o.id = $1 and o.org_id = $2 and o.provider = 'native' and o.archived_at is null) x
       join crm_pipelines p on p.id = x.pipeline_ref join crm_pipeline_stages s on s.id = x.stage_ref`,
      [id, actor.orgId],
    );
    const r = rows[0];
    if (!r) throw new AppError("not_found", "Deal not found.");
    const [card] = await toCards(db, actor.orgId, [r]);
    const history = await db.query<{ changed_at: Date; from_stage: string | null; to_stage: string | null; to_status: OpportunityStatus; actor: string | null; seconds_in_previous: number | null }>(
      `select h.changed_at, fs.name as from_stage, ts.name as to_stage, h.to_status, nullif(u.full_name, '') as actor, h.seconds_in_previous
       from crm_opportunity_history h left join crm_pipeline_stages fs on fs.id = h.from_stage left join crm_pipeline_stages ts on ts.id = h.to_stage left join users u on u.id = h.actor_user_id
       where h.org_id = $1 and h.opportunity_id = $2 order by h.id desc limit 100`,
      [actor.orgId, id],
    );
    return {
      ...card, pipelineName: r.pipeline_name, stageName: r.stage_name, stageKind: r.stage_kind, source: r.source, probability: r.probability, stageProbability: r.stage_probability,
      description: r.description, lostReason: r.lost_reason, createdVia: r.created_via, createdAt: new Date(r.created_at).toISOString(), closedAt: r.closed_at ? new Date(r.closed_at).toISOString() : null,
      fields: await readFieldValues(db, actor.orgId, "opportunity", id),
      history: history.rows.map((h) => ({ at: new Date(h.changed_at).toISOString(), fromStage: h.from_stage, toStage: h.to_stage, toStatus: h.to_status, actor: h.actor, secondsInPrevious: h.seconds_in_previous })),
    };
  });
}

// ---------------------------------------------------------------------------
// Pipeline metrics, from recorded deals and their history only
// ---------------------------------------------------------------------------

export interface PipelineMetrics {
  byStage: Array<{ stageId: string; name: string; kind: StageKind; count: number; totals: Array<{ currency: string; value: number }>; probability: number | null; avgDaysInStage: number | null }>;
  openValue: Array<{ currency: string; value: number }>;
  /** Only stages with a probability set contribute; deals in other stages are counted separately, never guessed. */
  weightedForecast: Array<{ currency: string; value: number }>;
  dealsWithoutProbability: number;
  wonCount: number;
  lostCount: number;
  wonValue: Array<{ currency: string; value: number }>;
  /** Won ÷ (won + lost) for deals closed in the period, as a percentage with one decimal; null when nothing closed. */
  winRate: number | null;
  createdCount: number;
  period: { from: string; to: string };
}

export async function getPipelineMetrics(actor: CrmActor, pipelineId: string, period: { from?: Date; to?: Date } = {}): Promise<PipelineMetrics> {
  assertCan(actor, "sales.view");
  const to = period.to ?? new Date();
  const from = period.from ?? new Date(to.getTime() - 90 * 86_400_000);
  return crmRead(actor, async (db) => {
    const stages = await db.query<{ id: string; name: string; kind: StageKind; probability: number | null }>("select id, name, kind, probability from crm_pipeline_stages where org_id = $1 and pipeline_id = $2 and archived_at is null order by position", [actor.orgId, pipelineId]);
    if (!stages.rows.length) throw new AppError("not_found", "Pipeline not found.");
    const open = await db.query<{ stage_ref: string; currency: string; n: string; total: string | null }>(
      "select stage_ref, currency, count(*)::text as n, sum(monetary_value)::text as total from crm_opportunities where org_id = $1 and pipeline_ref = $2 and provider = 'native' and archived_at is null and status = 'open' group by 1, 2",
      [actor.orgId, pipelineId],
    );
    // Average time deals spent in each stage before leaving it, from recorded moves within the period.
    const aging = await db.query<{ stage: string; avg: string | null }>(
      "select from_stage as stage, avg(seconds_in_previous)::text as avg from crm_opportunity_history where org_id = $1 and from_stage is not null and seconds_in_previous is not null and changed_at between $2 and $3 and opportunity_id in (select id from crm_opportunities where org_id = $1 and pipeline_ref = $4) group by 1",
      [actor.orgId, from, to, pipelineId],
    );
    const closed = await db.query<{ status: OpportunityStatus; currency: string; n: string; total: string | null }>(
      "select status, currency, count(*)::text as n, sum(monetary_value)::text as total from crm_opportunities where org_id = $1 and pipeline_ref = $2 and provider = 'native' and archived_at is null and status in ('won', 'lost') and closed_at between $3 and $4 group by 1, 2",
      [actor.orgId, pipelineId, from, to],
    );
    const created = await db.query<{ n: string }>("select count(*)::text as n from crm_opportunities where org_id = $1 and pipeline_ref = $2 and provider = 'native' and created_at between $3 and $4", [actor.orgId, pipelineId, from, to]);
    const sumBy = (rows: Array<{ currency: string; total: string | null }>) => {
      const m = new Map<string, number>();
      for (const r of rows) if (r.total !== null) m.set(r.currency, (m.get(r.currency) ?? 0) + Number(r.total));
      return [...m.entries()].map(([currency, value]) => ({ currency, value: Math.round(value * 100) / 100 }));
    };
    const weighted = new Map<string, number>();
    let without = 0;
    for (const r of open.rows) {
      const s = stages.rows.find((x) => x.id === r.stage_ref);
      if (s?.probability === null || s?.probability === undefined) {
        without += Number(r.n);
        continue;
      }
      if (r.total !== null) weighted.set(r.currency, (weighted.get(r.currency) ?? 0) + (Number(r.total) * s.probability) / 100);
    }
    const won = closed.rows.filter((r) => r.status === "won");
    const lost = closed.rows.filter((r) => r.status === "lost");
    const wonCount = won.reduce((n, r) => n + Number(r.n), 0);
    const lostCount = lost.reduce((n, r) => n + Number(r.n), 0);
    return {
      byStage: stages.rows.map((s) => {
        const rows = open.rows.filter((r) => r.stage_ref === s.id);
        const avg = aging.rows.find((a) => a.stage === s.id)?.avg;
        return { stageId: s.id, name: s.name, kind: s.kind, count: rows.reduce((n, r) => n + Number(r.n), 0), totals: sumBy(rows), probability: s.probability, avgDaysInStage: avg ? Math.round((Number(avg) / 86400) * 10) / 10 : null };
      }),
      openValue: sumBy(open.rows),
      weightedForecast: [...weighted.entries()].map(([currency, value]) => ({ currency, value: Math.round(value * 100) / 100 })),
      dealsWithoutProbability: without,
      wonCount,
      lostCount,
      wonValue: sumBy(won),
      winRate: wonCount + lostCount ? Math.round((wonCount / (wonCount + lostCount)) * 1000) / 10 : null,
      createdCount: Number(created.rows[0].n),
      period: { from: from.toISOString(), to: to.toISOString() },
    };
  });
}
