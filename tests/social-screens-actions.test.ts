// The server actions behind the social media screens, on embedded Postgres: who they refuse (an agency workspace), what they check before the server does
// (a pasted link, the hashtag cap, a missing time) and how they hand a message to the accounts page (a cookie, never the address). The signed-in workspace is
// replaced by a fixture's context; nothing else is mocked except the framework's cache and cookie store.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SOCIAL_CLIENT_ONLY_MESSAGE } from "@/lib/social/workspace";
import { MAX_HASHTAGS } from "@/lib/social/limits";
import { LINK_NOT_HTTPS } from "@/lib/social/links";
import { decodeSocialNotice, SOCIAL_NOTICE_COOKIE } from "@/server/social/notice";
import { createPost } from "@/server/social/posts";
import { approvedPost, connect, rows, scheduledPost, socialOrg, textPost, type SocialOrg } from "./support/social";

const mocks = vi.hoisted(() => ({
  ctx: null as unknown,
  jar: new Map<string, { value: string; options: Record<string, unknown> }>(),
  connectChosenPages: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    set: (name: string, value: string, options: Record<string, unknown> = {}) => { mocks.jar.set(name, { value, options }); },
    get: (name: string) => (mocks.jar.has(name) ? { name, value: mocks.jar.get(name)!.value } : undefined),
  }),
}));
vi.mock("@/server/tenancy/context", async (original) => ({ ...(await original<typeof import("@/server/tenancy/context")>()), requireOrgContextOrThrow: async () => mocks.ctx }));
vi.mock("@/server/social/accounts", async (original) => ({ ...(await original<typeof import("@/server/social/accounts")>()), connectChosenPages: mocks.connectChosenPages }));

import { connectChosenAction, createPostAction, decideAction, resolveUnknownAction, scheduleAction, suggestIdeasAction } from "@/app/actions/social";

const asClient = (s: SocialOrg) => { mocks.ctx = s.owner; };
const asAgency = (s: SocialOrg) => { mocks.ctx = { ...s.owner, org: { ...s.owner.org, kind: "agency" } }; };

beforeEach(() => {
  mocks.jar.clear();
  mocks.connectChosenPages.mockReset();
});

describe("social media in an agency workspace (#26)", () => {
  it("refuses every action with the same wording the page shows, and changes nothing", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    asAgency(s);
    const draft = await createPostAction(textPost(acc.id));
    expect(draft).toEqual({ ok: false, error: SOCIAL_CLIENT_ONLY_MESSAGE, code: "forbidden" });
    const id = "3f2a9c1e-5b7d-4c80-9a12-0d4e6f8a1b23";
    for (const result of [
      await decideAction(id, { decision: "approve", version: 1 }),
      await scheduleAction(id, { asap: true }),
      await suggestIdeasAction({ accountId: acc.id }),
      await connectChosenAction(id, [{ pageId: "1" }]),
    ]) expect(result).toEqual({ ok: false, error: SOCIAL_CLIENT_ONLY_MESSAGE, code: "forbidden" });
    expect(mocks.connectChosenPages).not.toHaveBeenCalled();
    expect(await rows("select id from social_posts where org_id = $1", [s.m.org.id])).toHaveLength(0);
  });

  it("works as before in a client workspace", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    asClient(s);
    const made = await createPostAction(textPost(acc.id));
    expect(made.ok).toBe(true);
    expect(await rows("select id from social_posts where org_id = $1", [s.m.org.id])).toHaveLength(1);
  });
});

describe("what the actions check before the server does", () => {
  it("says what is missing instead of 'something went wrong' when no time is chosen", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    asClient(s);
    const post = await approvedPost(s, acc.id);
    expect(await scheduleAction(post.id, {})).toEqual({ ok: false, error: "Choose a date and time.", code: "invalid_input" });
  });

  it("refuses more hashtags than the server keeps, in words (#66)", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    asClient(s);
    const tags = Array.from({ length: MAX_HASHTAGS + 1 }, (_, i) => `tag${i}`);
    expect(await createPostAction({ ...textPost(acc.id), hashtags: tags })).toEqual({ ok: false, error: `A post can carry at most ${MAX_HASHTAGS} hashtags.`, code: "invalid_input" });
    const fine = await createPostAction({ ...textPost(acc.id), hashtags: tags.slice(0, MAX_HASHTAGS) });
    expect(fine.ok).toBe(true);
  });

  it("uses the number the server keeps, so the composer never offers more than is saved (#66)", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const tags = Array.from({ length: MAX_HASHTAGS + 1 }, (_, i) => `tag${i}`);
    await expect(createPost(s.owner, { ...textPost(acc.id), hashtags: tags })).rejects.toThrow(new RegExp(`at most ${MAX_HASHTAGS} hashtags`));
    expect((await createPost(s.owner, { ...textPost(acc.id), hashtags: tags.slice(0, MAX_HASHTAGS) })).hashtags).toHaveLength(MAX_HASHTAGS);
  });
});

describe("the link a person pastes for a post they found on the Page (#59)", () => {
  async function unresolved(s: SocialOrg, accountId: string) {
    const post = await scheduledPost(s, accountId);
    await rows("update social_posts set status = 'needs_reconciliation' where id = $1", [post.id]);
    return post;
  }

  it("refuses anything that is not a full https address, and leaves the post waiting", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    asClient(s);
    const post = await unresolved(s, acc.id);
    for (const bad of ["facebook.com/page/posts/123", "http://facebook.com/page/posts/123", "javascript:alert(1)", "data:text/html,x"]) {
      expect(await resolveUnknownAction(post.id, "posted", bad)).toEqual({ ok: false, error: LINK_NOT_HTTPS, code: "invalid_input" });
    }
    expect((await rows<{ status: string }>("select status from social_posts where id = $1", [post.id]))[0].status).toBe("needs_reconciliation");
  });

  it("stores a proper https link in its normal form, and no link when none was given", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    asClient(s);
    const withLink = await unresolved(s, acc.id);
    expect((await resolveUnknownAction(withLink.id, "posted", "  https://www.facebook.com/harborhome/posts/123  ")).ok).toBe(true);
    const a = (await rows<{ status: string; permalink: string | null; provider_post_id: string }>("select status, permalink, provider_post_id from social_posts where id = $1", [withLink.id]))[0];
    expect(a).toMatchObject({ status: "published", permalink: "https://www.facebook.com/harborhome/posts/123" });
    expect(a.provider_post_id.startsWith("manual:")).toBe(true);

    const without = await unresolved(s, acc.id);
    expect((await resolveUnknownAction(without.id, "posted", "   ")).ok).toBe(true);
    expect((await rows<{ permalink: string | null }>("select permalink from social_posts where id = $1", [without.id]))[0].permalink).toBeNull();
  });
});

describe("Pages that could not be connected are told through the notice cookie (#52)", () => {
  const stateId = "3f2a9c1e-5b7d-4c80-9a12-0d4e6f8a1b23";

  it("sets an httpOnly-style notice with the reasons, and carries nothing in the result for the address", async () => {
    const s = await socialOrg();
    asClient(s);
    mocks.connectChosenPages.mockResolvedValue({ connected: [{ id: "a" }], skipped: [{ name: "Harbor Home", reason: "Your role on this Page does not let you publish to it." }] });
    const result = await connectChosenAction(stateId, [{ pageId: "1" }, { pageId: "2" }]);
    expect(result.ok).toBe(true);
    const cookie = mocks.jar.get(SOCIAL_NOTICE_COOKIE)!;
    expect(cookie.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/social" });
    expect(decodeSocialNotice(cookie.value)).toEqual({ kind: "error", message: "Connected 1 account. Not connected: Harbor Home: Your role on this Page does not let you publish to it." });
  });

  it("clears an older notice when everything connected", async () => {
    const s = await socialOrg();
    asClient(s);
    mocks.jar.set(SOCIAL_NOTICE_COOKIE, { value: "old", options: {} });
    mocks.connectChosenPages.mockResolvedValue({ connected: [{ id: "a" }], skipped: [] });
    expect((await connectChosenAction(stateId, [{ pageId: "1" }])).ok).toBe(true);
    const cookie = mocks.jar.get(SOCIAL_NOTICE_COOKIE)!;
    expect(cookie.value).toBe("");
    expect(cookie.options).toMatchObject({ maxAge: 0 });
  });
});
