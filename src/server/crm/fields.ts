import "server-only";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { assertCan, auditActor, crmRead, crmWrite, type CrmActor } from "@/server/crm/actor";
import { assertNativeOwner } from "@/server/crm/workspace";
import { emitEvent } from "@/server/crm/events";
import { coerceFieldValue, normalizeOptions, readStoredValue, slugifyKey, type FieldDefinition, type FieldOption, type FieldValue } from "@/lib/crm/fields";
import { FIELD_TYPES, type FieldEntity, type FieldType } from "@/lib/crm/types";

export interface CustomFieldView extends FieldDefinition {
  entity: FieldEntity;
  helpText: string | null;
  groupName: string | null;
  position: number;
  archived: boolean;
  valueCount: number;
}

interface FieldRow {
  id: string;
  entity: FieldEntity;
  key: string;
  label: string;
  type: FieldType;
  options: FieldOption[];
  required: boolean;
  help_text: string | null;
  group_name: string | null;
  position: number;
  archived_at: Date | null;
}

const toView = (r: FieldRow, valueCount = 0): CustomFieldView => ({
  id: r.id, entity: r.entity, key: r.key, label: r.label, type: r.type, options: r.options ?? [], required: r.required,
  helpText: r.help_text, groupName: r.group_name, position: r.position, archived: Boolean(r.archived_at), valueCount,
});

/** Active definitions for one record type, in display order. */
export async function loadFieldDefinitions(db: Queryable, orgId: string, entity: FieldEntity, opts: { includeArchived?: boolean } = {}): Promise<CustomFieldView[]> {
  const { rows } = await db.query<FieldRow>(
    `select id, entity, key, label, type, options, required, help_text, group_name, position, archived_at from crm_custom_fields
     where org_id = $1 and entity = $2 ${opts.includeArchived ? "" : "and archived_at is null"} order by position, created_at`,
    [orgId, entity],
  );
  return rows.map((r) => toView(r));
}

export async function listCustomFields(actor: CrmActor, entity?: FieldEntity): Promise<CustomFieldView[]> {
  assertCan(actor, "crm.view");
  return crmRead(actor, async (db) => {
    const { rows } = await db.query<FieldRow & { value_count: string }>(
      `select f.id, f.entity, f.key, f.label, f.type, f.options, f.required, f.help_text, f.group_name, f.position, f.archived_at,
              (select count(*) from crm_field_values v where v.field_id = f.id)::text as value_count
       from crm_custom_fields f where f.org_id = $1 and ($2::text is null or f.entity = $2) order by f.entity, f.archived_at nulls first, f.position, f.created_at`,
      [actor.orgId, entity ?? null],
    );
    return rows.map((r) => toView(r, Number(r.value_count)));
  });
}

export interface FieldDefinitionInput {
  entity: FieldEntity;
  label: string;
  key?: string;
  type: FieldType;
  options?: Array<string | Partial<FieldOption>>;
  required?: boolean;
  helpText?: string | null;
  groupName?: string | null;
}

export async function createCustomField(actor: CrmActor, input: FieldDefinitionInput): Promise<CustomFieldView> {
  assertCan(actor, "fields.manage");
  if (!FIELD_TYPES.includes(input.type)) throw new AppError("invalid_input", "Choose a field type.");
  const label = input.label.trim();
  if (!label || label.length > 80) throw new AppError("invalid_input", "Give the field a name of up to 80 characters.");
  const key = (input.key?.trim() || slugifyKey(label)).toLowerCase();
  if (!/^[a-z][a-z0-9_]{0,47}$/.test(key)) throw new AppError("invalid_input", "The field key can use lowercase letters, numbers and underscores, starting with a letter.");
  const options = input.type === "select" || input.type === "multiselect" ? normalizeOptions(input.options ?? []) : [];
  if ((input.type === "select" || input.type === "multiselect") && !options.length) throw new AppError("invalid_input", "Add at least one choice.");
  return crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "custom_fields");
    const dup = await db.query("select 1 from crm_custom_fields where org_id = $1 and entity = $2 and key = $3", [actor.orgId, input.entity, key]);
    if (dup.rows.length) throw new AppError("conflict", "A field with this key already exists. Choose a different name or key.");
    const pos = await db.query<{ n: number }>("select coalesce(max(position), 0) + 1 as n from crm_custom_fields where org_id = $1 and entity = $2", [actor.orgId, input.entity]);
    const { rows } = await db.query<FieldRow>(
      `insert into crm_custom_fields (org_id, entity, key, label, type, options, required, help_text, group_name, position, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       returning id, entity, key, label, type, options, required, help_text, group_name, position, archived_at`,
      [actor.orgId, input.entity, key, label, input.type, JSON.stringify(options), input.required === true, input.helpText?.trim().slice(0, 200) || null, input.groupName?.trim().slice(0, 60) || null, pos.rows[0].n, actor.userId],
    );
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.field_created", targetType: "crm_custom_field", targetId: rows[0].id, result: "success", metadata: { entity: input.entity, key, type: input.type } }, db);
    return toView(rows[0]);
  });
}

/**
 * Label, help text, group, required flag and choices can change. The key and type cannot once values exist, because stored values
 * and saved filters depend on them. Removing a choice that is in use is refused instead of silently clearing people's data.
 */
export async function updateCustomField(actor: CrmActor, id: string, input: { label?: string; required?: boolean; helpText?: string | null; groupName?: string | null; options?: Array<string | Partial<FieldOption>>; type?: FieldType }): Promise<CustomFieldView> {
  assertCan(actor, "fields.manage");
  return crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "custom_fields");
    const { rows } = await db.query<FieldRow>("select id, entity, key, label, type, options, required, help_text, group_name, position, archived_at from crm_custom_fields where id = $1 and org_id = $2 for update", [id, actor.orgId]);
    const f = rows[0];
    if (!f) throw new AppError("not_found", "Field not found.");
    const values = Number((await db.query<{ n: string }>("select count(*)::text as n from crm_field_values where field_id = $1", [id])).rows[0].n);
    let type = f.type;
    if (input.type && input.type !== f.type) {
      if (values > 0) throw new AppError("conflict", "This field already has values, so its type can't change. Create a new field instead.");
      if (!FIELD_TYPES.includes(input.type)) throw new AppError("invalid_input", "Choose a field type.");
      type = input.type;
    }
    let options = f.options ?? [];
    if (input.options !== undefined) {
      const next = normalizeOptions(input.options);
      const removed = options.filter((o) => !next.some((n) => n.value === o.value)).map((o) => o.value);
      if (removed.length && values > 0) {
        const used = await db.query("select 1 from crm_field_values where field_id = $1 and (value_text = any($2::text[]) or value_list && $2::text[]) limit 1", [id, removed]);
        if (used.rows.length) throw new AppError("conflict", "A choice you removed is still used by some records. Change those records first, or keep the choice.");
      }
      options = next;
    }
    if ((type === "select" || type === "multiselect") && !options.length) throw new AppError("invalid_input", "Add at least one choice.");
    if (type !== "select" && type !== "multiselect") options = [];
    const label = input.label !== undefined ? input.label.trim() : f.label;
    if (!label || label.length > 80) throw new AppError("invalid_input", "Give the field a name of up to 80 characters.");
    const res = await db.query<FieldRow>(
      `update crm_custom_fields set label = $3, type = $4, options = $5, required = $6, help_text = $7, group_name = $8 where id = $1 and org_id = $2
       returning id, entity, key, label, type, options, required, help_text, group_name, position, archived_at`,
      [id, actor.orgId, label, type, JSON.stringify(options), input.required ?? f.required,
        input.helpText !== undefined ? input.helpText?.trim().slice(0, 200) || null : f.help_text,
        input.groupName !== undefined ? input.groupName?.trim().slice(0, 60) || null : f.group_name],
    );
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.field_updated", targetType: "crm_custom_field", targetId: id, result: "success" }, db);
    return toView(res.rows[0], values);
  });
}

/** Archiving hides a field everywhere but keeps its values, so it can be restored. */
export async function setCustomFieldArchived(actor: CrmActor, id: string, archived: boolean): Promise<void> {
  assertCan(actor, "fields.manage");
  await crmWrite(actor, async (db) => {
    const res = await db.query(`update crm_custom_fields set archived_at = ${archived ? "now()" : "null"} where id = $1 and org_id = $2`, [id, actor.orgId]);
    if (!res.rowCount) throw new AppError("not_found", "Field not found.");
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: archived ? "crm.field_archived" : "crm.field_restored", targetType: "crm_custom_field", targetId: id, result: "success" }, db);
  });
}

export async function reorderCustomFields(actor: CrmActor, entity: FieldEntity, ids: string[]): Promise<void> {
  assertCan(actor, "fields.manage");
  await crmWrite(actor, async (db) => {
    for (const [i, id] of ids.slice(0, 200).entries()) await db.query("update crm_custom_fields set position = $4 where id = $1 and org_id = $2 and entity = $3", [id, actor.orgId, entity, i + 1]);
  });
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

export type FieldValueErrors = Record<string, string>;

/**
 * Validates and writes custom field values for one record, inside the caller's transaction. Keys are field keys (or ids). Unknown
 * keys are refused. Returns the keys that changed. With `enforceRequired`, a required field may not be left empty.
 */
export async function writeFieldValues(
  db: Queryable,
  actor: CrmActor,
  entity: FieldEntity,
  entityId: string,
  values: Record<string, unknown>,
  opts: { enforceRequired?: boolean; defaultCallingCode?: string | null; isNew?: boolean } = {},
): Promise<string[]> {
  const defs = await loadFieldDefinitions(db, actor.orgId, entity);
  const byKey = new Map<string, CustomFieldView>();
  for (const d of defs) {
    byKey.set(d.key, d);
    byKey.set(d.id, d);
  }
  const errors: FieldValueErrors = {};
  const writes: Array<{ def: CustomFieldView; stored: ReturnType<typeof coerceFieldValue> }> = [];
  for (const [key, raw] of Object.entries(values)) {
    const def = byKey.get(key);
    if (!def) {
      errors[key] = "This field doesn't exist.";
      continue;
    }
    const res = coerceFieldValue(def, raw, { defaultCallingCode: opts.defaultCallingCode });
    if (!res.ok) errors[def.key] = res.error;
    else if (res.stored === null && def.required && opts.enforceRequired) errors[def.key] = `${def.label} is required.`;
    else writes.push({ def, stored: res });
  }
  if (opts.enforceRequired && opts.isNew) {
    for (const d of defs) if (d.required && !(d.key in values) && !(d.id in values)) errors[d.key] = `${d.label} is required.`;
  }
  if (Object.keys(errors).length) {
    const first = Object.values(errors)[0];
    const err = new AppError("invalid_input", first);
    (err as AppError & { fieldErrors?: FieldValueErrors }).fieldErrors = errors;
    throw err;
  }
  const changed: string[] = [];
  for (const w of writes) {
    if (!w.stored.ok) continue;
    if (w.stored.stored === null) {
      const res = await db.query("delete from crm_field_values where field_id = $1 and entity_id = $2 and org_id = $3", [w.def.id, entityId, actor.orgId]);
      if (res.rowCount) changed.push(w.def.key);
      continue;
    }
    const s = w.stored.stored;
    const res = await db.query(
      `insert into crm_field_values (org_id, field_id, entity, entity_id, value_text, value_number, value_date, value_ts, value_bool, value_list, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       on conflict (field_id, entity_id) do update set value_text = excluded.value_text, value_number = excluded.value_number, value_date = excluded.value_date,
         value_ts = excluded.value_ts, value_bool = excluded.value_bool, value_list = excluded.value_list, updated_by = excluded.updated_by, updated_at = now()
       where (crm_field_values.value_text, crm_field_values.value_number, crm_field_values.value_date, crm_field_values.value_ts, crm_field_values.value_bool, crm_field_values.value_list)
         is distinct from (excluded.value_text, excluded.value_number, excluded.value_date, excluded.value_ts, excluded.value_bool, excluded.value_list)`,
      [actor.orgId, w.def.id, entity, entityId, s.value_text, s.value_number, s.value_date, s.value_ts, s.value_bool, s.value_list, actor.userId],
    );
    if (res.rowCount) changed.push(w.def.key);
  }
  return changed;
}

export interface RecordFieldValue {
  fieldId: string;
  key: string;
  label: string;
  type: FieldType;
  options: FieldOption[];
  required: boolean;
  helpText: string | null;
  groupName: string | null;
  value: FieldValue;
}

/** Every active field for a record with its value (null when empty). */
export async function readFieldValues(db: Queryable, orgId: string, entity: FieldEntity, entityId: string): Promise<RecordFieldValue[]> {
  const defs = await loadFieldDefinitions(db, orgId, entity);
  const { rows } = await db.query<{ field_id: string; value_text: string | null; value_number: string | null; value_date: string | null; value_ts: Date | null; value_bool: boolean | null; value_list: string[] | null }>(
    "select field_id, value_text, value_number::text as value_number, value_date::text as value_date, value_ts, value_bool, value_list from crm_field_values where org_id = $1 and entity = $2 and entity_id = $3",
    [orgId, entity, entityId],
  );
  const byField = new Map(rows.map((r) => [r.field_id, r]));
  return defs.map((d) => {
    const r = byField.get(d.id);
    return {
      fieldId: d.id, key: d.key, label: d.label, type: d.type, options: d.options, required: d.required, helpText: d.helpText, groupName: d.groupName,
      value: r ? readStoredValue(d.type, { ...r, value_ts: r.value_ts ? new Date(r.value_ts).toISOString() : null }) : null,
    };
  });
}

/** Sets custom fields on an existing record (contact, company or opportunity), with permission and ownership checks. */
export async function setRecordFields(actor: CrmActor, entity: FieldEntity, entityId: string, values: Record<string, unknown>): Promise<string[]> {
  const permission = entity === "contact" ? "contacts.edit" : entity === "company" ? "companies.edit" : "opportunities.edit";
  assertCan(actor, permission);
  return crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, entity === "contact" ? "contacts" : entity === "company" ? "companies" : "opportunities");
    const table = entity === "contact" ? "contacts" : entity === "company" ? "crm_companies" : "crm_opportunities";
    const exists = await db.query(`select 1 from ${table} where id = $1 and org_id = $2 ${entity === "opportunity" ? "" : "and deleted_at is null"} for update`, [entityId, actor.orgId]);
    if (!exists.rows.length) throw new AppError("not_found", "Record not found.");
    const ws = await db.query<{ default_calling_code: string | null }>("select default_calling_code from crm_workspaces where org_id = $1", [actor.orgId]);
    const changed = await writeFieldValues(db, actor, entity, entityId, values, { enforceRequired: true, defaultCallingCode: ws.rows[0]?.default_calling_code });
    if (changed.length) {
      if (entity !== "opportunity") await db.query(`update ${table} set version = version + 1 where id = $1 and org_id = $2`, [entityId, actor.orgId]);
      await emitEvent(db, actor, {
        type: `${entity}.updated`, entityType: entity, entityId, contactId: entity === "contact" ? entityId : null,
        payload: { changed: changed.map((k) => `cf:${k}`) }, dedupeKey: `${entity}.fields:${entityId}:${Date.now()}:${changed.join(",")}`,
      });
    }
    return changed;
  });
}
