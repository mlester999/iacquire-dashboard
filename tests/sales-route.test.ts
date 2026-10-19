import { describe, expect, it } from "vitest";
import { shouldRedirectSalesToNative } from "@/lib/crm/sales-route";

describe("legacy sales route ownership", () => {
  it("sends a native client opportunity view to the native workspace", () => {
    expect(shouldRedirectSalesToNative({ orgKind: "client", canViewCrm: true, opportunitiesNative: true })).toBe(true);
  });

  it("keeps the GoHighLevel sales view when GoHighLevel owns opportunities, including in a hybrid", () => {
    expect(shouldRedirectSalesToNative({ orgKind: "client", canViewCrm: true, opportunitiesNative: false })).toBe(false);
  });

  it("never redirects an agency workspace or someone who cannot see the CRM", () => {
    expect(shouldRedirectSalesToNative({ orgKind: "agency", canViewCrm: true, opportunitiesNative: true })).toBe(false);
    expect(shouldRedirectSalesToNative({ orgKind: "client", canViewCrm: false, opportunitiesNative: true })).toBe(false);
  });
});
