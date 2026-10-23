// The Meta adapter against a REPLACED HTTP layer. Nothing here talks to Meta: the fake records exactly what would have been sent and answers as the documented
// Graph API does. These tests prove the requests are shaped the way the SDK names them and that every answer is read honestly; they do not prove Meta accepts them.
import { describe, expect, it } from "vitest";
import { createMetaProvider, type GraphCall, type GraphRequest, type GraphResponse, type MetaSettings } from "@/server/social/providers/meta";
import { parseSignedRequest, resolveSignIn, signRequestForTests, canPostTo, authorizeUrl, META_SCOPES } from "@/server/social/providers/meta-oauth";
import { ProviderError, type PublishInput } from "@/server/social/providers/types";

const SETTINGS: MetaSettings = { appId: "1234567890", appSecret: "app-secret-0123456789", version: "v26.0", writesEnabled: true };

function fake(script: Array<(req: GraphRequest) => GraphResponse | Error>) {
  const seen: GraphRequest[] = [];
  const graph: GraphCall = async (req) => {
    seen.push(req);
    const next = script.shift();
    if (!next) throw new Error(`unexpected request: ${req.method} ${req.path}`);
    const r = next(req);
    if (r instanceof Error) throw r;
    return r;
  };
  return { graph, seen };
}
const ok = (json: Record<string, unknown>): GraphResponse => ({ status: 200, json, retryAfter: null });
const err = (status: number, error: Record<string, unknown>, retryAfter: string | null = null): GraphResponse => ({ status, json: { error }, retryAfter });
const provider = (graph: GraphCall, settings: Partial<MetaSettings> = {}) => createMetaProvider({ graph, settings: () => ({ ...SETTINGS, ...settings }) });
const creds = { accessToken: "page-token-abc" };
const base = (over: Partial<PublishInput>): PublishInput => ({ platform: "facebook", externalId: "PAGE1", kind: "text", message: "Hello", linkUrl: null, media: [], idempotencyKey: "k", ...over });
const img = { kind: "image" as const, url: "https://files.example.test/a.jpg", mimeType: "image/jpeg" };

describe("Facebook Page posts", () => {
  it("prepares a text post unpublished, then publishes it with a repeatable second step", async () => {
    const { graph, seen } = fake([() => ok({ id: "PAGE1_111" }), () => ok({ success: true }), () => ok({ permalink_url: "https://facebook.com/p/111" })]);
    const p = provider(graph);
    const input = base({ message: "Spring special #hvac", linkUrl: "https://example.test/offer?utm_source=facebook" });
    expect(p.mayCreate(input, {})).toBe(false);
    const a = await p.step(creds, input, {});
    expect(a.state.objectId).toBe("PAGE1_111");
    expect(p.mayCreate(input, a.state)).toBe(true); // the second step is the one that makes it visible
    const b = await p.step(creds, input, a.state);
    expect(b.state).toMatchObject({ done: true, providerPostId: "PAGE1_111", permalink: "https://facebook.com/p/111" });
    expect(seen[0]).toMatchObject({ method: "POST", path: "PAGE1/feed", params: { message: "Spring special #hvac", link: "https://example.test/offer?utm_source=facebook", published: "false" } });
    expect(seen[1]).toMatchObject({ method: "POST", path: "PAGE1_111", params: { is_published: "true" }, sent: true });
    expect(seen[0].sent).toBe(false);
  });

  it("sends a picture and a video in one step, with the platform's own field names", async () => {
    const photo = fake([() => ok({ id: "9", post_id: "PAGE1_9" }), () => ok({ permalink_url: "https://facebook.com/p/9" })]);
    const r = await provider(photo.graph).step(creds, base({ kind: "image", message: "Look", media: [img] }), {});
    expect(r.state).toMatchObject({ done: true, providerPostId: "PAGE1_9" });
    expect(photo.seen[0]).toMatchObject({ path: "PAGE1/photos", params: { url: img.url, caption: "Look", published: "true" }, sent: true });
    const video = fake([() => ok({ id: "V1" }), () => ok({})]);
    const v = await provider(video.graph).step(creds, base({ kind: "video", message: "Tour", media: [{ kind: "video", url: "https://files.example.test/v.mp4", mimeType: "video/mp4" }] }), {});
    expect(v.state.providerPostId).toBe("V1");
    expect(video.seen[0]).toMatchObject({ path: "PAGE1/videos", params: { file_url: "https://files.example.test/v.mp4", description: "Tour", published: "true" } });
  });

  it("never puts the token in a path or a parameter", async () => {
    const { graph, seen } = fake([() => ok({ id: "X" })]);
    await provider(graph).step(creds, base({}), {});
    for (const r of seen) {
      expect(JSON.stringify({ path: r.path, params: r.params })).not.toContain(creds.accessToken);
      expect(r.token).toBe(creds.accessToken);
    }
  });

  it("refuses to post at all while the write switch is off", async () => {
    const { graph, seen } = fake([]);
    await expect(provider(graph, { writesEnabled: false }).step(creds, base({}), {})).rejects.toMatchObject({ kind: "blocked" });
    expect(seen).toHaveLength(0);
  });
});

describe("Instagram posts", () => {
  it("creates a container, waits until the platform says it is ready, then publishes it", async () => {
    const { graph, seen } = fake([() => ok({ id: "C1" }), () => ok({ status_code: "FINISHED" }), () => ok({ id: "M1" }), () => ok({ permalink: "https://instagram.com/p/M1" })]);
    const p = provider(graph);
    const input = base({ platform: "instagram", externalId: "IG1", kind: "image", message: "Hello #hvac", media: [img] });
    const a = await p.step(creds, input, {});
    expect(a.state.creationId).toBe("C1");
    expect(p.mayCreate(input, a.state)).toBe(false);
    const b = await p.step(creds, input, a.state);
    expect(b.state.ready).toBe(true);
    expect(p.mayCreate(input, b.state)).toBe(true);
    const c = await p.step(creds, input, b.state);
    expect(c.state).toMatchObject({ done: true, providerPostId: "M1" });
    expect(seen[0]).toMatchObject({ path: "IG1/media", params: { image_url: img.url, caption: "Hello #hvac" }, sent: false });
    expect(seen[1]).toMatchObject({ method: "GET", path: "C1", params: { fields: "status_code" } });
    expect(seen[2]).toMatchObject({ path: "IG1/media_publish", params: { creation_id: "C1" }, sent: true });
  });

  it("asks for a video as a Reel and waits while the platform processes it", async () => {
    const { graph, seen } = fake([() => ok({ id: "C2" }), () => ok({ status_code: "IN_PROGRESS" })]);
    const p = provider(graph);
    const input = base({ platform: "instagram", externalId: "IG1", kind: "video", message: "Tour", media: [{ kind: "video", url: "https://files.example.test/v.mp4", mimeType: "video/mp4" }] });
    const a = await p.step(creds, input, {});
    expect(seen[0].params).toMatchObject({ media_type: "REELS", video_url: "https://files.example.test/v.mp4" });
    expect(a.waitSeconds).toBe(30);
    const b = await p.step(creds, input, a.state);
    expect(b.waitSeconds).toBe(30);
    expect(b.state.ready).toBeUndefined();
  });

  it("fails a container the platform could not process, without retrying", async () => {
    const { graph } = fake([() => ok({ status_code: "ERROR" })]);
    await expect(provider(graph).step(creds, base({ platform: "instagram", externalId: "IG1", kind: "image", media: [img] }), { creationId: "C3" })).rejects.toMatchObject({ kind: "invalid_content" });
  });
});

describe("reading the platform's answers honestly", () => {
  it("reads an expired or removed sign-in as one that needs reconnecting", async () => {
    const { graph } = fake([() => err(400, { code: 190, error_subcode: 463, message: "Error validating access token" })]);
    await expect(provider(graph).step(creds, base({}), {})).rejects.toMatchObject({ kind: "auth", needsReauth: true });
  });

  it("reads a rate limit with the wait it asked for, and a refusal of the content with its reason", async () => {
    await expect(provider(fake([() => err(429, { code: 4, message: "Rate" }, "600")]).graph).step(creds, base({}), {})).rejects.toMatchObject({ kind: "rate_limited", retryAfterSec: 600 });
    await expect(provider(fake([() => err(400, { code: 100, message: "Invalid parameter" })]).graph).step(creds, base({}), {})).rejects.toMatchObject({ kind: "invalid_content" });
  });

  it("treats a server error on a step that could create the post as an unknown outcome, and on a harmless step as temporary", async () => {
    // The first request of a text post only prepares: a failure there is just a failure.
    await expect(provider(fake([() => ({ status: 503, json: null, retryAfter: null })]).graph).step(creds, base({}), {})).rejects.toMatchObject({ kind: "transient" });
    // A failed send could have gone through: the outcome is unknown.
    await expect(provider(fake([() => ({ status: 502, json: null, retryAfter: null })]).graph).step(creds, base({ kind: "image", media: [img] }), {})).rejects.toMatchObject({ kind: "unknown_outcome" });
    // No answer at all, the same.
    await expect(provider(fake([() => new Error("socket hang up")]).graph).step(creds, base({ kind: "image", media: [img] }), {})).rejects.toMatchObject({ kind: "unknown_outcome" });
    await expect(provider(fake([() => new Error("socket hang up")]).graph).step(creds, base({}), {})).rejects.toBeInstanceOf(ProviderError);
  });

  it("never treats an answer without an identifier as a success", async () => {
    await expect(provider(fake([() => ok({})]).graph).step(creds, base({ kind: "image", media: [img] }), {})).rejects.toMatchObject({ kind: "unknown_outcome" });
  });
});

describe("checking whether a post exists", () => {
  it("finds a Facebook post by the object that was prepared", async () => {
    const yes = fake([() => ok({ is_published: true, permalink_url: "https://facebook.com/p/1" })]);
    expect(await provider(yes.graph).reconcile(creds, base({}), { objectId: "PAGE1_1" }, new Date())).toEqual({ found: true, providerPostId: "PAGE1_1", permalink: "https://facebook.com/p/1" });
    const no = fake([() => ok({ is_published: false })]);
    expect((await provider(no.graph).reconcile(creds, base({}), { objectId: "PAGE1_1" }, new Date())).found).toBe(false);
  });

  it("finds a picture post by its text among the Page's recent posts", async () => {
    const since = new Date("2026-10-23T12:00:00Z");
    const { graph, seen } = fake([() => ok({ data: [{ id: "PAGE1_5", message: "Another post", created_time: "2026-10-23T12:00:30+0000" }, { id: "PAGE1_6", message: "Look at this", created_time: "2026-10-23T12:01:00+0000", permalink_url: "https://facebook.com/p/6" }] })]);
    const r = await provider(graph).reconcile(creds, base({ kind: "image", message: "Look at this" }), {}, since);
    expect(r).toMatchObject({ found: true, providerPostId: "PAGE1_6" });
    expect(seen[0]).toMatchObject({ path: "PAGE1/published_posts", params: { limit: "25" } });
    expect(Number(seen[0].params?.since)).toBeLessThanOrEqual(Math.floor(since.getTime() / 1000));
  });

  it("finds an Instagram post from a published container and the account's recent media", async () => {
    const { graph } = fake([() => ok({ status_code: "PUBLISHED" }), () => ok({ data: [{ id: "M9", caption: "Hello there", timestamp: "2026-10-23T12:01:00+0000", permalink: "https://instagram.com/p/M9" }] })]);
    const r = await provider(graph).reconcile(creds, base({ platform: "instagram", externalId: "IG1", kind: "image", message: "Hello there" }), { creationId: "C1" }, new Date("2026-10-23T12:00:00Z"));
    expect(r).toEqual({ found: true, providerPostId: "M9", permalink: "https://instagram.com/p/M9" });
  });

  it("says not found when nothing matches", async () => {
    const { graph } = fake([() => ok({ status_code: "FINISHED" }), () => ok({ data: [] })]);
    expect((await provider(graph).reconcile(creds, base({ platform: "instagram", externalId: "IG1", kind: "image" }), { creationId: "C1" }, new Date())).found).toBe(false);
  });
});

describe("connection health and metrics", () => {
  it("reads token validity, scopes and expiry, and calls a missing permission a connection that cannot publish", async () => {
    const good = fake([() => ok({ data: { is_valid: true, scopes: ["pages_manage_posts", "pages_read_engagement"], expires_at: 0, data_access_expires_at: 1_800_000_000 } })]);
    const h = await provider(good.graph).health(creds, { platform: "facebook", externalId: "PAGE1" });
    expect(h).toMatchObject({ status: "connected", expiresAt: null, capabilities: { contentTypes: ["text", "link", "image", "video"], insights: true } });
    expect(h.dataAccessExpiresAt?.toISOString()).toBe(new Date(1_800_000_000_000).toISOString());
    expect(good.seen[0]).toMatchObject({ path: "debug_token", params: { input_token: creds.accessToken }, token: "1234567890|app-secret-0123456789" });
    const missing = fake([() => ok({ data: { is_valid: true, scopes: ["pages_show_list"] } })]);
    const m = await provider(missing.graph).health(creds, { platform: "facebook", externalId: "PAGE1" });
    expect(m).toMatchObject({ status: "needs_reauth", capabilities: { contentTypes: [] } });
    expect(m.detail).toMatch(/pages_manage_posts/);
    const dead = fake([() => ok({ data: { is_valid: false } })]);
    expect((await provider(dead.graph).health(creds, { platform: "facebook", externalId: "PAGE1" })).status).toBe("needs_reauth");
  });

  it("reads Instagram's posting limit when it is given and calls it unknown when it is not", async () => {
    const known = fake([() => ok({ data: { is_valid: true, scopes: ["instagram_content_publish"] } }), () => ok({ data: [{ quota_usage: 12, config: { quota_total: 100 } }] })]);
    expect((await provider(known.graph).health(creds, { platform: "instagram", externalId: "IG1" })).quota).toEqual({ usage: 12, total: 100 });
    const unknown = fake([() => ok({ data: { is_valid: true, scopes: ["instagram_content_publish"] } }), () => err(400, { code: 100, message: "no" })]);
    expect((await provider(unknown.graph).health(creds, { platform: "instagram", externalId: "IG1" })).quota).toBeNull();
  });

  it("returns only the numbers the platform returned", async () => {
    const fb = fake([() => ok({ likes: { summary: { total_count: 7 } }, comments: { summary: { total_count: 2 } } })]);
    expect(await provider(fb.graph).metrics(creds, { platform: "facebook", externalId: "PAGE1" }, "PAGE1_1")).toEqual({ likes: 7, comments: 2 }); // no shares field: absent, not zero
    const ig = fake([() => ok({ like_count: 3 })]);
    expect(await provider(ig.graph).metrics(creds, { platform: "instagram", externalId: "IG1" }, "M1")).toEqual({ likes: 3 });
  });
});

describe("signing in and the platform's callbacks", () => {
  it("exchanges the code, upgrades the token and lists the Pages with their own tokens", async () => {
    const { graph, seen } = fake([
      () => ok({ access_token: "short" }),
      () => ok({ access_token: "long" }),
      () => ok({ id: "USER1", name: "Olivia Owner" }),
      () => ok({ data: [{ id: "P1", name: "Harbor", access_token: "ptoken", tasks: ["CREATE_CONTENT", "ANALYZE"], instagram_business_account: { id: "IG1", username: "harbor" } }, { id: "P2", name: "Other", access_token: "t2", tasks: ["ANALYZE"] }] }),
    ]);
    const id = await resolveSignIn("the-code", { graph, settings: SETTINGS });
    expect(id).toMatchObject({ userId: "USER1", userName: "Olivia Owner" });
    expect(id.pages.map((p) => [p.id, canPostTo(p), p.instagram?.id ?? null])).toEqual([["P1", true, "IG1"], ["P2", false, null]]);
    expect(seen[0]).toMatchObject({ path: "oauth/access_token", params: { code: "the-code", client_id: SETTINGS.appId } });
    expect(seen[1].params).toMatchObject({ grant_type: "fb_exchange_token", fb_exchange_token: "short" });
    expect(seen[2].token).toBe("long");
  });

  it("reports a refused code without echoing Meta's response", async () => {
    const { graph } = fake([() => err(400, { code: 100, message: "Invalid verification code format. internal-trace-xyz" })]);
    await expect(resolveSignIn("bad", { graph, settings: SETTINGS })).rejects.toMatchObject({ kind: "auth" });
    await expect(resolveSignIn("bad", { graph: fake([() => err(400, { code: 100, message: "internal-trace-xyz" })]).graph, settings: SETTINGS })).rejects.toThrow(/Start again/);
  });

  it("builds the sign-in address with the least permissions this feature needs", () => {
    const u = new URL(authorizeUrl("state-123", "instagram", SETTINGS));
    expect(u.origin + u.pathname).toBe("https://www.facebook.com/v26.0/dialog/oauth");
    expect(u.searchParams.get("state")).toBe("state-123");
    expect(u.searchParams.get("scope")?.split(",")).toEqual([...META_SCOPES.instagram]);
    expect(META_SCOPES.facebook).not.toContain("instagram_content_publish");
    expect(u.searchParams.get("client_secret")).toBeNull();
  });

  it("accepts a correctly signed callback and refuses a forged, altered or differently signed one", () => {
    const signed = signRequestForTests({ user_id: "USER1" }, SETTINGS.appSecret as string);
    expect(parseSignedRequest(signed, SETTINGS.appSecret as string)).toMatchObject({ user_id: "USER1" });
    expect(parseSignedRequest(signed, "another-secret-0123456789")).toBeNull();
    const [sig, payload] = signed.split(".");
    const forged = Buffer.from(JSON.stringify({ algorithm: "HMAC-SHA256", user_id: "VICTIM" })).toString("base64url");
    expect(parseSignedRequest(`${sig}.${forged}`, SETTINGS.appSecret as string)).toBeNull();
    expect(parseSignedRequest(`${payload}`, SETTINGS.appSecret as string)).toBeNull();
    expect(parseSignedRequest("a.b.c", SETTINGS.appSecret as string)).toBeNull();
    const wrongAlg = Buffer.from(JSON.stringify({ algorithm: "none", user_id: "X" })).toString("base64url");
    expect(parseSignedRequest(`${sig}.${wrongAlg}`, SETTINGS.appSecret as string)).toBeNull();
  });
});
