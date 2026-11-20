import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as oauthCallback } from "@/app/api/integrations/workspace-oauth/[provider]/callback/route";
import { startWorkspaceOAuthAction } from "@/app/actions/workspace-oauth";
import { WORKSPACE_OAUTH_NOTICE, type WorkspaceOAuthProvider } from "@/lib/integrations/workspace-oauth";
import { withSystem, withUser } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { readWorkspaceOAuthNotice } from "@/server/integrations/workspace-oauth-notice";
import {
  checkWorkspaceOAuth, completeWorkspaceOAuth, disconnectWorkspaceOAuth, listWorkspaceOAuthConnections, startWorkspaceOAuth,
} from "@/server/integrations/workspace-oauth";
import { decryptSecret, sha256 } from "@/server/security/crypto";
import type { OrgContext } from "@/server/tenancy/context";
import { addMember, createOrg, createUser, ctxFor } from "./support/fixtures";

const requestContext = vi.hoisted(() => ({
  ctx: null as OrgContext | null,
  fresh: null as OrgContext["user"] | null,
}));
vi.mock("@/server/tenancy/context", () => ({
  getOrgContext: async () => requestContext.ctx,
  requireOrgContextOrThrow: async () => requestContext.ctx,
}));
vi.mock("@/server/auth/session", () => ({ requireFreshUserOrThrow: async () => requestContext.fresh }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const origin = "https://portal.example.test";
const inputs = {
  APP_URL: origin,
  NOTION_WORKSPACE_OAUTH_CLIENT_ID: "notion-test-client",
  NOTION_WORKSPACE_OAUTH_CLIENT_SECRET: "notion-test-secret",
  AIRTABLE_WORKSPACE_OAUTH_CLIENT_ID: "airtable-test-client",
  AIRTABLE_WORKSPACE_OAUTH_CLIENT_SECRET: "airtable-test-secret",
};
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  for (const [key, value] of Object.entries(inputs)) vi.stubEnv(key, value);
  resetEnvCache();
  fetchMock.mockReset().mockRejectedValue(new Error("Unexpected request in synthetic provider test"));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  requestContext.ctx = null;
  requestContext.fresh = null;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetEnvCache();
});

async function tenant() {
  const user = await createUser();
  const org = await createOrg();
  await addMember(org.id, user.id, "owner");
  return { org, user, ctx: ctxFor(user, org, "owner") };
}

const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const tokens = (prefix: string, airtable = false) => ({
  access_token: `${prefix}-access`, refresh_token: `${prefix}-refresh`, token_type: airtable ? "Bearer " : "bearer",
  ...(airtable ? { expires_in: 3600, refresh_expires_in: 5_184_000, scope: "schema.bases:read data.records:read" } : {}),
});

async function authorize(ctx: OrgContext, provider: WorkspaceOAuthProvider) {
  const url = new URL(await startWorkspaceOAuth(ctx, provider));
  return { url, state: url.searchParams.get("state"), code: "synthetic-code", denied: false };
}

async function connection(orgId: string, provider: WorkspaceOAuthProvider) {
  const { rows } = await withSystem((db) => db.query<{ credentials: string | null; status: string; has_shared_resources: boolean | null }>(
    "select credentials, status, has_shared_resources from workspace_oauth_connections where org_id = $1 and provider = $2",
    [orgId, provider],
  ));
  return rows[0] ?? null;
}

describe("tenant workspace OAuth", () => {
  it("rolls back empty tables in a transaction and refuses to drop existing connection history", async () => {
    const down = readFileSync("supabase/rollbacks/0143_workspace_oauth_connections.down.sql", "utf8");
    const knowledgeDown = readFileSync("supabase/rollbacks/0146_workspace_knowledge_sources.down.sql", "utf8");
    const done = new Error("Restore rolled-back schema");
    await expect(withSystem(async (db) => {
      await db.query(knowledgeDown);
      await db.query(down);
      const table = await db.query("select to_regclass('public.workspace_oauth_connections') as found");
      expect(table.rows[0]).toEqual({ found: null });
      throw done;
    })).rejects.toBe(done);
    const org = await createOrg();
    await expect(withSystem(async (db) => {
      await db.query("insert into workspace_oauth_connections (org_id, provider, status) values ($1, 'notion', 'disconnected')", [org.id]);
      await db.query(knowledgeDown);
      await db.query(down);
    })).rejects.toThrow(/Rollback refused/);
  });

  it("consumes a Notion callback once, verifies the credentials, and seals them before marking the tenant connected", async () => {
    const { ctx, org, user } = await tenant();
    fetchMock.mockResolvedValueOnce(response(tokens("notion"))).mockResolvedValueOnce(response({ active: true, workspace_name: "private workspace" }));
    const auth = await authorize(ctx, "notion");
    expect(auth.url.origin + auth.url.pathname).toBe("https://api.notion.com/v1/oauth/authorize");
    expect(auth.url.searchParams.get("owner")).toBe("user");
    expect(auth.url.searchParams.get("redirect_uri")).toBe(`${origin}/api/integrations/workspace-oauth/notion/callback`);
    expect(await completeWorkspaceOAuth(ctx, "notion", auth)).toBe("connected");
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.notion.com/v1/oauth/token", "https://api.notion.com/v1/oauth/introspect",
    ]);
    const tokenRequest = fetchMock.mock.calls[0][1];
    expect(tokenRequest).toMatchObject({ method: "POST", redirect: "error", cache: "no-store" });
    expect(new Headers(tokenRequest?.headers).get("authorization")).toBe(`Basic ${Buffer.from("notion-test-client:notion-test-secret").toString("base64")}`);
    expect(new Headers(tokenRequest?.headers).get("notion-version")).toBe("2026-03-11");
    expect(JSON.parse(String(tokenRequest?.body))).toMatchObject({ code: auth.code, grant_type: "authorization_code" });

    const persisted = await connection(org.id, "notion");
    expect(persisted?.credentials).toMatch(/^v1\./);
    expect(persisted?.credentials).not.toContain("notion-access");
    expect(JSON.parse(decryptSecret(persisted!.credentials!))).toMatchObject({
      orgId: org.id, provider: "notion", tokens: { accessToken: "notion-access", refreshToken: "notion-refresh" },
    });
    expect(await listWorkspaceOAuthConnections(ctx)).toContainEqual({
      provider: "notion", configured: true, status: "connected", lastVerifiedAt: expect.any(String), hasSharedResources: null,
    });
    await expect(completeWorkspaceOAuth(ctx, "notion", auth)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(withUser(user.id, (db) => db.query("select credentials from workspace_oauth_connections"))).rejects.toThrow(/permission denied/);
    await expect(withUser(user.id, (db) => db.query("select state_hash from workspace_oauth_states"))).rejects.toThrow(/permission denied/);
    const audit = await withSystem((db) => db.query("select actor_user_id, action, metadata from audit_logs where org_id = $1 order by action", [org.id]));
    expect(audit.rows).toContainEqual({ actor_user_id: user.id, action: "integration.workspace_oauth_connected", metadata: { provider: "notion" } });
    expect(JSON.stringify(audit.rows)).not.toMatch(/notion-access|notion-refresh|private workspace|synthetic-code/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("limits Airtable grants to base metadata and read-only records, refreshes rotated tokens once, and disconnects locally without an Airtable revoke request", async () => {
    const { ctx, org } = await tenant();
    const auth = await authorize(ctx, "airtable");
    expect(auth.url.origin + auth.url.pathname).toBe("https://airtable.com/oauth2/v1/authorize");
    expect(auth.url.searchParams.get("scope")).toBe("schema.bases:read data.records:read");
    expect(auth.url.searchParams.get("code_challenge_method")).toBe("S256");
    const stateRow = await withSystem((db) => db.query<{ state_hash: string; code_verifier: string }>(
      "select state_hash, code_verifier from workspace_oauth_states where org_id = $1", [org.id],
    ));
    expect(stateRow.rows[0].state_hash).toBe(sha256(auth.state!));
    expect(stateRow.rows[0].code_verifier).toMatch(/^v1\./);
    const verifier = decryptSecret(stateRow.rows[0].code_verifier);
    expect(auth.url.searchParams.get("code_challenge")).toBe(createHash("sha256").update(verifier).digest("base64url"));
    fetchMock.mockResolvedValueOnce(response(tokens("first", true))).mockResolvedValueOnce(response({ bases: [] }));
    expect(await completeWorkspaceOAuth(ctx, "airtable", auth)).toBe("connected");
    const exchange = fetchMock.mock.calls[0][1];
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://airtable.com/oauth2/v1/token");
    expect(new Headers(exchange?.headers).get("authorization")).toBe(`Basic ${Buffer.from("airtable-test-client:airtable-test-secret").toString("base64url")}`);
    expect(new URLSearchParams(String(exchange?.body)).get("code_verifier")).toBe(verifier);
    expect(await listWorkspaceOAuthConnections(ctx)).toContainEqual(expect.objectContaining({ provider: "airtable", status: "connected", hasSharedResources: false }));

    fetchMock.mockResolvedValueOnce(response({ error: "invalid token" }, 401)).mockResolvedValueOnce(response(tokens("rotated", true)))
      .mockResolvedValueOnce(response({ bases: [{ id: "appSynthetic", name: "private named base" }] }));
    expect(await checkWorkspaceOAuth(ctx, "airtable")).toMatchObject({ status: "connected", hasSharedResources: true });
    const refresh = fetchMock.mock.calls[3][1];
    expect(Object.fromEntries(new URLSearchParams(String(refresh?.body)))).toEqual({
      grant_type: "refresh_token", refresh_token: "first-refresh", scope: "schema.bases:read data.records:read",
    });
    expect(new Headers(fetchMock.mock.calls[4][1]?.headers).get("authorization")).toBe("Bearer rotated-access");
    const saved = decryptSecret((await connection(org.id, "airtable"))!.credentials!);
    expect(saved).toContain("rotated-refresh");
    expect(saved).not.toMatch(/appSynthetic|private named base|first-refresh/);
    expect(await disconnectWorkspaceOAuth(ctx, "airtable")).toBe("manual");
    expect(await connection(org.id, "airtable")).toEqual({ credentials: null, status: "disconnected", has_shared_resources: null });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://airtable.com/oauth2/v1/token", "https://api.airtable.com/v0/meta/bases", "https://api.airtable.com/v0/meta/bases",
      "https://airtable.com/oauth2/v1/token", "https://api.airtable.com/v0/meta/bases",
    ]);
  });

  it("binds the callback to the provider, tenant, actor, active permissions, and browser session", async () => {
    const { ctx, user, org } = await tenant();
    const otherOrg = await createOrg();
    await addMember(otherOrg.id, user.id, "owner");
    const alternate = { ...ctxFor(user, otherOrg, "owner"), user: ctx.user };
    const otherUser = await createUser();
    await addMember(org.id, otherUser.id, "admin");
    const otherAdmin = ctxFor(otherUser, org, "admin");
    const auth = await authorize(ctx, "notion");
    await expect(completeWorkspaceOAuth(alternate, "notion", auth)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(completeWorkspaceOAuth(ctx, "airtable", auth)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(completeWorkspaceOAuth(ctxFor(user, org, "owner"), "notion", auth)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(completeWorkspaceOAuth(otherAdmin, "notion", auth)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(startWorkspaceOAuth(ctxFor(user, org, "member"), "notion")).rejects.toMatchObject({ code: "forbidden" });
    await withSystem((db) => db.query(
      "update workspace_oauth_states set created_at = now() - interval '20 minutes', expires_at = now() - interval '10 minutes' where org_id = $1", [org.id],
    ));
    await expect(completeWorkspaceOAuth(ctx, "notion", auth)).rejects.toMatchObject({ code: "invalid_input" });
    const fresh = await authorize(ctx, "notion");
    await withSystem((db) => db.query("update organization_memberships set status = 'revoked' where org_id = $1 and user_id = $2", [org.id, user.id]));
    await expect(completeWorkspaceOAuth(ctx, "notion", fresh)).rejects.toMatchObject({ code: "forbidden" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks stale Settings actions and redirects callbacks without leaking provider messages, codes or a replayable state", async () => {
    const { ctx, org, user } = await tenant();
    requestContext.ctx = ctx;
    requestContext.fresh = ctx.user;
    const { org: wrong } = await tenant();
    await expect(startWorkspaceOAuthAction(wrong.id, "notion")).resolves.toMatchObject({ ok: false, code: "conflict" });
    const action = await startWorkspaceOAuthAction(org.id, "notion");
    expect(action.ok).toBe(true);
    const state = new URL(action.ok ? action.data : "").searchParams.get("state")!;
    const callback = (params: URLSearchParams) => oauthCallback(new NextRequest(`${origin}/api/integrations/workspace-oauth/notion/callback?${params}`), {
      params: Promise.resolve({ provider: "notion" }),
    });
    const callbackParams = new URLSearchParams({ state, error: "access_denied", error_description: "private upstream detail" });
    const duplicate = await callback(new URLSearchParams([...callbackParams, ["state", state]]));
    expect(readWorkspaceOAuthNotice(ctx, duplicate.cookies.get(WORKSPACE_OAUTH_NOTICE)?.value)).toEqual({ provider: "notion", outcome: "error" });
    const reply = await callback(callbackParams);
    expect(reply.status).toBe(303);
    expect(reply.headers.get("location")).toBe(`${origin}/settings/integrations`);
    expect(reply.headers.get("cache-control")).toBe("no-store");
    expect(reply.headers.get("referrer-policy")).toBe("no-referrer");
    expect(reply.headers.get("set-cookie")).not.toMatch(/private upstream detail|access_denied/);
    const cookie = reply.cookies.get(WORKSPACE_OAUTH_NOTICE)?.value;
    expect(readWorkspaceOAuthNotice(ctx, cookie)).toEqual({ provider: "notion", outcome: "denied" });
    expect(readWorkspaceOAuthNotice(ctxFor(user, org, "owner"), cookie)).toBeNull();
    expect(readWorkspaceOAuthNotice(ctx, (await callback(callbackParams)).cookies.get(WORKSPACE_OAUTH_NOTICE)?.value)).toEqual({ provider: "notion", outcome: "error" });
    expect(fetchMock).not.toHaveBeenCalled();
    const auth = await authorize(ctx, "notion");
    fetchMock.mockResolvedValueOnce(response(tokens("notion"))).mockResolvedValueOnce(response({ active: true }));
    const success = await callback(new URLSearchParams({ state: auth.state!, code: auth.code }));
    expect(success.headers.get("location")).toBe(`${origin}/settings/integrations`);
    expect(readWorkspaceOAuthNotice(ctx, success.cookies.get(WORKSPACE_OAUTH_NOTICE)?.value)).toBeNull();
    expect((await connection(org.id, "notion"))?.status).toBe("connected");
  });

  it("keeps verification stale after its validity window, avoids parallel refresh, and requires reconnect after an ambiguous rotation", async () => {
    const { ctx, org } = await tenant();
    const auth = await authorize(ctx, "airtable");
    fetchMock.mockResolvedValueOnce(response(tokens("first", true))).mockResolvedValueOnce(response({ bases: [] }));
    await completeWorkspaceOAuth(ctx, "airtable", auth);
    await withSystem((db) => db.query("update workspace_oauth_connections set last_verified_at = now() - interval '25 hours' where org_id = $1", [org.id]));
    expect(await listWorkspaceOAuthConnections(ctx)).toContainEqual(expect.objectContaining({ provider: "airtable", status: "needs_check", hasSharedResources: null }));
    const refreshStarted = Promise.withResolvers<void>();
    const finishRefresh = Promise.withResolvers<Response>();
    fetchMock.mockResolvedValueOnce(response({}, 401)).mockImplementationOnce(() => {
      refreshStarted.resolve();
      return finishRefresh.promise;
    });
    const firstCheck = checkWorkspaceOAuth(ctx, "airtable");
    await refreshStarted.promise;
    try {
      await expect(checkWorkspaceOAuth(ctx, "airtable")).rejects.toMatchObject({ code: "conflict" });
      expect(fetchMock).toHaveBeenCalledTimes(4);
    } finally {
      finishRefresh.resolve(response({ error: "private upstream detail" }, 503));
    }
    expect(await firstCheck).toMatchObject({ status: "needs_reauth" });
    await expect(checkWorkspaceOAuth(ctx, "airtable")).rejects.toMatchObject({ code: "conflict" });
    expect(fetchMock).toHaveBeenCalledTimes(4);

    const reconnect = await authorize(ctx, "airtable");
    fetchMock.mockResolvedValueOnce(response({ ...tokens("over-scoped", true), scope: "schema.bases:read data.records:read data.records:write" }));
    await expect(completeWorkspaceOAuth(ctx, "airtable", reconnect)).rejects.toMatchObject({ code: "upstream_error" });
    expect((await connection(org.id, "airtable"))?.status).toBe("needs_reauth");
    const valid = await authorize(ctx, "airtable");
    fetchMock.mockResolvedValueOnce(response(tokens("reauthorized", true))).mockResolvedValueOnce(response({ bases: [] }));
    await expect(completeWorkspaceOAuth(ctx, "airtable", valid)).resolves.toBe("connected");
  });

  it("cancels pending Notion attempts, erases local credentials before revoking, and degrades honestly without provider settings", async () => {
    const { ctx, org } = await tenant();
    expect(await listWorkspaceOAuthConnections(ctx)).toContainEqual(expect.objectContaining({ provider: "notion", configured: true, status: "disconnected" }));
    const auth = await authorize(ctx, "notion");
    fetchMock.mockResolvedValueOnce(response(tokens("notion"))).mockResolvedValueOnce(response({ active: true }));
    await completeWorkspaceOAuth(ctx, "notion", auth);
    const pending = await authorize(ctx, "notion");
    fetchMock.mockImplementationOnce(async (url, init) => {
      expect(String(url)).toBe("https://api.notion.com/v1/oauth/revoke");
      expect(JSON.parse(String(init?.body))).toEqual({ token: "notion-access" });
      expect(await connection(org.id, "notion")).toEqual({ credentials: null, status: "disconnected", has_shared_resources: null });
      return response({ request_id: "synthetic-request" });
    });
    expect(await disconnectWorkspaceOAuth(ctx, "notion")).toBe("revoked");
    await expect(completeWorkspaceOAuth(ctx, "notion", pending)).rejects.toMatchObject({ code: "invalid_input" });
    vi.stubEnv("NOTION_WORKSPACE_OAUTH_CLIENT_SECRET", "");
    resetEnvCache();
    expect(await listWorkspaceOAuthConnections(ctx)).toContainEqual(expect.objectContaining({ provider: "notion", configured: false, status: "disconnected" }));
    await expect(startWorkspaceOAuth(ctx, "notion")).rejects.toMatchObject({ code: "integration_unavailable" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
