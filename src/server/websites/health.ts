import "server-only";
import { withSystem } from "@/server/db";
import { platformHost, primaryHost } from "@/server/websites/service";
import { probeSite, type ProbeFetcher } from "@/server/websites/probe";

/**
 * Re-checks that live publications are actually being served, the way a visitor would reach them. A site that stops answering is
 * recorded as unhealthy (which opens an incident); one that answers again is recorded healthy (which closes it).
 * Where no probe origin is reachable (local development) the result stays "unchecked" and nothing is claimed.
 */
export async function checkLivePublications(opts: { limit?: number; staleMinutes?: number; probe?: ProbeFetcher; now?: Date } = {}): Promise<{ checked: number; healthy: number; unhealthy: number; unchecked: number }> {
  const now = opts.now ?? new Date();
  const { rows } = await withSystem((db) =>
    db.query<{ id: string; org_id: string; website_id: string; subdomain: string }>(
      `select p.id, p.org_id, p.website_id, w.subdomain from website_publications p join websites w on w.id = p.website_id
       where p.status = 'live' and (p.health_checked_at is null or p.health_checked_at < $1::timestamptz - make_interval(mins => $2))
       order by p.health_checked_at nulls first limit $3`,
      [now.toISOString(), opts.staleMinutes ?? 15, Math.min(50, opts.limit ?? 25)],
    ),
  );
  const out = { checked: 0, healthy: 0, unhealthy: 0, unchecked: 0 };
  for (const p of rows) {
    const host = await primaryHost(p.org_id, p.website_id, platformHost(p.subdomain));
    const result = await probeSite(host, p.id, opts.probe);
    out.checked += 1;
    out[result.state] += 1;
    if (result.state === "unchecked") continue;
    await withSystem((db) => db.query("update website_publications set health = $2, health_detail = $3, health_checked_at = $4 where id = $1 and status = 'live'", [p.id, result.state, result.detail.slice(0, 300), now.toISOString()]));
  }
  return out;
}
