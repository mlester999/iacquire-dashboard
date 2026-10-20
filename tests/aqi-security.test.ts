import { describe, expect, it } from "vitest";
import { canOpenAqiRoute, matchAqiRoute, pageFor, safeAqiHref, type AqiAccess } from "@/lib/aqi/routes";

const clientOwner: AqiAccess = { can: (permission) => permission === "workspace.view" || permission === "agents.use", agencyRole: null };
const superAdmin: AqiAccess = { can: () => true, agencyRole: "agency_super_admin" };
const agencyStaff: AqiAccess = { can: (permission) => permission === "agency.workforce.view", agencyRole: "agency_staff" };
const agencyManager: AqiAccess = { can: (permission) => permission === "agency.workforce.view" || permission === "agency.tool_policies.view", agencyRole: "agency_manager" };

describe("AQi navigation safety", () => {
  it("matches the most specific route", () => {
    expect(matchAqiRoute("/settings/team")?.path).toBe("/settings/team");
    expect(pageFor("/employees/sales-assistant/configure")?.path).toBe("/employees");
    expect(pageFor("/not-a-real-page")).toBeNull();
  });

  it("rejects external, protocol-relative and unauthorized destinations", () => {
    expect(safeAqiHref("https://evil.example", superAdmin)).toBeNull();
    expect(safeAqiHref("//evil.example/path", superAdmin)).toBeNull();
    expect(safeAqiHref("/admin/aqi", clientOwner)).toBeNull();
    expect(safeAqiHref("/employees", clientOwner)?.path).toBe("/employees");
    expect(safeAqiHref("/admin/aqi", superAdmin)?.path).toBe("/admin/aqi");
  });

  it("does not let a client open agency-only routes", () => {
    const adminRoute = matchAqiRoute("/admin/employees");
    expect(adminRoute).not.toBeNull();
    expect(canOpenAqiRoute(adminRoute!, clientOwner)).toBe(false);
    expect(canOpenAqiRoute(adminRoute!, superAdmin)).toBe(true);
  });

  it("checks the actual agency permission, not just the agency role", () => {
    expect(safeAqiHref("/admin/health", agencyStaff)).toBeNull();
    expect(safeAqiHref("/admin/integrations", agencyStaff)).toBeNull();
    expect(safeAqiHref("/admin/employees/policies", agencyStaff)).toBeNull();
    expect(safeAqiHref("/admin/employees/clients", agencyStaff)?.path).toBe("/admin/employees/clients");
    expect(safeAqiHref("/admin/employees", agencyStaff)).toBeNull();
    expect(safeAqiHref("/admin/aqi", agencyManager)).toBeNull();
    expect(safeAqiHref("/admin/employees/policies", agencyManager)?.path).toBe("/admin/employees/policies");
    expect(safeAqiHref("/admin", agencyStaff)?.path).toBe("/admin");
  });

  it("keeps client role permissions independent of agency access", () => {
    expect(safeAqiHref("/billing", clientOwner)).toBeNull();
    expect(safeAqiHref("/support", clientOwner)).toBeNull();
    const viewer: AqiAccess = { can: (permission) => permission === "workspace.view" || permission === "support.use", agencyRole: null };
    expect(safeAqiHref("/support", viewer)?.path).toBe("/support");
    expect(safeAqiHref("/employees", viewer)).toBeNull();
  });
});
