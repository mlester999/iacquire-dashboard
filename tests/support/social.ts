// Fixtures for the social media manager tests. Synthetic workspaces only: no platform is contacted, and every account is the in-process simulated one.
import { withSystem } from "@/server/db";
import { messagingOrg, type MessagingOrg } from "./messaging";
import { connectSimulatedAccount, type AccountView } from "@/server/social/accounts";
import { createPost, schedulePost, submitForApproval, decide, type PostInput, type PostView } from "@/server/social/posts";
import { simulated } from "@/server/social/providers/simulated";
import { processDueSocialPosts, type PublisherDeps } from "@/server/social/publisher";
import type { Platform } from "@/lib/social/rules";

export interface SocialOrg {
  m: MessagingOrg;
  owner: ReturnType<MessagingOrg["ctx"]>;
  manager: ReturnType<MessagingOrg["ctx"]>;
  sales: ReturnType<MessagingOrg["ctx"]>;
  viewer: ReturnType<MessagingOrg["ctx"]>;
}

export async function socialOrg(opts: Parameters<typeof messagingOrg>[0] = {}): Promise<SocialOrg> {
  simulated.reset();
  const m = await messagingOrg(opts);
  return { m, owner: m.ctx("owner"), manager: m.ctx("manager"), sales: m.ctx("sales"), viewer: m.ctx("viewer") };
}

export const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;

export const connect = (s: SocialOrg, platform: Platform = "facebook", name = "Harbor Home Page"): Promise<AccountView> => connectSimulatedAccount(s.owner, { platform, name });

export const textPost = (accountId: string, over: Partial<PostInput> = {}): PostInput => ({ accountId, kind: "text", caption: "Spring tune-up special: book this week.", ...over });

/** A post written by sales, approved by the manager, ready to schedule. */
export async function approvedPost(s: SocialOrg, accountId: string, over: Partial<PostInput> = {}): Promise<PostView> {
  const draft = await createPost(s.sales, textPost(accountId, over));
  const pending = await submitForApproval(s.sales, draft.id);
  return decide(s.manager, pending.id, { decision: "approve", version: pending.version });
}

export const at = (iso: string) => new Date(iso);
export const NOW = new Date("2026-10-23T12:00:00Z");
export const LATER = new Date("2026-10-23T13:00:00Z");

/** A scheduled post: approved, then queued for LATER. */
export async function scheduledPost(s: SocialOrg, accountId: string, over: Partial<PostInput> = {}, when = LATER): Promise<PostView> {
  const p = await approvedPost(s, accountId, over);
  return schedulePost(s.manager, p.id, { at: when }, { now: NOW });
}

/** One publisher pass at a chosen time, with a fixed jitter so retry times are predictable. */
export const tick = (s: SocialOrg, now: Date, deps: PublisherDeps = {}) => processDueSocialPosts({ now: () => now, jitter: () => 0, liveEnabled: () => false, workerId: "test-worker", orgId: s.m.org.id, ...deps });

export const minutes = (d: Date, n: number) => new Date(d.getTime() + n * 60_000);

/** A ready managed picture in the workspace's media library, with its stored-file record. No bytes exist: tests hand the publisher a fixed address instead. */
export async function addAsset(s: SocialOrg, over: { mime?: string; kind?: "image" | "video"; width?: number | null; height?: number | null; orgId?: string } = {}): Promise<string> {
  const orgId = over.orgId ?? s.m.org.id;
  const kind = over.kind ?? "image";
  const mime = over.mime ?? (kind === "image" ? "image/jpeg" : "video/mp4");
  return withSystem(async (db) => {
    const file = await db.query<{ id: string }>(
      "insert into private_files (org_id, bucket, storage_key, filename, mime_type, size_bytes, status) values ($1, 'social-media', $3::text || '/' || gen_random_uuid()::text || '/photo', 'photo', $2, 1000, 'ready') returning id",
      [orgId, mime, orgId],
    );
    const a = await db.query<{ id: string }>(
      "insert into social_media_assets (org_id, source, private_file_id, kind, filename, mime_type, size_bytes, width, height, status) values ($1, 'managed', $2, $3, 'photo', $4, 1000, $5, $6, 'ready') returning id",
      [orgId, file.rows[0].id, kind, mime, over.width === undefined ? 1080 : over.width, over.height === undefined ? 1080 : over.height],
    );
    return a.rows[0].id;
  });
}

export const MEDIA_URL = async (fileId: string) => `https://files.example.test/${fileId}`;
