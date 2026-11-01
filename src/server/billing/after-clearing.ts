import "server-only";
import type { Queryable } from "@/server/db";
import { notifyOrgRoles } from "@/server/notifications";
import { requestProvisioning } from "@/server/workforce/provisioning";
import { scheduleClientCrmSetup } from "@/server/onboarding/crm-provisioning";

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
  // The industry CRM waits for the same two things the employees do (questionnaire submitted, fee cleared); whichever of the two arrives second starts it. It runs only after this
  // transaction has committed, never inside it, and does nothing at all while the switch is off.
  scheduleClientCrmSetup(orgId, "setup fee cleared");
  // The launch ledger remembers the state this clearing left, after the transaction has committed (it reads the committed payment). Loaded on demand: the launch module imports
  // far more than a payment path should at load.
  try {
    const { scheduleLaunchSnapshot } = await import("@/server/setup/launch-ledger");
    scheduleLaunchSnapshot(orgId, "setup fee cleared");
  } catch (err) {
    console.warn("[iacquire] could not schedule the launch ledger after the setup fee cleared.", { error: err instanceof Error ? err.name : "unknown" });
  }
  return { provisioningRequested };
}
