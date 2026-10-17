import { describe, expect, it } from "vitest";
import { canViewAdminNavigation } from "@/lib/admin-nav";
import type { Permission } from "@/lib/permissions";

const permissionSet = (...permissions: Permission[]) => new Set<Permission>(permissions);

describe("agency navigation permissions", () => {
  it("hides a module when its effective server permission is denied", () => {
    expect(canViewAdminNavigation({ permission: "agency.support.view" }, "agency_staff", permissionSet())).toBe(false);
    expect(canViewAdminNavigation({ permission: "agency.support.view" }, "agency_staff", permissionSet("agency.support.view"))).toBe(true);
  });

  it("uses the agency CRM grant for the client-summary route", () => {
    const crmPolicy = { permission: "agency.crm.read" as const };
    expect(canViewAdminNavigation(crmPolicy, "agency_manager", permissionSet("agency.crm.read"))).toBe(true);
    expect(canViewAdminNavigation(crmPolicy, "agency_manager", permissionSet())).toBe(false);
  });

  it("keeps role-only routes and protected policy modules behind their role and permission", () => {
    expect(canViewAdminNavigation({ superOnly: true }, "agency_manager", permissionSet())).toBe(false);
    expect(canViewAdminNavigation({ superOnly: true }, "agency_super_admin", permissionSet())).toBe(true);
    expect(canViewAdminNavigation({ superOnly: true }, "agency_staff", permissionSet("agency.security.manage"))).toBe(false);
    expect(canViewAdminNavigation({ managerOrSuper: true, permission: "agency.tool_policies.view" }, "agency_staff", permissionSet("agency.tool_policies.view"))).toBe(false);
    expect(canViewAdminNavigation({ managerOrSuper: true, permission: "agency.tool_policies.view" }, "agency_manager", permissionSet("agency.tool_policies.view"))).toBe(true);
  });
});
