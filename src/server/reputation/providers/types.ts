import { ProviderError } from "@/server/social/providers/types";
import type { ReviewProvider as Site } from "@/lib/reputation/external";

// The contract between the review sync and a review site. The sync and the reply service know nothing about Google or Facebook: they ask an adapter for one page of reviews at a
// time, and for a reply to be posted or looked up. Every adapter is written against a replaceable HTTP layer and has only ever run against that, never against the real service.
//
// What an adapter may NOT offer, by design: creating, changing or deleting a review or a rating. There is no such method, so no code path can add one.

export { ProviderError };

export type ReviewAdapter = "google" | "meta" | "simulated";

/** A connection's decrypted credentials. Held in memory only for the length of a call. Google: the refresh token. Facebook: the Page's access token (from the Social connection). */
export interface ReviewCredentials {
  refreshToken?: string;
  accessToken?: string;
}

export interface LocationRef {
  provider: Site;
  /** Google: "accounts/123". Facebook: the Page id. */
  accountId: string | null;
  /** Google: "locations/456". Facebook: the Page id. */
  locationId: string;
}

/** One review as a site returned it. */
export interface ProviderReview {
  providerReviewId: string;
  rating: number | null;
  recommends: boolean | null;
  reviewerName: string | null;
  reviewerAnonymous: boolean;
  comment: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  /** A reply that is on the site now, whoever wrote it. */
  reply: { text: string; at: Date | null } | null;
}

export interface ReviewPage {
  reviews: ProviderReview[];
  nextPageToken: string | null;
  /** What the site says about its own totals, when it says. Kept apart from what was read. */
  reportedRating: number | null;
  reportedCount: number | null;
  /** Entries the site returned that could not be stored (no rating and no recommendation, or no id). */
  skipped: number;
}

export interface ReviewHealth {
  status: "connected" | "needs_reauth" | "error" | "needs_permission";
  detail: string;
  /** The permissions the site reports, when it says; empty means "not reported", not "none". */
  scopes: string[];
  /** Replies can be posted with this access, in this environment. */
  canReply: boolean;
}

/** What a read of one review's reply found. `uncertain` means the site's answer cannot settle it (a list too long to read, several that fit). */
export type ReplyRead = { state: "found"; text: string; at: Date | null } | { state: "absent" } | { state: "uncertain" };

export interface ReviewProvider {
  readonly adapter: ReviewAdapter;
  /** Whether a reply can be posted with this adapter in this environment, and if not, why, in plain words. */
  replySupport(): { ok: true } | { ok: false; reason: string };
  health(creds: ReviewCredentials, loc: LocationRef): Promise<ReviewHealth>;
  /** One page of the site's reviews, newest first. Throws ProviderError. */
  fetchPage(creds: ReviewCredentials, loc: LocationRef, pageToken: string | null, pageSize: number): Promise<ReviewPage>;
  /**
   * Posts a reply to one review. Throws ProviderError: `unknown_outcome` when the request may have reached the site but no answer came back (the caller then asks
   * `readReply` before anything is sent again).
   */
  postReply(creds: ReviewCredentials, loc: LocationRef, providerReviewId: string, text: string): Promise<{ postedAt: Date | null }>;
  /** Asks the site whether this review carries this reply. Used to settle a lost answer and to confirm a posted reply. Throws ProviderError. */
  readReply(creds: ReviewCredentials, loc: LocationRef, providerReviewId: string, text: string): Promise<ReplyRead>;
}

/** The text of a reply the way sites compare it: whitespace squashed. */
export const squashReply = (s: string | null | undefined) => String(s ?? "").replace(/\s+/g, " ").trim();
