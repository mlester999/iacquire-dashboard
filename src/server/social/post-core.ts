import "server-only";
import crypto from "node:crypto";
import type { Queryable } from "@/server/db";
import { systemActor } from "@/server/crm/actor";
import { emitEvent } from "@/server/crm/events";
import { composeCaption, trackedLink, type MediaFacts, type Platform, type PostKind } from "@/lib/social/rules";
import type { PostStatus } from "@/lib/social/state";

// What the posts service and the publisher both need: reading a post and the account it belongs to, the settings, the history log, and the text and link that
// will actually be sent. No permission checks live here: the callers make them.

export interface PostRow {
  id: string;
  org_id: string;
  account_id: string;
  campaign_id: string | null;
  kind: PostKind;
  caption: string;
  hashtags: string[];
  link_url: string | null;
  tracking_code: string | null;
  media_asset_ids: string[];
  status: PostStatus;
  scheduled_at: Date | null;
  timezone: string | null;
  origin: "human" | "ai";
  ai_run_id: string | null;
  author_id: string | null;
  version: number;
  approved_version: number | null;
  approved_by: string | null;
  approved_at: Date | null;
  decision_note: string | null;
  provider_post_id: string | null;
  permalink: string | null;
  published_at: Date | null;
  failure_code: string | null;
  failure_message: string | null;
  created_at: Date;
  updated_at: Date;
}

export const POST_COLUMNS =
  "id, org_id, account_id, campaign_id, kind, caption, hashtags, link_url, tracking_code, media_asset_ids, status, scheduled_at, timezone, origin, ai_run_id, author_id, version, approved_version, approved_by, approved_at, decision_note, provider_post_id, permalink, published_at, failure_code, failure_message, created_at, updated_at";

export async function loadPostRow(db: Queryable, orgId: string, id: string, lock = false): Promise<PostRow | null> {
  const { rows } = await db.query<PostRow>(`select ${POST_COLUMNS} from social_posts where id = $1 and org_id = $2${lock ? " for update" : ""}`, [id, orgId]);
  return rows[0] ?? null;
}

export interface SettingsRow {
  approvalForPublishers: boolean;
  aiDraftsEnabled: boolean;
  trackingLinks: boolean;
  defaultHashtags: string[];
  brandVoiceNote: string | null;
  version: number;
}

export const DEFAULT_SETTINGS: SettingsRow = { approvalForPublishers: false, aiDraftsEnabled: true, trackingLinks: true, defaultHashtags: [], brandVoiceNote: null, version: 0 };

export async function readSettings(db: Queryable, orgId: string): Promise<SettingsRow> {
  const { rows } = await db.query<{ approval_for_publishers: boolean; ai_drafts_enabled: boolean; tracking_links: boolean; default_hashtags: string[]; brand_voice_note: string | null; version: number }>(
    "select approval_for_publishers, ai_drafts_enabled, tracking_links, default_hashtags, brand_voice_note, version from social_settings where org_id = $1", [orgId],
  );
  const r = rows[0];
  return r ? { approvalForPublishers: r.approval_for_publishers, aiDraftsEnabled: r.ai_drafts_enabled, trackingLinks: r.tracking_links, defaultHashtags: r.default_hashtags, brandVoiceNote: r.brand_voice_note, version: r.version } : { ...DEFAULT_SETTINGS };
}

export async function addEvent(db: Queryable, orgId: string, postId: string, kind: string, actor: { id: string | null; kind: "user" | "ai" | "system" }, detail: Record<string, unknown> = {}): Promise<void> {
  await db.query("insert into social_post_events (org_id, post_id, kind, actor_id, actor_kind, detail) values ($1, $2, $3, $4, $5, $6::jsonb)", [orgId, postId, kind.slice(0, 40), actor.id, actor.kind, JSON.stringify(detail)]);
}

/**
 * Announces what happened to a post to the automation event outbox, once per post and version (a redelivered or repeated call records nothing new). The event
 * carries no contact and no customer data: the post, the platform and the account, and for a failure the reason. `occurrence` makes the key finer than the
 * version for things that can happen again to the same version: a failed post that is retried and fails again is announced again, once per failed job.
 */
export async function announce(db: Queryable, orgId: string, type: "social.post_published" | "social.post_failed" | "social.approval_requested", post: Pick<PostRow, "id" | "version" | "kind">, detail: Record<string, unknown> = {}, occurrence?: string): Promise<void> {
  await emitEvent(db, systemActor({ id: orgId }), {
    type, entityType: "social_post", entityId: post.id, payload: { postId: post.id, kind: post.kind, ...detail }, dedupeKey: `${type}:${post.id}:${post.version}${occurrence ? `:${occurrence}` : ""}`,
  });
}

export interface AccountRow {
  id: string;
  org_id: string;
  platform: Platform;
  adapter: "meta" | "simulated";
  external_id: string;
  name: string;
  credentials: string | null;
  status: "connected" | "needs_reauth" | "error" | "revoked" | "disconnected";
  capabilities: { contentTypes?: PostKind[] } | null;
  rate_state: { quotaUsage?: number; quotaTotal?: number; blockedUntil?: string } | null;
}

export async function loadAccountRow(db: Queryable, orgId: string, id: string): Promise<AccountRow | null> {
  const { rows } = await db.query<AccountRow>("select id, org_id, platform, adapter, external_id, name, credentials, status, capabilities, rate_state from social_accounts where id = $1 and org_id = $2", [id, orgId]);
  return rows[0] ?? null;
}

/**
 * A library file is usable only while its stored copy is. A managed file whose stored copy is not ready (deleted, or being removed) counts as removed, so a post
 * that uses it is refused when it is sent for approval, with the same message as when it is published, and not first on the day it should have gone out.
 * Written for `social_media_assets a left join private_files f on f.id = a.private_file_id and f.org_id = a.org_id`.
 */
export const USABLE_ASSET_STATUS_SQL = "case when a.status = 'ready' and a.source = 'managed' and f.status is distinct from 'ready' then 'removed' else a.status end";
export const ASSET_FILE_JOIN_SQL = "left join private_files f on f.id = a.private_file_id and f.org_id = a.org_id";

/** The files of a post as the checks see them. An id that is not this workspace's (or is gone) comes back as removed, so it can never be used or even detected. */
export async function mediaFactsFor(db: Queryable, orgId: string, ids: readonly string[]): Promise<MediaFacts[]> {
  if (!ids.length) return [];
  const { rows } = await db.query<{ id: string; kind: "image" | "video"; mime_type: string; size_bytes: number; width: number | null; height: number | null; status: "ready" | "invalid" | "removed" }>(
    `select a.id, a.kind, a.mime_type, a.size_bytes, a.width, a.height, ${USABLE_ASSET_STATUS_SQL} as status from social_media_assets a ${ASSET_FILE_JOIN_SQL} where a.org_id = $1 and a.id = any($2::uuid[])`, [orgId, ids as string[]],
  );
  const by = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id): MediaFacts => {
    const r = by.get(id);
    return r ? { id, kind: r.kind, mimeType: r.mime_type, sizeBytes: r.size_bytes, width: r.width, height: r.height, status: r.status } : { id, kind: "image", mimeType: "", sizeBytes: 0, width: null, height: null, status: "removed" };
  });
}

/** What is sent: the caption with its hashtags, and the link with this post's source tags when tracking is on. A picture or video post's link rides in the text. */
export function messageFor(post: Pick<PostRow, "kind" | "caption" | "hashtags" | "link_url" | "tracking_code">, platform: Platform, campaignTag: string | null, tracking: boolean): { message: string; linkUrl: string | null } {
  let message = composeCaption(post.caption, post.hashtags);
  let link = post.link_url;
  if (link && tracking && post.tracking_code) link = trackedLink(link, { platform, campaign: campaignTag, trackingCode: post.tracking_code }) ?? link;
  if (link && platform === "facebook" && (post.kind === "image" || post.kind === "video")) {
    message = `${message}${message ? "\n\n" : ""}${link}`;
    link = null;
  }
  if (platform === "instagram") link = null; // not clickable there: the caption is what is posted
  return { message, linkUrl: link };
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
export function newTrackingCode(): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s;
}
