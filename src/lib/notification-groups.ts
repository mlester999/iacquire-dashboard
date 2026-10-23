import type { ProactivePrefs } from "@/lib/proactive";

// The groups a person can switch off in the notification bell, shared by the settings screen and the server that filters the list.
// Critical alerts ignore these switches. Email is controlled separately (see src/lib/ops.ts).
export const NOTIFICATION_GROUPS = [
  { key: "setup", label: "Setup progress", description: "Setup milestones, requests from your team, and final readiness updates.", kinds: ["setup_milestone", "setup_action_required", "setup_issue", "setup_ready"] },
  { key: "approvals", label: "Approvals", description: "When an AI employee needs your decision, and when decisions are made.", kinds: ["approval_requested", "approval_decided"] },
  { key: "leads", label: "New leads", description: "Research results waiting for review.", kinds: ["lead_awaiting_approval"] },
  { key: "workforce", label: "AI workforce status", description: "Employees coming online or becoming unavailable.", kinds: ["agent_status", "agent_task_completed"] },
  { key: "support", label: "Support replies", description: "Replies and status changes from the iAcquire team.", kinds: ["support_reply", "support_status"] },
  { key: "knowledge", label: "Knowledge updates", description: "Reviews of held knowledge or configuration changes.", kinds: ["knowledge_update_ready"] },
  { key: "usage", label: "Usage alerts", description: "When you approach your workspace limits.", kinds: ["usage_limit_approaching"] },
  { key: "calendar", label: "Bookings", description: "New and confirmed bookings, and problems syncing a connected calendar.", kinds: ["booking_confirmed", "crm_booking_new", "crm_calendar_sync"] },
  { key: "projects", label: "Custom projects & maintenance", description: "Progress updates, messages and maintenance updates. Quotes and your decisions always notify you.", kinds: ["project_update", "project_message", "maintenance_update"] },
  { key: "billing", label: "Billing and credits", description: "Payments received, low balances and spending-limit warnings.", kinds: ["billing_payment_received", "billing_budget_warning", "billing_low_balance"] },
  { key: "messaging", label: "Customer messaging", description: "FYI notices about conversations handled by your team, conversations assigned to you, new enquiries nobody has picked up, and messages that were held back.", kinds: ["escalation_fyi", "message_blocked", "conversation_assigned", "conversation_new_inquiry", "conversation_awaiting_reply", "missed_call_follow_up", "web_chat_lead"] },
  { key: "crm", label: "CRM", description: "Records assigned to you, tasks coming due, and finished imports.", kinds: ["crm_assigned", "crm_task_due", "crm_import_finished", "hot_lead_detected"] },
  { key: "social", label: "Social media", description: "Posts waiting for your approval, posts that failed to publish, and accounts that need reconnecting.", kinds: ["social_approval_requested", "social_approval_decided", "social_post_failed", "social_account_attention"] },
  { key: "reputation", label: "Reviews and feedback", description: "Low private feedback that has waited too long, and replies to public reviews that need you.", kinds: ["feedback_follow_up_overdue", "review_needs_reply", "review_reply_requested", "review_reply_decided", "review_reply_failed", "review_connection_attention"] },
  { key: "proposals", label: "Proposals", description: "Proposals waiting for your approval, and when a customer opens, accepts, declines or asks for changes to a proposal, or a signing request finishes or fails.", kinds: ["proposal_approval_requested", "proposal_approval_decided", "proposal_viewed", "proposal_accepted", "proposal_declined", "proposal_changes_requested", "proposal_expiring", "signature_completed", "signature_failed"] },
  { key: "invoices", label: "Customer invoices and payments", description: "Invoices waiting for your approval, invoices that are paid, overdue or refunded, payments that need a look, and a payment account that needs attention.", kinds: ["invoice_approval_requested", "invoice_approval_decided", "invoice_paid", "invoice_payment_failed", "invoice_overdue", "invoice_refund_recorded", "payment_connection_attention", "payment_review_needed"] },
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
  /** Proactive AI employee reports: severity threshold, quiet hours, digests and the opt-in safe action. */
  proactive: ProactivePrefs;
}
