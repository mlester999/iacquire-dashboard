import { describe, expect, it } from "vitest";
import { parseWorkforceChatAssignment } from "@/lib/workforce-chat-assignment";
import { parseWorkforceChatReadIntent } from "@/lib/workforce-chat-read-intent";

const now = new Date("2026-11-18T12:00:00.000Z");
const parse = (role: "growth_partner" | "operations_manager", content: string, timeZone = "UTC", at: Date | number = now) =>
  parseWorkforceChatReadIntent(role, content, { now: at, timeZone });

describe("Growth Partner deterministic read-intent parser", () => {
  it.each([
    ["UTC", "2026-01-01T16:00:00.000Z", "2026-01-01"],
    ["Asia/Singapore", "2026-01-01T16:00:00.000Z", "2026-01-02"],
    ["America/Los_Angeles", "2026-01-02T00:00:00.000Z", "2026-01-01"],
  ])("uses the local date at a UTC boundary in %s", (timeZone, instant, localDate) => {
    expect(parse("growth_partner", "show my new leads today", String(timeZone), new Date(String(instant)))).toEqual({
      kind: "new_leads",
      window: { startDate: localDate, endDateExclusive: expect.any(String), label: localDate },
    });
  });

  it("uses the workspace-local Monday for week windows and resolves weekday words", () => {
    expect(parse("growth_partner", "activities you completed this week")).toEqual({
      kind: "completed_activity",
      window: { startDate: "2026-11-16", endDateExclusive: "2026-11-23", label: "this week" },
    });
    expect(parse("growth_partner", "appointments next Monday")).toEqual({ kind: "appointments_on", date: "2026-11-23" });
    expect(parse("growth_partner", "appointments last Friday")).toEqual({ kind: "appointments_on", date: "2026-11-13" });
  });

  it("accepts one valid ISO date for an appointment list", () => {
    expect(parse("growth_partner", "show appointments on 2026-11-20")).toEqual({ kind: "appointments_on", date: "2026-11-20" });
  });

  it.each([
    "show appointments on 11/12",
    "show appointments today or tomorrow",
    "show appointments next week",
    "show appointments on 2026-02-30",
    "show appointments on November 16",
  ])("asks instead of guessing the appointment date in %s", (content) => {
    expect(parse("growth_partner", content)).toMatchObject({ kind: "clarify" });
  });

  it("clarifies an ambiguous new-lead date and supports an explicit week", () => {
    expect(parse("growth_partner", "show new leads on 03/04")).toMatchObject({ kind: "clarify" });
    expect(parse("growth_partner", "show my new leads last week")).toEqual({
      kind: "new_leads",
      window: { startDate: "2026-11-09", endDateExclusive: "2026-11-16", label: "last week" },
    });
  });

  it.each([
    ["which leads should we follow up on", { kind: "followup_ranking" }],
    ["which tasks need my approval", { kind: "approvals_waiting" }],
    ["what approvals are waiting", { kind: "approvals_waiting" }],
    ["activities you completed this week", { kind: "completed_activity", window: { startDate: "2026-11-16", endDateExclusive: "2026-11-23", label: "this week" } }],
  ] as const)("recognizes %s", (content, expected) => {
    expect(parse("growth_partner", content)).toEqual(expected);
  });

  it("leaves legacy roles and reviewed appointment and operations requests on their existing routes", () => {
    expect(parse("operations_manager", "show my new leads today")).toEqual({ kind: "none" });
    for (const content of ["review my appointments", "review booking risks", "review operations"]) {
      expect(parse("growth_partner", content), content).toEqual({ kind: "none" });
    }
    expect(parseWorkforceChatAssignment("growth_partner", "review my appointments")?.capability).toBe("appointment_review");
    expect(parseWorkforceChatAssignment("growth_partner", "review booking risks")?.capability).toBe("appointment_review");
    expect(parseWorkforceChatAssignment("growth_partner", "review operations")?.capability).toBe("proactive_review");
    const availabilityReview = "Check our appointment availability and help me schedule a consultation";
    expect(parse("growth_partner", availabilityReview)).toEqual({ kind: "none" });
    expect(parseWorkforceChatAssignment("growth_partner", availabilityReview)?.capability).toBe("appointment_availability");
    const leadResearchReview = "Review our recent lead research and explain which candidates need review";
    expect(parse("growth_partner", leadResearchReview)).toEqual({ kind: "none" });
    expect(parseWorkforceChatAssignment("growth_partner", leadResearchReview)?.capability).toBe("lead_generation_review");
  });
});
