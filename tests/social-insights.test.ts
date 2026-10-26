// What publishing achieved (only from evidence that exists) and the platform's callbacks.
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { socialOverview, syncPostMetrics } from "@/server/social/analytics";
import { deletionStatus, handleDataDeletion, handleDeauthorize } from "@/server/social/webhooks";
import { signRequestForTests } from "@/server/social/providers/meta-oauth";
import { simulated, simulatedProvider } from "@/server/social/providers/simulated";
import { ProviderError } from "@/server/social/providers/types";
import { connect, LATER, minutes, rows, scheduledPost, socialOrg, tick, type SocialOrg } from "./support/social";
import { bookAppointment, DAY, daysAgo, leadWith, newCode, seedPublished, seedTracked, touch } from "./support/social-analytics";

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

// Posts written straight into the tables (see support/social-analytics.ts), so the window is relative to the real clock.
const RECENT = () => ({ startsAt: new Date(Date.now() - 120 * DAY), endsAt: new Date(Date.now() + DAY) });
const providerIdOf = (postId: string) => rows<{ provider_post_id: string }>("select provider_post_id from social_posts where id = $1", [postId]).then((r) => r[0].provider_post_id);
const readsOf = (postId: string) => rows<{ metrics: Record<string, number> }>("select metrics from social_post_metrics where post_id = $1 order by id", [postId]);

describe("a post that cannot be measured is not a post that brought nothing", () => {
  it("shows a post with no link, a link without tracking, and an Instagram post as not tracked, and ignores a code that could not have been in a clickable link", async () => {
    const s = await socialOrg();
    const fb = await connect(s);
    const ig = await connect(s, "instagram", "Harbor Instagram");
    const textOnly = await seedPublished(s, fb.id, { publishedAt: daysAgo(2) });
    const linkNoCode = await seedPublished(s, fb.id, { kind: "link", linkUrl: "https://www.client-site.test/a", publishedAt: daysAgo(3) });
    const instagramCode = newCode();
    const instagram = await seedPublished(s, ig.id, { kind: "image", linkUrl: "https://www.client-site.test/b", trackingCode: instagramCode, publishedAt: daysAgo(4) });
    const tracked = await seedTracked(s, fb.id, { publishedAt: daysAgo(5) });
    await leadWith(s, instagramCode); // a visit that somehow carried the Instagram post's code is still not claimed: the link never rode with that post
    await leadWith(s, tracked.code);
    const o = await socialOverview(s.viewer, RECENT());
    const by = (id: string) => o.posts.find((p) => p.postId === id)!;
    expect([textOnly, linkNoCode, instagram, tracked.id].map((id) => by(id).tracked)).toEqual([false, false, false, true]);
    expect(by(tracked.id)).toMatchObject({ leads: 1 });
    expect(by(instagram)).toMatchObject({ tracked: false, leads: 0 }); // 0 here is "not measured", and the page says so
    expect(o.leads).toMatchObject({ total: 1, trackedPosts: 1 });
  });

  it("says no post is tracked when none is, instead of presenting zero leads", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    await seedPublished(s, acc.id, { publishedAt: daysAgo(1) });
    const o = await socialOverview(s.viewer, RECENT());
    expect(o.leads).toMatchObject({ total: 0, trackedPosts: 0 });
    expect(o.campaigns).toEqual([expect.objectContaining({ name: "No campaign", posts: 1, trackedPosts: 0, tracked: false })]);
  });
});

describe("each contact is counted once", () => {
  it("counts a contact who came through two posts once in the totals and once in each post", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const a = await seedTracked(s, acc.id, { publishedAt: daysAgo(3) });
    const b = await seedTracked(s, acc.id, { publishedAt: daysAgo(2) });
    const both = await leadWith(s, a.code, { status: "qualified", visitAt: new Date(Date.now() - 120_000) });
    await touch(s, both, b.code, new Date(Date.now() - 60_000));
    await leadWith(s, b.code);
    const o = await socialOverview(s.viewer, RECENT());
    expect(o.posts.find((p) => p.postId === a.id)).toMatchObject({ leads: 1, qualified: 1 });
    expect(o.posts.find((p) => p.postId === b.id)).toMatchObject({ leads: 2, qualified: 1 });
    expect(o.leads).toMatchObject({ total: 2, qualified: 1 }); // two people, not the three the rows add up to
  });

  it("leaves out a contact that was deleted or merged away", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const a = await seedTracked(s, acc.id, { publishedAt: daysAgo(2) });
    await leadWith(s, a.code);
    const gone = await leadWith(s, a.code);
    await rows("update contacts set deleted_at = now() where id = $1", [gone]);
    const o = await socialOverview(s.viewer, RECENT());
    expect(o.posts[0]).toMatchObject({ leads: 1 });
    expect(o.leads.total).toBe(1);
  });

  it("covers every post of the period in the totals, and says when the table lists only the most recent", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const old = await seedTracked(s, acc.id, { publishedAt: daysAgo(100) });
    await leadWith(s, old.code);
    for (let i = 0; i < 200; i += 1) await seedPublished(s, acc.id, { publishedAt: new Date(Date.now() - (i + 1) * 3_600_000) });
    const o = await socialOverview(s.viewer, RECENT());
    expect(o.posts).toHaveLength(200);
    expect(o.counts.published).toBe(201);
    expect(o.postsTruncated).toBe(true);
    expect(o.posts.some((p) => p.postId === old.id)).toBe(false); // the oldest post is not listed, but its lead is in the total
    expect(o.leads.total).toBe(1);
  }, 60000);
});

describe("campaigns", () => {
  const campaign = (s: SocialOrg, name: string) => rows<{ id: string }>("insert into social_campaigns (org_id, name, utm_campaign) values ($1, $2, $3) returning id", [s.m.org.id, name, name.toLowerCase().replace(/\W+/g, "-")]).then((r) => r[0].id);

  it("rolls posts and the leads of their tracking codes up by campaign, with each contact counted once per campaign", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const spring = await campaign(s, "Spring tune-up");
    const brand = await campaign(s, "Brand awareness");
    const a1 = await seedTracked(s, acc.id, { publishedAt: daysAgo(4), campaignId: spring });
    const a2 = await seedTracked(s, acc.id, { publishedAt: daysAgo(3), campaignId: spring });
    await seedPublished(s, acc.id, { publishedAt: daysAgo(2), campaignId: brand }); // no link: cannot be measured
    const loose = await seedTracked(s, acc.id, { publishedAt: daysAgo(1) });
    const pat = await leadWith(s, a1.code, { status: "qualified", visitAt: new Date(Date.now() - 120_000) });
    await touch(s, pat, a2.code, new Date(Date.now() - 60_000)); // the same person through the campaign's second post
    await bookAppointment(s, pat, new Date());
    await leadWith(s, a2.code);
    await leadWith(s, loose.code);
    const o = await socialOverview(s.viewer, RECENT());
    expect(o.campaigns.map((c) => c.name)).toEqual(["Spring tune-up", "Brand awareness", "No campaign"]);
    expect(o.campaigns[0]).toMatchObject({ posts: 2, trackedPosts: 2, tracked: true, leads: 2, qualified: 1, appointments: 1 });
    expect(o.campaigns[1]).toMatchObject({ posts: 1, trackedPosts: 0, tracked: false, leads: 0 });
    expect(o.campaigns[2]).toMatchObject({ campaignId: null, posts: 1, tracked: true, leads: 1 });
    expect(o.posts.find((p) => p.postId === a1.id)?.campaignName).toBe("Spring tune-up");
  });

  it("does not show another workspace's campaigns or leads", async () => {
    const a = await socialOrg();
    const b = await socialOrg();
    const acc = await connect(a);
    const mine = await seedTracked(a, acc.id, { publishedAt: daysAgo(1), campaignId: await campaign(a, "Mine") });
    await leadWith(b, mine.code);
    const o = await socialOverview(a.viewer, RECENT());
    expect(o.campaigns).toEqual([expect.objectContaining({ name: "Mine", leads: 0 })]);
    expect((await socialOverview(b.viewer, RECENT())).campaigns).toEqual([]);
  });
});

describe("when the numbers are from", () => {
  it("marks numbers as current, older than a day, or past the window in which they are read", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const fresh = await seedPublished(s, acc.id, { publishedAt: daysAgo(1), metrics: { likes: 4 } });
    const aging = await seedPublished(s, acc.id, { publishedAt: daysAgo(10), metrics: { likes: 7 } });
    const old = await seedPublished(s, acc.id, { publishedAt: daysAgo(60), metrics: { likes: 9 } });
    const never = await seedPublished(s, acc.id, { publishedAt: daysAgo(2) });
    // Each seeded post was read an hour after it went out. "Now" is two hours after the newest.
    const now = new Date(daysAgo(1).getTime() + 2 * 3_600_000);
    const o = await socialOverview(s.viewer, RECENT(), { now });
    const by = (id: string) => o.posts.find((p) => p.postId === id)!;
    expect(by(fresh)).toMatchObject({ metricsState: "current", metrics: { likes: 4 } });
    expect(by(aging).metricsState).toBe("stale");
    expect(by(old)).toMatchObject({ metricsState: "frozen", metrics: { likes: 9 } });
    expect(by(old).metricsAt).not.toBeNull();
    expect(by(never)).toMatchObject({ metricsState: null, metrics: null, metricsAt: null });
    expect(o.engagement.outdatedPosts).toBe(2);
  });

  it("keeps showing earlier numbers when a later read found nothing", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const id = await seedPublished(s, acc.id, { publishedAt: daysAgo(2), metrics: { likes: 3, comments: 1 } });
    await rows("insert into social_post_metrics (org_id, post_id, fetched_at, metrics, source) values ($1, $2, now(), '{}'::jsonb, 'simulated')", [s.m.org.id, id]);
    const o = await socialOverview(s.viewer, RECENT());
    expect(o.posts[0]).toMatchObject({ metrics: { likes: 3, comments: 1 } });
    expect(o.engagement.postsWithData).toBe(1);
  });
});

describe("reading the platform's numbers fairly", () => {
  const sync = (over: Parameters<typeof syncPostMetrics>[0] = {}) => syncPostMetrics({ provider: () => simulatedProvider, ...over });
  const hours = (n: number) => new Date(Date.now() + n * 3_600_000);

  it("reads the post whose latest read is oldest first, and a post never read before any other", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const posts = [await seedPublished(s, acc.id, { publishedAt: daysAgo(5) }), await seedPublished(s, acc.id, { publishedAt: daysAgo(4) }), await seedPublished(s, acc.id, { publishedAt: daysAgo(3) })];
    for (const [i, id] of posts.entries()) simulated.setMetrics(await providerIdOf(id), { likes: i + 1 });
    const order: string[] = [];
    for (let pass = 0; pass < 4; pass += 1) {
      const before = await Promise.all(posts.map(async (id) => (await readsOf(id)).length));
      expect(await sync({ orgId: s.m.org.id, limit: 1, now: hours(pass * 7) })).toBe(1);
      const after = await Promise.all(posts.map(async (id) => (await readsOf(id)).length));
      order.push(String(after.findIndex((n, i) => n > before[i])));
    }
    // Newest first among the never-read, then the one read longest ago, instead of the same newest post every time.
    expect(order).toEqual(["2", "1", "0", "2"]);
  });

  it("takes one workspace's turn after another's, so a busy workspace does not starve a quiet one", async () => {
    const busy = await socialOrg();
    const quiet = await socialOrg();
    await rows("update social_accounts set status = 'needs_reauth' where org_id not in ($1, $2)", [busy.m.org.id, quiet.m.org.id]);
    const busyAcc = await connect(busy);
    const quietAcc = await connect(quiet);
    const ids: string[] = [];
    for (const [i, d] of [1, 2, 3].entries()) ids.push(await seedPublished(busy, busyAcc.id, { publishedAt: daysAgo(d), caption: `busy ${i}` }));
    const lone = await seedPublished(quiet, quietAcc.id, { publishedAt: daysAgo(10) });
    for (const id of [...ids, lone]) simulated.setMetrics(await providerIdOf(id), { likes: 1 });
    expect(await sync({ limit: 2 })).toBe(2);
    const read = async (orgId: string) => Number((await rows<{ n: string }>("select count(*)::text as n from social_post_metrics where org_id = $1", [orgId]))[0].n);
    expect(await read(busy.m.org.id)).toBe(1);
    expect(await read(quiet.m.org.id)).toBe(1); // the older post of the quiet workspace is read in the same pass
  });

  it("stops when its time budget is spent and leaves the rest for the next pass", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const ids: string[] = [];
    for (const d of [3, 2, 1]) ids.push(await seedPublished(s, acc.id, { publishedAt: daysAgo(d) }));
    for (const id of ids) simulated.setMetrics(await providerIdOf(id), { likes: 2 });
    const slow = { ...simulatedProvider, metrics: async (...a: Parameters<typeof simulatedProvider.metrics>) => { await new Promise((r) => setTimeout(r, 40)); return simulatedProvider.metrics(...a); } };
    expect(await syncPostMetrics({ provider: () => slow, orgId: s.m.org.id, budgetMs: 10 })).toBe(1);
    expect(await syncPostMetrics({ provider: () => slow, orgId: s.m.org.id })).toBe(2); // the two it did not reach, not the one it already read
  });

  it("moves a post the platform returns nothing for (or could not be read) to the back, without hiding earlier numbers", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const quiet = await seedPublished(s, acc.id, { publishedAt: daysAgo(2), metrics: { likes: 5 } });
    const broken = await seedPublished(s, acc.id, { publishedAt: daysAgo(1) });
    simulated.setMetrics(await providerIdOf(quiet), {}); // the platform now returns nothing
    simulated.failNext("metrics", new ProviderError("transient", "The platform was busy."));
    const calls = simulated.calls("metrics");
    expect(await sync({ orgId: s.m.org.id, now: hours(0) })).toBe(0);
    expect(simulated.calls("metrics") - calls).toBe(2);
    expect((await readsOf(quiet)).map((r) => Object.keys(r.metrics).length)).toEqual([1, 0]);
    expect((await readsOf(broken)).map((r) => Object.keys(r.metrics).length)).toEqual([0]);
    // Neither is asked again within the hours it takes to be due, so they cannot keep crowding out posts that have numbers.
    expect(await sync({ orgId: s.m.org.id, now: hours(2) })).toBe(0);
    expect(simulated.calls("metrics") - calls).toBe(2);
    const o = await socialOverview(s.viewer, RECENT());
    expect(o.posts.find((p) => p.postId === quiet)).toMatchObject({ metrics: { likes: 5 } });
    expect(o.posts.find((p) => p.postId === broken)).toMatchObject({ metrics: null });
  });

  it("does not read for a workspace that is suspended or paused, or a post whose id is not a readable one", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const post = await seedPublished(s, acc.id, { publishedAt: daysAgo(1) });
    simulated.setMetrics(await providerIdOf(post), { likes: 1 });
    await rows("update organizations set status = 'suspended' where id = $1", [s.m.org.id]);
    const calls = simulated.calls("metrics");
    expect(await sync({ orgId: s.m.org.id })).toBe(0);
    await rows("update organizations set status = 'active' where id = $1", [s.m.org.id]);
    await rows("insert into automation_pauses (org_id, scope, active, reason) values ($1, 'outbound', true, 'Paused for a test')", [s.m.org.id]);
    expect(await sync({ orgId: s.m.org.id })).toBe(0);
    await rows("update automation_pauses set active = false where org_id = $1", [s.m.org.id]);
    await rows("update social_posts set provider_post_id = 'container:abc' where id = $1", [post]);
    expect(await sync({ orgId: s.m.org.id })).toBe(0);
    expect(simulated.calls("metrics")).toBe(calls);
    await rows("update social_posts set provider_post_id = 'real_1' where id = $1", [post]);
    simulated.setMetrics("real_1", { likes: 2 });
    expect(await sync({ orgId: s.m.org.id })).toBe(1);
  });
});
