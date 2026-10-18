import type { Permission } from "@/lib/permissions";
import { canOpenAqiRoute, matchAqiRoute, type AqiAccess } from "@/lib/aqi/routes";

/**
 * Suggested questions are published by a Super Admin, but publication alone does not prove that the
 * signed-in person can use the destination. These deterministic capability rules keep a client or a
 * restricted employee from being invited to open an admin page they cannot access. Questions that do
 * not map to a protected capability stay available: they are generic platform questions.
 */
export interface AqiSuggestionRule {
  permission?: Permission;
  agency?: "staff" | "super_admin";
}

const RULES: Array<{ pattern: RegExp; rule: AqiSuggestionRule }> = [
  { pattern: /\bsuper\s+admin\b/i, rule: { agency: "super_admin" } },
  { pattern: /\badmin\b/i, rule: { agency: "staff" } },
  { pattern: /\b(?:ai\s+employees?|employees?|ai\s+workforce|workforce)\b/i, rule: { permission: "agents.use" } },
  { pattern: /\bknowledge(?:\s+center)?\b/i, rule: { permission: "knowledge.view" } },
  { pattern: /\bintegrations?\b/i, rule: { permission: "integrations.view" } },
  { pattern: /\b(?:support|contact\s+the\s+(?:i?acquire\s+)?team|get\s+help\s+from\s+(?:i?acquire)?)\b/i, rule: { permission: "support.use" } },
  { pattern: /\b(?:team|teammate|team\s+member|invite)\b/i, rule: { permission: "team.view" } },
  { pattern: /\b(?:crm|contacts?|companies|company|pipelines?|deals?)\b/i, rule: { permission: "crm.view" } },
  { pattern: /\b(?:billing|invoices?|payments?|plan)\b/i, rule: { permission: "billing.view" } },
  { pattern: /\b(?:setup|onboarding|activate|activation)\b/i, rule: { permission: "setup.view" } },
  { pattern: /\b(?:website|publish(?:ing)?)\b/i, rule: { permission: "website.view" } },
  { pattern: /\b(?:analytics|reports?|reporting)\b/i, rule: { permission: "analytics.view" } },
  { pattern: /\b(?:appointments?|calendar|booking)\b/i, rule: { permission: "appointments.view" } },
  { pattern: /\bleads?\b/i, rule: { permission: "leads.view" } },
  { pattern: /\bsales\b/i, rule: { permission: "sales.view" } },
  { pattern: /\bapprovals?\b/i, rule: { permission: "approvals.view" } },
  { pattern: /\bactivity\b/i, rule: { permission: "activity.view" } },
  { pattern: /\busage\b/i, rule: { permission: "usage.view" } },
  { pattern: /\bprojects?\b/i, rule: { permission: "projects.view" } },
];

export function requiredSuggestionAccess(question: string): AqiSuggestionRule | null {
  for (const entry of RULES) if (entry.pattern.test(question)) return entry.rule;
  return null;
}

export interface AqiSuggestionCandidate {
  question: string;
  scope: string;
  role: string | null;
  route_prefix: string | null;
}

export function canSeeAqiSuggestion(row: AqiSuggestionCandidate, access: AqiAccess): boolean {
  if (row.scope === "page") {
    const route = matchAqiRoute(row.route_prefix);
    if (!route || !canOpenAqiRoute(route, access)) return false;
  }
  const rule = requiredSuggestionAccess(row.question);
  if (!rule) return true;
  if (rule.agency) {
    if (!access.agencyRole) return false;
    if (rule.agency === "super_admin" && access.agencyRole !== "agency_super_admin") return false;
  }
  if (rule.permission && !access.can(rule.permission)) return false;
  return true;
}

/** Removes duplicate questions while preserving Super Admin ordering. */
export function dedupeAqiSuggestions<T extends { question: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = row.question.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
