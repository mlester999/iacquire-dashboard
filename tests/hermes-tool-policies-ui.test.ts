import { describe, expect, it } from "vitest";
import type { HermesToolPolicyView } from "@/server/workforce/tool-policies";
import { policyTargetOptions } from "@/components/admin/hermes-tool-policies";

describe("Hermes policy target labels", () => {
  it("distinguishes client previous profiles from internal profiles", () => {
    const data = {
      clients: [{ id: "client-1", name: "Roofing Co", policy: null, agentIds: ["client-agent"] }],
      agents: [
        { id: "internal-agent", orgId: "agency-1", orgName: "iAcquire", orgKind: "agency", roleKey: "operations_manager", displayName: "Operations Manager" },
        { id: "client-agent", orgId: "client-1", orgName: "Roofing Co", orgKind: "client", roleKey: "lead_hunter", displayName: "Lead Hunter" },
      ],
    } as unknown as HermesToolPolicyView;

    expect(policyTargetOptions(data).map((option) => option.label)).toEqual([
      "iAcquire · Internal profile · Operations Manager",
      "Roofing Co · Client",
      "Roofing Co · Previous profile · Lead Hunter",
    ]);
  });
});
