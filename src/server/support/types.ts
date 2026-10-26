import type { FeedbackStage, RequestType, TicketPriority, TicketStatus } from "@/lib/support/lifecycle";
import type { Diagnostics } from "@/lib/support/content";
import type { SlaView } from "@/server/support/response-clock";

// Shapes returned by the support services. Dates are ISO strings so a result can be handed straight to a client component.

export interface RequestListItem {
  id: string;
  ref: string;
  subject: string;
  category: string;
  requestType: RequestType;
  status: TicketStatus;
  feedbackStage: FeedbackStage | null;
  clientUrgency: string | null;
  affectedFeature: string | null;
  createdAt: string;
  lastActivityAt: string;
  createdByName: string | null;
  /** Whether a team member is assigned. The person's name is never given to clients. */
  isAssigned: boolean;
  /** The team replied after the client last opened the request. */
  hasUnreadReply: boolean;
}

export interface RequestPage<T> { items: T[]; total: number; page: number; pageSize: number }

export interface ThreadAttachment {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  visibility: "client" | "internal";
}

export interface ThreadMessage {
  id: string;
  authorKind: "client" | "agency" | "system";
  authorName: string | null;
  body: string;
  internal: boolean;
  createdAt: string;
  clientMessageId: string | null;
  attachments: ThreadAttachment[];
}

export interface TimelineEntry {
  id: string;
  kind: string;
  createdAt: string;
  actorKind: "client" | "agency" | "system";
  from: string | null;
  to: string | null;
  detail: string | null;
}

export interface ClientRequestDetail {
  ticket: RequestListItem & {
    description: string;
    resolvedAt: string | null;
    closedAt: string | null;
    reopenedCount: number;
    diagnostics: Diagnostics | null;
    projectId: string | null;
  };
  messages: ThreadMessage[];
  timeline: TimelineEntry[];
  /** When the iAcquire team last opened the request. A message the client sent before this moment has been seen. */
  teamLastReadAt: string | null;
  canReply: boolean;
  /** Why replying is unavailable, in words for the client; null when replying is possible. */
  replyBlockedReason: string | null;
  canReopen: boolean;
  /** "We aim to reply within …" only when the agency configured and chose to show it; otherwise null. */
  expectation: string | null;
  maxAttachmentMb: number;
  maxAttachments: number;
  reopenWindowDays: number;
  /** For a change request that was also filed as a change to an agreed project: that entry on the project's change list. Null otherwise. */
  linkedChange: { id: string; ref: string; title: string; status: string; projectId: string; projectRef: string; projectTitle: string } | null;
}

export interface AgencyListItem {
  id: string;
  ref: string;
  subject: string;
  category: string;
  requestType: RequestType;
  status: TicketStatus;
  priority: TicketPriority;
  feedbackStage: FeedbackStage | null;
  clientUrgency: string | null;
  createdAt: string;
  lastActivityAt: string;
  orgId: string;
  orgName: string;
  createdByName: string | null;
  assignedToId: string | null;
  assignedToName: string | null;
  escalated: boolean;
  /** The client wrote after the team last opened this request. */
  clientWaiting: boolean;
  firstRespondedAt: string | null;
  sla: SlaView;
}

export interface AgencyListQuery {
  /** A saved view: all active, unassigned, mine, overdue, escalated, waiting on client, recently replied, resolved, closed. */
  view?: "active" | "unassigned" | "mine" | "overdue" | "escalated" | "waiting_on_client" | "client_replied" | "resolved" | "closed" | "all";
  status?: TicketStatus;
  requestType?: RequestType;
  category?: string;
  priority?: TicketPriority;
  assignee?: "me" | "unassigned" | string;
  orgId?: string;
  q?: string;
  sort?: "priority" | "latest" | "oldest" | "due";
  page?: number;
  pageSize?: number;
}

export interface AgencyViewCounts {
  active: number;
  unassigned: number;
  mine: number;
  overdue: number;
  escalated: number;
  waitingOnClient: number;
  clientReplied: number;
}
