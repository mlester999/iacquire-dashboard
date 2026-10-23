import "server-only";
import { ProviderError, squashReply, type LocationRef, type ProviderReview, type ReplyRead, type ReviewCredentials, type ReviewHealth, type ReviewPage, type ReviewProvider } from "@/server/reputation/providers/types";

// A stand-in for a review site that lives inside this process. It reaches nothing. It exists so the whole pipeline (connecting, reading, the mirror, replies, reconciliation,
// revocation) can be tested and clicked through without a Google or Meta approval, and it refuses to run in production (see providers/index.ts).
//
// Every review it returns is made up, and the rows they become carry a "Simulated" badge. A location nobody seeded returns a fixed set of obviously fake sample reviews, so a
// person trying the screens in a test workspace sees something; tests seed what they need and get exactly that. Whatever was done to it is visible in `simulatedReviews`,
// which is what the duplicate-protection tests count.

type Step = "health" | "fetch" | "reply" | "read";

interface SimReview {
  id: string;
  rating: number | null;
  recommends: boolean | null;
  name: string | null;
  anonymous: boolean;
  comment: string | null;
  createdAt: Date;
  updatedAt: Date;
  reply: { text: string; at: Date } | null;
}

interface SimLocation {
  reviews: SimReview[];
  reportedCount: number | null;
  reportedRating: number | null;
}

interface World {
  locations: Map<string, SimLocation>;
  failures: Array<{ step: Step; error: ProviderError }>;
  lose: Step[];
  revoked: Set<string>;
  log: Array<{ step: Step; location: string; text?: string }>;
  replySupport: boolean;
}

const fresh = (): World => ({ locations: new Map(), failures: [], lose: [], revoked: new Set(), log: [], replySupport: true });
let world: World = fresh();

export interface SimSeed {
  id: string;
  rating?: number | null;
  recommends?: boolean | null;
  name?: string | null;
  anonymous?: boolean;
  comment?: string | null;
  createdAt?: Date | string;
  updatedAt?: Date | string;
  reply?: { text: string; at?: Date | string } | null;
}

const toSim = (s: SimSeed): SimReview => {
  const created = new Date(s.createdAt ?? Date.now());
  return {
    id: s.id,
    rating: s.rating === undefined ? 5 : s.rating,
    recommends: s.recommends ?? null,
    name: s.anonymous ? null : s.name === undefined ? "Sample Reviewer" : s.name,
    anonymous: s.anonymous ?? false,
    comment: s.comment === undefined ? null : s.comment,
    createdAt: created,
    updatedAt: new Date(s.updatedAt ?? created),
    reply: s.reply ? { text: s.reply.text, at: new Date(s.reply.at ?? created) } : null,
  };
};

/** The fixed sample reviews a location nobody seeded returns. Fake people, fake words, fixed dates: reading them twice changes nothing. */
function samples(locationId: string): SimLocation {
  const mk = (n: number, rating: number, comment: string | null, daysAgo: number, reply?: string): SimSeed => ({
    id: `sim-${locationId}-${n}`.slice(0, 190), rating, name: `Sample Reviewer ${n}`, comment,
    createdAt: new Date(Date.UTC(2026, 9, 20) - daysAgo * 86_400_000),
    ...(reply ? { reply: { text: reply, at: new Date(Date.UTC(2026, 9, 20) - (daysAgo - 1) * 86_400_000) } } : {}),
  });
  const list: SimSeed[] = [
    mk(1, 5, "SAMPLE TEXT: this is a made-up review from the simulated review site.", 2),
    mk(2, 2, "SAMPLE TEXT: a made-up low review, so the reply flow can be tried.", 4),
    mk(3, 4, "SAMPLE TEXT: another made-up review.", 9, "Thank you for taking the time to write. We're glad it went well."),
    mk(4, 5, null, 16),
    mk(5, 1, "SAMPLE TEXT: a made-up one-star review.", 30),
    mk(6, 3, "SAMPLE TEXT: a made-up three-star review.", 45),
  ];
  // The site reports two more than were returned, so the screen's "reported against read" line can be seen.
  return { reviews: list.map(toSim), reportedCount: list.length + 2, reportedRating: 3.4 };
}

const locationOf = (id: string): SimLocation => {
  let l = world.locations.get(id);
  if (!l) {
    l = samples(id);
    world.locations.set(id, l);
  }
  return l;
};

export const simulatedReviews = {
  reset() {
    world = fresh();
  },
  /** Replaces what a location holds. `reportedCount` and `reportedRating` default to what is seeded (the count) and null (the rating). */
  seed(locationId: string, reviews: SimSeed[], reported: { count?: number | null; rating?: number | null } = {}) {
    world.locations.set(locationId, { reviews: reviews.map(toSim), reportedCount: reported.count === undefined ? reviews.length : reported.count, reportedRating: reported.rating ?? null });
  },
  add(locationId: string, review: SimSeed) {
    const l = locationOf(locationId);
    l.reviews.unshift(toSim(review));
    if (l.reportedCount !== null) l.reportedCount += 1;
  },
  /** The reviewer or the site removes a review. */
  remove(locationId: string, id: string) {
    const l = locationOf(locationId);
    l.reviews = l.reviews.filter((r) => r.id !== id);
    if (l.reportedCount !== null) l.reportedCount = Math.max(0, l.reportedCount - 1);
  },
  edit(locationId: string, id: string, patch: Partial<SimSeed>) {
    const r = locationOf(locationId).reviews.find((x) => x.id === id);
    if (!r) return;
    if (patch.rating !== undefined) r.rating = patch.rating;
    if (patch.comment !== undefined) r.comment = patch.comment;
    r.updatedAt = new Date(patch.updatedAt ?? Date.now());
  },
  /** Somebody else (the business on the site itself) replies. */
  setReply(locationId: string, id: string, text: string | null) {
    const r = locationOf(locationId).reviews.find((x) => x.id === id);
    if (r) r.reply = text === null ? null : { text, at: new Date() };
  },
  replyOf(locationId: string, id: string): string | null {
    return locationOf(locationId).reviews.find((r) => r.id === id)?.reply?.text ?? null;
  },
  /** The next time the site is asked this, it refuses with this error (once). */
  failNext(step: Step, error: ProviderError) {
    world.failures.push({ step, error });
  },
  /** The next time the site is asked to do this, it does the work and then never answers. */
  loseResponseNext(step: Step) {
    world.lose.push(step);
  },
  revoke(token: string) {
    world.revoked.add(token);
  },
  /** Turns the site's ability to take replies off (as when the access granted lacks it). */
  setReplySupport(on: boolean) {
    world.replySupport = on;
  },
  calls(step?: Step): number {
    return world.log.filter((l) => !step || l.step === step).length;
  },
  /** Every reply the site was asked to post, in order. */
  replyCalls(): Array<{ location: string; text: string }> {
    return world.log.filter((l) => l.step === "reply").map((l) => ({ location: l.location, text: l.text ?? "" }));
  },
  reviewsOf(locationId: string): number {
    return locationOf(locationId).reviews.length;
  },
};

function enter(step: Step, location: string, text?: string) {
  world.log.push({ step, location, text });
  const i = world.failures.findIndex((f) => f.step === step);
  if (i >= 0) throw world.failures.splice(i, 1)[0].error;
}

function maybeLose(step: Step) {
  const i = world.lose.indexOf(step);
  if (i >= 0) {
    world.lose.splice(i, 1);
    throw new ProviderError("unknown_outcome", "The review site did not confirm whether it took the reply. It is being checked and will not be sent again until that is known.");
  }
}

function checkToken(creds: ReviewCredentials) {
  const token = creds.refreshToken ?? creds.accessToken ?? "";
  if (world.revoked.has(token)) throw new ProviderError("auth", "The review site no longer accepts this sign-in. Reconnect it.", { needsReauth: true });
}

const asProviderReview = (r: SimReview): ProviderReview => ({
  providerReviewId: r.id, rating: r.rating, recommends: r.recommends, reviewerName: r.name, reviewerAnonymous: r.anonymous, comment: r.comment,
  createdAt: r.createdAt, updatedAt: r.updatedAt, reply: r.reply ? { text: r.reply.text, at: r.reply.at } : null,
});

export const simulatedReviewProvider: ReviewProvider = {
  adapter: "simulated",

  replySupport() {
    return world.replySupport ? { ok: true } : { ok: false, reason: "The simulated review site is set not to take replies." };
  },

  async health(creds, loc: LocationRef): Promise<ReviewHealth> {
    enter("health", loc.locationId);
    const revoked = world.revoked.has(creds.refreshToken ?? creds.accessToken ?? "");
    return {
      status: revoked ? "needs_reauth" : "connected",
      detail: revoked ? "The review site no longer accepts this sign-in." : "Connected (simulated).",
      scopes: revoked ? [] : ["simulated.reviews"],
      canReply: !revoked && world.replySupport,
    };
  },

  async fetchPage(creds, loc, pageToken, pageSize): Promise<ReviewPage> {
    checkToken(creds);
    enter("fetch", loc.locationId);
    const l = locationOf(loc.locationId);
    const offset = pageToken ? Math.max(0, Number.parseInt(pageToken, 10) || 0) : 0;
    const size = Math.max(1, Math.min(pageSize, 50));
    const slice = [...l.reviews].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(offset, offset + size);
    const next = offset + size < l.reviews.length ? String(offset + size) : null;
    return { reviews: slice.map(asProviderReview), nextPageToken: next, reportedRating: l.reportedRating, reportedCount: l.reportedCount, skipped: 0 };
  },

  async postReply(creds, loc, providerReviewId, text) {
    checkToken(creds);
    if (!world.replySupport) throw new ProviderError("blocked", "The simulated review site is set not to take replies.");
    enter("reply", loc.locationId, text);
    const r = locationOf(loc.locationId).reviews.find((x) => x.id === providerReviewId);
    if (!r) throw new ProviderError("invalid_content", "The review site no longer has that review.");
    // Repeatable, like Google's: the same reply twice leaves the same reply.
    r.reply = { text, at: new Date() };
    maybeLose("reply");
    return { postedAt: r.reply.at };
  },

  async readReply(creds, loc, providerReviewId): Promise<ReplyRead> {
    checkToken(creds);
    enter("read", loc.locationId);
    const r = locationOf(loc.locationId).reviews.find((x) => x.id === providerReviewId);
    if (!r) throw new ProviderError("invalid_content", "The review site no longer has that review.");
    return r.reply ? { state: "found", text: squashReply(r.reply.text), at: r.reply.at } : { state: "absent" };
  },
};
