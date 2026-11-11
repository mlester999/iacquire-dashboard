import type { WorkforceRoleKey } from "@/lib/agents";

export type WorkforceChatCrmIntent =
  | { kind: "none" }
  | { kind: "clarification"; message: string }
  | { kind: "create_contact"; displayName: string; email: string | null; phone: string | null }
  | { kind: "create_opportunity"; name: string; contactName: string; value: number | null };

const NONE: WorkforceChatCrmIntent = { kind: "none" };
const PRONOUN_NAME = /^(?:this|that|the|a|an)\s+(?:contact|customer|client|prospect|lead)$/i;
const OPPORTUNITY_CREATE = /^(?:please\s+)?(?:create|add)\s+(?:(?:an?|new|crm)\s+)*(?:opportunity|deal)\b/i;
const OPPORTUNITY_HELP = "I can create one opportunity for a contact already in your CRM. Say “Create an opportunity called Roof Replacement for Jamie Lee”; include a value only when it is confirmed. No record was changed.";

function parseOpportunity(text: string): WorkforceChatCrmIntent {
  const prefix = text.match(OPPORTUNITY_CREATE);
  if (!prefix) return NONE;
  let details = text.slice(prefix[0].length).trim().replace(/[.!?]+$/, "").trim();

  let value: number | null = null;
  const valueMatch = details.match(/\s+(?:worth\s+|valued\s+at\s+|with\s+(?:a\s+)?value\s+(?:of\s+)?|value\s*:?\s*)(?:USD\s*)?\$?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)\s*$/i);
  if (valueMatch) {
    value = Number(valueMatch[1].replaceAll(",", ""));
    details = details.slice(0, valueMatch.index).trim();
    if (!Number.isFinite(value) || value < 0 || value >= 1e12) return { kind: "clarification", message: OPPORTUNITY_HELP };
  } else if (/\b(?:worth|valued\s+at|with\s+(?:a\s+)?value|value\s*:?)\b/i.test(details)) {
    return { kind: "clarification", message: OPPORTUNITY_HELP };
  }

  const match = details.match(/^(?:called|named)\s+(.+?)\s+for\s+(?:the\s+)?(?:existing\s+)?(?:crm\s+)?contact\s+(.+)$/i)
    ?? details.match(/^(?:called|named)\s+(.+?)\s+for\s+(.+)$/i);
  if (!match) return { kind: "clarification", message: OPPORTUNITY_HELP };

  const clean = (part: string) => part.trim().replace(/^["“'`]+|["”'`]+$/g, "").trim();
  const name = clean(match[1]);
  const contactName = clean(match[2]);
  if (!name || name.length > 200 || !contactName || contactName.length > 80) {
    return { kind: "clarification", message: OPPORTUNITY_HELP };
  }
  return { kind: "create_opportunity", name, contactName, value };
}

/** Recognizes deliberately narrow, explicit CRM contact and opportunity requests from the unified Growth Partner. */
export function parseWorkforceChatCrmIntent(role: WorkforceRoleKey, content: string): WorkforceChatCrmIntent {
  if (role !== "growth_partner") return NONE;
  const text = content.replace(/\s+/g, " ").trim();
  if (!/^(?:please\s+)?(?:add|create|save)\b/i.test(text)) return NONE;
  if (OPPORTUNITY_CREATE.test(text)) return parseOpportunity(text);

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
