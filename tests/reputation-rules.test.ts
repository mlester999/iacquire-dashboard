// The pure rules behind private-feedback follow-up: what counts as a low score, the settings a workspace may choose, and how a comment with no score is read. No database.
import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS, describeScore, FEEDBACK_SCALES, isFeedbackScale, isLowScore, THRESHOLD_LIMITS } from "@/lib/reputation/scores";
import { applySettingsPatch, cleanStyleNote, DEFAULT_REPUTATION_SETTINGS, SETTING_LIMITS, settingsPatchSchema } from "@/lib/reputation/settings";
import { withoutNegatedComplaints } from "@/lib/reputation/signals";

describe("what counts as a low score", () => {
  it("is a star rating at or below the workspace's level, and only that", () => {
    for (let level = THRESHOLD_LIMITS.escalateAtOrBelow.min; level <= THRESHOLD_LIMITS.escalateAtOrBelow.max; level += 1) {
      for (let rating = 1; rating <= 5; rating += 1) {
        expect(isLowScore("csat5", rating, { ...DEFAULT_THRESHOLDS, escalateAtOrBelow: level }), `${rating} of 5 at level ${level}`).toBe(rating <= level);
      }
    }
    // The standing default is 2 of 5: a 2 is low, a 3 is not.
    expect([1, 2, 3, 4, 5].map((n) => isLowScore("csat5", n))).toEqual([true, true, false, false, false]);
  });

  it("is a zero-to-ten score at or below the detractor level on that scale", () => {
    for (let level = THRESHOLD_LIMITS.npsDetractorMax.min; level <= THRESHOLD_LIMITS.npsDetractorMax.max; level += 1) {
      for (let score = 0; score <= 10; score += 1) {
        expect(isLowScore("nps10", score, { ...DEFAULT_THRESHOLDS, npsDetractorMax: level }), `${score} of 10 at level ${level}`).toBe(score <= level);
      }
    }
    expect([0, 6, 7, 8, 9, 10].map((n) => isLowScore("nps10", n))).toEqual([true, true, false, false, false, false]);
  });

  it("never treats a missing, fractional or out-of-range score as low: a number it does not have is not a complaint", () => {
    for (const bad of [null, undefined, Number.NaN, 2.5, 0, -1, 6, 11]) expect(isLowScore("csat5", bad as number | null), String(bad)).toBe(false);
    for (const bad of [null, undefined, Number.NaN, 0.5, -1, 11]) expect(isLowScore("nps10", bad as number | null), String(bad)).toBe(false);
    // A score 0 on the five-star scale is not a rating; on the ten-point scale it is the lowest answer.
    expect(isLowScore("nps10", 0)).toBe(true);
  });

  it("knows its two scales and words a score for a team member", () => {
    expect(FEEDBACK_SCALES).toEqual(["csat5", "nps10"]);
    expect(isFeedbackScale("csat5") && isFeedbackScale("nps10")).toBe(true);
    expect(isFeedbackScale("stars") || isFeedbackScale(5) || isFeedbackScale(null)).toBe(false);
    expect(describeScore("csat5", 2)).toBe("2 of 5");
    expect(describeScore("nps10", 6)).toBe("6 of 10");
    expect(describeScore("csat5", null)).toBeNull();
  });
});

describe("reading a comment that came without a score", () => {
  it("takes out a complaint that is named only to deny it, and leaves everything else", () => {
    const deny = ["No complaints at all, thank you!", "I have no complaints.", "Not a single complaint from us.", "Honestly can't complain", "There was nothing to complain about", "Zero complaints", "We never had a complaint"];
    for (const text of deny) expect(withoutNegatedComplaints(text).toLowerCase(), text).not.toMatch(/complain/);
    // A real complaint stays, even beside a denied one.
    expect(withoutNegatedComplaints("This was a real complaint about the wait.")).toMatch(/complaint/);
    expect(withoutNegatedComplaints("No complaints about the staff, but the service was terrible service overall.")).toMatch(/terrible service/);
    expect(withoutNegatedComplaints("Lovely staff and a quick visit.")).toBe("Lovely staff and a quick visit.");
  });
});

describe("the settings a workspace may choose", () => {
  it("starts from the standard settings: level 2, 24 hours, reminders on, nudges off, AI replies off", () => {
    expect(DEFAULT_REPUTATION_SETTINGS).toMatchObject({
      escalateAtOrBelow: 2, npsDetractorMax: 6, acknowledgeWithinHours: 24, publicReviewAlertAtOrBelow: 3, aiRepliesEnabled: false, slaRemindersEnabled: true, outcomeNudgesEnabled: false, renewalRemindersEnabled: false, version: 0, isDefault: true,
    });
  });

  it("accepts values inside the ranges and refuses anything outside them, with a plain reason", () => {
    const ok = (p: unknown) => settingsPatchSchema.safeParse(p);
    expect(ok({ escalateAtOrBelow: 1 }).success && ok({ escalateAtOrBelow: 3 }).success).toBe(true);
    for (const [key, bad] of [["escalateAtOrBelow", 0], ["escalateAtOrBelow", 4], ["escalateAtOrBelow", 2.5], ["npsDetractorMax", 3], ["npsDetractorMax", 8], ["acknowledgeWithinHours", 0],
      ["acknowledgeWithinHours", SETTING_LIMITS.acknowledgeWithinHours.max + 1], ["publicReviewAlertAtOrBelow", 5], ["aiRepliesEnabled", "yes"], ["slaRemindersEnabled", 1]] as const) {
      const r = ok({ [key]: bad });
      expect(r.success, `${key}=${String(bad)}`).toBe(false);
    }
    expect(ok({ acknowledgeWithinHours: 0 }).error?.issues[0]?.message).toMatch(/can't be lower than 1/);
  });

  it("refuses a field it does not list (a strict object), so nothing can be slipped in", () => {
    for (const extra of [{ version: 9 }, { isDefault: false }, { org_id: "x" }, { escalateAtOrBelow: 2, orgId: "x" }]) expect(settingsPatchSchema.safeParse(extra).success, JSON.stringify(extra)).toBe(false);
    expect(settingsPatchSchema.safeParse({}).success).toBe(true);
  });

  it("keeps the style note to one tidy line of at most 600 characters", () => {
    expect(settingsPatchSchema.safeParse({ replyStyleNote: "x".repeat(601) }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ replyStyleNote: "x".repeat(600) }).success).toBe(true);
    // Whitespace is squashed before it is counted.
    expect(settingsPatchSchema.safeParse({ replyStyleNote: `${"a ".repeat(200)}\n\n\n   ` }).success).toBe(true);
    expect(cleanStyleNote("  warm,\n short   and plain  ")).toBe("warm, short and plain");
    expect(cleanStyleNote("   ")).toBeNull();
    expect(cleanStyleNote(null)).toBeNull();
  });

  it("applies a patch field by field and leaves what it does not name", () => {
    const next = applySettingsPatch(DEFAULT_REPUTATION_SETTINGS, { escalateAtOrBelow: 3, outcomeNudgesEnabled: true, replyStyleNote: "  Warm and short.  " });
    expect(next).toMatchObject({ escalateAtOrBelow: 3, outcomeNudgesEnabled: true, replyStyleNote: "Warm and short.", acknowledgeWithinHours: 24, slaRemindersEnabled: true, aiRepliesEnabled: false });
    // Clearing the note, and a patch that changes nothing.
    expect(applySettingsPatch(next, { replyStyleNote: null }).replyStyleNote).toBeNull();
    expect(applySettingsPatch(next, {})).toEqual(next);
  });
});
