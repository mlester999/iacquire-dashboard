import { describe, expect, it } from "vitest";
import {
  absoluteNotificationTime,
  compactRelativeTime,
  configRiskLabel,
  configVersionSourceLabel,
  configVersionStatus,
  notificationCategory,
  notificationGroupLabel,
  presentNotificationCategories,
} from "@/lib/notification-presentation";

describe("notification presentation", () => {
  const now = Date.parse("2026-10-20T13:00:00.000Z");

  it("uses compact, intentional relative time instead of a long sentence", () => {
    expect(compactRelativeTime(new Date(now - 20_000).toISOString(), now, "UTC")).toBe("Just now");
    expect(compactRelativeTime(new Date(now - 5 * 60_000).toISOString(), now, "UTC")).toBe("5m ago");
    expect(compactRelativeTime(new Date(now - 2 * 3_600_000).toISOString(), now, "UTC")).toBe("2h ago");
    expect(compactRelativeTime(new Date(now - 3 * 86_400_000).toISOString(), now, "UTC")).toBe("3d ago");
    expect(compactRelativeTime(new Date(now - 30 * 86_400_000).toISOString(), now, "UTC")).toBe("Sep 20");
  });

  it("uses the workspace time zone for calendar boundaries", () => {
    // 25 hours earlier in Singapore is still the previous calendar day, so it reads as Yesterday
    // even though a naive 24-hour threshold would call it a day count.
    expect(compactRelativeTime("2026-10-19T12:00:00.000Z", now, "Asia/Singapore")).toBe("Yesterday");
    expect(notificationGroupLabel("2026-10-19T12:00:00.000Z", "Asia/Singapore", now)).toBe("Yesterday");
    expect(notificationGroupLabel("2026-10-20T02:00:00.000Z", "Asia/Singapore", now)).toBe("Today");
  });

  it("always exposes an absolute time with the zone label", () => {
    expect(absoluteNotificationTime("2026-10-20T05:04:00.000Z", "Asia/Singapore")).toMatch(/Oct 20, 2026/);
    expect(absoluteNotificationTime(null, "UTC")).toBe("Time not recorded");
    expect(compactRelativeTime("not-a-date", now, "UTC")).toBe("Time not recorded");
  });

  it("maps saved notification kinds to one stable category vocabulary", () => {
    expect(notificationCategory("approval_requested").key).toBe("approvals");
    expect(notificationCategory("agent_status").key).toBe("workforce");
    expect(notificationCategory("integration_disconnected").key).toBe("connectivity");
    expect(notificationCategory("billing_payment_failed").key).toBe("billing");
    expect(notificationCategory("crm_import_finished").key).toBe("crm");
    expect(notificationCategory("support_reply").key).toBe("support");
    expect(notificationCategory("something_new").key).toBe("system");
    expect(presentNotificationCategories(["approval_requested", "agent_status", "support_reply"]).map((category) => category.key)).toEqual([
      "approvals",
      "workforce",
      "support",
    ]);
  });

  it("labels only the source values the backend actually records", () => {
    expect(configVersionSourceLabel("client_edit")).toBe("Client edit");
    expect(configVersionSourceLabel("agency")).toBe("Internal agency edit");
    expect(configVersionSourceLabel("onboarding")).toBe("Onboarding configuration");
    expect(configVersionSourceLabel("change_request")).toBe("Change request");
    expect(configVersionSourceLabel("rollback")).toBe("Restored version");
    expect(configVersionSourceLabel("future_source")).toBe("Source not recorded");
    expect(configVersionSourceLabel(null)).toBe("Source not recorded");
  });

  it("keeps version states and risk flags human-readable", () => {
    expect(configVersionStatus("applied")).toMatchObject({ label: "Active", active: true, tone: "success" });
    expect(configVersionStatus("pending_agency_review")).toMatchObject({ label: "Awaiting review", tone: "warning", active: false });
    expect(configVersionStatus("rejected")).toMatchObject({ label: "Not approved", tone: "danger", active: false });
    expect(configVersionStatus("superseded")).toMatchObject({ label: "Superseded", tone: "neutral", active: false });
    expect(configRiskLabel("override_attempt")).toBe("Instruction-override attempt");
    expect(configRiskLabel("some_new_flag")).toBe("some new flag");
  });
});
