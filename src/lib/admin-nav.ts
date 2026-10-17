import type { Permission } from "@/lib/permissions";

export type AdminNavigationPolicy = {
  superOnly?: boolean;
  managerOrSuper?: boolean;
  permission?: Permission;
  allPermissions?: readonly Permission[];
};

export function canViewAdminNavigation(
  policy: AdminNavigationPolicy,
  platformRole: string,
  permissions: ReadonlySet<Permission>,
): boolean {
  if (policy.superOnly && platformRole !== "agency_super_admin") return false;
  if (policy.managerOrSuper && platformRole !== "agency_manager" && platformRole !== "agency_super_admin") return false;
  if (policy.permission && !permissions.has(policy.permission)) return false;
  if (policy.allPermissions?.some((permission) => !permissions.has(permission)) === true) return false;
  return true;
}
