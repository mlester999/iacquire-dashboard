// Review request batches: the states a batch moves through, why a customer can be left out, and the plain words for both. Pure and free of server code, so the screen and the
// scheduler read the same rules. Who is IN a batch is decided by src/lib/reputation/ask-criteria.ts (a completed service in a window); this file never looks at that.
import type { BatchCriteria } from "@/lib/reputation/ask-criteria";
import type { FeedbackScale, RequestKind } from "@/lib/reputation/scores";
import type { Channel } from "@/lib/messaging";

export const BATCH_STATUSES = ["draft", "awaiting_approval", "approved", "sending", "paused", "completed", "cancelled", "stopped"] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

export const BATCH_STATUS_LABELS: Record<BatchStatus, string> = {
  draft: "Draft",
  awaiting_approval: "Waiting for the owner",
  approved: "Approved, waiting to start",
  sending: "Sending",
  paused: "Paused",
  completed: "Finished",
  cancelled: "Cancelled",
  stopped: "Stopped",
};

/** Where a batch may go from each state. Finished, cancelled and stopped are final: a stopped batch is copied and approved again, never resumed. */
export const BATCH_TRANSITIONS: Record<BatchStatus, readonly BatchStatus[]> = {
  draft: ["awaiting_approval", "approved", "cancelled"],
  awaiting_approval: ["draft", "approved", "cancelled"],
  approved: ["sending", "paused", "cancelled", "stopped"],
  sending: ["paused", "completed", "cancelled", "stopped"],
  paused: ["sending", "cancelled", "stopped"],
  completed: [],
  cancelled: [],
  stopped: [],
};

export const canTransition = (from: BatchStatus, to: BatchStatus) => BATCH_TRANSITIONS[from].includes(to);
export const isFinalStatus = (s: BatchStatus) => BATCH_TRANSITIONS[s].length === 0;
/** Still being worked out: its wording, people and pace can be changed (a change withdraws any approval request). */
export const isEditableStatus = (s: BatchStatus) => s === "draft" || s === "awaiting_approval";
/** Waiting to send, or sending: the scheduler may act on it. */
export const isLiveStatus = (s: BatchStatus) => s === "approved" || s === "sending";
export const isBatchStatus = (v: unknown): v is BatchStatus => typeof v === "string" && (BATCH_STATUSES as readonly string[]).includes(v);

/** The most people one batch may cover. A bigger window is refused rather than sent in part. (A proposal; the founder can change it.) */
export const MAX_BATCH_PEOPLE = 1000;
export const MAX_RATE_PER_MINUTE = 60;
export const DEFAULT_RATE_PER_MINUTE = 10;
/** How long an owner's approval of a batch stands if it has not finished. After that the batch stops and has to be approved again. */
export const APPROVAL_DAYS = 14;

/**
 * Why a customer was left out of a batch, or did not get their message. The first rule that applies wins, in the order the send path checks them. Stored in
 * review_request_batch_items.reason; a refusal that has no code of its own is stored as blocked:<reason>.
 */
export const ITEM_REASONS = [
  "no_address", "suppressed", "consent_withdrawn", "no_consent", "recently_requested", "held_by_person", "archived", "deleted", "missing_values", "frequency_limit",
  "withdrawn", "batch_cancelled", "batch_stopped",
] as const;
export type ItemReason = (typeof ITEM_REASONS)[number];

export const ITEM_REASON_LABELS: Record<ItemReason, string> = {
  no_address: "No phone number or email address on file",
  suppressed: "Opted out or bounced",
  consent_withdrawn: "Withdrew consent to these messages",
  no_consent: "No consent on record for these messages",
  recently_requested: "Already asked in the last 30 days",
  held_by_person: "Held back by a person on your team",
  archived: "Archived contact",
  deleted: "Removed contact",
  missing_values: "A detail the message needs is missing",
  frequency_limit: "Reached the limit for program messages",
  withdrawn: "Withdrawn before it was sent",
  batch_cancelled: "The batch was cancelled",
  batch_stopped: "The batch was stopped",
};

/** The reasons the preview can foresee, in the order they are checked and shown. (A missing detail or a frequency limit is only known when the message is queued.) */
export const PREVIEW_REASONS = ["no_address", "suppressed", "consent_withdrawn", "no_consent", "recently_requested", "held_by_person"] as const;
// Every reason the preview can give is one the batch can store.
const previewReasonsAreItemReasons: readonly ItemReason[] = PREVIEW_REASONS;
void previewReasonsAreItemReasons;

export function reasonLabel(reason: string | null | undefined): string {
  if (!reason) return "";
  if ((ITEM_REASONS as readonly string[]).includes(reason)) return ITEM_REASON_LABELS[reason as ItemReason];
  if (reason.startsWith("blocked:")) return `Not sent (${reason.slice(8).replace(/_/g, " ")})`;
  return reason.replace(/_/g, " ");
}

export type ItemStatus = "pending" | "queued" | "excluded" | "failed";
export const ITEM_STATUS_LABELS: Record<ItemStatus, string> = { pending: "Waiting", queued: "Asked", excluded: "Left out", failed: "Not sent" };

/** Why a batch stopped or paused by itself, shown on it. */
export type BatchNoticeCode =
  | "paused" | "credits" | "budget" | "channel" | "price" | "template_changed" | "approval_void" | "approval_expired" | "too_large" | "workspace_paused" | "returned"
  | "no_links" | "surveys_not_enabled" | "wording" | "values_missing" | "provider";

export interface BatchNotice {
  code: BatchNoticeCode;
  detail: string;
  at: string;
}

export interface BatchCounts {
  total: number;
  pending: number;
  queued: number;
  excluded: number;
  failed: number;
  /** Why people were left out, by reason. */
  reasons: Record<string, number>;
  notice: BatchNotice | null;
  /** The scheduler does not look at the batch again before this time (the workspace is paused, for example). */
  waitUntil: string | null;
}

export const EMPTY_BATCH_COUNTS: BatchCounts = { total: 0, pending: 0, queued: 0, excluded: 0, failed: 0, reasons: {}, notice: null, waitUntil: null };

const NOTICE_CODES: readonly string[] = [
  "paused", "credits", "budget", "channel", "price", "template_changed", "approval_void", "approval_expired", "too_large", "workspace_paused", "returned", "no_links", "surveys_not_enabled",
  "wording", "values_missing", "provider",
];
const whole = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

/** Counts as stored on the batch row, whatever that row holds: unknown shapes read as zero, and a notice is kept only when it is one of ours. */
export function readBatchCounts(raw: unknown): BatchCounts {
  const o = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const reasons: Record<string, number> = {};
  if (typeof o.reasons === "object" && o.reasons !== null && !Array.isArray(o.reasons)) {
    for (const [k, v] of Object.entries(o.reasons as Record<string, unknown>)) if (k.length <= 120 && whole(v) > 0) reasons[k] = whole(v);
  }
  const n = typeof o.notice === "object" && o.notice !== null ? (o.notice as Record<string, unknown>) : null;
  const notice: BatchNotice | null = n && typeof n.code === "string" && NOTICE_CODES.includes(n.code) && typeof n.detail === "string"
    ? { code: n.code as BatchNoticeCode, detail: n.detail.slice(0, 400), at: typeof n.at === "string" ? n.at : new Date(0).toISOString() }
    : null;
  const wait = typeof o.waitUntil === "string" && !Number.isNaN(new Date(o.waitUntil).getTime()) ? o.waitUntil : null;
  return { total: whole(o.total), pending: whole(o.pending), queued: whole(o.queued), excluded: whole(o.excluded), failed: whole(o.failed), reasons, notice, waitUntil: wait };
}

/**
 * What the scheduler does with a refusal from the send path while it is asking one customer: leave that customer out (their own address, consent or hold decided it), pause the
 * whole batch because something outside the customer needs a person (credits, the channel, a missing link), stop it for good because the approved wording can't be sent, or
 * record this one customer as not sent and carry on. A pause or a stop never asks the next customer first.
 */
export type RefusalClass =
  | { action: "leave_out"; reason: ItemReason }
  | { action: "pause"; code: BatchNoticeCode }
  | { action: "stop"; code: BatchNoticeCode }
  | { action: "fail"; reason: string };

export function classifyRefusal(reason: string): RefusalClass {
  switch (reason) {
    case "suppressed": return { action: "leave_out", reason: "suppressed" };
    case "no_consent": return { action: "leave_out", reason: "no_consent" };
    case "contact_unreachable": return { action: "leave_out", reason: "no_address" };
    case "contact_archived": return { action: "leave_out", reason: "archived" };
    case "not_found": return { action: "leave_out", reason: "deleted" };
    case "recently_requested": return { action: "leave_out", reason: "recently_requested" };
    case "held_by_person": return { action: "leave_out", reason: "held_by_person" };
    case "retention_limit": return { action: "leave_out", reason: "frequency_limit" };
    case "missing_values": return { action: "leave_out", reason: "missing_values" };
    case "credits": return { action: "pause", code: "credits" };
    case "budget": return { action: "pause", code: "budget" };
    case "rate_not_published": return { action: "pause", code: "price" };
    case "channel_not_ready": return { action: "pause", code: "channel" };
    case "provider_owned": return { action: "pause", code: "provider" };
    case "no_destinations": return { action: "pause", code: "no_links" };
    case "surveys_not_enabled": return { action: "pause", code: "surveys_not_enabled" };
    case "template_changed": case "whatsapp_window_closed": case "template_mismatch": return { action: "stop", code: "template_changed" };
    case "no_review_link": case "marketing_template": case "incentive_wording": return { action: "stop", code: "wording" };
    default: return { action: "fail", reason: `blocked:${reason}`.slice(0, 120) };
  }
}

/** At most this many batches that have not finished, per workspace. */
export const MAX_OPEN_BATCHES = 20;

export interface BatchResults {
  /** Messages that have gone to the provider, messages the customer opened, and messages that failed or were stopped. */
  sent: number;
  opened: number;
  undelivered: number;
}

/** What a batch was approved for, as it was when the owner looked (counts only: the people are checked again one by one as they are asked). */
export interface BatchEstimate {
  eligible: number;
  total: number;
  excluded: Record<string, number>;
  checkedAt: string;
}

export interface BatchView {
  id: string;
  name: string;
  status: BatchStatus;
  kind: RequestKind;
  scale: FeedbackScale;
  channel: Channel;
  template: { id: string; name: string } | null;
  criteria: BatchCriteria | null;
  criteriaText: string;
  ratePerMinute: number;
  counts: BatchCounts;
  results: BatchResults;
  estimate: BatchEstimate | null;
  /** The owner's approval stands for exactly what the hash covered. */
  approved: boolean;
  createdAt: string;
  createdByName: string | null;
  requestedByName: string | null;
  requestedAt: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface BatchPreview {
  batchId: string;
  /** What an approval would cover; null while something stops it from being approved. */
  fingerprint: string | null;
  /** Why it can't be approved yet, in plain words. */
  problems: string[];
  template: { id: string; name: string; version: number } | null;
  channel: Channel;
  audience: { total: number; eligible: number; excluded: Record<string, number>; tooLarge: boolean };
  sample: { eligible: Array<{ id: string; name: string }>; excluded: Array<{ id: string; name: string; reason: string }> };
  /** The message as the first person on the list would get it, with "[review link]" where their own link goes. */
  message: { subject: string | null; body: string; forName: string } | null;
  minutes: number;
  checkedAt: string;
  canApprove: boolean;
}

export const PERSON_FILTERS = ["all", "waiting", "asked", "left_out", "failed"] as const;
export type PersonFilter = (typeof PERSON_FILTERS)[number];
export const PERSON_FILTER_LABELS: Record<PersonFilter, string> = { all: "Everyone", waiting: "Waiting", asked: "Asked", left_out: "Left out", failed: "Not sent" };

export interface BatchPersonView {
  contactId: string;
  name: string;
  status: ItemStatus;
  reason: string | null;
  reasonText: string;
  factAt: string | null;
  /** How far their message got, once they were asked. */
  delivery: "waiting" | "sent" | "opened" | "failed" | "withdrawn" | null;
}

export const kindWord = (kind: RequestKind) => (kind === "survey" ? "survey" : "review request");

/** How long a batch of this many people takes to queue at a pace, in whole minutes (at least 1 when there is anyone). Sending itself also waits for quiet hours and business hours. */
export function minutesAtPace(people: number, perMinute: number): number {
  if (people <= 0) return 0;
  return Math.max(1, Math.ceil(people / Math.max(1, perMinute)));
}

/** "about 3 minutes", "about 2 hours". */
export function durationWords(minutes: number): string {
  if (minutes <= 1) return "about a minute";
  if (minutes < 90) return `about ${minutes} minutes`;
  const h = Math.round(minutes / 60);
  return `about ${h} hours`;
}
