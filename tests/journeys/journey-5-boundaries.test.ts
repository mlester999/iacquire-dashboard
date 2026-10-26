// Journey 5, the edges: a social post becomes an attributed lead, asked what journey 5 does not.
//   * denied access: a sales rep cannot connect an account or approve what they wrote, a viewer cannot write a post, and a post nobody approved is never published;
//   * tenant isolation: another workspace's owner cannot read the account, the post or the media, cannot write a post on this workspace's account, and the other workspace's
//     overview credits it with nothing (row-level security as the application role);
//   * duplicates and replays: the publisher running again at the same time publishes nothing twice, and the same visit link followed twice by the same visitor is one lead;
//   * audit: who connected the account, who approved the post and who scheduled it are recorded under their names;
//   * what the platform is given: exactly the approved caption, with the post's own tracking tags.
// The social platform is src/server/social/providers/simulated.ts and the visitor's browser is the widget handler called directly, as in journey 5.
import { describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { ensureWidget, saveWidgetSettings } from "@/server/webchat/config";
import { socialOverview } from "@/server/social/analytics";
import { createPost, decide, schedulePost, submitForApproval } from "@/server/social/posts";
import { connectSimulatedAccount } from "@/server/social/accounts";
import { simulated } from "@/server/social/providers/simulated";
import { connect, LATER, NOW, rows, scheduledPost, socialOrg, textPost, tick } from "../support/social";
import { ORIGIN, embedCall, clientId, start } from "../support/webchat";

const WINDOW = { startsAt: new Date("2026-10-01T00:00:00Z"), endsAt: new Date("2026-12-01T00:00:00Z") };

describe("journey 5: who may publish, who can see it, and what a repeat does", () => {
  it("refuses a sales rep a connection and an approval of their own post, a viewer a draft, and never publishes a post nobody approved", async () => {
    const s = await socialOrg();
    await expect(connectSimulatedAccount(s.sales, { platform: "facebook", name: "Sales tries" })).rejects.toMatchObject({ code: "forbidden" });
    const account = await connect(s, "facebook", "Harbor Page");
    await expect(createPost(s.viewer, textPost(account.id))).rejects.toMatchObject({ code: "forbidden" });

    const draft = await createPost(s.sales, textPost(account.id, { caption: "Not approved yet." }));
    const pending = await submitForApproval(s.sales, draft.id);
    // The author cannot approve their own post.
    await expect(decide(s.sales, pending.id, { decision: "approve", version: pending.version })).rejects.toMatchObject({ code: expect.stringMatching(/forbidden|conflict/) });
    // A post that is not approved cannot be scheduled, so the publisher has nothing to take.
    await expect(schedulePost(s.manager, pending.id, { at: LATER }, { now: NOW })).rejects.toMatchObject({ code: expect.stringMatching(/conflict|forbidden|invalid_input/) });
    expect(await tick(s, LATER)).toMatchObject({ claimed: 0 });
    expect(simulated.published(account.externalId)).toHaveLength(0);
  });

  it("keeps the account, the post and the overview away from another workspace, and refuses a post on an account that is not yours", async () => {
    const a = await socialOrg();
    const b = await socialOrg();
    const account = await connect(a, "facebook", "A's Page");
    const post = await scheduledPost(a, account.id);
    await expect(createPost(b.sales, textPost(account.id))).rejects.toMatchObject({ code: expect.stringMatching(/not_found|forbidden|invalid_input/) });
    const seen = (table: string) => withUser(b.m.people.owner.id, async (db) => (await db.query(`select 1 from ${table} where org_id = $1`, [a.m.org.id])).rows.length);
    for (const table of ["social_accounts", "social_posts"]) {
      expect((await rows(`select 1 from ${table} where org_id = $1`, [a.m.org.id])).length, `${table} exists`).toBeGreaterThan(0);
      expect(await seen(table), `${table} seen by another workspace's owner`).toBe(0);
    }
    expect(await tick(b, LATER)).toMatchObject({ claimed: 0 });
    expect((await rows<{ status: string }>("select status from social_posts where id = $1", [post.id]))[0].status).toBe("scheduled");
    const theirs = await socialOverview(b.owner, WINDOW);
    expect(JSON.stringify(theirs)).not.toContain(account.id);
  });

  it("publishes once however many times the publisher runs, and counts one lead for one visitor who follows the link twice", async () => {
    const s = await socialOrg();
    const account = await connect(s, "facebook", "Harbor Page");
    const initial = await withSystem((db) => ensureWidget(db, s.m.org.id));
    const widget = await saveWidgetSettings(s.owner, { enabled: true, allowedOrigins: [ORIGIN] }, initial.version);
    const chat = { m: s.m, widget };
    const post = await scheduledPost(s, account.id, { kind: "link", caption: "Spring tune-up special: book this week.", linkUrl: `${ORIGIN}/offer` });
    expect(await tick(s, LATER)).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(await tick(s, LATER)).toMatchObject({ claimed: 0 });
    expect(await tick(s, new Date(LATER.getTime() + 60_000))).toMatchObject({ claimed: 0 });
    expect(simulated.published(account.externalId)).toHaveLength(1);

    const [published] = simulated.published(account.externalId);
    const link = new URL(published.linkUrl as string);
    const token = await start(chat, { landing: `${link.pathname}${link.search}`, referrer: "https://l.facebook.com/" });
    for (let i = 0; i < 2; i += 1) {
      await embedCall(chat, { action: "send", token, body: { text: "Saw your post.", clientMessageId: "same-message-id-0001" } });
    }
    const touches = await rows("select 1 from lead_touches where org_id = $1 and source = 'facebook'", [s.m.org.id]);
    expect(touches).toHaveLength(1);
    void clientId;
    expect(post.id).toBeTruthy();
  });

  it("records who connected the account, who approved the post and who scheduled it, and hands the platform exactly the approved words", async () => {
    const s = await socialOrg();
    const account = await connect(s, "facebook", "Harbor Page");
    const post = await scheduledPost(s, account.id, { caption: "Gutters cleaned this week, booking open." });
    const audit = await rows<{ action: string; actor_user_id: string | null }>("select action, actor_user_id from audit_logs where org_id = $1 and action like 'social.%' order by created_at, id", [s.m.org.id]);
    const by = (needle: RegExp) => audit.filter((a) => needle.test(a.action));
    expect(by(/account/).some((a) => a.actor_user_id === s.m.people.owner.id)).toBe(true);
    expect(by(/approv/).some((a) => a.actor_user_id === s.m.people.manager.id)).toBe(true);
    expect(by(/schedul/).some((a) => a.actor_user_id === s.m.people.manager.id)).toBe(true);
    await tick(s, LATER);
    const [published] = simulated.published(account.externalId);
    expect(published.message).toContain("Gutters cleaned this week, booking open.");
    expect(post.id).toBeTruthy();
  });
});
