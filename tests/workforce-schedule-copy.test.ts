import { describe, expect, it } from "vitest";
import { workforceScheduleSkipReasonLabel } from "@/lib/workforce-schedule-copy";

describe("workforce schedule skip explanations", () => {
  it("translates persisted scheduler reasons to plain language", () => {
    expect(workforceScheduleSkipReasonLabel("outside_business_hours")).toMatch(/business-hours window/i);
    expect(workforceScheduleSkipReasonLabel("automation_agent_not_ready")).toMatch(/connection check/i);
    expect(workforceScheduleSkipReasonLabel("research_rate_limited")).toMatch(/research limit/i);
    expect(workforceScheduleSkipReasonLabel("consecutive_failures")).toMatch(/three consecutive/i);
  });

  it("provides a readable fallback for an unknown stored reason", () => {
    expect(workforceScheduleSkipReasonLabel("future_scheduler_code")).toBe("Skipped because a required schedule check did not pass.");
    expect(workforceScheduleSkipReasonLabel(null)).toBeNull();
  });
});
