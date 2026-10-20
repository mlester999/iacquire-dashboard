import "server-only";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { assertCan, auditActor, crmRead, crmWrite, type CrmActor } from "@/server/crm/actor";
import { assertNativeOwner } from "@/server/crm/workspace";
import { emitEvent, recordActivity } from "@/server/crm/events";
import { TAG_COLORS } from "@/lib/crm/types";

export interface TagView {
  id: string;
  name: string;
  color: string;
  description: string | null;
  folderId: string | null;
  contactCount: number;
  companyCount: number;
  createdAt: string;
}

export type TagSource = "manual" | "bulk" | "import" | "workflow" | "form" | "agent" | "api" | "merge" | "blueprint" | "ghl_migration" | "booking";

const COLOR = /^#[0-9a-f]{6}$/;
const cleanName = (name: string) => name.replace(/\s+/g, " ").trim();

export async function listTags(actor: CrmActor, opts: { search?: string } = {}, existing?: Queryable): Promise<TagView[]> {
  assertCan(actor, "crm.view");
  const run = async (db: Queryable) => {
    const { rows } = await db.query<{ id: string; name: string; color: string; description: string | null; folder_id: string | null; contacts: string; companies: string; created_at: Date }>(
      `select t.id, t.name::text as name, t.color, t.description, t.folder_id, t.created_at,
              (select count(*) from crm_contact_tags ct join contacts c on c.id = ct.contact_id and c.deleted_at is null where ct.tag_id = t.id)::text as contacts,
              (select count(*) from crm_company_tags ct where ct.tag_id = t.id)::text as companies
       from crm_tags t where t.org_id = $1 and ($2::text is null or t.name ilike '%' || $2 || '%') order by lower(t.name::text)`,
      [actor.orgId, opts.search?.trim().replace(/[%_\\]/g, "") || null],
    );
    return rows.map((r) => ({ id: r.id, name: r.name, color: r.color, description: r.description, folderId: r.folder_id, contactCount: Number(r.contacts), companyCount: Number(r.companies), createdAt: new Date(r.created_at).toISOString() }));
  };
  return existing ? run(existing) : crmRead(actor, run);
}

/** Finds tags by name, creating the missing ones. Used by forms, imports and workflows so "VIP" and "vip" are one tag. */
export async function ensureTagsByName(db: Queryable, actor: CrmActor, names: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const raw of names.slice(0, 50)) {
    const name = cleanName(raw).slice(0, 60);
    if (!name) continue;
    const found = await db.query<{ id: string }>("select id from crm_tags where org_id = $1 and name = $2::citext", [actor.orgId, name]);
    if (found.rows[0]) {
      ids.push(found.rows[0].id);
      continue;
    }
    const color = TAG_COLORS[(name.length + name.charCodeAt(0)) % TAG_COLORS.length];
    const created = await db.query<{ id: string }>(
      "insert into crm_tags (org_id, name, color, created_by) values ($1, $2, $3, $4) on conflict (org_id, name) do update set name = crm_tags.name returning id",
      [actor.orgId, name, color, actor.userId],
    );
    ids.push(created.rows[0].id);
  }
  return [...new Set(ids)];
}

export async function createTag(actor: CrmActor, input: { name: string; color?: string; description?: string | null; folderId?: string | null }): Promise<TagView> {
  assertCan(actor, "tags.manage");
  const name = cleanName(input.name);
  if (!name || name.length > 60) throw new AppError("invalid_input", "Tag names are 1 to 60 characters.");
  const color = input.color && COLOR.test(input.color) ? input.color : TAG_COLORS[0];
  return crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "tags");
    const dup = await db.query("select 1 from crm_tags where org_id = $1 and name = $2::citext", [actor.orgId, name]);
    if (dup.rows.length) throw new AppError("conflict", `A tag called "${name}" already exists.`);
    if (input.folderId) await assertFolder(db, actor.orgId, input.folderId, "tag");
    const { rows } = await db.query<{ id: string; created_at: Date }>(
      "insert into crm_tags (org_id, name, color, description, folder_id, created_by) values ($1, $2, $3, $4, $5, $6) returning id, created_at",
      [actor.orgId, name, color, input.description?.trim().slice(0, 300) || null, input.folderId ?? null, actor.userId],
    );
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.tag_created", targetType: "crm_tag", targetId: rows[0].id, result: "success" }, db);
    return { id: rows[0].id, name, color, description: input.description?.trim() || null, folderId: input.folderId ?? null, contactCount: 0, companyCount: 0, createdAt: new Date(rows[0].created_at).toISOString() };
  });
}

export async function updateTag(actor: CrmActor, id: string, input: { name?: string; color?: string; description?: string | null; folderId?: string | null }): Promise<void> {
  assertCan(actor, "tags.manage");
  await crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "tags");
    const cur = await db.query<{ name: string }>("select name::text as name from crm_tags where id = $1 and org_id = $2 for update", [id, actor.orgId]);
    if (!cur.rows[0]) throw new AppError("not_found", "Tag not found.");
    const name = input.name !== undefined ? cleanName(input.name) : cur.rows[0].name;
    if (!name || name.length > 60) throw new AppError("invalid_input", "Tag names are 1 to 60 characters.");
    if (name.toLowerCase() !== cur.rows[0].name.toLowerCase()) {
      const dup = await db.query("select 1 from crm_tags where org_id = $1 and name = $2::citext and id <> $3", [actor.orgId, name, id]);
      if (dup.rows.length) throw new AppError("conflict", `A tag called "${name}" already exists. Merge them instead.`);
    }
    if (input.color !== undefined && !COLOR.test(input.color)) throw new AppError("invalid_input", "Choose a color.");
    if (input.folderId) await assertFolder(db, actor.orgId, input.folderId, "tag");
    await db.query(
      `update crm_tags set name = $3, color = coalesce($4, color), description = case when $5::boolean then $6 else description end,
         folder_id = case when $7::boolean then $8::uuid else folder_id end where id = $1 and org_id = $2`,
      [id, actor.orgId, name, input.color ?? null, input.description !== undefined, input.description?.trim().slice(0, 300) || null, input.folderId !== undefined, input.folderId ?? null],
    );
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.tag_updated", targetType: "crm_tag", targetId: id, result: "success", metadata: { renamed: name !== cur.rows[0].name } }, db);
  });
}

/** Deleting a tag removes it from every record. Saved filters that used it then refuse to run until edited, rather than matching everyone. */
export async function deleteTag(actor: CrmActor, id: string): Promise<{ removedFrom: number }> {
  assertCan(actor, "tags.manage");
  return crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "tags");
    const usage = await db.query<{ n: string }>("select ((select count(*) from crm_contact_tags where tag_id = $1) + (select count(*) from crm_company_tags where tag_id = $1))::text as n", [id]);
    const res = await db.query<{ name: string }>("delete from crm_tags where id = $1 and org_id = $2 returning name::text as name", [id, actor.orgId]);
    if (!res.rows[0]) throw new AppError("not_found", "Tag not found.");
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.tag_deleted", targetType: "crm_tag", targetId: id, result: "success", metadata: { name: res.rows[0].name, removedFrom: Number(usage.rows[0].n) } }, db);
    return { removedFrom: Number(usage.rows[0].n) };
  });
}

/** Moves every use of the source tags onto the target and removes the sources. No record loses a tag. */
export async function mergeTags(actor: CrmActor, input: { targetId: string; sourceIds: string[] }): Promise<{ moved: number }> {
  assertCan(actor, "tags.manage");
  const sources = [...new Set(input.sourceIds)].filter((s) => s !== input.targetId);
  if (!sources.length) throw new AppError("invalid_input", "Choose at least one other tag to merge into this one.");
  return crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "tags");
    const found = await db.query<{ id: string }>("select id from crm_tags where org_id = $1 and id = any($2::uuid[]) for update", [actor.orgId, [input.targetId, ...sources]]);
    if (found.rows.length !== sources.length + 1) throw new AppError("not_found", "One of these tags no longer exists.");
    const moved = await db.query(
      `insert into crm_contact_tags (org_id, contact_id, tag_id, source, added_by, added_at)
       select org_id, contact_id, $2, 'merge', $4, min(added_at) from crm_contact_tags where org_id = $1 and tag_id = any($3::uuid[]) group by org_id, contact_id
       on conflict (contact_id, tag_id) do nothing`,
      [actor.orgId, input.targetId, sources, actor.userId],
    );
    await db.query(
      `insert into crm_company_tags (org_id, company_id, tag_id, added_by, added_at)
       select org_id, company_id, $2, $4, min(added_at) from crm_company_tags where org_id = $1 and tag_id = any($3::uuid[]) group by org_id, company_id
       on conflict (company_id, tag_id) do nothing`,
      [actor.orgId, input.targetId, sources, actor.userId],
    );
    await db.query("delete from crm_tags where org_id = $1 and id = any($2::uuid[])", [actor.orgId, sources]);
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.tags_merged", targetType: "crm_tag", targetId: input.targetId, result: "success", metadata: { sources } }, db);
    return { moved: moved.rowCount };
  });
}

async function assertFolder(db: Queryable, orgId: string, folderId: string, kind: string) {
  const f = await db.query("select 1 from crm_folders where id = $1 and org_id = $2 and kind = $3", [folderId, orgId, kind]);
  if (!f.rows.length) throw new AppError("not_found", "Folder not found.");
}

// ---------------------------------------------------------------------------
// Applying tags. Each new assignment records an event (for workflows) and a timeline entry, exactly once.
// ---------------------------------------------------------------------------

export async function applyContactTags(
  db: Queryable,
  actor: CrmActor,
  contactIds: string[],
  tagIds: string[],
  source: TagSource,
  causedBy?: { eventId: number; depth: number } | null,
): Promise<number> {
  if (!contactIds.length || !tagIds.length) return 0;
  const tags = await db.query<{ id: string; name: string }>("select id, name::text as name from crm_tags where org_id = $1 and id = any($2::uuid[])", [actor.orgId, tagIds]);
  if (tags.rows.length !== new Set(tagIds).size) throw new AppError("not_found", "One of these tags no longer exists.");
  const { rows } = await db.query<{ contact_id: string; tag_id: string; added_at: Date }>(
    `insert into crm_contact_tags (org_id, contact_id, tag_id, source, added_by)
     select $1, c.id, t.id, $4, $5 from contacts c cross join unnest($3::uuid[]) as t(id)
     where c.org_id = $1 and c.id = any($2::uuid[]) and c.deleted_at is null
     on conflict (contact_id, tag_id) do nothing returning contact_id, tag_id, added_at`,
    [actor.orgId, contactIds, tagIds, source, actor.userId],
  );
  const names = new Map(tags.rows.map((t) => [t.id, t.name]));
  for (const r of rows) {
    const at = new Date(r.added_at).getTime();
    await emitEvent(db, actor, { type: "contact.tag_added", entityType: "contact", entityId: r.contact_id, contactId: r.contact_id, payload: { tagId: r.tag_id, tagName: names.get(r.tag_id), source }, dedupeKey: `contact.tag_added:${r.contact_id}:${r.tag_id}:${at}`, causedBy });
    await recordActivity(db, actor, { kind: "tag.added", summary: `Tag added: ${names.get(r.tag_id)}`, contactId: r.contact_id, refType: "tag", refId: r.tag_id });
  }
  return rows.length;
}

export async function removeContactTags(db: Queryable, actor: CrmActor, contactIds: string[], tagIds: string[], causedBy?: { eventId: number; depth: number } | null): Promise<number> {
  if (!contactIds.length || !tagIds.length) return 0;
  const { rows } = await db.query<{ contact_id: string; tag_id: string; name: string }>(
    `delete from crm_contact_tags ct using crm_tags t where ct.org_id = $1 and ct.contact_id = any($2::uuid[]) and ct.tag_id = any($3::uuid[]) and t.id = ct.tag_id
     returning ct.contact_id, ct.tag_id, t.name::text as name`,
    [actor.orgId, contactIds, tagIds],
  );
  for (const r of rows) {
    await emitEvent(db, actor, { type: "contact.tag_removed", entityType: "contact", entityId: r.contact_id, contactId: r.contact_id, payload: { tagId: r.tag_id, tagName: r.name }, dedupeKey: `contact.tag_removed:${r.contact_id}:${r.tag_id}:${Date.now()}`, causedBy });
    await recordActivity(db, actor, { kind: "tag.removed", summary: `Tag removed: ${r.name}`, contactId: r.contact_id, refType: "tag", refId: r.tag_id });
  }
  return rows.length;
}

/** Bulk tag from the contact list. One contact needs contacts.edit; more than one also needs contacts.bulk. */
export async function tagContacts(actor: CrmActor, input: { contactIds: string[]; addTagIds?: string[]; removeTagIds?: string[] }): Promise<{ added: number; removed: number }> {
  assertCan(actor, "contacts.edit");
  const ids = [...new Set(input.contactIds)].slice(0, 5000);
  if (ids.length > 1) assertCan(actor, "contacts.bulk", "Changing many contacts at once needs the bulk-edit permission.");
  return crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "contacts");
    const added = await applyContactTags(db, actor, ids, input.addTagIds ?? [], ids.length > 1 ? "bulk" : "manual");
    const removed = await removeContactTags(db, actor, ids, input.removeTagIds ?? []);
    if (ids.length > 1) await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.contacts_bulk_tagged", targetType: "contact", targetId: `${ids.length} contacts`, result: "success", metadata: { added, removed } }, db);
    return { added, removed };
  });
}

export async function tagCompany(actor: CrmActor, input: { companyId: string; addTagIds?: string[]; removeTagIds?: string[] }): Promise<void> {
  assertCan(actor, "companies.edit");
  await crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "companies");
    const co = await db.query("select 1 from crm_companies where id = $1 and org_id = $2 and deleted_at is null", [input.companyId, actor.orgId]);
    if (!co.rows.length) throw new AppError("not_found", "Company not found.");
    if (input.addTagIds?.length) {
      const ok = await db.query<{ n: string }>("select count(*)::text as n from crm_tags where org_id = $1 and id = any($2::uuid[])", [actor.orgId, input.addTagIds]);
      if (Number(ok.rows[0].n) !== new Set(input.addTagIds).size) throw new AppError("not_found", "One of these tags no longer exists.");
      await db.query("insert into crm_company_tags (org_id, company_id, tag_id, added_by) select $1, $2, t, $4 from unnest($3::uuid[]) t on conflict do nothing", [actor.orgId, input.companyId, input.addTagIds, actor.userId]);
    }
    if (input.removeTagIds?.length) await db.query("delete from crm_company_tags where org_id = $1 and company_id = $2 and tag_id = any($3::uuid[])", [actor.orgId, input.companyId, input.removeTagIds]);
  });
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export interface FolderView {
  id: string;
  kind: string;
  name: string;
  position: number;
}

export async function listFolders(actor: CrmActor, kind: string): Promise<FolderView[]> {
  assertCan(actor, "crm.view");
  return crmRead(actor, async (db) => {
    const { rows } = await db.query<FolderView>("select id, kind, name, position from crm_folders where org_id = $1 and kind = $2 order by position, lower(name)", [actor.orgId, kind]);
    return rows;
  });
}

const FOLDER_PERMISSION: Record<string, Parameters<CrmActor["can"]>[0]> = {
  smart_list: "smartlists.share", tag: "tags.manage", template: "templates.manage", workflow: "workflows.manage", form: "forms.manage", calendar: "calendars.manage", report: "analytics.view", campaign: "campaigns.manage",
};

export async function createFolder(actor: CrmActor, input: { kind: string; name: string }): Promise<FolderView> {
  const permission = FOLDER_PERMISSION[input.kind];
  if (!permission) throw new AppError("invalid_input", "Unknown folder type.");
  assertCan(actor, permission);
  const name = cleanName(input.name);
  if (!name || name.length > 80) throw new AppError("invalid_input", "Folder names are 1 to 80 characters.");
  return crmWrite(actor, async (db) => {
    const dup = await db.query("select 1 from crm_folders where org_id = $1 and kind = $2 and lower(name) = lower($3)", [actor.orgId, input.kind, name]);
    if (dup.rows.length) throw new AppError("conflict", "A folder with this name already exists.");
    const pos = await db.query<{ n: number }>("select coalesce(max(position), 0) + 1 as n from crm_folders where org_id = $1 and kind = $2", [actor.orgId, input.kind]);
    const { rows } = await db.query<FolderView>("insert into crm_folders (org_id, kind, name, position, created_by) values ($1, $2, $3, $4, $5) returning id, kind, name, position", [actor.orgId, input.kind, name, pos.rows[0].n, actor.userId]);
    return rows[0];
  });
}

export async function renameFolder(actor: CrmActor, id: string, name: string): Promise<void> {
  await crmWrite(actor, async (db) => {
    const f = await db.query<{ kind: string }>("select kind from crm_folders where id = $1 and org_id = $2", [id, actor.orgId]);
    if (!f.rows[0]) throw new AppError("not_found", "Folder not found.");
    assertCan(actor, FOLDER_PERMISSION[f.rows[0].kind]);
    const clean = cleanName(name);
    if (!clean || clean.length > 80) throw new AppError("invalid_input", "Folder names are 1 to 80 characters.");
    await db.query("update crm_folders set name = $3 where id = $1 and org_id = $2", [id, actor.orgId, clean]);
  });
}

/** Deleting a folder never deletes what is in it; items move back to "no folder". */
export async function deleteFolder(actor: CrmActor, id: string): Promise<void> {
  await crmWrite(actor, async (db) => {
    const f = await db.query<{ kind: string }>("select kind from crm_folders where id = $1 and org_id = $2", [id, actor.orgId]);
    if (!f.rows[0]) throw new AppError("not_found", "Folder not found.");
    assertCan(actor, FOLDER_PERMISSION[f.rows[0].kind]);
    await db.query("delete from crm_folders where id = $1 and org_id = $2", [id, actor.orgId]);
  });
}
