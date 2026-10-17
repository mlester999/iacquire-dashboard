import "server-only";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { parseSection, type Section } from "@/lib/website/doc";
import { roleHasPermission } from "@/lib/permissions";
import type { SessionUser } from "@/server/auth/service";
import type { OrgContext } from "@/server/tenancy/context";

export interface SavedComponentView {
  id: string;
  name: string;
  scope: "site" | "agency";
  section: Section;
}

const MAX_PER_SITE = 100;
const isAgency = (ctx: OrgContext) => ctx.user.platformRole !== "none";

/**
 * Sections this website's team has saved, plus the agency's shared ones. Saved sections are copied into a page when used, never linked, so
 * changing or deleting one never alters a page that already uses it. The agency sees its own drafts; clients see only published ones.
 */
export async function listComponents(ctx: OrgContext): Promise<SavedComponentView[]> {
  if (!ctx.can("website.view")) throw new AppError("forbidden", "You don't have access to the website.");
  return withSystem(async (db) => {
    const own = await db.query<{ id: string; name: string; section: unknown }>("select id, name, section from website_components where org_id = $1 and deleted_at is null order by created_at desc limit $2", [ctx.org.orgId, MAX_PER_SITE]);
    const shared = await db.query<{ id: string; name: string; section: unknown }>(
      `select id, name, section from website_patterns where status = 'published' or ($1::boolean and status = 'draft') order by updated_at desc limit 100`, [isAgency(ctx)]);
    const out: SavedComponentView[] = [];
    for (const [rows, scope] of [[own.rows, "site"], [shared.rows, "agency"]] as const) {
      for (const r of rows) {
        const parsed = parseSection(r.section);
        if (parsed.ok) out.push({ id: r.id, name: r.name, scope, section: parsed.section });
      }
    }
    return out;
  });
}

export async function saveComponent(ctx: OrgContext, input: { name: string; section: unknown; scope: "site" | "agency" }): Promise<SavedComponentView> {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 60) throw new AppError("invalid_input", "Give it a name of up to 60 characters.");
  const parsed = parseSection(input.section);
  if (!parsed.ok) throw new AppError("invalid_input", `That section can't be saved: ${parsed.error}`);
  if (JSON.stringify(parsed.section).length > 55_000) throw new AppError("invalid_input", "That section is too large to save. Save a smaller part of the page.");
  if (input.scope === "agency") {
    if (!isAgency(ctx) || !ctx.can("website.templates.design")) throw new AppError("forbidden", "Only the agency team can share a section with every website.");
    // A shared section reaches every client, so it can never point at one client's uploaded image.
    if (JSON.stringify(parsed.section).includes('"kind":"asset"')) throw new AppError("invalid_input", "A shared section can use built-in artwork only. Remove uploaded images from it first: they belong to one client.");
    const status = ctx.can("website.templates.publish") ? "published" : "draft";
    return withSystem(async (db) => {
      const { rows } = await db.query<{ id: string }>("insert into website_patterns (name, section, status, created_by) values ($1, $2, $3, $4) returning id", [name, JSON.stringify(parsed.section), status, ctx.user.id]);
      await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "agency", action: "website.component_saved", targetType: "website_pattern", targetId: rows[0].id, result: "success", metadata: { scope: "agency", status } }, db);
      return { id: rows[0].id, name, scope: "agency" as const, section: parsed.section };
    });
  }
  if (!ctx.can("website.edit")) throw new AppError("forbidden", "Only owners and managers can save sections.");
  return withSystem(async (db) => {
    const count = Number((await db.query<{ n: string }>("select count(*) as n from website_components where org_id = $1 and deleted_at is null", [ctx.org.orgId])).rows[0].n);
    if (count >= MAX_PER_SITE) throw new AppError("usage_limit", `You can keep up to ${MAX_PER_SITE} saved sections. Delete one you no longer use first.`);
    const { rows } = await db.query<{ id: string }>("insert into website_components (org_id, name, section, created_by) values ($1, $2, $3, $4) returning id", [ctx.org.orgId, name, JSON.stringify(parsed.section), ctx.user.id]);
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: isAgency(ctx) ? "agency" : "user", action: "website.component_saved", targetType: "website_component", targetId: rows[0].id, result: "success", metadata: { scope: "site" } }, db);
    return { id: rows[0].id, name, scope: "site" as const, section: parsed.section };
  });
}

/** Removes a saved section from the list. Pages that already used it keep their copy. */
export async function deleteComponent(ctx: OrgContext, id: string): Promise<void> {
  const own = await withSystem(async (db) => {
    if (!ctx.can("website.edit")) return null;
    return db.query("update website_components set deleted_at = now() where id = $1 and org_id = $2 and deleted_at is null", [id, ctx.org.orgId]);
  });
  if (own?.rowCount) return;
  if (isAgency(ctx) && ctx.can("website.templates.design")) {
    const res = await withSystem((db) => db.query("update website_patterns set status = 'archived' where id = $1 and status <> 'archived'", [id]));
    if (res.rowCount) {
      await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "agency", action: "website.component_removed", targetType: "website_pattern", targetId: id, result: "success" });
      return;
    }
  }
  throw new AppError("not_found", "That saved section wasn't found.");
}

// ---------------------------------------------------------------------------
// The agency's shared sections, as the agency manages them
// ---------------------------------------------------------------------------

export type PatternStatus = "draft" | "published" | "archived";
export interface PatternView { id: string; name: string; status: PatternStatus; createdByName: string | null; updatedAt: string }

const agencyOf = (user: SessionUser) => (user.platformRole === "none" ? null : user.platformRole);

/** Every shared section, whatever its state. For the agency team only. */
export async function listPatterns(user: SessionUser): Promise<PatternView[]> {
  if (!roleHasPermission(agencyOf(user), "website.templates.design")) throw new AppError("forbidden", "You don't have access to the template library.");
  const { rows } = await withSystem((db) => db.query<{ id: string; name: string; status: PatternStatus; created_by_name: string | null; updated_at: Date }>(
    `select p.id, p.name, p.status, u.full_name as created_by_name, p.updated_at from website_patterns p left join users u on u.id = p.created_by order by p.updated_at desc limit 200`));
  return rows.map((r) => ({ id: r.id, name: r.name, status: r.status, createdByName: r.created_by_name, updatedAt: new Date(r.updated_at).toISOString() }));
}

/** Offering a section to every client, taking it back, or archiving it. Clients who already used it keep their copy. */
export async function setPatternStatus(user: SessionUser, id: string, status: PatternStatus): Promise<void> {
  if (!roleHasPermission(agencyOf(user), "website.templates.publish")) throw new AppError("forbidden", "Only a super admin can decide which shared sections every client sees.");
  if (status !== "draft" && status !== "published" && status !== "archived") throw new AppError("invalid_input", "That isn't a status a shared section can have.");
  const res = await withSystem((db) => db.query("update website_patterns set status = $2 where id = $1", [id, status]));
  if (!res.rowCount) throw new AppError("not_found", "That shared section wasn't found.");
  await recordAudit({ orgId: null, actorUserId: user.id, actorKind: "user", action: "website.component_status", targetType: "website_pattern", targetId: id, result: "success", metadata: { status } });
}
