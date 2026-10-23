// What the Performance Analyst may say about social media, and when it must stay quiet. Posts and their numbers are written straight into the tables; the checks
// are run the way the review job runs them (read-only, for one workspace).
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import type { WorkJobRow } from "@/server/workforce/jobs";
import { accountsNeedAttention, approvalBacklog, campaignPerformance, engagementAdvice, engagementChange, failedPosts, leadsFromPosts, metrics, quietAccounts } from "@/server/workforce/social-review";
import { connect, rows, socialOrg, type SocialOrg } from "./support/social";
import { bookAppointment, daysAgo, leadWith, seedPublished, seedTracked } from "./support/social-analytics";

const job = (s: SocialOrg) => ({ org_id: s.m.org.id }) as unknown as WorkJobRow;
const run = <T>(s: SocialOrg, check: (db: Parameters<typeof failedPosts>[0], job: WorkJobRow) => Promise<T>) => withSystem((db) => check(db, job(s)));
const utc = (s: SocialOrg) => rows("update organizations set timezone = 'UTC' where id = $1", [s.m.org.id]);

/** Ten text/image posts on one account at the same hour on ten different days, so only the post type can differ. */
type Seed = { kind: "text" | "image"; metrics: Record<string, number> };
async function tenPosts(s: SocialOrg, accountId: string, numbers: (i: number) => Seed) {
  for (let i = 1; i <= 10; i += 1) {
    const { kind, metrics: m } = numbers(i);
    await seedPublished(s, accountId, { publishedAt: daysAgo(i, 10), kind, metrics: m });
  }
}

describe("failed posts", () => {
  it("counts posts that failed or could not be confirmed, and links to a view that shows both", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    await rows(
      `insert into social_posts (org_id, account_id, kind, caption, status, scheduled_at, approved_version, version) values ($1, $2, 'text', 'Unconfirmed', 'needs_reconciliation', now(), 1, 1)`,
      [s.m.org.id, acc.id],
    );
    const f = await run(s, failedPosts);
    expect(f).toMatchObject({ key: "social_posts_failed", count: 1 });
    expect(f?.title).toMatch(/failed or could not be confirmed/);
    expect(f?.evidenceHref).toBe("/social?view=list&status=failed,needs_reconciliation");
  });
});

describe("the older checks stay as they were", () => {
  it("say nothing for a workspace with nothing to report", async () => {
    const s = await socialOrg();
    for (const check of [failedPosts, approvalBacklog, accountsNeedAttention, quietAccounts]) expect(await run(s, check)).toBeNull();
  });
});

describe("engagement advice", () => {
  it("does not read a number the platform did not return as zero", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    await utc(s);
    // Instagram hides likes: only comments come back, so nothing here can be averaged as if the likes were 0.
    await tenPosts(s, acc.id, (i) => ({ kind: i % 2 ? "image" : "text", metrics: { comments: i % 2 ? 9 : 1 } }));
    const f = await run(s, engagementAdvice);
    expect(f).toMatchObject({ key: "social_not_enough_data", count: 10 });
    expect(f?.title).toMatch(/not both likes and comments/);
    expect(f?.detail).toMatch(/10 other posts were left out because the platform did not return both likes and comments/);
    expect(`${f?.title} ${f?.detail}`).not.toMatch(/averaged|better/i);
  });

  it("leaves the left-out posts out of the count that decides whether there is enough to say anything", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    await utc(s);
    await tenPosts(s, acc.id, (i): Seed => (i <= 6 ? { kind: "text", metrics: { likes: 3, comments: 1 } } : { kind: "image", metrics: { comments: 5 } }));
    const f = await run(s, engagementAdvice);
    expect(f).toMatchObject({ key: "social_not_enough_data", count: 6 });
    expect(f?.title).toMatch(/Only 6 recent posts on one account/);
    expect(f?.detail).toMatch(/4 other posts were left out/);
  });

  it("does not claim a difference when the averages are the same", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    await utc(s);
    await tenPosts(s, acc.id, (i) => ({ kind: i % 2 ? "image" : "text", metrics: { likes: 3, comments: 1 } }));
    const f = await run(s, engagementAdvice);
    expect(f).toMatchObject({ key: "social_engagement_similar" });
    expect(f?.title).toMatch(/looks similar/);
    expect(`${f?.title} ${f?.detail} ${f?.recommendedAction}`).not.toMatch(/differs|better-performing|averaged/);
  });

  it("does not claim a difference when the gap is small", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    await utc(s);
    // 4.4 against 4.0 is a 10% gap and less than one like or comment.
    await tenPosts(s, acc.id, (i) => ({ kind: i % 2 ? "image" : "text", metrics: { likes: i % 2 ? 3 : 3, comments: i % 2 ? 1.4 : 1 } }));
    expect((await run(s, engagementAdvice))?.key).toBe("social_engagement_similar");
  });

  it("reports a clear difference within one account, in plain words, without saying why", async () => {
    const s = await socialOrg();
    const acc = await connect(s, "facebook", "Harbor Home Page");
    await utc(s);
    await tenPosts(s, acc.id, (i) => (i % 2 ? { kind: "image", metrics: { likes: 20, comments: 4 } } : { kind: "text", metrics: { likes: 2, comments: 1 } }));
    const f = await run(s, engagementAdvice);
    expect(f).toMatchObject({ key: "social_engagement_pattern", severity: "info" });
    expect(f?.title).toBe("Recent engagement differs by post type");
    expect(f?.detail).toMatch(/On Harbor Home Page, image posts averaged 24\.0 likes and comments over 5 posts, against 3\.0 for text posts over 5/);
    expect(f?.detail).toMatch(/do not show that the type, day or time caused the difference, and a gap this size may be chance/);
    expect(f?.recommendedAction).toMatch(/test, not a rule/);
  });

  it("compares posts within an account, not a big Page against a small one", async () => {
    const s = await socialOrg();
    const big = await connect(s, "facebook", "Big Page");
    const small = await connect(s, "facebook", "Small Page");
    await utc(s);
    // Every image post is on the big Page and every text post on the small one. Pooled, images look 30 times better; within each account there is nothing to compare.
    for (let i = 1; i <= 8; i += 1) await seedPublished(s, big.id, { publishedAt: daysAgo(i, 10), kind: "image", metrics: { likes: 90, comments: 10 } });
    for (let i = 1; i <= 8; i += 1) await seedPublished(s, small.id, { publishedAt: daysAgo(i, 10), kind: "text", metrics: { likes: 2, comments: 1 } });
    const f = await run(s, engagementAdvice);
    expect(f).toMatchObject({ key: "social_engagement_similar" });
    expect(`${f?.title} ${f?.detail}`).not.toMatch(/image posts averaged/);
  });

  it("compares times of day and weekdays too, when they clearly differ", async () => {
    const s = await socialOrg();
    const acc = await connect(s, "facebook", "Harbor Home Page");
    await utc(s);
    for (let i = 1; i <= 8; i += 1) await seedPublished(s, acc.id, { publishedAt: daysAgo(i, i % 2 ? 9 : 19), kind: "text", metrics: i % 2 ? { likes: 30, comments: 2 } : { likes: 5, comments: 1 } });
    const f = await run(s, engagementAdvice);
    expect(f?.key).toBe("social_engagement_pattern");
    expect(f?.title).toMatch(/time of day/);
    expect(f?.detail).toMatch(/posts in the morning \(5am to noon\) averaged 32\.0 over 4 posts, against 6\.0 for posts in the evening \(5pm to 10pm\) over 4/);
  });

  it("says nothing when no post has numbers", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    await seedPublished(s, acc.id, { publishedAt: daysAgo(1) });
    expect(await run(s, engagementAdvice)).toBeNull();
  });
});

describe("change since the previous period", () => {
  const recent = (s: SocialOrg, accountId: string, n: number, likes: number) => Promise.all(Array.from({ length: n }, (_, i) => seedPublished(s, accountId, { publishedAt: daysAgo(2 + i), metrics: { likes, comments: 1 } })));
  const before = (s: SocialOrg, accountId: string, n: number, likes: number) => Promise.all(Array.from({ length: n }, (_, i) => seedPublished(s, accountId, { publishedAt: daysAgo(35 + i), metrics: { likes, comments: 1 } })));

  it("reports a clear change with enough posts in both periods, and does not say why", async () => {
    const s = await socialOrg();
    const acc = await connect(s, "facebook", "Harbor Home Page");
    await recent(s, acc.id, 5, 20);
    await before(s, acc.id, 5, 5);
    const f = await run(s, engagementChange);
    expect(f).toMatchObject({ key: "social_engagement_change", severity: "info", count: 10 });
    expect(f?.detail).toMatch(/On Harbor Home Page, the 5 posts of the last 30 days averaged 21\.0 likes and comments, up from 6\.0 over the 5 posts of the 30 days before/);
    expect(f?.detail).toMatch(/does not show why the numbers moved, and a change this size may be chance/);
  });

  it("says nothing with too few posts in either period, or when the numbers barely moved", async () => {
    const few = await socialOrg();
    const accFew = await connect(few);
    await recent(few, accFew.id, 4, 20);
    await before(few, accFew.id, 5, 5);
    expect(await run(few, engagementChange)).toBeNull();
    const flat = await socialOrg();
    const accFlat = await connect(flat);
    await recent(flat, accFlat.id, 5, 10);
    await before(flat, accFlat.id, 5, 11);
    expect(await run(flat, engagementChange)).toBeNull();
  });

  it("puts the change in the review's numbers only when either period has enough posts to compare", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    await recent(s, acc.id, 6, 3);
    await before(s, acc.id, 2, 3);
    const list = await withSystem((db) => metrics(db, job(s)));
    expect(list.find((m) => m.key === "social_published")).toMatchObject({ value: 6, previous: 2, change: 4, trend: "up", comparisonPeriod: "The 30 days before" });
    const small = await socialOrg();
    const accSmall = await connect(small);
    await recent(small, accSmall.id, 2, 3);
    const smallList = await withSystem((db) => metrics(db, job(small)));
    const published = smallList.find((m) => m.key === "social_published")!;
    expect(published).toMatchObject({ value: 2 });
    expect(published).not.toHaveProperty("previous");
    expect(smallList.find((m) => m.key === "social_with_numbers")).toMatchObject({ value: 2 });
  });
});

describe("campaign performance", () => {
  const campaign = (s: SocialOrg, name: string) => rows<{ id: string }>("insert into social_campaigns (org_id, name, utm_campaign) values ($1, $2, $3) returning id", [s.m.org.id, name, name.toLowerCase().replace(/\W+/g, "-")]).then((r) => r[0].id);

  it("reports what followed each campaign's posts, and says plainly which campaigns cannot be measured", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const spring = await campaign(s, "Spring tune-up");
    const brand = await campaign(s, "Brand awareness");
    const a = await seedTracked(s, acc.id, { publishedAt: daysAgo(5), campaignId: spring });
    await seedTracked(s, acc.id, { publishedAt: daysAgo(4), campaignId: spring });
    await seedPublished(s, acc.id, { publishedAt: daysAgo(3), campaignId: brand });
    const pat = await leadWith(s, a.code, { status: "qualified" });
    await bookAppointment(s, pat, new Date());
    await leadWith(s, a.code);
    const f = await run(s, campaignPerformance);
    expect(f).toMatchObject({ key: "social_campaign_performance", severity: "info", count: 2 });
    expect(f?.title).toBe("2 campaigns published posts in the last 60 days; 2 tracked leads came through their links");
    expect(f?.samples).toEqual(["Spring tune-up: 2 posts, 2 tracked leads, 1 appointment booked later", "Brand awareness: 1 post, none with a tracking link, so its leads cannot be measured"]);
    expect(f?.detail).toMatch(/not that the posts caused it/);
    expect(f?.detail).toMatch(/1 campaign had no post with a tracking link, so its leads cannot be measured/);
    expect(f?.recommendedAction).toMatch(/Add the page to share/);
  });

  it("says nothing about posts that belong to no campaign, or a workspace with none", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    await seedTracked(s, acc.id, { publishedAt: daysAgo(2) });
    expect(await run(s, campaignPerformance)).toBeNull();
  });
});

describe("leads from posts", () => {
  it("counts each lead once, leaves out deleted contacts, and says how many have had no follow-up", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const a = await seedTracked(s, acc.id, { publishedAt: daysAgo(3) });
    const b = await seedTracked(s, acc.id, { publishedAt: daysAgo(2) });
    const withTask = await leadWith(s, a.code);
    const messaged = await leadWith(s, b.code);
    await leadWith(s, a.code); // nobody has followed up
    const gone = await leadWith(s, b.code);
    await rows("update contacts set deleted_at = now() where id = $1", [gone]);
    await rows("insert into tasks (org_id, title, contact_id, status) values ($1, 'Call back', $2, 'open')", [s.m.org.id, withTask]);
    const conversation = (await rows<{ id: string }>("insert into conversations (org_id, contact_id, channel, status, subject) values ($1, $2, 'email', 'open', 'Quote') returning id", [s.m.org.id, messaged]))[0].id;
    await rows("insert into conversation_messages (org_id, conversation_id, direction, author_kind, body, status) values ($1, $2, 'outbound', 'human', 'Thanks for getting in touch.', 'sent')", [s.m.org.id, conversation]);
    const f = await run(s, leadsFromPosts);
    expect(f).toMatchObject({ key: "social_leads_tracked", count: 3 });
    expect(f?.title).toBe("3 leads arrived through the tracked link of 2 social posts in the last 60 days");
    expect(f?.detail).toMatch(/1 of the 3 has no open task and no message sent to them since their visit \(calls and meetings logged elsewhere are not checked\)/);
    expect(f?.recommendedAction).toBe("Give the 1 lead with no follow-up an owner and a task in the CRM.");
  });

  it("does not count a task that is done, or a message sent before the visit, as follow-up", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const a = await seedTracked(s, acc.id, { publishedAt: daysAgo(3) });
    const doneTask = await leadWith(s, a.code);
    const earlier = await leadWith(s, a.code);
    await rows("insert into tasks (org_id, title, contact_id, status, completed_at) values ($1, 'Called', $2, 'done', now())", [s.m.org.id, doneTask]);
    const conversation = (await rows<{ id: string }>("insert into conversations (org_id, contact_id, channel, status, subject) values ($1, $2, 'email', 'open', 'Old') returning id", [s.m.org.id, earlier]))[0].id;
    await rows("insert into conversation_messages (org_id, conversation_id, direction, author_kind, body, status, created_at) values ($1, $2, 'outbound', 'human', 'Years ago', 'sent', now() - interval '1 day')", [s.m.org.id, conversation]);
    const f = await run(s, leadsFromPosts);
    expect(f?.detail).toMatch(/2 of the 2 have no open task and no message sent to them since their visit/);
  });

  it("says nothing without a lead, and never counts another workspace's", async () => {
    const s = await socialOrg();
    const other = await socialOrg();
    const acc = await connect(s);
    const a = await seedTracked(s, acc.id, { publishedAt: daysAgo(1) });
    await leadWith(other, a.code);
    expect(await run(s, leadsFromPosts)).toBeNull();
  });
});
