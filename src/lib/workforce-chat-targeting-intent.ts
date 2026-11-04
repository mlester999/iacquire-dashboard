import type { WorkforceRoleKey } from "@/lib/agents";

export type WorkforceChatTargetingIntent =
  | { kind: "none" }
  | { kind: "clarification"; message: string }
  | { kind: "update"; industry: string; region: string };

const NOOP: WorkforceChatTargetingIntent = { kind: "none" };
const REQUEST = /\b(?:targeting|target industries|target locations|only look for|only search for|search only for)\b/i;

function clean(value: string): string {
  return value.trim().replace(/^['"“”‘’]+|['"“”‘’]+$/g, "").replace(/[.!?,;:]+$/g, "").trim();
}

/** Recognize only explicit, bounded edits to the saved industry and region targeting fields. */
export function parseWorkforceChatTargetingIntent(role: WorkforceRoleKey, content: string): WorkforceChatTargetingIntent {
  if (role !== "growth_partner" && role !== "lead_hunter") return NOOP;
  const text = content.replace(/\s+/g, " ").trim().slice(0, 2000);
  if (!REQUEST.test(text)) return NOOP;

  const patterns = [
    /^(?:please\s+)?only\s+(?:look\s+for|search\s+for|target)\s+(.+?)\s+in\s+(.+?)[.!?]*$/i,
    /^(?:please\s+)?(?:change|update|set)\s+(?:our|my|the)\s+target(?:ing)?(?:\s+rules)?\s+(?:to|for)\s+(.+?)\s+in\s+(.+?)[.!?]*$/i,
    /^(?:please\s+)?set\s+(?:our|my|the)\s+target\s+industries\s+to\s+(.+?)\s+in\s+(.+?)[.!?]*$/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const industry = clean(match[1]).slice(0, 120);
    const region = clean(match[2]).slice(0, 120);
    if (industry.length < 2 || region.length < 2) break;
    return { kind: "update", industry, region };
  }

  return {
    kind: "clarification",
    message: "I can update the saved lead targeting rules. Tell me one industry and one location, for example: “Only look for dental clinics in Florida.” No settings were changed.",
  };
}
