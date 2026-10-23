// How the proposals list is cut and written. Pure: the page reads a filter from the address and these decide what it means; nothing here touches the database.
import { formatMinor, isCurrency } from "@/lib/money";
import { BILLINGS, type Billing } from "@/lib/proposals/doc";
import { OPEN_STATUSES, type ProposalStatus } from "@/lib/proposals/state";
import { daysBetween, formatDay } from "@/lib/proposals/validity";

export const LIST_FILTERS = [
  { key: "open", label: "Open", statuses: OPEN_STATUSES },
  { key: "waiting", label: "Waiting for approval", statuses: ["pending_approval"] },
  { key: "out", label: "With the customer", statuses: ["sent"] },
  { key: "answered", label: "Answered", statuses: ["accepted", "declined"] },
  { key: "closed", label: "Closed without an answer", statuses: ["rejected", "expired", "withdrawn"] },
  { key: "all", label: "All", statuses: [] },
] as const satisfies ReadonlyArray<{ key: string; label: string; statuses: readonly ProposalStatus[] }>;

export type ListFilterKey = (typeof LIST_FILTERS)[number]["key"];

/** The filter named in the address; an unknown word is the default (open proposals), never an error. */
export function parseListFilter(raw: string | string[] | undefined): ListFilterKey {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return LIST_FILTERS.find((f) => f.key === v)?.key ?? "open";
}

/** The statuses a filter keeps; undefined keeps everything. */
export function statusesFor(key: ListFilterKey): ProposalStatus[] | undefined {
  const f = LIST_FILTERS.find((x) => x.key === key);
  return f && f.statuses.length ? [...f.statuses] : undefined;
}

export const WORKSPACE_TABS = ["edit", "preview", "versions", "activity", "delivery", "signature"] as const;
export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];

/** The tab named in the address ("?tab=delivery", which a notification can link to); anything else opens the editor. */
export function parseWorkspaceTab(raw: string | string[] | undefined): WorkspaceTab {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return WORKSPACE_TABS.find((t) => t === v) ?? "edit";
}

const GROUP_WORDS: Record<Billing, string> = { one_time: "once", monthly: "per month", yearly: "per year" };

/**
 * A proposal's totals in words: "USD 1,680.00 once + USD 99.00 per month". The groups are never added together. A proposal with nothing in any group says so rather than
 * showing a zero that looks like a price.
 */
export function groupTotalsText(totals: Record<Billing, number>, currency: string): string {
  if (!isCurrency(currency)) return "Total not available";
  const parts = BILLINGS.filter((b) => totals[b] > 0).map((b) => `${formatMinor(totals[b], currency)} ${GROUP_WORDS[b]}`);
  return parts.length ? parts.join(" + ") : "No amount yet";
}

/** The valid-until date for a list row, with how long is left where the workspace is. `today` is the workspace's own date. */
export function validityNote(validUntil: string | null, today: string): { text: string; tone: "neutral" | "warning" | "danger" } | null {
  if (!validUntil) return null;
  const left = daysBetween(today, validUntil);
  const date = formatDay(validUntil);
  if (left < 0) return { text: `Valid until ${date} (passed)`, tone: "danger" };
  if (left === 0) return { text: `Valid until ${date} (last day)`, tone: "warning" };
  if (left <= 3) return { text: `Valid until ${date} (${left} ${left === 1 ? "day" : "days"} left)`, tone: "warning" };
  return { text: `Valid until ${date}`, tone: "neutral" };
}

/** What a person should do next with a proposal, or null when there is nothing for them to do. Used to put proposals that need someone first. */
export function nextStep(status: ProposalStatus, i: { canApprove: boolean; canSend: boolean; canCreate: boolean }): string | null {
  switch (status) {
    case "draft": return i.canCreate ? "Finish the draft and send it for approval" : null;
    case "changes_requested": return i.canCreate ? "Make the changes a reviewer asked for" : null;
    case "pending_approval": return i.canApprove ? "Review and decide" : null;
    case "approved": return i.canSend ? "Send it to the customer" : null;
    case "sent": return null;
    default: return null;
  }
}
