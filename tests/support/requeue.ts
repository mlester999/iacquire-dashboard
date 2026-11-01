// Fixtures for tests that must go through the real requeueProvisioningJob: a workspace that is paid for and onboarded, whose employees have an approved configuration, and an
// agency person who may requeue. Nothing here talks to a provider.
import { withSystem } from "@/server/db";
import type { AgentRoleKey } from "@/lib/agents";
import { defaultSettings } from "@/server/workforce/compiler";
import { createConfigVersion } from "@/server/workforce/service";
import { requeueProvisioningJob } from "@/server/workforce/provisioning";
import { clearSetupPayment } from "./billing";
import { createUser } from "./fixtures";

/**
 * Makes a workspace requeue-ready (payment cleared, onboarding finished, an applied configuration for each given employee) and returns an agency person who may requeue it: the one
 * given, or a new Super Admin (a test that counts agency notices passes its own, because every agency person receives each of them).
 */
export async function readyToRequeue(org: { id: string }, ownerId: string, agentIds: string[], existingAdminId?: string): Promise<{ adminId: string }> {
  await clearSetupPayment(org.id);
  await withSystem(async (db) => {
    await db.query("update organizations set onboarding_completed_at = coalesce(onboarding_completed_at, now()) where id = $1", [org.id]);
    for (const agentId of agentIds) {
      const role = (await db.query<{ role_key: AgentRoleKey }>("select role_key from agent_instances where id = $1 and org_id = $2", [agentId, org.id])).rows[0].role_key;
      await createConfigVersion(db, { orgId: org.id, agentId, settings: defaultSettings(role), source: "onboarding", userId: ownerId, apply: true });
    }
  });
  if (existingAdminId) return { adminId: existingAdminId };
  const admin = await createUser({ platformRole: "agency_super_admin" });
  return { adminId: admin.id };
}

/** The agency's requeue, for one employee, through the real service (a new job opens beside the old one; the old one is left as it was). */
export const requeueAs = (adminId: string, orgId: string, agentId: string, reason = "Reviewed the host result and fixed it") => requeueProvisioningJob(adminId, orgId, agentId, reason);
