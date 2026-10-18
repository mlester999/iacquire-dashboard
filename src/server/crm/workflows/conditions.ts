import "server-only";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { compileContactFilter, type CompileContext } from "@/server/crm/filter-sql";
import { loadCustomFieldMetas } from "@/server/crm/directory";
import { FilterError, countConditions, isGroup, type FilterCondition, type FilterGroup } from "@/lib/crm/filters";
import { OPPORTUNITY_CONDITION_FIELDS, type ValidationIssue, type WorkflowDefinition } from "@/lib/crm/workflow/spec";

/**
 * Conditions a workflow checks against one record: the CRM filter language over the contact (compiled by src/server/crm/filter-sql.ts),
 * a small fixed catalog over the deal, and "replied since the run started". Every value is a bound parameter; field names map to fixed
 * SQL fragments.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const fail = (message: string): never => {
  throw new FilterError(message);
};
const bind = (ctx: { params: unknown[] }, v: unknown) => {
  ctx.params.push(v);
  return `$${ctx.params.length}`;
};

async function compileContext(db: Queryable, orgId: string, timezone: string): Promise<CompileContext> {
  return { params: [orgId], userId: null, timezone, customFields: await loadCustomFieldMetas(db, orgId) };
}

/** Whether a contact of this workspace matches a filter. An empty filter matches every (existing) contact. */
export async function contactMatches(db: Queryable, orgId: string, timezone: string, contactId: string, filter: FilterGroup): Promise<boolean> {
  const ctx = await compileContext(db, orgId, timezone);
  const expr = countConditions(filter) ? compileContactFilter(filter, ctx) : "true";
  const idParam = bind(ctx, contactId);
  const { rows } = await db.query(`select 1 from contacts c where c.org_id = $1 and c.id = ${idParam} and c.deleted_at is null and ${expr}`, ctx.params);
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Deal conditions
// ---------------------------------------------------------------------------

const OPP_FIELDS = new Map(OPPORTUNITY_CONDITION_FIELDS.map((f) => [f.key, f]));

function strings(value: unknown, label: string, uuids = false): string[] {
  const arr = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const out = [...new Set(arr.map((v) => (typeof v === "string" ? v.trim() : "")).filter(Boolean))];
  if (!out.length) fail(`Choose at least one value for ${label}.`);
  if (uuids && out.some((v) => !UUID.test(v))) fail(`Choose ${label} from the list.`);
  return out.slice(0, 200);
}

function numberOf(value: unknown, label: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) fail(`${label} must be a number.`);
  return n;
}

function days(value: unknown, label: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 3650) fail(`${label} must be a whole number of days.`);
  return n;
}

function dateOf(value: unknown, label: string): string {
  const s = typeof value === "string" ? value.trim() : "";
  if (!DATE.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) fail(`${label} needs a date like 2026-10-31.`);
  return s;
}

function range(value: unknown, label: string): { from: unknown; to: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} needs a start and an end.`);
  return value as { from: unknown; to: unknown };
}

function dateCond(expr: string, op: string, value: unknown, label: string, ctx: CompileContext, plainDate: boolean): string {
  const tz = () => bind(ctx, ctx.timezone);
  const at = (d: string) => (plainDate ? `${bind(ctx, d)}::date` : `(${bind(ctx, d)}::date::timestamp at time zone ${tz()})`);
  const next = (d: string) => (plainDate ? `(${bind(ctx, d)}::date + 1)` : `((${bind(ctx, d)}::date::timestamp at time zone ${tz()}) + interval '1 day')`);
  const today = plainDate ? `(now() at time zone ${tz()})::date` : "now()";
  const span = (n: number) => (plainDate ? `${n}` : `make_interval(days => ${n})`);
  switch (op) {
    case "before": return `${expr} < ${at(dateOf(value, label))}`;
    case "after": return `${expr} >= ${next(dateOf(value, label))}`;
    case "between": {
      const r = range(value, label);
      const from = dateOf(r.from, label);
      const to = dateOf(r.to, label);
      if (from > to) fail(`The start of ${label} must be before its end.`);
      return `(${expr} >= ${at(from)} and ${expr} < ${next(to)})`;
    }
    case "within_last_days": {
      const n = days(value, label);
      return `(${expr} >= ${today} - ${span(n)} and ${expr} <= ${today})`;
    }
    case "more_than_days_ago": return `${expr} < ${today} - ${span(days(value, label))}`;
    case "within_next_days": {
      const n = days(value, label);
      return `(${expr} >= ${today} and ${expr} <= ${today} + ${span(n)})`;
    }
    case "is_empty": return `${expr} is null`;
    case "is_not_empty": return `${expr} is not null`;
  }
  return fail(`${label} can't be compared that way.`);
}

function textCond(expr: string, op: string, value: unknown, label: string, ctx: CompileContext): string {
  const raw = () => {
    const v = typeof value === "string" || typeof value === "number" ? String(value).trim().toLowerCase() : "";
    if (!v) fail(`Enter a value for ${label}.`);
    return v.slice(0, 200);
  };
  const like = () => raw().replace(/[\\%_]/g, (m) => `\\${m}`);
  switch (op) {
    case "contains": return `${expr} like ${bind(ctx, `%${like()}%`)} escape '\\'`;
    case "not_contains": return `${expr} not like ${bind(ctx, `%${like()}%`)} escape '\\'`;
    case "starts_with": return `${expr} like ${bind(ctx, `${like()}%`)} escape '\\'`;
    case "equals": return `${expr} = ${bind(ctx, raw())}`;
    case "not_equals": return `${expr} <> ${bind(ctx, raw())}`;
    case "is_empty": return `${expr} = ''`;
    case "is_not_empty": return `${expr} <> ''`;
  }
  return fail(`${label} can't be compared that way.`);
}

function opportunityCondition(c: FilterCondition, ctx: CompileContext): string {
  const field = OPP_FIELDS.get(c.field) ?? fail("A deal condition uses a field that doesn't exist.");
  const label = field.label.toLowerCase();
  switch (c.field) {
    case "status": {
      const v = strings(c.value, label);
      if (v.some((x) => !["open", "won", "lost"].includes(x))) fail("Choose open, won or lost.");
      if (c.op === "in") return `o.status = any(${bind(ctx, v)}::text[])`;
      if (c.op === "not_in") return `not (o.status = any(${bind(ctx, v)}::text[]))`;
      break;
    }
    case "pipeline":
    case "stage": {
      const col = c.field === "pipeline" ? "o.pipeline_ref" : "o.stage_ref";
      const v = strings(c.value, label, true);
      if (c.op === "in") return `${col} = any(${bind(ctx, v)}::uuid[])`;
      if (c.op === "not_in") return `(${col} is null or not (${col} = any(${bind(ctx, v)}::uuid[])))`;
      break;
    }
    case "value": {
      const ops: Record<string, string> = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };
      if (ops[c.op]) return `o.monetary_value ${ops[c.op]} ${bind(ctx, numberOf(c.value, label))}`;
      if (c.op === "between") {
        const r = range(c.value, label);
        const a = numberOf(r.from, label);
        const b = numberOf(r.to, label);
        return `o.monetary_value between ${bind(ctx, Math.min(a, b))} and ${bind(ctx, Math.max(a, b))}`;
      }
      if (c.op === "is_empty") return "o.monetary_value is null";
      if (c.op === "is_not_empty") return "o.monetary_value is not null";
      break;
    }
    case "owner":
      if (c.op === "is_any_of") return `o.assigned_user_id = any(${bind(ctx, strings(c.value, label, true))}::uuid[])`;
      if (c.op === "is_unassigned") return "o.assigned_user_id is null";
      if (c.op === "is_assigned") return "o.assigned_user_id is not null";
      break;
    case "tags": {
      const ids = strings(c.value, label, true);
      const p = bind(ctx, ids);
      const scope = "t.org_id = o.org_id and t.opportunity_id = o.id";
      if (c.op === "has_any") return `exists (select 1 from crm_opportunity_tags t where ${scope} and t.tag_id = any(${p}::uuid[]))`;
      if (c.op === "has_none") return `not exists (select 1 from crm_opportunity_tags t where ${scope} and t.tag_id = any(${p}::uuid[]))`;
      if (c.op === "has_all") return `(select count(distinct t.tag_id) from crm_opportunity_tags t where ${scope} and t.tag_id = any(${p}::uuid[])) = ${ids.length}`;
      break;
    }
    case "source":
      return textCond("lower(coalesce(o.source, ''))", c.op, c.value, label, ctx);
    case "created_at":
      return dateCond("o.created_at", c.op, c.value, label, ctx, false);
    case "expected_close_date":
      return dateCond("o.expected_close_date", c.op, c.value, label, ctx, true);
  }
  return fail(`"${field.label}" can't be compared that way.`);
}

/** A boolean SQL expression over `crm_opportunities o`. */
export function compileOpportunityFilter(group: FilterGroup, ctx: CompileContext): string {
  const walk = (g: FilterGroup): string => {
    const parts = g.conditions.map((n) => (isGroup(n) ? walk(n) : opportunityCondition(n, ctx)));
    return parts.length ? `(${parts.join(g.op === "and" ? " and " : " or ")})` : "true";
  };
  try {
    return walk(group);
  } catch (err) {
    if (err instanceof FilterError) throw new AppError("invalid_input", err.message);
    throw err;
  }
}

export async function opportunityMatches(db: Queryable, orgId: string, timezone: string, opportunityId: string, filter: FilterGroup): Promise<boolean> {
  const ctx: CompileContext = { params: [orgId], userId: null, timezone, customFields: new Map() };
  const expr = countConditions(filter) ? compileOpportunityFilter(filter, ctx) : "true";
  const idParam = bind(ctx, opportunityId);
  const { rows } = await db.query(`select 1 from crm_opportunities o where o.org_id = $1 and o.id = ${idParam} and o.archived_at is null and ${expr}`, ctx.params);
  return rows.length > 0;
}

/** Whether the contact sent us any message after `since` (on any channel). */
export async function repliedSince(db: Queryable, orgId: string, contactId: string, since: Date): Promise<boolean> {
  const { rows } = await db.query(
    `select 1 from conversation_messages m join conversations c on c.id = m.conversation_id and c.org_id = m.org_id
     where m.org_id = $1 and c.contact_id = $2 and m.direction = 'inbound' and m.created_at > $3 limit 1`,
    [orgId, contactId, since.toISOString()],
  );
  return rows.length > 0;
}

/**
 * Compiles every condition in a definition against the workspace's current fields, so publishing refuses a filter that can't run (a
 * value that isn't a number, a deleted custom field) instead of failing at the first contact.
 */
export async function compileIssues(db: Queryable, orgId: string, timezone: string, def: WorkflowDefinition): Promise<ValidationIssue[]> {
  const out: ValidationIssue[] = [];
  const ctx = await compileContext(db, orgId, timezone);
  const check = (filter: FilterGroup, subject: "contact" | "opportunity", where: Pick<ValidationIssue, "stepKey" | "path">) => {
    try {
      const local: CompileContext = { ...ctx, params: [orgId] };
      if (subject === "contact") compileContactFilter(filter, local);
      else compileOpportunityFilter(filter, local);
    } catch (err) {
      if (err instanceof AppError || err instanceof FilterError) out.push({ level: "error", code: "invalid_conditions", message: err.message, ...where });
      else throw err;
    }
  };
  if (def.trigger.contactFilter && countConditions(def.trigger.contactFilter)) check(def.trigger.contactFilter, "contact", { path: "trigger.contactFilter" });
  for (const s of def.steps) {
    if (s.kind !== "branch") continue;
    const cfg = s.config as { subject: "contact" | "opportunity"; filter: FilterGroup };
    if (countConditions(cfg.filter)) check(cfg.filter, cfg.subject, { stepKey: s.key, path: "config.filter" });
  }
  return out;
}
