import type { StatusTone } from "@/components/ui/status";
import type { SlaState } from "@/lib/support/sla";
import type { AgencyListQuery } from "@/server/support/types";

export type View = NonNullable<AgencyListQuery["view"]>;

export const VIEWS: Array<{ value: View; label: string; hint: string; count?: "active" | "unassigned" | "mine" | "overdue" | "escalated" | "waitingOnClient" | "clientReplied" }> = [
  { value: "active", label: "Active", hint: "Everything still being worked on", count: "active" },
  { value: "unassigned", label: "Unassigned", hint: "Nobody owns these yet", count: "unassigned" },
  { value: "mine", label: "Mine", hint: "Assigned to you", count: "mine" },
  { value: "client_replied", label: "Client replied", hint: "The client wrote since the team last looked", count: "clientReplied" },
  { value: "overdue", label: "Overdue", hint: "Past their response target", count: "overdue" },
  { value: "escalated", label: "Escalated", hint: "Flagged for attention", count: "escalated" },
  { value: "waiting_on_client", label: "Waiting on client", hint: "The team is waiting for an answer", count: "waitingOnClient" },
  { value: "resolved", label: "Resolved", hint: "Marked resolved" },
  { value: "closed", label: "Closed", hint: "Finished" },
  { value: "all", label: "All", hint: "Every request you can see" },
];

export const SLA_TONE: Record<SlaState, StatusTone> = { none: "neutral", on_track: "success", approaching: "warning", overdue: "danger", waiting_on_client: "neutral", resolved: "neutral" };

export interface QueueQuery {
  view: View;
  q: string;
  status: string;
  requestType: string;
  category: string;
  priority: string;
  assignee: string;
  orgId: string;
  sort: "priority" | "latest" | "oldest" | "due";
  page: number;
  ticket: string;
}

export function queueHref(query: QueueQuery, patch: Partial<QueueQuery>): string {
  const next = { ...query, ...patch };
  const params = new URLSearchParams();
  if (next.view !== "active") params.set("view", next.view);
  if (next.q) params.set("q", next.q);
  for (const [key, value] of [["status", next.status], ["type", next.requestType], ["category", next.category], ["priority", next.priority], ["assignee", next.assignee], ["org", next.orgId]] as const) {
    if (value) params.set(key, value);
  }
  if (next.sort !== "priority") params.set("sort", next.sort);
  if (next.page > 1) params.set("page", String(next.page));
  if (next.ticket) params.set("ticket", next.ticket);
  const s = params.toString();
  return `/admin/support${s ? `?${s}` : ""}`;
}
