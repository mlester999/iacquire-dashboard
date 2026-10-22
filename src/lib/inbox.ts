// Pure Unified Inbox vocabulary shared by the server and the interface. No I/O here.

import type { AgentRoleKey } from "@/lib/agents";
import { CALL_CLASS_LABELS, type CallClass } from "@/lib/missed-calls/state";

// ---------------------------------------------------------------------------
// Views (the tabs on the conversation list)
// ---------------------------------------------------------------------------

export const INBOX_VIEWS = ["all", "unread", "mine", "ai", "unassigned", "attention", "open", "waiting", "resolved", "archived"] as const;
export type InboxView = (typeof INBOX_VIEWS)[number];
export const isInboxView = (v: unknown): v is InboxView => typeof v === "string" && (INBOX_VIEWS as readonly string[]).includes(v);

export const INBOX_VIEW_LABELS: Record<InboxView, string> = {
  all: "All",
  unread: "Unread",
  mine: "Assigned to me",
  ai: "Assigned to AI",
  unassigned: "Unassigned",
  attention: "Needs attention",
  open: "Open",
  waiting: "Waiting",
  resolved: "Resolved",
  archived: "Archived",
};

/** What each view means, in the words the interface shows next to it. These are definitions, not decoration: the server query applies exactly this. */
export const INBOX_VIEW_HELP: Record<InboxView, string> = {
  all: "Every conversation that is not archived.",
  unread: "Conversations with customer messages nobody has opened.",
  mine: "Conversations you own or that were assigned to you.",
  ai: "Open conversations an AI employee is handling.",
  unassigned: "Open conversations nobody, person or AI, is handling.",
  attention: "A person was asked for, a message failed, it is marked urgent, or the customer has waited for a reply.",
  open: "Conversations that are not resolved.",
  waiting: "We replied last and are waiting for the customer.",
  resolved: "Conversations closed with an outcome. A new customer message reopens one.",
  archived: "Put away. A new customer message brings one back.",
};

export const INBOX_SORTS = ["priority", "recent", "waiting_longest"] as const;
export type InboxSort = (typeof INBOX_SORTS)[number];
export const isInboxSort = (v: unknown): v is InboxSort => typeof v === "string" && (INBOX_SORTS as readonly string[]).includes(v);
export const INBOX_SORT_LABELS: Record<InboxSort, string> = { priority: "Priority", recent: "Newest", waiting_longest: "Longest waiting" };
/** What each sort does, for the hint under the control. */
export const INBOX_SORT_HELP: Record<InboxSort, string> = {
  priority: "People asked for first, then urgent and high priority, then newest.",
  recent: "Newest message first.",
  waiting_longest: "Customers waiting longest for a reply first.",
};

/** A customer message nobody has answered for this long makes the conversation "awaiting a reply" in Needs attention. */
export const AWAITING_REPLY_MINUTES = 30;

/** Why a conversation is in Needs attention. A reason is only listed when the database shows it; none is inferred by a model. */
export type AttentionReason = "needs_person" | "send_failed" | "urgent" | "awaiting_reply";
export const ATTENTION_LABELS: Record<AttentionReason, string> = {
  needs_person: "A person was asked to take over",
  send_failed: "A message could not be sent",
  urgent: "Marked urgent",
  awaiting_reply: "The customer is waiting for a reply",
};

/** "4 hours", "3 days": how long a conversation was quiet, as the automation editor and its summaries say it. */
export function idleLabel(hours: number): string {
  if (hours < 24 || hours % 24 !== 0) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = hours / 24;
  return `${days} day${days === 1 ? "" : "s"}`;
}

/**
 * What a person sees when an operator has switched the inbox off (INBOX_DISABLED, see src/server/messaging/inbox-switch.ts): on the page, in a
 * toast, in an API error. Plain and free of reasons; why it is off is the operator's to say.
 */
export const INBOX_UNAVAILABLE_MESSAGE = "The inbox is temporarily unavailable. Please try again in a little while.";
/** What a call to a new-inbox-only API or action gets when the workspace is not switched on in the rollout (see src/server/messaging/inbox-rollout.ts). */
export const INBOX_NOT_ENABLED_MESSAGE = "The new inbox isn't switched on for your workspace yet.";

// ---------------------------------------------------------------------------
// Outcomes (how a conversation ended)
// ---------------------------------------------------------------------------

export const CONVERSATION_OUTCOMES = ["booked", "qualified", "answered", "not_a_fit", "no_response", "spam", "other"] as const;
export type ConversationOutcome = (typeof CONVERSATION_OUTCOMES)[number];
export const isConversationOutcome = (v: unknown): v is ConversationOutcome => typeof v === "string" && (CONVERSATION_OUTCOMES as readonly string[]).includes(v);
export const OUTCOME_LABELS: Record<ConversationOutcome, string> = {
  booked: "Appointment booked",
  qualified: "Qualified lead",
  answered: "Question answered",
  not_a_fit: "Not a fit",
  no_response: "No response",
  spam: "Spam",
  other: "Other",
};

// ---------------------------------------------------------------------------
// AI employees on conversations
// ---------------------------------------------------------------------------

/**
 * The employees that may handle a customer's conversation. The Sales Assistant answers customers (the reply path in
 * src/server/messaging/responder.ts) and the Appointment Setter books through the real calendar. The other four roles are internal
 * (operations, lead research, CRM data quality, analytics): none of them has a customer-facing capability in WORKFORCE_CAPABILITIES, so the
 * server refuses to attach them to a conversation rather than hiding them in the interface.
 */
export const CONVERSATION_AI_ROLES = ["sales_assistant", "appointment_setter"] as const satisfies readonly AgentRoleKey[];
export type ConversationAiRole = (typeof CONVERSATION_AI_ROLES)[number];
export const canHandleConversations = (role: string | null | undefined): role is ConversationAiRole => (CONVERSATION_AI_ROLES as readonly string[]).includes(role ?? "");

// ---------------------------------------------------------------------------
// Lifecycle events
// ---------------------------------------------------------------------------

export const CONVERSATION_EVENT_KINDS = [
  "assigned", "ai_assigned", "ai_paused", "ai_resumed", "status_changed", "priority_changed", "archived", "unarchived", "handoff_requested",
  "task_linked", "opportunity_linked", "message_retried", "missed_call", "recovery_update",
] as const;
export type ConversationEventKind = (typeof CONVERSATION_EVENT_KINDS)[number];

const RECOVERY_UPDATE_TEXT: Record<string, string> = {
  message_sent: "A follow-up message went to the caller",
  draft_ready: "A follow-up message is waiting for approval",
  recovered: "The caller was reached",
  closed: "The missed-call follow-up was closed",
  assigned: "The missed-call follow-up was assigned",
  paused: "Automatic follow-up on the missed call was paused",
  resumed: "Automatic follow-up on the missed call was resumed",
};

/** The sentence the thread shows for an event. `detail` holds ids and short enums only, so names are looked up by the caller and passed in. */
export function describeConversationEvent(kind: string, detail: Record<string, unknown>, names: { actor: string; target?: string | null; agent?: string | null }): string {
  const who = names.actor;
  const s = (k: string) => (typeof detail[k] === "string" ? (detail[k] as string) : "");
  switch (kind) {
    case "assigned":
      return names.target ? `${who} assigned this to ${names.target}` : `${who} removed the assignment`;
    case "ai_assigned":
      return `${who} handed this to ${names.agent ?? "an AI employee"}`;
    case "ai_paused":
      return `${who} paused AI replies${s("reason") ? `: ${s("reason")}` : ""}`;
    case "ai_resumed":
      return `${who} turned AI replies back on`;
    case "status_changed":
      return s("to") === "closed" ? `${who} resolved this${s("outcome") ? ` (${OUTCOME_LABELS[s("outcome") as ConversationOutcome] ?? s("outcome")})` : ""}` : `${who} reopened this`;
    case "priority_changed":
      return `${who} set the priority to ${s("to") || "normal"}`;
    case "archived":
      return `${who} archived this`;
    case "unarchived":
      return `${who} moved this back to the inbox`;
    case "handoff_requested":
      return `${names.agent ?? who} asked for a person to take over${s("category") ? ` (${s("category").replace(/_/g, " ")})` : ""}`;
    case "task_linked":
      return `${who} created a task from this conversation`;
    case "opportunity_linked":
      return `${who} created a deal from this conversation`;
    case "message_retried":
      return `${who} sent a failed message again`;
    case "missed_call": {
      const label = CALL_CLASS_LABELS[s("class") as CallClass];
      return `Missed call${label ? `: ${label.toLowerCase()}` : ""}${detail.afterHours === true ? " (after hours)" : ""}`;
    }
    case "recovery_update":
      return RECOVERY_UPDATE_TEXT[s("stage")] ?? "Missed-call follow-up updated";
    default:
      return `${who} updated this conversation`;
  }
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

/** The honest state of a channel. "available" is the only one in which messages can flow. */
export type ChannelState = "connected" | "needs_attention" | "paused" | "not_connected" | "not_available";
export const CHANNEL_STATE_LABELS: Record<ChannelState, string> = {
  connected: "Connected",
  needs_attention: "Needs attention",
  paused: "Switched off",
  not_connected: "Not connected",
  not_available: "Not available",
};
