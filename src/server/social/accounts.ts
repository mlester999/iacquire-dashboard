import "server-only";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyOrgRoles } from "@/server/notifications";
import { decryptSecret, encryptSecret, randomToken, sha256 } from "@/server/security/crypto";
import type { OrgContext } from "@/server/tenancy/context";
import type { Platform } from "@/lib/social/rules";
import { PLATFORMS } from "@/lib/social/rules";
import { openCredentials, sealCredentials } from "@/server/social/credentials";
import { providerFor, simulatedAllowed, type Adapter } from "@/server/social/providers";
import { authorizeUrl, canPostTo, metaConfigured, resolveSignIn, type ConnectedPage } from "@/server/social/providers/meta-oauth";
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
  if (!ctx.can("social.connect")) throw new AppError("forbidden", "Only the business owner or a manager can connect social accounts.");
}

/** Connected and previously connected accounts, newest first. The token is never part of what is returned. */
export async function listAccounts(ctx: OrgContext, opts: { includeDisconnected?: boolean } = {}): Promise<AccountView[]> {
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

/** Records a single-use sign-in state for this person and returns the address to send the browser to. */
export async function startMetaConnect(ctx: OrgContext, platform: Platform, returnPath?: string | null): Promise<{ url: string }> {
  assertConnect(ctx);
  if (!PLATFORMS.includes(platform)) throw new AppError("invalid_input", "Choose Facebook or Instagram.");
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
  return { url: authorizeUrl(state, platform) };
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

async function openPending(db: Queryable, ctx: OrgContext, stateId: string): Promise<{ platform: Platform; userId: string; pages: ConnectedPage[] }> {
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
  const connected: string[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  const provider = deps.provider ?? providerFor("meta");
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
        }
        await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "social.account_connected", targetType: "social_account", targetId: accountId, result: "success", metadata: { platform: t.platform } }, db);
        return accountId;
      });
      connected.push(id);
    }
  }
  await withSystem((db) => db.query("update social_oauth_states set used_at = now(), pending = null where id = $1", [stateId]));
  const views = await listAccounts(ctx);
  return { connected: views.filter((v) => connected.includes(v.id)), skipped };
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
 * already have sent is NOT cancelled quietly: its post is marked failed with "not known whether it went out", never treated as "not posted". Returns how many posts were affected.
 */
export async function stopPublishingFor(db: Queryable, orgId: string, accountId: string): Promise<number> {
  const { rows } = await db.query<{ id: string; post_id: string; state: Record<string, unknown> }>(
    "select id, post_id, state from social_publish_jobs where org_id = $1 and account_id = $2 and status in ('queued', 'running', 'unknown')", [orgId, accountId],
  );
  for (const j of rows) {
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
  return rows.length;
}

/** Disconnects an account: the token is deleted, publishing for it stops. The business's published posts stay where they are on the platform. */
export async function disconnectAccount(ctx: OrgContext, accountId: string): Promise<{ stopped: number }> {
  assertConnect(ctx);
  return withSystem(async (db) => {
    const { rows } = await db.query<{ id: string; name: string; platform: Platform }>("select id, name, platform from social_accounts where id = $1 and org_id = $2 and status <> 'disconnected' for update", [accountId, ctx.org.orgId]);
    if (!rows[0]) throw new AppError("not_found", "That account was not found.");
    await db.query("update social_accounts set status = 'disconnected', credentials = null, token_expires_at = null, status_detail = 'Disconnected by a person.', disconnected_at = now() where id = $1", [accountId]);
    const stopped = await stopPublishingFor(db, ctx.org.orgId, accountId);
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "social.account_disconnected", targetType: "social_account", targetId: accountId, result: "success", metadata: { platform: rows[0].platform, stopped } }, db);
    return { stopped };
  });
}

/**
 * The platform told us a person removed the app (deauthorization) or asked for their data to be deleted: every account they authorized stops working here at
 * once, its token is deleted, and what it was about to publish is stopped. Returns the accounts affected.
 */
export async function revokeByProviderUser(providerUserId: string, why: "deauthorized" | "data_deletion"): Promise<number> {
  return withSystem(async (db) => {
    const { rows } = await db.query<{ id: string; org_id: string; name: string }>(
      "select id, org_id, name from social_accounts where provider_user_id = $1 and status in ('connected', 'needs_reauth', 'error') for update", [providerUserId],
    );
    for (const a of rows) {
      await db.query("update social_accounts set status = 'revoked', credentials = null, token_expires_at = null, status_detail = $2, disconnected_at = now() where id = $1", [a.id, why === "deauthorized" ? "The person who connected this account removed the iAcquire app on the platform." : "Data deletion was requested on the platform."]);
      const stopped = await stopPublishingFor(db, a.org_id, a.id);
      await recordAudit({ orgId: a.org_id, actorKind: "system", action: "social.account_revoked", targetType: "social_account", targetId: a.id, result: "success", metadata: { why, stopped } }, db);
      await notifyOrgRoles(db, a.org_id, ["owner", "admin"], { kind: "social_account_attention", severity: "warning", title: `${a.name} was disconnected`, body: "The platform reported that the app was removed from this account. Nothing more will be published to it until you reconnect.", link: "/social/accounts", dedupeKey: `social-revoked:${a.id}` });
    }
    return rows.length;
  });
}

/** Checks one account with its provider and records what it said. A change for the worse is announced to the owner and managers once. */
export async function checkAccountHealth(accountId: string, deps: { now?: Date } = {}): Promise<AccountStatus | null> {
  const acc = await withSystem(async (db) => (await db.query<{ id: string; org_id: string; platform: Platform; adapter: Adapter; external_id: string; name: string; credentials: string | null; status: AccountStatus }>(
    "select id, org_id, platform, adapter, external_id, name, credentials, status from social_accounts where id = $1 and status in ('connected', 'needs_reauth', 'error')", [accountId],
  )).rows[0]);
  if (!acc) return null;
  const creds = openCredentials(acc.credentials);
  let next: { status: AccountStatus; detail: string | null; health: HealthResult | null };
  if (!creds) next = { status: "needs_reauth", detail: "The saved sign-in can no longer be used. Reconnect the account.", health: null };
  else {
    try {
      const h = await providerFor(acc.adapter).health(creds, { platform: acc.platform, externalId: acc.external_id });
      next = { status: h.status, detail: h.status === "connected" ? null : h.detail, health: h };
    } catch (e) {
      const needsReauth = e instanceof ProviderError && e.needsReauth;
      next = { status: needsReauth ? "needs_reauth" : "error", detail: e instanceof ProviderError ? e.message : "The platform could not be reached.", health: null };
    }
  }
  await withSystem(async (db) => {
    const h = next.health;
    await db.query(
      `update social_accounts set status = $2, status_detail = $3, last_checked_at = $4,
         last_success_at = case when $2 = 'connected' then $4 else last_success_at end,
         scopes = coalesce($5, scopes), token_expires_at = coalesce($6, token_expires_at), data_access_expires_at = coalesce($7, data_access_expires_at),
         capabilities = coalesce($8::jsonb, capabilities), rate_state = case when $9::jsonb is null then rate_state else $9::jsonb end
       where id = $1`,
      [acc.id, next.status, next.detail, deps.now ?? new Date(), h?.scopes ?? null, h?.expiresAt ?? null, h?.dataAccessExpiresAt ?? null, h ? JSON.stringify(h.capabilities) : null,
        h?.quota ? JSON.stringify({ quotaUsage: h.quota.usage, quotaTotal: h.quota.total, checkedAt: (deps.now ?? new Date()).toISOString() }) : null],
    );
    if (next.status === "needs_reauth" && acc.status !== "needs_reauth") {
      const stopped = await stopPublishingFor(db, acc.org_id, acc.id);
      await notifyOrgRoles(db, acc.org_id, ["owner", "admin"], { kind: "social_account_attention", severity: "warning", title: `${acc.name} needs to be reconnected`, body: `${next.detail ?? "Its sign-in no longer works."}${stopped ? ` ${stopped} post${stopped === 1 ? "" : "s"} waiting to publish ${stopped === 1 ? "was" : "were"} stopped.` : ""}`, link: "/social/accounts", dedupeKey: `social-reauth:${acc.id}:${(deps.now ?? new Date()).toISOString().slice(0, 10)}` });
    }
  });
  return next.status;
}

/** The scheduler's sweep: every connected account, checked. Returns how many were checked. */
export async function checkAllAccounts(deps: { now?: Date } = {}): Promise<number> {
  const ids = await withSystem(async (db) => (await db.query<{ id: string }>("select id from social_accounts where status in ('connected', 'needs_reauth', 'error') order by last_checked_at nulls first limit 200")).rows.map((r) => r.id));
  let n = 0;
  for (const id of ids) {
    if ((await checkAccountHealth(id, deps)) !== null) n += 1;
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
