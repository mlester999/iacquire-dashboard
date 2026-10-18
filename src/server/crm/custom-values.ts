import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { assertCan, auditActor, crmRead, crmWrite, type CrmActor } from "@/server/crm/actor";
import {
  checkGroup, checkKey, checkLabel, CUSTOM_VALUE_LIMITS, CUSTOM_VALUE_TYPE_LABELS, isCustomValueType, keyFromLabel, normalizeCustomValue, type CustomValueType,
} from "@/lib/crm/custom-values";
import { customValueKeysUsed, customValueTokenKey, tokenText, type CustomValueTokenDef } from "@/lib/messaging/tokens";

// Workspace configuration values (crm_custom_values): things a business states once and uses in many messages, inserted into templates as
// {{custom_values.<key>}}.
//
//  * Everyone in the workspace who can open the CRM sees them (crm.view, the row-level security rule); owners and managers change them
//    (fields.manage). Every change is audited.
//  * A value's key is fixed once created, because templates refer to it. Values are checked for their type and never hold a credential.
//  * A value an approved template (or a campaign on its way out) uses can't be deleted: the template must stop using it first. A value only
//    drafts or canned replies use can be deleted once the person confirms they've seen which ones.
//  * Sending: the renderer fills these like any other token. An empty REQUIRED value blocks the send with a clear reason; an empty optional
//    one renders as nothing (see src/lib/messaging/tokens.ts).

export interface CustomValueUsage {
  kind: "template" | "canned_reply" | "campaign";
  id: string;
  /** Null when the person can't open that kind of record (they still see that it exists). */
  name: string | null;
  /** draft / approved for templates, the campaign's status for campaigns. */
  status: string;
  version: number | null;
  /** Deleting the value would break something automated: an approved template, or a campaign awaiting approval, scheduled or sending. */
  blocking: boolean;
}

export interface CustomValueView {
  id: string;
  key: string;
  /** What to type in a template: {{custom_values.<key>}}. */
  token: string;
  label: string;
  type: CustomValueType;
  typeLabel: string;
  value: string;
  group: string | null;
  required: boolean;
  /** Required and still empty: messages that use it are held until it is filled in. */
  missingRequired: boolean;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
  usage: CustomValueUsage[];
}

export interface CustomValuesList {
  values: CustomValueView[];
  limit: number;
}

interface Row {
  id: string;
  key: string;
  label: string;
  type: CustomValueType;
  value: string;
  group_name: string | null;
  required: boolean;
  created_by_name: string | null;
  created_at: Date;
  updated_at: Date;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (d: Date | string) => new Date(d).toISOString();
const SELECT = `
  select v.id, v.key, v.label, v.type, v.value, v.group_name, v.required, nullif(u.full_name, '') as created_by_name, v.created_at, v.updated_at
  from crm_custom_values v left join users u on u.id = v.created_by`;
const CAMPAIGN_BLOCKING = new Set(["awaiting_approval", "scheduled", "sending", "paused"]);
const CAMPAIGN_ACTIVE = ["draft", "awaiting_approval", "scheduled", "sending", "paused"];

function toView(r: Row, usage: CustomValueUsage[]): CustomValueView {
  return {
    id: r.id, key: r.key, token: tokenText(customValueTokenKey(r.key)), label: r.label, type: r.type, typeLabel: CUSTOM_VALUE_TYPE_LABELS[r.type] ?? r.type, value: r.value,
    group: r.group_name, required: r.required, missingRequired: r.required && !r.value.trim(), createdByName: r.created_by_name, createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at), usage,
  };
}

// ---------------------------------------------------------------------------
// Definitions for templates (no authorization: callers have already authorized the work they are doing for this organization)
// ---------------------------------------------------------------------------

/**
 * The workspace's configuration values as templates see them, read with the caller's connection (inside its transaction when it has one).
 * Used by the template validator (which keys exist) and the renderer (values and which are required).
 */
export async function loadCustomValueDefs(db: Queryable, orgId: string): Promise<CustomValueTokenDef[]> {
  const { rows } = await db.query<{ key: string; label: string; required: boolean; group_name: string | null; value: string }>(
    "select key, label, required, group_name, value from crm_custom_values where org_id = $1 order by key",
    [orgId],
  );
  return rows.map((r) => ({ key: r.key, label: r.label, required: r.required, group: r.group_name, value: r.value }));
}

/** The same, on its own connection: for validating a template before its transaction starts. */
export const customValueDefsFor = (orgId: string) => withSystem((db) => loadCustomValueDefs(db, orgId));

/**
 * The catalog the template editor offers and checks against. Anyone who can read templates or the CRM may see it: values are what the
 * business sends to customers, never secrets.
 */
export async function customValueTokenCatalog(actor: CrmActor): Promise<CustomValueTokenDef[]> {
  if (!actor.can("crm.view") && !actor.can("inbox.view") && !actor.can("templates.manage")) return [];
  return customValueDefsFor(actor.orgId);
}

// ---------------------------------------------------------------------------
// Usage: which templates and campaigns refer to each key
// ---------------------------------------------------------------------------

/**
 * Where each key is used: the current wording of every template and canned reply that isn't archived, and the template version of every
 * campaign that hasn't finished. Read with trusted access (the caller authorized the actor); names are hidden from people whose role can't
 * open that kind of record.
 */
async function usageByKey(db: Queryable, orgId: string, keys: readonly string[], viewer: CrmActor | null): Promise<Map<string, CustomValueUsage[]>> {
  const out = new Map<string, CustomValueUsage[]>(keys.map((k) => [k, []]));
  if (!keys.length) return out;
  const canSeeTemplates = !viewer || viewer.can("inbox.view") || viewer.can("templates.manage");
  const canSeeCampaigns = !viewer || viewer.can("campaigns.manage");
  const add = (text: string, u: CustomValueUsage) => {
    for (const k of customValueKeysUsed(text)) out.get(k)?.push(u);
  };
  const templates = await db.query<{ id: string; kind: "template" | "canned_reply"; name: string; status: string; current_version: number; subject: string | null; body: string }>(
    `select t.id, t.kind, t.name, t.status, t.current_version, v.subject, v.body
     from crm_message_templates t join crm_message_template_versions v on v.template_id = t.id and v.org_id = t.org_id and v.version = t.current_version
     where t.org_id = $1 and t.archived_at is null and (v.body like '%custom_value%' or coalesce(v.subject, '') like '%custom_value%')
     order by lower(t.name)`,
    [orgId],
  );
  for (const t of templates.rows) {
    add(`${t.subject ?? ""}\n${t.body}`, {
      kind: t.kind, id: t.id, name: canSeeTemplates ? t.name : null, status: t.status, version: t.current_version, blocking: t.kind === "template" && t.status === "approved",
    });
  }
  const campaigns = await db.query<{ id: string; name: string; status: string; template_version: number | null; subject: string | null; body: string }>(
    `select c.id, c.name, c.status, c.template_version, v.subject, v.body
     from crm_campaigns c join crm_message_template_versions v on v.template_id = c.template_id and v.org_id = c.org_id and v.version = c.template_version
     where c.org_id = $1 and c.status = any($2::text[]) and (v.body like '%custom_value%' or coalesce(v.subject, '') like '%custom_value%')
     order by lower(c.name)`,
    [orgId, CAMPAIGN_ACTIVE],
  );
  for (const c of campaigns.rows) {
    add(`${c.subject ?? ""}\n${c.body}`, { kind: "campaign", id: c.id, name: canSeeCampaigns ? c.name : null, status: c.status, version: c.template_version, blocking: CAMPAIGN_BLOCKING.has(c.status) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function listCustomValues(actor: CrmActor, opts: { q?: string } = {}): Promise<CustomValuesList> {
  assertCan(actor, "crm.view", "Your role doesn't include the CRM.");
  const params: unknown[] = [actor.orgId];
  let where = "v.org_id = $1";
  const q = (opts.q ?? "").trim().slice(0, 80);
  if (q) {
    params.push(`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    where += ` and (v.key ilike $2 escape '\\' or v.label ilike $2 escape '\\' or v.value ilike $2 escape '\\' or coalesce(v.group_name, '') ilike $2 escape '\\')`;
  }
  // Read as the actor (row-level security for members), then usage with trusted access for exactly these keys.
  const rows = await crmRead(actor, async (db) => (await db.query<Row>(`${SELECT} where ${where} order by lower(coalesce(v.group_name, '')), lower(v.label) limit 500`, params)).rows);
  const usage = await withSystem((db) => usageByKey(db, actor.orgId, rows.map((r) => r.key), actor));
  return { values: rows.map((r) => toView(r, usage.get(r.key) ?? [])), limit: CUSTOM_VALUE_LIMITS.perWorkspace };
}

async function loadRow(db: Queryable, orgId: string, id: string, opts: { forUpdate?: boolean } = {}): Promise<Row> {
  if (!UUID_RE.test(id)) throw new AppError("not_found", "Configuration value not found.");
  if (opts.forUpdate) await db.query("select 1 from crm_custom_values where id = $1 and org_id = $2 for update", [id, orgId]);
  const { rows } = await db.query<Row>(`${SELECT} where v.id = $1 and v.org_id = $2`, [id, orgId]);
  if (!rows[0]) throw new AppError("not_found", "Configuration value not found.");
  return rows[0];
}

export async function getCustomValue(actor: CrmActor, id: string): Promise<CustomValueView> {
  assertCan(actor, "crm.view", "Your role doesn't include the CRM.");
  const row = await crmRead(actor, (db) => loadRow(db, actor.orgId, id));
  const usage = await withSystem((db) => usageByKey(db, actor.orgId, [row.key], actor));
  return toView(row, usage.get(row.key) ?? []);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface CustomValueInput {
  /** Create only. Made from the label when not given. Never changes afterwards. */
  key?: string;
  label?: string;
  type?: string;
  value?: string | null;
  group?: string | null;
  required?: boolean;
}

const MANAGE = "Only owners and managers can change configuration values.";

async function callingCode(db: Queryable, orgId: string): Promise<string | null> {
  const { rows } = await db.query<{ default_calling_code: string | null }>("select default_calling_code from crm_workspaces where org_id = $1", [orgId]);
  return rows[0]?.default_calling_code ?? null;
}

function checkedValue(type: CustomValueType, raw: string | null | undefined, code: string | null): string {
  const v = normalizeCustomValue(type, raw, { defaultCallingCode: code });
  if (!v.ok) throw new AppError("invalid_input", v.error);
  return v.value;
}

export async function createCustomValue(actor: CrmActor, input: CustomValueInput): Promise<CustomValueView> {
  assertCan(actor, "fields.manage", MANAGE);
  const label = checkLabel(input.label);
  if (!label.ok) throw new AppError("invalid_input", label.error);
  const type = input.type === undefined ? "text" : input.type;
  if (!isCustomValueType(type)) throw new AppError("invalid_input", "Choose a type: text, web address, phone number, email address, number or colour.");
  const group = checkGroup(input.group);
  if (!group.ok) throw new AppError("invalid_input", group.error);
  const explicitKey = (input.key ?? "").trim();
  if (explicitKey) {
    const k = checkKey(explicitKey);
    if (!k.ok) throw new AppError("invalid_input", k.error);
  }
  return crmWrite(actor, async (db) => {
    const value = checkedValue(type, input.value, await callingCode(db, actor.orgId));
    const count = await db.query<{ n: string }>("select count(*)::text as n from crm_custom_values where org_id = $1", [actor.orgId]);
    if (Number(count.rows[0].n) >= CUSTOM_VALUE_LIMITS.perWorkspace) {
      throw new AppError("conflict", `A workspace can have up to ${CUSTOM_VALUE_LIMITS.perWorkspace} configuration values. Delete one you no longer use first.`);
    }
    let key: string;
    if (explicitKey) {
      const dup = await db.query("select 1 from crm_custom_values where org_id = $1 and key = $2", [actor.orgId, explicitKey]);
      if (dup.rows[0]) throw new AppError("conflict", `Another configuration value already uses the key ${explicitKey}. Keys are unique in a workspace.`);
      key = explicitKey;
    } else {
      const base = keyFromLabel(label.label);
      const { rows } = await db.query<{ key: string }>("select key from crm_custom_values where org_id = $1 and (key = $2 or key like $3)", [actor.orgId, base, `${base.slice(0, 44)}_%`]);
      const taken = new Set(rows.map((r) => r.key));
      key = base;
      for (let i = 2; taken.has(key); i += 1) key = `${base.slice(0, CUSTOM_VALUE_LIMITS.key - String(i).length - 1)}_${i}`;
    }
    let rows: Array<{ id: string }>;
    try {
      ({ rows } = await db.query<{ id: string }>(
        "insert into crm_custom_values (org_id, key, label, type, value, group_name, required, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id",
        [actor.orgId, key, label.label, type, value, group.group, Boolean(input.required), actor.userId],
      ));
    } catch (err) {
      // Someone added a value with the same key at the same moment.
      if ((err as { code?: string }).code === "23505") throw new AppError("conflict", `Another configuration value already uses the key ${key}. Keys are unique in a workspace.`);
      throw err;
    }
    await recordAudit({
      orgId: actor.orgId, ...auditActor(actor), action: "crm.custom_value_created", targetType: "crm_custom_value", targetId: rows[0].id, result: "success",
      metadata: { key, type, required: Boolean(input.required), filled: Boolean(value) },
    }, db);
    return toView(await loadRow(db, actor.orgId, rows[0].id), []);
  });
}

export interface CustomValueUpdate extends CustomValueInput {
  /** The updatedAt the person was looking at: if someone saved since, nothing is overwritten. */
  expectedUpdatedAt?: string;
}

export interface CustomValueUpdateResult {
  value: CustomValueView;
  /** Which settings changed (never the values themselves). */
  changed: Array<"label" | "type" | "value" | "group" | "required">;
}

export async function updateCustomValue(actor: CrmActor, id: string, input: CustomValueUpdate): Promise<CustomValueUpdateResult> {
  assertCan(actor, "fields.manage", MANAGE);
  return crmWrite(actor, async (db) => {
    const r = await loadRow(db, actor.orgId, id, { forUpdate: true });
    if (input.key !== undefined && input.key.trim() !== r.key) {
      throw new AppError("invalid_input", `The key ${r.key} can't change: templates refer to it as ${tokenText(customValueTokenKey(r.key))}. Create a new value with the key you want instead.`);
    }
    if (input.expectedUpdatedAt && new Date(input.expectedUpdatedAt).getTime() !== new Date(r.updated_at).getTime()) {
      throw new AppError("conflict", "Someone changed this value while you were editing it. Reload to see their change, then make yours again.");
    }
    let label = r.label;
    if (input.label !== undefined) {
      const l = checkLabel(input.label);
      if (!l.ok) throw new AppError("invalid_input", l.error);
      label = l.label;
    }
    const type = input.type === undefined ? r.type : input.type;
    if (!isCustomValueType(type)) throw new AppError("invalid_input", "Choose a type: text, web address, phone number, email address, number or colour.");
    let group = r.group_name;
    if (input.group !== undefined) {
      const g = checkGroup(input.group);
      if (!g.ok) throw new AppError("invalid_input", g.error);
      group = g.group;
    }
    const required = input.required === undefined ? r.required : Boolean(input.required);
    // The value is checked against the (possibly new) type, so changing the type can never leave an invalid value behind.
    const code = await callingCode(db, actor.orgId);
    let value: string;
    if (input.value !== undefined) value = checkedValue(type, input.value, code);
    else {
      const again = normalizeCustomValue(type, r.value, { defaultCallingCode: code });
      if (!again.ok) throw new AppError("invalid_input", `The current value isn't a valid ${CUSTOM_VALUE_TYPE_LABELS[type].toLowerCase()}. Change the value too. ${again.error}`);
      value = again.value;
    }
    const changed: CustomValueUpdateResult["changed"] = [];
    if (label !== r.label) changed.push("label");
    if (type !== r.type) changed.push("type");
    if (value !== r.value) changed.push("value");
    if (group !== r.group_name) changed.push("group");
    if (required !== r.required) changed.push("required");
    if (!changed.length) return { value: toView(r, (await usageByKey(db, actor.orgId, [r.key], actor)).get(r.key) ?? []), changed };
    await db.query(
      "update crm_custom_values set label = $3, type = $4, value = $5, group_name = $6, required = $7 where id = $1 and org_id = $2",
      [id, actor.orgId, label, type, value, group, required],
    );
    const usage = (await usageByKey(db, actor.orgId, [r.key], actor)).get(r.key) ?? [];
    await recordAudit({
      orgId: actor.orgId, ...auditActor(actor), action: "crm.custom_value_updated", targetType: "crm_custom_value", targetId: id, result: "success",
      metadata: { key: r.key, changed, required, filled: Boolean(value), usedByApproved: usage.filter((u) => u.blocking).length },
    }, db);
    return { value: toView(await loadRow(db, actor.orgId, id), usage), changed };
  });
}

const usageName = (u: CustomValueUsage) => {
  const what = u.kind === "campaign" ? "campaign" : u.kind === "canned_reply" ? "canned reply" : u.status === "approved" ? "approved template" : "draft template";
  return u.name ? `the ${what} “${u.name}”` : `a ${what} you can't open`;
};
const listNames = (items: string[]) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

/**
 * Deletes a value. Refused while an approved template or an active campaign uses it (they would stop sending); when only drafts or canned
 * replies use it, the person must confirm (`confirmUsage`), and those then can't be saved or sent until the token is removed from them.
 */
export async function deleteCustomValue(actor: CrmActor, id: string, opts: { confirmUsage?: boolean } = {}): Promise<{ key: string; affected: number }> {
  assertCan(actor, "fields.manage", MANAGE);
  return crmWrite(actor, async (db) => {
    const r = await loadRow(db, actor.orgId, id, { forUpdate: true });
    // Usage is read with trusted access whatever the person may open (only names are hidden), so a value can't be deleted out from under
    // something they can't see.
    const shown = (await usageByKey(db, actor.orgId, [r.key], actor)).get(r.key) ?? [];
    const blocking = shown.filter((u) => u.blocking);
    const token = tokenText(customValueTokenKey(r.key));
    if (blocking.length) {
      const names = blocking.slice(0, 5).map(usageName);
      if (blocking.length > 5) names.push(`${blocking.length - 5} more`);
      throw new AppError(
        "conflict",
        `“${r.label}” can't be deleted: ${listNames(names)} ${blocking.length === 1 ? "uses" : "use"} ${token}. Remove it from ${blocking.length === 1 ? "that" : "those"} first (an approved template that changes goes back to draft for approval), then delete the value.`,
      );
    }
    if (shown.length && !opts.confirmUsage) {
      throw new AppError(
        "conflict",
        `${listNames(shown.slice(0, 5).map(usageName))}${shown.length > 5 ? ` and ${shown.length - 5} more` : ""} ${shown.length === 1 ? "uses" : "use"} ${token}. Confirm the deletion to go ahead: ${shown.length === 1 ? "it" : "they"} can't be saved or sent until the token is removed.`,
      );
    }
    await db.query("delete from crm_custom_values where id = $1 and org_id = $2", [id, actor.orgId]);
    await recordAudit({
      orgId: actor.orgId, ...auditActor(actor), action: "crm.custom_value_deleted", targetType: "crm_custom_value", targetId: id, result: "success",
      metadata: { key: r.key, type: r.type, affected: shown.length },
    }, db);
    return { key: r.key, affected: shown.length };
  });
}
