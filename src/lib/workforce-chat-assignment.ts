import type { AgentRoleKey } from "@/lib/agents";
import type { CapabilityKey } from "@/lib/workforce-capabilities";

export interface WorkforceChatAssignment {
  capability: Exclude<CapabilityKey, "lead_research">;
  title: string;
  input: Record<string, unknown>;
  acknowledgement: string;
}

const normalize = (value: string) => value
  .toLocaleLowerCase("en-US")
  .replace(/[^\p{L}\p{N}]+/gu, " ")
  .replace(/\s+/g, " ")
  .trim();

const hasAction = (text: string, words: string) => new RegExp(`\\b(?:${words})\\b`, "i").test(text);

/**
 * Route only clear requests for existing, server-owned employee workflows. This recognizer does
 * not authorize an action by itself: dispatch still checks employee role and caller permissions.
 * Draft-producing work remains unsent and approval-gated; bookings, CRM imports, outreach and
 * recurring work use their separate guarded flows. Lead research has its own stricter parser.
 */
export function parseWorkforceChatAssignment(role: AgentRoleKey, content: string): WorkforceChatAssignment | null {
  const text = normalize(content);
  if (!text) return null;
  const reviewAction = hasAction(text, "review|check|audit|summari[sz]e|analy[sz]e|identify|find|show|list|compare|scan");

  if (role === "operations_manager" && (
    (reviewAction && /\b(?:operations|operational work|workforce|our workload)\b/.test(text))
    || /\bwhat (?:needs|requires) my attention\b/.test(text)
    || /\bwhat should i focus on today\b/.test(text)
  )) {
    return {
      capability: "proactive_review",
      title: "On-demand operations review",
      input: { sinceDays: /\btoday\b/.test(text) ? 1 : 7 },
      acknowledgement: "I’ll review persisted operational records and record evidence-backed priorities. This read-only review will not change tasks, approve requests or start monitoring.",
    };
  }

  if (role === "lead_hunter" && reviewAction && /\b(?:lead generation|lead research|research pipeline|lead pipeline|researched leads|research candidates|candidates (?:need|needing) review)\b/.test(text)) {
    return {
      capability: "lead_generation_review",
      title: "Lead generation review",
      input: {},
      acknowledgement: "I’ll review the saved research queue and coverage, then record evidence-backed recommendations. This review does not start new research or contact anyone.",
    };
  }

  if (role === "appointment_setter" && reviewAction && /\b(?:calendar|availability|available slots|available time|appointment slots)\b/.test(text)) {
    return {
      capability: "appointment_availability",
      title: "Calendar availability check",
      input: {},
      acknowledgement: "I’ll check the workspace’s real bookable calendar slots and record the result. This check does not hold a slot, create or change a booking, or contact anyone. Afterward, you can continue in Appointments to choose a contact and request a time; the calendar is checked again and any required approval still applies.",
    };
  }

  if (role === "appointment_setter" && reviewAction && /\b(?:appointments|booking requests|booking risks)\b/.test(text)) {
    return {
      capability: "appointment_review",
      title: "Appointment review",
      input: {},
      acknowledgement: "I’ll review persisted appointment requests and confirmation status. This read-only review will not book, reschedule, cancel or confirm an appointment.",
    };
  }

  if (role === "sales_assistant" && reviewAction && /\b(?:sales pipeline|pipeline|opportunities|deals|stale deals|follow[\s-]*ups?)\b/.test(text)
    && /\b(?:draft|prepare|write|compose)\b.{0,60}\b(?:follow[\s-]*ups?|messages?|emails?)\b/.test(text)) {
    return {
      capability: "pipeline_followup_drafts",
      title: "Sales pipeline review and follow-up drafts",
      input: { limit: 5 },
      acknowledgement: "I’ll review stale opportunities, prepare up to five follow-up drafts only in open conversations I already handle, and leave every draft unsent for a person to review. I won’t contact anyone or invent prices, promises or deal activity.",
    };
  }

  if (role === "sales_assistant" && reviewAction && /\b(?:sales pipeline|pipeline|opportunities|stale deals|follow ups|followups)\b/.test(text)) {
    return {
      capability: "pipeline_review",
      title: "Sales pipeline review",
      input: {},
      acknowledgement: "I’ll review saved opportunities and record follow-up risks and next-step recommendations. This review does not prepare personalized message drafts, change deals or send outreach.",
    };
  }

  if (role === "crm_manager" && reviewAction && /\b(?:crm|duplicates|incomplete records|data quality|contact records|company records)\b/.test(text)) {
    return {
      capability: "crm_quality_review",
      title: "CRM quality review",
      input: {},
      acknowledgement: "I’ll review tenant-scoped CRM records for missing details and possible duplicates. This read-only review will not edit, merge, delete or import records.",
    };
  }

  if (role === "performance_analyst" && reviewAction && /\b(?:performance|metrics|kpis|results|trends)\b/.test(text)) {
    const currentMonth = /\b(?:this month|month to date)\b/.test(text);
    return {
      capability: "performance_snapshot",
      title: "Performance snapshot",
      input: currentMonth ? { period: "current_month" } : {},
      acknowledgement: `I’ll calculate the saved workspace metrics for ${currentMonth ? "the current calendar month" : "the last 30 days"} and record their sources and limits. No value or benchmark will be estimated.`,
    };
  }

  return null;
}
