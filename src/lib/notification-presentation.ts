import { formatDateTime } from "@/lib/utils";

/**
 * One vocabulary for notification type, category, timestamp and version provenance.
 *
 * The notification bell, the full notification centre and the configuration-version history all
 * read these mappings, so the same saved event can never be described two different ways in two
 * parts of the product. Nothing here invents a backend event: every key is either a value already
 * stored in `notifications.kind` or a prefix fallback for a future kind using the same convention.
 */

export type NotificationTone = "neutral" | "primary" | "success" | "warning" | "danger" | "violet";

/** The serialised shape returned by the notification server actions and rendered by both centres. */
export interface NotificationListItem {
  id: string;
  kind: string;
  severity: string;
  title: string;
  body: string | null;
  link: string | null;
  /** ISO string, or null when the notification has not been read. */
  read_at: string | null;
  /** ISO string. */
  created_at: string;
}

export type NotificationCategoryKey =
  | "approvals"
  | "workforce"
  | "connectivity"
  | "support"
  | "onboarding"
  | "billing"
  | "projects"
  | "maintenance"
  | "website"
  | "operations"
  | "account"
  | "calendar"
  | "knowledge"
  | "crm"
  | "messaging"
  | "usage"
  | "system";

export interface NotificationCategoryMeta {
  key: NotificationCategoryKey;
  label: string;
  description: string;
  tone: NotificationTone;
}

export const NOTIFICATION_CATEGORIES: Record<NotificationCategoryKey, NotificationCategoryMeta> = {
  approvals: { key: "approvals", label: "Reviews & approvals", description: "Configuration reviews, approvals and decisions that need a person", tone: "violet" },
  workforce: { key: "workforce", label: "AI Workforce", description: "AI employee activity and configuration", tone: "primary" },
  connectivity: { key: "connectivity", label: "Connectivity", description: "Connections that stopped working", tone: "warning" },
  support: { key: "support", label: "Support", description: "Replies and updates on support requests", tone: "primary" },
  onboarding: { key: "onboarding", label: "Onboarding", description: "Setup and provisioning milestones", tone: "violet" },
  billing: { key: "billing", label: "Billing", description: "Payments, credits and billing decisions", tone: "warning" },
  projects: { key: "projects", label: "Custom projects", description: "Project updates, deliverables and decisions", tone: "primary" },
  maintenance: { key: "maintenance", label: "Maintenance", description: "Managed maintenance requests and changes", tone: "neutral" },
  website: { key: "website", label: "Website", description: "Website publishing and domain events", tone: "primary" },
  operations: { key: "operations", label: "Operations", description: "Incidents and important operational alerts", tone: "danger" },
  account: { key: "account", label: "Account", description: "Account, retention and offboarding updates", tone: "neutral" },
  calendar: { key: "calendar", label: "Calendar", description: "Bookings and appointment changes", tone: "primary" },
  knowledge: { key: "knowledge", label: "Knowledge", description: "Knowledge updates and reviews", tone: "violet" },
  crm: { key: "crm", label: "CRM", description: "CRM imports, assignments and automation", tone: "primary" },
  messaging: { key: "messaging", label: "Messaging", description: "Message delivery and channel problems", tone: "warning" },
  usage: { key: "usage", label: "Usage & limits", description: "Allowances, fair use and usage limits", tone: "warning" },
  system: { key: "system", label: "System", description: "Platform notices and account-wide updates", tone: "neutral" },
};

const KIND_CATEGORY: Record<string, NotificationCategoryKey> = {
  approval_requested: "approvals",
  approval_decided: "approvals",
  lead_awaiting_approval: "approvals",
  escalation_action_required: "approvals",
  escalation_fyi: "approvals",
  escalation_claimed: "approvals",
  escalation_unclaimed: "approvals",
  agent_status: "workforce",
  agent_task_completed: "workforce",
  workflow_failure: "workforce",
  integration_disconnected: "connectivity",
  integration_reconnect_required: "connectivity",
  message_blocked: "messaging",
  message_failed: "messaging",
  support_reply: "support",
  support_ticket_created: "support",
  setup_milestone: "onboarding",
  setup_action_required: "onboarding",
  setup_issue: "onboarding",
  setup_ready: "onboarding",
  maintenance_update: "maintenance",
  incident_opened: "operations",
  incident_recovered: "operations",
  account_inactivity_notice: "account",
  retention_attention: "account",
  fair_use_notice: "usage",
  usage_limit_approaching: "usage",
  offboarding_update: "account",
  knowledge_update_ready: "knowledge",
  system: "system",
};

const PREFIX_CATEGORY: Array<[string, NotificationCategoryKey]> = [
  ["billing_", "billing"],
  ["project_", "projects"],
  ["website_", "website"],
  ["domain_", "website"],
  ["crm_", "crm"],
  ["booking_", "calendar"],
];

export function notificationCategory(kind: string | null | undefined): NotificationCategoryMeta {
  if (!kind) return NOTIFICATION_CATEGORIES.system;
  const exact = KIND_CATEGORY[kind];
  if (exact) return NOTIFICATION_CATEGORIES[exact];
  for (const [prefix, key] of PREFIX_CATEGORY) if (kind.startsWith(prefix)) return NOTIFICATION_CATEGORIES[key];
  return NOTIFICATION_CATEGORIES.system;
}

/** The categories present in a list, in the product's stable order, for a compact filter. */
export function presentNotificationCategories(kinds: string[]): NotificationCategoryMeta[] {
  const present = new Set(kinds.map((kind) => notificationCategory(kind).key));
  return Object.values(NOTIFICATION_CATEGORIES).filter((category) => present.has(category.key));
}

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

function validDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dayKey(value: Date, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
  } catch {
    return value.toISOString().slice(0, 10);
  }
}

/** The absolute event time in the workspace's own time zone, including the zone label. */
export function absoluteNotificationTime(value: string | number | Date | null | undefined, timeZone?: string): string {
  const date = validDate(value);
  if (!date) return "Time not recorded";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(date);
  } catch {
    return formatDateTime(date);
  }
}

/**
 * Compact, intentional relative time: "Just now", "5m ago", "2h ago", "Yesterday", "3d ago",
 * then a short calendar date. Calendar-aware boundaries use the workspace's time zone.
 *
 * `now` is always supplied by the caller so a server render and the client-hydrated render use the
 * same instant; a live clock can then tick the value without a hydration mismatch.
 */
export function compactRelativeTime(value: string | number | Date | null | undefined, now: number, timeZone?: string): string {
  const date = validDate(value);
  if (!date) return "Time not recorded";
  const diff = now - date.getTime();
  if (!Number.isFinite(diff)) return "Time not recorded";
  if (diff < 45_000) return "Just now";
  if (diff < 0) return absoluteNotificationTime(date, timeZone);
  if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (dayKey(date, timeZone) === dayKey(new Date(now - 86_400_000), timeZone)) return "Yesterday";
  if (diff < 7 * 86_400_000) return `${Math.max(2, Math.floor(diff / 86_400_000))}d ago`;
  const sameYear = dayKey(date, timeZone).slice(0, 4) === dayKey(new Date(now), timeZone).slice(0, 4);
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      month: "short",
      day: "numeric",
      ...(sameYear ? {} : { year: "numeric" }),
    }).format(date);
  } catch {
    return formatDateTime(date);
  }
}

/** Today, Yesterday, the last week, then one group per calendar month. */
export function notificationGroupLabel(value: string | number | Date, timeZone: string, now: number): string {
  const date = validDate(value);
  if (!date) return "Earlier";
  const key = dayKey(date, timeZone);
  if (key === dayKey(new Date(now), timeZone)) return "Today";
  if (key === dayKey(new Date(now - 86_400_000), timeZone)) return "Yesterday";
  if (date.getTime() > now - 7 * 86_400_000) return "Last 7 days";
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, month: "long", year: "numeric" }).format(date);
  } catch {
    return "Earlier";
  }
}

// ---------------------------------------------------------------------------
// Configuration-version provenance and safety copy
// ---------------------------------------------------------------------------

const SOURCE_LABELS: Record<string, string> = {
  onboarding: "Onboarding configuration",
  client_edit: "Client edit",
  change_request: "Change request",
  rollback: "Restored version",
  agency: "Internal agency edit",
};

/** The label for the source value actually stored with the version. Never guessed from the viewer. */
export function configVersionSourceLabel(source: string | null | undefined): string {
  if (!source) return "Source not recorded";
  return SOURCE_LABELS[source] ?? "Source not recorded";
}

export interface ConfigVersionStatusMeta {
  label: string;
  description: string;
  tone: NotificationTone;
  /** Active means this version is the employee's current configuration. */
  active: boolean;
}

const VERSION_STATUS: Record<string, ConfigVersionStatusMeta> = {
  applied: { label: "Active", description: "This configuration is in use.", tone: "success", active: true },
  pending_agency_review: {
    label: "Awaiting review",
    description: "Held for iAcquire safety review before it can be applied.",
    tone: "warning",
    active: false,
  },
  rejected: { label: "Not approved", description: "Reviewed and not applied. The previous configuration stayed active.", tone: "danger", active: false },
  superseded: { label: "Superseded", description: "Replaced by a newer configuration.", tone: "neutral", active: false },
  draft: { label: "Draft", description: "Saved but not applied.", tone: "primary", active: false },
  pending_approval: { label: "Awaiting approval", description: "Saved and waiting for an approval decision.", tone: "warning", active: false },
};

export function configVersionStatus(status: string | null | undefined): ConfigVersionStatusMeta {
  if (!status) {
    return { label: "Recorded", description: "Recorded in version history.", tone: "neutral", active: false };
  }
  return VERSION_STATUS[status] ?? { label: status.replaceAll("_", " "), description: "Recorded in version history.", tone: "neutral", active: false };
}

const RISK_LABELS: Record<string, string> = {
  override_attempt: "Instruction-override attempt",
  prompt_probe: "Hidden-instruction probe",
  role_hijack: "Role impersonation",
  permission_grant: "Permission escalation",
  secret_request: "Credential request",
  cross_tenant: "Cross-client data request",
  approval_bypass: "Approval bypass",
  markup_injection: "Prompt-boundary injection",
};

/** Human-readable safety flags. Only the flag names already stored by the compiler are shown. */
export function configRiskLabel(flag: string): string {
  return RISK_LABELS[flag] ?? flag.replaceAll("_", " ");
}
