import { AGENT_BY_KEY, AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { parseWorkforceChatAssignment, type WorkforceChatAssignment } from "@/lib/workforce-chat-assignment";
import { capabilityDefinition } from "@/lib/workforce-capabilities";
import { parseWorkforceChatScheduleIntent } from "@/lib/workforce-chat-schedule-intent";

/** Whether a chat message asks to create or change an automation rather than perform employee work. */
export function isAutomationBuilderRequest(content: string): boolean {
  const text = content.replace(/\s+/g, " ").trim();
  if (!text || text.length > 8000) return false;
  const mentionsAutomation = /\b(?:automations?|workflows?)\b/i.test(text);
  const requestsChange = /\b(?:create|build|make|set up|design|edit|modify|change|test|publish|activate|automate)\b/i.test(text)
    || /\b(?:i|we)\s+(?:want|need)\b.{0,60}\b(?:automation|workflow)\b/i.test(text);
  return mentionsAutomation && requestsChange;
}

export interface NamedWorkforceHandoff {
  targetRole: AgentRoleKey;
  assignment: WorkforceChatAssignment;
}

/** Recognize a different employee explicitly addressed at the start of a chat request. */
export function explicitlyAddressedWorkforceRole(sourceRole: AgentRoleKey, content: string): AgentRoleKey | null {
  const normalized = content.toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  const addressedRoles = AGENT_ROLE_KEYS.filter((role) => {
    if (role === sourceRole) return false;
    const name = AGENT_BY_KEY[role].shortName.toLocaleLowerCase("en-US");
    return [
      `${name} `,
      `ai ${name} `,
      `hey ${name} `,
      `please ${name} `,
      `ask ${name} `,
      `ask the ${name} `,
      `please ask ${name} `,
      `please ask the ${name} `,
      `can ${name} `,
      `could ${name} `,
      `could you ask ${name} `,
      `could you ask the ${name} `,
      `would you ask ${name} `,
      `would you ask the ${name} `,
      `have ${name} `,
      `please have ${name} `,
    ].some((prefix) => normalized.startsWith(prefix));
  });
  if (addressedRoles.length !== 1) return null;
  const normalizedWithSpaces = ` ${normalized} `;
  const namedRoles = AGENT_ROLE_KEYS.filter((role) => normalizedWithSpaces.includes(` ${AGENT_BY_KEY[role].shortName.toLocaleLowerCase("en-US")} `));
  return namedRoles.length === 1 && namedRoles[0] === addressedRoles[0] ? addressedRoles[0] : null;
}

/**
 * Recognize an explicitly named, supported handoff. The target employee's existing assignment
 * parser determines the capability and payload; this function cannot invent or broaden either.
 */
export function parseNamedWorkforceHandoff(sourceRole: AgentRoleKey, content: string): NamedWorkforceHandoff | null {
  const targetRole = explicitlyAddressedWorkforceRole(sourceRole, content);
  if (!targetRole) return null;
  // A different employee's recurring assignment needs its own schedule preview and confirmation.
  // Never turn a recurrence request into a one-off job through this route.
  if (parseWorkforceChatScheduleIntent(targetRole, content).kind !== "none"
    || /\b(?:every|each|every other)\s+(?:weekday|weekend|day|week|month|morning|afternoon|evening|night|hour|year|quarter|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\b(?:daily|weekdays|weekends|weekly|monthly|yearly|recurring|cron|twice a week|once a (?:day|week|month))\b/i.test(content)) return null;
  const assignment = parseWorkforceChatAssignment(targetRole, content);
  if (!assignment) return null;
  const definition = capabilityDefinition(assignment.capability);
  if (!definition || !definition.allowedRoles.includes(targetRole)) return null;
  if (definition.risk !== "read_only" && definition.key !== "pipeline_followup_drafts") return null;
  return { targetRole, assignment };
}
