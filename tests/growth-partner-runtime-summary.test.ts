import { describe, expect, it } from "vitest";
import { growthPartnerRuntimeSummary } from "@/lib/integrations/growth-partner-runtime-summary";

describe("Growth Partner runtime presentation", () => {
  it("describes the single dedicated runtime as ready only after its recorded checks pass", () => {
    expect(growthPartnerRuntimeSummary(1, 1)).toEqual({
      value: "Ready",
      status: "connected",
      detail: "One dedicated runtime passed its latest readiness check.",
      body: "Your AI Growth Partner uses one dedicated runtime profile in this private workspace.",
    });
  });

  it("shows saved-but-unready runtimes as needing attention", () => {
    expect(growthPartnerRuntimeSummary(0, 1)).toMatchObject({ value: "Needs attention", status: "degraded" });
  });

  it("shows setup state when no enabled Growth Partner runtime exists", () => {
    expect(growthPartnerRuntimeSummary(0, 0)).toMatchObject({ value: "Not set up", status: "not_configured" });
  });
});
