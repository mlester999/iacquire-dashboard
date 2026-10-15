import "server-only";
import { withSystem, withUser } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyOrgRoles } from "@/server/notifications";
import { diffDocs, type DocDiff } from "@/lib/website/editor/diff";
import { parseStoredContent } from "@/lib/website/legacy";
import type { OrgContext } from "@/server/tenancy/context";

/** Whether this context belongs to the agency (a person working on a client's site) rather than the client's own team. */
const isAgency = (ctx: OrgContext) => ctx.user.platformRole !== "none";

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

export interface CommentView {
  id: string;
  pageSlug: string | null;
  nodeId: string | null;
  body: string;
  authorName: string | null;
  authorKind: "client" | "agency";
  createdAt: string;
  resolvedAt: string | null;
  resolvedByName: string | null;
}

async function websiteOf(orgId: string) {
  const w = (await withSystem((db) => db.query<{ id: string }>("select id from websites where org_id = $1 and kind = 'website'", [orgId]))).rows[0];
  if (!w) throw new AppError("not_found", "Create your website first.");
  return w.id;
}

export async function listComments(ctx: OrgContext): Promise<CommentView[]> {
  if (!ctx.can("website.view")) throw new AppError("forbidden", "You don't have access to the website.");
  return withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<{ id: string; page_slug: string | null; node_id: string | null; body: string; author_kind: "client" | "agency"; created_at: Date; resolved_at: Date | null; author: string | null; resolver: string | null }>(
      `select c.id, c.page_slug, c.node_id, c.body, c.author_kind, c.created_at, c.resolved_at, a.full_name as author, r.full_name as resolver
       from website_comments c join websites w on w.id = c.website_id left join users a on a.id = c.author_id left join users r on r.id = c.resolved_by
       where w.org_id = $1 and w.kind = 'website' order by c.resolved_at is not null, c.created_at desc limit 200`, [ctx.org.orgId]);
    return rows.map((r) => ({ id: r.id, pageSlug: r.page_slug, nodeId: r.node_id, body: r.body, authorName: r.author, authorKind: r.author_kind, createdAt: new Date(r.created_at).toISOString(), resolvedAt: r.resolved_at ? new Date(r.resolved_at).toISOString() : null, resolvedByName: r.resolver }));
  });
}

export async function addComment(ctx: OrgContext, input: { body: string; nodeId?: string | null; pageSlug?: string | null }): Promise<{ id: string }> {
  // The client's team comments with edit rights; the agency comments through its own review right.
  if (!(isAgency(ctx) ? ctx.can("website.review") : ctx.can("website.edit"))) throw new AppError("forbidden", "You can't comment on this website.");
  const body = input.body.trim();
  if (body.length < 1 || body.length > 2000) throw new AppError("invalid_input", "Write a comment of up to 2000 characters.");
  const websiteId = await websiteOf(ctx.org.orgId);
  return withSystem(async (db) => {
    const { rows } = await db.query<{ id: string }>(
      "insert into website_comments (org_id, website_id, page_slug, node_id, body, author_id, author_kind) values ($1, $2, $3, $4, $5, $6, $7) returning id",
      [ctx.org.orgId, websiteId, input.pageSlug?.slice(0, 40) || null, input.nodeId?.slice(0, 40) || null, body, ctx.user.id, isAgency(ctx) ? "agency" : "client"]);
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: isAgency(ctx) ? "agency" : "user", action: "website.comment_added", targetType: "website_comment", targetId: rows[0].id, result: "success" }, db);
    if (isAgency(ctx)) await notifyOrgRoles(db, ctx.org.orgId, ["owner", "admin"], { kind: "system", severity: "info", title: "iAcquire left a comment on your website", body: body.slice(0, 200), link: "/website/edit", dedupeKey: `website-comment:${rows[0].id}` });
    return { id: rows[0].id };
  });
}

export async function resolveComment(ctx: OrgContext, id: string, resolved: boolean): Promise<void> {
  if (!(isAgency(ctx) ? ctx.can("website.review") : ctx.can("website.edit"))) throw new AppError("forbidden", "You can't change comments on this website.");
  const res = await withSystem((db) => db.query(
    `update website_comments set resolved_at = case when $3 then now() else null end, resolved_by = case when $3 then $4::uuid else null end where id = $1 and org_id = $2`, [id, ctx.org.orgId, resolved, ctx.user.id]));
  if (!res.rowCount) throw new AppError("not_found", "Comment not found.");
}

// ---------------------------------------------------------------------------
// Review: what changed since the live site, and asking for changes
// ---------------------------------------------------------------------------

export interface ReviewSummary {
  hasLive: boolean;
  liveNumber: number | null;
  diff: DocDiff | null;
  approval: "draft" | "submitted" | "approved" | "changes_requested";
  approvalNote: string | null;
}

/** The draft compared with what is live now (or, before the first publication, nothing to compare). */
export async function reviewSummary(ctx: OrgContext): Promise<ReviewSummary> {
  if (!ctx.can("website.view")) throw new AppError("forbidden", "You don't have access to the website.");
  const r = (await withSystem((db) => db.query<{ draft_content: unknown; template_key: string; approval_status: ReviewSummary["approval"]; approval_note: string | null; pub_content: unknown | null; pub_template: string | null; pub_number: number | null }>(
    `select w.draft_content, w.template_key, w.approval_status, w.approval_note, p.content as pub_content, p.template_key as pub_template, p.number as pub_number
     from websites w left join website_publications p on p.id = w.published_publication_id where w.org_id = $1 and w.kind = 'website'`, [ctx.org.orgId]))).rows[0];
  if (!r) throw new AppError("not_found", "Create your website first.");
  const draft = parseStoredContent(r.draft_content, r.template_key);
  const live = r.pub_content ? parseStoredContent(r.pub_content, r.pub_template ?? r.template_key) : null;
  return {
    hasLive: Boolean(live?.ok), liveNumber: r.pub_number, approval: r.approval_status, approvalNote: r.approval_note,
    diff: draft.ok && live?.ok ? diffDocs(live.content, draft.content) : null,
  };
}

/** Asks the owner for changes without publishing anything. The note reaches the owner, and the site goes back to draft with that note attached. */
export async function requestChanges(ctx: OrgContext, note: string): Promise<void> {
  if (!ctx.can("website.review")) throw new AppError("forbidden", "Only agency reviewers can request changes.");
  const text = note.trim();
  if (text.length < 3) throw new AppError("invalid_input", "Say what should change.");
  await withSystem(async (db) => {
    const w = (await db.query<{ id: string; approval_status: string }>("select id, approval_status from websites where org_id = $1 and kind = 'website' for update", [ctx.org.orgId])).rows[0];
    if (!w) throw new AppError("not_found", "Create your website first.");
    await db.query("update websites set approval_status = 'changes_requested', approval_note = $2, approval_decided_by = $3, approval_decided_at = now() where id = $1", [w.id, text.slice(0, 600), ctx.user.id]);
    await notifyOrgRoles(db, ctx.org.orgId, ["owner", "admin"], { kind: "approval_decided", severity: "warning", title: "iAcquire asked for changes to your website", body: text.slice(0, 300), link: "/website/edit" });
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "agency", action: "website.changes_requested", targetType: "website", targetId: w.id, result: "success", metadata: { by: "agency" } }, db);
  });
}

// ---------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------

/** Archiving takes a website out of service and out of the agency's lists; nothing is deleted, and it can be restored. */
export async function setArchived(ctx: OrgContext, archived: boolean): Promise<void> {
  if (!ctx.can("website.publish")) throw new AppError("forbidden", "Only the business owner or an agency super admin can archive a website.");
  await withSystem(async (db) => {
    const w = (await db.query<{ id: string; published_publication_id: string | null }>("select id, published_publication_id from websites where org_id = $1 and kind = 'website' for update", [ctx.org.orgId])).rows[0];
    if (!w) throw new AppError("not_found", "Create your website first.");
    if (archived && w.published_publication_id) {
      await db.query("update website_publications set status = 'superseded', note = 'Taken offline when the website was archived' where id = $1", [w.published_publication_id]);
      await db.query("update websites set published_publication_id = null where id = $1", [w.id]);
    }
    await db.query("update websites set archived_at = case when $2 then now() else null end where id = $1", [w.id, archived]);
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: isAgency(ctx) ? "agency" : "user", action: archived ? "website.archived" : "website.unarchived", targetType: "website", targetId: w.id, result: "success" }, db);
  });
}

// ---------------------------------------------------------------------------
// Edit lock: a courtesy that tells a second person who is already editing. The revision check is what actually prevents overwrites.
// ---------------------------------------------------------------------------

const LOCK_SECONDS = 90;
export interface LockResult {
  held: boolean;
  by: string | null;
  until: string | null;
}

export async function acquireEditLock(ctx: OrgContext, opts: { takeOver?: boolean } = {}): Promise<LockResult> {
  if (!ctx.can("website.edit")) throw new AppError("forbidden", "Only owners and managers can edit the website.");
  const name = isAgency(ctx) ? `${ctx.user.fullName} (iAcquire)` : ctx.user.fullName;
  return withSystem(async (db) => {
    const got = await db.query<{ edit_lock_expires: Date }>(
      `update websites set edit_lock_user = $2, edit_lock_name = $3, edit_lock_expires = now() + ($4 || ' seconds')::interval
       where org_id = $1 and kind = 'website' and (edit_lock_user is null or edit_lock_user = $2 or edit_lock_expires is null or edit_lock_expires < now() or $5::boolean)
       returning edit_lock_expires`, [ctx.org.orgId, ctx.user.id, name.slice(0, 120), String(LOCK_SECONDS), opts.takeOver === true]);
    if (got.rows[0]) return { held: true, by: null, until: new Date(got.rows[0].edit_lock_expires).toISOString() };
    const cur = (await db.query<{ edit_lock_name: string | null; edit_lock_expires: Date | null }>("select edit_lock_name, edit_lock_expires from websites where org_id = $1 and kind = 'website'", [ctx.org.orgId])).rows[0];
    return { held: false, by: cur?.edit_lock_name ?? "someone else", until: cur?.edit_lock_expires ? new Date(cur.edit_lock_expires).toISOString() : null };
  });
}

export async function releaseEditLock(ctx: OrgContext): Promise<void> {
  await withSystem((db) => db.query("update websites set edit_lock_expires = now() where org_id = $1 and kind = 'website' and edit_lock_user = $2", [ctx.org.orgId, ctx.user.id]));
}
