import "server-only";
import type { Queryable } from "@/server/db";
import { parseHoursTemplate } from "@/server/calendars/setup";
import { readDraft, type FormDraft, type FormKind, type FormPurpose } from "@/lib/crm/forms/spec";
import type { WorkflowDefinition } from "@/lib/crm/workflow/spec";
import type { ReportConfig } from "@/components/crm/reports/spec";
import type { FilterGroup } from "@/lib/crm/filters";
import type { FieldEntity, FieldType } from "@/lib/crm/types";
import {
  ASSET_TYPES, BLUEPRINT_FOLDER_KINDS,
  type AssetType, type AppointmentTypeAsset, type AssignmentStrategy, type BlueprintFolderKind, type BookingQuestion, type CalendarAsset, type CustomValueType, type FieldOption,
  type MessageChannel, type NativeTypeMap, type SmartListEntity, type StageKind, type TemplateKind,
} from "@/lib/crm/blueprints/types";
import type { EntriesByType, NativeEntry, ReadOptions, WorkspaceConfig } from "@/server/crm/blueprints/native-io/types";

// Readers: every configuration record of one workspace in the contract's native record shape, read inside the caller's transaction.
// Only configuration tables are read here (folders, tags, fields, values, pipelines, stages, calendars and their hosts, appointment types,
// Smart Lists, assignment rules and their members, forms, templates, workflows, saved reports). Contacts, companies, deals, messages,
// appointments, submissions, credentials and AI memories are never selected, so neither the apply engine nor a capture can carry them.

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

function options(raw: unknown): FieldOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((o) => (typeof o === "string" ? { value: o, label: o } : { value: String((o as { value?: unknown }).value ?? ""), label: String((o as { label?: unknown }).label ?? (o as { value?: unknown }).value ?? "") }));
}

function filterOf(raw: unknown): FilterGroup {
  if (raw && typeof raw === "object" && Array.isArray((raw as FilterGroup).conditions)) return { op: (raw as FilterGroup).op === "or" ? "or" : "and", conditions: (raw as FilterGroup).conditions };
  return { op: "and", conditions: [] };
}

function entry<T extends AssetType>(type: T, id: string, record: NativeTypeMap[T], name: string, extra: Partial<Pick<NativeEntry<T>, "parentId" | "archived" | "meta">> = {}): NativeEntry<T> {
  return { type, id, record, name, parentId: extra.parentId ?? null, archived: extra.archived ?? false, meta: extra.meta ?? {} };
}

type Reader<T extends AssetType> = (db: Queryable, orgId: string, opts: ReadOptions, onlyId?: string) => Promise<Array<NativeEntry<T>>>;

/** "and id = $2" when one record is wanted. */
const one = (onlyId: string | undefined, column = "id") => (onlyId ? ` and ${column} = $2::uuid` : "");
const params = (orgId: string, onlyId?: string) => (onlyId ? [orgId, onlyId] : [orgId]);

const folders: Reader<"folder"> = async (db, orgId, _o, onlyId) => {
  const { rows } = await db.query<{ id: string; kind: BlueprintFolderKind; name: string; position: number }>(
    `select id, kind, name, position from crm_folders where org_id = $1 and kind = any($${onlyId ? 3 : 2}::text[])${one(onlyId)} order by kind, position, lower(name)`,
    [...params(orgId, onlyId), [...BLUEPRINT_FOLDER_KINDS]],
  );
  return rows.map((r) => entry("folder", r.id, { kind: r.kind, name: r.name }, r.name, { meta: { position: r.position } }));
};

const tags: Reader<"tag"> = async (db, orgId, _o, onlyId) => {
  const { rows } = await db.query<{ id: string; name: string; color: string; description: string | null; folder_id: string | null }>(
    `select id, name::text as name, color, description, folder_id from crm_tags where org_id = $1${one(onlyId)} order by lower(name::text)`,
    params(orgId, onlyId),
  );
  return rows.map((r) => entry("tag", r.id, { name: r.name, color: r.color, description: r.description, folderId: r.folder_id }, r.name));
};

const fields: Reader<"customField"> = async (db, orgId, _o, onlyId) => {
  const { rows } = await db.query<{ id: string; entity: FieldEntity; key: string; label: string; type: FieldType; options: unknown; required: boolean; help_text: string | null; group_name: string | null; position: number; archived_at: Date | null }>(
    `select id, entity, key, label, type, options, required, help_text, group_name, position, archived_at from crm_custom_fields where org_id = $1${one(onlyId)} order by entity, position, created_at`,
    params(orgId, onlyId),
  );
  return rows.map((r) => entry("customField", r.id, {
    entity: r.entity, key: r.key, label: r.label, type: r.type, options: options(r.options), required: r.required, helpText: r.help_text, groupName: r.group_name,
  }, r.label, { archived: Boolean(r.archived_at), meta: { position: r.position } }));
};

const values: Reader<"customValue"> = async (db, orgId, _o, onlyId) => {
  const { rows } = await db.query<{ id: string; key: string; label: string; type: CustomValueType; value: string; required: boolean; group_name: string | null }>(
    `select id, key, label, type, value, required, group_name from crm_custom_values where org_id = $1${one(onlyId)} order by key`,
    params(orgId, onlyId),
  );
  return rows.map((r) => entry("customValue", r.id, { key: r.key, label: r.label, type: r.type, value: r.value, required: r.required, groupName: r.group_name }, r.label));
};

const pipelines: Reader<"pipeline"> = async (db, orgId, _o, onlyId) => {
  const { rows } = await db.query<{ id: string; name: string; description: string | null; is_default: boolean; position: number; archived_at: Date | null }>(
    `select id, name, description, is_default, position, archived_at from crm_pipelines where org_id = $1 and provider = 'native'${one(onlyId)} order by position, lower(name)`,
    params(orgId, onlyId),
  );
  return rows.map((r) => entry("pipeline", r.id, { name: r.name, description: r.description, isDefault: r.is_default }, r.name, {
    archived: Boolean(r.archived_at), meta: { isDefault: r.is_default, position: r.position },
  }));
};

const stages: Reader<"stage"> = async (db, orgId, _o, onlyId) => {
  const { rows } = await db.query<{ id: string; pipeline_id: string; name: string; kind: StageKind; probability: number | null; color: string | null; position: number; archived_at: Date | null }>(
    `select s.id, s.pipeline_id, s.name, s.kind, s.probability, s.color, s.position, s.archived_at from crm_pipeline_stages s
     join crm_pipelines p on p.id = s.pipeline_id and p.org_id = s.org_id and p.provider = 'native'
     where s.org_id = $1${one(onlyId, "s.id")} order by s.pipeline_id, s.position`,
    params(orgId, onlyId),
  );
  return rows.map((r) => entry("stage", r.id, { pipelineId: r.pipeline_id, name: r.name, kind: r.kind, probability: r.probability, color: r.color }, r.name, {
    parentId: r.pipeline_id, archived: Boolean(r.archived_at), meta: { position: r.position },
  }));
};

const calendars: Reader<"calendar"> = async (db, orgId, _o, onlyId) => {
  const hosts = await db.query<{ calendar_id: string; user_id: string }>(
    `select calendar_id, user_id from crm_calendar_members where org_id = $1 and active${one(onlyId, "calendar_id")} order by priority desc, created_at, user_id`,
    params(orgId, onlyId),
  );
  const { rows } = await db.query<{
    id: string; name: string; slug: string; description: string | null; assignment: CalendarAsset["assignment"]; round_robin_mode: CalendarAsset["roundRobinMode"]; color: string | null;
    folder_id: string | null; booking_intro: string | null; timezone: string | null; hours_template: unknown; status: string; is_default: boolean; public: boolean; origin: string;
    verified_at: Date | null; archived_at: Date | null;
  }>(
    `select id, name, slug, description, assignment, round_robin_mode, color, folder_id, booking_intro, timezone, hours_template, status, is_default, public, origin, verified_at, archived_at
     from crm_calendars where org_id = $1${one(onlyId)} order by lower(name), created_at`,
    params(orgId, onlyId),
  );
  return rows.map((r) => {
    const hostIds = hosts.rows.filter((h) => h.calendar_id === r.id).map((h) => h.user_id);
    return entry("calendar", r.id, {
      name: r.name, description: r.description, assignment: r.assignment, roundRobinMode: r.round_robin_mode, color: r.color, folderId: r.folder_id, bookingIntro: r.booking_intro,
      timezone: r.timezone, hoursTemplate: parseHoursTemplate(r.hours_template), hostIds,
    }, r.name, {
      archived: Boolean(r.archived_at),
      meta: { status: r.status, isDefault: r.is_default, public: r.public, slug: r.slug, origin: r.origin, memberCount: hostIds.length, verifiedAt: iso(r.verified_at) },
    });
  });
};

interface TypeRow {
  id: string; calendar_id: string; name: string; slug: string; description: string | null; duration_minutes: number; slot_interval_minutes: number | null;
  buffer_before_minutes: number; buffer_after_minutes: number; min_notice_minutes: number; max_days_ahead: number; daily_limit: number | null; capacity: number;
  location_kind: AppointmentTypeAsset["locationKind"]; location_detail: string | null; meeting_provider: AppointmentTypeAsset["meetingProvider"]; meeting_link: string | null;
  requires_confirmation: boolean; public: boolean; questions: BookingQuestion[] | null; color: string | null; position: number; confirmation_message: string | null;
  allow_customer_changes: boolean | null; change_cutoff_minutes: number | null; require_email: boolean | null; require_phone: boolean | null; archived_at: Date | null;
}

/** An appointment type row as the contract's native record: every column a Blueprint controls, in the asset's own key order. */
function typeRecord(r: TypeRow): NativeTypeMap["appointmentType"] {
  return {
    calendarId: r.calendar_id, name: r.name, description: r.description, durationMinutes: r.duration_minutes, slotIntervalMinutes: r.slot_interval_minutes,
    bufferBeforeMinutes: r.buffer_before_minutes, bufferAfterMinutes: r.buffer_after_minutes, minNoticeMinutes: r.min_notice_minutes, maxDaysAhead: r.max_days_ahead,
    dailyLimit: r.daily_limit, capacity: r.capacity, locationKind: r.location_kind, locationDetail: r.location_detail, meetingProvider: r.meeting_provider,
    meetingLink: r.meeting_link, requiresConfirmation: r.requires_confirmation, public: r.public,
    questions: (r.questions ?? []).map((q) => ({ key: q.key, label: q.label, type: q.type, required: q.required === true, ...(q.type === "select" && Array.isArray(q.options) ? { options: [...q.options] } : {}) })),
    color: r.color, confirmationMessage: r.confirmation_message ?? null, allowCustomerChanges: r.allow_customer_changes ?? true, changeCutoffMinutes: r.change_cutoff_minutes ?? 0,
    requireEmail: r.require_email ?? true, requirePhone: r.require_phone ?? false,
  };
}

const types: Reader<"appointmentType"> = async (db, orgId, _o, onlyId) => {
  const { rows } = await db.query<TypeRow>(
    `select id, calendar_id, name, slug, description, duration_minutes, slot_interval_minutes, buffer_before_minutes, buffer_after_minutes, min_notice_minutes,
            max_days_ahead, daily_limit, capacity, location_kind, location_detail, meeting_provider, meeting_link, requires_confirmation, public, questions, color, position,
            confirmation_message, allow_customer_changes, change_cutoff_minutes, require_email, require_phone, archived_at
     from crm_appointment_types where org_id = $1${one(onlyId)} order by calendar_id, position, lower(name)`,
    params(orgId, onlyId),
  );
  return rows.map((r) => entry("appointmentType", r.id, typeRecord(r), r.name, { parentId: r.calendar_id, archived: Boolean(r.archived_at), meta: { position: r.position, slug: r.slug } }));
};

const lists: Reader<"smartList"> = async (db, orgId, _o, onlyId) => {
  const { rows } = await db.query<{
    id: string; entity: SmartListEntity; name: string; description: string | null; folder_id: string | null; filter: unknown; columns: string[] | null; sort: { by?: string; dir?: "asc" | "desc" } | null;
    visibility: "private" | "team"; owner_user_id: string; is_default: boolean; archived_at: Date | null;
  }>(
    `select id, entity, name, description, folder_id, filter, columns, sort, visibility, owner_user_id, is_default, archived_at from crm_smart_lists where org_id = $1${one(onlyId)}
     order by entity, lower(name), created_at`,
    params(orgId, onlyId),
  );
  return rows.map((r) => entry("smartList", r.id, {
    entity: r.entity, name: r.name, description: r.description, folderId: r.folder_id, filter: filterOf(r.filter), columns: [...(r.columns ?? [])], sort: r.sort ?? {}, isDefault: r.is_default,
  }, r.name, { archived: Boolean(r.archived_at), meta: { visibility: r.visibility, ownerUserId: r.owner_user_id, isDefault: r.is_default } }));
};

const rules: Reader<"assignmentRule"> = async (db, orgId, _o, onlyId) => {
  const members = await db.query<{ rule_id: string; user_id: string; weight: number; priority: number }>(
    `select rule_id, user_id, weight, priority from crm_assignment_members where org_id = $1${one(onlyId, "rule_id")} order by priority desc, user_id`,
    params(orgId, onlyId),
  );
  const { rows } = await db.query<{
    id: string; name: string; entity: "contact" | "opportunity"; conditions: unknown; strategy: AssignmentStrategy; respect_working_hours: boolean; fallback: "unassigned" | "fallback_user";
    fallback_user_id: string | null; active: boolean; position: number;
  }>(
    `select id, name, entity, conditions, strategy, respect_working_hours, fallback, fallback_user_id, active, position from crm_assignment_rules where org_id = $1${one(onlyId)}
     order by entity, position, created_at`,
    params(orgId, onlyId),
  );
  return rows.map((r) => {
    const ms = members.rows.filter((m) => m.rule_id === r.id).map((m) => ({ userId: m.user_id, weight: m.weight, priority: m.priority }));
    const cond = (r.conditions && typeof r.conditions === "object" ? r.conditions : {}) as { reassignOwned?: unknown };
    return entry("assignmentRule", r.id, {
      name: r.name, entity: r.entity, conditions: { ...filterOf(r.conditions), ...(cond.reassignOwned === true ? { reassignOwned: true } : {}) }, strategy: r.strategy,
      respectWorkingHours: r.respect_working_hours, fallback: r.fallback, fallbackUserId: r.fallback_user_id, members: ms,
    }, r.name, { meta: { active: r.active, position: r.position, memberCount: ms.length } });
  });
};

const forms: Reader<"form"> = async (db, orgId, opts, onlyId) => {
  const versions = new Map<string, { fields: unknown; actions: unknown; consent: unknown; settings: unknown }>();
  if (opts.live) {
    const { rows } = await db.query<{ id: string; fields: unknown; actions: unknown; consent: unknown; settings: unknown }>(
      `select v.id, v.fields, v.actions, v.consent, v.settings from crm_form_versions v join crm_forms f on f.published_version_id = v.id and f.org_id = v.org_id
       where v.org_id = $1 and f.status = 'published'${one(onlyId, "f.id")}`,
      params(orgId, onlyId),
    );
    for (const v of rows) versions.set(v.id, v);
  }
  const { rows } = await db.query<{ id: string; key: string; name: string; kind: FormKind; purpose: FormPurpose; folder_id: string | null; status: string; draft: unknown; published_version_id: string | null; archived_at: Date | null }>(
    `select id, key, name, kind, purpose, folder_id, status, draft, published_version_id, archived_at from crm_forms where org_id = $1${one(onlyId)} order by lower(name), created_at`,
    params(orgId, onlyId),
  );
  return rows.map((r) => {
    const live = r.status === "published" && r.published_version_id ? versions.get(r.published_version_id) : undefined;
    const draft: FormDraft = live ? readDraft({ questions: live.fields, actions: live.actions, consent: live.consent, settings: live.settings }, r.kind) : readDraft(r.draft, r.kind);
    return entry("form", r.id, { key: r.key, name: r.name, kind: r.kind, purpose: r.purpose, folderId: r.folder_id, draft }, r.name, {
      archived: Boolean(r.archived_at), meta: { status: r.status, publishedVersionId: r.published_version_id, live: Boolean(live) },
    });
  });
};

const templates: Reader<"messageTemplate"> = async (db, orgId, opts, onlyId) => {
  const { rows } = await db.query<{
    id: string; kind: TemplateKind; key: string; name: string; channel: MessageChannel | null; purpose: "service" | "marketing"; category: string | null; folder_id: string | null; status: string;
    current_version: number; approved_version: number | null; whatsapp_template_id: string | null; archived_at: Date | null; subject: string | null; body: string; cur_hash: string;
  }>(
    `select t.id, t.kind, t.key, t.name, t.channel, t.purpose, t.category, t.folder_id, t.status, t.current_version, t.approved_version, t.whatsapp_template_id, t.archived_at,
            v.subject, v.body, c.content_hash as cur_hash
     from crm_message_templates t
     join crm_message_template_versions c on c.template_id = t.id and c.org_id = t.org_id and c.version = t.current_version
     join crm_message_template_versions v on v.template_id = t.id and v.org_id = t.org_id
       and v.version = case when $${onlyId ? 3 : 2}::boolean and t.status = 'approved' and t.approved_version is not null then t.approved_version else t.current_version end
     where t.org_id = $1${one(onlyId, "t.id")} order by lower(t.name), t.created_at`,
    [...params(orgId, onlyId), opts.live === true],
  );
  return rows.map((r) => entry("messageTemplate", r.id, {
    kind: r.kind, key: r.key, name: r.name, channel: r.channel, purpose: r.purpose, category: r.category, folderId: r.folder_id, subject: r.subject, body: r.body, whatsapp: null,
  }, r.name, {
    archived: Boolean(r.archived_at),
    meta: { status: r.status, currentVersion: r.current_version, approvedVersion: r.approved_version, contentHash: r.cur_hash, whatsappTemplateId: r.whatsapp_template_id },
  }));
};

const workflows: Reader<"workflow"> = async (db, orgId, opts, onlyId) => {
  const versions = new Map<string, { trigger_config: unknown; steps: unknown }>();
  if (opts.live) {
    const { rows } = await db.query<{ id: string; trigger_config: unknown; steps: unknown }>(
      `select v.id, v.trigger_config, v.steps from crm_workflow_versions v join crm_workflows w on w.published_version_id = v.id and w.org_id = v.org_id
       where v.org_id = $1 and w.status in ('active', 'paused')${one(onlyId, "w.id")}`,
      params(orgId, onlyId),
    );
    for (const v of rows) versions.set(v.id, v);
  }
  const { rows } = await db.query<{ id: string; key: string; name: string; description: string | null; folder_id: string | null; hourly_run_limit: number; status: string; draft: unknown; published_version_id: string | null; archived_at: Date | null }>(
    `select id, key, name, description, folder_id, hourly_run_limit, status, draft, published_version_id, archived_at from crm_workflows where org_id = $1${one(onlyId)} order by lower(name), created_at`,
    params(orgId, onlyId),
  );
  return rows.map((r) => {
    const live = r.published_version_id ? versions.get(r.published_version_id) : undefined;
    const raw = (live ? { trigger: live.trigger_config, steps: live.steps } : r.draft) as Partial<WorkflowDefinition> | null;
    const draft = { trigger: (raw?.trigger && typeof raw.trigger === "object" ? raw.trigger : { type: "manual" }), steps: Array.isArray(raw?.steps) ? raw.steps : [] } as WorkflowDefinition;
    return entry("workflow", r.id, { key: r.key, name: r.name, description: r.description, folderId: r.folder_id, hourlyRunLimit: r.hourly_run_limit, draft }, r.name, {
      archived: Boolean(r.archived_at), meta: { status: r.status, publishedVersionId: r.published_version_id, live: Boolean(live) },
    });
  });
};

const reports: Reader<"report"> = async (db, orgId, _o, onlyId) => {
  const { rows } = await db.query<{ id: string; key: string; name: string; description: string | null; folder_id: string | null; report: string; config: unknown; visibility: "private" | "team"; owner_user_id: string | null; archived_at: Date | null }>(
    `select id, key, name, description, folder_id, report, config, visibility, owner_user_id, archived_at from crm_report_definitions where org_id = $1${one(onlyId)} order by lower(name), created_at`,
    params(orgId, onlyId),
  );
  return rows.map((r) => {
    const config = (r.config && typeof r.config === "object" ? r.config : { filters: { range: "30d" }, sections: [] }) as ReportConfig;
    return entry("report", r.id, { key: r.key, name: r.name, description: r.description, folderId: r.folder_id, report: r.report, config }, r.name, {
      archived: Boolean(r.archived_at), meta: { visibility: r.visibility, ownerUserId: r.owner_user_id },
    });
  });
};

const READERS: { [T in AssetType]: Reader<T> } = {
  folder: folders, tag: tags, customField: fields, customValue: values, pipeline: pipelines, stage: stages, calendar: calendars, appointmentType: types, smartList: lists,
  assignmentRule: rules, form: forms, messageTemplate: templates, workflow: workflows, report: reports,
};

/**
 * Every configuration record of the workspace, archived ones included (marked), so the apply engine can tell "missing" from "removed by the
 * client" and restore an archived custom field instead of duplicating it.
 */
export async function readWorkspaceConfig(db: Queryable, orgId: string, opts: ReadOptions = {}): Promise<WorkspaceConfig> {
  const entries = {} as EntriesByType;
  const byId = new Map<string, NativeEntry>();
  for (const t of ASSET_TYPES) {
    const list = await (READERS[t] as Reader<AssetType>)(db, orgId, opts);
    (entries as Record<AssetType, NativeEntry[]>)[t] = list;
    for (const e of list) byId.set(e.id, e);
  }
  return { orgId, entries, byId };
}

/** One record, read again (after a write the customization fingerprint is always taken from what the database holds). Null when it is gone. */
export async function readEntry<T extends AssetType>(db: Queryable, orgId: string, type: T, id: string, opts: ReadOptions = {}): Promise<NativeEntry<T> | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  const rows = await (READERS[type] as Reader<T>)(db, orgId, opts, id);
  return rows[0] ?? null;
}
