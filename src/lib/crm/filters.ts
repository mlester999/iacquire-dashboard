// Smart List filters: a small, validated expression language. The server compiles it to parameterized SQL over a fixed catalog
// of fields (src/server/crm/filter-sql.ts), so a saved list stays dynamic and no user input ever becomes SQL text.
import { z } from "zod";
import { LEAD_STATUSES, LEAD_STATUS_LABELS, CREATED_VIA, CREATED_VIA_LABELS, type FieldType } from "@/lib/crm/types";

export const TEXT_OPS = ["contains", "not_contains", "equals", "not_equals", "starts_with", "is_empty", "is_not_empty"] as const;
export const ENUM_OPS = ["in", "not_in"] as const;
export const DATE_OPS = ["before", "after", "between", "within_last_days", "more_than_days_ago", "within_next_days", "is_empty", "is_not_empty"] as const;
export const NUMBER_OPS = ["eq", "neq", "gt", "gte", "lt", "lte", "between", "is_empty", "is_not_empty"] as const;
export const TAG_OPS = ["has_any", "has_all", "has_none"] as const;
export const OWNER_OPS = ["is_any_of", "is_me", "is_unassigned", "is_assigned"] as const;
export const COMPANY_OPS = ["is_any_of", "has_company", "no_company"] as const;
export const CONSENT_OPS = ["is"] as const;
export const BOOL_OPS = ["is_true", "is_false", "is_empty"] as const;
export const PRESENCE_OPS = ["has_any", "has_upcoming", "has_none"] as const;
export const OPPORTUNITY_OPS = ["has_open", "has_won", "has_lost", "has_none", "in_stage", "in_pipeline"] as const;
export const CONVERSATION_OPS = ["no_reply_in_days", "replied_within_days", "never_contacted"] as const;

export type FieldKind = "text" | "enum" | "date" | "number" | "tags" | "owner" | "company" | "consent" | "bool" | "appointments" | "opportunity" | "conversation";

export const OPS_BY_KIND: Record<FieldKind, readonly string[]> = {
  text: TEXT_OPS,
  enum: ENUM_OPS,
  date: DATE_OPS,
  number: NUMBER_OPS,
  tags: TAG_OPS,
  owner: OWNER_OPS,
  company: COMPANY_OPS,
  consent: CONSENT_OPS,
  bool: BOOL_OPS,
  appointments: PRESENCE_OPS,
  opportunity: OPPORTUNITY_OPS,
  conversation: CONVERSATION_OPS,
};

/** Whether an operator takes a value. "has none" needs tags but not appointments, so this depends on the field's kind. */
export function opNeedsValue(kind: FieldKind, op: string): boolean {
  if (op === "is_empty" || op === "is_not_empty") return false;
  switch (kind) {
    case "owner":
    case "company":
      return op === "is_any_of";
    case "bool":
    case "appointments":
      return false;
    case "opportunity":
      return op === "in_stage" || op === "in_pipeline";
    case "conversation":
      return op !== "never_contacted";
    default:
      return true;
  }
}

export const OP_LABELS: Record<string, string> = {
  contains: "contains", not_contains: "does not contain", equals: "is", not_equals: "is not", starts_with: "starts with",
  is_empty: "is empty", is_not_empty: "is not empty", in: "is any of", not_in: "is none of",
  before: "is before", after: "is after", between: "is between", within_last_days: "in the last … days", more_than_days_ago: "more than … days ago", within_next_days: "in the next … days",
  eq: "=", neq: "≠", gt: ">", gte: "≥", lt: "<", lte: "≤",
  has_any: "has any of", has_all: "has all of", has_none: "has none of",
  is_any_of: "is any of", is_me: "is me", is_unassigned: "is unassigned", is_assigned: "is assigned",
  has_company: "has a company", no_company: "has no company", is: "is",
  is_true: "is yes", is_false: "is no",
  has_upcoming: "has an upcoming appointment",
  has_open: "has an open opportunity", has_won: "has a won opportunity", has_lost: "has a lost opportunity", in_stage: "is in stage", in_pipeline: "is in pipeline",
  no_reply_in_days: "hasn't replied in … days", replied_within_days: "replied in the last … days", never_contacted: "was never contacted",
};

export interface CatalogField {
  key: string;
  label: string;
  kind: FieldKind;
  group: "Contact" | "Company" | "Activity" | "Sales" | "Consent" | "Custom fields";
  options?: Array<{ value: string; label: string }>;
}

export const CONTACT_FILTER_FIELDS: CatalogField[] = [
  { key: "name", label: "Name", kind: "text", group: "Contact" },
  { key: "email", label: "Email", kind: "text", group: "Contact" },
  { key: "phone", label: "Phone", kind: "text", group: "Contact" },
  { key: "city", label: "City", kind: "text", group: "Contact" },
  { key: "country", label: "Country code", kind: "text", group: "Contact" },
  { key: "source", label: "Lead source", kind: "text", group: "Contact" },
  { key: "lead_status", label: "Lead status", kind: "enum", group: "Contact", options: LEAD_STATUSES.map((v) => ({ value: v, label: LEAD_STATUS_LABELS[v] })) },
  { key: "created_via", label: "Created via", kind: "enum", group: "Contact", options: CREATED_VIA.map((v) => ({ value: v, label: CREATED_VIA_LABELS[v] })) },
  { key: "owner", label: "Owner", kind: "owner", group: "Contact" },
  { key: "tags", label: "Tags", kind: "tags", group: "Contact" },
  { key: "company", label: "Company", kind: "company", group: "Contact" },
  { key: "lead_score", label: "Lead score", kind: "number", group: "Contact" },
  // Written by the scoring engine (or a person's override), never by hand-editing a contact. See src/server/lead-scoring.
  { key: "priority_label", label: "Lead priority", kind: "enum", group: "Contact", options: [{ value: "hot", label: "Hot" }, { value: "warm", label: "Warm" }, { value: "cold", label: "Cold" }, { value: "insufficient_data", label: "Insufficient data" }] },
  { key: "priority_score", label: "Priority score", kind: "number", group: "Contact" },
  { key: "created_at", label: "Created", kind: "date", group: "Activity" },
  { key: "updated_at", label: "Last updated", kind: "date", group: "Activity" },
  { key: "last_activity_at", label: "Last activity", kind: "date", group: "Activity" },
  { key: "last_inbound_at", label: "Last message from them", kind: "date", group: "Activity" },
  { key: "last_outbound_at", label: "Last message to them", kind: "date", group: "Activity" },
  { key: "conversation", label: "Replies", kind: "conversation", group: "Activity" },
  { key: "appointments", label: "Appointments", kind: "appointments", group: "Activity" },
  { key: "opportunity", label: "Opportunities", kind: "opportunity", group: "Sales" },
  { key: "consent", label: "Consent", kind: "consent", group: "Consent" },
];

export const COMPANY_FILTER_FIELDS: CatalogField[] = [
  { key: "name", label: "Name", kind: "text", group: "Company" },
  { key: "domain", label: "Domain", kind: "text", group: "Company" },
  { key: "industry", label: "Industry", kind: "text", group: "Company" },
  { key: "city", label: "City", kind: "text", group: "Company" },
  { key: "country", label: "Country code", kind: "text", group: "Company" },
  { key: "owner", label: "Owner", kind: "owner", group: "Company" },
  { key: "tags", label: "Tags", kind: "tags", group: "Company" },
  { key: "created_at", label: "Created", kind: "date", group: "Activity" },
  { key: "updated_at", label: "Last updated", kind: "date", group: "Activity" },
];

/** Operators offered for a custom field: those of its kind, plus emptiness checks for every type. */
export function customFieldOps(type: FieldType): string[] {
  const ops = [...OPS_BY_KIND[kindForFieldType(type)]];
  for (const o of ["is_empty", "is_not_empty"]) if (!ops.includes(o)) ops.push(o);
  return ops;
}

/** The kind of filter control used for a custom field of each type. */
export function kindForFieldType(type: FieldType): FieldKind {
  switch (type) {
    case "number":
    case "currency":
      return "number";
    case "date":
    case "datetime":
      return "date";
    case "boolean":
      return "bool";
    case "select":
    case "multiselect":
      return "enum";
    default:
      return "text";
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export const MAX_FILTER_DEPTH = 3;
export const MAX_FILTER_CONDITIONS = 40;
/**
 * The most list values (tags, owners, stages, options …) one whole filter may carry across all its conditions. Each condition already takes
 * at most 200; this bounds the total, so 40 conditions of 200 values each can't become one enormous statement.
 */
export const MAX_FILTER_LIST_VALUES = 1000;

export interface FilterCondition {
  field: string;
  op: string;
  value?: unknown;
}
export interface FilterGroup {
  op: "and" | "or";
  conditions: Array<FilterCondition | FilterGroup>;
}

export const isGroup = (n: FilterCondition | FilterGroup): n is FilterGroup => Array.isArray((n as FilterGroup).conditions);

const conditionSchema = z.object({
  field: z.string().min(1).max(60).regex(/^(cf:[0-9a-f-]{36}|[a-z_]+)$/, "Unknown field."),
  op: z.string().min(1).max(40).regex(/^[a-z_]+$/),
  value: z.unknown().optional(),
});

export const filterGroupSchema: z.ZodType<FilterGroup> = z.lazy(() =>
  z.object({
    op: z.enum(["and", "or"]),
    conditions: z.array(z.union([filterGroupSchema, conditionSchema])).max(MAX_FILTER_CONDITIONS),
  }),
);

export const EMPTY_FILTER: FilterGroup = { op: "and", conditions: [] };

/** Structural checks the schema cannot express: nesting depth and the total number of conditions. */
export function checkFilterShape(group: FilterGroup): string | null {
  let count = 0;
  const walk = (g: FilterGroup, depth: number): string | null => {
    if (depth > MAX_FILTER_DEPTH) return `Filters can be nested at most ${MAX_FILTER_DEPTH} levels deep.`;
    for (const c of g.conditions) {
      if (isGroup(c)) {
        const e = walk(c, depth + 1);
        if (e) return e;
      } else if (++count > MAX_FILTER_CONDITIONS) return `A filter can have at most ${MAX_FILTER_CONDITIONS} conditions.`;
    }
    return null;
  };
  return walk(group, 1);
}

export function parseFilter(input: unknown): FilterGroup {
  const parsed = filterGroupSchema.safeParse(input ?? EMPTY_FILTER);
  if (!parsed.success) throw new FilterError("This filter isn't valid. Rebuild it and try again.");
  const shape = checkFilterShape(parsed.data);
  if (shape) throw new FilterError(shape);
  if (countListValues(parsed.data) > MAX_FILTER_LIST_VALUES) {
    throw new FilterError(`A filter can list at most ${MAX_FILTER_LIST_VALUES.toLocaleString("en-US")} values in total across its conditions. Use fewer values, or group them with a tag or a Smart List.`);
  }
  return parsed.data;
}

/** Every list value across a filter's conditions, however deeply a value nests its lists (a stage list inside an object counts too). */
export function countListValues(group: FilterGroup): number {
  const inValue = (v: unknown, depth: number): number => {
    if (depth > 4 || v === null || typeof v !== "object") return 0;
    if (Array.isArray(v)) return v.length + v.reduce<number>((n, x) => n + inValue(x, depth + 1), 0);
    return Object.values(v).reduce<number>((n, x) => n + inValue(x, depth + 1), 0);
  };
  return group.conditions.reduce<number>((n, c) => n + (isGroup(c) ? countListValues(c) : inValue(c.value, 0)), 0);
}

export class FilterError extends Error {}

export function countConditions(group: FilterGroup): number {
  return group.conditions.reduce((n, c) => n + (isGroup(c) ? countConditions(c) : 1), 0);
}

// ---------------------------------------------------------------------------
// Sorting and columns
// ---------------------------------------------------------------------------

export const CONTACT_SORTS = ["name", "created_at", "updated_at", "last_activity_at", "lead_score", "lead_status", "priority"] as const;
export type ContactSort = (typeof CONTACT_SORTS)[number];
export const CONTACT_SORT_LABELS: Record<ContactSort, string> = {
  name: "Name", created_at: "Created", updated_at: "Last updated", last_activity_at: "Last activity", lead_score: "Lead score", lead_status: "Lead status", priority: "Lead priority",
};

export const CONTACT_COLUMNS = ["email", "phone", "company", "owner", "lead_status", "source", "tags", "lead_score", "priority", "created_at", "last_activity_at", "city", "country", "created_via"] as const;
export type ContactColumn = (typeof CONTACT_COLUMNS)[number];
export const CONTACT_COLUMN_LABELS: Record<ContactColumn, string> = {
  email: "Email", phone: "Phone", company: "Company", owner: "Owner", lead_status: "Status", source: "Source", tags: "Tags", lead_score: "Score", priority: "Priority",
  created_at: "Created", last_activity_at: "Last activity", city: "City", country: "Country", created_via: "Created via",
};
export const DEFAULT_CONTACT_COLUMNS: ContactColumn[] = ["phone", "company", "owner", "lead_status", "tags", "created_at"];

export const sortSchema = z.object({ by: z.string().max(60).default("created_at"), dir: z.enum(["asc", "desc"]).default("desc") });
