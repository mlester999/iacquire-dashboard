// What publishing achieved (only from evidence that exists) and the platform's callbacks.
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { socialOverview, syncPostMetrics } from "@/server/social/analytics";
import { deletionStatus, handleDataDeletion, handleDeauthorize } from "@/server/social/webhooks";
import { signRequestForTests } from "@/server/social/providers/meta-oauth";
import { simulated, simulatedProvider } from "@/server/social/providers/simulated";
import { connect, LATER, minutes, rows, scheduledPost, socialOrg, tick, type SocialOrg } from "./support/social";

const SECRET = "test-app-secret-0123456789";
const form = (signed: string) => new URLSearchParams({ signed_request: signed }).toString();
const WINDOW = { startsAt: new Date("2026-10-01T00:00:00Z"), endsAt: new Date("2026-12-01T00:00:00Z") };

async function publishedLink(s: SocialOrg, accountId: string, caption = "Spring special") {
  const post = await scheduledPost(s, accountId, { kind: "link", linkUrl: "https://www.example.test/offer", caption });
  await tick(s, LATER);
  return post;
}

describe("the platform's callbacks", () => {
  async function accountFor(userId: string) {
    const s = await socialOrg();
    const acc = await connect(s);
    await withSystem((db) => db.query("update social_accounts set provider_user_id = $2 where id = $1", [acc.id, userId]));
    return { s, acc };
  }

  it("revokes every account the person authorized when the platform says they removed the app", async () => {
    const { s, acc } = await accountFor("fb-77");
    const post = await scheduledPost(s, acc.id);
    const r = await handleDeauthorize(form(signRequestForTests({ user_id: "fb-77" }, SECRET)), { secret: SECRET });
    expect(r).toEqual({ status: 200, body: { ok: true, revoked: 1 } });
    expect((await rows<{ status: string; credentials: string | null }>("select status, credentials from social_accounts where id = $1", [acc.id]))[0]).toMatchObject({ status: "revoked", credentials: null });
    expect((await rows<{ status: string }>("select status from social_posts where id = $1", [post.id]))[0].status).toBe("failed");
    expect((await tick(s, LATER)).claimed).toBe(0);
  });

  it("does nothing for a forged, unsigned or differently signed request", async () => {
    const { s, acc } = await accountFor("fb-78");
    const forged = signRequestForTests({ user_id: "fb-78" }, "attacker-secret-0123456789");
    expect((await handleDeauthorize(form(forged), { secret: SECRET })).status).toBe(400);
    expect((await handleDeauthorize("signed_request=", { secret: SECRET })).status).toBe(400);
    expect((await handleDeauthorize("nothing=here", { secret: SECRET })).status).toBe(400);
    expect((await handleDeauthorize(form(signRequestForTests({}, SECRET)), { secret: SECRET })).status).toBe(400); // no user
    expect((await rows<{ status: string }>("select status from social_accounts where id = $1", [acc.id]))[0].status).toBe("connected");
    void s;
  });

  it("answers an unknown person without revealing anything", async () => {
    await socialOrg();
    expect(await handleDeauthorize(form(signRequestForTests({ user_id: "nobody" }, SECRET)), { secret: SECRET })).toEqual({ status: 200, body: { ok: true, revoked: 0 } });
  });

  it("is not configured without the app's secret", async () => {
    expect((await handleDeauthorize(form(signRequestForTests({ user_id: "x" }, SECRET)))).status).toBe(503);
  });

  it("answers a data deletion request with a confirmation code whose status can be read", async () => {
    const { acc } = await accountFor("fb-79");
    const r = await handleDataDeletion(form(signRequestForTests({ user_id: "fb-79" }, SECRET)), { secret: SECRET });
    expect(r.status).toBe(200);
    const code = r.body.confirmation_code as string;
    expect(code).toMatch(/^[0-9a-f]{24}$/);
    expect(String(r.body.url)).toContain(`data-deletion-status?code=${code}`);
    expect((await rows<{ status: string; credentials: string | null }>("select status, credentials from social_accounts where id = $1", [acc.id]))[0]).toMatchObject({ status: "revoked", credentials: null });
    expect((await deletionStatus(code)).status).toBe(200);
    expect((await deletionStatus("0".repeat(24))).status).toBe(404);
    expect((await deletionStatus("../etc")).status).toBe(404);
    expect((await deletionStatus(null)).status).toBe(404);
  });

  it("refuses an oversized body", async () => {
    expect((await handleDeauthorize("a".repeat(9000), { secret: SECRET })).status).toBe(413);
  });
});

describe("engagement: only what the platform returned", () => {
  it("stores the numbers it returned, and nothing for a post it returned nothing for", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const one = await publishedLink(s, acc.id, "One");
    const two = await scheduledPost(s, acc.id, { caption: "Two" }, minutes(LATER, 5));
    await tick(s, minutes(LATER, 6));
    const providerId = (id: string) => rows<{ provider_post_id: string }>("select provider_post_id from social_posts where id = $1", [id]).then((r) => r[0].provider_post_id);
    simulated.setMetrics(await providerId(one.id), { likes: 12, comments: 3 }); // no shares field: absent
    expect(await syncPostMetrics({ now: minutes(LATER, 60), provider: () => simulatedProvider, orgId: s.m.org.id })).toBe(1);
    const o = await socialOverview(s.viewer, WINDOW);
    expect(o.counts.published).toBe(2);
    expect(o.engagement).toMatchObject({ totals: { likes: 12, comments: 3 }, postsWithData: 1, publishedPosts: 2 });
    expect(o.engagement.totals).not.toHaveProperty("shares"); // absent, not zero
    expect(o.posts.find((p) => p.postId === two.id)?.metrics).toBeNull();
    expect(o.posts.find((p) => p.postId === one.id)?.metrics).toEqual({ likes: 12, comments: 3 });
    expect(o.notes.join(" ")).toMatch(/not the same as zero/);
  });

  it("does not look again within a few hours, and reads fresh numbers later", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const post = await publishedLink(s, acc.id);
    const pid = (await rows<{ provider_post_id: string }>("select provider_post_id from social_posts where id = $1", [post.id]))[0].provider_post_id;
    simulated.setMetrics(pid, { likes: 1 });
    expect(await syncPostMetrics({ now: minutes(LATER, 60), provider: () => simulatedProvider, orgId: s.m.org.id })).toBe(1);
    simulated.setMetrics(pid, { likes: 5 });
    expect(await syncPostMetrics({ now: minutes(LATER, 120), provider: () => simulatedProvider, orgId: s.m.org.id })).toBe(0);
    expect(await syncPostMetrics({ now: minutes(LATER, 60 * 8), provider: () => simulatedProvider, orgId: s.m.org.id })).toBe(1);
    expect((await socialOverview(s.viewer, WINDOW)).engagement.totals).toEqual({ likes: 5 });
  });

  it("skips accounts that are not connected and posts a person confirmed by hand", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const post = await publishedLink(s, acc.id);
    await withSystem((db) => db.query("update social_accounts set status = 'needs_reauth' where id = $1", [acc.id]));
    expect(await syncPostMetrics({ now: minutes(LATER, 60), provider: () => simulatedProvider, orgId: s.m.org.id })).toBe(0);
    await withSystem(async (db) => {
      await db.query("update social_accounts set status = 'connected' where id = $1", [acc.id]);
      await db.query("update social_posts set provider_post_id = 'manual:x' where id = $1", [post.id]);
    });
    expect(await syncPostMetrics({ now: minutes(LATER, 60), provider: () => simulatedProvider, orgId: s.m.org.id })).toBe(0);
  });
});

describe("leads tied to a post, only by evidence", () => {
  async function contactWithTouch(s: SocialOrg, code: string | null, over: { status?: string; source?: string } = {}) {
    const c = (await rows<{ id: string }>("insert into contacts (org_id, display_name, lead_status) values ($1, 'Lead', $2) returning id", [s.m.org.id, over.status ?? "new"]))[0].id;
    await rows("insert into lead_touches (org_id, contact_id, kind, source, medium, content, confidence, evidence, ref_type, ref_id) values ($1, $2, 'website_form', $3, 'social', $4, 'known', 'utm', 'website_submission', $5)", [s.m.org.id, c, over.source ?? "facebook", code, `ref-${Math.random()}`]);
    return c;
  }

  it("counts contacts whose own recorded visit carried the post's code, and what became of them", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const post = await publishedLink(s, acc.id);
    const code = (await rows<{ tracking_code: string }>("select tracking_code from social_posts where id = $1", [post.id]))[0].tracking_code;
    await contactWithTouch(s, code);
    await contactWithTouch(s, code, { status: "qualified" });
    await contactWithTouch(s, "zzzzzzzz"); // another post's code: not this one
    await contactWithTouch(s, null, { source: "facebook" }); // facebook, but no code: not claimed by any post
    const o = await socialOverview(s.viewer, WINDOW);
    expect(o.posts[0]).toMatchObject({ postId: post.id, leads: 2, qualified: 1 });
    expect(o.leads).toMatchObject({ total: 2, qualified: 1 });
    expect(o.notes.join(" ")).toMatch(/never counted as sales/);
  });

  it("counts a lead against its post once however many touches it made, and never across workspaces", async () => {
    const a = await socialOrg();
    const b = await socialOrg();
    const acc = await connect(a);
    const post = await publishedLink(a, acc.id);
    const code = (await rows<{ tracking_code: string }>("select tracking_code from social_posts where id = $1", [post.id]))[0].tracking_code;
    const c = await contactWithTouch(a, code);
    await rows("insert into lead_touches (org_id, contact_id, kind, source, medium, content, confidence, evidence, ref_type, ref_id) values ($1, $2, 'website_chat', 'facebook', 'social', $3, 'known', 'utm', 'web_chat_session', 'again')", [a.m.org.id, c, code]);
    await contactWithTouch(b, code); // another workspace using the same code: invisible here
    expect((await socialOverview(a.viewer, WINDOW)).posts[0].leads).toBe(1);
    expect((await socialOverview(b.viewer, WINDOW)).posts).toEqual([]);
  });

  it("refuses to show it to a role that cannot see social media, and rejects an inverted period", async () => {
    const s = await socialOrg();
    await expect(socialOverview({ ...s.viewer, can: () => false } as never, WINDOW)).rejects.toThrow(/can't see social media/);
    await expect(socialOverview(s.viewer, { startsAt: WINDOW.endsAt, endsAt: WINDOW.startsAt })).rejects.toThrow(/must end after/);
  });
});
