import type { AgentRoleKey } from "@/lib/agents";

export type WorkforceChatRefusalReason =
  | "out_of_role_research"
  | "external_outreach"
  | "crm_write"
  | "appointment_write"
  | "approval_bypass"
  | "unsupported_internal_write";

export interface WorkforceChatRefusal {
  reason: WorkforceChatRefusalReason;
  message: string;
}

const normalize = (value: string) => value
  .toLocaleLowerCase("en-US")
  .replace(/[^\p{L}\p{N}]+/gu, " ")
  .replace(/\s+/g, " ")
  .trim();

const follows = (text: string, action: RegExp, object: RegExp) => action.test(text) && object.test(text);

/**
 * Stop clear requests for effects that have no employee-scoped application executor. Hermes's
 * public research tools are shared across profiles, so role instructions alone cannot enforce
 * that a non-Lead-Hunter never performs prospect research. This guard runs before any Hermes
 * submission; authorized read-only jobs are handled separately by the capability allowlist.
 */
export function workforceChatRefusal(role: AgentRoleKey, content: string, employeeName?: string): WorkforceChatRefusal | null {
  const text = normalize(content);
  if (!text) return null;

  const bookingReadRequest = role === "appointment_setter"
    && /\b(?:check|find|show|list|review)\b.{0,60}\b(?:calendar|availability|available slots|appointment slots)\b/.test(text);

  if (role !== "lead_hunter" && follows(
    text,
    /\b(?:research|find|source|prospect|discover|identify|generate|compile|search for|look up)\b/,
    /\b(?:leads?|prospects?|businesses|companies|agencies|brokerages|decision makers)\b/,
  )) {
    return {
      reason: "out_of_role_research",
      message: "Prospect research is reserved for Lead Hunter. I did not search public sources, inspect websites or create leads.",
    };
  }

  const outreachTarget = /\b(?:outreach|campaign|prospects?|leads?|customers?|clients?|contacts?|businesses|companies|agencies|brokerages)\b/;
  if (
    follows(text, /\b(?:send|deliver|email|text|call|message|launch|start)\b/, outreachTarget)
    || /\b(?:contact|reach out(?: to)?|follow up with)\b.{0,60}\b(?:prospects?|leads?|customers?|clients?|businesses|companies|agencies|brokerages)\b/.test(text)
  ) {
    return {
      reason: "external_outreach",
      message: "This chat has no approved outbound communication action. No message or campaign was sent or scheduled.",
    };
  }

  if (follows(
    text,
    /\b(?:merge|delete|remove|import|export|overwrite|bulk edit|bulk update|bulk delete|bulk merge)\b/,
    /\b(?:crm|contacts?|company|companies|leads?|records?|opportunities|deals|pipeline)\b/,
  )) {
    return {
      reason: "crm_write",
      message: "This employee chat does not have an approved CRM write action. No record was created, imported, edited, merged or deleted.",
    };
  }

  if (!bookingReadRequest && follows(
    text,
    /\b(?:book|schedule|confirm|reschedule|cancel|move)\b/,
    /\b(?:appointment|meeting|calendar|booking|slot)\b/,
  )) {
    return {
      reason: "appointment_write",
      message: "This chat can check real calendar availability, but it cannot create, confirm, cancel or reschedule a booking. No calendar record was changed.",
    };
  }

  if (/\b(?:bypass|skip|ignore|override)\b.{0,40}\b(?:approval|human review|permission)\b/.test(text)) {
    return {
      reason: "approval_bypass",
      message: "I can’t bypass an approval or permission check. No action was taken.",
    };
  }

  if (role === "operations_manager" && follows(
    text,
    /\b(?:create|assign|reassign|close|complete|delete|change)\b/,
    /\b(?:task|employee|work item|job)\b/,
  )) {
    return {
      reason: "unsupported_internal_write",
      // The employee's own display name for this company, or its role label: a name belongs to one company and is never a default.
      message: `${employeeName?.trim() || "The Operations Manager"} can review and recommend operational work, but this chat has no approved task-assignment action. No task or assignment was changed.`,
    };
  }

  return null;
}
