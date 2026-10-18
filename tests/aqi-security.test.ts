import { describe, expect, it } from "vitest";
import { canOpenAqiRoute, matchAqiRoute, pageFor, safeAqiHref, type AqiAccess } from "@/lib/aqi/routes";

const clientOwner: AqiAccess = { can: (permission) => permission === "workspace.view" || permission === "agents.use", agencyRole: null };
const superAdmin: AqiAccess = { can: () => true, agencyRole: "agency_super_admin" };

describe("AQi navigation safety", () => {
  it("matches the most specific route", () => {
    expect(matchAqiRoute("/settings/team")?.path).toBe("/settings/team");
    expect(pageFor("/workforce/sales-assistant/configure")?.path).toBe("/workforce");
    expect(pageFor("/not-a-real-page")).toBeNull();
  });

  it("rejects external, protocol-relative and unauthorized destinations", () => {
    expect(safeAqiHref("https://evil.example", superAdmin)).toBeNull();
    expect(safeAqiHref("//evil.example/path", superAdmin)).toBeNull();
    expect(safeAqiHref("/admin/aqi", clientOwner)).toBeNull();
    expect(safeAqiHref("/workforce", clientOwner)?.path).toBe("/workforce");
    expect(safeAqiHref("/admin/aqi", superAdmin)?.path).toBe("/admin/aqi");
  });

  it("does not let a client open agency-only routes", () => {
    const adminRoute = matchAqiRoute("/admin/workforce");
    expect(adminRoute).not.toBeNull();
    expect(canOpenAqiRoute(adminRoute!, clientOwner)).toBe(false);
    expect(canOpenAqiRoute(adminRoute!, superAdmin)).toBe(true);
  });
});
