// Writing, approving and scheduling posts on embedded Postgres: who may do what, what an approval covers, and what another workspace can never see.
import { describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { listPosts, createPost, decide, duplicatePost, getPostDetail, reschedulePost, schedulePost, submitForApproval, updatePost } from "@/server/social/posts";
import { insertDraft } from "@/server/social/posts";
import { getSocialSettings, saveSocialSettings, createCampaign, listCampaigns } from "@/server/social/settings";
import { listAccounts, disconnectAccount } from "@/server/social/accounts";
import { simulated } from "@/server/social/providers/simulated";
import { addAsset, approvedPost, connect, LATER, minutes, NOW, rows, scheduledPost, socialOrg, textPost, tick } from "./support/social";

describe("who may do what", () => {
  it("lets a viewer look and nothing else", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    expect(await listAccounts(s.viewer)).toHaveLength(1);
    await expect(createPost(s.viewer, textPost(acc.id))).rejects.toThrow(/can't write/);
    await expect(listPosts(s.viewer)).resolves.toEqual([]);
  });

  it("lets a sales rep draft and submit but not approve, schedule, connect or change settings", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const draft = await createPost(s.sales, textPost(acc.id));
    const pending = await submitForApproval(s.sales, draft.id);
    expect(pending.status).toBe("pending_approval");
    await expect(decide(s.sales, pending.id, { decision: "approve", version: pending.version })).rejects.toThrow(/owner or a manager/);
    await expect(schedulePost(s.sales, pending.id, { at: LATER }, { now: NOW })).rejects.toThrow(/can't schedule/);
    await expect(disconnectAccount(s.sales, acc.id)).rejects.toThrow(/owner or a manager/);
    await expect(saveSocialSettings(s.manager, { aiDraftsEnabled: false }, 0)).rejects.toThrow(/only the business owner/i);
    const saved = await saveSocialSettings(s.owner, { aiDraftsEnabled: false }, 0);
    expect(saved).toMatchObject({ aiDraftsEnabled: false, version: 1 });
    await expect(saveSocialSettings(s.owner, { aiDraftsEnabled: true }, 0)).rejects.toThrow(/Someone else changed/);
  });

  it("only lets the author or a manager edit a draft", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const draft = await createPost(s.owner, textPost(acc.id));
    // A sales rep did not write it and cannot approve or publish: not theirs to change.
    await expect(updatePost(s.sales, draft.id, { caption: "Mine now" }, draft.version)).rejects.toThrow(/person who wrote/);
    const edited = await updatePost(s.manager, draft.id, { caption: "Manager's edit" }, draft.version);
    expect(edited.caption).toBe("Manager's edit");
  });
});

describe("approval is of one version", () => {
  it("is voided by any change, which also cancels the queued job", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const post = await scheduledPost(s, acc.id);
    expect(post.status).toBe("scheduled");
    const edited = await updatePost(s.manager, post.id, { caption: "A different caption" }, post.version);
    expect(edited).toMatchObject({ status: "draft", approvedVersion: null, version: post.version + 1 });
    const jobs = await rows<{ status: string }>("select status from social_publish_jobs where post_id = $1", [post.id]);
    expect(jobs.map((j) => j.status)).toEqual(["cancelled"]);
    expect((await tick(s, LATER)).claimed).toBe(0);
    expect(simulated.posts(acc.externalId)).toHaveLength(0);
    // It has to go through approval again.
    await expect(schedulePost(s.sales, edited.id, { at: LATER }, { now: NOW })).rejects.toThrow(/can't schedule/);
    const resubmitted = await submitForApproval(s.sales, edited.id).catch(async () => submitForApproval(s.manager, edited.id));
    const approved = await decide(s.manager, resubmitted.id, { decision: "approve", version: resubmitted.version });
    expect(approved.approvedVersion).toBe(edited.version);
  });

  it("does not change anything when nothing changed, and refuses a stale edit", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const post = await approvedPost(s, acc.id);
    const same = await updatePost(s.manager, post.id, { caption: post.caption }, post.version);
    expect(same).toMatchObject({ status: "approved", version: post.version });
    await expect(updatePost(s.manager, post.id, { caption: "x" }, post.version - 1 || 99)).rejects.toThrow(/Someone changed this post/);
  });

  it("makes a reviewer say what to change, tells the author, and accepts the resubmission", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const draft = await createPost(s.sales, textPost(acc.id));
    const pending = await submitForApproval(s.sales, draft.id);
    await expect(decide(s.manager, pending.id, { decision: "request_changes", version: pending.version })).rejects.toThrow(/Say what should change/);
    const back = await decide(s.manager, pending.id, { decision: "request_changes", version: pending.version, note: "Mention the price is from $89." });
    expect(back).toMatchObject({ status: "changes_requested", decisionNote: "Mention the price is from $89." });
    const n = await rows("select kind from notifications where user_id = $1 and kind = 'social_approval_decided'", [s.m.people.sales.id]);
    expect(n).toHaveLength(1);
    const edited = await updatePost(s.sales, back.id, { caption: "Spring tune-up from $89." }, back.version);
    expect(edited.status).toBe("changes_requested");
    const again = await submitForApproval(s.sales, edited.id);
    expect(again.status).toBe("pending_approval");
    const rejected = await decide(s.manager, again.id, { decision: "reject", version: again.version, note: "Not this month." });
    expect(rejected.status).toBe("rejected");
    await expect(schedulePost(s.manager, rejected.id, { at: LATER }, { now: NOW })).rejects.toThrow();
  });

  it("asks the owner and managers when a post is sent for approval", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const draft = await createPost(s.sales, textPost(acc.id));
    await submitForApproval(s.sales, draft.id);
    const n = await rows<{ user_id: string }>("select user_id from notifications where org_id = $1 and kind = 'social_approval_requested'", [s.m.org.id]);
    expect(new Set(n.map((r) => r.user_id))).toEqual(new Set([s.m.people.owner.id, s.m.people.manager.id]));
  });
});

describe("what an AI draft can never do", () => {
  it("is never approved by being scheduled, even by the owner", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const ai = await withSystem((db) => insertDraft(db, { orgId: s.m.org.id, userId: s.m.people.owner.id }, textPost(acc.id, { caption: "AI wrote this." }), "ai"));
    await expect(schedulePost(s.owner, ai.id, { at: LATER }, { now: NOW })).rejects.toThrow(/needs to be approved/);
    const submitted = await submitForApproval(s.owner, ai.id);
    expect(submitted.origin).toBe("ai");
    const approved = await decide(s.owner, submitted.id, { decision: "approve", version: submitted.version });
    expect(approved.status).toBe("approved");
    const scheduled = await schedulePost(s.owner, approved.id, { at: LATER }, { now: NOW });
    expect(scheduled.status).toBe("scheduled");
    const events = await rows<{ kind: string; actor_kind: string }>("select kind, actor_kind from social_post_events where post_id = $1 order by id", [ai.id]);
    expect(events[0]).toMatchObject({ kind: "ai_drafted", actor_kind: "ai" });
  });
});

describe("the workspace's own approval rules", () => {
  it("lets a publisher schedule their own post, with the history saying so", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const post = await createPost(s.owner, textPost(acc.id));
    const scheduled = await schedulePost(s.owner, post.id, { at: LATER }, { now: NOW });
    expect(scheduled).toMatchObject({ status: "scheduled", approvedVersion: post.version });
    const kinds = (await rows<{ kind: string }>("select kind from social_post_events where post_id = $1", [post.id])).map((e) => e.kind);
    expect(kinds).toContain("self_approved");
  });

  it("asks for a second person when the workspace requires review, and will not let the author approve", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    await saveSocialSettings(s.owner, { approvalForPublishers: true }, 0);
    const post = await createPost(s.owner, textPost(acc.id));
    await expect(schedulePost(s.owner, post.id, { at: LATER }, { now: NOW })).rejects.toThrow(/needs to be approved/);
    const pending = await submitForApproval(s.owner, post.id);
    await expect(decide(s.owner, pending.id, { decision: "approve", version: pending.version })).rejects.toThrow(/second person/);
    expect((await decide(s.manager, pending.id, { decision: "approve", version: pending.version })).status).toBe("approved");
  });
});

describe("a post must be publishable before it asks for approval", () => {
  it("stops platform problems at submission, in plain words", async () => {
    const s = await socialOrg();
    const ig = await connect(s, "instagram", "Harbor on Instagram");
    const fb = await connect(s, "facebook");
    const textOnIg = await createPost(s.sales, { accountId: ig.id, kind: "text", caption: "Hello" });
    await expect(submitForApproval(s.sales, textOnIg.id)).rejects.toThrow(/posts here are image, video/);
    const long = await createPost(s.sales, { accountId: ig.id, kind: "image", caption: "x".repeat(2300), mediaAssetIds: [await addAsset(s)] });
    await expect(submitForApproval(s.sales, long.id)).rejects.toThrow(/2,300 characters; Instagram allows 2,200/);
    const png = await createPost(s.sales, { accountId: ig.id, kind: "image", caption: "ok", mediaAssetIds: [await addAsset(s, { mime: "image/png" })] });
    await expect(submitForApproval(s.sales, png.id)).rejects.toThrow(/JPEG/);
    const empty = await createPost(s.sales, { accountId: fb.id, kind: "text", caption: "   " });
    await expect(submitForApproval(s.sales, empty.id)).rejects.toThrow(/Write something/);
  });

  it("refuses a picture whose stored file is gone at approval, not on the day it should have gone out", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const asset = await addAsset(s);
    const gone = () => withSystem((db) => db.query("update private_files set status = 'deleted' where id = (select private_file_id from social_media_assets where id = $1)", [asset]));
    const draft = await createPost(s.sales, textPost(acc.id, { kind: "image", mediaAssetIds: [asset] }));
    // While the file is there a person with only the view permission sees it as ready: reading under row-level security must not make a file look removed.
    expect((await listPosts(s.viewer))[0]).toMatchObject({ media: [{ status: "ready" }], problems: [] });
    expect((await getPostDetail(s.viewer, draft.id)).post.problems).toEqual([]);
    await gone();
    await expect(submitForApproval(s.sales, draft.id)).rejects.toThrow(/no longer available/);
    // An approval that was waiting is refused the same way.
    const asset2 = await addAsset(s);
    const waiting = await submitForApproval(s.sales, (await createPost(s.sales, textPost(acc.id, { kind: "image", mediaAssetIds: [asset2] }))).id);
    await withSystem((db) => db.query("update private_files set status = 'deleted' where id = (select private_file_id from social_media_assets where id = $1)", [asset2]));
    await expect(decide(s.manager, waiting.id, { decision: "approve", version: waiting.version })).rejects.toThrow(/no longer available/);
    // A file taken out of the library while a post still holds it is refused too.
    const asset3 = await addAsset(s);
    const third = await createPost(s.sales, textPost(acc.id, { kind: "image", mediaAssetIds: [asset3] }));
    await withSystem((db) => db.query("update social_media_assets set status = 'removed' where id = $1", [asset3]));
    await expect(submitForApproval(s.sales, third.id)).rejects.toThrow(/no longer available/);
  });

  it("refuses to attach another workspace's file, and cannot tell whether it exists", async () => {
    const a = await socialOrg();
    const b = await socialOrg();
    const acc = await connect(a);
    const theirs = await addAsset(b);
    await expect(createPost(a.sales, { accountId: acc.id, kind: "image", caption: "x", mediaAssetIds: [theirs] })).rejects.toThrow(/not found in your media library/);
    await expect(createPost(a.sales, { accountId: acc.id, kind: "image", caption: "x", mediaAssetIds: ["00000000-0000-4000-8000-000000000000"] })).rejects.toThrow(/not found in your media library/);
  });

  it("refuses an account that was disconnected", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const post = await createPost(s.sales, textPost(acc.id));
    await disconnectAccount(s.owner, acc.id);
    await expect(createPost(s.sales, textPost(acc.id))).rejects.toThrow(/connected account/);
    await expect(submitForApproval(s.sales, post.id)).rejects.toThrow(/connected account/);
  });
});

describe("tracked links", () => {
  it("tags a post's link with its own code, and posts that link", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const campaign = await createCampaign(s.manager, { name: "Spring Tune-Up!" });
    expect(campaign.utmCampaign).toBe("spring-tune-up");
    const post = await createPost(s.sales, textPost(acc.id, { kind: "link", linkUrl: "https://www.example.test/offer", campaignId: campaign.id }));
    expect(post.trackingCode).toMatch(/^[a-z0-9]{8}$/);
    const pending = await submitForApproval(s.sales, post.id);
    const approved = await decide(s.manager, pending.id, { decision: "approve", version: pending.version });
    await schedulePost(s.manager, approved.id, { at: LATER }, { now: NOW });
    await tick(s, LATER);
    const sent = simulated.published(acc.externalId)[0];
    const link = new URL(sent.linkUrl as string);
    expect(Object.fromEntries(link.searchParams)).toEqual({ utm_source: "facebook", utm_medium: "social", utm_campaign: "spring-tune-up", utm_content: post.trackingCode });
  });

  it("gives a duplicate its own code", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const post = await createPost(s.sales, textPost(acc.id, { kind: "link", linkUrl: "https://www.example.test/offer" }));
    const copy = await duplicatePost(s.sales, post.id);
    expect(copy.status).toBe("draft");
    expect(copy.trackingCode).not.toBe(post.trackingCode);
    expect(copy.caption).toBe(post.caption);
  });

  it("does not tag links when the workspace turned tracking off", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    await saveSocialSettings(s.owner, { trackingLinks: false }, 0);
    const post = await createPost(s.sales, textPost(acc.id, { kind: "link", linkUrl: "https://www.example.test/offer" }));
    expect(post.trackingCode).toBeNull();
  });
});

describe("a copy of an AI draft is still an AI draft", () => {
  it("keeps its origin and its AI run, so it still needs a person's approval whoever copied it", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const run = (await rows<{ id: string }>("insert into social_ai_runs (org_id, user_id, kind, status) values ($1, $2, 'caption', 'succeeded') returning id", [s.m.org.id, s.m.people.owner.id]))[0].id;
    const ai = await withSystem((db) => insertDraft(db, { orgId: s.m.org.id, userId: s.m.people.sales.id }, textPost(acc.id, { caption: "AI wrote this." }), "ai", run));
    for (const who of [s.owner, s.manager]) {
      const copy = await duplicatePost(who, ai.id);
      expect(copy).toMatchObject({ origin: "ai", status: "draft", caption: "AI wrote this." });
      expect((await rows("select origin, ai_run_id from social_posts where id = $1", [copy.id]))[0]).toMatchObject({ origin: "ai", ai_run_id: run });
      // Copying does not buy a way around the approval: even a person who may publish cannot schedule it without one.
      await expect(schedulePost(who, copy.id, { at: LATER }, { now: NOW })).rejects.toThrow(/needs to be approved/);
      const kinds = (await rows<{ kind: string }>("select kind from social_post_events where post_id = $1 order by id", [copy.id])).map((e) => e.kind);
      expect(kinds).toEqual(["created", "duplicated"]); // copied by a person, not drafted by the model again
    }
  });

  it("leaves a copy of a person's own post a person's post", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const post = await createPost(s.owner, textPost(acc.id));
    const copy = await duplicatePost(s.owner, post.id);
    expect(copy.origin).toBe("human");
    expect((await schedulePost(s.owner, copy.id, { at: LATER }, { now: NOW })).status).toBe("scheduled");
  });
});

describe("a settings save that changed nothing is not reported as a save", () => {
  it("says someone else changed them, and writes no audit record", async () => {
    const s = await socialOrg();
    await saveSocialSettings(s.owner, { aiDraftsEnabled: false }, 0);
    const audits = () => rows("select 1 from audit_logs where org_id = $1 and action = 'social.settings_saved'", [s.m.org.id]);
    expect(await audits()).toHaveLength(1);
    // Another save landing between the version check and the write leaves this statement with no row to change. The trigger skips the update to stand in for it.
    await withSystem(async (db) => {
      await db.query("create function skip_settings_update() returns trigger language plpgsql as $$ begin return null; end $$");
      await db.query("create trigger skip_settings_update before update on social_settings for each row execute function skip_settings_update()");
    });
    try {
      await expect(saveSocialSettings(s.owner, { approvalForPublishers: true }, 1)).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/Someone else changed these settings/) });
      expect(await audits()).toHaveLength(1);
    } finally {
      await withSystem(async (db) => {
        await db.query("drop trigger skip_settings_update on social_settings");
        await db.query("drop function skip_settings_update()");
      });
    }
    expect(await getSocialSettings(s.owner)).toMatchObject({ approvalForPublishers: false, aiDraftsEnabled: false, version: 1 });
  });
});

describe("limits are explained in words, not by the database", () => {
  const invalid = (text: RegExp) => ({ code: "invalid_input", message: expect.stringMatching(text) });

  it("refuses a link that is not https, accepts any case of the scheme, and stores it in lower case", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    await expect(createPost(s.sales, textPost(acc.id, { kind: "link", linkUrl: "http://oldsite.test/offer" }))).rejects.toMatchObject(invalid(/must start with https:\/\//));
    await expect(createPost(s.sales, textPost(acc.id, { kind: "link", linkUrl: "oldsite.test/offer" }))).rejects.toMatchObject(invalid(/must start with https:\/\//));
    await expect(createPost(s.sales, textPost(acc.id, { kind: "link", linkUrl: "https://" }))).rejects.toMatchObject(invalid(/not a web address/));
    await expect(createPost(s.sales, textPost(acc.id, { kind: "link", linkUrl: `https://shop.test/${"a".repeat(1000)}` }))).rejects.toMatchObject(invalid(/longer than 1,000/));
    const ok = await createPost(s.sales, textPost(acc.id, { kind: "link", linkUrl: " HTTPS://Shop.test/Offer " }));
    expect(ok.linkUrl).toBe("https://Shop.test/Offer");
    await expect(updatePost(s.sales, ok.id, { linkUrl: "http://oldsite.test/offer" }, ok.version)).rejects.toMatchObject(invalid(/must start with https:\/\//));
    const moved = await updatePost(s.sales, ok.id, { linkUrl: "Https://Other.test/a" }, ok.version);
    expect(moved.linkUrl).toBe("https://Other.test/a");
    expect((await updatePost(s.sales, ok.id, { linkUrl: null }, moved.version)).linkUrl).toBeNull();
  });

  it("refuses a caption past the limit and more hashtags than a post can carry, and accepts the limit itself", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    await expect(createPost(s.sales, textPost(acc.id, { caption: "x".repeat(63_207) }))).rejects.toMatchObject(invalid(/longer than 63,206 characters/));
    const manyTags = Array.from({ length: 31 }, (_, i) => `tag${i}`);
    await expect(createPost(s.sales, textPost(acc.id, { hashtags: manyTags }))).rejects.toMatchObject(invalid(/at most 30 hashtags/));
    const edge = await createPost(s.sales, textPost(acc.id, { caption: "x".repeat(63_206), hashtags: manyTags.slice(0, 30) }));
    expect(edge.caption).toHaveLength(63_206);
    await expect(updatePost(s.sales, edge.id, { caption: "x".repeat(63_207) }, edge.version)).rejects.toMatchObject(invalid(/longer than 63,206 characters/));
    await expect(updatePost(s.sales, edge.id, { hashtags: manyTags }, edge.version)).rejects.toMatchObject(invalid(/at most 30 hashtags/));
    expect((await rows("select 1 from social_posts where id = $1 and version = $2", [edge.id, edge.version])).length).toBe(1); // nothing was half-written
  });
});

describe("the calendar and history", () => {
  it("lists a day, a month and a status, and moves a scheduled post", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const one = await scheduledPost(s, acc.id, { caption: "One" });
    const draft = await createPost(s.sales, textPost(acc.id, { caption: "A draft" }));
    const all = await listPosts(s.viewer, { from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-11-01T00:00:00Z") });
    expect(all.map((p) => p.caption).sort()).toEqual(["A draft", "One"]);
    expect((await listPosts(s.viewer, { statuses: ["scheduled"] })).map((p) => p.id)).toEqual([one.id]);
    expect(await listPosts(s.viewer, { accountId: "00000000-0000-4000-8000-000000000000" })).toEqual([]);
    const moved = await reschedulePost(s.manager, one.id, { at: minutes(LATER, 120), timezone: "America/Chicago" }, { now: NOW });
    expect(moved).toMatchObject({ scheduledAt: minutes(LATER, 120).toISOString(), timezone: "America/Chicago" });
    const detail = await getPostDetail(s.viewer, one.id);
    expect(detail.events.map((e) => e.kind)).toEqual(expect.arrayContaining(["scheduled", "rescheduled"]));
    expect(detail.job).toMatchObject({ status: "queued" });
    expect(draft.status).toBe("draft");
  });
});

describe("one workspace never sees another's", () => {
  it("shows no posts, accounts, campaigns or settings across workspaces, and hides the token from the database role", async () => {
    const a = await socialOrg();
    const b = await socialOrg();
    const acc = await connect(a);
    const post = await createPost(a.sales, textPost(acc.id));
    await createCampaign(a.manager, { name: "Only A" });
    expect(await listPosts(b.owner)).toEqual([]);
    expect(await listAccounts(b.owner)).toEqual([]);
    expect(await listCampaigns(b.owner)).toEqual([]);
    await expect(getPostDetail(b.owner, post.id)).rejects.toThrow(/not found/);
    await expect(updatePost(b.owner, post.id, { caption: "hijack" }, post.version)).rejects.toThrow(/not found/);
    expect((await getSocialSettings(b.owner)).version).toBe(0);
    // The application role cannot read the sealed token at all.
    await expect(withUser(a.owner.user.id, (db) => db.query("select credentials from social_accounts"))).rejects.toThrow(/permission denied/);
    const visible = await withUser(a.owner.user.id, (db) => db.query("select id, name from social_accounts"));
    expect(visible.rows).toHaveLength(1);
  });
});
