// The groups a person can switch off in the notification bell, shared by the settings screen and the server that filters the list.
// Critical alerts ignore these switches. Email is controlled separately (see src/lib/ops.ts).
export const NOTIFICATION_GROUPS = [
  { key: "setup", label: "Setup progress", description: "Setup milestones, requests from your team, and final readiness updates.", kinds: ["setup_milestone", "setup_action_required", "setup_issue", "setup_ready"] },
  { key: "approvals", label: "Approvals", description: "When an AI employee needs your decision, and when decisions are made.", kinds: ["approval_requested", "approval_decided"] },
  { key: "leads", label: "New leads", description: "Research results waiting for review.", kinds: ["lead_awaiting_approval"] },
  { key: "workforce", label: "AI workforce status", description: "Employees coming online or becoming unavailable.", kinds: ["agent_status", "agent_task_completed"] },
  { key: "support", label: "Support replies", description: "Replies and status changes from the iAcquire team.", kinds: ["support_reply"] },
  { key: "knowledge", label: "Knowledge updates", description: "Reviews of held knowledge or configuration changes.", kinds: ["knowledge_update_ready"] },
  { key: "usage", label: "Usage alerts", description: "When you approach your workspace limits.", kinds: ["usage_limit_approaching"] },
  { key: "calendar", label: "Bookings", description: "Confirmed bookings from your calendar.", kinds: ["booking_confirmed"] },
  { key: "projects", label: "Custom projects & maintenance", description: "Progress updates, messages and maintenance updates. Quotes and your decisions always notify you.", kinds: ["project_update", "project_message", "maintenance_update"] },
  { key: "billing", label: "Billing and credits", description: "Payments received, low balances and spending-limit warnings.", kinds: ["billing_payment_received", "billing_budget_warning", "billing_low_balance"] },
  { key: "messaging", label: "Customer messaging", description: "FYI notices about conversations handled by your team, and messages that were held back.", kinds: ["escalation_fyi", "message_blocked"] },
  { key: "crm", label: "CRM", description: "Records assigned to you, tasks coming due, and finished imports.", kinds: ["crm_assigned", "crm_task_due", "crm_import_finished"] },
  { key: "websites", label: "Website", description: "When your website is published or a domain is verified.", kinds: ["website_published", "domain_verified"] },
] as const;

export type NotificationGroupKey = (typeof NOTIFICATION_GROUPS)[number]["key"];

export interface NotificationPrefsView {
  /** One switch per group for the notification bell. */
  groups: Record<string, boolean>;
  /** Setup progress emails are an explicit opt-in. */
  setupEmails: boolean;
  /** Which other notifications are also emailed. Critical alerts are always emailed. */
  email: "important" | "all" | "off";
}
