/** Plain-language names for the reviewed tools an AI employee can be given. */
export const AGENT_TOOL_COPY: Record<string, string> = {
  "tasks.read": "Read workspace tasks",
  "approvals.create": "Request approvals from you",
  "summaries.write": "Write summaries",
  "research.public_web": "Research approved public sources",
  "leads.stage_for_review": "Add leads to your review queue",
  "calendar.read_availability": "Read calendar availability",
  "appointments.read": "Look up appointments",
  "appointments.request_change": "Request bookings and changes (needs approval)",
  "crm.read_opportunities": "Read CRM opportunities",
  "drafts.create": "Draft messages (never sends them)",
  "crm.read": "Read CRM records",
  "crm.request_update": "Propose CRM updates (needs approval)",
  "analytics.read": "Read workspace analytics",
};

export function agentToolLabel(tool: string): string {
  return AGENT_TOOL_COPY[tool] ?? tool.replaceAll("_", " ").replaceAll(".", " · ");
}
