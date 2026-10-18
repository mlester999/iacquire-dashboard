// Pure labels and checks for the Reviews screens, the customer page and the workflow editor's "Request a review" step. No I/O and no
// "use client", so server views, client components and tests share them. The rules themselves live in src/server/crm/reviews.ts.
import type { Channel } from "@/lib/messaging";

export type ReviewPlatformKey = "google" | "facebook" | "yelp" | "tripadvisor" | "trustpilot" | "other";
export const PLATFORM_LABELS: Record<ReviewPlatformKey, string> = {
  google: "Google", facebook: "Facebook", yelp: "Yelp", tripadvisor: "Tripadvisor", trustpilot: "Trustpilot", other: "Other site",
};
export const PLATFORM_KEYS = Object.keys(PLATFORM_LABELS) as ReviewPlatformKey[];
/** What a link for each site usually looks like, as a hint in the form. */
export const PLATFORM_HINTS: Record<ReviewPlatformKey, string> = {
  google: "From Google Business Profile → Ask for reviews, for example https://g.page/r/…/review.",
  facebook: "Your Page's reviews tab, for example https://www.facebook.com/yourpage/reviews.",
  yelp: "Your business page on Yelp, for example https://www.yelp.com/writeareview/biz/….",
  tripadvisor: "Your listing's review page on Tripadvisor.",
  trustpilot: "Your Trustpilot review page, for example https://www.trustpilot.com/evaluate/yourdomain.com.",
  other: "Any https:// page where customers can leave a public review.",
};

export type RequestStatusKey = "pending" | "queued" | "sent" | "opened" | "feedback_received" | "review_link_clicked" | "failed" | "cancelled";
export const REQUEST_STATUS_LABELS: Record<RequestStatusKey, string> = {
  pending: "Preparing", queued: "Waiting to send", sent: "Sent", opened: "Opened", feedback_received: "Feedback received", review_link_clicked: "Opened a review site",
  failed: "Not sent", cancelled: "Cancelled",
};
export const REQUEST_STATUS_TONES: Record<RequestStatusKey, "neutral" | "primary" | "success" | "warning" | "danger" | "violet"> = {
  pending: "neutral", queued: "neutral", sent: "primary", opened: "violet", feedback_received: "success", review_link_clicked: "success", failed: "danger", cancelled: "neutral",
};

export type FollowUpKey = "new" | "acknowledged" | "escalated" | "resolved";
export const FOLLOW_UP_LABELS: Record<FollowUpKey, string> = { new: "New", acknowledged: "Acknowledged", escalated: "Escalated", resolved: "Resolved" };
export const FOLLOW_UP_TONES: Record<FollowUpKey, "neutral" | "primary" | "success" | "warning" | "danger"> = { new: "primary", acknowledged: "neutral", escalated: "warning", resolved: "success" };

export const RATING_WORDS: Record<number, string> = { 1: "Poor", 2: "Fair", 3: "Good", 4: "Very good", 5: "Excellent" };

const REVIEW_LINK = /\{\{\s*review\.link\s*\}\}/;

/**
 * A template that can be used for a review request: service purpose, and {{review.link}} in its text (never its subject: the link is
 * filled in only where the provider receives it). The same rule as hasReviewLinkToken in src/server/crm/reviews.ts.
 */
export function isReviewTemplate(t: { purpose: "service" | "marketing"; subject: string | null; body: string; channel: Channel | null }): boolean {
  return t.purpose === "service" && t.channel !== null && REVIEW_LINK.test(t.body) && !(t.subject ? REVIEW_LINK.test(t.subject) : false);
}
