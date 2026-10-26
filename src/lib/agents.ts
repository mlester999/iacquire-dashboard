// Client-safe metadata for the six AI employee roles. Mirrors the agent_roles reference rows.

export const AGENT_ROLE_KEYS = [
  "operations_manager",
  "lead_hunter",
  "appointment_setter",
  "sales_assistant",
  "crm_manager",
  "performance_analyst",
] as const;

export type AgentRoleKey = (typeof AGENT_ROLE_KEYS)[number];

/** Existing iAcquire Hermes employees, confirmed by the agency's Hermes profile inventory. */
export const AGENCY_HERMES_PROFILE_IDS: Record<AgentRoleKey, string> = {
  operations_manager: "iacquire-operations-manager",
  lead_hunter: "iacquire-lead-hunter",
  appointment_setter: "iacquire-appointment-setter",
  sales_assistant: "iacquire-sales-assistant",
  crm_manager: "iacquire-crm-manager",
  performance_analyst: "iacquire-analyst",
};

export interface RoleQuestion {
  id: string;
  label: string;
  placeholder: string;
  help?: string;
}

export interface AgentRoleMeta {
  key: AgentRoleKey;
  slug: string;
  name: string;
  shortName: string;
  tagline: string;
  accent: string;
  /** Text-safe variant of the accent for small labels on light surfaces. */
  ink: string;
  mascot: string;
  questions: RoleQuestion[];
  suggestedPrompts: string[];
  activityWords: string;
}

export const AGENT_ROLES: AgentRoleMeta[] = [
  {
    key: "operations_manager",
    slug: "operations-manager",
    name: "AI Operations Manager",
    shortName: "Operations Manager",
    tagline: "Keeps your AI team coordinated and on track.",
    accent: "#7C8BA6",
    ink: "#4A5872",
    mascot: "/mascots/operations-manager",
    questions: [
      {
        id: "priorities",
        label: "What daily tasks should your AI team prioritise?",
        placeholder: "e.g. Respond to new inquiries first, then follow up on open quotes",
        help: "Describe the internal work that should come first each day. Focus on outcomes, not step-by-step instructions.",
      },
      {
        id: "approval_rules",
        label: "Which decisions require your approval?",
        placeholder: "e.g. Anything that contacts a customer or changes a price",
        help: "Name the decisions that must involve a person. This cannot relax iAcquire's mandatory approvals.",
      },
    ],
    suggestedPrompts: [
      "Summarise what needs my attention today",
      "What's blocking our pipeline this week?",
      "Draft a weekly operations summary",
    ],
    activityWords: "coordinating",
  },
  {
    key: "lead_hunter",
    slug: "lead-hunter",
    name: "AI Lead Hunter",
    shortName: "Lead Hunter",
    tagline: "Finds and evaluates businesses that fit your ideal customer.",
    accent: "#5CCB2E",
    ink: "#2F7A12",
    mascot: "/mascots/lead-hunter",
    questions: [
      {
        id: "targets",
        label: "What businesses or people should we target?",
        placeholder: "e.g. Independent dental clinics with 2–10 dentists",
        help: "Describe the type of business or person that fits your ideal customer profile. This is used to decide what to research.",
      },
      {
        id: "qualification",
        label: "What locations, industries and qualification rules matter?",
        placeholder: "e.g. Texas and Florida only; must have an online booking page",
        help: "Add the locations, industries and must-have signals that make a lead worth pursuing. The employee cannot contact leads from this setting.",
      },
    ],
    suggestedPrompts: [
      "What makes a lead a good fit for us?",
      "Explain how you score leads",
      "Which industries should we research next?",
    ],
    activityWords: "researching",
  },
  {
    key: "appointment_setter",
    slug: "appointment-setter",
    name: "AI Appointment Setter",
    shortName: "Appointment Setter",
    tagline: "Turns qualified interest into booked meetings.",
    accent: "#FF9500",
    ink: "#A35A00",
    mascot: "/mascots/appointment-setter",
    questions: [
      {
        id: "meeting_types",
        label: "What type of meetings do you offer?",
        placeholder: "e.g. 30-minute discovery call over video",
        help: "List each meeting type and how long it lasts. The employee only offers the types you list here.",
      },
      {
        id: "hours",
        label: "What are your approved appointment hours?",
        placeholder: "e.g. Weekdays 9am–5pm Eastern, no Fridays after 3pm",
        help: "State when appointments may be offered. Real availability still comes from your connected calendar.",
      },
    ],
    suggestedPrompts: [
      "What appointments do I have this week?",
      "How do you handle a reschedule request?",
      "What should you confirm before booking?",
    ],
    activityWords: "scheduling",
  },
  {
    key: "sales_assistant",
    slug: "sales-assistant",
    name: "AI Sales Assistant",
    shortName: "Sales Assistant",
    tagline: "Prepares follow-ups, proposals and discovery calls.",
    accent: "#FF2E93",
    ink: "#B0125F",
    mascot: "/mascots/sales-assistant",
    questions: [
      {
        id: "offers",
        label: "What are your main offers?",
        placeholder: "e.g. Website redesign from $3,000; monthly SEO from $800",
        help: "Summarise what you sell and any approved prices or limits. The employee must not invent figures you have not provided.",
      },
      {
        id: "approach",
        label: "What sales approach and follow-up style do you prefer?",
        placeholder: "e.g. Consultative and patient; follow up after 2 days, then weekly",
        help: "Describe the tone and cadence for follow-ups, and when a person should take over the conversation.",
      },
    ],
    suggestedPrompts: [
      "Draft a friendly follow-up for a quiet prospect",
      "Help me prepare for a discovery call",
      "Outline a proposal for a new client",
    ],
    activityWords: "drafting",
  },
  {
    key: "crm_manager",
    slug: "crm-manager",
    name: "AI CRM Manager",
    shortName: "CRM Manager",
    tagline: "Keeps your customer records clean and organised.",
    accent: "#0A84FF",
    ink: "#0558B0",
    mascot: "/mascots/crm-manager",
    questions: [
      {
        id: "important_info",
        label: "What customer information is most important?",
        placeholder: "e.g. Budget, decision maker, preferred contact time",
        help: "List the fields your team needs on every record. Keep it to information your workspace already collects.",
      },
      {
        id: "stages",
        label: "What sales stages does your business use?",
        placeholder: "e.g. New inquiry → Qualified → Proposal → Won/Lost",
        help: "Name your pipeline stages in order, from first contact to closed. The employee uses this to organise records consistently.",
      },
    ],
    suggestedPrompts: [
      "How should we organise our pipeline stages?",
      "What makes a CRM record complete?",
      "How do you spot duplicate contacts?",
    ],
    activityWords: "organising",
  },
  {
    key: "performance_analyst",
    slug: "performance-analyst",
    name: "AI Performance Analyst",
    shortName: "Performance Analyst",
    tagline: "Explains what is working and what to improve.",
    accent: "#12C9A5",
    ink: "#0B7A64",
    mascot: "/mascots/performance-analyst",
    questions: [
      {
        id: "results",
        label: "Which results matter most to you?",
        placeholder: "e.g. Booked calls per week and close rate",
        help: "Describe the outcomes you want to improve. Clear business results help the employee choose what to report on.",
      },
      {
        id: "metrics",
        label: "What metrics should we prioritise?",
        placeholder: "e.g. Response time, cost per lead, show-up rate",
        help: "Name the measures the employee should watch. It can only analyse data it is authorised to access.",
      },
    ],
    suggestedPrompts: [
      "Which metrics should I watch weekly?",
      "How do I read my conversion funnel?",
      "What would improve our show-up rate?",
    ],
    activityWords: "analysing",
  },
];

export const AGENT_BY_KEY = Object.fromEntries(AGENT_ROLES.map((r) => [r.key, r])) as Record<AgentRoleKey, AgentRoleMeta>;
export const AGENT_BY_SLUG = Object.fromEntries(AGENT_ROLES.map((r) => [r.slug, r])) as Record<string, AgentRoleMeta>;

/** Keeps a custom employee name tied to its fixed specialist role in identity labels. */
export function agentIdentityLabel(displayName: string, role: AgentRoleMeta) {
  const name = displayName.trim() || role.shortName;
  const normalizedName = name.toLowerCase();
  const normalizedRole = role.shortName.toLowerCase();
  const normalizedFullRole = role.name.toLowerCase();

  if (
    normalizedName === normalizedRole ||
    normalizedName === normalizedFullRole ||
    normalizedName.endsWith(` · ${normalizedRole}`) ||
    normalizedName.endsWith(` · ${normalizedFullRole}`)
  ) {
    return name;
  }

  return `${name} · ${role.shortName}`;
}

export function isAgentRoleKey(value: string): value is AgentRoleKey {
  return (AGENT_ROLE_KEYS as readonly string[]).includes(value);
}

export type AgentStatus = "setup_required" | "provisioning" | "online" | "busy" | "offline" | "error" | "disabled";

/**
 * The one place the "not working yet" status is worded. "Setup required" is what the product has always said; "Pending setup" was offered as the alternative and is the
 * founder's choice: change this line and nothing else (tests/onboarding-status-wording.test.ts fails for a copy of the words anywhere else in src).
 */
export const SETUP_REQUIRED_LABEL = "Setup required";

/** Why an employee that is switched on is not working yet, in the words a client reads after the label. */
export const SETUP_REASON_TEXT = {
  setup_payment: "waiting for setup payment",
  profile_not_connected: "Hermes profile not connected",
} as const;
export type SetupReason = keyof typeof SETUP_REASON_TEXT;

/**
 * The reason behind "Setup required". An employee that is switched on and has no connected profile waits for the setup payment when the payment is known to be unconfirmed, and
 * otherwise for its Hermes profile. Any other status says nothing here: an employee that is online keeps working when a payment is refunded afterwards (a refund stops new
 * provisioning, it never pauses a running AI team), and one that is paused or being set up has its own wording. `paymentCleared` undefined means "not asked".
 */
export function setupRequiredReason(input: { status: AgentStatus; enabled: boolean; paymentCleared?: boolean | null }): SetupReason | null {
  if (!input.enabled || input.status !== "setup_required") return null;
  return input.paymentCleared === false ? "setup_payment" : "profile_not_connected";
}

/** "Setup required: waiting for setup payment", or null when the status is not "Setup required". */
export function setupRequiredLine(input: { status: AgentStatus; enabled: boolean; paymentCleared?: boolean | null }): string | null {
  const reason = setupRequiredReason(input);
  return reason ? `${SETUP_REQUIRED_LABEL}: ${SETUP_REASON_TEXT[reason]}` : null;
}

export const AGENT_STATUS_LABEL: Record<AgentStatus, string> = {
  setup_required: SETUP_REQUIRED_LABEL,
  provisioning: "Being set up",
  online: "Online",
  busy: "Busy",
  offline: "Offline",
  error: "Needs attention",
  disabled: "Not in plan",
};

export function canChat(status: AgentStatus) {
  return status === "online" || status === "busy";
}
