import "server-only";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { assertCan, auditActor, crmRead, crmWrite, type CrmActor } from "@/server/crm/actor";
import { assertNativeOwner } from "@/server/crm/workspace";
import { emitEvent, recordActivity } from "@/server/crm/events";
import { readFieldValues, writeFieldValues, type RecordFieldValue } from "@/server/crm/fields";
import { assertAssignable } from "@/server/crm/contacts";
import { normalizeEmail, normalizePhone } from "@/lib/messaging";

export interface CompanyInput {
  name: string;
  domain?: string | null;
  website?: string | null;
  industry?: string | null;
  phone?: string | null;
  email?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  country?: string | null;
  description?: string | null;
  ownerId?: string | null;
  customFields?: Record<string, unknown>;
}

const clean = (v: string | null | undefined, max: number) => {
  const s = (v ?? "").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
};

/** example.com from "https://www.example.com/about" or "Example.com". Null when it isn't a real domain. */
export function normalizeDomain(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim().toLowerCase();
  if (!s) return null;
  let host = s;
  try {
    host = new URL(/^https?:\/\//.test(s) ? s : `https://${s}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^www\./, "");
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host) && host.length <= 253 ? host : null;
}

function normalize(input: CompanyInput, callingCode: string | null) {
  const name = clean(input.name, 200);
  if (!name) throw new AppError("invalid_input", "Give the company a name.");
  const domain = input.domain ? normalizeDomain(input.domain) : input.website ? normalizeDomain(input.website) : null;
  if (input.domain && !domain) throw new AppError("invalid_input", "That domain doesn't look right. Use something like example.com.");
  let website: string | null = null;
  if (input.website?.trim()) {
    try {
      const u = new URL(/^https?:\/\//i.test(input.website.trim()) ? input.website.trim() : `https://${input.website.trim()}`);
      if (!["http:", "https:"].includes(u.protocol) || !u.hostname.includes(".")) throw new Error("bad");
      website = u.toString().slice(0, 300);
    } catch {
      throw new AppError("invalid_input", "That website address doesn't look right.");
    }
  }
  const phone = input.phone?.trim() ? normalizePhone(input.phone, callingCode ?? undefined) : null;
  if (input.phone?.trim() && !phone) throw new AppError("invalid_input", "Enter the company phone with its country code.");
  const email = input.email?.trim() ? normalizeEmail(input.email) : null;
  if (input.email?.trim() && !email) throw new AppError("invalid_input", "Enter a valid company email.");
  const country = input.country?.trim() ? input.country.trim().toUpperCase() : null;
  if (country && !/^[A-Z]{2}$/.test(country)) throw new AppError("invalid_input", "Use a two-letter country code, such as PH or US.");
  return {
    name, domain, website, industry: clean(input.industry, 120), phone, email, addressLine1: clean(input.addressLine1, 200), addressLine2: clean(input.addressLine2, 200),
    city: clean(input.city, 100), region: clean(input.region, 100), postalCode: clean(input.postalCode, 20), country, description: input.description?.trim().slice(0, 2000) || null,
  };
}

async function callingCode(db: Queryable, orgId: string) {
  return (await db.query<{ c: string | null }>("select default_calling_code as c from crm_workspaces where org_id = $1", [orgId])).rows[0]?.c ?? null;
}

export async function createCompanyInTx(db: Queryable, actor: CrmActor, input: CompanyInput, via: "manual" | "import" | "form" | "api" | "agent" | "workflow" | "ghl_migration" = "manual", opts: { onDuplicate?: "error" | "return_existing" } = {}): Promise<{ id: string; created: boolean }> {
  await assertNativeOwner(db, actor.orgId, "companies");
  const n = normalize(input, await callingCode(db, actor.orgId));
  if (n.domain) {
    const dup = await db.query<{ id: string; name: string }>("select id, name from crm_companies where org_id = $1 and domain = $2 and deleted_at is null", [actor.orgId, n.domain]);
    if (dup.rows[0]) {
      if (opts.onDuplicate === "return_existing") return { id: dup.rows[0].id, created: false };
      throw new AppError("conflict", `${dup.rows[0].name} already uses ${n.domain}.`);
    }
  }
  if (input.ownerId) await assertAssignable(db, actor.orgId, input.ownerId);
  const { rows } = await db.query<{ id: string }>(
    `insert into crm_companies (org_id, name, domain, website, industry, phone, email, address_line1, address_line2, city, region, postal_code, country, description, owner_user_id, created_by, created_via)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) returning id`,
    [actor.orgId, n.name, n.domain, n.website, n.industry, n.phone, n.email, n.addressLine1, n.addressLine2, n.city, n.region, n.postalCode, n.country, n.description, input.ownerId ?? null,
      actor.kind === "member" || actor.kind === "agency" ? actor.userId : null, via],
  );
  const id = rows[0].id;
  if (input.customFields && Object.keys(input.customFields).length) await writeFieldValues(db, actor, "company", id, input.customFields, { enforceRequired: via === "manual", isNew: true, defaultCallingCode: await callingCode(db, actor.orgId) });
  await emitEvent(db, actor, { type: "company.created", entityType: "company", entityId: id, payload: { via }, dedupeKey: `company.created:${id}` });
  await recordActivity(db, actor, { kind: "company.created", summary: "Company created", companyId: id });
  return { id, created: true };
}

export async function createCompany(actor: CrmActor, input: CompanyInput): Promise<{ id: string }> {
  assertCan(actor, "companies.edit");
  return crmWrite(actor, async (db) => {
    const r = await createCompanyInTx(db, actor, input, actor.kind === "agent" ? "agent" : actor.kind === "api" ? "api" : "manual");
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.company_created", targetType: "crm_company", targetId: r.id, result: "success" }, db);
    return { id: r.id };
  });
}

export async function updateCompany(actor: CrmActor, id: string, input: Partial<CompanyInput>, expectedVersion?: number): Promise<{ version: number }> {
  assertCan(actor, "companies.edit");
  return crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "companies");
    const { rows } = await db.query<Record<string, unknown> & { version: number; name: string; domain: string | null; owner_user_id: string | null }>(
      "select *, domain::text as domain, email::text as email from crm_companies where id = $1 and org_id = $2 and deleted_at is null for update",
      [id, actor.orgId],
    );
    const cur = rows[0];
    if (!cur) throw new AppError("not_found", "Company not found.");
    if (expectedVersion !== undefined && cur.version !== expectedVersion) throw new AppError("conflict", "Someone else changed this company while you were editing. Reload and try again.");
    const merged: CompanyInput = {
      name: input.name ?? cur.name, domain: "domain" in input ? input.domain : cur.domain, website: "website" in input ? input.website : (cur.website as string | null),
      industry: "industry" in input ? input.industry : (cur.industry as string | null), phone: "phone" in input ? input.phone : (cur.phone as string | null),
      email: "email" in input ? input.email : (cur.email as string | null), addressLine1: "addressLine1" in input ? input.addressLine1 : (cur.address_line1 as string | null),
      addressLine2: "addressLine2" in input ? input.addressLine2 : (cur.address_line2 as string | null), city: "city" in input ? input.city : (cur.city as string | null),
      region: "region" in input ? input.region : (cur.region as string | null), postalCode: "postalCode" in input ? input.postalCode : (cur.postal_code as string | null),
      country: "country" in input ? input.country : (cur.country as string | null), description: "description" in input ? input.description : (cur.description as string | null),
    };
    const n = normalize({ ...merged, domain: merged.domain ?? null, website: "domain" in input ? merged.website : merged.website }, await callingCode(db, actor.orgId));
    if (n.domain && n.domain !== cur.domain) {
      const dup = await db.query<{ name: string }>("select name from crm_companies where org_id = $1 and domain = $2 and deleted_at is null and id <> $3", [actor.orgId, n.domain, id]);
      if (dup.rows[0]) throw new AppError("conflict", `${dup.rows[0].name} already uses ${n.domain}.`);
    }
    let owner = cur.owner_user_id;
    if ("ownerId" in input) {
      if (input.ownerId && input.ownerId !== cur.owner_user_id) {
        assertCan(actor, "contacts.assign", "Changing the company owner needs the assign permission.");
        await assertAssignable(db, actor.orgId, input.ownerId);
      }
      owner = input.ownerId ?? null;
    }
    const res = await db.query<{ version: number }>(
      `update crm_companies set name = $3, domain = $4, website = $5, industry = $6, phone = $7, email = $8, address_line1 = $9, address_line2 = $10, city = $11, region = $12,
         postal_code = $13, country = $14, description = $15, owner_user_id = $16, version = version + 1 where id = $1 and org_id = $2 returning version`,
      [id, actor.orgId, n.name, n.domain, n.website, n.industry, n.phone, n.email, n.addressLine1, n.addressLine2, n.city, n.region, n.postalCode, n.country, n.description, owner],
    );
    if (input.customFields && Object.keys(input.customFields).length) await writeFieldValues(db, actor, "company", id, input.customFields, { enforceRequired: true, defaultCallingCode: await callingCode(db, actor.orgId) });
    await emitEvent(db, actor, { type: "company.updated", entityType: "company", entityId: id, dedupeKey: `company.updated:${id}:v${res.rows[0].version}` });
    await recordActivity(db, actor, { kind: "company.updated", summary: "Company details updated", companyId: id });
    return { version: res.rows[0].version };
  });
}

export async function setCompaniesArchived(actor: CrmActor, ids: string[], archived: boolean): Promise<{ changed: number }> {
  assertCan(actor, "contacts.delete", "Archiving companies needs the archive permission.");
  return crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "companies");
    const res = await db.query(
      archived
        ? "update crm_companies set archived_at = now(), version = version + 1 where org_id = $1 and id = any($2::uuid[]) and deleted_at is null and archived_at is null"
        : "update crm_companies set archived_at = null, version = version + 1 where org_id = $1 and id = any($2::uuid[]) and deleted_at is null and archived_at is not null",
      [actor.orgId, ids.slice(0, 2000)],
    );
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: archived ? "crm.companies_archived" : "crm.companies_restored", targetType: "crm_company", targetId: ids.length === 1 ? ids[0] : `${ids.length} companies`, result: "success" }, db);
    return { changed: res.rowCount };
  });
}

/** Deleting a company unlinks its people (they are kept) and keeps its opportunities without a company. */
export async function deleteCompany(actor: CrmActor, id: string): Promise<void> {
  assertCan(actor, "contacts.delete", "Deleting companies needs the archive permission.");
  await crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "companies");
    const res = await db.query<{ name: string }>("update crm_companies set deleted_at = now(), domain = null where id = $1 and org_id = $2 and deleted_at is null returning name", [id, actor.orgId]);
    if (!res.rows[0]) throw new AppError("not_found", "Company not found.");
    await db.query("delete from crm_contact_companies where org_id = $1 and company_id = $2", [actor.orgId, id]);
    await db.query("update crm_opportunities set company_id = null where org_id = $1 and company_id = $2", [actor.orgId, id]);
    await db.query("delete from crm_field_values where org_id = $1 and entity = 'company' and entity_id = $2", [actor.orgId, id]);
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.company_deleted", targetType: "crm_company", targetId: id, result: "success" }, db);
  });
}

export interface CompanyDetail {
  id: string;
  version: number;
  name: string;
  domain: string | null;
  website: string | null;
  industry: string | null;
  phone: string | null;
  email: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
  description: string | null;
  owner: { id: string; name: string } | null;
  createdVia: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  contacts: Array<{ id: string; displayName: string; email: string | null; phone: string | null; title: string | null; isPrimary: boolean }>;
  opportunities: Array<{ id: string; name: string; status: string; value: number | null; currency: string | null; stage: string | null }>;
  tags: Array<{ id: string; name: string; color: string }>;
  fields: RecordFieldValue[];
}

export async function getCompanyDetail(actor: CrmActor, id: string): Promise<CompanyDetail> {
  assertCan(actor, "companies.view");
  return crmRead(actor, async (db) => {
    const { rows } = await db.query<Record<string, unknown> & { id: string; version: number; name: string; owner_user_id: string | null; owner_name: string | null; created_at: Date; updated_at: Date; archived_at: Date | null }>(
      `select co.*, co.domain::text as domain, co.email::text as email, nullif(u.full_name, '') as owner_name from crm_companies co left join users u on u.id = co.owner_user_id
       where co.id = $1 and co.org_id = $2 and co.deleted_at is null`,
      [id, actor.orgId],
    );
    const c = rows[0];
    if (!c) throw new AppError("not_found", "Company not found.");
    const [contacts, opps, tags] = await Promise.all([
      actor.can("contacts.view")
        ? db.query<{ id: string; display_name: string; email: string | null; phone: string | null; title: string | null; is_primary: boolean }>(
            `select ct.id, ct.display_name, ct.email::text as email, ct.phone, cc.title, cc.is_primary from crm_contact_companies cc join contacts ct on ct.id = cc.contact_id and ct.deleted_at is null
             where cc.org_id = $1 and cc.company_id = $2 order by ct.display_name limit 200`,
            [actor.orgId, id],
          )
        : Promise.resolve({ rows: [] as Array<{ id: string; display_name: string; email: string | null; phone: string | null; title: string | null; is_primary: boolean }>, rowCount: 0 }),
      actor.can("sales.view")
        ? db.query<{ id: string; name: string; status: string; monetary_value: string | null; currency: string | null; stage: string | null }>(
            `select o.id, o.name, o.status, o.monetary_value::text, o.currency, s.name as stage from crm_opportunities o left join crm_pipeline_stages s on s.id = o.stage_ref
             where o.org_id = $1 and o.company_id = $2 and o.archived_at is null order by o.status = 'open' desc, o.updated_at desc limit 100`,
            [actor.orgId, id],
          )
        : Promise.resolve({ rows: [] as Array<{ id: string; name: string; status: string; monetary_value: string | null; currency: string | null; stage: string | null }>, rowCount: 0 }),
      db.query<{ id: string; name: string; color: string }>("select t.id, t.name::text as name, t.color from crm_company_tags ct join crm_tags t on t.id = ct.tag_id where ct.org_id = $1 and ct.company_id = $2 order by lower(t.name::text)", [actor.orgId, id]),
    ]);
    const s = (k: string) => (c[k] as string | null) ?? null;
    return {
      id: c.id, version: c.version, name: c.name, domain: s("domain"), website: s("website"), industry: s("industry"), phone: s("phone"), email: s("email"),
      addressLine1: s("address_line1"), addressLine2: s("address_line2"), city: s("city"), region: s("region"), postalCode: s("postal_code"), country: s("country"), description: s("description"),
      owner: c.owner_user_id ? { id: c.owner_user_id, name: c.owner_name ?? "Teammate" } : null, createdVia: s("created_via") ?? "manual",
      archivedAt: c.archived_at ? new Date(c.archived_at).toISOString() : null, createdAt: new Date(c.created_at).toISOString(), updatedAt: new Date(c.updated_at).toISOString(),
      contacts: contacts.rows.map((r) => ({ id: r.id, displayName: r.display_name, email: r.email, phone: r.phone, title: r.title, isPrimary: r.is_primary })),
      opportunities: opps.rows.map((o) => ({ id: o.id, name: o.name, status: o.status, value: o.monetary_value === null ? null : Number(o.monetary_value), currency: o.currency, stage: o.stage })),
      tags: tags.rows,
      fields: await readFieldValues(db, actor.orgId, "company", id),
    };
  });
}

/** Companies whose name or domain matches, for pickers. */
export async function searchCompanies(actor: CrmActor, q: string, limit = 10): Promise<Array<{ id: string; name: string; domain: string | null }>> {
  assertCan(actor, "companies.view");
  const term = q.trim().toLowerCase().slice(0, 80);
  return crmRead(actor, async (db) => {
    const { rows } = await db.query<{ id: string; name: string; domain: string | null }>(
      `select id, name, domain::text as domain from crm_companies where org_id = $1 and deleted_at is null and archived_at is null
         and ($2 = '' or search_text like '%' || replace(replace(replace($2, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%' escape '\\')
       order by lower(name) limit $3`,
      [actor.orgId, term, Math.min(25, limit)],
    );
    return rows;
  });
}
