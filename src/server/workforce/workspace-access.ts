import "server-only";

import { redirect } from "next/navigation";
import type { Permission } from "@/lib/permissions";
import { AppError } from "@/server/errors";
import { requireOrgContext, requireOrgContextOrThrow, type OrgContext } from "@/server/tenancy/context";

/** Internal iAcquire employee records are available only to an authenticated agency Super Admin. */
export function assertWorkforceWorkspaceAccess(ctx: OrgContext): OrgContext {
  if (ctx.org.kind === "agency" && ctx.user.platformRole !== "agency_super_admin") {
    throw new AppError("forbidden", "Only an iAcquire Super Admin can access internal AI employees.");
  }
  return ctx;
}

/** Page entry point for employee, chat, work board, and calendar screens. */
export async function requireWorkforceContext(permission?: Permission): Promise<OrgContext> {
  const ctx = await requireOrgContext(permission);
  if (ctx.org.kind === "agency" && ctx.user.platformRole !== "agency_super_admin") {
    redirect(ctx.user.platformRole === "agency_staff" ? "/admin/employees/clients" : "/admin");
  }
  return ctx;
}

/** Server actions and API routes must enforce the same boundary without relying on a page visit. */
export async function requireWorkforceContextOrThrow(permission?: Permission): Promise<OrgContext> {
  return assertWorkforceWorkspaceAccess(await requireOrgContextOrThrow(permission));
}
