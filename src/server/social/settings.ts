import "server-only";
import { withSystem, withUser } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import type { OrgContext } from "@/server/tenancy/context";
import { campaignTag, normalizeHashtags } from "@/lib/social/rules";
import { readSettings, type SettingsRow } from "@/server/social/post-core";

export type SocialSettings = SettingsRow;

export async function getSocialSettings(ctx: OrgContext): Promise<SocialSettings> {
  if (!ctx.can("social.view")) throw new AppError("forbidden", "Your role can't see social media.");
  return withUser(ctx.user.id, (db) => readSettings(db, ctx.org.orgId));
}

export interface SettingsPatch {
  approvalForPublishers?: boolean;
  aiDraftsEnabled?: boolean;
  trackingLinks?: boolean;
  defaultHashtags?: string[];
  brandVoiceNote?: string | null;
}

/** The workspace's rules for social posts. Only the owner changes them. There is no setting that lets an AI draft publish itself. */
export async function saveSocialSettings(ctx: OrgContext, patch: SettingsPatch, expectedVersion: number): Promise<SocialSettings> {
  if (!ctx.can("social.settings")) throw new AppError("forbidden", "Only the business owner can change the social media settings.");
  return withSystem(async (db) => {
    const cur = await readSettings(db, ctx.org.orgId);
    if (cur.version !== expectedVersion) throw new AppError("conflict", "Someone else changed these settings. Reload to see their changes, then try again.");
    const next = {
      approvalForPublishers: patch.approvalForPublishers ?? cur.approvalForPublishers,
      aiDraftsEnabled: patch.aiDraftsEnabled ?? cur.aiDraftsEnabled,
      trackingLinks: patch.trackingLinks ?? cur.trackingLinks,
      defaultHashtags: patch.defaultHashtags !== undefined ? normalizeHashtags(patch.defaultHashtags, 10) : cur.defaultHashtags,
      brandVoiceNote: patch.brandVoiceNote !== undefined ? patch.brandVoiceNote?.replace(/\s+/g, " ").trim().slice(0, 600) || null : cur.brandVoiceNote,
    };
    await db.query(
      `insert into social_settings (org_id, approval_for_publishers, ai_drafts_enabled, tracking_links, default_hashtags, brand_voice_note, version, updated_by)
       values ($1, $2, $3, $4, $5, $6, 1, $7)
       on conflict (org_id) do update set approval_for_publishers = excluded.approval_for_publishers, ai_drafts_enabled = excluded.ai_drafts_enabled, tracking_links = excluded.tracking_links,
         default_hashtags = excluded.default_hashtags, brand_voice_note = excluded.brand_voice_note, version = social_settings.version + 1, updated_by = excluded.updated_by, updated_at = now()
       where social_settings.version = $8`,
      [ctx.org.orgId, next.approvalForPublishers, next.aiDraftsEnabled, next.trackingLinks, next.defaultHashtags, next.brandVoiceNote, ctx.user.id, expectedVersion],
    );
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "social.settings_saved", targetType: "social_settings", targetId: ctx.org.orgId, result: "success", metadata: { approvalForPublishers: next.approvalForPublishers, aiDraftsEnabled: next.aiDraftsEnabled } }, db);
    return readSettings(db, ctx.org.orgId);
  });
}

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

export interface CampaignView {
  id: string;
  name: string;
  goal: string | null;
  utmCampaign: string;
  startsOn: string | null;
  endsOn: string | null;
  status: "active" | "archived";
}

export async function listCampaigns(ctx: OrgContext): Promise<CampaignView[]> {
  if (!ctx.can("social.view")) throw new AppError("forbidden", "Your role can't see social media.");
  return withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<{ id: string; name: string; goal: string | null; utm_campaign: string; starts_on: string | null; ends_on: string | null; status: "active" | "archived" }>(
      "select id, name, goal, utm_campaign, to_char(starts_on, 'YYYY-MM-DD') as starts_on, to_char(ends_on, 'YYYY-MM-DD') as ends_on, status from social_campaigns where org_id = $1 order by status, created_at desc", [ctx.org.orgId],
    );
    return rows.map((r) => ({ id: r.id, name: r.name, goal: r.goal, utmCampaign: r.utm_campaign, startsOn: r.starts_on, endsOn: r.ends_on, status: r.status }));
  });
}

export async function createCampaign(ctx: OrgContext, input: { name: string; goal?: string | null; startsOn?: string | null; endsOn?: string | null }): Promise<CampaignView> {
  if (!ctx.can("social.create")) throw new AppError("forbidden", "Your role can't write social posts.");
  const name = input.name.replace(/\s+/g, " ").trim().slice(0, 120);
  const tag = campaignTag(name);
  if (!name || !tag) throw new AppError("invalid_input", "Give the campaign a name.");
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  const startsOn = input.startsOn && DAY.test(input.startsOn) ? input.startsOn : null;
  const endsOn = input.endsOn && DAY.test(input.endsOn) ? input.endsOn : null;
  if (startsOn && endsOn && endsOn < startsOn) throw new AppError("invalid_input", "The campaign cannot end before it starts.");
  return withSystem(async (db) => {
    const taken = await db.query("select 1 from social_campaigns where org_id = $1 and utm_campaign = $2 and status = 'active'", [ctx.org.orgId, tag]);
    if (taken.rows[0]) throw new AppError("conflict", "You already have an active campaign with that name.");
    const { rows } = await db.query<{ id: string }>("insert into social_campaigns (org_id, name, goal, utm_campaign, starts_on, ends_on, created_by) values ($1, $2, $3, $4, $5, $6, $7) returning id", [ctx.org.orgId, name, input.goal?.trim().slice(0, 400) || null, tag, startsOn, endsOn, ctx.user.id]);
    return { id: rows[0].id, name, goal: input.goal?.trim().slice(0, 400) || null, utmCampaign: tag, startsOn, endsOn, status: "active" as const };
  });
}

export async function archiveCampaign(ctx: OrgContext, id: string): Promise<void> {
  if (!ctx.can("social.create")) throw new AppError("forbidden", "Your role can't write social posts.");
  await withSystem(async (db) => {
    const r = await db.query("update social_campaigns set status = 'archived' where id = $1 and org_id = $2 and status = 'active' returning id", [id, ctx.org.orgId]);
    if (!r.rows[0]) throw new AppError("not_found", "That campaign was not found.");
  });
}
