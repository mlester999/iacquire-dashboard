// Operations vocabulary shared by the server and the interface: incident sources, severities, and the rules deciding which
// notifications are also sent by email. Pure functions only; nothing here reads the database or the environment.

export const INCIDENT_SOURCES = [
  "database", "scheduler", "ghl", "hermes", "n8n", "appointment_processor", "website", "domain", "messaging", "payments", "queue", "credits", "email", "integration", "automation",
] as const;
export type IncidentSource = (typeof INCIDENT_SOURCES)[number];
export type IncidentSeverity = "info" | "warning" | "critical";
export type IncidentStatus = "open" | "acknowledged" | "resolved";

export const SOURCE_LABELS: Record<IncidentSource, string> = {
  database: "Database", scheduler: "Scheduled jobs", ghl: "GoHighLevel", hermes: "AI employees", n8n: "n8n automation", appointment_processor: "Appointment processing",
  website: "Website", domain: "Domain", messaging: "Messaging", payments: "Payments", queue: "Work queue", credits: "Service credits", email: "Email delivery",
  integration: "Connection", automation: "Automation",
};

export const SEVERITY_RANK: Record<IncidentSeverity, number> = { info: 0, warning: 1, critical: 2 };

/**
 * Turns an error into a short, safe sentence for a record that people read: no stack, no URLs, nothing that looks like a secret.
 * The error class is kept because it is what an operator needs first.
 */
export function sanitizeErrorText(err: unknown, max = 300): string {
  const name = err instanceof Error ? err.name : "Error";
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "unknown error";
  const cleaned = raw
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s)'"]+/gi, "[url]")
    .replace(/\b(?:sk|pk|whsec|eyJ)[A-Za-z0-9._-]{12,}/g, "[redacted]")
    .replace(/\b[A-Za-z0-9+/_-]{32,}\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return `${name}: ${cleaned}`.slice(0, max);
}

// ---------------------------------------------------------------------------
// Which notifications are emailed
// ---------------------------------------------------------------------------

export type EmailPreference = "important" | "all" | "off";
export const EMAIL_PREFERENCES: EmailPreference[] = ["important", "all", "off"];

/** Kinds worth an email by default even when they are only informational: someone needs to act, or it concerns money or the live site. */
const IMPORTANT_KINDS = new Set([
  "escalation_action_required", "escalation_unclaimed", "approval_requested", "booking_confirmed", "support_reply", "billing_payment_received", "billing_payment_failed",
  "billing_low_balance", "billing_credits_exhausted", "billing_budget_warning", "booking_cancelled", "booking_rescheduled", "booking_conflict", "booking_needs_action", "retention_attention", "fair_use_notice", "offboarding_update", "setup_action_required", "setup_ready", "website_published", "website_publish_failed",
  "domain_verified", "domain_renewal_due", "domain_issue", "incident_opened", "incident_recovered", "integration_reconnect_required", "integration_disconnected",
  "account_inactivity_notice", "project_quote", "workflow_failure", "message_failed",
]);

/**
 * Kinds whose body can contain what a customer wrote or a lead's details. Email is outside the portal's access controls, so these
 * are emailed as a title and a link only; the details stay behind the sign-in.
 */
const CUSTOMER_CONTENT_KINDS = new Set(["escalation_action_required", "escalation_fyi", "escalation_claimed", "escalation_unclaimed", "message_blocked", "message_failed", "system", "booking_confirmed", "booking_cancelled", "booking_rescheduled", "booking_conflict", "booking_needs_action", "lead_awaiting_approval"]);

/** Kinds that already send their own email (owner-first escalations honour the person's own alert settings; setup updates email from the setup engine; support updates follow the delivery rules the Super Admin chose). */
export const emailedElsewhere = (kind: string) => kind.startsWith("escalation_") || kind.startsWith("setup_") || kind.startsWith("support_");

/**
 * Warnings that stay in the app unless the person chose to be emailed everything. The Unified Inbox raises one "customer is waiting" notice per customer
 * message (at most ten a scan per workspace); a warning is emailed by default, so without this the first scheduler run in a workspace with the new
 * inbox would email its team for each of them, and again each morning for ones held back by quiet hours.
 */
const IN_APP_BY_DEFAULT = new Set(["conversation_awaiting_reply", "missed_call_follow_up", "hot_lead_detected", "web_chat_lead", "social_approval_requested", "social_approval_decided", "social_post_failed", "social_account_attention"]);

export function shouldEmail(kind: string, severity: string, preference: EmailPreference): boolean {
  if (preference === "off") return severity === "critical";
  if (preference === "all") return true;
  if (IN_APP_BY_DEFAULT.has(kind) && severity !== "critical") return false;
  return severity === "critical" || severity === "warning" || IMPORTANT_KINDS.has(kind);
}

export const emailIncludesBody = (kind: string) => !CUSTOMER_CONTENT_KINDS.has(kind);

export function parseEmailPreference(prefs: unknown): EmailPreference {
  const value = typeof prefs === "object" && prefs !== null ? (prefs as Record<string, unknown>).email : undefined;
  return value === "all" || value === "off" || value === "important" ? value : "important";
}

/** Plain names for the scheduled jobs, for the agency health page. */
export const JOB_LABELS: Record<string, string> = {
  tick: "Whole scheduler run",
  expiredReservations: "Release expired credit holds",
  escalationsOpened: "Open escalations to staff",
  followUpsPrepared: "Prepare due follow-ups",
  repliesChecked: "Draft replies to new messages",
  approvalExpiry: "Expire old approval requests",
  bookingHolds: "Release abandoned booking holds",
  appointmentReminders: "Queue appointment reminders",
  retentionPrograms: "Run customer retention programs",
  missedCallRecovery: "Follow up missed calls",
  phase2Retention: "Clear out old missed-call and lead-score records",
  webChatRetention: "Clear out old website chats",
  socialPublisher: "Publish due social media posts",
  socialAccountHealth: "Check social media account connections",
  socialMetrics: "Read social media engagement numbers",
  socialCleanup: "Clear out unfinished social media sign-ins and removed media files",
  leadScoreReassessment: "Re-score leads whose details changed",
  messagesDispatched: "Send queued messages",
  websiteEnquiries: "Turn website enquiries into leads",
  domainRenewals: "Domain renewal reminders",
  websiteHealth: "Check live websites",
  notificationEmails: "Email notifications",
  incidentChecks: "Run health checks",
  incidentEscalations: "Re-alert unacknowledged incidents",
  supportResponseTargets: "Check support response targets",
  supportEmails: "Send support email updates",
  supportAutoClose: "Close resolved support requests",
  supportAttachmentCleanup: "Remove unsent support files",
  fairUseChecks: "Measure usage against fair-use limits",
  inactivityReview: "Review accounts that have gone quiet",
  offboardingReminders: "Remind departing clients before deletion",
  aiWorkRecovery: "Recover stalled AI work jobs",
  aiWorkSchedules: "Run due AI workforce schedules",
  aiWorkTriggers: "Run AI workforce event triggers",
  aiProactiveHeldReports: "Release proactive reports held by quiet hours",
  aiProactiveBriefings: "Generate opted-in AI workforce briefings",
};
