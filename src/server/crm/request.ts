import "server-only";
import { AppError } from "@/server/errors";
import { requireUserOrThrow } from "@/server/auth/session";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { agencyActor, assertCan, memberActor, type CrmActor } from "@/server/crm/actor";
import type { Permission } from "@/lib/permissions";

/**
 * The actor for a server action or route handler. A client user always acts on their own active workspace (another organization ID is
 * refused, not honoured). An agency user names the client and must hold a support session for it. Kept apart from the services so they
 * stay usable from scripts and background work, which have no request.
 */
export async function resolveCrmActor(orgId?: string | null, permission: Permission = "crm.view"): Promise<CrmActor> {
  const user = await requireUserOrThrow();
  if (orgId && user.platformRole !== "none") {
    const actor = await agencyActor(user, orgId);
    assertCan(actor, permission);
    return actor;
  }
  const ctx = await requireOrgContextOrThrow();
  if (orgId && orgId !== ctx.org.orgId) throw new AppError("forbidden", "You don't have access to that workspace.");
  const actor = memberActor(ctx);
  assertCan(actor, permission);
  return actor;
}
