// The life of a reply to a public review, and who may do what at each step. Pure: the server enforces these rules and the interface only reads them.
//
// A reply is written by a person, or drafted by the AI assist for a person. Either way a person with the right to answer for the business approves one exact version, and the
// text that is posted must still equal what was approved. There is no setting that posts a reply by itself, and none that lets an AI draft skip the approval.

export const REPLY_STATUSES = ["draft", "pending_approval", "changes_requested", "approved", "posting", "posted", "failed", "needs_reconciliation", "rejected", "cancelled"] as const;
export type ReplyStatus = (typeof REPLY_STATUSES)[number];
export const isReplyStatus = (v: unknown): v is ReplyStatus => typeof v === "string" && (REPLY_STATUSES as readonly string[]).includes(v);

export const REPLY_STATUS_LABELS: Record<ReplyStatus, string> = {
  draft: "Draft",
  pending_approval: "Waiting for approval",
  changes_requested: "Changes requested",
  approved: "Approved",
  posting: "Posting",
  posted: "Posted",
  failed: "Not posted",
  needs_reconciliation: "Checking the result",
  rejected: "Rejected",
  cancelled: "Cancelled",
};

/** One line saying what a status means, for the person looking at it. Never softer than the truth. */
export const REPLY_STATUS_EXPLAIN: Record<ReplyStatus, string> = {
  draft: "Not sent for approval yet. Nothing has been posted.",
  pending_approval: "The owner or a manager has to read this exact reply before it can be posted. Nothing has been posted.",
  changes_requested: "A reviewer asked for changes. Edit it and send it again. Nothing has been posted.",
  approved: "Approved. It has not been posted yet; it is posted when the owner or a manager presses Post.",
  posting: "Being sent to the review site now.",
  posted: "Sent to the review site.",
  failed: "The review site did not take it, so it is not posted. See the reason, then try again or edit it.",
  needs_reconciliation: "The review site did not confirm whether it took the reply. It is being checked, and it will not be sent again until that is known.",
  rejected: "A reviewer rejected this reply. It will not be posted.",
  cancelled: "Cancelled before it was posted.",
};

const NEXT: Record<ReplyStatus, readonly ReplyStatus[]> = {
  draft: ["pending_approval", "cancelled"],
  pending_approval: ["approved", "changes_requested", "rejected", "draft", "cancelled"],
  changes_requested: ["pending_approval", "draft", "cancelled"],
  approved: ["posting", "draft", "cancelled"],
  posting: ["posted", "failed", "needs_reconciliation"],
  failed: ["posting", "draft", "cancelled"],
  needs_reconciliation: ["posted", "failed"],
  posted: [],
  rejected: [],
  cancelled: [],
};

export const canTransitionReply = (from: ReplyStatus, to: ReplyStatus) => NEXT[from].includes(to);

/** One reply per review may be open: not yet posted, and not closed by a decision. (Matches the partial unique index of migration 0095.) */
export const OPEN_REPLY_STATUSES: readonly ReplyStatus[] = ["draft", "pending_approval", "changes_requested", "approved", "posting", "failed", "needs_reconciliation"];
export const isOpenReply = (s: ReplyStatus) => OPEN_REPLY_STATUSES.includes(s);

/** Statuses in which the words can still be changed. Changing them sends the reply back to a draft: the approval was of the old words. */
export const EDITABLE_REPLY_STATUSES: readonly ReplyStatus[] = ["draft", "pending_approval", "changes_requested", "approved", "failed"];
export const isEditableReply = (s: ReplyStatus) => EDITABLE_REPLY_STATUSES.includes(s);

/** The statuses from which a reply was or may have been sent: it can no longer be edited or cancelled quietly. */
export const SENT_OR_UNKNOWN: readonly ReplyStatus[] = ["posting", "posted", "needs_reconciliation"];

/** The words as the person approved them are the words that are posted: the version must be the approved one and the hash must still match. */
export const approvalStands = (r: { version: number; approvedVersion: number | null; approvedHashMatches: boolean }) => r.approvedVersion !== null && r.approvedVersion === r.version && r.approvedHashMatches;

/** How long a reply may sit in "posting" before the scheduler asks the review site what happened. */
export const POSTING_STALE_MINUTES = 5;
// (The grace period before "not found" is believed, and the day after which a person is asked to look, are RECONCILE_GRACE_MINUTES and RECONCILE_GIVE_UP_HOURS in src/server/reputation/replies.ts.)

// ---------------------------------------------------------------------------
// What this person may do right now
// ---------------------------------------------------------------------------

export interface ReplyFacts {
  /** The reply, or null when the review has none open yet. */
  reply: { status: ReplyStatus; version: number; approvedVersion: number | null; authorId: string | null; origin: "human" | "ai" } | null;
  /** The person acting. */
  userId: string | null;
  /** They may write and send replies for approval (reviews.respond, or an agency write session for the client). */
  canDraft: boolean;
  /** They may approve and post (reviews.reply_publish in the client's own workspace). */
  canPublish: boolean;
  /** The AI assist is switched on for this workspace and they may use it. */
  canAi: boolean;
  /** The review can still be answered: it is still on the site and its connection is working. */
  reviewLive: boolean;
  /** The connection lets a reply be posted from here right now (the site allows it, the environment switch is on, access was granted). */
  postable: boolean;
  /** Why not, in plain words, when `postable` is false. */
  postableReason: string | null;
  /** The workspace has review reading switched on. */
  enabled: boolean;
}

export interface ReplyAbilities {
  start: boolean;
  startWithAi: boolean;
  edit: boolean;
  submit: boolean;
  approve: boolean;
  requestChanges: boolean;
  reject: boolean;
  post: boolean;
  /** A person says they posted it themselves on the site (only when it cannot be posted from here, or the result is unknown). */
  markPosted: boolean;
  markNotPosted: boolean;
  cancel: boolean;
  /** Plain words for the first thing that stops the main next step, when something does. */
  note: string | null;
}

/** What the interface offers, and what the server will accept, for one reply and one person. The server re-checks every one of these itself. */
export function replyAbilities(f: ReplyFacts): ReplyAbilities {
  const none: ReplyAbilities = { start: false, startWithAi: false, edit: false, submit: false, approve: false, requestChanges: false, reject: false, post: false, markPosted: false, markNotPosted: false, cancel: false, note: null };
  const r = f.reply;
  if (!f.enabled) return { ...none, note: "Replying to reviews isn't switched on for this workspace yet. Ask your iAcquire contact to switch it on." };
  if (!f.reviewLive && !r) return { ...none, note: "This review is no longer on the review site, or its connection needs attention, so it can't be answered from here." };
  if (!r || !isOpenReply(r.status)) {
    return { ...none, start: f.canDraft && f.reviewLive, startWithAi: f.canAi && f.canDraft && f.reviewLive, note: f.canDraft ? null : "Your role can't write replies." };
  }
  const isAuthor = f.userId !== null && r.authorId === f.userId;
  const sentOrUnknown = SENT_OR_UNKNOWN.includes(r.status);
  const out: ReplyAbilities = { ...none };
  out.edit = isEditableReply(r.status) && f.canDraft && (isAuthor || f.canPublish);
  out.submit = (r.status === "draft" || r.status === "changes_requested") && f.canDraft && (isAuthor || f.canPublish) && f.reviewLive;
  out.approve = r.status === "pending_approval" && f.canPublish && f.reviewLive;
  out.requestChanges = r.status === "pending_approval" && f.canPublish;
  out.reject = r.status === "pending_approval" && f.canPublish;
  out.post = (r.status === "approved" || r.status === "failed") && f.canPublish && f.reviewLive && f.postable && r.approvedVersion === r.version;
  out.markPosted = f.canPublish && ((r.status === "approved" && !f.postable) || r.status === "needs_reconciliation");
  out.markNotPosted = f.canPublish && r.status === "needs_reconciliation";
  out.cancel = !sentOrUnknown && r.status !== "posted" && f.canDraft && (isAuthor || f.canPublish);
  if ((r.status === "approved" || r.status === "failed") && f.canPublish && !out.post) out.note = r.approvedVersion !== r.version ? "The approval is for an earlier version. Send it for approval again." : f.postableReason;
  if (r.status === "pending_approval" && !f.canPublish) out.note = "Only the owner or a manager can approve a reply.";
  return out;
}

/** What each step in a reply's history is called on the screen. */
export const REPLY_EVENT_LABELS: Record<string, string> = {
  created: "Started",
  ai_drafted: "Drafted by the AI assist for a person",
  edited: "Edited",
  submitted: "Sent for approval",
  approved: "Approved",
  changes_requested: "Changes asked for",
  rejected: "Rejected",
  cancelled: "Cancelled",
  posting: "Sending to the review site",
  posted: "Posted",
  posted_confirmed: "Confirmed on the review site",
  outcome_unknown: "The review site did not say whether it took it",
  posting_interrupted: "Sending was interrupted",
  failed: "Not posted",
  not_posted: "Checked: not on the review site",
  resolved_by_person: "A person said what happened",
  review_changed: "The review changed, so the approval was withdrawn",
};

export const eventLabel = (kind: string) => REPLY_EVENT_LABELS[kind] ?? kind.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
