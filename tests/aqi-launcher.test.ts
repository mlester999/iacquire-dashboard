import { describe, expect, it } from "vitest";
import { aqiLauncherRaised } from "@/lib/aqi/launcher";

describe("where the AQi launcher sits", () => {
  it("lifts above a bottom composer on the chat and a staff conversation, and nowhere else", () => {
    expect(aqiLauncherRaised("/chat")).toBe(true);
    expect(aqiLauncherRaised("/chat/operations-manager")).toBe(true);
    expect(aqiLauncherRaised("/admin/messages/3d0d9483-b5b5-4e10-a87c-98332648b4a6")).toBe(true);
    expect(aqiLauncherRaised("/admin/messages")).toBe(false);
    expect(aqiLauncherRaised("/admin/messages/settings")).toBe(false);
    expect(aqiLauncherRaised("/admin/support")).toBe(false);
    expect(aqiLauncherRaised(null)).toBe(false);
  });
});
