import { AI_GROWTH_PARTNER_ROLE_KEY, type WorkforceRoleKey } from "@/lib/agents";
import type { BusinessBrain } from "@/lib/ai-growth-partner";

type BusinessBrainSection = keyof BusinessBrain["sections"];

export type WorkforceChatBusinessBrainIntent =
  | { kind: "none" }
  | { kind: "clarification"; message: string }
  | { kind: "draft"; section: BusinessBrainSection; key: string; label: string; valueText: string };

const NOOP: WorkforceChatBusinessBrainIntent = { kind: "none" };
const CLARIFICATION = "To change the Business Brain from chat, send one explicit update such as “Update Business Brain service areas to Orlando and Kissimmee.” Supported fields are business name, industry, business background, services, ideal customers, customer policies, and company operating rules. The change will be saved as a draft for owner review; it will not become active until you approve it in Partner Controls.";

const FIELDS: Record<string, { section: BusinessBrainSection; key: string; label: string }> = {
  "business name": { section: "businessIdentity", key: "companyName", label: "business name" },
  "company name": { section: "businessIdentity", key: "companyName", label: "business name" },
  industry: { section: "businessIdentity", key: "industry", label: "industry" },
  "business background": { section: "businessIdentity", key: "background", label: "business background" },
  services: { section: "productsServicesOffers", key: "services", label: "services" },
  "ideal customer": { section: "idealCustomers", key: "targetTypes", label: "ideal customers" },
  "ideal customers": { section: "idealCustomers", key: "targetTypes", label: "ideal customers" },
  "target customers": { section: "idealCustomers", key: "targetTypes", label: "ideal customers" },
  "service area": { section: "businessIdentity", key: "serviceAreas", label: "service areas" },
  "service areas": { section: "businessIdentity", key: "serviceAreas", label: "service areas" },
  "customer policies": { section: "policies", key: "customerPolicies", label: "customer policies" },
  "company operating rules": { section: "employeeBehavior", key: "companyOperatingRules", label: "company operating rules" },
};

function normalizeField(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replace(/[’']/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

/** Parses only one explicit Business Brain edit; saves remain drafts until an owner activates them. */
export function parseWorkforceChatBusinessBrainIntent(role: WorkforceRoleKey, content: string): WorkforceChatBusinessBrainIntent {
  if (role !== AI_GROWTH_PARTNER_ROLE_KEY) return NOOP;
  const text = content.trim();
  if (!/\b(?:set|change|update|edit)\b[\s\S]*\bbusiness\s+brain\b/i.test(text)) return NOOP;
  if (text.length > 5000) return { kind: "clarification", message: CLARIFICATION };

  const command = text.match(/^(?:please\s+)?(?:set|change|update|edit)\s+(?:(?:our|the)\s+)?business\s+brain(?:['’]s)?\s*:?\s*([\s\S]+)$/i);
  if (!command || /(?:\b(?:and\s+then|also)\s+)(?:set|change|update|edit)\s+(?:(?:our|the)\s+)?business\s+brain\b/i.test(command[1])) {
    return { kind: "clarification", message: CLARIFICATION };
  }

  const assignment = command[1].match(/^(.+?)\s*(?:=|\bto\b|\bas\b)\s*([\s\S]+)$/i);
  if (!assignment) return { kind: "clarification", message: CLARIFICATION };
  const field = FIELDS[normalizeField(assignment[1])];
  const valueText = assignment[2].trim().replace(/[.!?]+$/, "").trim();
  if (!field || !valueText || valueText.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(valueText)) {
    return { kind: "clarification", message: CLARIFICATION };
  }

  return { kind: "draft", ...field, valueText };
}
