import { describe, expect, it } from "vitest";
import { growthPartnerWorkRows } from "@/lib/analytics-view";

describe("Growth Partner analytics presentation", () => {
  it("shows the unified partner and aggregates preserved role activity without retired names", () => {
    expect(growthPartnerWorkRows([
      { role_key: "growth_partner", total: 3 },
      { role_key: "lead_hunter", total: 5 },
      { role_key: "crm_manager", total: 2 },
    ])).toEqual([
      { key: "growth_partner", label: "AI Growth Partner", value: 3 },
      { key: "previous_profiles", label: "Previous role profiles", value: 7 },
    ]);
  });

  it("shows no empty role rows when there has been no recorded work", () => {
    expect(growthPartnerWorkRows([
      { role_key: "growth_partner", total: 0 },
      { role_key: "lead_hunter", total: 0 },
    ])).toEqual([]);
  });
});
