import "server-only";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyUser } from "@/server/notifications";
import { assertCan, assertCanCreate, auditActor, crmRead, crmWrite, type CrmActor } from "@/server/crm/actor";
import { assertNativeOwner } from "@/server/crm/workspace";
import { emitEvent, recordActivity } from "@/server/crm/events";
import { readFieldValues, writeFieldValues, type RecordFieldValue } from "@/server/crm/fields";
import { applyContactTags } from "@/server/crm/tags";
import { getConsent, mergeContactsInTx, recordConsent, redactContact } from "@/server/messaging/contacts";
import { normalizeEmail, normalizePhone, CHANNELS, type Channel } from "@/lib/messaging";
import { composeDisplayName, LEAD_STATUSES, PREFERRED_CHANNELS, type CreatedVia, type LeadStatus, type PreferredChannel } from "@/lib/crm/types";

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface ContactInput {
  firstName?: string | null;
  lastName?: string | null;
  displayName?: string | null;
  email?: string | null;
  phone?: string | null;
  /** Extra addresses beyond the primary email and phone. */
  emails?: string[];
  phones?: string[];
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  country?: string | null;
  timezone?: string | null;
  preferredLanguage?: string | null;
  preferredChannel?: PreferredChannel | null;
  source?: string | null;
  leadStatus?: LeadStatus;
  leadScore?: number | null;
  ownerId?: string | null;
  companyId?: string | null;
  companyTitle?: string | null;
  tagIds?: string[];
  customFields?: Record<string, unknown>;
}

const trimOrNull = (v: string | null | undefined, max: number) => {
  const s = (v ?? "").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
};

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface NormalizedContact {
  firstName: string | null;
  lastName: string | null;
  displayName: string;
  emails: string[];
  phones: string[];
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
  timezone: string | null;
  preferredLanguage: string | null;
  preferredChannel: PreferredChannel | null;
  source: string | null;
  leadStatus: LeadStatus | undefined;
  leadScore: number | null | undefined;
}

/** Normalizes what a person typed. Phone numbers without a country code use the workspace's calling code, or are refused. */
export function normalizeContactInput(input: ContactInput, defaultCallingCode: string | null): NormalizedContact {
  const emails: string[] = [];
  for (const raw of [input.email, ...(input.emails ?? [])]) {
    if (!raw || !raw.trim()) continue;
    const e = normalizeEmail(raw);
    if (!e) throw new AppError("invalid_input", `"${raw.slice(0, 60)}" isn't a valid email address.`);
    if (!emails.includes(e)) emails.push(e);
  }
  const phones: string[] = [];
  for (const raw of [input.phone, ...(input.phones ?? [])]) {
    if (!raw || !raw.trim()) continue;
    const p = normalizePhone(raw, defaultCallingCode ?? undefined);
    if (!p) throw new AppError("invalid_input", `"${raw.slice(0, 30)}" needs a country code, like +63 917 123 4567.`);
    if (!phones.includes(p)) phones.push(p);
  }
  const country = input.country ? input.country.trim().toUpperCase() : null;
  if (country && !/^[A-Z]{2}$/.test(country)) throw new AppError("invalid_input", "Use a two-letter country code, such as PH or US.");
  const timezone = trimOrNull(input.timezone, 64);
  if (timezone && !validTimeZone(timezone)) throw new AppError("invalid_input", "Choose a valid time zone.");
  const language = trimOrNull(input.preferredLanguage, 35)?.toLowerCase() ?? null;
  if (language && !/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(language)) throw new AppError("invalid_input", "Use a language code such as en or fil.");
  if (input.preferredChannel && !PREFERRED_CHANNELS.includes(input.preferredChannel)) throw new AppError("invalid_input", "Choose a preferred channel.");
  if (input.leadStatus && !LEAD_STATUSES.includes(input.leadStatus)) throw new AppError("invalid_input", "Choose a lead status.");
  if (input.leadScore !== undefined && input.leadScore !== null && (!Number.isInteger(input.leadScore) || input.leadScore < 0 || input.leadScore > 100)) {
    throw new AppError("invalid_input", "Lead score is a whole number from 0 to 100.");
  }
  const firstName = trimOrNull(input.firstName, 100);
  const lastName = trimOrNull(input.lastName, 100);
  const displayName = composeDisplayName(firstName, lastName, input.displayName);
  return {
    firstName, lastName, displayName, emails, phones,
    addressLine1: trimOrNull(input.addressLine1, 200), addressLine2: trimOrNull(input.addressLine2, 200), city: trimOrNull(input.city, 100),
    region: trimOrNull(input.region, 100), postalCode: trimOrNull(input.postalCode, 20), country, timezone,
    preferredLanguage: language, preferredChannel: input.preferredChannel ?? null, source: trimOrNull(input.source, 60),
    leadStatus: input.leadStatus, leadScore: input.leadScore,
  };
}

async function callingCode(db: Queryable, orgId: string): Promise<string | null> {
  const { rows } = await db.query<{ default_calling_code: string | null }>("select default_calling_code from crm_workspaces where org_id = $1", [orgId]);
  return rows[0]?.default_calling_code ?? null;
}

/** The person must be an active member of this workspace who can see contacts. */
export async function assertAssignable(db: Queryable, orgId: string, userId: string): Promise<{ name: string }> {
  const { rows } = await db.query<{ full_name: string; email: string }>(
    `select u.full_name, u.email::text as email from organization_memberships m join users u on u.id = m.user_id
     where m.org_id = $1 and m.user_id = $2 and m.status = 'active' and u.status = 'active'
       and (m.role = 'owner' or coalesce(
             (select o.effect = 'grant' from member_permission_overrides o where o.org_id = m.org_id and o.user_id = m.user_id and o.permission = 'contacts.view'),
             exists (select 1 from role_permissions rp where rp.role = m.role and rp.permission = 'contacts.view')))`,
    [orgId, userId],
  );
  if (!rows[0]) throw new AppError("invalid_input", "Choose a teammate who can see contacts in this workspace.");
  return { name: rows[0].full_name || rows[0].email };
}

/** Which existing contacts already own any of these addresses. Matching is by exact normalized identifier only, never by name. */
export async function findByIdentities(db: Queryable, orgId: string, emails: string[], phones: string[], excludeId?: string): Promise<Array<{ contactId: string; kind: "email" | "phone"; value: string }>> {
  if (!emails.length && !phones.length) return [];
  const { rows } = await db.query<{ contact_id: string; kind: "email" | "phone"; value: string }>(
    `select i.contact_id, i.kind, i.value from contact_identities i join contacts c on c.id = i.contact_id and c.org_id = i.org_id
     where i.org_id = $1 and c.deleted_at is null and ((i.kind = 'email' and i.value = any($2::text[])) or (i.kind = 'phone' and i.value = any($3::text[])))
       and ($4::uuid is null or i.contact_id <> $4)`,
    [orgId, emails, phones, excludeId ?? null],
  );
  return rows.map((r) => ({ contactId: r.contact_id, kind: r.kind, value: r.value }));
}

export class DuplicateContactError extends AppError {
  constructor(readonly existingContactId: string, value: string) {
    super("conflict", `${value} already belongs to another contact. Open that contact, or merge the two if they are the same person.`);
  }
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateContactOptions {
  via: CreatedVia;
  /** What to do when an email or phone already belongs to a contact: refuse (people creating by hand) or return that contact (forms, bookings). */
  onDuplicate?: "error" | "return_existing";
  tagSource?: Parameters<typeof applyContactTags>[4];
  enforceRequiredFields?: boolean;
  causedBy?: { eventId: number; depth: number } | null;
}

export interface CreateContactResult {
  id: string;
  created: boolean;
}

/** Creates a contact inside the caller's transaction. Used by people, forms, bookings, imports, workflows and AI tools. */
export async function createContactInTx(db: Queryable, actor: CrmActor, input: ContactInput, opts: CreateContactOptions): Promise<CreateContactResult> {
  await assertNativeOwner(db, actor.orgId, "contacts");
  const n = normalizeContactInput(input, await callingCode(db, actor.orgId));
  if (!n.displayName && !n.emails.length && !n.phones.length) throw new AppError("invalid_input", "Give the contact a name, an email or a phone number.");
  const existing = await findByIdentities(db, actor.orgId, n.emails, n.phones);
  if (existing.length) {
    if (opts.onDuplicate === "return_existing") return { id: existing[0].contactId, created: false };
    throw new DuplicateContactError(existing[0].contactId, existing[0].value);
  }
  if (input.ownerId) await assertAssignable(db, actor.orgId, input.ownerId);
  const { rows } = await db.query<{ id: string }>(
    `insert into contacts (org_id, display_name, first_name, last_name, email, phone, address_line1, address_line2, city, region, postal_code, country,
       timezone, preferred_language, preferred_channel, source, lead_status, lead_score, assigned_user_id, created_by, created_via)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21) returning id`,
    [
      actor.orgId, n.displayName, n.firstName, n.lastName, n.emails[0] ?? null, n.phones[0] ?? null, n.addressLine1, n.addressLine2, n.city, n.region, n.postalCode, n.country,
      n.timezone, n.preferredLanguage, n.preferredChannel, n.source ?? opts.via, n.leadStatus ?? "new", n.leadScore ?? null, input.ownerId ?? null,
      actor.kind === "member" || actor.kind === "agency" ? actor.userId : null, opts.via,
    ],
  );
  const id = rows[0].id;
  // Addresses typed or submitted by someone are not proof of ownership, so they start unverified.
  for (const e of n.emails) await db.query("insert into contact_identities (org_id, contact_id, kind, value, verified) values ($1, $2, 'email', $3, false)", [actor.orgId, id, e]);
  for (const p of n.phones) await db.query("insert into contact_identities (org_id, contact_id, kind, value, verified) values ($1, $2, 'phone', $3, false)", [actor.orgId, id, p]);
  if (input.companyId) await linkCompanyInTx(db, actor, id, input.companyId, { title: input.companyTitle ?? null, primary: true });
  if (input.customFields && Object.keys(input.customFields).length) {
    await writeFieldValues(db, actor, "contact", id, input.customFields, { enforceRequired: opts.enforceRequiredFields, isNew: true, defaultCallingCode: await callingCode(db, actor.orgId) });
  } else if (opts.enforceRequiredFields) {
    await writeFieldValues(db, actor, "contact", id, {}, { enforceRequired: true, isNew: true });
  }
  const ev = await emitEvent(db, actor, {
    type: "contact.created", entityType: "contact", entityId: id, contactId: id, payload: { via: opts.via, source: n.source ?? opts.via, ownerId: input.ownerId ?? null },
    dedupeKey: `contact.created:${id}`, causedBy: opts.causedBy,
  });
  await recordActivity(db, actor, { kind: "contact.created", summary: `Contact created (${opts.via.replace(/_/g, " ")})`, contactId: id });
  if (input.tagIds?.length) await applyContactTags(db, actor, [id], input.tagIds, opts.tagSource ?? "manual", ev.id ? { eventId: ev.id, depth: opts.causedBy ? opts.causedBy.depth + 1 : 0 } : opts.causedBy);
  if (input.ownerId && input.ownerId !== actor.userId) {
    await notifyUser(db, input.ownerId, actor.orgId, { kind: "crm_assigned", severity: "info", title: `New contact assigned to you: ${n.displayName || n.emails[0] || n.phones[0]}`, link: `/crm/contacts/${id}`, dedupeKey: `crm-assigned:${id}:${input.ownerId}` });
  }
  return { id, created: true };
}

export async function createContact(actor: CrmActor, input: ContactInput): Promise<CreateContactResult> {
  assertCanCreate(actor, "contacts.create");
  if (input.ownerId && input.ownerId !== actor.userId) assertCan(actor, "contacts.assign", "Assigning contacts to someone else needs the assign permission.");
  return crmWrite(actor, async (db) => {
    const r = await createContactInTx(db, actor, input, { via: actor.kind === "agent" ? "agent" : actor.kind === "api" ? "api" : "manual", onDuplicate: "error", enforceRequiredFields: actor.kind === "member" || actor.kind === "agency" });
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.contact_created", targetType: "contact", targetId: r.id, result: "success" }, db);
    return r;
  });
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export type ContactPatch = Omit<ContactInput, "emails" | "phones" | "tagIds" | "companyId" | "companyTitle" | "ownerId" | "customFields">;

const PATCH_COLUMNS: Array<[keyof NormalizedContact, string]> = [
  ["firstName", "first_name"], ["lastName", "last_name"], ["addressLine1", "address_line1"], ["addressLine2", "address_line2"], ["city", "city"], ["region", "region"],
  ["postalCode", "postal_code"], ["country", "country"], ["timezone", "timezone"], ["preferredLanguage", "preferred_language"], ["preferredChannel", "preferred_channel"], ["source", "source"],
];

/**
 * Edits a contact. `expectedVersion` is the version the editor loaded; if someone else saved in between, the edit is refused so neither
 * change is silently lost. Email and phone go through identities so duplicates stay impossible.
 */
export async function updateContact(actor: CrmActor, id: string, patch: ContactPatch & { customFields?: Record<string, unknown> }, expectedVersion?: number): Promise<{ version: number; changed: string[] }> {
  assertCan(actor, "contacts.edit");
  return crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "contacts");
    const { rows } = await db.query<Record<string, unknown> & { version: number; email: string | null; phone: string | null; lead_status: string; display_name: string }>(
      "select *, email::text as email from contacts where id = $1 and org_id = $2 and deleted_at is null for update",
      [id, actor.orgId],
    );
    const cur = rows[0];
    if (!cur) throw new AppError("not_found", "Contact not found.");
    if (expectedVersion !== undefined && cur.version !== expectedVersion) throw new AppError("conflict", "Someone else changed this contact while you were editing. Reload to see their changes, then try again.");
    const code = await callingCode(db, actor.orgId);
    const n = normalizeContactInput({ ...patch, email: patch.email ?? null, phone: patch.phone ?? null }, code);
    const sets: string[] = [];
    const params: unknown[] = [id, actor.orgId];
    const changed: string[] = [];
    const set = (column: string, value: unknown, key: string) => {
      if ((cur[column] ?? null) === (value ?? null)) return;
      params.push(value);
      sets.push(`${column} = $${params.length}`);
      changed.push(key);
    };
    for (const [key, column] of PATCH_COLUMNS) if (key in patch) set(column, n[key], key);
    if ("leadStatus" in patch && n.leadStatus) set("lead_status", n.leadStatus, "leadStatus");
    if ("leadScore" in patch) set("lead_score", n.leadScore ?? null, "leadScore");
    if ("firstName" in patch || "lastName" in patch || "displayName" in patch) {
      const first = "firstName" in patch ? n.firstName : (cur.first_name as string | null);
      const last = "lastName" in patch ? n.lastName : (cur.last_name as string | null);
      set("display_name", composeDisplayName(first, last, "displayName" in patch ? patch.displayName : cur.display_name), "displayName");
    }
    if ("email" in patch) {
      const email = n.emails[0] ?? null;
      if (email !== cur.email) {
        if (email) await ensureIdentity(db, actor.orgId, id, "email", email);
        set("email", email, "email");
      }
    }
    if ("phone" in patch) {
      const phone = n.phones[0] ?? null;
      if (phone !== cur.phone) {
        if (phone) await ensureIdentity(db, actor.orgId, id, "phone", phone);
        set("phone", phone, "phone");
      }
    }
    if (patch.customFields && Object.keys(patch.customFields).length) {
      const fieldChanges = await writeFieldValues(db, actor, "contact", id, patch.customFields, { enforceRequired: true, defaultCallingCode: code });
      changed.push(...fieldChanges.map((k) => `cf:${k}`));
    }
    if (!changed.length) return { version: cur.version, changed };
    const res = await db.query<{ version: number }>(`update contacts set ${sets.length ? `${sets.join(", ")}, ` : ""}version = version + 1 where id = $1 and org_id = $2 returning version`, params);
    await emitEvent(db, actor, { type: "contact.updated", entityType: "contact", entityId: id, contactId: id, payload: { changed }, dedupeKey: `contact.updated:${id}:v${res.rows[0].version}` });
    if (changed.includes("leadStatus")) {
      await recordActivity(db, actor, { kind: "contact.status_changed", summary: `Lead status changed to ${String(n.leadStatus).replace(/_/g, " ")}`, contactId: id, metadata: { from: cur.lead_status, to: n.leadStatus } });
    } else {
      await recordActivity(db, actor, { kind: "contact.updated", summary: `Details updated (${changed.length} ${changed.length === 1 ? "field" : "fields"})`, contactId: id, metadata: { changed: changed.slice(0, 20) } });
    }
    return { version: res.rows[0].version, changed };
  });
}

async function ensureIdentity(db: Queryable, orgId: string, contactId: string, kind: "email" | "phone", value: string) {
  const owner = await db.query<{ contact_id: string }>(
    `select i.contact_id from contact_identities i join contacts c on c.id = i.contact_id where i.org_id = $1 and i.kind = $2 and i.value = $3 and c.deleted_at is null`,
    [orgId, kind, value],
  );
  if (owner.rows[0] && owner.rows[0].contact_id !== contactId) throw new DuplicateContactError(owner.rows[0].contact_id, value);
  if (!owner.rows[0]) {
    // A stale identity left by a deleted contact is released first, so a real person can reuse their address.
    await db.query("delete from contact_identities i using contacts c where c.id = i.contact_id and c.deleted_at is not null and i.org_id = $1 and i.kind = $2 and i.value = $3", [orgId, kind, value]);
    await db.query("insert into contact_identities (org_id, contact_id, kind, value, verified) values ($1, $2, $3, $4, false)", [orgId, contactId, kind, value]);
  }
}

/** Adds another email or phone to a contact. */
export async function addContactIdentity(actor: CrmActor, contactId: string, input: { kind: "email" | "phone"; value: string }): Promise<void> {
  assertCan(actor, "contacts.edit");
  await crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "contacts");
    const c = await db.query<{ email: string | null; phone: string | null }>("select email::text as email, phone from contacts where id = $1 and org_id = $2 and deleted_at is null for update", [contactId, actor.orgId]);
    if (!c.rows[0]) throw new AppError("not_found", "Contact not found.");
    const value = input.kind === "email" ? normalizeEmail(input.value) : normalizePhone(input.value, (await callingCode(db, actor.orgId)) ?? undefined);
    if (!value) throw new AppError("invalid_input", input.kind === "email" ? "Enter a valid email address." : "Enter the number with its country code, like +63 917 123 4567.");
    await ensureIdentity(db, actor.orgId, contactId, input.kind, value);
    if (input.kind === "email" && !c.rows[0].email) await db.query("update contacts set email = $3, version = version + 1 where id = $1 and org_id = $2", [contactId, actor.orgId, value]);
    if (input.kind === "phone" && !c.rows[0].phone) await db.query("update contacts set phone = $3, version = version + 1 where id = $1 and org_id = $2", [contactId, actor.orgId, value]);
    await recordActivity(db, actor, { kind: "contact.identity_added", summary: input.kind === "email" ? "Email address added" : "Phone number added", contactId });
  });
}

/** Removes an email or phone. The opt-out history for that address is kept (suppressions are by address, not by contact). */
export async function removeContactIdentity(actor: CrmActor, contactId: string, identityId: string): Promise<void> {
  assertCan(actor, "contacts.edit");
  await crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "contacts");
    const { rows } = await db.query<{ kind: "email" | "phone"; value: string }>("delete from contact_identities where id = $1 and org_id = $2 and contact_id = $3 returning kind, value", [identityId, actor.orgId, contactId]);
    if (!rows[0]) throw new AppError("not_found", "That address isn't on this contact.");
    const col = rows[0].kind === "email" ? "email" : "phone";
    const next = await db.query<{ value: string }>("select value from contact_identities where org_id = $1 and contact_id = $2 and kind = $3 order by verified desc, created_at limit 1", [actor.orgId, contactId, rows[0].kind]);
    await db.query(`update contacts set ${col} = case when ${col}::text = $3 then $4 else ${col} end, version = version + 1 where id = $1 and org_id = $2`, [contactId, actor.orgId, rows[0].value, next.rows[0]?.value ?? null]);
    await recordActivity(db, actor, { kind: "contact.identity_removed", summary: rows[0].kind === "email" ? "Email address removed" : "Phone number removed", contactId });
  });
}

// ---------------------------------------------------------------------------
// Ownership, archive, companies
// ---------------------------------------------------------------------------

/** Assigns contacts to a teammate (or nobody). Assigning to yourself needs edit; to anyone else needs assign; many at once needs bulk. */
export async function assignContacts(actor: CrmActor, contactIds: string[], ownerId: string | null): Promise<{ changed: number }> {
  const ids = [...new Set(contactIds)].slice(0, 5000);
  if (ownerId === actor.userId && ids.length === 1) assertCan(actor, "contacts.edit");
  else assertCan(actor, "contacts.assign", "Assigning contacts needs the assign permission.");
  if (ids.length > 1) assertCan(actor, "contacts.bulk", "Changing many contacts at once needs the bulk-edit permission.");
  return crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "contacts");
    const owner = ownerId ? await assertAssignable(db, actor.orgId, ownerId) : null;
    // Lock the rows so two people (or a person and a routing rule) assigning at once resolve to one recorded result.
    const { rows } = await db.query<{ id: string; assigned_user_id: string | null }>(
      "select id, assigned_user_id from contacts where org_id = $1 and id = any($2::uuid[]) and deleted_at is null order by id for update",
      [actor.orgId, ids],
    );
    let changed = 0;
    for (const r of rows) {
      if (r.assigned_user_id === ownerId) continue;
      await db.query("update contacts set assigned_user_id = $3, version = version + 1 where id = $1 and org_id = $2", [r.id, actor.orgId, ownerId]);
      await emitEvent(db, actor, { type: "contact.assigned", entityType: "contact", entityId: r.id, contactId: r.id, payload: { from: r.assigned_user_id, to: ownerId }, dedupeKey: `contact.assigned:${r.id}:${ownerId ?? "none"}:${Date.now()}` });
      await recordActivity(db, actor, { kind: "contact.assigned", summary: owner ? `Assigned to ${owner.name}` : "Unassigned", contactId: r.id, metadata: { from: r.assigned_user_id, to: ownerId } });
      changed++;
    }
    if (ownerId && ownerId !== actor.userId && changed) {
      await notifyUser(db, ownerId, actor.orgId, {
        kind: "crm_assigned", severity: "info", title: changed === 1 ? "A contact was assigned to you" : `${changed} contacts were assigned to you`,
        link: changed === 1 ? `/crm/contacts/${rows.find((r) => r.assigned_user_id !== ownerId)?.id}` : "/crm/contacts?owner=me", dedupeKey: `crm-assign-batch:${ownerId}:${Date.now()}`,
      });
    }
    if (ids.length > 1) await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.contacts_bulk_assigned", targetType: "contact", targetId: `${ids.length} contacts`, result: "success", metadata: { ownerId, changed } }, db);
    return { changed };
  });
}

/** Archived contacts leave lists and automations but keep their whole history and can be restored. */
export async function setContactsArchived(actor: CrmActor, contactIds: string[], archived: boolean): Promise<{ changed: number }> {
  assertCan(actor, "contacts.delete", "Archiving contacts needs the archive permission.");
  const ids = [...new Set(contactIds)].slice(0, 5000);
  if (ids.length > 1) assertCan(actor, "contacts.bulk");
  return crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "contacts");
    const { rows } = await db.query<{ id: string }>(
      archived
        ? "update contacts set archived_at = now(), archived_by = $3, version = version + 1 where org_id = $1 and id = any($2::uuid[]) and deleted_at is null and archived_at is null returning id"
        : "update contacts set archived_at = null, archived_by = null, version = version + 1 where org_id = $1 and id = any($2::uuid[]) and deleted_at is null and archived_at is not null returning id",
      archived ? [actor.orgId, ids, actor.userId] : [actor.orgId, ids],
    );
    for (const r of rows) {
      await emitEvent(db, actor, { type: archived ? "contact.archived" : "contact.restored", entityType: "contact", entityId: r.id, contactId: r.id, dedupeKey: `contact.${archived ? "archived" : "restored"}:${r.id}:${Date.now()}` });
      await recordActivity(db, actor, { kind: archived ? "contact.archived" : "contact.restored", summary: archived ? "Contact archived" : "Contact restored", contactId: r.id });
    }
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: archived ? "crm.contacts_archived" : "crm.contacts_restored", targetType: "contact", targetId: ids.length === 1 ? ids[0] : `${ids.length} contacts`, result: "success", metadata: { changed: rows.length } }, db);
    return { changed: rows.length };
  });
}

export async function linkCompanyInTx(db: Queryable, actor: CrmActor, contactId: string, companyId: string, opts: { title?: string | null; primary?: boolean }) {
  const co = await db.query<{ name: string }>("select name from crm_companies where id = $1 and org_id = $2 and deleted_at is null", [companyId, actor.orgId]);
  if (!co.rows[0]) throw new AppError("not_found", "Company not found.");
  if (opts.primary) await db.query("update crm_contact_companies set is_primary = false where contact_id = $1 and org_id = $2 and is_primary", [contactId, actor.orgId]);
  const res = await db.query(
    `insert into crm_contact_companies (org_id, contact_id, company_id, title, is_primary, created_by) values ($1, $2, $3, $4, $5, $6)
     on conflict (contact_id, company_id) do update set title = coalesce(excluded.title, crm_contact_companies.title), is_primary = excluded.is_primary or crm_contact_companies.is_primary`,
    [actor.orgId, contactId, companyId, opts.title?.trim().slice(0, 120) || null, opts.primary === true, actor.userId],
  );
  if (res.rowCount) await recordActivity(db, actor, { kind: "company.linked", summary: `Linked to ${co.rows[0].name}`, contactId, companyId });
}

export async function linkContactCompany(actor: CrmActor, input: { contactId: string; companyId: string; title?: string | null; primary?: boolean }): Promise<void> {
  assertCan(actor, "contacts.edit");
  await crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "contacts");
    const c = await db.query("select 1 from contacts where id = $1 and org_id = $2 and deleted_at is null", [input.contactId, actor.orgId]);
    if (!c.rows.length) throw new AppError("not_found", "Contact not found.");
    await linkCompanyInTx(db, actor, input.contactId, input.companyId, input);
  });
}

export async function unlinkContactCompany(actor: CrmActor, input: { contactId: string; companyId: string }): Promise<void> {
  assertCan(actor, "contacts.edit");
  await crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "contacts");
    const res = await db.query<{ name: string }>(
      "delete from crm_contact_companies cc using crm_companies co where co.id = cc.company_id and cc.org_id = $1 and cc.contact_id = $2 and cc.company_id = $3 returning co.name",
      [actor.orgId, input.contactId, input.companyId],
    );
    if (res.rows[0]) await recordActivity(db, actor, { kind: "company.unlinked", summary: `No longer linked to ${res.rows[0].name}`, contactId: input.contactId, companyId: input.companyId });
  });
}

// ---------------------------------------------------------------------------
// Consent, merge, privacy
// ---------------------------------------------------------------------------

/** Records consent a person collected outside the platform (for example a signed form). Evidence is required. */
export async function setContactConsent(actor: CrmActor, contactId: string, input: { channel: Channel; purpose: "service" | "marketing"; status: "granted" | "revoked"; evidence: string }): Promise<void> {
  assertCan(actor, "consent.manage", "Only owners and managers can record consent.");
  if (!CHANNELS.includes(input.channel)) throw new AppError("invalid_input", "Choose a channel.");
  if (input.status === "granted" && input.evidence.trim().length < 5) throw new AppError("invalid_input", "Describe where this consent came from (for example: signed intake form, 12 Oct).");
  await crmWrite(actor, async (db) => {
    const c = await db.query("select 1 from contacts where id = $1 and org_id = $2 and deleted_at is null", [contactId, actor.orgId]);
    if (!c.rows.length) throw new AppError("not_found", "Contact not found.");
    const before = await getConsent(db, actor.orgId, contactId, input.channel, input.purpose);
    if (before === input.status) return;
    await recordConsent(db, { orgId: actor.orgId, contactId, channel: input.channel, purpose: input.purpose, status: input.status, source: "staff_recorded", evidence: input.evidence.trim().slice(0, 500), recordedBy: actor.userId });
    await emitEvent(db, actor, { type: "contact.consent_changed", entityType: "contact", entityId: contactId, contactId, payload: { channel: input.channel, purpose: input.purpose, status: input.status }, dedupeKey: `contact.consent:${contactId}:${input.channel}:${input.purpose}:${Date.now()}` });
    await recordActivity(db, actor, { kind: "contact.consent_changed", summary: `${input.purpose === "marketing" ? "Marketing" : "Service"} consent for ${input.channel.toUpperCase()} ${input.status}`, contactId });
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.consent_recorded", targetType: "contact", targetId: contactId, result: "success", metadata: { channel: input.channel, purpose: input.purpose, status: input.status } }, db);
  });
}

export async function mergeCrmContacts(actor: CrmActor, input: { keptId: string; mergedId: string; reason: string }): Promise<{ keptId: string }> {
  assertCan(actor, "contacts.merge", "Only owners and managers can merge contacts.");
  if (input.reason.trim().length < 5) throw new AppError("invalid_input", "Record why these are the same person.");
  return crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "contacts");
    const r = await mergeContactsInTx(db, actor, input);
    await emitEvent(db, actor, { type: "contact.merged", entityType: "contact", entityId: r.keptId, contactId: r.keptId, payload: { mergedContactId: input.mergedId }, dedupeKey: `contact.merged:${input.mergedId}` });
    await recordActivity(db, actor, { kind: "contact.merged", summary: "Another record for this person was merged in", contactId: r.keptId, metadata: { mergedContactId: input.mergedId } });
    return r;
  });
}

/** Privacy erasure: personal details, identifiers and CRM data about the person are removed; opt-outs and the audit trail stay. */
export async function eraseContact(actor: CrmActor, contactId: string, reason: string) {
  assertCan(actor, "contacts.delete");
  assertCan(actor, "consent.manage", "Only owners and managers can process privacy requests.");
  const r = await redactContact(actor, contactId, reason);
  await crmWrite(actor, (db) => emitEvent(db, actor, { type: "contact.erased", entityType: "contact", entityId: contactId, dedupeKey: `contact.erased:${contactId}` }));
  return r;
}

// ---------------------------------------------------------------------------
// Duplicate review
// ---------------------------------------------------------------------------

export interface DuplicateGroup {
  reason: "same_name" | "same_name_and_company";
  contacts: Array<{ id: string; displayName: string; email: string | null; phone: string | null; createdAt: string; company: string | null }>;
}

/**
 * People who might be the same person. Email and phone can never be shared, so what is left is a name match; that is only ever a
 * suggestion for a person to review, never an automatic merge.
 */
export async function findDuplicateCandidates(actor: CrmActor, limit = 50): Promise<DuplicateGroup[]> {
  assertCan(actor, "contacts.merge");
  return crmRead(actor, async (db) => {
    const { rows } = await db.query<{ key: string; ids: string[] }>(
      `select lower(regexp_replace(display_name, '\\s+', ' ', 'g')) as key, array_agg(id order by created_at) as ids from contacts
       where org_id = $1 and deleted_at is null and archived_at is null and char_length(btrim(display_name)) >= 3
       group by 1 having count(*) between 2 and 10 order by count(*) desc, 1 limit $2`,
      [actor.orgId, Math.min(200, limit)],
    );
    if (!rows.length) return [];
    const ids = rows.flatMap((r) => r.ids);
    const details = await db.query<{ id: string; display_name: string; email: string | null; phone: string | null; created_at: Date; company: string | null }>(
      `select c.id, c.display_name, c.email::text as email, c.phone, c.created_at,
              (select co.name from crm_contact_companies cc join crm_companies co on co.id = cc.company_id where cc.contact_id = c.id order by cc.is_primary desc limit 1) as company
       from contacts c where c.org_id = $1 and c.id = any($2::uuid[])`,
      [actor.orgId, ids],
    );
    const byId = new Map(details.rows.map((d) => [d.id, d]));
    return rows.map((r) => {
      const contacts = r.ids.map((id) => byId.get(id)).filter(Boolean).map((d) => ({ id: d!.id, displayName: d!.display_name, email: d!.email, phone: d!.phone, createdAt: new Date(d!.created_at).toISOString(), company: d!.company }));
      const companies = new Set(contacts.map((c) => c.company).filter(Boolean));
      return { reason: companies.size === 1 && contacts.every((c) => c.company) ? "same_name_and_company" : "same_name", contacts } as DuplicateGroup;
    });
  });
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export interface ContactDetail {
  id: string;
  version: number;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  identities: Array<{ id: string; kind: "email" | "phone"; value: string; verified: boolean; primary: boolean }>;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
  timezone: string | null;
  preferredLanguage: string | null;
  preferredChannel: PreferredChannel | null;
  source: string;
  createdVia: CreatedVia;
  leadStatus: LeadStatus;
  leadScore: number | null;
  lifecycleStage: string;
  owner: { id: string; name: string } | null;
  createdBy: string | null;
  companies: Array<{ id: string; name: string; title: string | null; isPrimary: boolean }>;
  tags: Array<{ id: string; name: string; color: string }>;
  fields: RecordFieldValue[];
  consent: Array<{ channel: Channel; purpose: "service" | "marketing"; status: "granted" | "revoked" | "unknown"; source: string | null; at: string | null }>;
  suppressions: Array<{ channel: string; address: string; reason: string }>;
  ghlContactId: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string | null;
  counts: { conversations: number; openOpportunities: number; upcomingAppointments: number; openTasks: number; notes: number };
}

export async function getContactDetail(actor: CrmActor, id: string): Promise<ContactDetail> {
  assertCan(actor, "contacts.view");
  return crmRead(actor, async (db) => {
    const { rows } = await db.query<{
      id: string; version: number; display_name: string; first_name: string | null; last_name: string | null; email: string | null; phone: string | null;
      address_line1: string | null; address_line2: string | null; city: string | null; region: string | null; postal_code: string | null; country: string | null;
      timezone: string | null; preferred_language: string | null; preferred_channel: PreferredChannel | null; source: string; created_via: CreatedVia; lead_status: LeadStatus;
      lead_score: number | null; lifecycle_stage: string; assigned_user_id: string | null; owner_name: string | null; creator_name: string | null; ghl_contact_id: string | null;
      archived_at: Date | null; created_at: Date; updated_at: Date; last_activity_at: Date | null;
    }>(
      `select c.id, c.version, c.display_name, c.first_name, c.last_name, c.email::text as email, c.phone, c.address_line1, c.address_line2, c.city, c.region, c.postal_code, c.country,
              c.timezone, c.preferred_language, c.preferred_channel, c.source, c.created_via, c.lead_status, c.lead_score, c.lifecycle_stage, c.assigned_user_id,
              nullif(ou.full_name, '') as owner_name, nullif(cu.full_name, '') as creator_name, c.ghl_contact_id, c.archived_at, c.created_at, c.updated_at, c.last_activity_at
       from contacts c left join users ou on ou.id = c.assigned_user_id left join users cu on cu.id = c.created_by
       where c.id = $1 and c.org_id = $2 and c.deleted_at is null`,
      [id, actor.orgId],
    );
    const c = rows[0];
    if (!c) throw new AppError("not_found", "Contact not found.");
    const [identities, companies, tags, consentRows, suppressions] = await Promise.all([
      db.query<{ id: string; kind: "email" | "phone"; value: string; verified: boolean }>("select id, kind, value, verified from contact_identities where org_id = $1 and contact_id = $2 order by kind, created_at", [actor.orgId, id]),
      actor.can("companies.view")
        ? db.query<{ id: string; name: string; title: string | null; is_primary: boolean }>("select co.id, co.name, cc.title, cc.is_primary from crm_contact_companies cc join crm_companies co on co.id = cc.company_id and co.deleted_at is null where cc.org_id = $1 and cc.contact_id = $2 order by cc.is_primary desc, co.name", [actor.orgId, id])
        : Promise.resolve({ rows: [] as Array<{ id: string; name: string; title: string | null; is_primary: boolean }>, rowCount: 0 }),
      db.query<{ id: string; name: string; color: string }>("select t.id, t.name::text as name, t.color from crm_contact_tags ct join crm_tags t on t.id = ct.tag_id where ct.org_id = $1 and ct.contact_id = $2 order by lower(t.name::text)", [actor.orgId, id]),
      db.query<{ channel: Channel; purpose: "service" | "marketing"; status: "granted" | "revoked"; source: string; created_at: Date }>(
        "select distinct on (channel, purpose) channel, purpose, status, source, created_at from contact_consent_events where org_id = $1 and contact_id = $2 order by channel, purpose, id desc",
        [actor.orgId, id],
      ),
      db.query<{ channel: string; address: string; reason: string }>(
        "select s.channel, s.address, s.reason from suppressions s where s.org_id = $1 and s.lifted_at is null and s.address in (select value from contact_identities where org_id = $1 and contact_id = $2)",
        [actor.orgId, id],
      ),
    ]);
    const fields = await readFieldValues(db, actor.orgId, "contact", id);
    const consent: ContactDetail["consent"] = [];
    for (const channel of CHANNELS) {
      for (const purpose of ["service", "marketing"] as const) {
        const r = consentRows.rows.find((x) => x.channel === channel && x.purpose === purpose);
        consent.push({ channel, purpose, status: r?.status ?? "unknown", source: r?.source ?? null, at: r ? new Date(r.created_at).toISOString() : null });
      }
    }
    const count = async (sql: string) => Number((await db.query<{ n: string }>(sql, [actor.orgId, id])).rows[0]?.n ?? 0);
    const [conversations, openOpportunities, upcomingAppointments, openTasks, notes] = await Promise.all([
      actor.can("inbox.view") ? count("select count(*)::text as n from conversations where org_id = $1 and contact_id = $2") : Promise.resolve(0),
      actor.can("sales.view") ? count("select count(*)::text as n from crm_opportunities where org_id = $1 and contact_id = $2 and status = 'open'") : Promise.resolve(0),
      actor.can("appointments.view") ? count("select count(*)::text as n from appointment_refs where org_id = $1 and contact_id = $2 and start_at > now() and status not in ('cancelled', 'invalid')") : Promise.resolve(0),
      count("select count(*)::text as n from tasks where org_id = $1 and contact_id = $2 and status = 'open'"),
      count("select count(*)::text as n from record_notes where org_id = $1 and record_type = 'contact' and record_id = $2::text and deleted_at is null"),
    ]);
    const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
    return {
      id: c.id, version: c.version, displayName: c.display_name, firstName: c.first_name, lastName: c.last_name, email: c.email, phone: c.phone,
      identities: identities.rows.map((i) => ({ ...i, primary: (i.kind === "email" ? c.email : c.phone) === i.value })),
      addressLine1: c.address_line1, addressLine2: c.address_line2, city: c.city, region: c.region, postalCode: c.postal_code, country: c.country, timezone: c.timezone,
      preferredLanguage: c.preferred_language, preferredChannel: c.preferred_channel, source: c.source, createdVia: c.created_via, leadStatus: c.lead_status, leadScore: c.lead_score,
      lifecycleStage: c.lifecycle_stage, owner: c.assigned_user_id ? { id: c.assigned_user_id, name: c.owner_name ?? "Teammate" } : null, createdBy: c.creator_name,
      companies: companies.rows.map((r) => ({ id: r.id, name: r.name, title: r.title, isPrimary: r.is_primary })), tags: tags.rows, fields, consent, suppressions: suppressions.rows,
      ghlContactId: c.ghl_contact_id, archivedAt: iso(c.archived_at), createdAt: iso(c.created_at)!, updatedAt: iso(c.updated_at)!, lastActivityAt: iso(c.last_activity_at),
      counts: { conversations, openOpportunities, upcomingAppointments, openTasks, notes },
    };
  });
}

// ---------------------------------------------------------------------------
// Pickers and related lists for the interface
// ---------------------------------------------------------------------------

/** Teammates who can own contacts and deals (active members who can see contacts). */
export async function listAssignableMembers(actor: CrmActor): Promise<Array<{ id: string; name: string; role: string }>> {
  assertCan(actor, "crm.view");
  return crmRead(actor, async (db) => {
    const { rows } = await db.query<{ id: string; name: string; role: string }>(
      `select u.id, coalesce(nullif(u.full_name, ''), u.email::text) as name, m.role from organization_memberships m join users u on u.id = m.user_id
       where m.org_id = $1 and m.status = 'active' and u.status = 'active'
         and (m.role = 'owner' or coalesce(
               (select o.effect = 'grant' from member_permission_overrides o where o.org_id = m.org_id and o.user_id = m.user_id and o.permission = 'contacts.view'),
               exists (select 1 from role_permissions rp where rp.role = m.role and rp.permission = 'contacts.view')))
       order by lower(coalesce(nullif(u.full_name, ''), u.email::text))`,
      [actor.orgId],
    );
    return rows;
  });
}

/** Contacts whose name, email or phone matches, for pickers (deal, task and booking forms). */
export async function searchContacts(actor: CrmActor, q: string, limit = 10): Promise<Array<{ id: string; name: string; email: string | null; phone: string | null }>> {
  assertCan(actor, "contacts.view");
  const term = q.trim().toLowerCase().slice(0, 80);
  return crmRead(actor, async (db) => {
    const like = `%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const { rows } = await db.query<{ id: string; name: string; email: string | null; phone: string | null }>(
      `select c.id, c.display_name as name, c.email::text as email, c.phone from contacts c
       where c.org_id = $1 and c.deleted_at is null and c.archived_at is null and ($2 = '' or c.search_text like $3 escape '\\')
       order by c.last_activity_at desc nulls last, c.created_at desc limit $4`,
      [actor.orgId, term, like, Math.min(25, limit)],
    );
    return rows;
  });
}

export interface ContactConversation {
  id: string;
  channel: string;
  status: string;
  ownerKind: string;
  lastMessageAt: string | null;
  preview: string | null;
  unread: number;
}

/** The person's conversations the reader is allowed to see (row-level security applies for client members). */
export async function listContactConversations(actor: CrmActor, contactId: string): Promise<ContactConversation[]> {
  assertCan(actor, "inbox.view");
  return crmRead(actor, async (db) => {
    const { rows } = await db.query<{ id: string; channel: string; status: string; owner_kind: string; last_message_at: Date | null; last_message_preview: string | null; unread_count: number }>(
      `select id, channel, status, owner_kind, last_message_at, last_message_preview, unread_count from conversations
       where org_id = $1 and contact_id = $2 order by last_message_at desc nulls last limit 50`,
      [actor.orgId, contactId],
    );
    return rows.map((r) => ({ id: r.id, channel: r.channel, status: r.status, ownerKind: r.owner_kind, lastMessageAt: r.last_message_at ? new Date(r.last_message_at).toISOString() : null, preview: r.last_message_preview, unread: r.unread_count }));
  });
}

export interface ContactAppointment {
  id: string;
  title: string;
  status: string;
  startAt: string;
  endAt: string;
}

export async function listContactAppointments(actor: CrmActor, contactId: string): Promise<ContactAppointment[]> {
  assertCan(actor, "appointments.view");
  return crmRead(actor, async (db) => {
    const { rows } = await db.query<{ id: string; title: string; status: string; start_at: Date; end_at: Date }>(
      "select id, title, status, start_at, end_at from appointment_refs where org_id = $1 and contact_id = $2 order by start_at desc limit 50",
      [actor.orgId, contactId],
    );
    return rows.map((r) => ({ id: r.id, title: r.title, status: r.status, startAt: new Date(r.start_at).toISOString(), endAt: new Date(r.end_at).toISOString() }));
  });
}
