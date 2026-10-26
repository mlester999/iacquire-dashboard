// Journey 5: a social post becomes an attributed lead, across the social, publishing, website-chat and attribution services instead of inside one module.
//
// An account is connected to a social platform, a link post is approved and scheduled, the durable publisher hands it to the platform at its time, a visitor follows
// the tracked link the platform now serves, the website chat records the visit, and the social overview counts that visitor as a lead of that post.
//
// Two external boundaries are simulated and only here:
//   * the social platform: src/server/social/providers/simulated.ts, reached through the same publisher seam the production adapters use. It posts nothing anywhere;
//     what the tests read is what it was asked to publish (including the exact link it would serve to a visitor);
//   * the visitor's browser: tests/support/webchat.ts embedCall calls the public website-chat handler the way an embedded widget does, with the landing address the
//     visitor arrived on. No socket is opened; the visit is the query string the platform's own link carries.
// The email and messaging providers are not involved at all: nothing here sends an email or a text message.
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { ensureWidget, saveWidgetSettings } from "@/server/webchat/config";
import { socialOverview } from "@/server/social/analytics";
import { simulated } from "@/server/social/providers/simulated";
import { connect, LATER, rows, scheduledPost, socialOrg, tick } from "../support/social";
import { ORIGIN, answer, bodyOf, clientId, embedCall, start } from "../support/webchat";

/** The month the journey runs in. Passing it to the overview keeps every date in this file on the clock the story uses, not the wall clock. */
const WINDOW = { startsAt: new Date("2026-10-01T00:00:00Z"), endsAt: new Date("2026-12-01T00:00:00Z") };

describe("a social post becomes an attributed lead", () => {
  it("publishes through the durable publisher, and the visit the platform's tracked link brings is counted against that post", async () => {
    // 1. The workspace connects a Facebook Page. The connection goes through the simulated platform, so the token it hands back is the stand-in's.
    const s = await socialOrg();
    const account = await connect(s, "facebook", "Harbor Home Page");
    expect(account.platform).toBe("facebook");

    // 2. The website chat is switched on for the client's site, because that is where the post's link sends people. Nothing is sent to the visitor: the widget's
    // own handler is called directly.
    const initial = await withSystem((db) => ensureWidget(db, s.m.org.id));
    const widget = await saveWidgetSettings(s.owner, { enabled: true, allowedOrigins: [ORIGIN] }, initial.version);
    const chat = { m: s.m, widget };

    // 3. A link post is written, approved and scheduled for one hour after the story's "now", then the publisher is run at that time. The platform is the only
    // thing that makes a post; the publisher is what decides when and exactly once.
    const post = await scheduledPost(s, account.id, { kind: "link", caption: "Spring tune-up special: book this week.", linkUrl: `${ORIGIN}/offer` });
    expect(await tick(s, LATER)).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });

    // 4. What the platform would serve is the page's address with this post's own tracking tags, and utm_content is the code the visit will carry. This is the
    // link a visitor clicks, so the rest of the journey starts from the platform's answer rather than from an address the test made up.
    const [published] = simulated.published(account.externalId);
    expect(published).toBeTruthy();
    const link = new URL(published.linkUrl as string);
    const code = (await rows<{ tracking_code: string; status: string }>("select tracking_code, status from social_posts where id = $1", [post.id]))[0];
    expect(code.status).toBe("published");
    expect(link.origin).toBe(ORIGIN);
    expect(link.pathname).toBe("/offer");
    expect(link.searchParams.get("utm_source")).toBe("facebook");
    expect(link.searchParams.get("utm_medium")).toBe("social");
    expect(link.searchParams.get("utm_content")).toBe(code.tracking_code);

    // 5. The visitor arrives from that link. Their browser hands the widget the landing address it was opened with; the chat service is what turns the visit
    // into a contact and a recorded touch, and this is the value the platform's link passed to it, unchanged.
    const token = await start(chat, { landing: `${link.pathname}${link.search}`, referrer: "https://l.facebook.com/" });
    const sent = await embedCall(chat, {
      action: "send",
      token,
      body: { text: "Hi, I saw your Facebook post about the spring tune-up.", clientMessageId: clientId() },
      generate: answer("Happy to help. What sort of home is it?").generate,
    });
    expect(bodyOf(sent).ok).toBe(true);

    // 6. The visit is one lead touch, and it carries what the post's link carried: the platform as the source, social as the medium and the post's code as the
    // content. A touch with no code, or another post's code, could not be attributed to this post, so the code is the fact that matters.
    const [contact] = await rows<{ id: string; first_touch_id: string | null; created_via: string }>(
      "select id, first_touch_id, created_via from contacts where org_id = $1 order by created_at desc, id desc limit 1", [s.m.org.id],
    );
    expect(contact).toMatchObject({ created_via: "website_chat" });
    expect(contact.first_touch_id).not.toBeNull();
    const [touch] = await rows<{ kind: string; source: string; medium: string; campaign: string; content: string; confidence: string; evidence: string; ref_type: string }>(
      "select kind, source, medium, campaign, content, confidence, evidence, ref_type from lead_touches where org_id = $1 and contact_id = $2", [s.m.org.id, contact.id],
    );
    expect(touch).toMatchObject({ kind: "website_chat", source: "facebook", medium: "social", content: code.tracking_code, confidence: "known", evidence: "utm", ref_type: "web_chat_session" });

    // 7. The overview the client's viewer opens credits that contact to the post, and says the post is tracked (its link can carry a code). "Tracked" is
    // asserted separately from "one lead" because a post with no usable link cannot be measured at all.
    const overview = await socialOverview(s.viewer, WINDOW, { now: new Date("2026-10-24T09:00:00Z") });
    expect(overview.posts).toHaveLength(1);
    expect(overview.posts[0]).toMatchObject({ postId: post.id, platform: "facebook", accountName: "Harbor Home Page", tracked: true, leads: 1 });
    expect(overview.leads).toMatchObject({ total: 1, trackedPosts: 1 });
    expect(overview.counts.published).toBe(1);

    // 8. The visitor was not counted twice: the platform holds one post, and the same code read by the overview is the one the single touch carries.
    expect(simulated.posts(account.externalId)).toHaveLength(1);
    expect(await rows("select 1 from lead_touches where org_id = $1 and contact_id = $2", [s.m.org.id, contact.id])).toHaveLength(1);
  });

  it("does not credit the post with a visitor whose visit carried no tracking code", async () => {
    // The same journey without the tracked link: a visitor who arrives from the site's own navigation is a contact with no touch code, and the overview must not
    // claim the post brought them. This is the guard that keeps "leads" from becoming "people who happened to be around".
    const s = await socialOrg();
    const account = await connect(s);
    const initial = await withSystem((db) => ensureWidget(db, s.m.org.id));
    const widget = await saveWidgetSettings(s.owner, { enabled: true, allowedOrigins: [ORIGIN] }, initial.version);
    const chat = { m: s.m, widget };

    const post = await scheduledPost(s, account.id, { kind: "link", linkUrl: `${ORIGIN}/offer` });
    await tick(s, LATER);

    const token = await start(chat, { landing: "/offer", referrer: "https://www.google.com/" });
    await embedCall(chat, { action: "send", token, body: { text: "Just browsing your prices.", clientMessageId: clientId() }, generate: answer("Here is what we do.").generate });

    const overview = await socialOverview(s.viewer, WINDOW, { now: new Date("2026-10-24T09:00:00Z") });
    expect(overview.posts[0]).toMatchObject({ postId: post.id, tracked: true, leads: 0 });
    expect(overview.leads).toMatchObject({ total: 0 });
    // The post itself is still measured (its link can carry a code); only this visitor is not claimed by it, because their touch carries no code at all.
    const [touch] = await rows<{ content: string | null; confidence: string }>(
      "select content, confidence from lead_touches where org_id = $1 and contact_id = (select id from contacts where org_id = $1 order by created_at desc, id desc limit 1)", [s.m.org.id],
    );
    expect(touch.content ?? "").toBe("");
    expect(touch.confidence).not.toBe("known");
  });
});
