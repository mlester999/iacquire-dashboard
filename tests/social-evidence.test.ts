// The whole chain a claim about results rests on: a published post's link, a website enquiry from that link, and what became of the person afterwards. The
// post's tracking code is the only thing that ties them, and an outcome counts only if it came after the visit.
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { memberActor } from "@/server/crm/actor";
import { attributionReport } from "@/server/attribution/report";
import { socialOverview } from "@/server/social/analytics";
import { simulated } from "@/server/social/providers/simulated";
import { processSubmissions } from "@/server/websites/forms";
import { connect, LATER, rows, scheduledPost, socialOrg, tick, type SocialOrg } from "./support/social";
import { bookAppointment, DAY, openDeal } from "./support/social-analytics";
import { addSiteHost } from "./support/webchat";

const WINDOW = { startsAt: new Date("2026-10-01T00:00:00Z"), endsAt: new Date("2026-12-01T00:00:00Z") };

/** A published link post, and the address it was actually posted with. */
async function publishedLink(s: SocialOrg, accountId: string, externalId: string, caption: string) {
  const post = await scheduledPost(s, accountId, { kind: "link", linkUrl: "https://www.client-site.test/offer", caption });
  await tick(s, LATER);
  const code = (await rows<{ tracking_code: string }>("select tracking_code from social_posts where id = $1", [post.id]))[0].tracking_code;
  const sent = simulated.published(externalId).find((p) => p.message.startsWith(caption));
  return { id: post.id, code, link: new URL(sent!.linkUrl!) };
}

/** The enquiry a visitor sends from the site after arriving through `link`, as the website form stores it. */
async function enquire(s: SocialOrg, site: { id: string; host: string }, link: URL | null, who: { email: string; name: string; at: Date }) {
  const utm = link ? Object.fromEntries([...link.searchParams].filter(([k]) => k.startsWith("utm_"))) : {};
  await rows(
    `insert into website_form_submissions (org_id, website_id, publication_id, host, page_slug, name, email, phone, message, consent, consent_text, utm, referrer, dedupe_key, created_at)
     values ($1, $2, $3, $4, 'offer', $5, $6, null, 'Quote please', true, 'I agree to be contacted about my enquiry.', $7::jsonb, null, $8, $9)`,
    [s.m.org.id, site.id, crypto.randomUUID(), site.host, who.name, who.email, JSON.stringify(utm), `dedupe-${crypto.randomUUID()}`, who.at],
  );
  await processSubmissions({ limit: 50 });
  return (await rows<{ id: string }>("select id from contacts where org_id = $1 and email = $2", [s.m.org.id, who.email]))[0].id;
}

describe("from a published post to what became of the people it brought", () => {
  it("ties a lead to the post whose link brought them, credits only what came after the visit, and still shows the source", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const host = `evidence-${crypto.randomBytes(3).toString("hex")}.iacquire.site`;
    await addSiteHost(s.m.org.id, host);
    const site = { id: (await rows<{ id: string }>("select id from websites where org_id = $1", [s.m.org.id]))[0].id, host };
    const tag = crypto.randomBytes(3).toString("hex");
    const earlier = (days: number) => new Date(Date.now() - days * DAY);
    const justNow = () => new Date(Date.now() - 120_000);

    const pat = await publishedLink(s, acc.id, acc.externalId, "Spring tune-up special");
    const quinn = await publishedLink(s, acc.id, acc.externalId, "Gutter check reminder");
    const rae = await publishedLink(s, acc.id, acc.externalId, "Winter prep checklist");
    const other = await publishedLink(s, acc.id, acc.externalId, "Thank you for a great month");

    // The address that was posted carries the post's own code, whatever the person pasted.
    for (const p of [pat, quinn, rae, other]) {
      expect(p.link.searchParams.get("utm_content")).toBe(p.code);
      expect(p.link.searchParams.get("utm_source")).toBe("facebook");
      expect(p.link.searchParams.get("utm_medium")).toBe("social");
    }

    // Pat: a new lead from the first post, who then books, gets a deal, and the deal is won. All after the visit.
    const patId = await enquire(s, site, pat.link, { email: `pat-${tag}@example.net`, name: "Pat Lead", at: justNow() });
    await rows("update contacts set lead_status = 'qualified' where id = $1", [patId]);
    await bookAppointment(s, patId, new Date());
    await openDeal(s, patId, new Date(), "won");

    // Quinn: a new lead from the second post whose appointment and deal were both made BEFORE the visit (a customer-to-be who was already in the pipeline).
    const quinnId = await enquire(s, site, quinn.link, { email: `quinn-${tag}@example.net`, name: "Quinn Lead", at: justNow() });
    await bookAppointment(s, quinnId, earlier(3));
    await openDeal(s, quinnId, earlier(3), "won");

    // Rae: a customer for over a year with a won deal in 2025, who clicks the third post's link and sends a form.
    const raeEmail = `rae-${tag}@example.net`;
    await enquire(s, site, null, { email: raeEmail, name: "Rae Customer", at: earlier(400) });
    const raeId = (await rows<{ id: string }>("select id from contacts where org_id = $1 and email = $2", [s.m.org.id, raeEmail]))[0].id;
    await rows("update contacts set created_at = now() - interval '400 days', lead_status = 'customer' where id = $1", [raeId]);
    await openDeal(s, raeId, earlier(400), "won");
    await bookAppointment(s, raeId, earlier(399));
    expect(await enquire(s, site, rae.link, { email: raeEmail, name: "Rae Customer", at: justNow() })).toBe(raeId); // the same contact, not a second one

    const o = await socialOverview(s.viewer, WINDOW);
    const post = (id: string) => o.posts.find((p) => p.postId === id)!;
    expect(post(pat.id)).toMatchObject({ tracked: true, leads: 1, qualified: 1, appointments: 1, opportunities: 1, wonCount: 1, alreadyInCrm: 0 });
    // Quinn is a lead of the second post, and nothing else is claimed: the booking and the deal came first.
    expect(post(quinn.id)).toMatchObject({ tracked: true, leads: 1, qualified: 0, appointments: 0, opportunities: 0, wonCount: 0, alreadyInCrm: 0 });
    // Rae is a lead of the third post, but a 2025 sale, her status and her old booking are not this post's.
    expect(post(rae.id)).toMatchObject({ tracked: true, leads: 1, qualified: 0, appointments: 0, opportunities: 0, wonCount: 0, alreadyInCrm: 1 });
    // A post nobody arrived through has a measured zero.
    expect(post(other.id)).toMatchObject({ tracked: true, leads: 0, qualified: 0, appointments: 0, opportunities: 0, wonCount: 0 });
    expect(o.leads).toMatchObject({ total: 3, qualified: 1, appointments: 1, opportunities: 1, wonCount: 1, alreadyInCrm: 1, trackedPosts: 4 });
    expect(o.campaigns).toEqual([expect.objectContaining({ name: "No campaign", posts: 4, trackedPosts: 4, tracked: true, leads: 3, qualified: 1, wonCount: 1 })]);

    // The Lead Sources report still shows where Pat and Quinn came from (Rae joined long ago, so she is not a new lead in this period).
    const report = await attributionReport(memberActor(s.owner), { startsAt: new Date(Date.now() - DAY), endsAt: new Date(Date.now() + DAY) });
    const facebook = report.rows.find((r) => r.source === "facebook");
    expect(facebook).toMatchObject({ label: "Facebook", leads: 2, qualified: 1, known: 2 });
    // The same two people on the contact's own page: their first visit carried the posts' codes.
    const touches = await rows<{ content: string; contact_id: string }>("select content, contact_id from lead_touches where org_id = $1 and content is not null order by id", [s.m.org.id]);
    expect(touches.map((t) => t.content).sort()).toEqual([pat.code, quinn.code, rae.code].sort());
  }, 60000);

  it("credits a lead to the right post when the link was copied from an earlier one", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const host = `evidence-${crypto.randomBytes(3).toString("hex")}.iacquire.site`;
    await addSiteHost(s.m.org.id, host);
    const site = { id: (await rows<{ id: string }>("select id from websites where org_id = $1", [s.m.org.id]))[0].id, host };
    const first = await publishedLink(s, acc.id, acc.externalId, "The first post");
    // The second post's person pastes the first post's tagged address.
    const post = await scheduledPost(s, acc.id, { kind: "link", linkUrl: first.link.toString(), caption: "A second post" });
    await tick(s, LATER);
    const code = (await rows<{ tracking_code: string }>("select tracking_code from social_posts where id = $1", [post.id]))[0].tracking_code;
    const posted = new URL(simulated.published(acc.externalId).find((p) => p.message.startsWith("A second post"))!.linkUrl!);
    expect(code).not.toBe(first.code);
    expect(posted.searchParams.getAll("utm_content")).toEqual([code]);
    await enquire(s, site, posted, { email: `copy-${crypto.randomBytes(3).toString("hex")}@example.net`, name: "Copy Lead", at: new Date(Date.now() - 60_000) });
    const o = await socialOverview(s.viewer, WINDOW);
    expect(o.posts.find((p) => p.postId === post.id)).toMatchObject({ leads: 1 });
    expect(o.posts.find((p) => p.postId === first.id)).toMatchObject({ leads: 0 });
  }, 60000);
});
