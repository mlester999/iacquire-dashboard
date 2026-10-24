// Support & Requests vocabulary shared by the server, the database tests and the interface. Pure data and functions only:
// nothing here reads the database or the environment. supabase/migrations/0065_support_requests.sql mirrors the status
// transition table and the category lists, and tests/support-lifecycle.test.ts fails if the two drift apart.

export const REQUEST_TYPES = ["support", "issue", "feedback", "change"] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];
/** The types a person can start from the assistant (AQi) and the help widget. A change needs a target and a project, so it has its own page. */
export const ASSISTANT_REQUEST_TYPES = ["support", "issue", "feedback"] as const satisfies readonly RequestType[];

/** One lifecycle for every request type. Feedback shows the same states under its own wording (see FEEDBACK_STAGES). */
export const TICKET_STATUSES = ["new", "open", "in_progress", "waiting_for_client", "resolved", "closed"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** Requests that are still being worked on or waiting for someone. */
export const ACTIVE_STATUSES = ["new", "open", "in_progress", "waiting_for_client"] as const satisfies readonly TicketStatus[];
/** Active requests where the next move belongs to the iAcquire team (the response clock runs only in these). */
export const AWAITING_AGENCY_STATUSES = ["new", "open", "in_progress"] as const satisfies readonly TicketStatus[];
export const DONE_STATUSES = ["resolved", "closed"] as const satisfies readonly TicketStatus[];

export const isActiveStatus = (status: string) => (ACTIVE_STATUSES as readonly string[]).includes(status);
export const isAwaitingAgency = (status: string) => (AWAITING_AGENCY_STATUSES as readonly string[]).includes(status);
export const isDoneStatus = (status: string) => (DONE_STATUSES as readonly string[]).includes(status);

export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TicketPriority = (typeof PRIORITIES)[number];
export const PRIORITY_RANK: Record<TicketPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

/**
 * Allowed status changes. Reopening is resolved -> open (client or staff) and closed -> open (staff only, enforced by the service).
 * Nothing moves back to "new": a request is new only until the team first touches it.
 */
export const STATUS_TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  new: ["open", "in_progress", "waiting_for_client", "resolved", "closed"],
  open: ["in_progress", "waiting_for_client", "resolved", "closed"],
  in_progress: ["open", "waiting_for_client", "resolved", "closed"],
  waiting_for_client: ["open", "in_progress", "resolved", "closed"],
  resolved: ["open", "closed"],
  closed: ["open"],
};

export function canTransition(from: TicketStatus, to: TicketStatus): boolean {
  return from === to || STATUS_TRANSITIONS[from].includes(to);
}

/** A change that moves a finished request back into active work. */
export const isReopen = (from: TicketStatus, to: TicketStatus) => isDoneStatus(from) && isActiveStatus(to);

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/** Categories a client can choose per request type. "Legacy" categories exist only on requests created by other modules or earlier versions. */
export const SUPPORT_CATEGORIES = ["general", "account", "crm", "ai_employees", "integrations", "website", "billing", "other"] as const;
export const ISSUE_CATEGORIES = ["feature_not_working", "crm", "ai_employees", "integrations", "website", "incorrect_information", "performance", "access", "other"] as const;
export const FEEDBACK_CATEGORIES = ["feature_suggestion", "improvement", "ux_feedback", "positive_feedback", "general_suggestion"] as const;
export const CHANGE_CATEGORIES = ["change_ai_employee", "change_website", "change_automation", "change_integration", "change_project", "change_other"] as const;
export const LEGACY_CATEGORIES = ["bug", "onboarding", "project", "maintenance"] as const;

export const CATEGORIES_BY_TYPE = {
  support: SUPPORT_CATEGORIES,
  issue: ISSUE_CATEGORIES,
  feedback: FEEDBACK_CATEGORIES,
  change: CHANGE_CATEGORIES,
} as const satisfies Record<RequestType, readonly string[]>;

export const ALL_CATEGORIES = [...new Set<string>([...SUPPORT_CATEGORIES, ...ISSUE_CATEGORIES, ...FEEDBACK_CATEGORIES, ...CHANGE_CATEGORIES, ...LEGACY_CATEGORIES])] as readonly string[];

export const CATEGORY_LABELS: Record<string, { label: string; hint?: string }> = {
  general: { label: "General question", hint: "Anything that doesn't fit the other topics." },
  account: { label: "Account help", hint: "Sign-in, team members, roles and workspace details." },
  crm: { label: "CRM help", hint: "Contacts, pipelines, tasks and calendars." },
  ai_employees: { label: "AI employee question", hint: "How your AI employees work, behave or answer." },
  integrations: { label: "Integration help", hint: "Connecting or fixing a connected service." },
  website: { label: "Website help", hint: "Your website, pages, forms or domain." },
  billing: { label: "Billing or usage", hint: "Credits, usage, invoices and plan questions." },
  other: { label: "Something else" },
  feature_not_working: { label: "A feature isn't working", hint: "Something stopped working or behaves wrongly." },
  incorrect_information: { label: "Incorrect information shown", hint: "A number, name, date or message looks wrong." },
  performance: { label: "Slow or stuck", hint: "A page is slow, frozen or never finishes loading." },
  access: { label: "Access or permission problem", hint: "You can't open something you should be able to." },
  feature_suggestion: { label: "Feature suggestion", hint: "Something new you'd like iAcquire to do." },
  improvement: { label: "Improvement idea", hint: "A way to make something that exists work better." },
  ux_feedback: { label: "Ease of use", hint: "Something confusing, awkward or hard to find." },
  positive_feedback: { label: "What's working well", hint: "Tell us what you value." },
  general_suggestion: { label: "General suggestion" },
  change_ai_employee: { label: "An AI employee", hint: "Change how an AI employee answers, behaves or what it knows." },
  change_website: { label: "My website", hint: "Change a page, a form, the layout or the domain." },
  change_automation: { label: "An automation or workflow", hint: "Change what happens automatically, and when." },
  change_integration: { label: "A connected service", hint: "Change how a connected service is set up or used." },
  change_project: { label: "A custom project", hint: "Change something about a custom project we are building for you." },
  change_other: { label: "Something else" },
  bug: { label: "Bug report" },
  onboarding: { label: "Onboarding" },
  project: { label: "Custom project" },
  maintenance: { label: "Maintenance" },
};

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category]?.label ?? category.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

export function isCategoryForType(type: RequestType, category: string): boolean {
  return (CATEGORIES_BY_TYPE[type] as readonly string[]).includes(category);
}

export const REQUEST_TYPE_LABELS: Record<RequestType, { label: string; plural: string; verb: string }> = {
  support: { label: "Support request", plural: "Support requests", verb: "asked for help" },
  issue: { label: "Issue report", plural: "Issue reports", verb: "reported an issue" },
  feedback: { label: "Feedback", plural: "Feedback", verb: "shared feedback" },
  change: { label: "Change request", plural: "Change requests", verb: "asked for a change" },
};

/** Features a request can relate to. Stored as a short code; "page" in diagnostics is a separate, optional path. */
export const AFFECTED_FEATURES = [
  "crm", "inbox", "ai_workforce", "leads", "appointments", "knowledge", "website", "integrations", "billing", "setup", "projects", "analytics", "settings", "other",
] as const;
export type AffectedFeature = (typeof AFFECTED_FEATURES)[number];
export const FEATURE_LABELS: Record<AffectedFeature, string> = {
  crm: "CRM (contacts, pipelines, tasks)",
  inbox: "Inbox and messages",
  ai_workforce: "AI employees",
  leads: "Leads",
  appointments: "Appointments and calendar",
  knowledge: "Knowledge Center",
  website: "Website",
  integrations: "Connected services",
  billing: "Billing and credits",
  setup: "Setup Center",
  projects: "Custom projects",
  analytics: "Analytics and reports",
  settings: "Settings and team",
  other: "Something else",
};
export const featureLabel = (feature: string | null | undefined) => (feature ? (FEATURE_LABELS as Record<string, string>)[feature] ?? feature : null);

/** What the person tells us about impact. Deliberately separate from the priority the iAcquire team assigns. */
export const CLIENT_URGENCIES = ["not_urgent", "soon", "blocking"] as const;
export type ClientUrgency = (typeof CLIENT_URGENCIES)[number];
export const CLIENT_URGENCY_LABELS: Record<ClientUrgency, { label: string; hint: string }> = {
  not_urgent: { label: "Not urgent", hint: "I can keep working; fix it when you can." },
  soon: { label: "Needs attention soon", hint: "It's slowing me down or affecting customers." },
  blocking: { label: "Blocking my work", hint: "I can't do something important right now." },
};

// ---------------------------------------------------------------------------
// Feedback wording
// ---------------------------------------------------------------------------

export const FEEDBACK_STAGES = ["received", "under_review", "planned", "completed", "not_planned"] as const;
export type FeedbackStage = (typeof FEEDBACK_STAGES)[number];
/** Feedback keeps the shared lifecycle; each stage sets the status it belongs to. */
export const FEEDBACK_STAGE_STATUS: Record<FeedbackStage, TicketStatus> = {
  received: "new",
  under_review: "open",
  planned: "in_progress",
  completed: "resolved",
  not_planned: "closed",
};
export const FEEDBACK_STAGE_LABELS: Record<FeedbackStage, { label: string; description: string }> = {
  received: { label: "Received", description: "We have your feedback." },
  under_review: { label: "Under review", description: "The team is considering it." },
  planned: { label: "Planned", description: "It is on the team's plan. This is not a delivery date." },
  completed: { label: "Completed", description: "It has been delivered." },
  not_planned: { label: "Not planned", description: "The team does not plan to do this right now." },
};
export function nextFeedbackStageOptions(current: FeedbackStage | null): FeedbackStage[] {
  const from = current ?? "received";
  return FEEDBACK_STAGES.filter((stage) => stage !== from);
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const AGENCY_STATUS_LABELS: Record<TicketStatus, string> = {
  new: "New",
  open: "Open",
  in_progress: "In progress",
  waiting_for_client: "Waiting on client",
  resolved: "Resolved",
  closed: "Closed",
};
const CLIENT_STATUS_LABELS: Record<TicketStatus, string> = {
  ...AGENCY_STATUS_LABELS,
  new: "Received",
  waiting_for_client: "Waiting for you",
};

export const statusLabelForAgency = (status: string) => (AGENCY_STATUS_LABELS as Record<string, string>)[status] ?? status.replace(/_/g, " ");

/** The wording a client sees. Feedback shows its stage; everything else uses the shared lifecycle. */
export function statusLabelForClient(status: string, type: RequestType = "support", stage: FeedbackStage | null = null): string {
  if (type === "feedback" && stage) return FEEDBACK_STAGE_LABELS[stage].label;
  return (CLIENT_STATUS_LABELS as Record<string, string>)[status] ?? status.replace(/_/g, " ");
}

/** A plain sentence about where the request stands, from the client's point of view. Never claims work the team has not started. */
export function clientProgressSentence(input: { status: string; type: RequestType; stage: FeedbackStage | null; assigned: boolean; hasAgencyReply: boolean }): string {
  if (input.type === "feedback" && input.stage) return FEEDBACK_STAGE_LABELS[input.stage].description;
  switch (input.status) {
    case "new":
      return "We've received your request. The team hasn't picked it up yet.";
    case "waiting_for_client":
      return "The iAcquire team replied and is waiting for your response.";
    case "resolved":
      return "The iAcquire team marked this as resolved. You can reopen it if it isn't.";
    case "closed":
      return "This request is closed.";
    default:
      return input.assigned ? "An iAcquire team member is working on this." : input.hasAgencyReply ? "The team has replied and is reviewing your request." : "Waiting for an iAcquire team member to pick this up.";
  }
}

// ---------------------------------------------------------------------------
// Reopening
// ---------------------------------------------------------------------------

/** Whether a client may reopen: only a resolved request, and only inside the window the agency configured (0 = never). */
export function clientCanReopen(input: { status: string; resolvedAt: Date | string | null; windowDays: number; now?: Date }): boolean {
  if (input.status !== "resolved" || input.windowDays <= 0) return false;
  if (!input.resolvedAt) return true;
  const resolved = new Date(input.resolvedAt).getTime();
  const now = (input.now ?? new Date()).getTime();
  return now - resolved <= input.windowDays * 86_400_000;
}

// ---------------------------------------------------------------------------
// Timeline events
// ---------------------------------------------------------------------------

export const EVENT_KINDS = [
  "created", "reply", "note", "attachment", "status_changed", "feedback_stage", "assigned", "unassigned", "priority_changed", "escalated", "de_escalated",
  "reopened", "resolved", "closed", "linked", "merged", "sla_alert", "ai_assist", "change_classified",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
/** Events a client may see on their own timeline. Everything else is for the team only. */
export const CLIENT_VISIBLE_EVENTS = ["created", "reply", "attachment", "status_changed", "feedback_stage", "assigned", "reopened", "resolved", "closed"] as const satisfies readonly EventKind[];
export const isClientVisibleEvent = (kind: string) => (CLIENT_VISIBLE_EVENTS as readonly string[]).includes(kind);

// ---------------------------------------------------------------------------
// Notification events (Super Admin configures how each one is delivered)
// ---------------------------------------------------------------------------

export const SUPPORT_EVENTS = [
  "request_submitted", "assigned", "agency_reply", "client_reply", "status_changed", "priority_escalated",
  "response_approaching", "response_overdue", "resolved", "reopened", "closed",
] as const;
export type SupportEvent = (typeof SUPPORT_EVENTS)[number];
export const DELIVERY_MODES = ["in_app", "email", "both", "disabled"] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

export const SUPPORT_EVENT_INFO: Record<SupportEvent, { label: string; recipients: string; defaultMode: DeliveryMode }> = {
  request_submitted: { label: "New request submitted", recipients: "The iAcquire team members who handle that client", defaultMode: "in_app" },
  assigned: { label: "Request assigned", recipients: "The team member it is assigned to", defaultMode: "in_app" },
  agency_reply: { label: "New reply from the iAcquire team", recipients: "The people on the client's side of that request", defaultMode: "both" },
  client_reply: { label: "New reply from the client", recipients: "The assigned team member, or the handling team when unassigned", defaultMode: "in_app" },
  status_changed: { label: "Status changed", recipients: "The people on the client's side of that request", defaultMode: "in_app" },
  priority_escalated: { label: "Priority raised or request escalated", recipients: "The assigned team member and the team members who manage priorities", defaultMode: "in_app" },
  response_approaching: { label: "Response target approaching", recipients: "The assigned team member, or the handling team when unassigned", defaultMode: "in_app" },
  response_overdue: { label: "Response overdue", recipients: "The assigned team member and the team members who manage priorities", defaultMode: "both" },
  resolved: { label: "Request resolved", recipients: "The people on the client's side of that request", defaultMode: "both" },
  reopened: { label: "Request reopened", recipients: "The assigned team member, or the handling team when unassigned", defaultMode: "in_app" },
  closed: { label: "Request closed", recipients: "The people on the client's side of that request", defaultMode: "in_app" },
};

/** The in-app notification kind (see notifications_kind_check) each event is delivered as. */
export const EVENT_NOTIFICATION_KIND: Record<SupportEvent, "support_ticket_created" | "support_assigned" | "support_reply" | "support_status" | "support_escalated" | "support_sla"> = {
  request_submitted: "support_ticket_created",
  assigned: "support_assigned",
  agency_reply: "support_reply",
  client_reply: "support_reply",
  status_changed: "support_status",
  priority_escalated: "support_escalated",
  response_approaching: "support_sla",
  response_overdue: "support_sla",
  resolved: "support_status",
  reopened: "support_status",
  closed: "support_status",
};

export const modeSendsInApp = (mode: DeliveryMode) => mode === "in_app" || mode === "both";
export const modeSendsEmail = (mode: DeliveryMode) => mode === "email" || mode === "both";
export const MODE_LABELS: Record<DeliveryMode, string> = { in_app: "In-app only", email: "Email only", both: "In-app and email", disabled: "Off" };

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export const ATTACHMENT_TYPES = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  txt: "text/plain",
  csv: "text/csv",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
} as const;
export const ATTACHMENT_ACCEPT = Object.keys(ATTACHMENT_TYPES).map((e) => `.${e}`).join(",");
export const ATTACHMENT_TYPE_SUMMARY = "PNG, JPG, WebP, PDF, Word (.docx), CSV or text";
export const DEFAULT_MAX_ATTACHMENT_MB = 10;
export const DEFAULT_MAX_ATTACHMENTS = 5;

export const isImageFile = (name: string) => /\.(png|jpe?g|webp)$/i.test(name);

// ---------------------------------------------------------------------------
// Defaults the Super Admin can change (support_settings)
// ---------------------------------------------------------------------------

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export const WEEKDAY_LABELS: Record<Weekday, string> = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };
export type BusinessHours = Partial<Record<Weekday, Array<[string, string]>>>;

export const DEFAULT_BUSINESS_HOURS: BusinessHours = {
  mon: [["09:00", "17:00"]], tue: [["09:00", "17:00"]], wed: [["09:00", "17:00"]], thu: [["09:00", "17:00"]], fri: [["09:00", "17:00"]],
};
