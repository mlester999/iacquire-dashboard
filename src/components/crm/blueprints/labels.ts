// Plain-language labels the Blueprint onboarding and setup screens share. Pure (usable from server and client components).
import { REQUIREMENT_INFO, type RequirementKey } from "@/lib/crm/blueprints/types";
import type { ModuleView } from "@/lib/crm/blueprints/views";

/** Wording for what arrives as a draft, only for the modules the Blueprint has. */
export function draftNotes(modules: ModuleView[]): Array<{ key: string; icon: "calendar" | "workflow" | "draft"; text: string }> {
  const has = (s: ModuleView["section"]) => modules.some((m) => m.section === s && m.count > 0);
  const out: Array<{ key: string; icon: "calendar" | "workflow" | "draft"; text: string }> = [];
  if (has("calendars")) out.push({ key: "calendars", icon: "calendar", text: "Calendars arrive as drafts. They take no bookings until hosts, hours and time zone are checked and someone activates them." });
  if (has("workflows")) out.push({ key: "workflows", icon: "workflow", text: "Workflows arrive as drafts and never run on their own." });
  if (has("forms") || has("messageTemplates")) out.push({ key: "drafts", icon: "draft", text: "Forms and message templates arrive as drafts: forms take no submissions until published, and wording is approved before anything automated uses it." });
  // A new client has nobody mapped yet, so a rule that hands leads to people arrives off; one that only keeps existing owners needs nobody.
  if (has("assignmentRules")) out.push({ key: "rules", icon: "draft", text: "Lead assignment rules that hand leads to people stay switched off until those people are added. A rule that only keeps the existing owner, with no fallback person, needs nobody and works straight away." });
  return out;
}

export function requirementLabels(keys: readonly RequirementKey[]): string[] {
  return keys.map((k) => REQUIREMENT_INFO[k]?.label ?? k);
}
