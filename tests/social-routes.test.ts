// The social media routes: the sign-in start and return, the media upload and preview, and Meta's callbacks. The session is replaced (a signed-in person is
// handed to the route); everything below the route is the real service on embedded Postgres. Nothing contacts Meta.
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { sha256 } from "@/server/security/crypto";
import { signRequestForTests } from "@/server/social/providers/meta-oauth";
import { decodeSocialNotice } from "@/server/social/notice";
import { GET as startRoute } from "@/app/api/social/oauth/meta/start/route";
import { GET as callbackRoute } from "@/app/api/social/oauth/meta/callback/route";
import { POST as uploadRoute } from "@/app/api/social/media/route";
import { GET as previewRoute } from "@/app/api/social/media/[id]/route";
import { POST as deauthorizeRoute } from "@/app/api/webhooks/meta-social/deauthorize/route";
import { POST as dataDeletionRoute } from "@/app/api/webhooks/meta-social/data-deletion/route";
import { GET as deletionStatusRoute } from "@/app/api/webhooks/meta-social/data-deletion-status/route";
import { createOrg } from "./support/fixtures";
import { connect, rows, socialOrg, type SocialOrg } from "./support/social";

const session = vi.hoisted(() => ({ ctx: null as unknown, user: null as unknown }));
vi.mock("@/server/tenancy/context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/tenancy/context")>()),
  requireOrgContextOrThrow: async () => session.ctx,
}));
vi.mock("@/server/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth/session")>()),
  getCurrentUser: async () => session.user,
  assertSameOrigin: async () => undefined,
}));

const APP_SECRET = "route-test-app-secret-0123456789";
const words = /Social media is managed inside each client's workspace/;

beforeAll(() => {
  process.env.META_SOCIAL_APP_SECRET = APP_SECRET;
  resetEnvCache();
});
afterAll(() => {
  delete process.env.META_SOCIAL_APP_SECRET;
  resetEnvCache();
});

const agencyOf = (ctx: SocialOrg["owner"]) => ({ ...ctx, org: { ...ctx.org, kind: "agency" as const } });
/** The message a route handed to the accounts page in its notice cookie. */
const notice = (res: Response) => {
  const cookie = /iaq_social_notice=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
  return cookie ? decodeSocialNotice(cookie) : null;
};
const start = (qs = "platform=facebook", headers: Record<string, string> = {}) => startRoute(new NextRequest(`http://localhost:3000/api/social/oauth/meta/start?${qs}`, { headers }));

describe("starting a connection", () => {
  it("sends an agency workspace back to the accounts page with the reason, and never to Meta", async () => {
    const s = await socialOrg();
    session.ctx = agencyOf(s.owner);
    const res = await start();
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("http://localhost:3000/social/accounts");
    expect(notice(res)).toMatchObject({ kind: "error", message: expect.stringMatching(words) });
    expect(await rows("select id from social_oauth_states where org_id = $1", [s.m.org.id])).toHaveLength(0);
  });

  it("tells a client's team member who may not connect, and a deployment with no Meta app, apart", async () => {
    const s = await socialOrg();
    session.ctx = s.sales;
    expect(notice(await start())).toMatchObject({ message: expect.stringMatching(/owner or a manager/) });
    session.ctx = s.owner;
    expect(notice(await start())).toMatchObject({ message: expect.stringMatching(/not set up for this deployment yet/) });
  });

  it("ignores a sign-in that another site started", async () => {
    const s = await socialOrg();
    session.ctx = s.owner;
    expect(notice(await start("platform=facebook", { "sec-fetch-site": "cross-site" }))).toMatchObject({ message: expect.stringMatching(/didn't start from iAcquire/) });
  });
});

describe("coming back from Meta", () => {
  const back = (qs: string) => callbackRoute(new NextRequest(`http://localhost:3000/api/social/oauth/meta/callback?${qs}`));

  it("sends a signed-out visitor to sign in", async () => {
    session.user = null;
    const res = await back("state=x&code=y");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/^http:\/\/localhost:3000\/login\?next=/);
  });

  it("refuses a sign-in that this person did not start, without showing what Meta sent", async () => {
    const s = await socialOrg();
    session.user = s.owner.user;
    const res = await back("state=never-issued&code=SECRET-CODE-FROM-META");
    expect(res.headers.get("location")).toBe("http://localhost:3000/social/accounts");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(notice(res)?.message).toMatch(/expired or was not started by you/);
    expect(JSON.stringify([...res.headers.entries()])).not.toContain("SECRET-CODE-FROM-META");
  });

  it("refuses a sign-in for a workspace that is not a client's, with the same words", async () => {
    const s = await socialOrg();
    const agency = await createOrg({ kind: "agency" });
    await withSystem((db) => db.query("insert into social_oauth_states (org_id, user_id, platform, state_hash, expires_at) values ($1, $2, 'facebook', $3, now() + interval '10 minutes')", [agency.id, s.m.people.owner.id, sha256("state-route-agency")]));
    session.user = s.owner.user;
    expect(notice(await back("state=state-route-agency&code=c"))?.message).toMatch(words);
  });
});

describe("the media routes", () => {
  const upload = () => {
    const form = new FormData();
    form.set("file", new File([Buffer.from([0xff, 0xd8, 0xff, 0xc0])], "a.jpg", { type: "image/jpeg" }));
    return uploadRoute(new Request("http://localhost:3000/api/social/media", { method: "POST", body: form }));
  };

  it("refuses an upload from an agency workspace in the same words, and a preview too", async () => {
    const s = await socialOrg();
    session.ctx = agencyOf(s.owner);
    const res = await upload();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(words);
    const preview = await previewRoute(new Request("http://localhost:3000/api/social/media/x"), { params: Promise.resolve({ id: "12345678-1234-1234-1234-123456789012" }) });
    expect(preview.status).toBe(403);
    expect((await preview.json()).error).toMatch(words);
  });

  it("says a client without managed storage has none, and a viewer may not add", async () => {
    const s = await socialOrg();
    session.ctx = s.owner;
    const none = await upload();
    expect(none.status).toBe(403);
    expect((await none.json()).error).toMatch(/No media storage is available/);
    session.ctx = s.viewer;
    expect((await (await upload()).json()).error).toMatch(/can't add media/);
  });
});

describe("Meta's callbacks", () => {
  const post = (route: typeof deauthorizeRoute, raw: string, headers: Record<string, string> = {}) => route(new Request("http://localhost:3000/x", { method: "POST", body: raw, headers }));
  const signed = (userId: string, secret = APP_SECRET) => `signed_request=${signRequestForTests({ user_id: userId }, secret)}`;

  it("revokes on a correctly signed deauthorization and does nothing for a forged one", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    await withSystem((db) => db.query("update social_accounts set provider_user_id = 'fb-route-1' where id = $1", [acc.id]));
    const forged = await post(deauthorizeRoute, signed("fb-route-1", "attacker-secret-0123456789"));
    expect(forged.status).toBe(400);
    expect((await rows<{ status: string }>("select status from social_accounts where id = $1", [acc.id]))[0].status).toBe("connected");
    const ok = await post(deauthorizeRoute, signed("fb-route-1"));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, revoked: 1 });
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect((await rows<{ status: string; provider_user_id: string | null }>("select status, provider_user_id from social_accounts where id = $1", [acc.id]))[0]).toEqual({ status: "revoked", provider_user_id: null });
  });

  it("refuses an oversized body by its declared length", async () => {
    expect((await post(deauthorizeRoute, "x", { "content-length": "9000" })).status).toBe(413);
    expect((await post(dataDeletionRoute, "x", { "content-length": "9000" })).status).toBe(413);
  });

  it("answers a data deletion request with a code whose status page says what was deleted", async () => {
    const res = await post(dataDeletionRoute, signed("fb-route-2"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; confirmation_code: string };
    const status = await deletionStatusRoute(new Request(body.url));
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ status: "completed", detail: expect.stringMatching(/unfinished sign-ins/) });
    expect((await deletionStatusRoute(new Request("http://localhost:3000/x?code=nope"))).status).toBe(404);
  });
});
