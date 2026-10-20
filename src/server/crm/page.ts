import "server-only";
import { redirect } from "next/navigation";
import { requireOrgContext } from "@/server/tenancy/context";
import { memberActor, type CrmActor } from "@/server/crm/actor";
import { getWorkspace } from "@/server/crm/workspace";
import { PERMISSION_MATRIX, type Permission } from "@/lib/permissions";

/** What a client component needs to know about who is acting and where: serializable, with no secrets. */
export interface CrmScope {
  base: string;
  /** Passed to every server action: null for a client's own workspace, the client's id for an agency support session. */
  orgId: string | null;
  agency: boolean;
  readOnly: boolean;
  userId: string | null;
  timezone: string;
  currency: string;
  can: Partial<Record<Permission, true>>;
}

export async function scopeFor(actor: CrmActor, base: string): Promise<CrmScope> {
  const can: Partial<Record<Permission, true>> = {};
  for (const p of Object.keys(PERMISSION_MATRIX) as Permission[]) if (actor.can(p)) can[p] = true;
  // Reuses the workspace the CRM layout already loaded in this render instead of querying the
  // currency again. Falls back to one query for routes rendered without that layout.
  const ws = await getWorkspace(actor);
  return {
    base,
    orgId: actor.kind === "agency" ? actor.orgId : null,
    agency: actor.kind === "agency",
    readOnly: actor.kind === "agency" && actor.supportMode === "read",
    userId: actor.userId,
    timezone: actor.timezone,
    currency: ws.defaultCurrency,
    can,
  };
}

/** The signed-in member's CRM actor for a client portal page. Agency people without a client workspace go to the agency console. */
export async function clientCrmActor(permission: Permission = "crm.view"): Promise<CrmActor> {
  const ctx = await requireOrgContext(permission);
  if (ctx.org.kind !== "client") redirect("/admin/crm");
  return memberActor(ctx);
}
