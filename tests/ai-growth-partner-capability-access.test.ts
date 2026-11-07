import { describe, expect, it } from "vitest";
import {
  deriveGrowthPartnerCapabilityAccess,
  GROWTH_PARTNER_CAPABILITY_GROUPS,
} from "@/lib/ai-growth-partner-capability-access";
import { ROLE_ABILITIES } from "@/lib/employee-tool-policy";
import { WORKFORCE_CAPABILITIES } from "@/lib/workforce-capabilities";

const base = {
  partnerExists: true,
  runtimeAgentId: "growth-partner-runtime",
  runtimeReady: true,
  can: () => true,
  activeAbilities: new Set(ROLE_ABILITIES.growth_partner),
};

describe("Growth Partner capability access", () => {
  it("groups every unified reviewed capability exactly once", () => {
    const grouped = GROWTH_PARTNER_CAPABILITY_GROUPS.flatMap((group) => group.capabilityKeys);
    const unified = Object.values(WORKFORCE_CAPABILITIES)
      .filter((capability) => capability.allowedRoles.includes("growth_partner"))
      .map((capability) => capability.key);

    expect(grouped).toHaveLength(unified.length);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual([...unified].sort());
  });

  it("marks a capability requestable only when member permission, Partner actions and runtime are verified", () => {
    const ready = deriveGrowthPartnerCapabilityAccess(base);
    expect(ready.length).toBe(14);
    expect(ready.every((item) => item.status === "available")).toBe(true);

    const noRuntime = deriveGrowthPartnerCapabilityAccess({ ...base, runtimeReady: false });
    expect(noRuntime.every((item) => item.status === "runtime_unverified")).toBe(true);
  });

  it("honors the signed-in member's additional permission for follow-up drafts", () => {
    const access = deriveGrowthPartnerCapabilityAccess({
      ...base,
      can: (permission) => permission !== "inbox.reply",
    });
    expect(access.find((item) => item.key === "pipeline_followup_drafts")?.status).toBe("permission_required");
    expect(access.find((item) => item.key === "pipeline_review")?.status).toBe("available");
  });

  it("reports an ability switch as disabled and unreadable ability state as unverified", () => {
    const abilities = new Set(ROLE_ABILITIES.growth_partner.filter((ability) => ability !== "crm.read"));
    const disabled = deriveGrowthPartnerCapabilityAccess({ ...base, activeAbilities: abilities });
    expect(disabled.find((item) => item.key === "crm_quality_review")?.status).toBe("disabled");
    expect(disabled.find((item) => item.key === "pipeline_review")?.status).toBe("available");

    const unreadable = deriveGrowthPartnerCapabilityAccess({ ...base, activeAbilities: null });
    expect(unreadable.every((item) => item.status === "actions_unverified")).toBe(true);
  });

  it("does not show a capability as available before a Partner identity exists", () => {
    const access = deriveGrowthPartnerCapabilityAccess({ ...base, partnerExists: false, runtimeAgentId: null });
    expect(access.every((item) => item.status === "not_configured")).toBe(true);
  });
});
