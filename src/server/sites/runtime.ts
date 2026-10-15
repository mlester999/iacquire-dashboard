import "server-only";
import { withSiteRuntime } from "@/server/db";
import type { SiteContent } from "@/lib/website/doc";
import { parseStoredContent } from "@/lib/website/legacy";

// Everything the public website runtime may do, and nothing else. All reads go through restricted SQL functions that
// run as iaq_site_runtime (see the websites migration), so this module cannot reach drafts, other tenants or customers.

export interface LiveSite {
  websiteId: string;
  orgId: string;
  publicationId: string;
  templateKey: string;
  content: SiteContent;
  contentHash: string;
  hostKind: "platform" | "custom";
  publishedAt: string;
  canonicalHost: string;
}

const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Lower-cases a Host header, drops the port and a trailing dot, and returns null for anything that is not a hostname. */
export function normalizeHost(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const host = raw.trim().toLowerCase().replace(/:\d{1,5}$/, "").replace(/\.$/, "");
  return host.length <= 253 && HOST.test(host) ? host : null;
}

const CACHE_MS = 10_000;
const cache = new Map<string, { at: number; value: LiveSite | null }>();
export function clearSiteCache() {
  cache.clear();
  assetCache.clear();
}

/** A verified host with a live publication, or null. Cached for a few seconds so a busy site does not hit the database on every request. */
export async function resolveSite(rawHost: string): Promise<LiveSite | null> {
  const host = normalizeHost(rawHost);
  if (!host) return null;
  const hit = cache.get(host);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const rows = await withSiteRuntime((db) =>
    db.query<{
      website_id: string; org_id: string; publication_id: string; template_key: string; content: unknown; content_hash: string;
      host_kind: "platform" | "custom"; published_at: Date; canonical_host: string;
    }>("select * from app.site_by_host($1)", [host]),
  );
  const row = rows.rows[0];
  let value: LiveSite | null = null;
  if (row) {
    const parsed = parseStoredContent(row.content, row.template_key);
    // Content is validated when it is published; if it no longer parses (the schema moved on), serve nothing rather than guess.
    if (parsed.ok) {
      value = {
        websiteId: row.website_id, orgId: row.org_id, publicationId: row.publication_id, templateKey: row.template_key, content: parsed.content,
        contentHash: row.content_hash, hostKind: row.host_kind, publishedAt: new Date(row.published_at).toISOString(), canonicalHost: row.canonical_host,
      };
    }
  }
  if (cache.size > 2000) cache.clear();
  cache.set(host, { at: Date.now(), value });
  return value;
}

export interface SiteAsset {
  assetId: string;
  sha256: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  alt: string;
}

// A publication's images never change, so what we learn about them can be remembered for as long as the publication is live.
const assetCache = new Map<string, Map<string, SiteAsset>>();

export async function siteAssets(host: string, publicationId?: string): Promise<Map<string, SiteAsset>> {
  const normalized = normalizeHost(host);
  if (!normalized) return new Map();
  const cached = publicationId ? assetCache.get(publicationId) : undefined;
  if (cached) return cached;
  const { rows } = await withSiteRuntime((db) =>
    db.query<{ asset_id: string; sha256: string; mime_type: string; width: number | null; height: number | null; alt: string }>("select * from app.site_assets_for_host($1)", [normalized]),
  );
  const map = new Map(rows.map((r) => [r.asset_id.toLowerCase(), { assetId: r.asset_id, sha256: r.sha256, mimeType: r.mime_type, width: r.width, height: r.height, alt: r.alt }]));
  if (publicationId) {
    if (assetCache.size > 300) assetCache.clear();
    assetCache.set(publicationId, map);
  }
  return map;
}

export async function loadSiteAsset(host: string, sha256: string): Promise<{ mimeType: string; bytes: Buffer } | null> {
  const normalized = normalizeHost(host);
  if (!normalized || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  const { rows } = await withSiteRuntime((db) => db.query<{ mime_type: string; bytes: Buffer }>("select * from app.site_asset($1, $2)", [normalized, sha256]));
  return rows[0] ? { mimeType: rows[0].mime_type, bytes: Buffer.from(rows[0].bytes) } : null;
}

export async function siteRateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const { rows } = await withSiteRuntime((db) => db.query<{ ok: boolean }>("select app.site_rate_limit($1, $2, $3) as ok", [key, limit, windowSeconds]));
  return rows[0]?.ok === true;
}

export interface FormInput {
  host: string; page: string; name: string; email: string; phone: string; service: string; message: string;
  consent: boolean; marketing: boolean; consentText: string; ipHash: string; utm: Record<string, string>; referrer: string; dedupe: string;
  purpose?: "contact" | "consultation" | "lead" | "appointment"; formId?: string;
}
export type FormOutcome = "ok" | "duplicate" | "unknown_host" | "disabled" | "consent_required";

export async function submitSiteForm(i: FormInput): Promise<{ status: FormOutcome; id?: string }> {
  const { rows } = await withSiteRuntime((db) =>
    db.query<{ result: { status: FormOutcome; id?: string } }>("select app.submit_site_form($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) as result", [
      i.host, i.page, i.name, i.email, i.phone, i.service, i.message, i.consent, i.marketing, i.consentText, i.ipHash, JSON.stringify(i.utm), i.referrer, i.dedupe, i.purpose ?? "contact", i.formId ?? null,
    ]),
  );
  return rows[0]?.result ?? { status: "unknown_host" };
}

// ---------------------------------------------------------------------------
// Usage: counted in memory and written in batches, so measuring never slows a page down.
// ---------------------------------------------------------------------------

const pending = new Map<string, { requests: number; bytes: number }>();
let lastFlush = Date.now();

export async function flushUsage(): Promise<void> {
  lastFlush = Date.now();
  const batch = [...pending.entries()];
  pending.clear();
  for (const [host, u] of batch) {
    try {
      await withSiteRuntime((db) => db.query("select app.record_site_usage($1, $2, $3)", [host, u.requests, u.bytes]));
    } catch {
      // Measuring must never break serving. Put the counts back so the next flush retries them.
      const cur = pending.get(host) ?? { requests: 0, bytes: 0 };
      pending.set(host, { requests: cur.requests + u.requests, bytes: cur.bytes + u.bytes });
    }
  }
}

export function recordUsage(host: string, bytes: number): Promise<void> | void {
  const cur = pending.get(host) ?? { requests: 0, bytes: 0 };
  pending.set(host, { requests: cur.requests + 1, bytes: cur.bytes + Math.max(0, Math.round(bytes)) });
  if (Date.now() - lastFlush > 30_000 || pending.size > 50) return flushUsage();
}
