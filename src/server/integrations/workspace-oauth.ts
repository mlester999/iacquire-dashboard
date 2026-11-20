import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { WorkspaceConnectionView, WorkspaceOAuthProvider } from "@/lib/integrations/workspace-oauth";
import { WORKSPACE_OAUTH_LABEL, WORKSPACE_OAUTH_PROVIDERS } from "@/lib/integrations/workspace-oauth";
import { recordAudit } from "@/server/audit";
import { pkcePair } from "@/server/calendars/adapters/oauth";
import { readSystem, withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { decryptSecret, encryptSecret, randomToken, sha256 } from "@/server/security/crypto";
import { consumeRateLimit } from "@/server/security/rate-limit";
import type { OrgContext } from "@/server/tenancy/context";
import {
  exchangeWorkspaceCode, refreshWorkspaceToken, revokeWorkspaceAccessToken, verifyWorkspaceToken,
  AIRTABLE_RECORD_SCOPE, WorkspaceOAuthError, workspaceAuthorizeUrl, workspaceOAuthConfig, workspaceTokensSchema, type OAuthConfig, type WorkspaceTokens,
} from "./workspace-oauth-adapter";

const MANAGE_RATE = { name: "workspace:oauth:manage", limit: 24, windowSeconds: 3600 };
const VERIFICATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const VALID_STATE = /^[A-Za-z0-9_-]{43}$/;

type StoredStatus = Exclude<WorkspaceConnectionView["status"], "needs_check">;
type ConnectionFacts = {
  provider: WorkspaceOAuthProvider;
  status: StoredStatus;
  access_expires_at: Date | null;
  last_verified_at: Date | null;
  has_shared_resources: boolean | null;
  stale_check: boolean;
};
type ConnectionRecord = ConnectionFacts & { credentials: string | null; check_id: string | null; check_in_progress: boolean; knowledge_retry_at: Date | null };

const connectionColumns = `provider, status, access_expires_at, last_verified_at, has_shared_resources,
  (check_id is not null and check_started_at <= now() - interval '65 seconds') as stale_check`;

function isEligibleWorkspace(ctx: OrgContext) {
  return ctx.org.kind === "client" && (ctx.org.status === "active" || ctx.org.status === "onboarding") && !ctx.org.isDemo;
}

export function canManageWorkspaceOAuth(ctx: OrgContext): boolean {
  return isEligibleWorkspace(ctx) && ctx.can("integrations.view") && (ctx.role === "owner" || ctx.role === "admin");
}

function requireManager(ctx: OrgContext) {
  if (!canManageWorkspaceOAuth(ctx)) throw new AppError("forbidden", "Only workspace owners and admins can manage these connections.");
}

async function lockConnection(db: Queryable, ctx: OrgContext, provider: WorkspaceOAuthProvider) {
  requireManager(ctx);
  await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`workspace-oauth:${ctx.org.orgId}:${provider}`]);
  const { rows } = await db.query(
    `select 1 from organization_memberships m
       join organizations o on o.id = m.org_id
       join users u on u.id = m.user_id
      where m.org_id = $1 and m.user_id = $2 and m.status = 'active' and u.status = 'active'
        and m.role in ('owner','admin') and o.kind = 'client' and o.status in ('active','onboarding') and not o.is_demo
      for share of m, o, u`,
    [ctx.org.orgId, ctx.user.id],
  );
  if (!rows.length) throw new AppError("forbidden", "Your workspace connection permissions changed.");
}

function requireConfig(provider: WorkspaceOAuthProvider) {
  const cfg = workspaceOAuthConfig(provider);
  if (!cfg) throw new AppError("integration_unavailable", `${WORKSPACE_OAUTH_LABEL[provider]} sign-in requires setup by iAcquire.`);
  return cfg;
}

async function rateLimit(ctx: OrgContext) {
  const limit = await consumeRateLimit(MANAGE_RATE, ctx.org.orgId);
  if (!limit.allowed) throw new AppError("rate_limited", "Too many connection requests. Try again later.", { retryAfterSeconds: limit.retryAfterSeconds });
}

async function loadConnection(db: Queryable, orgId: string, provider: WorkspaceOAuthProvider) {
  const { rows } = await db.query<ConnectionRecord>(
    `select ${connectionColumns}, credentials, check_id, knowledge_retry_at,
            (check_id is not null and check_started_at > now() - interval '65 seconds') as check_in_progress
       from workspace_oauth_connections where org_id = $1 and provider = $2`,
    [orgId, provider],
  );
  return rows[0] ?? null;
}

async function assertNoConcurrentExchange(db: Queryable, orgId: string, provider: WorkspaceOAuthProvider) {
  const { rows } = await db.query(
    `select 1 from workspace_oauth_states
      where org_id = $1 and provider = $2 and used_at > now() - interval '65 seconds' and expires_at > now()`,
    [orgId, provider],
  );
  if (rows.length) throw new AppError("conflict", "An authorization is already completing. Try again shortly.");
}

function assertNoConcurrentCheck(row: ConnectionRecord | null) {
  if (row?.check_in_progress) throw new AppError("conflict", "This connection is being checked or disconnected. Try again shortly.");
}

const credentialSchema = z.object({
  version: z.literal(1),
  orgId: z.string().uuid(),
  provider: z.enum(WORKSPACE_OAUTH_PROVIDERS),
  tokens: workspaceTokensSchema,
}).strict();

function sealTokens(orgId: string, provider: WorkspaceOAuthProvider, tokens: WorkspaceTokens) {
  return encryptSecret(JSON.stringify({ version: 1, orgId, provider, tokens }));
}

function openTokens(raw: string, orgId: string, provider: WorkspaceOAuthProvider): WorkspaceTokens {
  const value = credentialSchema.parse(JSON.parse(decryptSecret(raw)));
  if (value.orgId !== orgId || value.provider !== provider) throw new Error("Stored connection does not match its workspace.");
  return value.tokens;
}

function view(provider: WorkspaceOAuthProvider, row?: ConnectionFacts): WorkspaceConnectionView {
  const now = Date.now();
  const fresh = !row?.stale_check && row?.last_verified_at
    && new Date(row.last_verified_at).getTime() > now - VERIFICATION_MAX_AGE_MS
    && (!row.access_expires_at || new Date(row.access_expires_at).getTime() > now);
  const current = row?.status ?? "disconnected";
  const status = row?.stale_check && current !== "disconnected" ? "needs_reauth" : current === "connected" && !fresh ? "needs_check" : current;
  return {
    provider, configured: Boolean(workspaceOAuthConfig(provider)), status,
    lastVerifiedAt: row?.last_verified_at ? new Date(row.last_verified_at).toISOString() : null,
    hasSharedResources: status === "connected" ? row?.has_shared_resources ?? null : null,
  };
}

export async function listWorkspaceOAuthConnections(ctx: OrgContext): Promise<WorkspaceConnectionView[]> {
  if (!isEligibleWorkspace(ctx) || !ctx.can("integrations.view")) return [];
  const { rows } = await readSystem((db) => db.query<ConnectionFacts>(
    `select ${connectionColumns} from workspace_oauth_connections where org_id = $1`,
    [ctx.org.orgId],
  ));
  return WORKSPACE_OAUTH_PROVIDERS.map((provider) => view(provider, rows.find((row) => row.provider === provider)));
}

function audit(db: Queryable, ctx: OrgContext, provider: WorkspaceOAuthProvider, action: string, result: "success" | "failure" | "denied", metadata: Record<string, unknown> = {}) {
  return recordAudit({
    orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user",
    action: `integration.workspace_oauth_${action}`, targetType: "workspace_oauth_connection", targetId: provider,
    result, metadata: { provider, ...metadata },
  }, db);
}

export async function startWorkspaceOAuth(ctx: OrgContext, provider: WorkspaceOAuthProvider) {
  requireManager(ctx);
  const cfg = requireConfig(provider);
  await rateLimit(ctx);
  const state = randomToken(32);
  const pkce = provider === "airtable" ? pkcePair() : null;
  await withSystem(async (db) => {
    await lockConnection(db, ctx, provider);
    assertNoConcurrentCheck(await loadConnection(db, ctx.org.orgId, provider));
    await assertNoConcurrentExchange(db, ctx.org.orgId, provider);
    await db.query(
      `insert into workspace_oauth_states (org_id, user_id, provider, state_hash, session_hash, code_verifier, expires_at)
       values ($1, $2, $3, $4, $5, $6, now() + interval '10 minutes')
       on conflict (org_id, provider) do update set user_id = excluded.user_id, state_hash = excluded.state_hash,
         session_hash = excluded.session_hash, code_verifier = excluded.code_verifier, created_at = now(),
         expires_at = excluded.expires_at, used_at = null`,
      [ctx.org.orgId, ctx.user.id, provider, sha256(state), sha256(ctx.user.sessionId), pkce ? encryptSecret(pkce.verifier) : null],
    );
    await audit(db, ctx, provider, "started", "success");
  });
  return workspaceAuthorizeUrl(cfg, state, pkce?.challenge);
}

export async function completeWorkspaceOAuth(ctx: OrgContext, provider: WorkspaceOAuthProvider, input: { state: string | null; code: string | null; denied: boolean }) {
  requireManager(ctx);
  if (!input.state || !VALID_STATE.test(input.state)) throw new AppError("invalid_input", "This connection link is invalid. Start again from Integrations.");
  const cfg = requireConfig(provider);
  const stateHash = sha256(input.state);
  const stateArgs = [ctx.org.orgId, ctx.user.id, provider, stateHash, sha256(ctx.user.sessionId)];
  const criteria = "org_id = $1 and user_id = $2 and provider = $3 and state_hash = $4 and session_hash = $5";
  const consumed = await withSystem(async (db) => {
    await lockConnection(db, ctx, provider);
    assertNoConcurrentCheck(await loadConnection(db, ctx.org.orgId, provider));
    const { rows } = await db.query<{ code_verifier: string | null }>(
      `update workspace_oauth_states set used_at = now() where ${criteria} and used_at is null and expires_at > now() returning code_verifier`,
      stateArgs,
    );
    return rows[0] ?? null;
  });
  if (!consumed) throw new AppError("invalid_input", "This connection link expired, was used, or belongs to a different session or workspace.");

  let tokens: WorkspaceTokens;
  let observed: Awaited<ReturnType<typeof verifyWorkspaceToken>>;
  try {
    if (input.denied) {
      await withSystem((db) => audit(db, ctx, provider, "denied", "denied"));
      return "denied" as const;
    }
    if (!input.code || input.code.length > 4096 || /[\s\p{Cc}]/u.test(input.code)) throw new AppError("invalid_input", "The provider did not return a valid sign-in code.");
    tokens = await exchangeWorkspaceCode(cfg, input.code, consumed.code_verifier ? decryptSecret(consumed.code_verifier) : null);
    observed = await verifyWorkspaceToken(cfg, tokens.accessToken);
    await withSystem(async (db) => {
      await lockConnection(db, ctx, provider);
      assertNoConcurrentCheck(await loadConnection(db, ctx.org.orgId, provider));
      const used = await db.query(`delete from workspace_oauth_states where ${criteria} and used_at is not null and expires_at > now()`, stateArgs);
      if (!used.rowCount) throw new AppError("conflict", "The authorization was superseded. Start again from Integrations.");
      await db.query(
        `insert into workspace_oauth_connections (org_id, provider, status, credentials, access_expires_at, last_checked_at, last_verified_at, has_shared_resources)
         values ($1, $2, 'connected', $3, $4, now(), now(), $5)
         on conflict (org_id, provider) do update set status = 'connected', credentials = excluded.credentials,
           access_expires_at = excluded.access_expires_at, last_checked_at = now(), last_verified_at = now(),
           has_shared_resources = excluded.has_shared_resources, check_id = null, check_started_at = null, updated_at = now(), grant_revision = gen_random_uuid(), knowledge_retry_at = null`,
        [ctx.org.orgId, provider, sealTokens(ctx.org.orgId, provider, tokens), tokens.expiresAt ? new Date(tokens.expiresAt) : null, observed.hasSharedResources],
      );
      await audit(db, ctx, provider, "connected", "success");
    });
    return "connected" as const;
  } catch (error) {
    await withSystem((db) => audit(db, ctx, provider, "failed", "failure", { reason: error instanceof WorkspaceOAuthError ? error.kind : "authorization_incomplete" }));
    if (error instanceof AppError) throw error;
    throw new AppError("upstream_error", "The provider connection could not be verified. Check access at the provider and reconnect.");
  } finally {
    // Only remove this attempted state, so a replacement authorization remains intact.
    await withSystem((db) => db.query(`delete from workspace_oauth_states where ${criteria} and used_at is not null`, stateArgs)).catch(() => undefined);
  }
}

function classifyHealthError(error: unknown): StoredStatus {
  return error instanceof WorkspaceOAuthError && (error.kind === "auth" || error.kind === "permission") ? "needs_reauth" : "error";
}

export async function checkWorkspaceOAuth(ctx: OrgContext, provider: WorkspaceOAuthProvider): Promise<WorkspaceConnectionView> {
  await withWorkspaceOAuthRead(ctx, provider, verifyWorkspaceToken, { verify: true });
  const result = (await listWorkspaceOAuthConnections(ctx)).find((row) => row.provider === provider);
  if (!result) throw new AppError("not_found", "The connection could not be loaded.");
  return result;
}

type ReadLifecycle<T> = {
  verify?: boolean;
  before?: (db: Queryable) => Promise<void>;
  complete?: (db: Queryable, result: T) => Promise<void>;
  failed?: (db: Queryable, error: unknown) => Promise<void>;
};

/** Shared lease serializes token rotation, verification, imports and disconnection. */
export async function withWorkspaceOAuthRead<T>(
  ctx: OrgContext,
  provider: WorkspaceOAuthProvider,
  read: (cfg: OAuthConfig, token: string) => Promise<T>,
  lifecycle: ReadLifecycle<T> = {},
): Promise<T | null> {
  requireManager(ctx);
  const cfg = requireConfig(provider);
  await rateLimit(ctx);
  const checkId = randomUUID();
  const orgId = ctx.org.orgId;
  const claimed = await withSystem(async (db) => {
    await lockConnection(db, ctx, provider);
    const row = await loadConnection(db, orgId, provider);
    assertNoConcurrentCheck(row);
    await assertNoConcurrentExchange(db, orgId, provider);
    if (!row?.credentials || row.status === "disconnected" || row.status === "needs_reauth") {
      throw new AppError("conflict", "Reconnect the provider to restore access.");
    }
    if (!lifecycle.verify && row.knowledge_retry_at && new Date(row.knowledge_retry_at).getTime() > Date.now()) {
      const retryAfterSeconds = Math.ceil((new Date(row.knowledge_retry_at).getTime() - Date.now()) / 1000);
      throw new AppError("rate_limited", "The provider asked us to wait before reading again.", { retryAfterSeconds });
    }
    if (row.check_id) {
      // A previous operation may have rotated the refresh token before it was interrupted.
      await db.query(
        "update workspace_oauth_connections set status = 'needs_reauth', check_id = null, check_started_at = null, last_checked_at = now(), updated_at = now() where org_id = $1 and provider = $2",
        [orgId, provider],
      );
      await audit(db, ctx, provider, "checked", "failure", { status: "needs_reauth", reason: "interrupted" });
      return null;
    }
    await lifecycle.before?.(db);
    await db.query(
      "update workspace_oauth_connections set check_id = $3, check_started_at = now() where org_id = $1 and provider = $2",
      [orgId, provider, checkId],
    );
    return { ...row, credentials: row.credentials };
  });
  if (!claimed) throw new AppError("conflict", "The previous request was interrupted. Reconnect to restore access.");

  let status: StoredStatus = claimed.status;
  let tokens: WorkspaceTokens | null = null;
  let result: { data: T } | null = null;
  let failure: unknown;
  let refreshStarted = false;
  let refreshSucceeded = false;
  try {
    tokens = openTokens(claimed.credentials, orgId, provider);
    if (!lifecycle.verify && provider === "airtable" && tokens.airtableScope !== AIRTABLE_RECORD_SCOPE) {
      throw new AppError("conflict", "Reconnect Airtable and grant read access to records before importing.");
    }
    const refresh = async (previous: WorkspaceTokens) => {
      refreshStarted = true;
      if (previous.refreshExpiresAt && previous.refreshExpiresAt <= Date.now()) throw new WorkspaceOAuthError("auth");
      const next = await refreshWorkspaceToken(cfg, previous);
      refreshSucceeded = true;
      return next;
    };
    if (tokens.expiresAt && tokens.expiresAt <= Date.now()) tokens = await refresh(tokens);
    try {
      result = { data: await read(cfg, tokens.accessToken) };
    } catch (error) {
      if (!(error instanceof WorkspaceOAuthError) || error.kind !== "auth" || refreshStarted) throw error;
      tokens = await refresh(tokens);
      result = { data: await read(cfg, tokens.accessToken) };
    }
    status = "connected";
  } catch (error) {
    failure = error;
    if (!tokens || (refreshStarted && !refreshSucceeded) || (error instanceof WorkspaceOAuthError && error.kind === "auth")) {
      status = "needs_reauth";
    } else if (lifecycle.verify) {
      status = classifyHealthError(error);
    }
  }

  const sharedResources = result && lifecycle.verify ? (result.data as { hasSharedResources: boolean | null }).hasSharedResources : claimed.has_shared_resources;
  const retryAfter = failure instanceof WorkspaceOAuthError && failure.kind === "rate_limit" ? failure.retryAfter : null;
  await withSystem(async (db) => {
    await lockConnection(db, ctx, provider);
    const updated = await db.query(
      `update workspace_oauth_connections
          set status = $4, credentials = $5, access_expires_at = $6, last_checked_at = now(),
              last_verified_at = case when $8::boolean then now() else last_verified_at end,
              has_shared_resources = $7, check_id = null, check_started_at = null, updated_at = now(),
              knowledge_retry_at = case when $9::int is not null then now() + $9 * interval '1 second' else knowledge_retry_at end
        where org_id = $1 and provider = $2 and check_id = $3`,
      [orgId, provider, checkId, status, tokens ? (refreshSucceeded ? sealTokens(orgId, provider, tokens) : claimed.credentials) : null,
        tokens?.expiresAt ? new Date(tokens.expiresAt) : null, lifecycle.verify && !result ? null : sharedResources, Boolean(result), retryAfter],
    );
    if (!updated.rowCount) throw new AppError("conflict", "The connection changed while it was checked.");
    if (result) await lifecycle.complete?.(db, result.data);
    else await lifecycle.failed?.(db, failure);
    if (lifecycle.verify || status === "needs_reauth") {
      await audit(db, ctx, provider, "checked", status === "connected" ? "success" : "failure", { status, refreshed: refreshSucceeded });
    }
  });
  if (result) return result.data;
  if (lifecycle.verify) return null;
  if (status === "needs_reauth") throw new AppError("conflict", "Reconnect the provider to restore access.");
  if (failure instanceof AppError) throw failure;
  if (failure instanceof WorkspaceOAuthError) {
    if (failure.kind === "rate_limit") throw new AppError("rate_limited", "The provider asked us to wait before reading again.", { retryAfterSeconds: failure.retryAfter });
    if (failure.kind === "permission" || failure.kind === "missing") throw new AppError("not_found", "The provider no longer shares this source, or the source was removed.");
  }
  throw new AppError("upstream_error", "The provider did not return a usable response. Try again later.");
}

/** Reviews run under the same lock as imports so a stale browser cannot approve an old snapshot. */
export async function withWorkspaceKnowledgeReview<T>(ctx: OrgContext, provider: WorkspaceOAuthProvider, run: (db: Queryable) => Promise<T>) {
  return withSystem(async (db) => {
    await lockConnection(db, ctx, provider);
    const row = await loadConnection(db, ctx.org.orgId, provider);
    await assertNoConcurrentExchange(db, ctx.org.orgId, provider);
    if (!row || row.status !== "connected" || row.check_id || !workspaceOAuthConfig(provider)) {
      throw new AppError("conflict", "Verify your provider connection before reviewing this import.");
    }
    return run(db);
  });
}

export async function disconnectWorkspaceOAuth(ctx: OrgContext, provider: WorkspaceOAuthProvider): Promise<"revoked" | "manual"> {
  requireManager(ctx);
  const cfg = workspaceOAuthConfig(provider);
  const orgId = ctx.org.orgId;
  const revokeId = randomUUID();
  const captured = await withSystem(async (db) => {
    await lockConnection(db, ctx, provider);
    const row = await loadConnection(db, orgId, provider);
    assertNoConcurrentCheck(row);
    await db.query("delete from workspace_oauth_states where org_id = $1 and provider = $2", [orgId, provider]);
    if (!row || row.status === "disconnected") return null;
    const revoke = provider === "notion" && cfg && row.credentials ? revokeId : null;
    await db.query(
      `update workspace_oauth_connections set status = 'disconnected', credentials = null, access_expires_at = null,
         last_verified_at = null, has_shared_resources = null, last_checked_at = now(), updated_at = now(),
         grant_revision = gen_random_uuid(), knowledge_retry_at = null,
         check_id = $3, check_started_at = case when $3::uuid is not null then now() else null end
       where org_id = $1 and provider = $2`,
      [orgId, provider, revoke],
    );
    await audit(db, ctx, provider, "disconnected", "success");
    return revoke ? row.credentials : null;
  });
  if (!captured || !cfg) return "manual";
  const revoked = await (async () => {
    try {
      const tokens = openTokens(captured, orgId, provider);
      return await revokeWorkspaceAccessToken(cfg, tokens.accessToken);
    } catch {
      return false;
    }
  })();
  await withSystem(async (db) => {
    await db.query(
      "update workspace_oauth_connections set check_id = null, check_started_at = null where org_id = $1 and provider = $2 and check_id = $3",
      [orgId, provider, revokeId],
    );
    await audit(db, ctx, provider, "revocation", revoked ? "success" : "failure", { providerRevocationConfirmed: revoked });
  });
  return revoked ? "revoked" : "manual";
}
