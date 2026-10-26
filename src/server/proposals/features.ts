import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { env } from "@/server/env";
import type { SessionUser } from "@/server/auth/service";

// Per-workspace switches for modules that are dormant until a Super Admin turns them on: a row in org_features (table 0001) with enabled = true. No row means off, and off is
// the default for every workspace. Modeled on the Unified Inbox rollout (src/server/messaging/inbox-rollout.ts): a short cache so a request does not read the table every
// time, cleared at once for a change made by this process and seen by another instance within a few seconds.
//
// The switch decides whether a workspace has the module at all. It is not a permission: who may do what inside the module is still src/lib/permissions.ts.
// Other modules may use featureOn for their own feature names; "proposals" and "esign" are this module's.

export const PROPOSALS_FEATURE = "proposals";
export const ESIGN_FEATURE = "esign";
export const PROPOSALS_NOT_ENABLED_MESSAGE = "Proposals aren't switched on for your workspace yet. Ask your iAcquire contact to switch them on.";

const TTL_MS = 3000;
const cache = new Map<string, { on: boolean; at: number }>();
const FEATURE_RE = /^[a-z_.]{2,64}$/;

/** Forgets what was read about a workspace (all of them without an id). */
export function clearFeatureCache(orgId?: string) {
  if (!orgId) return cache.clear();
  for (const key of cache.keys()) if (key.startsWith(`${orgId}:`)) cache.delete(key);
}

/** Whether a Super Admin switched this feature on for the workspace. Pass `db` from inside a transaction (no nested connection, no cache). */
export async function featureOn(orgId: string, feature: string, db?: Queryable): Promise<boolean> {
  const read = async (q: Queryable) => (await q.query<{ enabled: boolean }>("select enabled from org_features where org_id = $1 and feature = $2", [orgId, feature])).rows[0]?.enabled === true;
  if (db) return read(db);
  const key = `${orgId}:${feature}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.on;
  const on = await withSystem(read);
  cache.set(key, { on, at: Date.now() });
  return on;
}

/** Throws unless proposals are on for the workspace: a refusal, not an outage. */
export async function assertProposalsEnabled(orgId: string, db?: Queryable): Promise<void> {
  if (!(await featureOn(orgId, PROPOSALS_FEATURE, db))) throw new AppError("not_enabled", PROPOSALS_NOT_ENABLED_MESSAGE);
}

/** The platform-wide emergency switch for everything a customer can reach (PROPOSALS_PUBLIC_DISABLED). It is checked first, before any database read. */
export const proposalsPublicDisabled = (): boolean => env().PROPOSALS_PUBLIC_DISABLED;

/** Switches a feature on or off for one workspace. Super Admin only; audited. Returns false when the workspace was already in that state (nothing is written). */
export async function setOrgFeature(user: SessionUser, input: { orgId: string; feature: string; enabled: boolean }): Promise<{ changed: boolean }> {
  if (user.platformRole !== "agency_super_admin") throw new AppError("forbidden", "Only a Super Admin can switch a workspace feature on or off.");
  if (!FEATURE_RE.test(input.feature)) throw new AppError("invalid_input", "That is not a feature name.");
  const out = await withSystem(async (db) => {
    const org = await db.query("select 1 from organizations where id = $1", [input.orgId]);
    if (!org.rows[0]) throw new AppError("not_found", "Workspace not found.");
    const before = (await db.query<{ enabled: boolean }>("select enabled from org_features where org_id = $1 and feature = $2 for update", [input.orgId, input.feature])).rows[0]?.enabled === true;
    if (before === input.enabled) return { changed: false };
    await db.query(
      `insert into org_features (org_id, feature, enabled, updated_by) values ($1, $2, $3, $4)
       on conflict (org_id, feature) do update set enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = now()`,
      [input.orgId, input.feature, input.enabled, user.id],
    );
    await recordAudit({ orgId: input.orgId, actorUserId: user.id, actorKind: "agency", action: input.enabled ? "feature.enabled" : "feature.disabled", targetType: "workspace", targetId: input.orgId, result: "success", metadata: { feature: input.feature } }, db);
    return { changed: true };
  });
  clearFeatureCache(input.orgId);
  return out;
}
