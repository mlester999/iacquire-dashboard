import "server-only";
import { AppError } from "@/server/errors";
import {
  CONTACT_FILTER_FIELDS, COMPANY_FILTER_FIELDS, FilterError, isGroup, kindForFieldType, opNeedsValue, OPS_BY_KIND,
  type CatalogField, type FieldKind, type FilterCondition, type FilterGroup,
} from "@/lib/crm/filters";
import { LEAD_STATUSES, CREATED_VIA, type FieldEntity, type FieldType } from "@/lib/crm/types";

/**
 * Compiles a validated Smart List filter into a SQL boolean expression with bound parameters. Field names come from a fixed catalog
 * and are mapped to fixed SQL fragments; every value is a parameter. Unknown fields, operators or values are refused, never ignored,
 * so a list never silently matches more people than its filter says.
 */

export interface CustomFieldMeta {
  id: string;
  entity: FieldEntity;
  type: FieldType;
  options: Array<{ value: string; label: string }>;
}

export interface CompileContext {
  /** Shared parameter list. By convention $1 is the organization id and is pushed by the caller. */
  params: unknown[];
  userId: string | null;
  timezone: string;
  customFields: Map<string, CustomFieldMeta>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const bind = (ctx: CompileContext, value: unknown) => {
  ctx.params.push(value);
  return `$${ctx.params.length}`;
};
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

function fail(message: string): never {
  throw new FilterError(message);
}

function str(value: unknown, label: string, max = 200): string {
  if (typeof value !== "string" && typeof value !== "number") fail(`Enter a value for ${label}.`);
  const s = String(value).trim();
  if (!s) fail(`Enter a value for ${label}.`);
  if (s.length > max) fail(`The value for ${label} is too long.`);
  return s;
}

function strList(value: unknown, label: string, allowed?: readonly string[]): string[] {
  const arr = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const out = [...new Set(arr.map((v) => (typeof v === "string" ? v.trim() : "")).filter(Boolean))];
  if (!out.length) fail(`Choose at least one value for ${label}.`);
  if (out.length > 200) fail(`Choose at most 200 values for ${label}.`);
  if (allowed) for (const v of out) if (!allowed.includes(v)) fail(`"${v.slice(0, 40)}" is not a valid ${label}.`);
  return out;
}

function uuidList(value: unknown, label: string): string[] {
  const out = strList(value, label);
  for (const v of out) if (!UUID.test(v)) fail(`Choose ${label} from the list.`);
  return out;
}

function positiveInt(value: unknown, label: string, max = 3650): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < 0 || n > max) fail(`${label} must be a whole number between 0 and ${max}.`);
  return n;
}

function num(value: unknown, label: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) fail(`${label} must be a number.`);
  return n;
}

function dateStr(value: unknown, label: string): string {
  const s = typeof value === "string" ? value.trim() : "";
  if (!DATE.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) fail(`${label} needs a date like 2026-10-31.`);
  return s;
}

function range(value: unknown, label: string): { from: unknown; to: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} needs a start and an end.`);
  const v = value as { from?: unknown; to?: unknown };
  return { from: v.from, to: v.to };
}

// ---------------------------------------------------------------------------
// Generic operator builders over a SQL expression
// ---------------------------------------------------------------------------

function textCondition(expr: string, op: string, value: unknown, label: string, ctx: CompileContext): string {
  switch (op) {
    case "contains":
      return `${expr} like ${bind(ctx, `%${likeEscape(str(value, label).toLowerCase())}%`)} escape '\\'`;
    case "not_contains":
      return `${expr} not like ${bind(ctx, `%${likeEscape(str(value, label).toLowerCase())}%`)} escape '\\'`;
    case "starts_with":
      return `${expr} like ${bind(ctx, `${likeEscape(str(value, label).toLowerCase())}%`)} escape '\\'`;
    case "equals":
      return `${expr} = ${bind(ctx, str(value, label).toLowerCase())}`;
    case "not_equals":
      return `${expr} <> ${bind(ctx, str(value, label).toLowerCase())}`;
    case "is_empty":
      return `${expr} = ''`;
    case "is_not_empty":
      return `${expr} <> ''`;
  }
  return fail(`"${op}" can't be used with ${label}.`);
}

/** Dates typed by a person are days in the workspace's time zone, not UTC. */
function dayStart(ctx: CompileContext, day: string) {
  return `(${bind(ctx, day)}::date::timestamp at time zone ${bind(ctx, ctx.timezone)})`;
}

function dateCondition(expr: string, op: string, value: unknown, label: string, ctx: CompileContext, isPlainDate = false): string {
  const at = (day: string) => (isPlainDate ? `${bind(ctx, day)}::date` : dayStart(ctx, day));
  const nextDay = (day: string) => (isPlainDate ? `(${bind(ctx, day)}::date + 1)` : `(${dayStart(ctx, day)} + interval '1 day')`);
  const today = isPlainDate ? `(now() at time zone ${bind(ctx, ctx.timezone)})::date` : "now()";
  const days = (n: number) => (isPlainDate ? `${n}` : `make_interval(days => ${n})`);
  switch (op) {
    case "before":
      return `${expr} < ${at(dateStr(value, label))}`;
    case "after":
      return `${expr} >= ${nextDay(dateStr(value, label))}`;
    case "between": {
      const r = range(value, label);
      const from = dateStr(r.from, label);
      const to = dateStr(r.to, label);
      if (from > to) fail(`The start of ${label} must be before its end.`);
      return `(${expr} >= ${at(from)} and ${expr} < ${nextDay(to)})`;
    }
    case "within_last_days": {
      const n = positiveInt(value, label);
      return `(${expr} >= ${today} - ${days(n)} and ${expr} <= ${today})`;
    }
    case "more_than_days_ago":
      return `${expr} < ${today} - ${days(positiveInt(value, label))}`;
    case "within_next_days": {
      const n = positiveInt(value, label);
      return `(${expr} >= ${today} and ${expr} <= ${today} + ${days(n)})`;
    }
    case "is_empty":
      return `${expr} is null`;
    case "is_not_empty":
      return `${expr} is not null`;
  }
  return fail(`"${op}" can't be used with ${label}.`);
}

function numberCondition(expr: string, op: string, value: unknown, label: string, ctx: CompileContext): string {
  const ops: Record<string, string> = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };
  if (ops[op]) return `${expr} ${ops[op]} ${bind(ctx, num(value, label))}`;
  if (op === "between") {
    const r = range(value, label);
    const a = num(r.from, label);
    const b = num(r.to, label);
    return `${expr} between ${bind(ctx, Math.min(a, b))} and ${bind(ctx, Math.max(a, b))}`;
  }
  if (op === "is_empty") return `${expr} is null`;
  if (op === "is_not_empty") return `${expr} is not null`;
  return fail(`"${op}" can't be used with ${label}.`);
}

// ---------------------------------------------------------------------------
// Custom fields
// ---------------------------------------------------------------------------

function customFieldCondition(alias: string, entity: FieldEntity, fieldKey: string, op: string, value: unknown, ctx: CompileContext): string {
  const id = fieldKey.slice(3);
  const meta = ctx.customFields.get(id);
  if (!meta || meta.entity !== entity) fail("A custom field in this filter no longer exists.");
  const kind = kindForFieldType(meta.type);
  // Any custom field can be checked for being empty, whatever its type.
  if (!OPS_BY_KIND[kind].includes(op) && op !== "is_empty" && op !== "is_not_empty") fail(`"${op}" can't be used with this custom field.`);
  const label = "this custom field";
  const exists = (cond: string) => `exists (select 1 from crm_field_values v where v.org_id = ${alias}.org_id and v.field_id = ${bind(ctx, id)} and v.entity_id = ${alias}.id and ${cond})`;
  const missing = () => `not exists (select 1 from crm_field_values v where v.org_id = ${alias}.org_id and v.field_id = ${bind(ctx, id)} and v.entity_id = ${alias}.id)`;
  if (op === "is_empty") return missing();
  if (op === "is_not_empty") return `not ${missing()}`;
  switch (kind) {
    case "text": {
      if (op === "not_contains" || op === "not_equals") {
        const positive = textCondition("lower(v.value_text)", op === "not_contains" ? "contains" : "equals", value, label, ctx);
        return `not ${exists(positive)}`;
      }
      return exists(textCondition("lower(v.value_text)", op, value, label, ctx));
    }
    case "enum": {
      const values = strList(value, label, meta.options.map((o) => o.value));
      const match = meta.type === "multiselect" ? `v.value_list && ${bind(ctx, values)}::text[]` : `v.value_text = any(${bind(ctx, values)}::text[])`;
      return op === "in" ? exists(match) : `not ${exists(match)}`;
    }
    case "number":
      return exists(numberCondition("v.value_number", op, value, label, ctx));
    case "date":
      return exists(meta.type === "date" ? dateCondition("v.value_date", op, value, label, ctx, true) : dateCondition("v.value_ts", op, value, label, ctx));
    case "bool":
      if (op === "is_true") return exists("v.value_bool = true");
      if (op === "is_false") return exists("v.value_bool = false");
      break;
  }
  return fail(`"${op}" can't be used with this custom field.`);
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

const CONTACT_FIELDS = new Map(CONTACT_FILTER_FIELDS.map((f) => [f.key, f]));

function contactCondition(c: FilterCondition, ctx: CompileContext): string {
  if (c.field.startsWith("cf:")) return customFieldCondition("c", "contact", c.field, c.op, c.value, ctx);
  const field = CONTACT_FIELDS.get(c.field) ?? fail("This filter uses a field that doesn't exist.");
  checkOp(field, c);
  const label = field.label.toLowerCase();
  const identity = (kind: "email" | "phone", cond: string) =>
    `exists (select 1 from contact_identities i where i.org_id = c.org_id and i.contact_id = c.id and i.kind = '${kind}' and ${cond})`;
  switch (c.field) {
    case "name":
      if (c.op === "equals" || c.op === "not_equals") return textCondition("lower(c.display_name)", c.op, c.value, label, ctx);
      return textCondition("lower(coalesce(c.display_name, '') || ' ' || coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, ''))", c.op, c.value, label, ctx);
    case "email": {
      if (c.op === "is_empty") return `(c.email is null and not ${identity("email", "true")})`;
      if (c.op === "is_not_empty") return `(c.email is not null or ${identity("email", "true")})`;
      const positive = c.op === "not_contains" ? "contains" : c.op === "not_equals" ? "equals" : c.op;
      const own = textCondition("lower(coalesce(c.email::text, ''))", positive, c.value, label, ctx);
      const other = textCondition("lower(i.value)", positive, c.value, label, ctx);
      const any = `(${own} or ${identity("email", other)})`;
      return positive === c.op ? any : `not ${any}`;
    }
    case "phone": {
      if (c.op === "is_empty") return `(c.phone is null and not ${identity("phone", "true")})`;
      if (c.op === "is_not_empty") return `(c.phone is not null or ${identity("phone", "true")})`;
      const digits = str(c.value, label).replace(/\D/g, "");
      if (digits.length < 3) fail("Enter at least three digits of the phone number.");
      const positive = c.op === "not_contains" ? "contains" : c.op === "not_equals" ? "equals" : c.op;
      const pattern = positive === "equals" ? digits : positive === "starts_with" ? `${digits}%` : `%${digits}%`;
      const p = bind(ctx, pattern);
      const cmp = positive === "equals" ? "=" : "like";
      const any = `(regexp_replace(coalesce(c.phone, ''), '\\D', '', 'g') ${cmp} ${p} or ${identity("phone", `regexp_replace(i.value, '\\D', '', 'g') ${cmp} ${p}`)})`;
      return positive === c.op ? any : `not ${any}`;
    }
    case "city":
      return textCondition("lower(coalesce(c.city, ''))", c.op, c.value, label, ctx);
    case "country":
      return textCondition("lower(coalesce(c.country, ''))", c.op, c.value, label, ctx);
    case "source":
      return textCondition("lower(coalesce(c.source, ''))", c.op, c.value, label, ctx);
    case "lead_status": {
      const v = strList(c.value, label, LEAD_STATUSES);
      return c.op === "in" ? `c.lead_status = any(${bind(ctx, v)}::text[])` : `not (c.lead_status = any(${bind(ctx, v)}::text[]))`;
    }
    case "created_via": {
      const v = strList(c.value, label, CREATED_VIA);
      return c.op === "in" ? `c.created_via = any(${bind(ctx, v)}::text[])` : `not (c.created_via = any(${bind(ctx, v)}::text[]))`;
    }
    case "owner":
      return ownerCondition("c.assigned_user_id", c, ctx);
    case "tags":
      return tagCondition("crm_contact_tags", "contact_id", "c", c, ctx);
    case "company": {
      if (c.op === "has_company") return "exists (select 1 from crm_contact_companies cc where cc.org_id = c.org_id and cc.contact_id = c.id)";
      if (c.op === "no_company") return "not exists (select 1 from crm_contact_companies cc where cc.org_id = c.org_id and cc.contact_id = c.id)";
      return `exists (select 1 from crm_contact_companies cc where cc.org_id = c.org_id and cc.contact_id = c.id and cc.company_id = any(${bind(ctx, uuidList(c.value, "company"))}::uuid[]))`;
    }
    case "lead_score":
      return numberCondition("c.lead_score", c.op, c.value, label, ctx);
    case "created_at":
    case "updated_at":
    case "last_activity_at":
      return dateCondition(`c.${c.field}`, c.op, c.value, label, ctx);
    case "last_inbound_at":
    case "last_outbound_at":
      return dateCondition(`(select max(cv.${c.field}) from conversations cv where cv.org_id = c.org_id and cv.contact_id = c.id)`, c.op, c.value, label, ctx);
    case "conversation": {
      const agg = "(select max(cv.last_inbound_at) as li, max(cv.last_outbound_at) as lo from conversations cv where cv.org_id = c.org_id and cv.contact_id = c.id)";
      if (c.op === "never_contacted") return `not exists (select 1 from conversations cv where cv.org_id = c.org_id and cv.contact_id = c.id and cv.last_outbound_at is not null)`;
      const n = positiveInt(c.value, "the number of days");
      if (c.op === "no_reply_in_days") return `exists (select 1 from ${agg} s where s.lo is not null and (s.li is null or s.li < s.lo) and s.lo < now() - make_interval(days => ${bind(ctx, n)}))`;
      return `exists (select 1 from conversations cv where cv.org_id = c.org_id and cv.contact_id = c.id and cv.last_inbound_at >= now() - make_interval(days => ${bind(ctx, n)}))`;
    }
    case "appointments": {
      const live = "a.org_id = c.org_id and a.contact_id = c.id and a.status not in ('cancelled', 'invalid')";
      if (c.op === "has_upcoming") return `exists (select 1 from appointment_refs a where ${live} and a.start_at > now())`;
      if (c.op === "has_any") return `exists (select 1 from appointment_refs a where ${live})`;
      return `not exists (select 1 from appointment_refs a where ${live})`;
    }
    case "opportunity":
      return opportunityCondition(c, ctx);
    case "consent": {
      const v = (c.value ?? {}) as { channel?: unknown; purpose?: unknown; status?: unknown };
      const channel = ["sms", "whatsapp", "email"].includes(String(v.channel)) ? String(v.channel) : fail("Choose a channel for the consent filter.");
      const purpose = ["service", "marketing"].includes(String(v.purpose)) ? String(v.purpose) : fail("Choose a purpose for the consent filter.");
      const status = ["granted", "revoked", "unknown"].includes(String(v.status)) ? String(v.status) : fail("Choose a consent status.");
      return `coalesce((select e.status from contact_consent_events e where e.org_id = c.org_id and e.contact_id = c.id and e.channel = ${bind(ctx, channel)} and e.purpose = ${bind(ctx, purpose)} order by e.id desc limit 1), 'unknown') = ${bind(ctx, status)}`;
    }
  }
  return fail("This filter uses a field that doesn't exist.");
}

function opportunityCondition(c: FilterCondition, ctx: CompileContext): string {
  const base = "o.org_id = c.org_id and o.contact_id = c.id and o.provider = 'native' and o.archived_at is null";
  switch (c.op) {
    case "has_open":
      return `exists (select 1 from crm_opportunities o where ${base} and o.status = 'open')`;
    case "has_won":
      return `exists (select 1 from crm_opportunities o where ${base} and o.status = 'won')`;
    case "has_lost":
      return `exists (select 1 from crm_opportunities o where ${base} and o.status = 'lost')`;
    case "has_none":
      return `not exists (select 1 from crm_opportunities o where ${base})`;
    case "in_stage":
      return `exists (select 1 from crm_opportunities o where ${base} and o.status = 'open' and o.stage_ref = any(${bind(ctx, uuidList(c.value, "stage"))}::uuid[]))`;
    case "in_pipeline":
      return `exists (select 1 from crm_opportunities o where ${base} and o.pipeline_ref = any(${bind(ctx, uuidList(c.value, "pipeline"))}::uuid[]))`;
  }
  return fail(`"${c.op}" can't be used with opportunities.`);
}

function ownerCondition(column: string, c: FilterCondition, ctx: CompileContext): string {
  switch (c.op) {
    case "is_me":
      return ctx.userId ? `${column} = ${bind(ctx, ctx.userId)}` : "false";
    case "is_unassigned":
      return `${column} is null`;
    case "is_assigned":
      return `${column} is not null`;
    case "is_any_of":
      return `${column} = any(${bind(ctx, uuidList(c.value, "owner"))}::uuid[])`;
  }
  return fail(`"${c.op}" can't be used with owner.`);
}

function tagCondition(table: "crm_contact_tags" | "crm_company_tags", column: string, alias: string, c: FilterCondition, ctx: CompileContext): string {
  const ids = uuidList(c.value, "tags");
  const p = bind(ctx, ids);
  const scope = `t.org_id = ${alias}.org_id and t.${column} = ${alias}.id`;
  switch (c.op) {
    case "has_any":
      return `exists (select 1 from ${table} t where ${scope} and t.tag_id = any(${p}::uuid[]))`;
    case "has_none":
      return `not exists (select 1 from ${table} t where ${scope} and t.tag_id = any(${p}::uuid[]))`;
    case "has_all":
      return `(select count(distinct t.tag_id) from ${table} t where ${scope} and t.tag_id = any(${p}::uuid[])) = ${ids.length}`;
  }
  return fail(`"${c.op}" can't be used with tags.`);
}

function checkOp(field: CatalogField, c: FilterCondition) {
  const kind: FieldKind = field.kind;
  if (!OPS_BY_KIND[kind].includes(c.op)) fail(`"${c.op}" can't be used with ${field.label.toLowerCase()}.`);
  if (opNeedsValue(kind, c.op) && (c.value === undefined || c.value === null || c.value === "")) fail(`Enter a value for ${field.label.toLowerCase()}.`);
}

function compileGroup(group: FilterGroup, ctx: CompileContext, leaf: (c: FilterCondition, ctx: CompileContext) => string): string {
  const parts = group.conditions.map((node) => (isGroup(node) ? compileGroup(node, ctx, leaf) : leaf(node, ctx)));
  if (!parts.length) return "true";
  return `(${parts.join(group.op === "and" ? " and " : " or ")})`;
}

function wrap<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof FilterError) throw new AppError("invalid_input", err.message);
    throw err;
  }
}

/** A boolean SQL expression over `contacts c`. */
export function compileContactFilter(group: FilterGroup, ctx: CompileContext): string {
  return wrap(() => compileGroup(group, ctx, contactCondition));
}

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------

const COMPANY_FIELDS = new Map(COMPANY_FILTER_FIELDS.map((f) => [f.key, f]));

function companyCondition(c: FilterCondition, ctx: CompileContext): string {
  if (c.field.startsWith("cf:")) return customFieldCondition("co", "company", c.field, c.op, c.value, ctx);
  const field = COMPANY_FIELDS.get(c.field) ?? fail("This filter uses a field that doesn't exist.");
  checkOp(field, c);
  const label = field.label.toLowerCase();
  switch (c.field) {
    case "name":
      return textCondition("lower(co.name)", c.op, c.value, label, ctx);
    case "domain":
      return textCondition("lower(coalesce(co.domain::text, ''))", c.op, c.value, label, ctx);
    case "industry":
      return textCondition("lower(coalesce(co.industry, ''))", c.op, c.value, label, ctx);
    case "city":
      return textCondition("lower(coalesce(co.city, ''))", c.op, c.value, label, ctx);
    case "country":
      return textCondition("lower(coalesce(co.country, ''))", c.op, c.value, label, ctx);
    case "owner":
      return ownerCondition("co.owner_user_id", c, ctx);
    case "tags":
      return tagCondition("crm_company_tags", "company_id", "co", c, ctx);
    case "created_at":
    case "updated_at":
      return dateCondition(`co.${c.field}`, c.op, c.value, label, ctx);
  }
  return fail("This filter uses a field that doesn't exist.");
}

/** A boolean SQL expression over `crm_companies co`. */
export function compileCompanyFilter(group: FilterGroup, ctx: CompileContext): string {
  return wrap(() => compileGroup(group, ctx, companyCondition));
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

const CONTACT_ORDER: Record<string, string> = {
  name: "lower(nullif(c.display_name, ''))",
  created_at: "c.created_at",
  updated_at: "c.updated_at",
  last_activity_at: "c.last_activity_at",
  lead_score: "c.lead_score",
  lead_status: "c.lead_status",
};

export function contactOrderBy(sort: { by?: string; dir?: "asc" | "desc" } | undefined): string {
  const expr = CONTACT_ORDER[sort?.by ?? "created_at"] ?? CONTACT_ORDER.created_at;
  const dir = sort?.dir === "asc" ? "asc" : "desc";
  return `${expr} ${dir} nulls last, c.id ${dir}`;
}

const COMPANY_ORDER: Record<string, string> = { name: "lower(co.name)", created_at: "co.created_at", updated_at: "co.updated_at" };
export function companyOrderBy(sort: { by?: string; dir?: "asc" | "desc" } | undefined): string {
  const expr = COMPANY_ORDER[sort?.by ?? "name"] ?? COMPANY_ORDER.name;
  const dir = sort?.dir === "desc" ? "desc" : "asc";
  return `${expr} ${dir} nulls last, co.id ${dir}`;
}

/** Quick search across names, email, phone and city (and every recorded email and phone). */
export function contactSearchCondition(q: string, ctx: CompileContext): string | null {
  const term = q.trim().toLowerCase().slice(0, 120);
  if (!term) return null;
  const p = bind(ctx, `%${likeEscape(term)}%`);
  const digits = term.replace(/\D/g, "");
  const phone = digits.length >= 4 ? ` or regexp_replace(i.value, '\\D', '', 'g') like ${bind(ctx, `%${digits}%`)}` : "";
  return `(c.search_text like ${p} escape '\\' or exists (select 1 from contact_identities i where i.org_id = c.org_id and i.contact_id = c.id and (i.value like ${p} escape '\\'${phone})))`;
}
