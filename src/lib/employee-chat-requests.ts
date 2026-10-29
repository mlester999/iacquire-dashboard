import type { AgentRoleKey } from "@/lib/agents";
import type { Permission } from "@/lib/permissions";
import type { CapabilityKey } from "@/lib/workforce-capabilities";

// What a person can actually start from an employee's chat today, and nothing else.
//
// The pinned Hermes runtime gives an employee no way to change anything in iAcquireOS, so an employee never "does" these things. What exists is the chat router: when the person's
// own message matches one of the requests below, iAcquire (not the model) starts the work under the person's permissions and shows the result in the chat. The employee's job is to
// tell the person truthfully which of these they can ask for, in words the router recognises, and to say plainly that everything else is not available from chat.
// tests/employee-chat-quality.test.ts proves every `say` below really reaches the router flow it names, so this list cannot drift into promising something that is not wired.

export interface ChatRequestDef {
  key: string;
  /** Plain words for what the person gets. */
  label: string;
  /** Wording the router recognises (an example the person can copy and adapt). */
  say: string;
  /** What iAcquire does when the person says it. */
  result: string;
  /** The reviewed capability it starts, when it starts one: the person's permissions come from its definition. */
  capability?: CapabilityKey;
  /** The person's permissions, for a request that is not a reviewed capability. */
  permissions?: readonly Permission[];
  /** The employee must still have at least one of these (its Allowed actions) switched on. */
  abilities: readonly string[];
}

const BOOKING_PERMISSIONS = ["agents.use", "contacts.view", "appointments.view", "appointments.book"] as const satisfies readonly Permission[];

export const CHAT_REQUESTS: Record<AgentRoleKey, readonly ChatRequestDef[]> = {
  operations_manager: [
    {
      key: "operations_review",
      label: "An operations review",
      say: "Review our current operations and tell me what needs my attention",
      result: "iAcquire runs a read-only review of operations records and posts the findings on the AI Work Board. It changes and starts nothing.",
      capability: "proactive_review",
      abilities: ["tasks.read"],
    },
  ],
  lead_hunter: [
    {
      key: "lead_review",
      label: "A review of the researched leads",
      say: "Review our researched leads and tell me which need review",
      result: "iAcquire reviews the saved research queue and coverage and posts recommendations on the AI Work Board. It starts no research and contacts no one.",
      capability: "lead_generation_review",
      abilities: ["leads.stage_for_review", "research.public_web"],
    },
    {
      key: "lead_research",
      label: "New lead research",
      say: "Find 10 dental clinics in Austin, Texas",
      result: "iAcquire starts a research job over approved public sources and saves what it finds for a person to review. It needs saved targeting rules, adds nothing to the CRM and contacts no one.",
      permissions: ["agents.use", "leads.research"],
      abilities: ["research.public_web"],
    },
  ],
  appointment_setter: [
    {
      key: "availability_check",
      label: "A calendar availability check",
      say: "Check our calendar availability for the next week",
      result: "iAcquire reads the calendar's real open times for the next seven days. It holds no slot and books nothing.",
      capability: "appointment_availability",
      abilities: ["calendar.read_availability"],
    },
    {
      key: "appointment_review",
      label: "An appointment review",
      say: "Review our appointments and booking requests",
      result: "iAcquire reviews appointment requests and their confirmation status. It books, moves and cancels nothing.",
      capability: "appointment_review",
      abilities: ["appointments.read", "appointments.request_change"],
    },
    {
      key: "booking_preview",
      label: "A booking preview",
      say: "Book an appointment with Jane Doe at 2026-11-02T09:00+08:00",
      result: "iAcquire shows a preview for that exact CRM contact and exact time (with a timezone offset). Nothing is booked until the person confirms in the chat, and an owner or admin approval may still apply.",
      permissions: BOOKING_PERMISSIONS,
      abilities: ["appointments.request_change"],
    },
    {
      key: "appointment_change",
      label: "A cancellation or reschedule preview",
      say: "Reschedule the appointment for Jane Doe from 2026-11-02T09:00+08:00 to 2026-11-03T10:00+08:00",
      result: "iAcquire shows a preview and, after the person confirms in the chat, asks an owner or admin to approve it. Nothing changes until they do.",
      permissions: BOOKING_PERMISSIONS,
      abilities: ["appointments.request_change"],
    },
  ],
  sales_assistant: [
    {
      key: "pipeline_review",
      label: "A sales pipeline review",
      say: "Review our sales pipeline and tell me which deals need follow-up",
      result: "iAcquire reviews saved opportunities and posts follow-up risks and next steps. It changes no deal and sends nothing.",
      capability: "pipeline_review",
      abilities: ["crm.read_opportunities"],
    },
    {
      key: "followup_drafts",
      label: "Unsent follow-up drafts",
      say: "Review our sales pipeline and prepare follow-up drafts for the stale deals",
      result: "iAcquire prepares up to five unsent follow-up drafts in the Inbox, only for open conversations this employee already handles, for a person to review. It sends nothing.",
      capability: "pipeline_followup_drafts",
      abilities: ["crm.read_opportunities"],
    },
  ],
  crm_manager: [
    {
      key: "crm_quality_review",
      label: "A CRM data quality review",
      say: "Check our CRM for incomplete records and possible duplicates",
      result: "iAcquire reviews contacts and companies for missing details and possible duplicates. It edits, merges and deletes nothing.",
      capability: "crm_quality_review",
      abilities: ["crm.read"],
    },
  ],
  performance_analyst: [
    {
      key: "performance_snapshot",
      label: "The performance KPI card",
      say: "Show our performance metrics for the last 30 days",
      result: "iAcquire calculates the saved metrics and shows them as a KPI card with each figure's source. Nothing is estimated. Say \"this month\" for the current calendar month.",
      capability: "performance_snapshot",
      abilities: ["analytics.read"],
    },
  ],
};
