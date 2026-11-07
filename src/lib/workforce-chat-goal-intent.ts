import { AI_GROWTH_PARTNER_ROLE_KEY, type WorkforceRoleKey } from "@/lib/agents";
import type { GrowthPartnerGoalCadence, GrowthPartnerGoalMetric } from "@/lib/ai-growth-partner-goals";

export type WorkforceChatGoalIntent =
  | { kind: "none" }
  | { kind: "clarification"; message: string }
  | { kind: "set"; metric: GrowthPartnerGoalMetric; cadence: GrowthPartnerGoalCadence; targetValue: number };

const NOOP: WorkforceChatGoalIntent = { kind: "none" };
const CLARIFICATION = "To save a Growth Partner goal, specify one target and period. For example: “Set a goal of 20 qualified leads per week.” Qualified leads count lead records approved by a person; new leads count lead records created. Supported targets are qualified leads, new leads, appointments, and won deals, per week or month. No goal was changed.";

function targetMetric(text: string): GrowthPartnerGoalMetric | null {
  const qualifiedLead = /\b(?:qualified|approved)\s+leads?\b|\bleads?\s+(?:qualified|approved)\b/i.test(text);
  const newLead = /\b(?:new\s+)?leads?\b|\bprospects?\b|\blead\s+creation\b/i.test(text) && !qualifiedLead;
  const appointments = /\b(?:booked\s+)?(?:appointments?|consultations?|bookings?)\b/i.test(text);
  const deals = /\b(?:won\s+deals?|deals?\s+won|closed\s+deals?)\b/i.test(text);
  const matches = [
    qualifiedLead ? "leads_approved" : null,
    newLead ? "leads_created" : null,
    appointments ? "appointments_booked" : null,
    deals ? "deals_won" : null,
  ].filter((metric): metric is GrowthPartnerGoalMetric => metric !== null);
  return matches.length === 1 ? matches[0] : null;
}

function targetCadence(text: string): GrowthPartnerGoalCadence | null {
  const weekly = /\bweekly\b|\b(?:per|each|every|a)\s+week\b/i.test(text);
  const monthly = /\bmonthly\b|\b(?:per|each|every|a)\s+month\b/i.test(text);
  if (weekly === monthly) return null;
  return weekly ? "weekly" : "monthly";
}

/** Recognizes only explicit, bounded requests to change a Growth Partner goal. */
export function parseWorkforceChatGoalIntent(role: WorkforceRoleKey, content: string): WorkforceChatGoalIntent {
  if (role !== AI_GROWTH_PARTNER_ROLE_KEY) return NOOP;
  const text = content.replace(/\s+/g, " ").trim().slice(0, 2000);
  const changeRequest = /\b(?:set|change|update|adjust|raise|lower|aim\s+for)\b/i.test(text);
  const goalRequest = /\b(?:goal|target|aim)\b/i.test(text);
  if (!changeRequest || !goalRequest) return NOOP;

  const values = [...text.matchAll(/\b\d+\b/g)].map((match) => Number(match[0]));
  const metric = targetMetric(text);
  const cadence = targetCadence(text);
  if (values.length !== 1 || !Number.isSafeInteger(values[0]) || values[0] < 1 || values[0] > 100_000 || !metric || !cadence) {
    return { kind: "clarification", message: CLARIFICATION };
  }

  // A single-goal command cannot also contain another requested change.
  if (/\b(?:and|then|also)\b/i.test(text)) return { kind: "clarification", message: CLARIFICATION };
  return { kind: "set", metric, cadence, targetValue: values[0] };
}
