// The life of a social post, and who must approve it. Pure: the server enforces these rules and the interface only reads them.

export const POST_STATUSES = ["draft", "pending_approval", "changes_requested", "approved", "scheduled", "publishing", "needs_reconciliation", "published", "failed", "cancelled", "rejected"] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

export const STATUS_LABELS: Record<PostStatus, string> = {
  draft: "Draft",
  pending_approval: "Waiting for approval",
  changes_requested: "Changes requested",
  approved: "Approved",
  scheduled: "Scheduled",
  publishing: "Publishing",
  needs_reconciliation: "Checking the result",
  published: "Published",
  failed: "Failed",
  cancelled: "Cancelled",
  rejected: "Rejected",
};

/** One line saying what a status means, for the person looking at it. Never softer than the truth. */
export const STATUS_EXPLAIN: Record<PostStatus, string> = {
  draft: "Not sent for approval yet.",
  pending_approval: "A person with approval rights has to look at this before it can be scheduled.",
  changes_requested: "A reviewer asked for changes. Edit it and send it again.",
  approved: "Approved, not scheduled yet.",
  scheduled: "Will be published at the chosen time, if the account is still connected.",
  publishing: "Being sent to the platform now, or waiting to retry.",
  needs_reconciliation: "The platform did not confirm whether this went out. It is being checked, and it will not be sent again until that is known.",
  published: "Confirmed published by the platform.",
  failed: "Not published. See the reason, then retry or edit.",
  cancelled: "Cancelled before it was published.",
  rejected: "Rejected by a reviewer. It will not be published.",
};

/** The id a post carries when a person, not the platform, said it was published (src/server/social/posts.ts resolveUnknown). */
export const MANUAL_PUBLISH_PREFIX = "manual:";
export const isManualPublish = (providerPostId: string | null | undefined) => typeof providerPostId === "string" && providerPostId.startsWith(MANUAL_PUBLISH_PREFIX);

export interface ExplainFacts {
  providerPostId?: string | null;
  /** Publishing to real accounts is switched off in this environment, so a scheduled post waits instead of going out. */
  liveBlocked?: boolean;
  /** The post belongs to a test account: nothing it "publishes" leaves the product. */
  testAccount?: boolean;
}

/** STATUS_EXPLAIN, made true for this post: a published post a person marked by hand is not "confirmed by the platform", and a held or test post says so. */
export function statusExplain(status: PostStatus, facts: ExplainFacts = {}): string {
  if (status === "published") {
    if (facts.testAccount) return "Recorded as published on a test account. Nothing was posted anywhere.";
    if (isManualPublish(facts.providerPostId)) return "Marked as published by a person; the platform did not confirm it.";
  }
  if (status === "scheduled" && facts.liveBlocked) return "Waiting: publishing to real accounts is switched off in this environment, so nothing is sent until iAcquire switches it on.";
  return STATUS_EXPLAIN[status];
}

/** A status filter from an address: one status or several separated by commas. Unknown words are dropped, repeats are kept once, the order given is kept. */
export function parseStatusFilter(raw: string | null | undefined): PostStatus[] {
  const out: PostStatus[] = [];
  for (const part of (raw ?? "").slice(0, 400).split(",")) {
    const s = part.trim() as PostStatus;
    if (POST_STATUSES.includes(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

const NEXT: Record<PostStatus, readonly PostStatus[]> = {
  draft: ["pending_approval", "scheduled", "cancelled"],
  pending_approval: ["approved", "changes_requested", "rejected", "draft", "cancelled"],
  changes_requested: ["pending_approval", "draft", "cancelled"],
  approved: ["scheduled", "draft", "cancelled"],
  scheduled: ["publishing", "approved", "draft", "cancelled"],
  publishing: ["published", "failed", "needs_reconciliation", "scheduled"],
  needs_reconciliation: ["published", "failed"],
  published: [],
  failed: ["scheduled", "draft", "cancelled"],
  cancelled: [],
  rejected: [],
};

export const canTransition = (from: PostStatus, to: PostStatus) => NEXT[from].includes(to);

/** Statuses in which the content can be changed. Editing a post that was waiting, approved or scheduled sends it back to draft: the approval was of the old text. */
export const EDITABLE: readonly PostStatus[] = ["draft", "pending_approval", "changes_requested", "approved", "scheduled", "failed"];
export const isEditable = (s: PostStatus) => EDITABLE.includes(s);

/** Posts the calendar still expects something from. */
export const OPEN_STATUSES: readonly PostStatus[] = ["draft", "pending_approval", "changes_requested", "approved", "scheduled", "publishing", "needs_reconciliation", "failed"];
export const TERMINAL_STATUSES: readonly PostStatus[] = ["published", "cancelled", "rejected"];

export interface ApprovalInput {
  origin: "human" | "ai";
  /** The author holds the publish permission. */
  authorCanPublish: boolean;
  /** The workspace asks even people who can publish to have their posts approved by someone else. */
  approvalForPublishers: boolean;
}

/**
 * Whether a post needs a reviewer's approval before it can be scheduled. An AI draft always does, whatever the settings: no setting lets an AI draft publish
 * itself. A post written by someone who cannot publish always does. A person who can publish may schedule their own post unless the workspace asked for review.
 */
export function approvalRequired(i: ApprovalInput): boolean {
  if (i.origin === "ai") return true;
  if (!i.authorCanPublish) return true;
  return i.approvalForPublishers;
}

/** Whether the reviewer may be the person who wrote the post. Only when the workspace has not asked for a second pair of eyes. */
export const selfApprovalAllowed = (approvalForPublishers: boolean) => !approvalForPublishers;

/**
 * Why this person cannot approve this post, or null when they can. The same two rules the server applies in `decide`, so the interface offers Approve only
 * where it will be accepted: approving needs the approve permission, and a post's own author cannot approve it when the workspace asked for a second pair of eyes.
 */
export function approveBlockedReason(i: { canApprove: boolean; isAuthor: boolean; approvalForPublishers: boolean }): string | null {
  if (!i.canApprove) return "Only the business owner or a manager can approve it.";
  if (i.isAuthor && !selfApprovalAllowed(i.approvalForPublishers)) return "Your workspace asks for a second person to approve each post. Ask another owner or manager.";
  return null;
}

export const SCHEDULE_MIN_LEAD_MS = 5 * 60_000;
export const SCHEDULE_MAX_LEAD_MS = 180 * 86_400_000;

/** A schedule the system will accept: at least five minutes ahead and at most 180 days out. Returns the reason it is not, or null. */
export function scheduleProblem(at: Date, now: Date): string | null {
  if (Number.isNaN(at.getTime())) return "Choose a date and time.";
  if (at.getTime() < now.getTime() + SCHEDULE_MIN_LEAD_MS) return "Choose a time at least five minutes from now.";
  if (at.getTime() > now.getTime() + SCHEDULE_MAX_LEAD_MS) return "Posts can be scheduled up to 180 days ahead.";
  return null;
}
