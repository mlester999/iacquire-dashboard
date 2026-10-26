import "server-only";
import type { Queryable } from "@/server/db";
import { notifyOrgRoles } from "@/server/notifications";
import { requestProvisioning } from "@/server/workforce/provisioning";

/**
 * What follows any event that cleared the setup fee (a provider's signed webhook, a payment a Super Admin recorded, a waiver): the AI employees' provisioning requests
 * are opened (idempotent, and still subject to every other condition: onboarding finished, a verified owner, an active workspace) and the owners are told. Returns how
 * many requests were opened. The caller's transaction carries it, so a clearing and its provisioning requests commit together or not at all.
 */
export async function afterSetupCleared(db: Queryable, orgId: string, o: { actorUserId: string | null; how: "payment" | "waiver"; eventKey: string }): Promise<{ provisioningRequested: number }> {
  const provisioningRequested = await requestProvisioning(db, orgId, o.actorUserId);
  await notifyOrgRoles(db, orgId, ["owner", "admin"], {
    kind: "billing_setup_cleared",
    severity: "success",
    title: o.how === "payment" ? "Your setup payment is confirmed" : "Your setup fee has been waived",
    body: "Your AI team can now be set up. iAcquire will tell you as each employee is ready.",
    link: "/employees",
    dedupeKey: `setup-cleared:${o.eventKey}`,
  });
  return { provisioningRequested };
}
