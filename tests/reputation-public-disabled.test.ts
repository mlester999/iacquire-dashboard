// The platform-wide emergency switch for the customer's review page (REVIEWS_PUBLIC_DISABLED): /r/<token> and its two forms answer "temporarily unavailable" for every workspace
// before any database read, and nothing is recorded. Every database entry point is counted, so "before any read" is checked and not assumed.
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

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

const reads = vi.hoisted(() => ({ n: 0 }));
vi.mock("@/server/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/db")>();
  const counted = <A extends unknown[], R>(fn: (...a: A) => R) => (...a: A): R => {
    reads.n += 1;
    return fn(...a);
  };
  return { ...actual, withSystem: counted(actual.withSystem), readSystem: counted(actual.readSystem), withServiceRole: counted(actual.withServiceRole), withUser: counted(actual.withUser), withSiteRuntime: counted(actual.withSiteRuntime) };
});

import { env, resetEnvCache } from "@/server/env";
import { withSystem } from "@/server/db";
import { loadReviewPage, recordReviewClick, submitReviewFeedback } from "@/server/crm/reviews";
import { POST as postFeedback, GET as getFeedback } from "@/app/api/public/reviews/feedback/route";
import { POST as postClick } from "@/app/api/public/reviews/click/route";
import ReviewRequestPage from "@/app/r/[token]/page";
import { ask, one, reputationShop, shopCustomer, type ReputationShop } from "./support/reputation";

let s: ReputationShop;
beforeAll(async () => {
  s = await reputationShop("Public Switch Shop");
});

async function withSwitch<T>(on: boolean, fn: () => Promise<T>): Promise<T> {
  const before = process.env.REVIEWS_PUBLIC_DISABLED;
  process.env.REVIEWS_PUBLIC_DISABLED = on ? "true" : "false";
  resetEnvCache();
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.REVIEWS_PUBLIC_DISABLED;
    else process.env.REVIEWS_PUBLIC_DISABLED = before;
    resetEnvCache();
  }
}
afterEach(() => resetEnvCache());

const post = (path: string, fields: Record<string, string>) =>
  new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
const opened = (id: string) => one<{ opened_at: Date | null; clicked_at: Date | null; status: string }>("select opened_at, clicked_at, status from crm_review_requests where id = $1", [id]);
const feedbackRows = async (requestId: string) => (await withSystem((db) => db.query("select 1 from customer_feedback where review_request_id = $1", [requestId]))).rows.length;

describe("REVIEWS_PUBLIC_DISABLED", () => {
  it("is off by default, so the page works as usual", async () => {
    expect(env().REVIEWS_PUBLIC_DISABLED).toBe(false);
    const a = await ask(s, await shopCustomer(s));
    expect((await loadReviewPage(a.token)).state).toBe("open");
  });

  it("answers 'temporarily unavailable' on the page, the feedback form and the review-site click, without one database read, and records nothing", async () => {
    const a = await ask(s, await shopCustomer(s));
    await withSwitch(true, async () => {
      expect(env().REVIEWS_PUBLIC_DISABLED).toBe(true);
      const before = reads.n;
      expect(await loadReviewPage(a.token)).toEqual({ state: "disabled", closedReason: null, kind: "review", scale: "csat5", business: null, destinations: [], feedback: null });
      expect(await submitReviewFeedback(a.token, { rating: "1", comment: "Switched off." })).toEqual({ outcome: "unavailable" });
      expect(await recordReviewClick(a.token, s.google)).toBeNull();
      const feedback = await postFeedback(post("/api/public/reviews/feedback", { t: a.token, rating: "1", comment: "Switched off." }));
      expect(feedback.status).toBe(303);
      expect(feedback.headers.get("location")).toBe(`/r/${a.token}?r=unavailable`);
      const click = await postClick(post("/api/public/reviews/click", { t: a.token, d: s.google }));
      expect(click.status).toBe(303);
      expect(click.headers.get("location")).toBe(`/r/${a.token}?r=unavailable`);
      for (const res of [feedback, click]) expect(res.headers.get("cache-control")).toBe("no-store");
      expect(reads.n).toBe(before);
    });
    // Nothing was recorded: the request was not opened, no review site was marked as clicked, no feedback was saved.
    expect(await opened(a.requestId)).toMatchObject({ opened_at: null, clicked_at: null, status: "queued" });
    expect(await feedbackRows(a.requestId)).toBe(0);
  });

  it("shows the visitor the same plain notice for every address, valid or not, and no business details", async () => {
    const a = await ask(s, await shopCustomer(s));
    await withSwitch(true, async () => {
      for (const token of [a.token, "A".repeat(43), "not-a-token"]) {
        const html = renderToStaticMarkup(await ReviewRequestPage({ params: Promise.resolve({ token }), searchParams: Promise.resolve({}) }));
        const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        expect(text, token).toContain("Feedback is temporarily unavailable");
        expect(text).toContain("Please try again later");
        expect(text).not.toContain("Public Switch Shop");
        expect(html).not.toContain("/api/public/reviews/");
      }
      // Opening the address of the feedback endpoint only goes back to the page, switch or not.
      const back = await getFeedback(new Request(`http://localhost/api/public/reviews/feedback?t=${a.token}`));
      expect(back.headers.get("location")).toBe(`/r/${a.token}`);
    });
  });

  it("works again the moment the switch is turned off, for a link that was never touched while it was on", async () => {
    const a = await ask(s, await shopCustomer(s));
    await withSwitch(true, async () => {
      expect((await loadReviewPage(a.token)).state).toBe("disabled");
    });
    const page = await loadReviewPage(a.token);
    expect(page.state).toBe("open");
    expect(page.destinations.length).toBeGreaterThan(0);
    expect(await submitReviewFeedback(a.token, { rating: "5" })).toMatchObject({ outcome: "saved" });
  });
});
