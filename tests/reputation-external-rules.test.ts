// The pure rules behind public reviews: the honest state of each review site, the few numbers computed from what was read, and the life of a reply with who may do what at each
// step. No database, no network.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PROVIDER_LABELS, REVIEW_FILTERS, agoText, isLowPublicReview, providerState, ratingText, summarizeMirror, syncedAgainstReported, weeklyCounts,
  type ConnectionStatus, type MirrorRow, type ProviderFacts,
} from "@/lib/reputation/external";
import {
  OPEN_REPLY_STATUSES, REPLY_EVENT_LABELS, REPLY_STATUSES, REPLY_STATUS_EXPLAIN, REPLY_STATUS_LABELS, SENT_OR_UNKNOWN, approvalStands, canTransitionReply, eventLabel, isEditableReply, isOpenReply,
  replyAbilities, type ReplyFacts, type ReplyStatus,
} from "@/lib/reputation/reply-state";

const facts = (over: Partial<ProviderFacts> = {}): ProviderFacts => ({ provider: "google", environmentReady: true, missing: null, connection: null, simulatedAllowed: false, ...over });
const conn = (status: Exclude<ConnectionStatus, "disconnected">, over: Partial<NonNullable<ProviderFacts["connection"]>> = {}) => ({ status, statusDetail: null, name: "Harbor Dental", simulated: false, ...over });

describe("the honest state of a review site", () => {
  it("says it is not available, in words, while the site has not approved iAcquire, and offers no way to connect", () => {
    const s = providerState(facts({ environmentReady: false, missing: "Google hasn't approved iAcquire's access to Business Profile reviews yet." }));
    expect(s).toMatchObject({ state: "unavailable", label: "Not available yet", canConnect: false, tone: "neutral" });
    expect(s.detail).toMatch(/hasn't approved/);
    expect(providerState(facts({ environmentReady: false })).detail).toMatch(/isn't set up for iAcquire yet/);
  });

  it("offers to connect only when the site is set up, and for Facebook only through a Page that was connected for Social media with the extra permission", () => {
    expect(providerState(facts())).toMatchObject({ state: "available_not_connected", canConnect: true });
    const fb = (over: Partial<ProviderFacts>) => providerState(facts({ provider: "facebook", ...over }));
    expect(fb({ pageConnected: false })).toMatchObject({ state: "available_not_connected", canConnect: false });
    expect(fb({ pageConnected: false }).detail).toMatch(/Social media first/);
    expect(fb({ pageConnected: true, pageLacksPermission: true })).toMatchObject({ state: "needs_permission", canConnect: false, tone: "warning" });
    expect(fb({ pageConnected: true, pageLacksPermission: false })).toMatchObject({ state: "available_not_connected", canConnect: true });
  });

  it("shows each state of a connection for what it is, and a test connection as made-up", () => {
    expect(providerState(facts({ connection: conn("connected") }))).toMatchObject({ state: "connected", tone: "success" });
    expect(providerState(facts({ connection: conn("connected", { simulated: true }) })).detail).toMatch(/test connection: the reviews are samples/);
    expect(providerState(facts({ connection: conn("needs_reauth") }))).toMatchObject({ state: "needs_reauth", tone: "warning", canConnect: true });
    expect(providerState(facts({ connection: conn("revoked") }))).toMatchObject({ state: "revoked", tone: "warning" });
    expect(providerState(facts({ connection: conn("error", { statusDetail: "Google is having trouble." }) }))).toMatchObject({ state: "error", tone: "danger", detail: "Google is having trouble." });
    // Reconnecting is offered only where the site can be reached in this deployment.
    expect(providerState(facts({ environmentReady: false, connection: conn("needs_reauth") })).canConnect).toBe(false);
  });

  it("never says connected for a connection the deployment no longer reads, or for no connection at all (all 96 combinations)", () => {
    const statuses: Array<Exclude<ConnectionStatus, "disconnected"> | null> = [null, "connected", "needs_reauth", "error", "revoked"];
    let combos = 0;
    for (const provider of ["google", "facebook"] as const) {
      for (const environmentReady of [true, false]) {
        for (const status of statuses) {
          for (const simulated of [true, false]) {
            for (const pageConnected of [undefined, true, false]) {
              combos += 1;
              const s = providerState({ provider, environmentReady, missing: null, simulatedAllowed: simulated, pageConnected, connection: status ? conn(status, { simulated }) : null });
              expect(s.state === "connected", `${provider} env=${environmentReady} status=${status}`).toBe(environmentReady && status === "connected");
              expect(s.detail.length).toBeGreaterThan(20);
              expect(s.label).not.toBe("");
            }
          }
        }
      }
    }
    expect(combos).toBe(120);
  });
});

describe("numbers computed from what was read", () => {
  it("counts the live reviews, sets removed ones apart, and averages only the star ratings, to one decimal", () => {
    const rows: MirrorRow[] = [
      { rating: 5, recommends: null, removed: false }, { rating: 4, recommends: null, removed: false }, { rating: 2, recommends: null, removed: false },
      { rating: 1, recommends: null, removed: true }, { rating: null, recommends: true, removed: false }, { rating: null, recommends: false, removed: false },
    ];
    expect(summarizeMirror(rows)).toEqual({ live: 5, removed: 1, rated: 3, average: 3.7, byRating: { 1: 0, 2: 1, 3: 0, 4: 1, 5: 1 }, recommended: 1, notRecommended: 1 });
  });

  it("gives no average for no ratings: never a made-up zero", () => {
    expect(summarizeMirror([])).toMatchObject({ live: 0, rated: 0, average: null });
    expect(summarizeMirror([{ rating: null, recommends: true, removed: false }])).toMatchObject({ live: 1, rated: 0, average: null, recommended: 1 });
  });

  it("is the same whether reviews are listed one by one or counted in groups (300 seeded sets)", () => {
    let seed = 7;
    const next = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (let i = 0; i < 300; i += 1) {
      const groups: MirrorRow[] = [];
      for (let g = 0; g < 1 + Math.floor(next() * 6); g += 1) {
        const star = next() < 0.8;
        groups.push({ rating: star ? 1 + Math.floor(next() * 5) : null, recommends: star ? null : next() < 0.5, removed: next() < 0.2, n: 1 + Math.floor(next() * 40) });
      }
      const expanded = groups.flatMap((g) => Array.from({ length: g.n ?? 1 }, () => ({ rating: g.rating, recommends: g.recommends, removed: g.removed })));
      expect(summarizeMirror(groups), JSON.stringify(groups)).toEqual(summarizeMirror(expanded));
    }
  });

  it("sets what the site reports beside what was read, and never adds them together", () => {
    expect(syncedAgainstReported("Google", "review", 9, 12)).toBe("Google reports 12 reviews; 9 read so far.");
    expect(syncedAgainstReported("Google", "review", 12, 12)).toBe("12 reviews read, the same as Google reports.");
    expect(syncedAgainstReported("Google", "review", 1, null)).toBe("1 review read. Google doesn't report a total.");
    expect(syncedAgainstReported("Facebook", "recommendation", 14, 12)).toMatch(/14 recommendations read; Facebook now reports 12\. Some have been removed/);
    expect(syncedAgainstReported("Google", "review", 0, 0)).toBe("0 reviews read, the same as Google reports.");
  });

  it("decides which public reviews are low: stars at or below the level, or a recommendation withdrawn", () => {
    for (let level = 1; level <= 4; level += 1) for (let stars = 1; stars <= 5; stars += 1) expect(isLowPublicReview({ rating: stars, recommends: null }, level)).toBe(stars <= level);
    expect(isLowPublicReview({ rating: null, recommends: false }, 3)).toBe(true);
    expect(isLowPublicReview({ rating: null, recommends: true }, 3)).toBe(false);
    expect(isLowPublicReview({ rating: null, recommends: null }, 3)).toBe(false);
    expect(ratingText(4, null)).toBe("4 of 5 stars");
    expect(ratingText(null, true)).toBe("Recommends");
    expect(ratingText(null, false)).toBe("Doesn't recommend");
    expect(ratingText(null, null)).toBe("No rating");
  });

  it("counts new reviews per week, oldest first, with every week present and a quiet week as zero", () => {
    const now = new Date("2026-10-24T10:00:00Z"); // a Saturday
    const weeks = weeklyCounts(["2026-10-24T01:00:00Z", "2026-10-19T00:00:00Z", "2026-10-18T23:59:00Z", new Date("2026-09-01T12:00:00Z"), null, "not a date", "2025-01-01T00:00:00Z"], now, 12);
    expect(weeks).toHaveLength(12);
    expect(weeks.at(-1)).toEqual({ weekStart: "2026-10-19", count: 2 });
    expect(weeks.at(-2)).toEqual({ weekStart: "2026-10-12", count: 1 });
    expect(weeks.find((w) => w.weekStart === "2026-08-31")?.count).toBe(1);
    expect(weeks.reduce((t, w) => t + w.count, 0)).toBe(4);
    expect(weeks.map((w) => w.weekStart)).toEqual([...weeks.map((w) => w.weekStart)].sort());
  });

  it("says how long ago something was read, and 'never' when it was not", () => {
    const now = new Date("2026-10-24T12:00:00Z");
    expect(agoText(null, now)).toBe("never");
    expect(agoText("2026-10-24T11:59:30Z", now)).toBe("just now");
    expect(agoText("2026-10-24T11:30:00Z", now)).toBe("30 minutes ago");
    expect(agoText("2026-10-24T09:00:00Z", now)).toBe("3 hours ago");
    expect(agoText("2026-10-20T12:00:00Z", now)).toBe("4 days ago");
    expect(REVIEW_FILTERS).toEqual(["all", "needs_reply", "low", "replied", "removed"]);
    expect(PROVIDER_LABELS).toEqual({ google: "Google", facebook: "Facebook" });
  });
});

describe("the life of a reply", () => {
  it("has a plain label and explanation for every status, and a name for every step in its history", () => {
    for (const s of REPLY_STATUSES) {
      expect(REPLY_STATUS_LABELS[s], s).toBeTruthy();
      expect(REPLY_STATUS_EXPLAIN[s].length, s).toBeGreaterThan(15);
    }
    expect(eventLabel("approved")).toBe("Approved");
    expect(eventLabel("something_new")).toBe("Something new");
    expect(Object.keys(REPLY_EVENT_LABELS)).toEqual(expect.arrayContaining(["created", "ai_drafted", "edited", "submitted", "approved", "posting", "posted", "outcome_unknown", "review_changed"]));
  });

  it("allows only the moves the rules name, and ends in posted, rejected or cancelled", () => {
    const allowed: Record<ReplyStatus, ReplyStatus[]> = {
      draft: ["pending_approval", "cancelled"],
      pending_approval: ["approved", "changes_requested", "rejected", "draft", "cancelled"],
      changes_requested: ["pending_approval", "draft", "cancelled"],
      approved: ["posting", "draft", "cancelled"],
      posting: ["posted", "failed", "needs_reconciliation"],
      failed: ["posting", "draft", "cancelled"],
      needs_reconciliation: ["posted", "failed"],
      posted: [], rejected: [], cancelled: [],
    };
    for (const from of REPLY_STATUSES) for (const to of REPLY_STATUSES) expect(canTransitionReply(from, to), `${from} -> ${to}`).toBe(allowed[from].includes(to));
  });

  it("can only reach 'posted' through 'posting' or a check of an unknown result, and only reach 'posting' from an approval (2,000 random walks)", () => {
    let seed = 99;
    const next = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (let walk = 0; walk < 2000; walk += 1) {
      let at: ReplyStatus = "draft";
      let approvedBefore = false;
      for (let step = 0; step < 14; step += 1) {
        const options = REPLY_STATUSES.filter((s) => canTransitionReply(at, s));
        if (!options.length) break;
        const to = options[Math.floor(next() * options.length)];
        if (to === "posted") expect(["posting", "needs_reconciliation"], `${at} -> posted`).toContain(at);
        if (to === "posting") {
          expect(["approved", "failed"], `${at} -> posting`).toContain(at);
          expect(approvedBefore, "approved before posting").toBe(true);
        }
        if (to === "approved") expect(at).toBe("pending_approval");
        if (to === "approved") approvedBefore = true;
        if (to === "draft") approvedBefore = false; // an edit sends it back and voids the approval
        at = to;
      }
    }
  });

  it("matches the database: the open statuses are exactly those the one-open-reply index covers, and a sent reply cannot be edited or quietly cancelled", () => {
    const sql = readFileSync("supabase/migrations/0095_external_reviews.sql", "utf8");
    const m = /review_replies_open_idx on review_replies \(review_id\) where status in \(([^)]+)\)/.exec(sql);
    expect(m).not.toBeNull();
    const inIndex = [...m![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
    expect([...OPEN_REPLY_STATUSES].sort()).toEqual(inIndex);
    for (const s of REPLY_STATUSES) expect(isOpenReply(s), s).toBe(OPEN_REPLY_STATUSES.includes(s));
    for (const s of SENT_OR_UNKNOWN) {
      expect(isEditableReply(s), s).toBe(false);
      expect(canTransitionReply(s, "cancelled"), s).toBe(false);
    }
    expect(approvalStands({ version: 3, approvedVersion: 3, approvedHashMatches: true })).toBe(true);
    expect(approvalStands({ version: 4, approvedVersion: 3, approvedHashMatches: true })).toBe(false);
    expect(approvalStands({ version: 3, approvedVersion: 3, approvedHashMatches: false })).toBe(false);
    expect(approvalStands({ version: 1, approvedVersion: null, approvedHashMatches: true })).toBe(false);
  });
});

describe("who may do what with a reply", () => {
  const base: ReplyFacts = { reply: null, userId: "u-author", canDraft: true, canPublish: false, canAi: true, reviewLive: true, postable: true, postableReason: null, enabled: true };
  const reply = (status: ReplyStatus, over: Partial<NonNullable<ReplyFacts["reply"]>> = {}): ReplyFacts["reply"] => ({ status, version: 2, approvedVersion: null, authorId: "u-author", origin: "human", ...over });
  const can = (f: Partial<ReplyFacts>) => replyAbilities({ ...base, ...f });
  const onlyTrue = (a: ReturnType<typeof replyAbilities>) => Object.entries(a).filter(([k, v]) => k !== "note" && v === true).map(([k]) => k).sort();

  it("lets a drafter start a reply, with or without the AI assist, and nothing more", () => {
    expect(onlyTrue(can({}))).toEqual(["start", "startWithAi"]);
    expect(onlyTrue(can({ canAi: false }))).toEqual(["start"]);
    expect(onlyTrue(can({ canDraft: false }))).toEqual([]);
    expect(can({ canDraft: false }).note).toMatch(/can't write replies/);
  });

  it("offers nothing where public reviews are off, or the review is gone or its connection needs attention", () => {
    expect(onlyTrue(can({ enabled: false }))).toEqual([]);
    expect(can({ enabled: false }).note).toMatch(/isn't switched on/);
    expect(onlyTrue(can({ reviewLive: false }))).toEqual([]);
    expect(can({ reviewLive: false }).note).toMatch(/no longer on the review site/);
  });

  it("lets the author edit, send for approval and cancel a draft, and not approve it", () => {
    expect(onlyTrue(can({ reply: reply("draft") }))).toEqual(["cancel", "edit", "submit"]);
    expect(onlyTrue(can({ reply: reply("changes_requested") }))).toEqual(["cancel", "edit", "submit"]);
  });

  it("keeps another person's draft from a drafter, and gives it to the owner or a manager", () => {
    expect(onlyTrue(can({ reply: reply("draft", { authorId: "u-other" }) }))).toEqual([]);
    expect(onlyTrue(can({ reply: reply("draft", { authorId: "u-other" }), canPublish: true, userId: "u-boss" }))).toEqual(["cancel", "edit", "submit"]);
  });

  it("lets only the owner or a manager decide, and tells anyone else why they can't", () => {
    const pending = reply("pending_approval");
    expect(onlyTrue(can({ reply: pending, canPublish: true }))).toEqual(["approve", "cancel", "edit", "reject", "requestChanges"]);
    const author = can({ reply: pending });
    expect(author.approve || author.reject || author.requestChanges).toBe(false);
    expect(author.note).toBe("Only the owner or a manager can approve a reply.");
    expect(can({ reply: pending, canPublish: true, reviewLive: false }).approve).toBe(false);
  });

  it("lets the owner or a manager post only the approved version, only where posting works, and offers 'I posted it myself' where it does not", () => {
    const approved = reply("approved", { approvedVersion: 2 });
    expect(can({ reply: approved, canPublish: true }).post).toBe(true);
    expect(can({ reply: approved, canPublish: false }).post).toBe(false);
    const stale = can({ reply: reply("approved", { approvedVersion: 1 }), canPublish: true });
    expect(stale.post).toBe(false);
    expect(stale.note).toMatch(/earlier version/);
    const notPostable = can({ reply: approved, canPublish: true, postable: false, postableReason: "Posting replies to Google isn't switched on for iAcquire yet." });
    expect(notPostable).toMatchObject({ post: false, markPosted: true });
    expect(notPostable.note).toMatch(/isn't switched on/);
    expect(can({ reply: reply("failed", { approvedVersion: 2 }), canPublish: true }).post).toBe(true);
  });

  it("never lets a reply that is being sent, or whose result is unknown, be edited, cancelled or sent again; a person can say what happened", () => {
    expect(onlyTrue(can({ reply: reply("posting", { approvedVersion: 2 }), canPublish: true }))).toEqual([]);
    expect(onlyTrue(can({ reply: reply("needs_reconciliation", { approvedVersion: 2 }), canPublish: true }))).toEqual(["markNotPosted", "markPosted"]);
    expect(onlyTrue(can({ reply: reply("needs_reconciliation", { approvedVersion: 2 }), canPublish: false }))).toEqual([]);
  });

  it("treats a finished reply as closed: a new one can be started, nothing else", () => {
    for (const s of ["posted", "rejected", "cancelled"] as const) expect(onlyTrue(can({ reply: reply(s, { approvedVersion: 2 }) })), s).toEqual(["start", "startWithAi"]);
  });

  it("gives iAcquire support in a write session the drafter's rights and never the publisher's", () => {
    // (A support session is canDraft with canPublish false and no AI assist.)
    const agency = { userId: "u-agency", canDraft: true, canPublish: false, canAi: false };
    expect(onlyTrue(can({ ...agency }))).toEqual(["start"]);
    const pending = can({ ...agency, reply: reply("pending_approval", { authorId: "u-agency" }) });
    expect(pending.approve || pending.reject || pending.post).toBe(false);
    expect(can({ ...agency, reply: reply("approved", { authorId: "u-agency", approvedVersion: 2 }) }).post).toBe(false);
  });
});
