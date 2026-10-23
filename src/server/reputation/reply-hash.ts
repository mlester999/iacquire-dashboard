import "server-only";
import crypto from "node:crypto";
import { cleanReplyBody } from "@/lib/reputation/reply-rules";

// What a person's approval of a reply covers. The hash is made of the review's identity and what it said, the version of the reply and its exact words. It is stored when the
// reply is approved and made again, from the review as it is now and the words as they are now, at the moment of posting: a reply is posted only if the two are equal.
// That keeps three things from slipping past a person who read the reply: a change to the words, a reply moved to a different review, and a review that was edited after
// the reply was approved (an answer written for one thing is not posted under another).

const squash = (s: string | null | undefined) => String(s ?? "").replace(/\s+/g, " ").trim();

/** What the review said, as a hash: the stars or recommendation and the reviewer's words. The reviewer's name is not part of it. */
export function reviewFingerprint(r: { rating: number | null; recommends: boolean | null; comment: string | null }): string {
  return crypto.createHash("sha256").update(JSON.stringify(["review", 1, r.rating, r.recommends, squash(r.comment)]), "utf8").digest("hex");
}

export interface ApprovalFacts {
  orgId: string;
  connectionId: string;
  reviewId: string;
  providerReviewId: string;
  /** reviewFingerprint of the review as it is when the hash is made. */
  fingerprint: string;
  version: number;
  body: string;
}

export function replyApprovalHash(f: ApprovalFacts): string {
  const canonical = JSON.stringify(["reply", 1, f.orgId, f.connectionId, f.reviewId, f.providerReviewId, f.fingerprint, f.version, cleanReplyBody(f.body)]);
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}
