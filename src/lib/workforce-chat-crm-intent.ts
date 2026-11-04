import type { WorkforceRoleKey } from "@/lib/agents";

export type WorkforceChatCrmIntent =
  | { kind: "none" }
  | { kind: "clarification"; message: string }
  | { kind: "create_contact"; displayName: string; email: string | null; phone: string | null };

const NONE: WorkforceChatCrmIntent = { kind: "none" };
const PRONOUN_NAME = /^(?:this|that|the|a|an)\s+(?:contact|customer|client|prospect|lead)$/i;

/** Recognizes a deliberately narrow, explicit request to add one identified person to the CRM. */
export function parseWorkforceChatCrmIntent(role: WorkforceRoleKey, content: string): WorkforceChatCrmIntent {
  if (role !== "growth_partner") return NONE;
  const text = content.replace(/\s+/g, " ").trim();
  if (!/^(?:please\s+)?(?:add|create|save)\b/i.test(text)) return NONE;

  const explicitCrm = /\b(?:to|in)\s+(?:(?:our|the)\s+)?crm\b/i.test(text);
  const email = text.match(/\bemail(?:\s+address)?\s*(?:is\s+|:\s*)?([a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,})\b/i)?.[1] ?? null;
  const phoneMatch = text.match(/\bphone(?:\s+number)?\s*(?:is\s+|:\s*)?([+()\d][+\d()\s.-]{5,})/i)?.[1] ?? null;
  const phone = phoneMatch?.split(/\s+(?:and|with)\s+(?:email|phone)\b|[,;]|\s+to\s+(?:our\s+|the\s+)?crm\b/i)[0]?.replace(/[.\s]+$/, "") ?? null;
  const explicitObject = /\b(?:contact|prospect|lead|customer|client)\b/i.test(text) || (explicitCrm && Boolean(email || phone));
  const explicitCreate = /^(?:please\s+)?(?:create|add)\s+(?:a\s+)?(?:new\s+)?(?:crm\s+)?(?:contact|prospect|lead|customer|client)\b/i.test(text);
  if (!explicitObject || (!explicitCrm && !explicitCreate)) return NONE;

  const labeledName = text.match(/\b(?:full\s+name|name)\s*(?:is\s+|:\s*)["“]?([^,;.!?]+?)["”]?(?=\s+(?:with\s+)?(?:email|phone)\b|$)/i)?.[1]?.trim();
  let candidate = (labeledName ?? text)
    .replace(/^(?:please\s+)?(?:add|create|save)\s+/i, "")
    .replace(/^(?:a\s+|an\s+)?(?:new\s+)?(?:crm\s+)?(?:contact|prospect|lead|customer|client)\s+(?:(?:named|called|for)\s+)?/i, "")
    .replace(/^(?:this|that|the)\s+(?:contact|prospect|lead|customer|client)\s+/i, "")
    .replace(/\b(?:to|in)\s+(?:(?:our|the)\s+)?crm\b.*$/i, "")
    .replace(/\s+(?:with\s+)?(?:email|phone)(?:\s+address|\s+number)?\b.*$/i, "")
    .replace(/[“”"'`]/g, "")
    .replace(/[.!?]+$/, "")
    .trim();
  // "Add this prospect to CRM" names no person; never infer an identity from older chat text.
  if (PRONOUN_NAME.test(candidate)) candidate = "";

  if (!candidate || candidate.length > 80 || (!email && !phone)) {
    return {
      kind: "clarification",
      message: "I can add one person to the CRM. Please include their full name and an email address or phone number so I can check for duplicates first.",
    };
  }
  return { kind: "create_contact", displayName: candidate, email, phone };
}
