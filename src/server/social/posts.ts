import "server-only";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyOrgRoles, notifyUser } from "@/server/notifications";
import type { OrgContext } from "@/server/tenancy/context";
import { draftProblems, normalizeHashtags, type MediaFacts, type Platform, type PostKind, type Problem } from "@/lib/social/rules";
import { approvalRequired, canTransition, scheduleProblem, selfApprovalAllowed, type PostStatus } from "@/lib/social/state";
import { MAX_CAPTION, MAX_HASHTAGS } from "@/lib/social/limits";
import { addEvent, announce, ASSET_FILE_JOIN_SQL, loadAccountRow, loadPostRow, newTrackingCode, POST_COLUMNS, readSettings, USABLE_ASSET_STATUS_SQL, type AccountRow, type PostRow } from "@/server/social/post-core";
import { cancelQueuedJob, enqueueJob } from "@/server/social/publisher";

// Writing a post, getting it approved, scheduling it, and every way it can be stopped or retried. The server decides everything here; the interface only reads
// the result. An approval is of one version of one post: any change to what will be posted voids it. Nothing is ever published by this file: it only queues a
// job for the publisher, and only for a version somebody with the right approved.

export interface MediaRef {
  id: string;
  filename: string;
  kind: "image" | "video";
  mimeType: string;
  width: number | null;
  height: number | null;
  status: "ready" | "invalid" | "removed";
}

export interface PostView {
  id: string;
  accountId: string;
  accountName: string;
  platform: Platform;
  campaignId: string | null;
  campaignName: string | null;
  kind: PostKind;
  caption: string;
  hashtags: string[];
  linkUrl: string | null;
  trackingCode: string | null;
  media: MediaRef[];
  status: PostStatus;
  scheduledAt: string | null;
  timezone: string | null;
  origin: "human" | "ai";
  authorId: string | null;
  authorName: string | null;
  version: number;
  approvedVersion: number | null;
  approvedByName: string | null;
  approvedAt: string | null;
  decisionNote: string | null;
  providerPostId: string | null;
  permalink: string | null;
  publishedAt: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  createdAt: string;
  updatedAt: string;
  /** What is wrong with it for the platform it is going to. Blocking problems stop it being sent for approval or scheduled. */
  problems: Problem[];
}

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

function must(ctx: OrgContext, permission: Parameters<OrgContext["can"]>[0], message: string) {
  if (!ctx.can(permission)) throw new AppError("forbidden", message);
}

const canEditRow = (ctx: OrgContext, row: PostRow) => ctx.can("social.create") && (row.author_id === ctx.user.id || ctx.can("social.approve") || ctx.can("social.publish"));

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** `storedFiles` also checks that each managed file's stored copy is still there. Reads under a person's own row-level security leave it off: they cannot see every stored file, and a file they cannot see must not look removed. */
async function viewsFor(db: Queryable, orgId: string, rows: PostRow[], storedFiles = true): Promise<PostView[]> {
  if (!rows.length) return [];
  const accountIds = [...new Set(rows.map((r) => r.account_id))];
  const accounts = new Map((await db.query<{ id: string; name: string; platform: Platform; capabilities: { contentTypes?: PostKind[] } | null }>("select id, name, platform, capabilities from social_accounts where org_id = $1 and id = any($2::uuid[])", [orgId, accountIds])).rows.map((a) => [a.id, a]));
  const campaignIds = [...new Set(rows.map((r) => r.campaign_id).filter((x): x is string => Boolean(x)))];
  const campaigns = new Map((campaignIds.length ? (await db.query<{ id: string; name: string }>("select id, name from social_campaigns where org_id = $1 and id = any($2::uuid[])", [orgId, campaignIds])).rows : []).map((c) => [c.id, c.name]));
  const userIds = [...new Set(rows.flatMap((r) => [r.author_id, r.approved_by]).filter((x): x is string => Boolean(x)))];
  const users = new Map((userIds.length ? (await db.query<{ id: string; full_name: string }>("select id, full_name from users where id = any($1::uuid[])", [userIds])).rows : []).map((u) => [u.id, u.full_name]));
  const assetIds = [...new Set(rows.flatMap((r) => r.media_asset_ids))];
  const assets = new Map((assetIds.length ? (await db.query<{ id: string; filename: string; kind: "image" | "video"; mime_type: string; width: number | null; height: number | null; size_bytes: number; status: "ready" | "invalid" | "removed" }>(
    `select a.id, a.filename, a.kind, a.mime_type, a.width, a.height, a.size_bytes, ${storedFiles ? USABLE_ASSET_STATUS_SQL : "a.status"} as status from social_media_assets a ${storedFiles ? ASSET_FILE_JOIN_SQL : ""} where a.org_id = $1 and a.id = any($2::uuid[])`, [orgId, assetIds])).rows : []).map((a) => [a.id, a]));
  return rows.map((r) => {
    const acc = accounts.get(r.account_id);
    const platform = acc?.platform ?? "facebook";
    const media: MediaRef[] = r.media_asset_ids.flatMap((id) => {
      const a = assets.get(id);
      return a ? [{ id, filename: a.filename, kind: a.kind, mimeType: a.mime_type, width: a.width, height: a.height, status: a.status }] : [];
    });
    const facts: MediaFacts[] = r.media_asset_ids.map((id) => {
      const a = assets.get(id);
      return a ? { id, kind: a.kind, mimeType: a.mime_type, sizeBytes: a.size_bytes, width: a.width, height: a.height, status: a.status } : { id, kind: "image", mimeType: "", sizeBytes: 0, width: null, height: null, status: "removed" };
    });
    const problems = draftProblems(platform, { kind: r.kind, caption: r.caption, hashtags: r.hashtags, linkUrl: r.link_url }, facts);
    if (acc && acc.capabilities?.contentTypes && !acc.capabilities.contentTypes.includes(r.kind)) problems.push({ level: "blocking", code: "account_cannot", message: `This account's permissions do not allow ${r.kind} posts. Reconnect it and allow the requested access.` });
    return {
      id: r.id, accountId: r.account_id, accountName: acc?.name ?? "Unknown account", platform, campaignId: r.campaign_id, campaignName: r.campaign_id ? campaigns.get(r.campaign_id) ?? null : null,
      kind: r.kind, caption: r.caption, hashtags: r.hashtags, linkUrl: r.link_url, trackingCode: r.tracking_code, media, status: r.status, scheduledAt: iso(r.scheduled_at), timezone: r.timezone,
      origin: r.origin, authorId: r.author_id, authorName: r.author_id ? users.get(r.author_id) ?? null : null, version: r.version, approvedVersion: r.approved_version,
      approvedByName: r.approved_by ? users.get(r.approved_by) ?? null : null, approvedAt: iso(r.approved_at), decisionNote: r.decision_note, providerPostId: r.provider_post_id, permalink: r.permalink,
      publishedAt: iso(r.published_at), failureCode: r.failure_code, failureMessage: r.failure_message, createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(), problems,
    };
  });
}

export interface PostFilter {
  from?: Date;
  to?: Date;
  accountId?: string;
  statuses?: PostStatus[];
  limit?: number;
}

/** Posts for the calendar and lists. A post sits on the day it was or will be published; a draft with no date sits on the day it was written. */
export async function listPosts(ctx: OrgContext, f: PostFilter = {}): Promise<PostView[]> {
  must(ctx, "social.view", "Your role can't see social media.");
  return withUser(ctx.user.id, async (db) => {
    const where = ["org_id = $1"];
    const params: unknown[] = [ctx.org.orgId];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace("?", `$${params.length}`));
    };
    if (f.from) add("coalesce(published_at, scheduled_at, created_at) >= ?", f.from);
    if (f.to) add("coalesce(published_at, scheduled_at, created_at) < ?", f.to);
    if (f.accountId) add("account_id = ?", f.accountId);
    if (f.statuses?.length) add("status = any(?::text[])", f.statuses);
    const { rows } = await db.query<PostRow>(`select ${POST_COLUMNS} from social_posts where ${where.join(" and ")} order by coalesce(published_at, scheduled_at, created_at) desc limit ${Math.min(f.limit ?? 500, 1000)}`, params);
    return viewsFor(db, ctx.org.orgId, rows, false);
  });
}

export interface PostEvent {
  id: number;
  at: string;
  kind: string;
  actorName: string | null;
  actorKind: "user" | "ai" | "system";
  detail: Record<string, unknown>;
}

export interface JobSummary {
  status: string;
  attempt: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  lastErrorKind: string | null;
}

export async function getPostDetail(ctx: OrgContext, id: string): Promise<{ post: PostView; events: PostEvent[]; job: JobSummary | null }> {
  must(ctx, "social.view", "Your role can't see social media.");
  return withUser(ctx.user.id, async (db) => {
    const row = await loadPostRow(db, ctx.org.orgId, id);
    if (!row) throw new AppError("not_found", "That post was not found.");
    const [post] = await viewsFor(db, ctx.org.orgId, [row], false);
    const ev = await db.query<{ id: string; at: Date; kind: string; actor_kind: "user" | "ai" | "system"; detail: Record<string, unknown>; full_name: string | null }>(
      "select e.id::text as id, e.at, e.kind, e.actor_kind, e.detail, u.full_name from social_post_events e left join users u on u.id = e.actor_id where e.post_id = $1 and e.org_id = $2 order by e.id", [id, ctx.org.orgId],
    );
    const job = (await db.query<{ status: string; attempt: number; max_attempts: number; run_at: Date; last_error: string | null; last_error_kind: string | null }>(
      "select status, attempt, max_attempts, run_at, last_error, last_error_kind from social_publish_jobs where post_id = $1 and org_id = $2 order by created_at desc limit 1", [id, ctx.org.orgId],
    )).rows[0];
    return {
      post,
      events: ev.rows.map((e) => ({ id: Number(e.id), at: new Date(e.at).toISOString(), kind: e.kind, actorName: e.full_name, actorKind: e.actor_kind, detail: e.detail })),
      job: job ? { status: job.status, attempt: job.attempt, maxAttempts: job.max_attempts, nextAttemptAt: job.status === "queued" ? new Date(job.run_at).toISOString() : null, lastError: job.last_error, lastErrorKind: job.last_error_kind } : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface PostInput {
  accountId: string;
  kind: PostKind;
  caption?: string;
  hashtags?: string[];
  linkUrl?: string | null;
  mediaAssetIds?: string[];
  campaignId?: string | null;
}

async function checkAccount(db: Queryable, orgId: string, accountId: string): Promise<AccountRow> {
  const a = await loadAccountRow(db, orgId, accountId);
  if (!a || a.status === "disconnected" || a.status === "revoked") throw new AppError("invalid_input", "Choose a connected account for this post.");
  return a;
}

async function checkMedia(db: Queryable, orgId: string, ids: string[]): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  const n = await db.query<{ n: string }>("select count(*)::text as n from social_media_assets where org_id = $1 and id = any($2::uuid[]) and status = 'ready'", [orgId, unique]);
  // A file of another workspace is indistinguishable from one that does not exist: neither can be attached.
  if (Number(n.rows[0].n) !== unique.length) throw new AppError("invalid_input", "A selected file was not found in your media library.");
  return unique;
}

async function checkCampaign(db: Queryable, orgId: string, id: string | null | undefined): Promise<string | null> {
  if (!id) return null;
  const r = await db.query("select 1 from social_campaigns where id = $1 and org_id = $2 and status = 'active'", [id, orgId]);
  if (!r.rows[0]) throw new AppError("invalid_input", "Choose one of your campaigns.");
  return id;
}

const clean = (text: string | undefined) => (text ?? "").replace(/\r\n/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trimEnd();

// What the database holds, checked here first so that a person who goes over a limit is told which one, in words, and not "something went wrong".
const CAPTION_MAX = MAX_CAPTION;
const LINK_MAX = 1_000;
const HASHTAGS_MAX = MAX_HASHTAGS;

function cleanCaption(text: string | undefined): string {
  const caption = clean(text);
  if (caption.length > CAPTION_MAX) throw new AppError("invalid_input", `Captions can't be longer than ${CAPTION_MAX.toLocaleString("en-US")} characters. This one is ${caption.length.toLocaleString("en-US")}.`);
  return caption;
}

function cleanHashtags(list: readonly string[] | undefined): string[] {
  const tags = normalizeHashtags(list ?? [], 1_000);
  if (tags.length > HASHTAGS_MAX) throw new AppError("invalid_input", `A post can carry at most ${HASHTAGS_MAX} hashtags. Remove ${tags.length - HASHTAGS_MAX}.`);
  return tags;
}

/** The link as stored: https only, with the scheme in lower case so the rules and the database agree, a real address, and not longer than the database holds. */
function cleanLink(raw: string | null | undefined): string | null {
  const link = raw?.trim();
  if (!link) return null;
  if (!/^https:\/\//i.test(link)) throw new AppError("invalid_input", "Links must start with https://.");
  if (link.length > LINK_MAX) throw new AppError("invalid_input", `Links can't be longer than ${LINK_MAX.toLocaleString("en-US")} characters.`);
  try {
    new URL(link);
  } catch {
    throw new AppError("invalid_input", "That link is not a web address. Check it and try again.");
  }
  return `https://${link.slice("https://".length)}`;
}

/** Inserts a draft. The caller has made its permission checks. `origin: "ai"` is only ever passed by the AI drafting path, or by a copy of an AI draft (`copy`). */
export async function insertDraft(db: Queryable, actor: { orgId: string; userId: string }, input: PostInput, origin: "human" | "ai", aiRunId: string | null = null, opts: { copy?: boolean } = {}): Promise<PostRow> {
  const caption = cleanCaption(input.caption);
  const hashtags = cleanHashtags(input.hashtags);
  const linkUrl = cleanLink(input.linkUrl);
  const account = await checkAccount(db, actor.orgId, input.accountId);
  const settings = await readSettings(db, actor.orgId);
  const media = await checkMedia(db, actor.orgId, input.mediaAssetIds ?? []);
  const campaignId = await checkCampaign(db, actor.orgId, input.campaignId);
  const code = linkUrl && settings.trackingLinks ? newTrackingCode() : null;
  const { rows } = await db.query<PostRow>(
    `insert into social_posts (org_id, account_id, campaign_id, kind, caption, hashtags, link_url, tracking_code, media_asset_ids, origin, ai_run_id, author_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning ${POST_COLUMNS}`,
    [actor.orgId, account.id, campaignId, input.kind, caption, hashtags, linkUrl, code, media, origin, aiRunId, actor.userId],
  );
  // A copy of an AI draft is still AI-written (so it still needs a person's approval) but the model did not just write it: its history says it was copied.
  const drafted = origin === "ai" && !opts.copy;
  await addEvent(db, actor.orgId, rows[0].id, drafted ? "ai_drafted" : "created", { id: drafted ? null : actor.userId, kind: drafted ? "ai" : "user" }, drafted ? { aiRunId, requestedBy: actor.userId } : {});
  return rows[0];
}

export async function createPost(ctx: OrgContext, input: PostInput): Promise<PostView> {
  must(ctx, "social.create", "Your role can't write social posts.");
  return withSystem(async (db) => {
    const row = await insertDraft(db, { orgId: ctx.org.orgId, userId: ctx.user.id }, input, "human");
    return (await viewsFor(db, ctx.org.orgId, [row]))[0];
  });
}

/**
 * For the AI drafting path only: a draft marked as AI-written, belonging to the person who asked for it. It is an ordinary draft in every other way, and it can
 * never be scheduled without a human approval (see approvalRequired).
 */
export async function createAiDraft(ctx: OrgContext, input: PostInput, aiRunId: string, detail: Record<string, unknown> = {}): Promise<PostView> {
  must(ctx, "social.create", "Your role can't write social posts.");
  return withSystem(async (db) => {
    const row = await insertDraft(db, { orgId: ctx.org.orgId, userId: ctx.user.id }, input, "ai", aiRunId);
    await addEvent(db, ctx.org.orgId, row.id, "ai_option_chosen", { id: ctx.user.id, kind: "user" }, detail);
    return (await viewsFor(db, ctx.org.orgId, [row]))[0];
  });
}

export type PostPatch = Partial<PostInput> & { timezone?: string | null };

const CONTENT_KEYS = ["account_id", "campaign_id", "kind", "caption", "hashtags", "link_url", "media_asset_ids"] as const;

/**
 * Changes a post. If what will be posted changes, the version goes up and any approval is void: an approved or scheduled post goes back to a draft, its queued
 * job is cancelled (a job already sending cannot be, and the edit is refused). A post waiting out a retry has a queued job and nothing in flight, so it can be
 * changed too. `expectedVersion` stops two people overwriting each other.
 */
export async function updatePost(ctx: OrgContext, id: string, patch: PostPatch, expectedVersion: number): Promise<PostView> {
  must(ctx, "social.create", "Your role can't write social posts.");
  return withSystem(async (db) => {
    const row = await loadPostRow(db, ctx.org.orgId, id, true);
    if (!row) throw new AppError("not_found", "That post was not found.");
    if (!canEditRow(ctx, row)) throw new AppError("forbidden", "Only the person who wrote this post, or a manager, can change it.");
    if (row.version !== expectedVersion) throw new AppError("conflict", "Someone changed this post. Reload to see their changes, then try again.");
    if (row.status === "failed" && row.failure_code === "unknown_outcome") throw new AppError("conflict", "The platform may already have this post. Look at the Page and say whether it was posted before changing it.");
    if (!["draft", "pending_approval", "changes_requested", "approved", "scheduled", "publishing", "failed"].includes(row.status)) throw new AppError("conflict", row.status === "published" ? "A published post cannot be edited. Duplicate it to post a new version." : "This post cannot be edited right now.");
    const settings = await readSettings(db, ctx.org.orgId);
    const next = {
      account_id: patch.accountId !== undefined ? (await checkAccount(db, ctx.org.orgId, patch.accountId)).id : row.account_id,
      campaign_id: patch.campaignId !== undefined ? await checkCampaign(db, ctx.org.orgId, patch.campaignId) : row.campaign_id,
      kind: patch.kind ?? row.kind,
      caption: patch.caption !== undefined ? cleanCaption(patch.caption) : row.caption,
      hashtags: patch.hashtags !== undefined ? cleanHashtags(patch.hashtags) : row.hashtags,
      link_url: patch.linkUrl !== undefined ? cleanLink(patch.linkUrl) : row.link_url,
      media_asset_ids: patch.mediaAssetIds !== undefined ? await checkMedia(db, ctx.org.orgId, patch.mediaAssetIds) : row.media_asset_ids,
    };
    const changed = CONTENT_KEYS.filter((k) => JSON.stringify(next[k]) !== JSON.stringify(row[k]));
    const tz = patch.timezone !== undefined ? patch.timezone : row.timezone;
    if (!changed.length && tz === row.timezone) return (await viewsFor(db, ctx.org.orgId, [row]))[0];
    const resets = changed.length > 0 && ["pending_approval", "approved", "scheduled", "publishing", "failed"].includes(row.status);
    if (changed.length && (row.status === "scheduled" || row.status === "publishing")) {
      if (!(await cancelQueuedJob(db, row.id))) throw new AppError("conflict", row.status === "publishing" ? "This post is being sent or checked right now and cannot be changed." : "This post is being sent right now and cannot be changed.");
    }
    const code = next.link_url && settings.trackingLinks ? row.tracking_code ?? newTrackingCode() : next.link_url ? row.tracking_code : null;
    const nextStatus: PostStatus = resets ? "draft" : row.status;
    const { rows } = await db.query<PostRow>(
      `update social_posts set account_id = $3, campaign_id = $4, kind = $5, caption = $6, hashtags = $7, link_url = $8, media_asset_ids = $9, tracking_code = $10, timezone = $11,
         version = version + $12, status = $13,
         approved_version = case when $14 then null else approved_version end, approved_by = case when $14 then null else approved_by end, approved_at = case when $14 then null else approved_at end,
         failure_code = case when $14 then null else failure_code end, failure_message = case when $14 then null else failure_message end
       where id = $1 and org_id = $2 returning ${POST_COLUMNS}`,
      [id, ctx.org.orgId, next.account_id, next.campaign_id, next.kind, next.caption, next.hashtags, next.link_url, next.media_asset_ids, code, tz, changed.length ? 1 : 0, nextStatus, resets],
    );
    await addEvent(db, ctx.org.orgId, id, "edited", { id: ctx.user.id, kind: "user" }, { changed: [...changed], approvalVoided: resets });
    return (await viewsFor(db, ctx.org.orgId, rows))[0];
  });
}

/** Sends a draft for approval. Blocking problems stop it here, so a reviewer is never asked to look at something that could not be published. */
export async function submitForApproval(ctx: OrgContext, id: string): Promise<PostView> {
  must(ctx, "social.create", "Your role can't write social posts.");
  return withSystem(async (db) => {
    const row = await loadPostRow(db, ctx.org.orgId, id, true);
    if (!row) throw new AppError("not_found", "That post was not found.");
    if (!canEditRow(ctx, row)) throw new AppError("forbidden", "Only the person who wrote this post, or a manager, can send it for approval.");
    if (!canTransition(row.status, "pending_approval")) throw new AppError("conflict", "This post cannot be sent for approval from its current state.");
    await checkAccount(db, ctx.org.orgId, row.account_id);
    const [v] = await viewsFor(db, ctx.org.orgId, [row]);
    const blocking = v.problems.filter((p) => p.level === "blocking");
    if (blocking.length) throw new AppError("invalid_input", blocking[0].message);
    await db.query("update social_posts set status = 'pending_approval', decision_note = null where id = $1 and org_id = $2", [id, ctx.org.orgId]);
    await addEvent(db, ctx.org.orgId, id, "submitted", { id: ctx.user.id, kind: "user" }, { version: row.version });
    await announce(db, ctx.org.orgId, "social.approval_requested", row, { accountId: row.account_id, origin: row.origin });
    await notifyOrgRoles(db, ctx.org.orgId, ["owner", "admin"], { kind: "social_approval_requested", title: "A social post is waiting for your approval", body: `${v.accountName}: ${v.caption.slice(0, 140) || "(picture or video)"}`, link: `/social/posts/${id}`, dedupeKey: `social-approval:${id}:${row.version}` });
    const after = await loadPostRow(db, ctx.org.orgId, id);
    return (await viewsFor(db, ctx.org.orgId, [after as PostRow]))[0];
  });
}

export type Decision = "approve" | "request_changes" | "reject";

/** A reviewer's decision, bound to the version they looked at. Approving needs the approve permission, and a second pair of eyes when the workspace asked for one. */
export async function decide(ctx: OrgContext, id: string, input: { decision: Decision; version: number; note?: string | null }): Promise<PostView> {
  must(ctx, "social.approve", "Only the business owner or a manager can approve social posts.");
  const note = input.note?.trim().slice(0, 600) || null;
  if (input.decision === "request_changes" && !note) throw new AppError("invalid_input", "Say what should change.");
  return withSystem(async (db) => {
    const row = await loadPostRow(db, ctx.org.orgId, id, true);
    if (!row) throw new AppError("not_found", "That post was not found.");
    if (row.status !== "pending_approval") throw new AppError("conflict", "This post is not waiting for approval.");
    if (row.version !== input.version) throw new AppError("conflict", "The post changed while you were reviewing it. Review the new version.");
    const settings = await readSettings(db, ctx.org.orgId);
    if (input.decision === "approve") {
      if (row.author_id === ctx.user.id && !selfApprovalAllowed(settings.approvalForPublishers)) throw new AppError("forbidden", "Your workspace asks for a second person to approve each post. Ask another owner or manager.");
      const [v] = await viewsFor(db, ctx.org.orgId, [row]);
      const blocking = v.problems.filter((p) => p.level === "blocking");
      if (blocking.length) throw new AppError("invalid_input", blocking[0].message);
    }
    const to: PostStatus = input.decision === "approve" ? "approved" : input.decision === "reject" ? "rejected" : "changes_requested";
    if (!canTransition(row.status, to)) throw new AppError("conflict", "That decision is not possible now.");
    if (to === "approved") {
      await db.query("update social_posts set status = 'approved', approved_version = version, approved_by = $3, approved_at = now(), decision_note = $4 where id = $1 and org_id = $2", [id, ctx.org.orgId, ctx.user.id, note]);
    } else {
      await db.query("update social_posts set status = $3, decision_note = $4, approved_version = null, approved_by = null, approved_at = null where id = $1 and org_id = $2", [id, ctx.org.orgId, to, note]);
    }
    const kind = input.decision === "approve" ? "approved" : input.decision === "reject" ? "rejected" : "changes_requested";
    await addEvent(db, ctx.org.orgId, id, kind, { id: ctx.user.id, kind: "user" }, { version: row.version, note });
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: `social.post_${kind}`, targetType: "social_post", targetId: id, result: "success", metadata: { version: row.version, origin: row.origin } }, db);
    if (row.author_id && row.author_id !== ctx.user.id) {
      await notifyUser(db, row.author_id, ctx.org.orgId, {
        kind: "social_approval_decided", title: input.decision === "approve" ? "Your social post was approved" : input.decision === "reject" ? "Your social post was rejected" : "Changes were requested on your social post",
        body: note ?? undefined, link: `/social/posts/${id}`, dedupeKey: `social-decided:${id}:${row.version}:${kind}`,
      });
    }
    return (await viewsFor(db, ctx.org.orgId, [(await loadPostRow(db, ctx.org.orgId, id)) as PostRow]))[0];
  });
}

export interface ScheduleInput {
  at?: Date;
  /** Publish as soon as a worker can, instead of at a chosen time. */
  asap?: boolean;
  timezone?: string | null;
}

/**
 * Queues an approved post for publication. A post that does not need approval (a person who may publish, scheduling their own non-AI post, in a workspace that
 * did not ask for review) is approved by that act, and the history says so. Asking twice for the same time returns the same job: no second publication.
 */
export async function schedulePost(ctx: OrgContext, id: string, input: ScheduleInput, deps: { now?: Date } = {}): Promise<PostView> {
  must(ctx, "social.publish", "Your role can't schedule social posts.");
  const now = deps.now ?? new Date();
  const at = input.asap ? now : input.at;
  if (!at) throw new AppError("invalid_input", "Choose a date and time.");
  if (!input.asap) {
    const why = scheduleProblem(at, now);
    if (why) throw new AppError("invalid_input", why);
  }
  return withSystem(async (db) => {
    const row = await loadPostRow(db, ctx.org.orgId, id, true);
    if (!row) throw new AppError("not_found", "That post was not found.");
    if (row.status === "scheduled" && row.scheduled_at && new Date(row.scheduled_at).getTime() === at.getTime()) return (await viewsFor(db, ctx.org.orgId, [row]))[0]; // already so
    const settings = await readSettings(db, ctx.org.orgId);
    const needsApproval = approvalRequired({ origin: row.origin, authorCanPublish: row.author_id === ctx.user.id && ctx.can("social.publish"), approvalForPublishers: settings.approvalForPublishers });
    const selfApprove = (row.status === "draft" || row.status === "changes_requested") && !needsApproval;
    if (row.status !== "approved" && !selfApprove) {
      throw new AppError("conflict", row.status === "draft" || row.status === "changes_requested" || row.status === "pending_approval" ? "This post needs to be approved before it can be scheduled." : "This post cannot be scheduled from its current state.");
    }
    if (row.status === "scheduled") throw new AppError("conflict", "Use reschedule to change the time of a scheduled post.");
    const account = await checkAccount(db, ctx.org.orgId, row.account_id);
    if (account.status !== "connected") throw new AppError("conflict", "This account needs to be reconnected before anything can be published to it.");
    const [v] = await viewsFor(db, ctx.org.orgId, [row]);
    const blocking = v.problems.filter((p) => p.level === "blocking");
    if (blocking.length) throw new AppError("invalid_input", blocking[0].message);
    if (selfApprove) {
      await db.query("update social_posts set approved_version = version, approved_by = $3, approved_at = now() where id = $1 and org_id = $2", [id, ctx.org.orgId, ctx.user.id]);
      await addEvent(db, ctx.org.orgId, id, "self_approved", { id: ctx.user.id, kind: "user" }, { version: row.version });
      await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "social.post_approved", targetType: "social_post", targetId: id, result: "success", metadata: { version: row.version, self: true } }, db);
    } else if (row.approved_version !== row.version) {
      throw new AppError("conflict", "The approval is for an earlier version of this post. Send it for approval again.");
    }
    const ordinal = Number((await db.query<{ n: string }>("select count(*)::text as n from social_publish_jobs where post_id = $1", [id])).rows[0].n);
    await db.query("update social_posts set status = 'scheduled', scheduled_at = $3, timezone = coalesce($4, timezone), failure_code = null, failure_message = null where id = $1 and org_id = $2", [id, ctx.org.orgId, at, input.timezone ?? null]);
    await enqueueJob(db, { id, org_id: ctx.org.orgId, account_id: row.account_id, version: row.version }, at, ordinal);
    await addEvent(db, ctx.org.orgId, id, "scheduled", { id: ctx.user.id, kind: "user" }, { at: at.toISOString(), asap: Boolean(input.asap) });
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "social.post_scheduled", targetType: "social_post", targetId: id, result: "success", metadata: { at: at.toISOString(), version: row.version } }, db);
    return (await viewsFor(db, ctx.org.orgId, [(await loadPostRow(db, ctx.org.orgId, id)) as PostRow]))[0];
  });
}

/**
 * Moves a scheduled post to another time. The old job is cancelled first; if a worker already holds it, the move is refused rather than risk two. A post waiting
 * out a retry (nothing in flight) can be moved as well: it goes back to scheduled, and the new job starts from the beginning.
 */
export async function reschedulePost(ctx: OrgContext, id: string, input: { at: Date; timezone?: string | null }, deps: { now?: Date } = {}): Promise<PostView> {
  must(ctx, "social.publish", "Your role can't reschedule social posts.");
  const now = deps.now ?? new Date();
  const why = scheduleProblem(input.at, now);
  if (why) throw new AppError("invalid_input", why);
  return withSystem(async (db) => {
    const row = await loadPostRow(db, ctx.org.orgId, id, true);
    if (!row) throw new AppError("not_found", "That post was not found.");
    if (row.status !== "scheduled" && row.status !== "publishing") throw new AppError("conflict", "Only a scheduled post can be moved.");
    if (row.scheduled_at && new Date(row.scheduled_at).getTime() === input.at.getTime()) return (await viewsFor(db, ctx.org.orgId, [row]))[0];
    if (!(await cancelQueuedJob(db, id))) throw new AppError("conflict", "This post is being sent right now and cannot be moved.");
    const ordinal = Number((await db.query<{ n: string }>("select count(*)::text as n from social_publish_jobs where post_id = $1", [id])).rows[0].n);
    await db.query("update social_posts set status = 'scheduled', scheduled_at = $3, timezone = coalesce($4, timezone) where id = $1 and org_id = $2", [id, ctx.org.orgId, input.at, input.timezone ?? null]);
    await enqueueJob(db, { id, org_id: ctx.org.orgId, account_id: row.account_id, version: row.version }, input.at, ordinal);
    await addEvent(db, ctx.org.orgId, id, "rescheduled", { id: ctx.user.id, kind: "user" }, { from: iso(row.scheduled_at), to: input.at.toISOString() });
    return (await viewsFor(db, ctx.org.orgId, [(await loadPostRow(db, ctx.org.orgId, id)) as PostRow]))[0];
  });
}

/**
 * Cancels a post that has not been published. A post being sent, or that may already have been sent, is never silently cancelled. A post waiting out a retry
 * (its job queued, nothing in flight) is not being sent, so it can be.
 */
export async function cancelPost(ctx: OrgContext, id: string): Promise<PostView> {
  must(ctx, "social.create", "Your role can't change social posts.");
  return withSystem(async (db) => {
    const row = await loadPostRow(db, ctx.org.orgId, id, true);
    if (!row) throw new AppError("not_found", "That post was not found.");
    if (!canEditRow(ctx, row)) throw new AppError("forbidden", "Only the person who wrote this post, or a manager, can cancel it.");
    // It may be live: only a person looking at the Page can say, and cancelling it would hide that from everyone.
    if (row.status === "failed" && row.failure_code === "unknown_outcome") throw new AppError("conflict", "The platform may already have this post. Look at the Page and say whether it was posted before cancelling it.");
    const retrying = row.status === "publishing";
    if (!retrying && !canTransition(row.status, "cancelled")) throw new AppError("conflict", row.status === "needs_reconciliation" ? "This post is being sent or checked, so it cannot be cancelled now. If it appears on the Page, remove it there." : "This post cannot be cancelled.");
    if ((row.status === "scheduled" || retrying) && !(await cancelQueuedJob(db, id))) throw new AppError("conflict", retrying ? "This post is being sent or checked, so it cannot be cancelled now. If it appears on the Page, remove it there." : "This post is being sent right now and cannot be cancelled.");
    await db.query("update social_posts set status = 'cancelled' where id = $1 and org_id = $2", [id, ctx.org.orgId]);
    await addEvent(db, ctx.org.orgId, id, "cancelled", { id: ctx.user.id, kind: "user" }, {});
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "social.post_cancelled", targetType: "social_post", targetId: id, result: "success" }, db);
    return (await viewsFor(db, ctx.org.orgId, [(await loadPostRow(db, ctx.org.orgId, id)) as PostRow]))[0];
  });
}

/** Tries a failed post again. Not offered when the platform may already have it: that needs a person to look at the Page first. */
export async function retryPost(ctx: OrgContext, id: string, deps: { now?: Date } = {}): Promise<PostView> {
  must(ctx, "social.publish", "Your role can't retry social posts.");
  const now = deps.now ?? new Date();
  return withSystem(async (db) => {
    const row = await loadPostRow(db, ctx.org.orgId, id, true);
    if (!row) throw new AppError("not_found", "That post was not found.");
    if (row.status !== "failed") throw new AppError("conflict", "Only a failed post can be retried.");
    if (row.failure_code === "unknown_outcome") throw new AppError("conflict", "The platform may already have this post. Look at the Page, then say whether it was posted.");
    const account = await checkAccount(db, ctx.org.orgId, row.account_id);
    if (account.status !== "connected") throw new AppError("conflict", "This account needs to be reconnected before anything can be published to it.");
    if (row.approved_version !== row.version) throw new AppError("conflict", "This post was changed after it was approved. Send it for approval again.");
    const live = await db.query("select 1 from social_publish_jobs where post_id = $1 and status in ('queued', 'running', 'unknown')", [id]);
    if (live.rows[0]) throw new AppError("conflict", "This post is already being published.");
    const ordinal = Number((await db.query<{ n: string }>("select count(*)::text as n from social_publish_jobs where post_id = $1", [id])).rows[0].n);
    await db.query("update social_posts set status = 'scheduled', scheduled_at = $3, failure_code = null, failure_message = null where id = $1 and org_id = $2", [id, ctx.org.orgId, now]);
    await enqueueJob(db, { id, org_id: ctx.org.orgId, account_id: row.account_id, version: row.version }, now, ordinal);
    await addEvent(db, ctx.org.orgId, id, "retry_requested", { id: ctx.user.id, kind: "user" }, {});
    return (await viewsFor(db, ctx.org.orgId, [(await loadPostRow(db, ctx.org.orgId, id)) as PostRow]))[0];
  });
}

// Where a post's own address can be, by platform. Checked only for real accounts: the simulated platform's links are on its own address.
const PERMALINK_HOSTS: Record<Platform, readonly string[]> = { facebook: ["facebook.com", "fb.com"], instagram: ["instagram.com"] };

/** The address a person pasted for a post they found on the Page: an https address, on the platform's own site for a real account, or nothing. */
function cleanPermalink(raw: string | null | undefined, account: Pick<AccountRow, "platform" | "adapter">): string | null {
  const text = raw?.trim();
  if (!text) return null;
  const bad = () => new AppError("invalid_input", "Paste the full link to the post, starting with https://.");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw bad();
  }
  if (url.protocol !== "https:" || url.username || url.password) throw bad();
  if (account.adapter === "meta") {
    const host = url.hostname.toLowerCase();
    if (!PERMALINK_HOSTS[account.platform].some((d) => host === d || host.endsWith(`.${d}`))) throw new AppError("invalid_input", `That link is not on ${PERMALINK_HOSTS[account.platform][0]}. Paste the link to the post from the Page.`);
  }
  if (url.href.length > 500) throw new AppError("invalid_input", "That link is too long. Paste the shorter link to the post.");
  return url.href;
}

/** A person looked at the Page and says whether a post whose outcome could not be confirmed is there. It is recorded as their word, and audited. */
export async function resolveUnknown(ctx: OrgContext, id: string, input: { outcome: "posted" | "not_posted"; permalink?: string | null }): Promise<PostView> {
  must(ctx, "social.publish", "Your role can't resolve social posts.");
  return withSystem(async (db) => {
    const row = await loadPostRow(db, ctx.org.orgId, id, true);
    if (!row) throw new AppError("not_found", "That post was not found.");
    const unresolved = row.status === "needs_reconciliation" || (row.status === "failed" && row.failure_code === "unknown_outcome");
    if (!unresolved) throw new AppError("conflict", "This post does not need checking.");
    const account = input.outcome === "posted" ? await loadAccountRow(db, ctx.org.orgId, row.account_id) : null;
    const permalink = account ? cleanPermalink(input.permalink, account) : null;
    await db.query("update social_publish_jobs set status = $2, finished_at = now(), lease_until = null where post_id = $1 and status in ('unknown', 'running', 'queued', 'failed') and finished_at is null", [id, input.outcome === "posted" ? "succeeded" : "failed"]);
    if (input.outcome === "posted") {
      await db.query("update social_posts set status = 'published', provider_post_id = coalesce(provider_post_id, $3), permalink = $4, published_at = coalesce(published_at, now()), failure_code = null, failure_message = null where id = $1 and org_id = $2", [id, ctx.org.orgId, `manual:${id}`, permalink]);
    } else {
      await db.query("update social_posts set status = 'failed', failure_code = 'confirmed_not_posted', failure_message = 'A person confirmed this was not posted. You can try again.' where id = $1 and org_id = $2", [id, ctx.org.orgId]);
    }
    await addEvent(db, ctx.org.orgId, id, "resolved_by_person", { id: ctx.user.id, kind: "user" }, { outcome: input.outcome });
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "social.post_resolved", targetType: "social_post", targetId: id, result: "success", metadata: { outcome: input.outcome } }, db);
    return (await viewsFor(db, ctx.org.orgId, [(await loadPostRow(db, ctx.org.orgId, id)) as PostRow]))[0];
  });
}

/**
 * A new draft with the same content: how a published post is posted again, or a good post is reused. A copy of AI-written text is still AI-written: it keeps its
 * origin and its AI run, so it still needs a person's approval and the always-approve rule cannot be sidestepped by copying.
 */
export async function duplicatePost(ctx: OrgContext, id: string): Promise<PostView> {
  must(ctx, "social.create", "Your role can't write social posts.");
  return withSystem(async (db) => {
    const row = await loadPostRow(db, ctx.org.orgId, id);
    if (!row) throw new AppError("not_found", "That post was not found.");
    const copy = await insertDraft(db, { orgId: ctx.org.orgId, userId: ctx.user.id }, { accountId: row.account_id, kind: row.kind, caption: row.caption, hashtags: row.hashtags, linkUrl: row.link_url, mediaAssetIds: row.media_asset_ids, campaignId: row.campaign_id }, row.origin, row.origin === "ai" ? row.ai_run_id : null, { copy: true });
    await addEvent(db, ctx.org.orgId, copy.id, "duplicated", { id: ctx.user.id, kind: "user" }, { from: id, origin: row.origin });
    return (await viewsFor(db, ctx.org.orgId, [copy]))[0];
  });
}
