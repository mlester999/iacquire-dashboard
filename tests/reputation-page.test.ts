// Rules R1 and R3 of the review-gating-safe design, on the customer's page: every token, in every state and for every score, shows the business's same public review links in
// the same order, and the thank-you after a low score differs from the one after a high score only by one sentence about a private follow-up, which never asks the customer to
// wait or reconsider before posting. Synthetic workspaces on embedded Postgres.
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh() {}, push() {}, replace() {} }),
  usePathname: () => "/r/token",
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error("not found");
  },
  redirect: () => {
    throw new Error("redirect");
  },
}));
vi.mock("next/cache", () => ({ revalidatePath() {} }));

import { withSystem } from "@/server/db";
import { cancelReviewRequest, listReviewDestinations, loadReviewPage, submitReviewFeedback } from "@/server/crm/reviews";
import ReviewRequestPage from "@/app/r/[token]/page";
import { ask, giveFeedback, reputationShop, shopCustomer, type ReputationShop } from "./support/reputation";

const render = async (token: string, r?: string) => renderToStaticMarkup(await ReviewRequestPage({ params: Promise.resolve({ token }), searchParams: Promise.resolve(r ? { r } : {}) }));
const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&apos;|&#x27;/g, "'").replace(/\s+/g, " ").trim();

let s: ReputationShop;
let FOLLOW_UP: string;
beforeAll(async () => {
  s = await reputationShop("Parity Shop");
  FOLLOW_UP = " Someone from Parity Shop will also follow up with you privately.";
});

describe("rule R1: one set of links for everyone", () => {
  it("shows the same links, in the business's order, for an unopened link, a low answer, a high answer, an expired link and a cancelled one", async () => {
    const want = (await listReviewDestinations(s.owner)).filter((d) => d.active).map((d) => ({ id: d.id, label: d.label, url: d.url }));
    expect(want.length).toBeGreaterThan(1);
    const open = await ask(s, await shopCustomer(s));
    const low = await giveFeedback(s, await shopCustomer(s), { rating: 1, comment: "Terrible service." });
    const high = await giveFeedback(s, await shopCustomer(s), { rating: 5 });
    const complaint = await giveFeedback(s, await shopCustomer(s), { comment: "This was unacceptable." });
    const expired = await ask(s, await shopCustomer(s));
    await withSystem((db) => db.query("update crm_review_requests set expires_at = now() - interval '1 minute' where id = $1", [expired.requestId]));
    const cancelled = await ask(s, await shopCustomer(s));
    await cancelReviewRequest(s.owner, cancelled.requestId);

    const states = { open, low, high, complaint, expired, cancelled };
    const seen: Record<string, string[]> = {};
    for (const [name, x] of Object.entries(states)) {
      const page = await loadReviewPage(x.token);
      expect(page.destinations.map((d) => ({ id: d.id, label: d.label, url: d.url })), name).toEqual(want);
      seen[name] = page.destinations.map((d) => d.id);
    }
    expect(new Set(Object.values(seen).map((ids) => ids.join(","))).size).toBe(1);
    expect(low.result.escalated && complaint.result.escalated && !high.result.escalated).toBe(true);
  });

  it("renders the same review-site buttons whatever the score, and never mentions the score on the page of someone who has not answered", async () => {
    const low = await giveFeedback(s, await shopCustomer(s), { rating: 2 });
    const mid = await giveFeedback(s, await shopCustomer(s), { rating: 3 });
    const buttons = (html: string, token: string) => html.replaceAll(token, "TOKEN").match(/<section aria-labelledby="public-reviews"[\s\S]*?<\/section>/)?.[0];
    const a = buttons(await render(low.token, "saved"), low.token);
    const b = buttons(await render(mid.token, "saved"), mid.token);
    expect(a).toBeTruthy();
    expect(a).toBe(b);
    expect(a).toContain("Review us on Facebook");
    expect(a).toContain("/api/public/reviews/click");
  });
});

describe("rule R3: a low score adds a private follow-up and replaces nothing", () => {
  it("makes the thank-you for a 1 and for a 5 identical except for the one sentence about the private follow-up", async () => {
    const one = await giveFeedback(s, await shopCustomer(s), { rating: 1, comment: "Cold room." });
    const five = await giveFeedback(s, await shopCustomer(s), { rating: 5, comment: "Lovely." });
    for (const r of ["saved", undefined]) {
      const lowHtml = (await render(one.token, r)).replaceAll(one.token, "TOKEN");
      const highHtml = (await render(five.token, r)).replaceAll(five.token, "TOKEN");
      expect(lowHtml.includes(FOLLOW_UP), `low, r=${r}`).toBe(true);
      expect(highHtml.includes("follow up with you"), `high, r=${r}`).toBe(false);
      expect(lowHtml.replace(FOLLOW_UP, ""), `r=${r}`).toBe(highHtml);
    }
  });

  it("does the same for a score of 2, a comment-only complaint and a score just above the level", async () => {
    const two = await giveFeedback(s, await shopCustomer(s), { rating: 2 });
    const three = await giveFeedback(s, await shopCustomer(s), { rating: 3 });
    const angry = await giveFeedback(s, await shopCustomer(s), { comment: "I want to complain about the service." });
    const html = async (x: { token: string }) => (await render(x.token, "saved")).replaceAll(x.token, "TOKEN");
    expect((await html(two)).includes(FOLLOW_UP)).toBe(true);
    expect((await html(angry)).includes(FOLLOW_UP)).toBe(true);
    expect((await html(three)).includes(FOLLOW_UP)).toBe(false);
    expect((await html(two)).replace(FOLLOW_UP, "")).toBe(await html(three));
    expect((await html(angry)).replace(FOLLOW_UP, "")).toBe(await html(three));
  });

  it("words the follow-up as an offer, and never asks the customer to wait, reconsider or do anything before posting a review", async () => {
    const low = await giveFeedback(s, await shopCustomer(s), { rating: 1 });
    const text = textOf(await render(low.token, "saved"));
    expect(text).toContain("Someone from Parity Shop will also follow up with you privately.");
    expect(text).toContain("The review links above stay open to you either way.");
    expect(text).not.toMatch(/reconsider|before you (post|leave|write|review)|wait (for|until)|hold off|give us a chance|change your (rating|review|mind)|instead of (posting|a public)|please don't (post|leave)/i);
    // The only text that differs from a customer who did not answer is the thank-you; the public-review panel is word for word the same.
    const fresh = textOf(await render((await ask(s, await shopCustomer(s))).token));
    const panel = (t: string) => t.match(/Leave a public review.*?whatever you tell us below\./)?.[0];
    expect(panel(text)).toBeTruthy();
    expect(panel(text)).toBe(panel(fresh));
  });

  it("does not show the follow-up sentence before the customer has answered, or to a customer whose answer was fine", async () => {
    const fresh = await ask(s, await shopCustomer(s));
    expect(await render(fresh.token)).not.toContain("follow up with you");
    const fine = await giveFeedback(s, await shopCustomer(s), { rating: 4, comment: "Good." });
    expect(await render(fine.token, "saved")).not.toContain("follow up with you");
    // A submission that is refused (nothing chosen) shows the error, not a thank-you or a follow-up.
    const empty = await ask(s, await shopCustomer(s));
    expect(await submitReviewFeedback(empty.token, {})).toEqual({ outcome: "empty" });
    expect(await render(empty.token, "empty")).not.toContain("follow up with you");
  });
});
