import "server-only";
import crypto from "node:crypto";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { slugify } from "@/server/calendars/setup";
import { templateContentHash } from "@/server/crm/message-templates";
import { readDraft } from "@/lib/crm/forms/spec";
import { tokensUsed } from "@/lib/messaging/tokens";
import type { AssetType, NativeTypeMap } from "@/lib/crm/blueprints/types";
import type { CreateOptions, NativeEntry, WriteContext } from "@/server/crm/blueprints/native-io/types";

// Writers: one create, update and delete per asset type, as careful SQL that keeps every rule the CRM's own services keep (the services
// themselves open their own transactions, which can't nest inside an apply). The apply engine has already checked identities, names,
// limits and compatibility under the workspace lock; these functions only write, and the database constraints remain the last guard.
//
// What a Blueprint never sets: a calendar's status (always draft here), booking page, default flag and hosts; whether an existing
// appointment type is offered for online booking; a template's approval or kind; a form's or workflow's published version and status; a
// Smart List's privacy (always shared with the team); an assignment rule's members on update (people are the workspace's own).

const json = (v: unknown) => JSON.stringify(v);

async function nextPosition(db: Queryable, sql: string, params: unknown[]): Promise<number> {
  const { rows } = await db.query<{ n: number }>(sql, params);
  return Number(rows[0]?.n ?? 1);
}

/** A slug free among the calendar's (or the workspace's) records that aren't archived. */
async function freeSlug(db: Queryable, base: string, taken: (slug: string) => Promise<boolean>): Promise<string> {
  let slug = base;
  for (let i = 2; await taken(slug); i++) {
    slug = `${base.slice(0, 44).replace(/-+$/, "")}-${i}`;
    if (i > 500) return `${base.slice(0, 40)}-${crypto.randomBytes(3).toString("hex")}`;
  }
  return slug;
}

/** What a template version stores for its wording (the same as the template service: channel, subject and body separated in the hash). */
export function templateContent(r: NativeTypeMap["messageTemplate"]) {
  const body = r.body.replace(/\r\n?/g, "\n");
  const subject = r.channel === "email" && r.kind === "template" ? (r.subject ?? "").replace(/\r\n?/g, "\n").trim() : null;
  return { subject, body, hash: templateContentHash(r.channel, subject, body), tokens: tokensUsed(subject, body).slice(0, 40) };
}

/** Where a new stage goes in an existing pipeline: an open stage after the last open one, a won or lost stage at the end. */
async function stagePosition(db: Queryable, orgId: string, pipelineId: string, kind: string, wanted?: number): Promise<number> {
  const { rows } = await db.query<{ id: string; kind: string; position: number }>(
    "select id, kind, position from crm_pipeline_stages where org_id = $1 and pipeline_id = $2 and archived_at is null order by position for update",
    [orgId, pipelineId],
  );
  const position = wanted ?? (kind === "open" ? (rows.filter((s) => s.kind === "open").at(-1)?.position ?? 0) + 1 : (rows.at(-1)?.position ?? 0) + 1);
  // Two passes so positions never collide (the same as reordering stages by hand).
  const after = rows.filter((s) => s.position >= position);
  for (const s of after) await db.query("update crm_pipeline_stages set position = $3 where id = $1 and org_id = $2", [s.id, orgId, 10_000 + s.position]);
  for (const s of after) await db.query("update crm_pipeline_stages set position = $3 where id = $1 and org_id = $2", [s.id, orgId, s.position + 1]);
  return position;
}

async function renumberStages(db: Queryable, orgId: string, pipelineId: string) {
  const { rows } = await db.query<{ id: string }>("select id from crm_pipeline_stages where org_id = $1 and pipeline_id = $2 and archived_at is null order by position for update", [orgId, pipelineId]);
  for (const [i, s] of rows.entries()) await db.query("update crm_pipeline_stages set position = $3 where id = $1 and org_id = $2", [s.id, orgId, 10_000 + i]);
  for (const [i, s] of rows.entries()) await db.query("update crm_pipeline_stages set position = $3 where id = $1 and org_id = $2", [s.id, orgId, i + 1]);
}

/** Inserts the workspace record for one asset and returns its ID. */
export async function createRecord<T extends AssetType>(ctx: WriteContext, type: T, record: NativeTypeMap[T], opts: CreateOptions = {}): Promise<string> {
  const { db, orgId, userId } = ctx;
  const id = async (sql: string, params: unknown[]) => (await db.query<{ id: string }>(sql, params)).rows[0].id;
  switch (type) {
    case "folder": {
      const r = record as NativeTypeMap["folder"];
      const pos = await nextPosition(db, "select coalesce(max(position), 0) + 1 as n from crm_folders where org_id = $1 and kind = $2", [orgId, r.kind]);
      return id("insert into crm_folders (org_id, kind, name, position, created_by) values ($1, $2, $3, $4, $5) returning id", [orgId, r.kind, r.name, pos, userId]);
    }
    case "tag": {
      const r = record as NativeTypeMap["tag"];
      return id("insert into crm_tags (org_id, name, color, description, folder_id, created_by) values ($1, $2, $3, $4, $5, $6) returning id", [orgId, r.name, r.color, r.description, r.folderId, userId]);
    }
    case "customField": {
      const r = record as NativeTypeMap["customField"];
      const pos = await nextPosition(db, "select coalesce(max(position), 0) + 1 as n from crm_custom_fields where org_id = $1 and entity = $2", [orgId, r.entity]);
      const options = r.type === "select" || r.type === "multiselect" ? r.options : [];
      return id(
        `insert into crm_custom_fields (org_id, entity, key, label, type, options, required, help_text, group_name, position, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
        [orgId, r.entity, r.key, r.label, r.type, json(options), r.required, r.helpText, r.groupName, pos, userId],
      );
    }
    case "customValue": {
      const r = record as NativeTypeMap["customValue"];
      return id(
        "insert into crm_custom_values (org_id, key, label, type, value, group_name, required, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id",
        [orgId, r.key, r.label, r.type, r.value, r.groupName, r.required, userId],
      );
    }
    case "pipeline": {
      const r = record as NativeTypeMap["pipeline"];
      const pos = await nextPosition(db, "select count(*)::int + 1 as n from crm_pipelines where org_id = $1 and provider = 'native' and archived_at is null", [orgId]);
      return id(
        "insert into crm_pipelines (org_id, provider, name, description, is_default, position, created_by) values ($1, 'native', $2, $3, $4, $5, $6) returning id",
        [orgId, r.name, r.description, opts.makeDefault === true, pos, userId],
      );
    }
    case "stage": {
      const r = record as NativeTypeMap["stage"];
      const position = await stagePosition(db, orgId, r.pipelineId, r.kind, opts.position);
      return id(
        "insert into crm_pipeline_stages (org_id, pipeline_id, name, position, kind, probability, color) values ($1, $2, $3, $4, $5, $6, $7) returning id",
        [orgId, r.pipelineId, r.name, position, r.kind, r.probability, r.color],
      );
    }
    case "calendar": {
      const r = record as NativeTypeMap["calendar"];
      const slug = await freeSlug(db, slugify(r.name), async (s) => (await db.query("select 1 from crm_calendars where org_id = $1 and slug = $2 and archived_at is null", [orgId, s])).rows.length > 0);
      // A draft: no booking page, never the default, no hosts. It takes no bookings until it is verified and activated in this workspace.
      return id(
        `insert into crm_calendars (org_id, name, slug, description, assignment, round_robin_mode, color, public, is_default, created_by, booking_intro, status, folder_id, timezone, hours_template, origin)
         values ($1, $2, $3, $4, $5, $6, $7, false, false, $8, $9, 'draft', $10, $11, $12, 'blueprint') returning id`,
        [orgId, r.name, slug, r.description, r.assignment, r.roundRobinMode, r.color, userId, r.bookingIntro, r.folderId, r.timezone, json(r.hoursTemplate)],
      );
    }
    case "appointmentType": {
      const r = record as NativeTypeMap["appointmentType"];
      const slug = await freeSlug(db, slugify(r.name), async (s) => (await db.query("select 1 from crm_appointment_types where calendar_id = $1 and slug = $2 and archived_at is null", [r.calendarId, s])).rows.length > 0);
      const pos = await nextPosition(db, "select coalesce(max(position), 0) + 1 as n from crm_appointment_types where calendar_id = $1", [r.calendarId]);
      return id(
        `insert into crm_appointment_types (org_id, calendar_id, name, slug, description, duration_minutes, slot_interval_minutes, buffer_before_minutes, buffer_after_minutes, min_notice_minutes,
           max_days_ahead, daily_limit, capacity, location_kind, location_detail, meeting_provider, meeting_link, requires_confirmation, public, questions, color, position,
           confirmation_message, allow_customer_changes, change_cutoff_minutes, require_email, require_phone)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27) returning id`,
        [orgId, r.calendarId, r.name, slug, r.description, r.durationMinutes, r.slotIntervalMinutes, r.bufferBeforeMinutes, r.bufferAfterMinutes, r.minNoticeMinutes,
          r.maxDaysAhead, r.dailyLimit, r.capacity, r.locationKind, r.locationDetail, r.meetingProvider, r.meetingLink, r.requiresConfirmation, r.public, json(r.questions), r.color, pos,
          r.confirmationMessage, r.allowCustomerChanges, r.changeCutoffMinutes, r.requireEmail, r.requirePhone],
      );
    }
    case "smartList": {
      const r = record as NativeTypeMap["smartList"];
      return id(
        `insert into crm_smart_lists (org_id, entity, name, description, folder_id, filter, columns, sort, visibility, owner_user_id, is_default)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'team', $9, $10) returning id`,
        [orgId, r.entity, r.name, r.description, r.folderId, json(r.filter), r.columns, json(r.sort ?? {}), ctx.listOwnerId, opts.makeDefault === true],
      );
    }
    case "assignmentRule": {
      const r = record as NativeTypeMap["assignmentRule"];
      // Serialized per workspace and record kind, so positions stay unique (as the assignment service does).
      await db.query("select id from crm_assignment_rules where org_id = $1 and entity = $2 for update", [orgId, r.entity]);
      const pos = await nextPosition(db, "select coalesce(max(position) + 1, 0) as n from crm_assignment_rules where org_id = $1 and entity = $2", [orgId, r.entity]);
      const ruleId = await id(
        `insert into crm_assignment_rules (org_id, name, entity, conditions, strategy, respect_working_hours, fallback, fallback_user_id, position, active, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
        [orgId, r.name, r.entity, json(storedConditions(r)), r.strategy, r.respectWorkingHours, r.fallback, r.fallback === "fallback_user" ? r.fallbackUserId : null, pos, opts.active === true, userId],
      );
      for (const m of r.members) {
        await db.query("insert into crm_assignment_members (org_id, rule_id, user_id, weight, priority) values ($1, $2, $3, $4, $5) on conflict (rule_id, user_id) do nothing", [orgId, ruleId, m.userId, m.weight, m.priority]);
      }
      return ruleId;
    }
    case "form": {
      const r = record as NativeTypeMap["form"];
      return id(
        "insert into crm_forms (org_id, key, name, kind, purpose, folder_id, status, draft, created_by, updated_by) values ($1, $2, $3, $4, $5, $6, 'draft', $7, $8, $8) returning id",
        [orgId, r.key, r.name, r.kind, r.purpose, r.folderId, json(readDraft(r.draft, r.kind)), userId],
      );
    }
    case "messageTemplate": {
      const r = record as NativeTypeMap["messageTemplate"];
      const c = templateContent(r);
      const templateId = await id(
        `insert into crm_message_templates (org_id, kind, key, name, channel, purpose, category, folder_id, status, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'draft', $9) returning id`,
        [orgId, r.kind, r.key, r.name, r.channel, r.kind === "canned_reply" ? "service" : r.purpose, r.category, r.folderId, userId],
      );
      await db.query(
        "insert into crm_message_template_versions (org_id, template_id, version, subject, body, content_hash, tokens, created_by) values ($1, $2, 1, $3, $4, $5, $6, $7)",
        [orgId, templateId, c.subject, c.body, c.hash, c.tokens, userId],
      );
      return templateId;
    }
    case "workflow": {
      const r = record as NativeTypeMap["workflow"];
      // Always a draft: nothing runs until providers are connected, people are mapped and the workspace's owner approves this exact version.
      return id(
        `insert into crm_workflows (org_id, key, name, description, folder_id, status, draft, hourly_run_limit, created_by, updated_by)
         values ($1, $2, $3, $4, $5, 'draft', $6, $7, $8, $8) returning id`,
        [orgId, r.key, r.name, r.description, r.folderId, json({ trigger: r.draft.trigger, steps: r.draft.steps }), r.hourlyRunLimit, userId],
      );
    }
    case "report": {
      const r = record as NativeTypeMap["report"];
      return id(
        "insert into crm_report_definitions (org_id, key, name, description, folder_id, report, config, visibility, owner_user_id) values ($1, $2, $3, $4, $5, $6, $7, 'team', $8) returning id",
        [orgId, r.key, r.name, r.description, r.folderId, r.report, json(r.config), ctx.reportOwnerId],
      );
    }
  }
  throw new AppError("internal", "Unknown asset type.");
}

/** What crm_assignment_rules.conditions stores: the filter, and reassignOwned beside it only when it is on (as the assignment service writes it). */
export function storedConditions(r: NativeTypeMap["assignmentRule"]): Record<string, unknown> {
  const reassign = r.strategy !== "keep_existing_owner" && r.conditions.reassignOwned === true;
  return { op: r.conditions.op, conditions: r.conditions.conditions, ...(reassign ? { reassignOwned: true } : {}) };
}

/**
 * Writes the Blueprint's version of a record over the workspace's one (or a `before` copy back, for a rollback). `archived`, when given,
 * archives or restores a custom field (a field from a Blueprint whose key the workspace archived is restored rather than duplicated).
 */
export async function updateRecord<T extends AssetType>(ctx: WriteContext, entry: NativeEntry<T>, record: NativeTypeMap[T], opts: { archived?: boolean } = {}): Promise<void> {
  const { db, orgId, userId } = ctx;
  const nid = entry.id;
  const run = (sql: string, params: unknown[]) => db.query(sql, [nid, orgId, ...params]);
  switch (entry.type) {
    case "folder": {
      const r = record as NativeTypeMap["folder"];
      await run("update crm_folders set name = $3 where id = $1 and org_id = $2", [r.name]);
      return;
    }
    case "tag": {
      const r = record as NativeTypeMap["tag"];
      await run("update crm_tags set name = $3, color = $4, description = $5, folder_id = $6 where id = $1 and org_id = $2", [r.name, r.color, r.description, r.folderId]);
      return;
    }
    case "customField": {
      const r = record as NativeTypeMap["customField"];
      const options = r.type === "select" || r.type === "multiselect" ? r.options : [];
      const archived = opts.archived === undefined ? "archived_at" : opts.archived ? "coalesce(archived_at, now())" : "null";
      await run(
        `update crm_custom_fields set label = $3, type = $4, options = $5, required = $6, help_text = $7, group_name = $8, archived_at = ${archived} where id = $1 and org_id = $2`,
        [r.label, r.type, json(options), r.required, r.helpText, r.groupName],
      );
      return;
    }
    case "customValue": {
      const r = record as NativeTypeMap["customValue"];
      await run("update crm_custom_values set label = $3, type = $4, value = $5, group_name = $6, required = $7 where id = $1 and org_id = $2", [r.label, r.type, r.value, r.groupName, r.required]);
      return;
    }
    case "pipeline": {
      const r = record as NativeTypeMap["pipeline"];
      // The default pipeline is the workspace's choice: an update never changes it.
      await run("update crm_pipelines set name = $3, description = $4 where id = $1 and org_id = $2 and provider = 'native'", [r.name, r.description]);
      return;
    }
    case "stage": {
      const r = record as NativeTypeMap["stage"];
      await run("update crm_pipeline_stages set name = $3, kind = $4, probability = $5, color = $6 where id = $1 and org_id = $2", [r.name, r.kind, r.probability, r.color]);
      return;
    }
    case "calendar": {
      const r = record as NativeTypeMap["calendar"];
      // Status, booking page, default flag and hosts stay exactly as the workspace has them.
      await run(
        `update crm_calendars set name = $3, description = $4, assignment = $5, round_robin_mode = $6, color = $7, folder_id = $8, booking_intro = $9, timezone = $10, hours_template = $11
         where id = $1 and org_id = $2`,
        [r.name, r.description, r.assignment, r.roundRobinMode, r.color, r.folderId, r.bookingIntro, r.timezone, json(r.hoursTemplate)],
      );
      return;
    }
    case "appointmentType": {
      const r = record as NativeTypeMap["appointmentType"];
      // Whether it is offered for online booking stays the workspace's own (as a calendar's status and booking page do).
      await run(
        `update crm_appointment_types set name = $3, description = $4, duration_minutes = $5, slot_interval_minutes = $6, buffer_before_minutes = $7, buffer_after_minutes = $8,
           min_notice_minutes = $9, max_days_ahead = $10, daily_limit = $11, capacity = $12, location_kind = $13, location_detail = $14, meeting_provider = $15, meeting_link = $16,
           requires_confirmation = $17, questions = $18, color = $19, confirmation_message = $20, allow_customer_changes = $21, change_cutoff_minutes = $22,
           require_email = $23, require_phone = $24 where id = $1 and org_id = $2`,
        [r.name, r.description, r.durationMinutes, r.slotIntervalMinutes, r.bufferBeforeMinutes, r.bufferAfterMinutes, r.minNoticeMinutes, r.maxDaysAhead, r.dailyLimit, r.capacity,
          r.locationKind, r.locationDetail, r.meetingProvider, r.meetingLink, r.requiresConfirmation, json(r.questions), r.color, r.confirmationMessage, r.allowCustomerChanges,
          r.changeCutoffMinutes, r.requireEmail, r.requirePhone],
      );
      return;
    }
    case "smartList": {
      const r = record as NativeTypeMap["smartList"];
      await run("update crm_smart_lists set name = $3, description = $4, folder_id = $5, filter = $6, columns = $7, sort = $8 where id = $1 and org_id = $2", [r.name, r.description, r.folderId, json(r.filter), r.columns, json(r.sort ?? {})]);
      return;
    }
    case "assignmentRule": {
      const r = record as NativeTypeMap["assignmentRule"];
      // Members and whether the rule is on stay the workspace's own.
      await run(
        "update crm_assignment_rules set name = $3, conditions = $4, strategy = $5, respect_working_hours = $6, fallback = $7, fallback_user_id = $8 where id = $1 and org_id = $2",
        [r.name, json(storedConditions(r)), r.strategy, r.respectWorkingHours, r.fallback, r.fallback === "fallback_user" ? r.fallbackUserId : null],
      );
      return;
    }
    case "form": {
      const r = record as NativeTypeMap["form"];
      // The working copy only: what visitors see is the workspace's published version, which only the workspace publishes.
      await run(
        "update crm_forms set name = $3, kind = $4, purpose = $5, folder_id = $6, draft = $7, draft_revision = draft_revision + 1, updated_by = $8 where id = $1 and org_id = $2",
        [r.name, r.kind, r.purpose, r.folderId, json(readDraft(r.draft, r.kind)), userId],
      );
      return;
    }
    case "messageTemplate": {
      const r = record as NativeTypeMap["messageTemplate"];
      const c = templateContent(r);
      const cur = await db.query<{ current_version: number; content_hash: string; status: string; purpose: string; channel: string | null; kind: string }>(
        `select t.current_version, v.content_hash, t.status, t.purpose, t.channel, t.kind from crm_message_templates t
         join crm_message_template_versions v on v.template_id = t.id and v.org_id = t.org_id and v.version = t.current_version where t.id = $1 and t.org_id = $2 for update of t`,
        [nid, orgId],
      );
      const t = cur.rows[0];
      if (!t) throw new AppError("not_found", "Template not found.");
      // The apply engine never plans this (a kind change is a conflict); refused here too, so a mismatch can never be reported as updated.
      if (t.kind !== r.kind) throw new AppError("conflict", t.kind === "canned_reply" ? "It is a canned reply here, so it can't become a message template." : "It is a message template here, so it can't become a canned reply.");
      const purpose = r.kind === "canned_reply" ? "service" : r.purpose;
      const newVersion = c.hash !== t.content_hash;
      const version = newVersion ? t.current_version + 1 : t.current_version;
      if (newVersion) {
        await db.query(
          "insert into crm_message_template_versions (org_id, template_id, version, subject, body, content_hash, tokens, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8)",
          [orgId, nid, version, c.subject, c.body, c.hash, c.tokens, userId],
        );
      }
      // As editing by hand: changed wording or purpose takes an approval back (automated sends only use what a person approved).
      const unapprove = t.status === "approved" && (newVersion || purpose !== t.purpose);
      await run(
        `update crm_message_templates set name = $3, channel = $4, purpose = $5, category = $6, folder_id = $7, current_version = $8,
           whatsapp_template_id = case when $4::text = 'whatsapp' then whatsapp_template_id else null end,
           status = case when $9::boolean then 'draft' else status end, approved_version = case when $9::boolean then null else approved_version end,
           approved_by = case when $9::boolean then null else approved_by end, approved_at = case when $9::boolean then null else approved_at end
         where id = $1 and org_id = $2`,
        [r.name, r.channel, purpose, r.category, r.folderId, version, unapprove],
      );
      return;
    }
    case "workflow": {
      const r = record as NativeTypeMap["workflow"];
      // The working copy only: a published version (and whether it runs) stays exactly as the workspace left it.
      await run(
        "update crm_workflows set name = $3, description = $4, folder_id = $5, hourly_run_limit = $6, draft = $7, draft_revision = draft_revision + 1, updated_by = $8 where id = $1 and org_id = $2",
        [r.name, r.description, r.folderId, r.hourlyRunLimit, json({ trigger: r.draft.trigger, steps: r.draft.steps }), userId],
      );
      return;
    }
    case "report": {
      const r = record as NativeTypeMap["report"];
      await run("update crm_report_definitions set name = $3, description = $4, folder_id = $5, report = $6, config = $7 where id = $1 and org_id = $2", [r.name, r.description, r.folderId, r.report, json(r.config)]);
      return;
    }
  }
}

/** Removes a record a rollback found unchanged and unused. Never called for anything else (usage.ts decides). */
export async function deleteRecord(ctx: WriteContext, entry: NativeEntry): Promise<void> {
  const { db, orgId } = ctx;
  const del = (table: string) => db.query(`delete from ${table} where id = $1 and org_id = $2`, [entry.id, orgId]);
  switch (entry.type) {
    case "folder": await del("crm_folders"); return;
    case "tag": await del("crm_tags"); return;
    case "customField": await del("crm_custom_fields"); return;
    case "customValue": await del("crm_custom_values"); return;
    case "pipeline": {
      const wasDefault = entry.meta.isDefault === true;
      await del("crm_pipelines");
      if (wasDefault) {
        await db.query(
          `update crm_pipelines set is_default = true where id = (select id from crm_pipelines where org_id = $1 and provider = 'native' and archived_at is null order by position limit 1)
           and not exists (select 1 from crm_pipelines where org_id = $1 and provider = 'native' and archived_at is null and is_default)`,
          [orgId],
        );
      }
      return;
    }
    case "stage": {
      await del("crm_pipeline_stages");
      if (entry.parentId) await renumberStages(db, orgId, entry.parentId);
      return;
    }
    case "calendar": await del("crm_calendars"); return;
    case "appointmentType": await del("crm_appointment_types"); return;
    case "smartList": await del("crm_smart_lists"); return;
    case "assignmentRule": {
      const r = entry.record as NativeTypeMap["assignmentRule"];
      await del("crm_assignment_rules");
      const { rows } = await db.query<{ id: string }>("select id from crm_assignment_rules where org_id = $1 and entity = $2 order by position, created_at, id for update", [orgId, r.entity]);
      for (const [pos, x] of rows.entries()) await db.query("update crm_assignment_rules set position = $3 where id = $1 and org_id = $2 and position is distinct from $3", [x.id, orgId, pos]);
      return;
    }
    case "form": await del("crm_forms"); return;
    case "messageTemplate": await del("crm_message_templates"); return;
    case "workflow": await del("crm_workflows"); return;
    case "report": await del("crm_report_definitions"); return;
  }
}
