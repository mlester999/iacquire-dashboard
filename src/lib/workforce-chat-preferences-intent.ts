import { AI_GROWTH_PARTNER_ROLE_KEY, type WorkforceRoleKey } from "@/lib/agents";
import { LANGUAGES, REPLY_LENGTHS, TONES, type AiPreferences } from "@/lib/agent-settings";

export type WorkforceChatPreferences = Partial<Pick<AiPreferences, "tone" | "replyLength" | "language">>;
export type WorkforceChatPreferencesIntent =
  | { kind: "none" }
  | { kind: "clarification"; message: string }
  | { kind: "update"; preferences: WorkforceChatPreferences };

const normalize = (value: string) => value.trim().toLocaleLowerCase("en").replace(/[’']/g, "'");
const hasSettingEdit = (content: string) => /\b(?:set|change|switch)\b/i.test(content)
  && /\b(?:tone|voice|language|reply|response|default)\b/i.test(content);

function supportedMatches<T extends string>(values: readonly T[], content: string): T[] {
  const normalized = normalize(content);
  const matches = values.filter((value) => normalized.includes(normalize(value)));
  // Prefer a longer label when one supported value contains another (for example, Chinese and Chinese (Simplified)).
  return matches.filter((value) => !matches.some((other) => other !== value && normalize(other).includes(normalize(value))));
}

function clarificationFor(field: "tone" | "replyLength" | "language"): string {
  if (field === "tone") return "Which tone should I save for future replies? Choose friendly, professional, casual, or premium. I haven't changed anything.";
  if (field === "replyLength") return "Which reply length should I save? Choose concise, balanced, or detailed. I haven't changed anything.";
  return `Which language should I save for future replies? Choose ${LANGUAGES.join(", ")}. I haven't changed anything.`;
}

/** Recognizes only explicit, persistent changes to the Growth Partner's three bounded communication preferences. */
export function parseWorkforceChatPreferencesIntent(role: WorkforceRoleKey, content: string): WorkforceChatPreferencesIntent {
  if (role !== AI_GROWTH_PARTNER_ROLE_KEY) return { kind: "none" };
  const text = content.trim();
  const persistent = /\b(?:from now on|going forward|always|as (?:the )?default|by default)\b/i.test(text) || hasSettingEdit(text);
  if (!persistent) return { kind: "none" };

  const toneValues = supportedMatches(TONES, text);
  const replyValues = supportedMatches(REPLY_LENGTHS, text);
  const languageValues = supportedMatches(LANGUAGES, text);
  const toneMentioned = /\b(?:tone|voice)\b/i.test(text) || toneValues.length > 0 && /\b(?:use|be|sound|set|change|switch|always)\b/i.test(text);
  const replyMentioned = /\b(?:reply|response)\s+(?:length|style)\b/i.test(text)
    || /\b(?:reply|response)(?:\s+length)?\s+(?:to|as)\s+\w+\b/i.test(text)
    || replyValues.length > 0 && /\b(?:use|keep|set|change|switch|always|from now on|going forward)\b/i.test(text);
  const languageMentioned = /\b(?:language|respond in|reply in|answer in|write in|speak in)\b/i.test(text)
    || languageValues.length > 0 && /\b(?:use|set|change|switch|always)\b/i.test(text);

  const preferences: WorkforceChatPreferences = {};
  if (toneMentioned) {
    if (toneValues.length !== 1) return { kind: "clarification", message: clarificationFor("tone") };
    preferences.tone = toneValues[0];
  }
  if (replyMentioned) {
    if (replyValues.length !== 1) return { kind: "clarification", message: clarificationFor("replyLength") };
    preferences.replyLength = replyValues[0];
  }
  if (languageMentioned) {
    if (languageValues.length !== 1) return { kind: "clarification", message: clarificationFor("language") };
    preferences.language = languageValues[0];
  }
  return Object.keys(preferences).length ? { kind: "update", preferences } : { kind: "none" };
}
