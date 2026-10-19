import "server-only";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { assertCan, auditActor, crmRead, crmWrite, type CrmActor } from "@/server/crm/actor";
import { compileContactFilter, compileCompanyFilter } from "@/server/crm/filter-sql";
import { loadCustomFieldMetas, parseFilterOrThrow } from "@/server/crm/directory";
import type { Queryable } from "@/server/db";
import { EMPTY_FILTER, type FilterGroup } from "@/lib/crm/filters";

export type SmartListEntity = "contact" | "company" | "opportunity";

export interface SmartListView {
  id: string;
  entity: SmartListEntity;
  name: string;
  description: string | null;
  folderId: string | null;
  folderName: string | null;
  filter: FilterGroup;
  columns: string[];
  sort: { by?: string; dir?: "asc" | "desc" };
  visibility: "private" | "team";
  ownerUserId: string;
  ownerName: string | null;
  isDefault: boolean;
  pinned: boolean;
  lastUsedAt: string | null;
  mine: boolean;
  updatedAt: string;
}

export interface SmartListInput {
  entity?: SmartListEntity;
  name: string;
  description?: string | null;
  folderId?: string | null;
  filter: unknown;
  columns?: string[];
  sort?: { by?: string; dir?: "asc" | "desc" };
  visibility?: "private" | "team";
}

const COLUMN = /^(cf:[0-9a-f-]{36}|[a-z_]{2,40})$/;

function cleanInput(input: SmartListInput) {
  const name = input.name.replace(/\s+/g, " ").trim();
  if (!name || name.length > 80) throw new AppError("invalid_input", "Name the list (up to 80 characters).");
  const filter = parseFilterOrThrow(input.filter ?? EMPTY_FILTER);
  const columns = [...new Set((input.columns ?? []).filter((c) => COLUMN.test(c)))].slice(0, 30);
  const sort = input.sort?.by && /^[a-z_]{2,40}$/.test(input.sort.by) ? { by: input.sort.by, dir: input.sort.dir === "asc" ? "asc" : "desc" } : {};
  return { name, description: input.description?.trim().slice(0, 300) || null, filter, columns, sort };
}

/** Checks that a filter compiles against this workspace's fields before it is saved, so a saved list always runs. */
async function assertCompiles(actor: CrmActor, entity: SmartListEntity, filter: FilterGroup) {
  await crmRead(actor, async (db) => {
    const ctx = { params: [actor.orgId] as unknown[], userId: actor.userId, timezone: actor.timezone, customFields: await loadCustomFieldMetas(db, actor.orgId) };
    if (entity === "contact") compileContactFilter(filter, ctx);
    else if (entity === "company") compileCompanyFilter(filter, ctx);
  });
}

export async function listSmartLists(actor: CrmActor, entity: SmartListEntity = "contact", existing?: Queryable): Promise<SmartListView[]> {
  assertCan(actor, "crm.view");
  const run = async (db: Queryable) => {
    const { rows } = await db.query<{
      id: string; entity: SmartListEntity; name: string; description: string | null; folder_id: string | null; folder_name: string | null; filter: FilterGroup; columns: string[];
      sort: { by?: string; dir?: "asc" | "desc" }; visibility: "private" | "team"; owner_user_id: string; owner_name: string | null; is_default: boolean; pinned: boolean | null; last_used_at: Date | null; updated_at: Date;
    }>(
      `select l.id, l.entity, l.name, l.description, l.folder_id, f.name as folder_name, l.filter, l.columns, l.sort, l.visibility, l.owner_user_id, nullif(u.full_name, '') as owner_name,
              l.is_default, p.pinned, p.last_used_at, l.updated_at
       from crm_smart_lists l left join crm_folders f on f.id = l.folder_id left join users u on u.id = l.owner_user_id
       left join crm_view_preferences p on p.smart_list_id = l.id and p.user_id = $3
       where l.org_id = $1 and l.entity = $2 and l.archived_at is null and (l.visibility = 'team' or l.owner_user_id = $3)
       order by coalesce(p.pinned, false) desc, l.is_default desc, lower(l.name)`,
      [actor.orgId, entity, actor.userId],
    );
    return rows.map((r) => ({
      id: r.id, entity: r.entity, name: r.name, description: r.description, folderId: r.folder_id, folderName: r.folder_name, filter: r.filter, columns: r.columns, sort: r.sort ?? {},
      visibility: r.visibility, ownerUserId: r.owner_user_id, ownerName: r.owner_name, isDefault: r.is_default, pinned: r.pinned === true,
      lastUsedAt: r.last_used_at ? new Date(r.last_used_at).toISOString() : null, mine: r.owner_user_id === actor.userId, updatedAt: new Date(r.updated_at).toISOString(),
    }));
  };
  return existing ? run(existing) : crmRead(actor, run);
}

export async function createSmartList(actor: CrmActor, input: SmartListInput): Promise<{ id: string }> {
  assertCan(actor, "crm.view");
  if (!actor.userId) throw new AppError("forbidden", "Saved lists belong to a person.");
  const entity = input.entity ?? "contact";
  assertCan(actor, entity === "company" ? "companies.view" : entity === "opportunity" ? "sales.view" : "contacts.view");
  const visibility = input.visibility ?? "private";
  if (visibility === "team") assertCan(actor, "smartlists.share", "Sharing a list with the whole team needs the share permission.");
  const c = cleanInput(input);
  await assertCompiles(actor, entity, c.filter);
  return crmWrite(actor, async (db) => {
    if (input.folderId) {
      const f = await db.query("select 1 from crm_folders where id = $1 and org_id = $2 and kind = 'smart_list'", [input.folderId, actor.orgId]);
      if (!f.rows.length) throw new AppError("not_found", "Folder not found.");
    }
    const { rows } = await db.query<{ id: string }>(
      `insert into crm_smart_lists (org_id, entity, name, description, folder_id, filter, columns, sort, visibility, owner_user_id) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
      [actor.orgId, entity, c.name, c.description, input.folderId ?? null, JSON.stringify(c.filter), c.columns, JSON.stringify(c.sort), visibility, actor.userId],
    );
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.smart_list_created", targetType: "crm_smart_list", targetId: rows[0].id, result: "success", metadata: { entity, visibility } }, db);
    return { id: rows[0].id };
  });
}

/** A private list can be edited by its owner; a team list by anyone allowed to share lists. */
async function editable(actor: CrmActor, id: string) {
  return crmWrite(actor, async (db) => {
    const { rows } = await db.query<{ owner_user_id: string; visibility: "private" | "team"; entity: SmartListEntity }>("select owner_user_id, visibility, entity from crm_smart_lists where id = $1 and org_id = $2 and archived_at is null", [id, actor.orgId]);
    const r = rows[0];
    if (!r || (r.visibility === "private" && r.owner_user_id !== actor.userId)) throw new AppError("not_found", "List not found.");
    if (r.visibility === "team" && r.owner_user_id !== actor.userId) assertCan(actor, "smartlists.share", "Only people who can share lists can change a team list.");
    return r;
  });
}

export async function updateSmartList(actor: CrmActor, id: string, input: Partial<SmartListInput>): Promise<void> {
  assertCan(actor, "crm.view");
  const cur = await editable(actor, id);
  if (input.visibility === "team" && cur.visibility !== "team") assertCan(actor, "smartlists.share", "Sharing a list with the whole team needs the share permission.");
  if (input.visibility === "private" && cur.visibility === "team" && cur.owner_user_id !== actor.userId) throw new AppError("forbidden", "Only the person who created a team list can make it private again.");
  const filter = input.filter !== undefined ? parseFilterOrThrow(input.filter) : undefined;
  if (filter) await assertCompiles(actor, cur.entity, filter);
  const c = input.name !== undefined ? cleanInput({ name: input.name, filter: filter ?? EMPTY_FILTER, columns: input.columns, sort: input.sort, description: input.description }) : null;
  await crmWrite(actor, async (db) => {
    if (input.folderId) {
      const f = await db.query("select 1 from crm_folders where id = $1 and org_id = $2 and kind = 'smart_list'", [input.folderId, actor.orgId]);
      if (!f.rows.length) throw new AppError("not_found", "Folder not found.");
    }
    await db.query(
      `update crm_smart_lists set
         name = coalesce($3, name), description = case when $4::boolean then $5 else description end, filter = coalesce($6::jsonb, filter),
         columns = coalesce($7::text[], columns), sort = coalesce($8::jsonb, sort), visibility = coalesce($9, visibility),
         folder_id = case when $10::boolean then $11::uuid else folder_id end,
         is_default = case when coalesce($9, visibility) = 'private' then false else is_default end
       where id = $1 and org_id = $2`,
      [
        id, actor.orgId, c?.name ?? null, input.description !== undefined, input.description?.trim().slice(0, 300) || null, filter ? JSON.stringify(filter) : null,
        input.columns ? [...new Set(input.columns.filter((x) => COLUMN.test(x)))].slice(0, 30) : null,
        input.sort ? JSON.stringify(input.sort.by && /^[a-z_]{2,40}$/.test(input.sort.by) ? { by: input.sort.by, dir: input.sort.dir === "asc" ? "asc" : "desc" } : {}) : null,
        input.visibility ?? null, input.folderId !== undefined, input.folderId ?? null,
      ],
    );
  });
}

export async function duplicateSmartList(actor: CrmActor, id: string, name?: string): Promise<{ id: string }> {
  assertCan(actor, "crm.view");
  const src = await crmRead(actor, async (db) => {
    const { rows } = await db.query<{ entity: SmartListEntity; name: string; description: string | null; filter: FilterGroup; columns: string[]; sort: { by?: string; dir?: "asc" | "desc" } }>(
      "select entity, name, description, filter, columns, sort from crm_smart_lists where id = $1 and org_id = $2 and archived_at is null and (visibility = 'team' or owner_user_id = $3)",
      [id, actor.orgId, actor.userId],
    );
    return rows[0];
  });
  if (!src) throw new AppError("not_found", "List not found.");
  // A copy is always private to the person who made it; they can share it afterwards if allowed.
  return createSmartList(actor, { entity: src.entity, name: (name?.trim() || `${src.name} (copy)`).slice(0, 80), description: src.description, filter: src.filter, columns: src.columns, sort: src.sort, visibility: "private" });
}

export async function deleteSmartList(actor: CrmActor, id: string): Promise<void> {
  await editable(actor, id);
  await crmWrite(actor, async (db) => {
    await db.query("update crm_smart_lists set archived_at = now(), is_default = false where id = $1 and org_id = $2", [id, actor.orgId]);
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.smart_list_deleted", targetType: "crm_smart_list", targetId: id, result: "success" }, db);
  });
}

export async function pinSmartList(actor: CrmActor, id: string, pinned: boolean): Promise<void> {
  assertCan(actor, "crm.view");
  if (!actor.userId) throw new AppError("forbidden", "Pins belong to a person.");
  await crmWrite(actor, async (db) => {
    const ok = await db.query("select 1 from crm_smart_lists where id = $1 and org_id = $2 and archived_at is null and (visibility = 'team' or owner_user_id = $3)", [id, actor.orgId, actor.userId]);
    if (!ok.rows.length) throw new AppError("not_found", "List not found.");
    await db.query(
      `insert into crm_view_preferences (org_id, user_id, smart_list_id, pinned) values ($1, $2, $3, $4)
       on conflict (user_id, smart_list_id) do update set pinned = excluded.pinned`,
      [actor.orgId, actor.userId, id, pinned],
    );
  });
}

/** Remembers when a person last opened a list, for "recently used". */
export async function touchSmartList(actor: CrmActor, id: string): Promise<void> {
  if (!actor.userId || actor.kind !== "member") return;
  await crmWrite(actor, (db) =>
    db.query(
      `insert into crm_view_preferences (org_id, user_id, smart_list_id, last_used_at)
       select $1, $2, l.id, now() from crm_smart_lists l where l.id = $3 and l.org_id = $1 and (l.visibility = 'team' or l.owner_user_id = $2)
       on conflict (user_id, smart_list_id) do update set last_used_at = now()`,
      [actor.orgId, actor.userId, id],
    ),
  );
}

/** Makes a team list the view everyone sees first. */
export async function setDefaultSmartList(actor: CrmActor, id: string | null, entity: SmartListEntity = "contact"): Promise<void> {
  assertCan(actor, "smartlists.share");
  await crmWrite(actor, async (db) => {
    await db.query("update crm_smart_lists set is_default = false where org_id = $1 and entity = $2 and is_default", [actor.orgId, entity]);
    if (!id) return;
    const res = await db.query("update crm_smart_lists set is_default = true where id = $1 and org_id = $2 and entity = $3 and visibility = 'team' and archived_at is null", [id, actor.orgId, entity]);
    if (!res.rowCount) throw new AppError("invalid_input", "Only a list shared with the team can be the default view.");
  });
}
