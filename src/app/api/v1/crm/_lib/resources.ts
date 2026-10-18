import "server-only";
import type { Queryable } from "@/server/db";
import type { CrmActor } from "@/server/crm/actor";
import { contactWhere } from "@/server/crm/directory";
import { ApiError, encodeCursor } from "./http";

// The public shapes of CRM records in API version 2026-10-01 (docs/crm-api.md). They are deliberately separate from the screens' types so
// the API stays stable when the screens change. Every query names the organization of the API key.

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

export interface ApiContact {
  id: string;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  emails: string[];
  phones: string[];
  leadStatus: string;
  leadScore: number | null;
  source: string;
  ownerId: string | null;
  timezone: string | null;
  preferredLanguage: string | null;
  preferredChannel: string | null;
  address: { line1: string | null; line2: string | null; city: string | null; region: string | null; postalCode: string | null; country: string | null };
  tags: Array<{ id: string; name: string }>;
  archived: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

type ContactRow = {
  id: string; display_name: string; first_name: string | null; last_name: string | null; email: string | null; phone: string | null; lead_status: string; lead_score: number | null; source: string;
  assigned_user_id: string | null; timezone: string | null; preferred_language: string | null; preferred_channel: string | null; address_line1: string | null; address_line2: string | null;
  city: string | null; region: string | null; postal_code: string | null; country: string | null; archived_at: Date | null; version: number; created_at: Date; updated_at: Date;
};

/** Contacts by id, in the order given; missing or deleted ones are left out. */
export async function contactsByIds(db: Queryable, orgId: string, ids: string[]): Promise<ApiContact[]> {
  if (!ids.length) return [];
  const { rows } = await db.query<ContactRow>(
    `select id, display_name, first_name, last_name, email::text as email, phone, lead_status, lead_score, source, assigned_user_id, timezone, preferred_language, preferred_channel,
            address_line1, address_line2, city, region, postal_code, country, archived_at, version, created_at, updated_at
     from contacts where org_id = $1 and id = any($2::uuid[]) and deleted_at is null`,
    [orgId, ids],
  );
  const [identities, tags] = await Promise.all([
    db.query<{ contact_id: string; kind: "email" | "phone"; value: string }>("select contact_id, kind, value from contact_identities where org_id = $1 and contact_id = any($2::uuid[]) order by created_at", [orgId, ids]),
    db.query<{ contact_id: string; id: string; name: string }>(
      "select ct.contact_id, t.id, t.name::text as name from crm_contact_tags ct join crm_tags t on t.id = ct.tag_id where ct.org_id = $1 and ct.contact_id = any($2::uuid[]) order by lower(t.name::text)",
      [orgId, ids],
    ),
  ]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const r = byId.get(id);
    if (!r) return [];
    const ident = identities.rows.filter((i) => i.contact_id === id);
    return [{
      id: r.id, displayName: r.display_name, firstName: r.first_name, lastName: r.last_name, email: r.email, phone: r.phone,
      emails: ident.filter((i) => i.kind === "email").map((i) => i.value), phones: ident.filter((i) => i.kind === "phone").map((i) => i.value),
      leadStatus: r.lead_status, leadScore: r.lead_score, source: r.source, ownerId: r.assigned_user_id, timezone: r.timezone, preferredLanguage: r.preferred_language,
      preferredChannel: r.preferred_channel,
      address: { line1: r.address_line1, line2: r.address_line2, city: r.city, region: r.region, postalCode: r.postal_code, country: r.country },
      tags: tags.rows.filter((t) => t.contact_id === id).map((t) => ({ id: t.id, name: t.name })), archived: Boolean(r.archived_at), version: r.version,
      createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(),
    }];
  });
}

export async function contactOr404(db: Queryable, orgId: string, id: string): Promise<ApiContact> {
  const [c] = await contactsByIds(db, orgId, [id]);
  if (!c) throw new ApiError(404, "not_found", "Contact not found.");
  return c;
}

export interface Page<T> {
  data: T[];
  pagination: { hasMore: boolean; nextCursor: string | null };
}

/** Contacts newest first, searched exactly as the Contacts screen searches (name, email, phone digits), with keyset pagination. */
export async function listContactsPage(db: Queryable, actor: CrmActor, q: { limit: number; cursor: { sortValue: string; id: string } | null; search?: string; updatedSince?: Date | null; includeArchived?: boolean }): Promise<Page<ApiContact>> {
  const params: unknown[] = [actor.orgId];
  const { where } = await contactWhere(db, actor, { search: q.search, archived: q.includeArchived ? "include" : "exclude" }, params);
  let extra = "";
  if (q.updatedSince) {
    params.push(q.updatedSince);
    extra += ` and c.updated_at >= $${params.length}`;
  }
  if (q.cursor) {
    params.push(q.cursor.sortValue, q.cursor.id);
    extra += ` and (c.created_at, c.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
  }
  params.push(q.limit + 1);
  const { rows } = await db.query<{ id: string; created_key: string }>(`select c.id, c.created_at::text as created_key from contacts c where ${where}${extra} order by c.created_at desc, c.id desc limit $${params.length}`, params);
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    data: await contactsByIds(db, actor.orgId, page.map((r) => r.id)),
    pagination: { hasMore: rows.length > q.limit, nextCursor: rows.length > q.limit && last ? encodeCursor(last.created_key, last.id) : null },
  };
}

// ---------------------------------------------------------------------------
// Deals
// ---------------------------------------------------------------------------

export interface ApiOpportunity {
  id: string;
  name: string;
  status: string;
  pipelineId: string;
  stageId: string;
  stageName: string | null;
  value: number | null;
  currency: string;
  contactId: string | null;
  companyId: string | null;
  ownerId: string | null;
  expectedCloseDate: string | null;
  probability: number | null;
  source: string | null;
  lostReason: string | null;
  tags: Array<{ id: string; name: string }>;
  version: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

type OppRow = {
  id: string; name: string; status: string; pipeline_ref: string; stage_ref: string; stage_name: string | null; monetary_value: string | null; currency: string; contact_id: string | null;
  company_id: string | null; assigned_user_id: string | null; expected_close_date: string | null; probability: number | null; source: string | null; lost_reason: string | null; version: number;
  created_at: Date; created_key: string; updated_at: Date; closed_at: Date | null;
};

const OPP_COLUMNS = `o.id, o.name, o.status, o.pipeline_ref::text as pipeline_ref, o.stage_ref::text as stage_ref, coalesce(s.name, o.stage_name) as stage_name, o.monetary_value::text as monetary_value,
  o.currency, o.contact_id, o.company_id, o.assigned_user_id, o.expected_close_date::text as expected_close_date, o.probability, o.source, o.lost_reason, o.version, o.created_at, o.created_at::text as created_key, o.updated_at, o.closed_at`;

async function toOpportunities(db: Queryable, orgId: string, rows: OppRow[]): Promise<ApiOpportunity[]> {
  const ids = rows.map((r) => r.id);
  const tags = ids.length
    ? await db.query<{ opportunity_id: string; id: string; name: string }>("select ot.opportunity_id, t.id, t.name::text as name from crm_opportunity_tags ot join crm_tags t on t.id = ot.tag_id where ot.org_id = $1 and ot.opportunity_id = any($2::uuid[]) order by lower(t.name::text)", [orgId, ids])
    : { rows: [] as Array<{ opportunity_id: string; id: string; name: string }> };
  return rows.map((r) => ({
    id: r.id, name: r.name, status: r.status, pipelineId: r.pipeline_ref, stageId: r.stage_ref, stageName: r.stage_name, value: r.monetary_value === null ? null : Number(r.monetary_value),
    currency: r.currency, contactId: r.contact_id, companyId: r.company_id, ownerId: r.assigned_user_id, expectedCloseDate: r.expected_close_date, probability: r.probability, source: r.source,
    lostReason: r.lost_reason, tags: tags.rows.filter((t) => t.opportunity_id === r.id).map((t) => ({ id: t.id, name: t.name })), version: r.version,
    createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(), closedAt: iso(r.closed_at),
  }));
}

export async function opportunityOr404(db: Queryable, orgId: string, id: string): Promise<ApiOpportunity> {
  const { rows } = await db.query<OppRow>(
    `select ${OPP_COLUMNS} from crm_opportunities o left join crm_pipeline_stages s on s.id = o.stage_ref and s.org_id = o.org_id
     where o.org_id = $1 and o.id = $2 and o.provider = 'native' and o.archived_at is null`,
    [orgId, id],
  );
  if (!rows[0]) throw new ApiError(404, "not_found", "Deal not found.");
  return (await toOpportunities(db, orgId, rows))[0];
}

export async function listOpportunitiesPage(db: Queryable, orgId: string, q: { limit: number; cursor: { sortValue: string; id: string } | null; pipelineId?: string | null; stageId?: string | null; status?: string | null; contactId?: string | null; updatedSince?: Date | null }): Promise<Page<ApiOpportunity>> {
  const params: unknown[] = [orgId];
  const where = ["o.org_id = $1", "o.provider = 'native'", "o.archived_at is null"];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace("?", `$${params.length}`));
  };
  if (q.pipelineId) add("o.pipeline_ref = ?::uuid", q.pipelineId);
  if (q.stageId) add("o.stage_ref = ?::uuid", q.stageId);
  if (q.status) add("o.status = ?", q.status);
  if (q.contactId) add("o.contact_id = ?::uuid", q.contactId);
  if (q.updatedSince) add("o.updated_at >= ?", q.updatedSince);
  if (q.cursor) {
    params.push(q.cursor.sortValue, q.cursor.id);
    where.push(`(o.created_at, o.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(q.limit + 1);
  const { rows } = await db.query<OppRow>(
    `select ${OPP_COLUMNS} from crm_opportunities o left join crm_pipeline_stages s on s.id = o.stage_ref and s.org_id = o.org_id
     where ${where.join(" and ")} order by o.created_at desc, o.id desc limit $${params.length}`,
    params,
  );
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    data: await toOpportunities(db, orgId, page),
    pagination: { hasMore: rows.length > q.limit, nextCursor: rows.length > q.limit && last ? encodeCursor(last.created_key, last.id) : null },
  };
}

// ---------------------------------------------------------------------------
// Appointments
// ---------------------------------------------------------------------------

export interface ApiAppointment {
  id: string;
  title: string;
  status: string;
  startAt: string;
  endAt: string;
  calendarId: string | null;
  appointmentTypeId: string | null;
  contactId: string | null;
  hostIds: string[];
  location: string | null;
  meetingLink: string | null;
  bookedVia: string | null;
  version: number;
}

export async function listAppointmentsPage(db: Queryable, orgId: string, q: { limit: number; cursor: { sortValue: string; id: string } | null; from: Date; to: Date | null; status?: string | null; contactId?: string | null; calendarId?: string | null }): Promise<Page<ApiAppointment>> {
  const params: unknown[] = [orgId, q.from];
  const where = ["a.org_id = $1", "a.provider = 'native'", "a.end_at > $2"];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace("?", `$${params.length}`));
  };
  if (q.to) add("a.start_at < ?", q.to);
  if (q.status) add("a.status = ?", q.status === "no_show" ? "noshow" : q.status);
  if (q.contactId) add("a.contact_id = ?::uuid", q.contactId);
  if (q.calendarId) add("a.calendar_ref = ?::uuid", q.calendarId);
  if (q.cursor) {
    params.push(q.cursor.sortValue, q.cursor.id);
    where.push(`(a.start_at, a.id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(q.limit + 1);
  const { rows } = await db.query<{ id: string; title: string; status: string; start_at: Date; end_at: Date; calendar_ref: string | null; appointment_type_id: string | null; contact_id: string | null; location: string | null; meeting_link: string | null; booked_via: string | null; version: number; host_ids: string[] | null; start_key: string }>(
    `select a.id, a.title, a.status, a.start_at, a.start_at::text as start_key, a.end_at, a.calendar_ref, a.appointment_type_id, a.contact_id, a.location, a.meeting_link, a.booked_via, a.version,
            (select array_agg(h.user_id::text order by h.user_id) from crm_appointment_hosts h where h.appointment_id = a.id) as host_ids
     from appointment_refs a where ${where.join(" and ")} order by a.start_at, a.id limit $${params.length}`,
    params,
  );
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    data: page.map((r) => ({
      id: r.id, title: r.title, status: r.status === "noshow" ? "no_show" : r.status, startAt: new Date(r.start_at).toISOString(), endAt: new Date(r.end_at).toISOString(), calendarId: r.calendar_ref,
      appointmentTypeId: r.appointment_type_id, contactId: r.contact_id, hostIds: r.host_ids ?? [], location: r.location, meetingLink: r.meeting_link, bookedVia: r.booked_via, version: r.version,
    })),
    pagination: { hasMore: rows.length > q.limit, nextCursor: rows.length > q.limit && last ? encodeCursor(last.start_key, last.id) : null },
  };
}
