// The life of a proposal, and who must approve it. Pure: the server enforces these rules and the interface only reads them.
//
// A proposal moves draft -> pending_approval -> approved -> sent -> accepted | declined | expired. Anything not yet answered can be withdrawn. A sent, declined, expired or
// withdrawn proposal can be revised, which makes the next version a draft; an accepted proposal is final (a change is a new proposal). An approval is of one version: any change
// to what the customer will see makes a new version and voids the approval.

export const PROPOSAL_STATUSES = ["draft", "pending_approval", "changes_requested", "rejected", "approved", "sent", "accepted", "declined", "expired", "withdrawn"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const STATUS_LABELS: Record<ProposalStatus, string> = {
  draft: "Draft",
  pending_approval: "Waiting for approval",
  changes_requested: "Changes requested",
  rejected: "Rejected",
  approved: "Approved",
  sent: "Sent",
  accepted: "Accepted",
  declined: "Declined",
  expired: "Expired",
  withdrawn: "Withdrawn",
};

/** One line saying what a status means. Never softer than the truth: "Accepted" here means a recorded answer, not a signature unless a signing service said so. */
export const STATUS_EXPLAIN: Record<ProposalStatus, string> = {
  draft: "Not sent for approval yet.",
  pending_approval: "A person with approval rights has to look at this exact version before it can be sent.",
  changes_requested: "A reviewer asked for changes. Edit it and send it for approval again.",
  rejected: "A reviewer rejected it. It will not be sent. Duplicate it to start again.",
  approved: "Approved, not sent yet.",
  sent: "Sent to the customer. Waiting for their answer.",
  accepted: "The customer's acceptance is recorded.",
  declined: "The customer declined.",
  expired: "The valid-until date passed before the customer answered.",
  withdrawn: "Taken back. The customer can no longer accept it.",
};

const NEXT: Record<ProposalStatus, readonly ProposalStatus[]> = {
  // draft -> sent is the author's own approval at send time, when nothing requires a second look.
  draft: ["pending_approval", "sent", "withdrawn"],
  pending_approval: ["approved", "changes_requested", "rejected", "draft", "withdrawn"],
  changes_requested: ["pending_approval", "draft", "sent", "withdrawn"],
  rejected: [],
  approved: ["sent", "draft", "withdrawn"],
  // sent -> draft is a revision.
  sent: ["accepted", "declined", "expired", "withdrawn", "draft"],
  accepted: [],
  declined: ["draft"],
  expired: ["draft"],
  withdrawn: ["draft"],
};

export const canTransition = (from: ProposalStatus, to: ProposalStatus): boolean => NEXT[from].includes(to);

/** Statuses in which the wording can be changed. Changing a waiting or approved proposal sends it back to draft: the approval was of the old text. */
export const EDITABLE: readonly ProposalStatus[] = ["draft", "pending_approval", "changes_requested", "approved"];
export const isEditable = (s: ProposalStatus): boolean => EDITABLE.includes(s);

/** Statuses that can be revised into a new draft version. */
export const REVISABLE: readonly ProposalStatus[] = ["sent", "declined", "expired", "withdrawn"];
export const isRevisable = (s: ProposalStatus): boolean => REVISABLE.includes(s);

/** The customer may still answer. */
export const isLive = (s: ProposalStatus): boolean => s === "sent";
/** Nothing more will happen to this version without a person starting a new one. */
export const isClosed = (s: ProposalStatus): boolean => ["rejected", "accepted", "declined", "expired", "withdrawn"].includes(s);
/** The statuses a person still has something to do with. */
export const OPEN_STATUSES: readonly ProposalStatus[] = ["draft", "pending_approval", "changes_requested", "approved", "sent"];

export function parseStatusFilter(raw: string | null | undefined): ProposalStatus[] {
  const out: ProposalStatus[] = [];
  for (const part of (raw ?? "").slice(0, 400).split(",")) {
    const s = part.trim() as ProposalStatus;
    if (PROPOSAL_STATUSES.includes(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

export type ApprovalReason = "ai_draft" | "discount" | "over_threshold" | "all_proposals" | "cannot_send";

export interface ApprovalFacts {
  origin: "human" | "ai";
  /** The author holds the send permission. */
  authorCanSend: boolean;
  mode: "ai_and_discounts" | "all";
  discountNeedsApproval: boolean;
  /** A discount, or a price set below the price book's. */
  lowersPrice: boolean;
  /** Any billing group's total (tax included) above this needs approval. */
  overMinor: number | null;
  /** The proposal's grand total per billing group that holds anything. */
  groupTotals: readonly number[];
}

/**
 * Why this proposal needs a second look before it goes out; empty when it does not. An AI draft always does, whatever the settings: nothing lets an AI-written proposal go
 * out on its own. A proposal written by someone who cannot send always does. The rest are the workspace's choices.
 */
export function approvalReasons(f: ApprovalFacts): ApprovalReason[] {
  const reasons: ApprovalReason[] = [];
  if (f.origin === "ai") reasons.push("ai_draft");
  if (!f.authorCanSend) reasons.push("cannot_send");
  if (f.mode === "all") reasons.push("all_proposals");
  if (f.discountNeedsApproval && f.lowersPrice) reasons.push("discount");
  if (f.overMinor !== null && f.groupTotals.some((t) => t > (f.overMinor as number))) reasons.push("over_threshold");
  return reasons;
}

export const approvalRequired = (f: ApprovalFacts): boolean => approvalReasons(f).length > 0;

export const APPROVAL_REASON_TEXT: Record<ApprovalReason, string> = {
  ai_draft: "An AI draft always needs a person's approval.",
  cannot_send: "The person who wrote it can write proposals but not send them, so someone who can has to approve this one.",
  all_proposals: "Your workspace has every proposal approved before it is sent.",
  discount: "It gives a discount or sets a price below the price book.",
  over_threshold: "A total is above the amount your workspace set for approval.",
};

/** Whether the person who wrote the proposal may also approve it. Only when the workspace has not asked for a second person. */
export const selfApprovalAllowed = (twoPerson: boolean): boolean => !twoPerson;

/** Why this person cannot approve this proposal, or null when they can: the two rules the server applies when a decision is made. */
export function approveBlockedReason(i: { canApprove: boolean; isAuthor: boolean; twoPerson: boolean }): string | null {
  if (!i.canApprove) return "Only the business owner or a manager can approve proposals.";
  if (i.isAuthor && !selfApprovalAllowed(i.twoPerson)) return "Your workspace asks for a second person to approve each proposal. Ask another owner or manager.";
  return null;
}
