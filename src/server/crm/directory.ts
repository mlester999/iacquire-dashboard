import "server-only";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { assertCan, crmRead, type CrmActor } from "@/server/crm/actor";
import { compileContactFilter, compileCompanyFilter, contactOrderBy, companyOrderBy, contactSearchCondition, type CompileContext, type CustomFieldMeta } from "@/server/crm/filter-sql";
import { EMPTY_FILTER, parseFilter, type FilterGroup } from "@/lib/crm/filters";
import { readStoredValue, type FieldValue } from "@/lib/crm/fields";
import type { CreatedVia, FieldType, LeadStatus } from "@/lib/crm/types";

export const MAX_PAGE_SIZE = 100;

/**
 * The total for a page of results. A page that came back short already says how many match (page 1 with 7 rows: 7), so the full count, a
 * scan of every matching record, runs only when the page is full or empty past the first page.
 */
export async function pageTotal(page: number, pageSize: number, rowsOnPage: number, count: () => Promise<number>): Promise<number> {
  if (rowsOnPage < pageSize && (rowsOnPage > 0 || page === 1)) return (page - 1) * pageSize + rowsOnPage;
  return count();
}

/** Validates a filter from a request, turning a malformed one into a message the person can act on. */
export function parseFilterOrThrow(input: unknown): FilterGroup {
  try {
    return parseFilter(input);
  } catch (err) {
    throw new AppError("invalid_input", err instanceof Error ? err.message : "This filter isn't valid.");
  }
}

export async function loadCustomFieldMetas(db: Queryable, orgId: string): Promise<Map<string, CustomFieldMeta>> {
  const { rows } = await db.query<CustomFieldMeta>("select id, entity, type, options from crm_custom_fields where org_id = $1 and archived_at is null", [orgId]);
  return new Map(rows.map((r) => [r.id, { ...r, options: r.options ?? [] }]));
}

export interface SavedListRef {
  id: string;
  name: string;
  filter: FilterGroup;
  columns: string[];
  sort: { by?: string; dir?: "asc" | "desc" };
  visibility: "private" | "team";
  ownerUserId: string;
}

/** A Smart List the actor may use: their own, or one shared with the team. */
export async function loadSmartList(db: Queryable, actor: CrmActor, id: string, entity: "contact" | "company" | "opportunity"): Promise<SavedListRef> {
  const { rows } = await db.query<{ id: string; name: string; filter: unknown; columns: string[]; sort: { by?: string; dir?: "asc" | "desc" }; visibility: "private" | "team"; owner_user_id: string }>(
    `select id, name, filter, columns, sort, visibility, owner_user_id from crm_smart_lists
     where id = $1 and org_id = $2 and entity = $3 and archived_at is null and (visibility = 'team' or owner_user_id = $4)`,
    [id, actor.orgId, entity, actor.userId],
  );
  const r = rows[0];
  if (!r) throw new AppError("not_found", "This saved list doesn't exist or isn't shared with you.");
  let filter: FilterGroup;
  try {
    filter = parseFilter(r.filter);
  } catch {
    throw new AppError("invalid_input", "This saved list's filter is no longer valid. Edit the list to fix it.");
  }
  return { id: r.id, name: r.name, filter, columns: r.columns, sort: r.sort ?? {}, visibility: r.visibility, ownerUserId: r.owner_user_id };
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export interface ContactListQuery {
  smartListId?: string | null;
  filter?: unknown;
  search?: string;
  sort?: { by?: string; dir?: "asc" | "desc" };
  page?: number;
  pageSize?: number;
  archived?: "exclude" | "only" | "include";
  columns?: string[];
}

export interface ContactRow {
  id: string;
  displayName: string;
  email: string | null;
  phone: string | null;
  leadStatus: LeadStatus;
  leadScore: number | null;
  source: string;
  createdVia: CreatedVia;
  city: string | null;
  country: string | null;
  createdAt: string;
  lastActivityAt: string | null;
  archived: boolean;
  owner: { id: string; name: string } | null;
  company: { id: string; name: string } | null;
  tags: Array<{ id: string; name: string; color: string }>;
  fields: Record<string, FieldValue>;
}

export interface ContactPage {
  rows: ContactRow[];
  total: number;
  page: number;
  pageSize: number;
  smartList: SavedListRef | null;
}

/** Builds the WHERE clause shared by the list, the count, bulk selection and export. $1 is the organization. */
export async function contactWhere(db: Queryable, actor: CrmActor, q: Pick<ContactListQuery, "smartListId" | "filter" | "search" | "archived">, params: unknown[]): Promise<{ where: string; smartList: SavedListRef | null }> {
  const metas = await loadCustomFieldMetas(db, actor.orgId);
  const ctx: CompileContext = { params, userId: actor.userId, timezone: actor.timezone, customFields: metas };
  const parts = ["c.org_id = $1", "c.deleted_at is null"];
  const archived = q.archived ?? "exclude";
  if (archived === "exclude") parts.push("c.archived_at is null");
  if (archived === "only") parts.push("c.archived_at is not null");
  let smartList: SavedListRef | null = null;
  if (q.smartListId) {
    smartList = await loadSmartList(db, actor, q.smartListId, "contact");
    parts.push(compileContactFilter(smartList.filter, ctx));
  }
  if (q.filter) parts.push(compileContactFilter(parseFilterOrThrow(q.filter), ctx));
  const search = q.search ? contactSearchCondition(q.search, ctx) : null;
  if (search) parts.push(search);
  return { where: parts.join(" and "), smartList };
}

export async function listContacts(actor: CrmActor, q: ContactListQuery = {}): Promise<ContactPage> {
  assertCan(actor, "contacts.view");
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(q.pageSize ?? 25)));
  const page = Math.max(1, Math.trunc(q.page ?? 1));
  return crmRead(actor, async (db) => {
    const params: unknown[] = [actor.orgId];
    const { where, smartList } = await contactWhere(db, actor, q, params);
    const sort = q.sort ?? smartList?.sort;
    // A text search can match one contact or thousands, and PostgreSQL can't tell which from a %term% pattern: walking the directory's order
    // index until a page fills is quick for a common term but reads the whole workspace one row at a time for a rare one. So a search is
    // matched first (OFFSET 0 keeps the order and limit out of that sub-select), only the matches are sorted, and the same pass counts them,
    // so a search reads the workspace once instead of once for the page and again for the total.
    const searching = Boolean(q.search?.trim());
    const { rows } = await db.query<{
      id: string; display_name: string; email: string | null; phone: string | null; lead_status: LeadStatus; lead_score: number | null; source: string; created_via: CreatedVia;
      city: string | null; country: string | null; created_at: Date; last_activity_at: Date | null; archived_at: Date | null; assigned_user_id: string | null; owner_name: string | null; full_count?: string;
    }>(
      `select c.id, c.display_name, c.email::text as email, c.phone, c.lead_status, c.lead_score, c.source, c.created_via, c.city, c.country, c.created_at, c.last_activity_at,
              c.archived_at, c.assigned_user_id, nullif(u.full_name, '') as owner_name${searching ? ", (count(*) over ())::text as full_count" : ""}
       from ${searching ? `(select * from contacts c where ${where} offset 0) c` : "contacts c"} left join users u on u.id = c.assigned_user_id
       where ${searching ? "true" : where} order by ${contactOrderBy(sort)} limit ${pageSize} offset ${(page - 1) * pageSize}`,
      params,
    );
    const count = async () => Number((await db.query<{ n: string }>(`select count(*)::text as n from contacts c where ${where}`, params)).rows[0].n);
    const total = searching && rows[0]?.full_count !== undefined ? Number(rows[0].full_count) : await pageTotal(page, pageSize, rows.length, count);
    const ids = rows.map((r) => r.id);
    const [tags, companies, fieldValues] = ids.length
      ? await Promise.all([
          db.query<{ contact_id: string; id: string; name: string; color: string }>(
            "select ct.contact_id, t.id, t.name::text as name, t.color from crm_contact_tags ct join crm_tags t on t.id = ct.tag_id where ct.org_id = $1 and ct.contact_id = any($2::uuid[]) order by lower(t.name::text)",
            [actor.orgId, ids],
          ),
          actor.can("companies.view")
            ? db.query<{ contact_id: string; id: string; name: string }>(
                `select distinct on (cc.contact_id) cc.contact_id, co.id, co.name from crm_contact_companies cc join crm_companies co on co.id = cc.company_id and co.deleted_at is null
                 where cc.org_id = $1 and cc.contact_id = any($2::uuid[]) order by cc.contact_id, cc.is_primary desc, co.name`,
                [actor.orgId, ids],
              )
            : Promise.resolve({ rows: [] as Array<{ contact_id: string; id: string; name: string }>, rowCount: 0 }),
          fieldColumns(db, actor.orgId, ids, q.columns ?? smartList?.columns ?? []),
        ])
      : [{ rows: [] }, { rows: [] }, new Map<string, Record<string, FieldValue>>()] as const;
    const tagsBy = new Map<string, ContactRow["tags"]>();
    for (const t of tags.rows) tagsBy.set(t.contact_id, [...(tagsBy.get(t.contact_id) ?? []), { id: t.id, name: t.name, color: t.color }]);
    const companyBy = new Map(companies.rows.map((c) => [c.contact_id, { id: c.id, name: c.name }]));
    return {
      rows: rows.map((r) => ({
        id: r.id, displayName: r.display_name, email: r.email, phone: r.phone, leadStatus: r.lead_status, leadScore: r.lead_score, source: r.source, createdVia: r.created_via,
        city: r.city, country: r.country, createdAt: new Date(r.created_at).toISOString(), lastActivityAt: r.last_activity_at ? new Date(r.last_activity_at).toISOString() : null,
        archived: Boolean(r.archived_at), owner: r.assigned_user_id ? { id: r.assigned_user_id, name: r.owner_name ?? "Teammate" } : null,
        company: companyBy.get(r.id) ?? null, tags: tagsBy.get(r.id) ?? [], fields: fieldValues.get(r.id) ?? {},
      })),
      total,
      page,
      pageSize,
      smartList,
    };
  });
}

/** Values of the custom-field columns a view shows, for one page of records, in one query. */
async function fieldColumns(db: Queryable, orgId: string, entityIds: string[], columns: string[]): Promise<Map<string, Record<string, FieldValue>>> {
  const fieldIds = columns.filter((c) => c.startsWith("cf:")).map((c) => c.slice(3)).filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  const out = new Map<string, Record<string, FieldValue>>();
  if (!fieldIds.length || !entityIds.length) return out;
  const { rows } = await db.query<{ entity_id: string; field_id: string; type: FieldType; value_text: string | null; value_number: string | null; value_date: string | null; value_ts: Date | null; value_bool: boolean | null; value_list: string[] | null }>(
    `select v.entity_id, v.field_id, f.type, v.value_text, v.value_number::text as value_number, v.value_date::text as value_date, v.value_ts, v.value_bool, v.value_list
     from crm_field_values v join crm_custom_fields f on f.id = v.field_id where v.org_id = $1 and v.entity_id = any($2::uuid[]) and v.field_id = any($3::uuid[])`,
    [orgId, entityIds, fieldIds],
  );
  for (const r of rows) {
    const rec = out.get(r.entity_id) ?? {};
    rec[r.field_id] = readStoredValue(r.type, { ...r, value_ts: r.value_ts ? new Date(r.value_ts).toISOString() : null });
    out.set(r.entity_id, rec);
  }
  return out;
}

/** How many contacts a filter matches right now. */
export async function countContacts(actor: CrmActor, q: Pick<ContactListQuery, "smartListId" | "filter" | "search" | "archived">): Promise<number> {
  assertCan(actor, "contacts.view");
  return crmRead(actor, async (db) => {
    const params: unknown[] = [actor.orgId];
    const { where } = await contactWhere(db, actor, q, params);
    return Number((await db.query<{ n: string }>(`select count(*)::text as n from contacts c where ${where}`, params)).rows[0].n);
  });
}

/** Every matching contact id (for "select all matching" bulk actions), capped. */
export async function matchingContactIds(actor: CrmActor, q: Pick<ContactListQuery, "smartListId" | "filter" | "search" | "archived">, cap = 5000): Promise<string[]> {
  assertCan(actor, "contacts.view");
  return crmRead(actor, async (db) => {
    const params: unknown[] = [actor.orgId];
    const { where } = await contactWhere(db, actor, q, params);
    const { rows } = await db.query<{ id: string }>(`select c.id from contacts c where ${where} order by c.created_at limit ${Math.min(cap, 5000)}`, params);
    return rows.map((r) => r.id);
  });
}

/**
 * Reads matching contacts in id order, one page at a time, each page in its own short transaction (no long-held connection),
 * for exports. Stops after `max` rows.
 */
export async function* iterateContacts(actor: CrmActor, q: Pick<ContactListQuery, "smartListId" | "filter" | "search" | "archived">, opts: { batch?: number; max?: number } = {}) {
  assertCan(actor, "contacts.view");
  const batch = Math.min(1000, opts.batch ?? 500);
  const max = opts.max ?? 100_000;
  let after: string | null = null;
  let sent = 0;
  while (sent < max) {
    const rows = await crmRead(actor, async (db) => {
      const params: unknown[] = [actor.orgId];
      const { where } = await contactWhere(db, actor, q, params);
      params.push(after);
      const res = await db.query<{ id: string }>(`select c.id from contacts c where ${where} and ($${params.length}::uuid is null or c.id > $${params.length}::uuid) order by c.id limit ${batch}`, params);
      return res.rows.map((r) => r.id);
    });
    if (!rows.length) return;
    yield rows.slice(0, max - sent);
    sent += rows.length;
    after = rows[rows.length - 1];
    if (rows.length < batch) return;
  }
}

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------

export interface CompanyListQuery {
  smartListId?: string | null;
  filter?: unknown;
  search?: string;
  sort?: { by?: string; dir?: "asc" | "desc" };
  page?: number;
  pageSize?: number;
  archived?: "exclude" | "only" | "include";
}

export interface CompanyRow {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  city: string | null;
  country: string | null;
  phone: string | null;
  owner: { id: string; name: string } | null;
  contactCount: number;
  openOpportunities: number;
  tags: Array<{ id: string; name: string; color: string }>;
  archived: boolean;
  createdAt: string;
}

export async function listCompanies(actor: CrmActor, q: CompanyListQuery = {}): Promise<{ rows: CompanyRow[]; total: number; page: number; pageSize: number }> {
  assertCan(actor, "companies.view");
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(q.pageSize ?? 25)));
  const page = Math.max(1, Math.trunc(q.page ?? 1));
  return crmRead(actor, async (db) => {
    const params: unknown[] = [actor.orgId];
    const ctx: CompileContext = { params, userId: actor.userId, timezone: actor.timezone, customFields: await loadCustomFieldMetas(db, actor.orgId) };
    const parts = ["co.org_id = $1", "co.deleted_at is null"];
    const archived = q.archived ?? "exclude";
    if (archived === "exclude") parts.push("co.archived_at is null");
    if (archived === "only") parts.push("co.archived_at is not null");
    let sort = q.sort;
    if (q.smartListId) {
      const list = await loadSmartList(db, actor, q.smartListId, "company");
      parts.push(compileCompanyFilter(list.filter, ctx));
      sort ??= list.sort;
    }
    if (q.filter) parts.push(compileCompanyFilter(parseFilterOrThrow(q.filter ?? EMPTY_FILTER), ctx));
    const term = q.search?.trim().toLowerCase().slice(0, 120);
    if (term) {
      params.push(`%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
      parts.push(`co.search_text like $${params.length} escape '\\'`);
    }
    const where = parts.join(" and ");
    const { rows } = await db.query<{ id: string; name: string; domain: string | null; industry: string | null; city: string | null; country: string | null; phone: string | null; owner_user_id: string | null; owner_name: string | null; contacts: string; opps: string; archived_at: Date | null; created_at: Date }>(
      `select co.id, co.name, co.domain::text as domain, co.industry, co.city, co.country, co.phone, co.owner_user_id, nullif(u.full_name, '') as owner_name, co.archived_at, co.created_at,
              (select count(*) from crm_contact_companies cc join contacts c on c.id = cc.contact_id and c.deleted_at is null where cc.company_id = co.id)::text as contacts,
              (select count(*) from crm_opportunities o where o.org_id = co.org_id and o.company_id = co.id and o.status = 'open' and o.archived_at is null)::text as opps
       from crm_companies co left join users u on u.id = co.owner_user_id where ${where} order by ${companyOrderBy(sort)} limit ${pageSize} offset ${(page - 1) * pageSize}`,
      params,
    );
    const total = await pageTotal(page, pageSize, rows.length, async () => Number((await db.query<{ n: string }>(`select count(*)::text as n from crm_companies co where ${where}`, params)).rows[0].n));
    const ids = rows.map((r) => r.id);
    const tags = ids.length
      ? await db.query<{ company_id: string; id: string; name: string; color: string }>("select ct.company_id, t.id, t.name::text as name, t.color from crm_company_tags ct join crm_tags t on t.id = ct.tag_id where ct.org_id = $1 and ct.company_id = any($2::uuid[])", [actor.orgId, ids])
      : { rows: [] };
    const tagsBy = new Map<string, CompanyRow["tags"]>();
    for (const t of tags.rows) tagsBy.set(t.company_id, [...(tagsBy.get(t.company_id) ?? []), { id: t.id, name: t.name, color: t.color }]);
    return {
      rows: rows.map((r) => ({
        id: r.id, name: r.name, domain: r.domain, industry: r.industry, city: r.city, country: r.country, phone: r.phone,
        owner: r.owner_user_id ? { id: r.owner_user_id, name: r.owner_name ?? "Teammate" } : null, contactCount: Number(r.contacts), openOpportunities: Number(r.opps),
        tags: tagsBy.get(r.id) ?? [], archived: Boolean(r.archived_at), createdAt: new Date(r.created_at).toISOString(),
      })),
      total,
      page,
      pageSize,
    };
  });
}
