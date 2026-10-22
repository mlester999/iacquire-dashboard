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
 * Route only clear requests for the existing read-only native employee workflows.
 * This is intentionally a narrow command recognizer: it cannot authorize writes, approvals,
 * bookings, CRM imports, outreach or recurring work. Lead research has its own stricter parser.
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

  if (role === "lead_hunter" && reviewAction && /\b(?:lead generation|research pipeline|lead pipeline|researched leads)\b/.test(text)) {
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
      acknowledgement: "I’ll check the workspace’s real bookable calendar slots and record the result. This check does not hold a slot, create or change a booking, or contact anyone.",
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
