import { describe, expect, it } from "vitest";
import { preferredChatTimeZone, resolveChatTimeZone } from "@/lib/chat-timezone";
import { chatDateSeparatorLabel, compactRelativeTime, conversationDateKey, formatChatTime, fullTimestamp } from "@/lib/conversation-time";

describe("AI Employee Chat display timezone", () => {
  it("uses a deliberately saved account timezone and otherwise follows the browser timezone", () => {
    expect(preferredChatTimeZone("UTC", {})).toBeNull();
    expect(preferredChatTimeZone("UTC", { preferredDisplayTimezoneConfigured: true })).toBe("UTC");
    expect(preferredChatTimeZone("Asia/Manila", {})).toBe("Asia/Manila");
    expect(resolveChatTimeZone("America/New_York", "Asia/Manila")).toBe("America/New_York");
    expect(resolveChatTimeZone(null, "America/Los_Angeles")).toBe("America/Los_Angeles");
    expect(resolveChatTimeZone("invalid/zone", "Asia/Manila")).toBe("Asia/Manila");
    expect(resolveChatTimeZone(null, null)).toBe("UTC");
  });

  it("formats message times and same-day conversation previews in 12-hour local time", () => {
    const now = new Date("2026-10-20T04:00:00.000Z");
    const message = "2026-10-19T17:00:00.000Z";

    expect(formatChatTime(message, "Asia/Manila")).toBe("1:00 AM");
    expect(formatChatTime(message, "UTC")).toBe("5:00 PM");
    expect(compactRelativeTime(message, now, "Asia/Manila")).toBe("1:00 AM");
    expect(compactRelativeTime(message, now, "UTC")).toBe("11h");
    expect(fullTimestamp(message, "Asia/Manila")).toMatch(/AM/);
  });

  it("uses local calendar days for Today/Yesterday groupings and message date dividers", () => {
    const now = new Date("2026-10-20T04:00:00.000Z");
    const message = "2026-10-19T17:00:00.000Z";

    expect(conversationDateKey(message, "Asia/Manila")).toBe("2026-10-20");
    expect(conversationDateKey(message, "UTC")).toBe("2026-10-19");
    expect(chatDateSeparatorLabel(message, now, "Asia/Manila")).toBe("Today");
    expect(chatDateSeparatorLabel(message, now, "UTC")).toBe("Yesterday");
  });

  it("applies North American daylight saving transitions when formatting historical timestamps", () => {
    expect(formatChatTime("2026-03-08T06:30:00.000Z", "America/New_York")).toBe("1:30 AM");
    expect(formatChatTime("2026-03-08T07:30:00.000Z", "America/New_York")).toBe("3:30 AM");
    expect(formatChatTime("2026-11-01T06:30:00.000Z", "America/New_York")).toBe("1:30 AM");
  });
});
