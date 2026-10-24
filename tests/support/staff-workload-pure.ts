// A work item for the tests of the pure workload rules, which need no database.
import type { WorkItem } from "@/lib/staff-workload/sources";

let counter = 0;

/** An open, normal-priority support request assigned to "u-1", with no due date; change what a test is about. Each call gets its own id. */
export const workItem = (over: Partial<WorkItem> = {}): WorkItem => ({
  source: "support", itemId: `i-${(counter += 1)}`, orgId: "o-1", orgName: "Client", assigneeId: "u-1", ref: null, title: "A title", status: "open", priority: "normal", hint: null, dueAt: null,
  dueOn: null, dueKind: null, escalated: false, blocked: false, waitingOnClient: false, optional: false, openReviewTasks: 0, createdAt: "2026-10-01T00:00:00.000Z", lastActivityAt: null, ...over,
});
