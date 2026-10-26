import "server-only";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyOrgRoles } from "@/server/notifications";
import { decryptSecret, encryptSecret, randomToken, sha256 } from "@/server/security/crypto";
import type { OrgContext } from "@/server/tenancy/context";
import type { Platform } from "@/lib/social/rules";
import { PLATFORMS } from "@/lib/social/rules";
import { isRetryable } from "@/lib/social/errors";
import { openCredentials, sealCredentials } from "@/server/social/credentials";
import { socialOrgRunnableSql } from "@/server/social/org-gate";
import { assertSocialWorkspace } from "@/server/social/workspace";
import { SOCIAL_CLIENT_ONLY_MESSAGE } from "@/lib/social/workspace";
import { providerFor, simulatedAllowed, type Adapter } from "@/server/social/providers";
import { authorizeUrl, canPostTo, metaConfigured, resolveSignIn, type ConnectedPage } from "@/server/social/providers/meta-oauth";
import { metaRepliesReady, metaReviewsReady } from "@/server/reputation/providers/meta-reviews";
import { ProviderError, type AccountCapabilities, type HealthResult, type SocialProvider } from "@/server/social/providers/types";

// Connecting, checking and disconnecting social accounts. An account is a Facebook Page or an Instagram professional account that belongs to the CLIENT: only
// the client's owner and manager connect or disconnect it. Its token is stored sealed and is never returned to a browser. The status is a fact read from the
// provider (connected, needs_reauth, error) or a decision a person made (disconnected) or the provider made (revoked): never a guess.

export type AccountStatus = "connected" | "needs_reauth" | "error" | "revoked" | "disconnected";

export interface AccountView {
  id: string;
  platform: Platform;
  adapter: Adapter;
  externalId: string;
  name: string;
  username: string | null;
  avatarUrl: string | null;
  status: AccountStatus;
  statusDetail: string | null;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  connectedAt: string;
  capabilities: AccountCapabilities;
  scopes: string[];
  tokenExpiresAt: string | null;
  dataAccessExpiresAt: string | null;
  quota: { usage: number; total: number } | null;
  /** True once the platform has said the account may be posted to. */
  canPublish: boolean;
}

interface Row {
  id: string; platform: Platform; adapter: Adapter; external_id: string; name: string; username: string | null; avatar_url: string | null; status: AccountStatus;
  status_detail: string | null; last_checked_at: Date | null; last_success_at: Date | null; connected_at: Date; capabilities: Partial<AccountCapabilities>; scopes: string[];
  token_expires_at: Date | null; data_access_expires_at: Date | null; rate_state: { quotaUsage?: number; quotaTotal?: number } | null;
}
const VIEW_COLUMNS = "id, platform, adapter, external_id, name, username, avatar_url, status, status_detail, last_checked_at, last_success_at, connected_at, capabilities, scopes, token_expires_at, data_access_expires_at, rate_state";
const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

const toView = (r: Row): AccountView => ({
  id: r.id, platform: r.platform, adapter: r.adapter, externalId: r.external_id, name: r.name, username: r.username, avatarUrl: r.avatar_url, status: r.status, statusDetail: r.status_detail,
  lastCheckedAt: iso(r.last_checked_at), lastSuccessAt: iso(r.last_success_at), connectedAt: new Date(r.connected_at).toISOString(),
  capabilities: { contentTypes: r.capabilities?.contentTypes ?? [], insights: r.capabilities?.insights ?? false },
  scopes: r.scopes ?? [], tokenExpiresAt: iso(r.token_expires_at), dataAccessExpiresAt: iso(r.data_access_expires_at),
  quota: typeof r.rate_state?.quotaUsage === "number" && typeof r.rate_state?.quotaTotal === "number" ? { usage: r.rate_state.quotaUsage, total: r.rate_state.quotaTotal } : null,
  canPublish: r.status === "connected" && (r.capabilities?.contentTypes?.length ?? 0) > 0,
});

function assertConnect(ctx: OrgContext) {
  assertSocialWorkspace(ctx);
  if (!ctx.can("social.connect")) throw new AppError("forbidden", "Only the business owner or a manager can connect social accounts.");
}

/** Connected and previously connected accounts, newest first. The token is never part of what is returned. */
export async function listAccounts(ctx: OrgContext, opts: { includeDisconnected?: boolean } = {}): Promise<AccountView[]> {
  assertSocialWorkspace(ctx);
  if (!ctx.can("social.view")) throw new AppError("forbidden", "Your role can't see social media.");
  return withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<Row>(
      `select ${VIEW_COLUMNS} from social_accounts where org_id = $1 ${opts.includeDisconnected ? "" : "and status <> 'disconnected'"} order by connected_at desc`,
      [ctx.org.orgId],
    );
    return rows.map(toView);
  });
}

// ---------------------------------------------------------------------------
// Signing in with Meta
// ---------------------------------------------------------------------------

export const STATE_MINUTES = 10;
export const DEFAULT_RETURN = "/social/accounts";
export const safeReturn = (raw: string | null | undefined) => (raw && /^\/social(\/[A-Za-z0-9/_-]*)?$/.test(raw) ? raw : DEFAULT_RETURN);

/**
 * Records a single-use sign-in state for this person and returns the address to send the browser to. `reviews` is the "reconnect with review access" step of CRM → Reviews: it
 * also asks Meta for the permissions to read the Page's recommendations (and to reply to them when that is switched on), and is refused unless reading them is switched on at all.
 */
export async function startMetaConnect(ctx: OrgContext, platform: Platform, returnPath?: string | null, opts: { reviews?: boolean } = {}): Promise<{ url: string }> {
  assertConnect(ctx);
  if (!PLATFORMS.includes(platform)) throw new AppError("invalid_input", "Choose Facebook or Instagram.");
  if (opts.reviews && platform !== "facebook") throw new AppError("invalid_input", "Review access is for Facebook Pages.");
  if (opts.reviews && !metaReviewsReady()) throw new AppError("unavailable", "Reading Facebook recommendations isn't switched on for iAcquire yet, so review access can't be asked for.");
  if (!metaConfigured()) {
    throw new AppError("unavailable", "Connecting Facebook and Instagram is not set up for this deployment yet. iAcquire needs to register its Meta app first, so nothing can be connected today.");
  }
  const state = randomToken(32);
  await withSystem(async (db) => {
    await db.query("delete from social_oauth_states where user_id = $1 and (used_at is not null or expires_at < now())", [ctx.user.id]);
    await db.query(
      "insert into social_oauth_states (org_id, user_id, platform, state_hash, return_path, expires_at) values ($1, $2, $3, $4, $5, now() + make_interval(mins => $6))",
      [ctx.org.orgId, ctx.user.id, platform, sha256(state), safeReturn(returnPath), STATE_MINUTES],
    );
  });
  return { url: authorizeUrl(state, platform, undefined, { reviews: opts.reviews, replies: metaRepliesReady() }) };
}

export interface PageChoice {
  pageId: string;
  name: string;
  /** The person's role on the Page lets them publish to it. */
  canPost: boolean;
  instagram: { id: string; username: string | null } | null;
}

/**
 * Meta sent the person back with a code. Valid only for the person who started it, within ten minutes, once. The code is exchanged, the Pages the person
 * manages are read, and they are stored SEALED for the choice screen: nothing is connected until the person picks. Returns where to go next.
 */
export async function completeMetaConnect(
  user: { id: string },
  input: { state?: string | null; code?: string | null; error?: string | null },
  deps: { resolve?: typeof resolveSignIn } = {},
): Promise<{ outcome: "choose" | "denied"; stateId: string | null; returnPath: string }> {
  if (!input.state) throw new AppError("invalid_input", "That sign-in did not start from iAcquire, so it was ignored.");
  const row = await withSystem(async (db) => {
    const { rows } = await db.query<{ id: string; org_id: string; user_id: string; return_path: string; expires_at: Date; used_at: Date | null; platform: Platform }>(
      "select id, org_id, user_id, return_path, expires_at, used_at, platform from social_oauth_states where state_hash = $1", [sha256(input.state as string)],
    );
    return rows[0] ?? null;
  });
  if (!row || row.user_id !== user.id || row.used_at || new Date(row.expires_at).getTime() < Date.now()) {
    throw new AppError("invalid_input", "That sign-in expired or was not started by you. Start the connection again.");
  }
  // The workspace may have stopped being a client's since the sign-in started; nothing is connected to an agency workspace.
  const kind = (await withSystem((db) => db.query<{ kind: "agency" | "client" }>("select kind from organizations where id = $1", [row.org_id]))).rows[0]?.kind;
  if (kind !== "client") {
    await withSystem((db) => db.query("update social_oauth_states set used_at = now() where id = $1", [row.id]));
    throw new AppError("forbidden", SOCIAL_CLIENT_ONLY_MESSAGE);
  }
  const allowed = await withUser(user.id, async (db) => (await db.query<{ ok: boolean }>("select app.has_permission($1, 'social.connect') as ok", [row.org_id])).rows[0]?.ok);
  if (!allowed) throw new AppError("forbidden", "Only the business owner or a manager can connect social accounts.");
  if (input.error || !input.code) {
    await withSystem((db) => db.query("update social_oauth_states set used_at = now() where id = $1", [row.id]));
    return { outcome: "denied", stateId: null, returnPath: row.return_path };
  }
  let identity;
  try {
    identity = await (deps.resolve ?? resolveSignIn)(input.code);
  } catch (e) {
    await withSystem((db) => db.query("update social_oauth_states set used_at = now() where id = $1", [row.id]));
    throw new AppError("upstream_error", e instanceof ProviderError ? e.message : "Meta could not complete the sign-in. Start again.");
  }
  const sealed = encryptSecret(JSON.stringify({ userId: identity.userId, userName: identity.userName, pages: identity.pages }));
  await withSystem((db) => db.query("update social_oauth_states set pending = $2 where id = $1 and used_at is null", [row.id, sealed]));
  return { outcome: "choose", stateId: row.id, returnPath: row.return_path };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function openPending(db: Queryable, ctx: OrgContext, stateId: string): Promise<{ platform: Platform; userId: string; pages: ConnectedPage[] }> {
  // A mangled link (?choose=abc) is a connection that is gone, not a database error.
  if (!UUID.test(stateId)) throw new AppError("not_found", "That connection expired. Start it again.");
  const { rows } = await db.query<{ org_id: string; user_id: string; platform: Platform; pending: string | null; expires_at: Date; used_at: Date | null }>(
    "select org_id, user_id, platform, pending, expires_at, used_at from social_oauth_states where id = $1", [stateId],
  );
  const r = rows[0];
  if (!r || r.org_id !== ctx.org.orgId || r.user_id !== ctx.user.id || r.used_at || !r.pending || new Date(r.expires_at).getTime() < Date.now()) {
    throw new AppError("not_found", "That connection expired. Start it again.");
  }
  const j = JSON.parse(decryptSecret(r.pending)) as { userId: string; pages: ConnectedPage[] };
  return { platform: r.platform, userId: j.userId, pages: j.pages };
}

/** The Pages the person may choose from, without their tokens. */
export async function pendingChoices(ctx: OrgContext, stateId: string): Promise<{ platform: Platform; choices: PageChoice[] }> {
  assertConnect(ctx);
  const p = await withSystem((db) => openPending(db, ctx, stateId));
  return { platform: p.platform, choices: p.pages.map((g) => ({ pageId: g.id, name: g.name, canPost: canPostTo(g), instagram: g.instagram ? { id: g.instagram.id, username: g.instagram.username } : null })) };
}

/**
 * Connects the Pages the person chose (and, where they ticked it and one is linked, the Page's Instagram account). Each account is tested with the
 * provider first and saved only if it can actually be posted to: a connection that cannot publish is not shown as connected.
 */
export async function connectChosenPages(
  ctx: OrgContext,
  stateId: string,
  picks: Array<{ pageId: string; includeInstagram?: boolean }>,
  deps: { provider?: SocialProvider } = {},
): Promise<{ connected: AccountView[]; skipped: Array<{ name: string; reason: string }> }> {
  assertConnect(ctx);
  if (!picks.length) throw new AppError("invalid_input", "Choose at least one Page.");
  const pending = await withSystem((db) => openPending(db, ctx, stateId));
  let result: { connected: string[]; skipped: Array<{ name: string; reason: string }> };
  try {
    result = await connectPicks(ctx, pending, picks, deps.provider ?? providerFor("meta"));
  } finally {
    // The sealed Pages and their tokens have done their job, or the attempt failed part-way: either way they are not kept. If this cannot be written, the
    // expiry sweep (purgeSignInStates) clears them within minutes of the ten that the sign-in lasts.
    await withSystem((db) => db.query("update social_oauth_states set used_at = coalesce(used_at, now()), pending = null where id = $1", [stateId])).catch(() => undefined);
  }
  const views = await listAccounts(ctx);
  return { connected: views.filter((v) => result.connected.includes(v.id)), skipped: result.skipped };
}

async function connectPicks(
  ctx: OrgContext,
  pending: { platform: Platform; userId: string; pages: ConnectedPage[] },
  picks: Array<{ pageId: string; includeInstagram?: boolean }>,
  provider: SocialProvider,
): Promise<{ connected: string[]; skipped: Array<{ name: string; reason: string }> }> {
  const connected: string[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  for (const pick of picks) {
    const page = pending.pages.find((g) => g.id === pick.pageId);
    if (!page) {
      skipped.push({ name: pick.pageId, reason: "That Page was not in your list." });
      continue;
    }
    if (!canPostTo(page)) {
      skipped.push({ name: page.name, reason: "Your role on this Page does not let you publish to it. Ask a Page admin to give you the right to create content." });
      continue;
    }
    const targets: Array<{ platform: Platform; externalId: string; name: string; username: string | null }> = [{ platform: "facebook", externalId: page.id, name: page.name, username: null }];
    if (pick.includeInstagram && page.instagram) targets.push({ platform: "instagram", externalId: page.instagram.id, name: page.instagram.name ?? page.instagram.username ?? page.name, username: page.instagram.username });
    for (const t of targets) {
      let health: HealthResult;
      try {
        health = await provider.health({ accessToken: page.token }, { platform: t.platform, externalId: t.externalId });
      } catch (e) {
        skipped.push({ name: t.name, reason: e instanceof ProviderError ? e.message : "The platform could not be reached to test this account." });
        continue;
      }
      if (health.status !== "connected" || health.capabilities.contentTypes.length === 0) {
        skipped.push({ name: t.name, reason: health.detail });
        continue;
      }
      const id = await withSystem(async (db) => {
        // A reconnection updates the account that is already there instead of making a second one.
        const existing = await db.query<{ id: string }>("select id from social_accounts where org_id = $1 and platform = $2 and external_id = $3 and status <> 'disconnected'", [ctx.org.orgId, t.platform, t.externalId]);
        const sealed = sealCredentials({ accessToken: page.token });
        const rate = health.quota ? JSON.stringify({ quotaUsage: health.quota.usage, quotaTotal: health.quota.total, checkedAt: new Date().toISOString() }) : "{}";
        let accountId: string;
        if (existing.rows[0]) {
          accountId = existing.rows[0].id;
          await db.query(
            `update social_accounts set name = $2, username = $3, credentials = $4, token_expires_at = $5, data_access_expires_at = $6, scopes = $7, provider_user_id = $8, status = 'connected', status_detail = null,
               last_checked_at = now(), last_success_at = now(), connected_by = $9, capabilities = $10::jsonb, rate_state = $11::jsonb where id = $1`,
            [accountId, t.name, t.username, sealed, health.expiresAt, health.dataAccessExpiresAt, health.scopes, pending.userId, ctx.user.id, JSON.stringify(health.capabilities), rate],
          );
        } else {
          const ins = await db.query<{ id: string }>(
            `insert into social_accounts (org_id, platform, adapter, external_id, name, username, credentials, token_expires_at, data_access_expires_at, scopes, provider_user_id, status, last_checked_at, last_success_at, connected_by, capabilities, rate_state)
             values ($1, $2, 'meta', $3, $4, $5, $6, $7, $8, $9, $10, 'connected', now(), now(), $11, $12::jsonb, $13::jsonb) returning id`,
            [ctx.org.orgId, t.platform, t.externalId, t.name, t.username, sealed, health.expiresAt, health.dataAccessExpiresAt, health.scopes, pending.userId, ctx.user.id, JSON.stringify(health.capabilities), rate],
          );
          accountId = ins.rows[0].id;
          await followReconnectedPage(db, ctx, accountId, t.platform, t.externalId);
        }
        await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "social.account_connected", targetType: "social_account", targetId: accountId, result: "success", metadata: { platform: t.platform } }, db);
        return accountId;
      });
      connected.push(id);
    }
  }
  return { connected, skipped };
}

/**
 * A Page a person disconnected and then connected again comes back as a new account row (the old one is history). The posts that were waiting on the old row
 * follow the Page, so the owner can schedule them again instead of finding them stuck on an account that no longer exists. Only posts that never went out
 * move: published posts and their history stay with the old row, a post that may be live (outcome unknown) stays where it is, and nothing leaves this workspace.
 */
async function followReconnectedPage(db: Queryable, ctx: OrgContext, accountId: string, platform: Platform, externalId: string): Promise<void> {
  const { rows } = await db.query<{ id: string; from_account: string }>(
    `update social_posts p set account_id = $1
       from social_accounts old
      where p.org_id = $2 and old.org_id = $2 and p.account_id = old.id and old.id <> $1 and old.platform = $3 and old.external_id = $4 and old.status = 'disconnected'
        and (p.status in ('draft', 'pending_approval', 'changes_requested', 'approved') or (p.status = 'failed' and p.failure_code = 'account_unavailable'))
      returning p.id, old.id as from_account`,
    [accountId, ctx.org.orgId, platform, externalId],
  );
  for (const r of rows) {
    await db.query(
      "insert into social_post_events (org_id, post_id, kind, actor_id, actor_kind, detail) values ($1, $2, 'account_reconnected', $3, 'user', $4::jsonb)",
      [ctx.org.orgId, r.id, ctx.user.id, JSON.stringify({ from: r.from_account, to: accountId })],
    );
  }
}

/** A local stand-in account for tests and QA. Posts nothing anywhere, refused in production. */
export async function connectSimulatedAccount(ctx: OrgContext, input: { platform: Platform; name: string; externalId?: string }): Promise<AccountView> {
  assertConnect(ctx);
  if (!simulatedAllowed()) throw new AppError("forbidden", "Simulated accounts are not available in production.");
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new AppError("invalid_input", "Give the account a name.");
  const externalId = input.externalId ?? `sim-${randomToken(6)}`;
  const health = await providerFor("simulated").health({ accessToken: "sim_valid" }, { platform: input.platform, externalId });
  const id = await withSystem(async (db) => {
    const { rows } = await db.query<{ id: string }>(
      `insert into social_accounts (org_id, platform, adapter, external_id, name, username, credentials, scopes, status, last_checked_at, last_success_at, connected_by, capabilities)
       values ($1, $2, 'simulated', $3, $4, $5, $6, $7, 'connected', now(), now(), $8, $9::jsonb) returning id`,
      [ctx.org.orgId, input.platform, externalId, name, input.platform === "instagram" ? name.toLowerCase().replace(/[^a-z0-9]+/g, "") : null, sealCredentials({ accessToken: "sim_valid" }), health.scopes, ctx.user.id, JSON.stringify(health.capabilities)],
    );
    await followReconnectedPage(db, ctx, rows[0].id, input.platform, externalId);
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "social.account_connected", targetType: "social_account", targetId: rows[0].id, result: "success", metadata: { platform: input.platform, adapter: "simulated" } }, db);
    return rows[0].id;
  });
  const v = (await listAccounts(ctx)).find((a) => a.id === id);
  if (!v) throw new AppError("internal", "The account was saved but could not be read back.");
  return v;
}

// ---------------------------------------------------------------------------
// Health, disconnection and revocation
// ---------------------------------------------------------------------------

const REASON_FAILED = "The account was disconnected, so this was not published. Reconnect it and schedule it again.";
const REASON_UNKNOWN = "The account was disconnected while this was being sent, so it is not known whether it went out. Check the Page before posting again.";

/**
 * Stops everything the account was about to publish. A job that had not started sending is cancelled and its post fails with a clear reason; a job that may
 * already have sent is NOT cancelled quietly: its post is marked failed with "not known whether it went out", never treated as "not posted". A job that already
 * holds the platform's answer is left alone: that post is live. Returns how many posts were affected.
 */
export async function stopPublishingFor(db: Queryable, orgId: string, accountId: string): Promise<number> {
  const { rows } = await db.query<{ id: string; post_id: string; state: Record<string, unknown> }>(
    "select id, post_id, state from social_publish_jobs where org_id = $1 and account_id = $2 and status in ('queued', 'running', 'unknown')", [orgId, accountId],
  );
  let stopped = 0;
  for (const j of rows) {
    // The platform already answered and the answer is saved: the post is live. The publisher records it as published (publisher.ts finishes any job holding an
    // answer), so failing or cancelling it here would show a live post as not published.
    if (j.state?.done && j.state?.providerPostId) continue;
    stopped += 1;
    const maybeSent = Boolean(j.state?.sendingAt) && !j.state?.providerPostId;
    await db.query(
      "update social_publish_jobs set status = $2, last_error = $3, last_error_kind = $4, lease_until = null, finished_at = now() where id = $1",
      [j.id, maybeSent ? "failed" : "cancelled", maybeSent ? REASON_UNKNOWN : REASON_FAILED, maybeSent ? "unknown_outcome" : "auth"],
    );
    await db.query(
      "update social_posts set status = 'failed', failure_code = $2, failure_message = $3 where id = $1 and org_id = $4 and status in ('scheduled', 'publishing', 'needs_reconciliation')",
      [j.post_id, maybeSent ? "unknown_outcome" : "account_unavailable", maybeSent ? REASON_UNKNOWN : REASON_FAILED, orgId],
    );
    await db.query("insert into social_post_events (org_id, post_id, kind, actor_kind, detail) values ($1, $2, 'publishing_stopped', 'system', $3::jsonb)", [orgId, j.post_id, JSON.stringify({ reason: maybeSent ? "account_lost_while_sending" : "account_unavailable" })]);
  }
  // A scheduled post with no job (it should not exist) must not sit waiting for an account that cannot publish.
  await db.query(
    "update social_posts set status = 'failed', failure_code = 'account_unavailable', failure_message = $3 where org_id = $1 and account_id = $2 and status = 'scheduled'",
    [orgId, accountId, REASON_FAILED],
  );
  return stopped;
}

/** What disconnecting does to an account, whoever asks: its token and the platform's id for the person who connected it are deleted, and publishing for it stops. */
async function disconnectRow(db: Queryable, orgId: string, accountId: string, detail: string): Promise<number> {
  await db.query("update social_accounts set status = 'disconnected', credentials = null, token_expires_at = null, provider_user_id = null, status_detail = $2, disconnected_at = now() where id = $1", [accountId, detail]);
  return stopPublishingFor(db, orgId, accountId);
}

/** Disconnects an account: the token is deleted, publishing for it stops. The business's published posts stay where they are on the platform. */
export async function disconnectAccount(ctx: OrgContext, accountId: string): Promise<{ stopped: number }> {
  assertConnect(ctx);
  return withSystem(async (db) => {
    const { rows } = await db.query<{ id: string; name: string; platform: Platform }>("select id, name, platform from social_accounts where id = $1 and org_id = $2 and status <> 'disconnected' for update", [accountId, ctx.org.orgId]);
    if (!rows[0]) throw new AppError("not_found", "That account was not found.");
    const stopped = await disconnectRow(db, ctx.org.orgId, accountId, "Disconnected by a person.");
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "social.account_disconnected", targetType: "social_account", targetId: accountId, result: "success", metadata: { platform: rows[0].platform, stopped } }, db);
    return { stopped };
  });
}

/**
 * Disconnects every account a workspace still uses, for a workspace that is being closed (offboarding): no signed-in member is involved, and each account ends
 * exactly as if its owner had disconnected it. One account failing does not stop the others; the failures are returned by name so they are reported, not hidden.
 */
export async function disconnectWorkspaceAccounts(orgId: string, actorUserId: string): Promise<{ disconnected: number; stopped: number; failed: string[] }> {
  const accounts = (await withSystem((db) => db.query<{ id: string; name: string; platform: Platform }>(
    "select id, name, platform from social_accounts where org_id = $1 and status in ('connected', 'needs_reauth', 'error') order by connected_at", [orgId],
  ))).rows;
  let disconnected = 0;
  let stopped = 0;
  const failed: string[] = [];
  for (const a of accounts) {
    try {
      stopped += await withSystem(async (db) => {
        const live = await db.query("select 1 from social_accounts where id = $1 and org_id = $2 and status in ('connected', 'needs_reauth', 'error') for update", [a.id, orgId]);
        if (!live.rows[0]) return 0; // a person or the platform got there first
        const n = await disconnectRow(db, orgId, a.id, "The workspace was closed.");
        await recordAudit({ orgId, actorUserId, actorKind: "agency", action: "social.account_disconnected", targetType: "social_account", targetId: a.id, result: "success", metadata: { platform: a.platform, stopped: n, why: "workspace_closed" } }, db);
        return n;
      });
      disconnected += 1;
    } catch {
      failed.push(a.name);
    }
  }
  return { disconnected, stopped, failed };
}

/**
 * Forgets the sign-ins a person left half-finished. The sealed list of Pages (with their tokens) of a sign-in that was never completed is cleared for the
 * given platform user. The list is encrypted, so it is opened here to see whose it is. Returns how many were cleared.
 */
async function clearPendingSignIns(db: Queryable, providerUserId: string): Promise<number> {
  let cleared = 0;
  let after = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const { rows } = await db.query<{ id: string; pending: string }>("select id, pending from social_oauth_states where pending is not null and id > $1::uuid order by id limit 200 for update", [after]);
    if (!rows.length) return cleared;
    for (const r of rows) {
      after = r.id;
      let who: string | null = null;
      try {
        who = (JSON.parse(decryptSecret(r.pending)) as { userId?: string }).userId ?? null;
      } catch {
        who = null; // not readable (a key changed): the expiry sweep clears it
      }
      if (who !== providerUserId) continue;
      await db.query("update social_oauth_states set pending = null, used_at = coalesce(used_at, now()) where id = $1", [r.id]);
      cleared += 1;
    }
  }
}

/**
 * The platform told us a person removed the app (deauthorization) or asked for their data to be deleted: every account they authorized stops working here at
 * once, its token is deleted, and what it was about to publish is stopped. The sign-ins they left unfinished are cleared, and the platform's id for them is
 * removed from every account row that carried it, disconnected and revoked ones included. Returns the accounts affected.
 */
export async function revokeByProviderUser(providerUserId: string, why: "deauthorized" | "data_deletion"): Promise<number> {
  return withSystem(async (db) => {
    const { rows } = await db.query<{ id: string; org_id: string; name: string }>(
      "select id, org_id, name from social_accounts where provider_user_id = $1 and status in ('connected', 'needs_reauth', 'error') for update", [providerUserId],
    );
    const at = new Date().toISOString();
    for (const a of rows) {
      await db.query("update social_accounts set status = 'revoked', credentials = null, token_expires_at = null, status_detail = $2, disconnected_at = now() where id = $1", [a.id, why === "deauthorized" ? "The person who connected this account removed the iAcquire app on the platform." : "Data deletion was requested on the platform."]);
      const stopped = await stopPublishingFor(db, a.org_id, a.id);
      await recordAudit({ orgId: a.org_id, actorKind: "system", action: "social.account_revoked", targetType: "social_account", targetId: a.id, result: "success", metadata: { why, stopped } }, db);
      // Keyed by the moment: an account that is connected again and revoked again is announced again.
      await notifyOrgRoles(db, a.org_id, ["owner", "admin"], { kind: "social_account_attention", severity: "warning", title: `${a.name} was disconnected`, body: "The platform reported that the app was removed from this account. Nothing more will be published to it until you reconnect.", link: "/social/accounts", dedupeKey: `social-revoked:${a.id}:${at}` });
    }
    await clearPendingSignIns(db, providerUserId);
    await db.query("update social_accounts set provider_user_id = null where provider_user_id = $1", [providerUserId]);
    return rows.length;
  });
}

/**
 * The sign-in states that outlived their ten minutes: the sealed Pages and tokens of one that was never finished are cleared the moment it expires, and the
 * state itself is deleted a day later. Returns how many sealed lists were cleared and how many states deleted.
 */
export async function purgeSignInStates(now: Date = new Date()): Promise<{ cleared: number; deleted: number }> {
  return withSystem(async (db) => {
    const cleared = await db.query("update social_oauth_states set pending = null where pending is not null and expires_at < $1 returning id", [now]);
    const deleted = await db.query("delete from social_oauth_states where expires_at < $1::timestamptz - interval '1 day' returning id", [now]);
    return { cleared: cleared.rows.length, deleted: deleted.rows.length };
  });
}

/** Days before a sign-in (or the platform's access to the account's data) runs out that the owner and managers are first told. */
export const EXPIRY_WARNING_DAYS = 7;

/** The platform said when the sign-in or the access to the account's data ends, and it is close: tell the owner and managers once per account and date. */
async function warnExpiring(db: Queryable, acc: { id: string; org_id: string; name: string }, ends: { signIn: Date | null; data: Date | null }, now: Date): Promise<void> {
  const byDay = new Map<string, string[]>();
  const add = (d: Date | null, what: string) => {
    if (d === null) return;
    const at = new Date(d).getTime();
    if (at <= now.getTime() || at > now.getTime() + EXPIRY_WARNING_DAYS * 86_400_000) return;
    const day = new Date(at).toISOString().slice(0, 10);
    byDay.set(day, [...(byDay.get(day) ?? []), what]);
  };
  add(ends.signIn, "its sign-in runs out");
  add(ends.data, "the platform's access to its data runs out");
  for (const [day, what] of byDay) {
    await notifyOrgRoles(db, acc.org_id, ["owner", "admin"], {
      kind: "social_account_attention", severity: "warning", title: `${acc.name} needs to be reconnected before ${day}`,
      body: `On ${day} ${what.join(" and ")}. Reconnect the account before then so scheduled posts keep going out; after that nothing more can be published to it until you do.`,
      link: "/social/accounts", dedupeKey: `social-expiry:${acc.id}:${day}`,
    });
  }
}

interface HealthOutcome {
  status: AccountStatus;
  /** checked: the platform answered. unreachable: it could not be asked (a timeout, a server error, a limit), so the status is the one from before. changed: another change to the account (a disconnect, a revoke, a reconnect) landed first, and this result was dropped. */
  outcome: "checked" | "unreachable" | "changed";
}

/** A refusal the platform means (as opposed to not being able to ask): only these change what an account is shown as. */
const unanswered = (e: unknown) => !(e instanceof ProviderError) || isRetryable(e.kind) || e.kind === "unknown_outcome";

async function runHealthCheck(accountId: string, now: Date): Promise<HealthOutcome | null> {
  const acc = await withSystem(async (db) => (await db.query<{ id: string; org_id: string; platform: Platform; adapter: Adapter; external_id: string; name: string; credentials: string | null; status: AccountStatus; status_detail: string | null }>(
    "select id, org_id, platform, adapter, external_id, name, credentials, status, status_detail from social_accounts where id = $1 and status in ('connected', 'needs_reauth', 'error')", [accountId],
  )).rows[0]);
  if (!acc) return null;
  const creds = openCredentials(acc.credentials);
  let next: { status: AccountStatus; detail: string | null; health: HealthResult | null; answered: boolean };
  if (!creds) next = { status: "needs_reauth", detail: "The saved sign-in can no longer be used. Reconnect the account.", health: null, answered: true };
  else {
    try {
      const h = await providerFor(acc.adapter).health(creds, { platform: acc.platform, externalId: acc.external_id });
      next = { status: h.status, detail: h.status === "connected" ? null : h.detail, health: h, answered: true };
    } catch (e) {
      const message = e instanceof ProviderError ? e.message : "The platform could not be reached.";
      if (e instanceof ProviderError && e.needsReauth) next = { status: "needs_reauth", detail: message, health: null, answered: true };
      // A timeout, a server error or a limit says nothing about the account: it keeps the status it had, with a note of why it was not re-checked. An account
      // that needs reconnecting keeps the reason it already had.
      else if (unanswered(e)) next = { status: acc.status, detail: acc.status === "needs_reauth" ? acc.status_detail : message, health: null, answered: false };
      else next = { status: "error", detail: message, health: null, answered: true };
    }
  }
  const h = next.health;
  const written = await withSystem(async (db) => {
    // Guarded by the status read above: a disconnect, a revoke or a reconnect that landed while the platform was being asked wins, and this result is dropped.
    const res = await db.query<{ token_expires_at: Date | null; data_access_expires_at: Date | null }>(
      `update social_accounts set status = $2, status_detail = $3, last_checked_at = $4,
         last_success_at = case when $2 = 'connected' and $10::boolean then $4 else last_success_at end,
         scopes = coalesce($5, scopes), token_expires_at = coalesce($6, token_expires_at), data_access_expires_at = coalesce($7, data_access_expires_at),
         capabilities = coalesce($8::jsonb, capabilities),
         rate_state = case when $9::jsonb is null then rate_state else (rate_state - 'quotaUsage' - 'quotaTotal' - 'checkedAt') || $9::jsonb end
       where id = $1 and status = $11
       returning token_expires_at, data_access_expires_at`,
      [acc.id, next.status, next.detail, now, h?.scopes ?? null, h?.expiresAt ?? null, h?.dataAccessExpiresAt ?? null, h ? JSON.stringify(h.capabilities) : null,
        h?.quota ? JSON.stringify({ quotaUsage: h.quota.usage, quotaTotal: h.quota.total, checkedAt: now.toISOString() }) : null, next.answered, acc.status],
    );
    const row = res.rows[0];
    if (!row) return false;
    if (next.status === "needs_reauth" && acc.status !== "needs_reauth") {
      const stopped = await stopPublishingFor(db, acc.org_id, acc.id);
      await notifyOrgRoles(db, acc.org_id, ["owner", "admin"], { kind: "social_account_attention", severity: "warning", title: `${acc.name} needs to be reconnected`, body: `${next.detail ?? "Its sign-in no longer works."}${stopped ? ` ${stopped} post${stopped === 1 ? "" : "s"} waiting to publish ${stopped === 1 ? "was" : "were"} stopped.` : ""}`, link: "/social/accounts", dedupeKey: `social-reauth:${acc.id}:${now.toISOString().slice(0, 10)}` });
    }
    if (next.status === "connected") await warnExpiring(db, acc, { signIn: row.token_expires_at, data: row.data_access_expires_at }, now);
    return true;
  });
  if (!written) {
    const current = (await withSystem((db) => db.query<{ status: AccountStatus }>("select status from social_accounts where id = $1", [acc.id]))).rows[0]?.status ?? next.status;
    return { status: current, outcome: "changed" };
  }
  return { status: next.status, outcome: next.answered ? "checked" : "unreachable" };
}

/**
 * Checks one account with its provider and records what it said. A change for the worse is announced to the owner and managers once. When the platform cannot
 * be asked (a timeout, a server error, a limit) the account keeps the status it had and the note says so: only an answer changes what an account is shown as.
 * Returns the account's status afterwards, or null when there is nothing to check.
 */
export async function checkAccountHealth(accountId: string, deps: { now?: Date } = {}): Promise<AccountStatus | null> {
  return (await runHealthCheck(accountId, deps.now ?? new Date()))?.status ?? null;
}

/** How long the scheduler's health sweep may keep starting new checks in one run; the rest wait for the next. */
export const HEALTH_SWEEP_BUDGET_MS = 20_000;

/**
 * The scheduler's sweep: every connected account of a workspace that may have social work done right now, the one checked longest ago first, until the time
 * budget is spent (a slow platform must not hold up the rest of the scheduler). Returns how many were checked.
 */
export async function checkAllAccounts(deps: { now?: Date; budgetMs?: number } = {}): Promise<number> {
  const started = Date.now();
  const ids = await withSystem(async (db) => (await db.query<{ id: string }>(
    `select a.id from social_accounts a where a.status in ('connected', 'needs_reauth', 'error') and ${socialOrgRunnableSql("a.org_id")} order by a.last_checked_at nulls first limit 200`,
  )).rows.map((r) => r.id));
  let n = 0;
  for (const id of ids) {
    if (Date.now() - started >= (deps.budgetMs ?? HEALTH_SWEEP_BUDGET_MS)) break;
    if ((await checkAccountHealth(id, { now: deps.now })) !== null) n += 1;
  }
  return n;
}

/**
 * The platform refused an account's sign-in or permissions while publishing. The account stops being offered as connected, the other posts waiting on it are
 * stopped with a clear reason, and the owner and managers are told once a day. Call it after the failing job's own post has been finished.
 */
export async function markAccountNeedsReauth(db: Queryable, orgId: string, accountId: string, detail: string, now: Date = new Date()): Promise<void> {
  const { rows } = await db.query<{ name: string; status: AccountStatus }>("select name, status from social_accounts where id = $1 and org_id = $2 for update", [accountId, orgId]);
  const a = rows[0];
  if (!a || a.status === "needs_reauth" || a.status === "disconnected" || a.status === "revoked") return;
  await db.query("update social_accounts set status = 'needs_reauth', status_detail = $2, last_checked_at = $3 where id = $1", [accountId, detail.slice(0, 400), now]);
  const stopped = await stopPublishingFor(db, orgId, accountId);
  await notifyOrgRoles(db, orgId, ["owner", "admin"], {
    kind: "social_account_attention", severity: "warning", title: `${a.name} needs to be reconnected`,
    body: `${detail}${stopped ? ` ${stopped} post${stopped === 1 ? "" : "s"} waiting to publish ${stopped === 1 ? "was" : "were"} stopped.` : ""}`, link: "/social/accounts", dedupeKey: `social-reauth:${accountId}:${now.toISOString().slice(0, 10)}`,
  });
}

/** Tests one account now, for the person looking at it. Only the client's owner or manager (who may connect it) can, and only for their own workspace's account. */
export async function checkMyAccount(ctx: OrgContext, accountId: string): Promise<AccountStatus> {
  assertConnect(ctx);
  const own = await withSystem(async (db) => (await db.query("select 1 from social_accounts where id = $1 and org_id = $2 and status in ('connected', 'needs_reauth', 'error')", [accountId, ctx.org.orgId])).rows.length > 0);
  if (!own) throw new AppError("not_found", "That account was not found.");
  const r = await runHealthCheck(accountId, new Date());
  // Gone while the platform was being asked (disconnected, or the app removed): there is nothing to report on.
  if (!r || r.status === "disconnected" || r.status === "revoked") throw new AppError("not_found", "That account was not found.");
  // Say so rather than reporting the old status as if it had just been confirmed.
  if (r.outcome === "unreachable") throw new AppError("upstream_error", "The platform could not be reached just now, so this account could not be checked. Nothing about it has changed. Try again in a few minutes.");
  return r.status;
}
