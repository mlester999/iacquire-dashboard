import { AI_GROWTH_PARTNER_ROLE_KEY } from "@/lib/agents";
import { abilitiesForCapability, requiredAbilitiesForCapability } from "@/lib/employee-tool-policy";
import { WORKFORCE_CAPABILITIES, type CapabilityKey } from "@/lib/workforce-capabilities";
import type { Permission } from "@/lib/permissions";

export const GROWTH_PARTNER_CAPABILITY_GROUPS = [
  { key: "lead_discovery", title: "Lead discovery & qualification", capabilityKeys: ["lead_research", "lead_generation_review"] },
  { key: "sales", title: "Sales & follow-up", capabilityKeys: ["pipeline_review", "pipeline_followup_drafts", "lead_priority_review"] },
  { key: "scheduling", title: "Calendar & appointments", capabilityKeys: ["appointment_review", "appointment_availability", "missed_call_review"] },
  { key: "crm", title: "CRM & pipeline records", capabilityKeys: ["crm_quality_review"] },
  { key: "operations", title: "Business operations", capabilityKeys: ["proactive_review", "receivables_review", "reputation_review"] },
  { key: "analytics", title: "Performance & analytics", capabilityKeys: ["performance_snapshot", "social_performance_review"] },
] as const satisfies readonly { key: string; title: string; capabilityKeys: readonly CapabilityKey[] }[];

export type GrowthPartnerCapabilityDomainKey = (typeof GROWTH_PARTNER_CAPABILITY_GROUPS)[number]["key"];
export type GrowthPartnerCapabilityAccessStatus =
  | "available"
  | "permission_required"
  | "disabled"
  | "actions_unverified"
  | "runtime_unverified"
  | "not_configured";

export interface GrowthPartnerCapabilityAccess {
  key: CapabilityKey;
  label: string;
  status: GrowthPartnerCapabilityAccessStatus;
  detail: string;
}

export function deriveGrowthPartnerCapabilityAccess(input: {
  partnerExists: boolean;
  runtimeAgentId: string | null;
  runtimeReady: boolean;
  can: (permission: Permission) => boolean;
  activeAbilities: ReadonlySet<string> | null;
}): GrowthPartnerCapabilityAccess[] {
  return Object.values(WORKFORCE_CAPABILITIES)
    .filter((capability) => capability.allowedRoles.includes(AI_GROWTH_PARTNER_ROLE_KEY))
    .map((capability) => {
      const permissions = [capability.requiredPermission, ...(capability.additionalPermissions ?? [])];
      const hasMemberAccess = permissions.every(input.can);
      const abilities = abilitiesForCapability(capability.key);
      const requiredAbilities = requiredAbilitiesForCapability(capability.key);
      const hasPartnerAbility = input.activeAbilities !== null
        && abilities.some((ability) => input.activeAbilities?.has(ability))
        && requiredAbilities.every((ability) => input.activeAbilities?.has(ability));

      if (!input.partnerExists) {
        return { key: capability.key, label: capability.label, status: "not_configured", detail: "A Growth Partner identity has not been set up for this workspace." };
      }
      if (!input.runtimeAgentId || !input.runtimeReady) {
        return { key: capability.key, label: capability.label, status: "runtime_unverified", detail: "The Growth Partner runtime has not passed its current ready check." };
      }
      if (!hasMemberAccess) {
        return { key: capability.key, label: capability.label, status: "permission_required", detail: "Your workspace access does not include this action. Ask an owner or admin to review your access." };
      }
      if (input.activeAbilities === null) {
        return { key: capability.key, label: capability.label, status: "actions_unverified", detail: "The Growth Partner's current Allowed actions could not be verified." };
      }
      if (!hasPartnerAbility) {
        return { key: capability.key, label: capability.label, status: "disabled", detail: "A required action is switched off in the Growth Partner's Allowed actions." };
      }
      return {
        key: capability.key,
        label: capability.label,
        status: "available",
        detail: "Your access, the Growth Partner's required actions, and its runtime check are recorded. Connected services, limits, and approvals are checked again when work starts.",
      };
    });
}
