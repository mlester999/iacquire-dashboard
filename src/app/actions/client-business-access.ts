"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { guard } from "@/server/action-guard";
import { requireAgencyOrThrow } from "@/server/tenancy/context";
import { revokeClientBusinessAccessAsAdmin, setClientBusinessTools } from "@/server/workforce/provisioning";

// Super Admin levers for a client's AI employees' business tools. Each action signs the person in as a Super Admin first (the check is made again where the work is done), parses its input
// strictly, and hands over to the service that audits the change. The ids travel as text and are checked there; nothing here returns a credential, a secret or a hash.

const ids = {
  orgId: z.string().uuid(),
  agentId: z.string().uuid().optional(),
  credentialId: z.string().uuid().optional(),
};

const revokeInput = z.object({ ...ids, reason: z.string().min(5, "Say why this access is being ended (at least 5 characters).").max(500) }).strict();
const switchInput = z.object({ orgId: z.string().uuid(), tools: z.boolean().optional(), proposals: z.boolean().optional(), reason: z.string().trim().min(5, "Say why this is being switched (at least 5 characters).").max(500).optional() }).strict();

const refresh = (orgId: string) => revalidatePath(`/admin/clients/${orgId}`);

/**
 * Ends a client's business tool access at once: one credential, one employee's, or all of the workspace's (the emergency lever). The reason, 5 or more characters, is kept in the audit trail.
 * Never for an agency or a demo workspace. Returns how many credentials were ended.
 */
export async function revokeClientBusinessAccess(input: unknown) {
  return guard(async () => {
    const user = await requireAgencyOrThrow("super_admin");
    const parsed = revokeInput.parse(input);
    const result = await revokeClientBusinessAccessAsAdmin(user, parsed);
    refresh(parsed.orgId);
    return result;
  });
}

/**
 * Switches a client workspace's business tools (reads) and/or change proposals on or off, and asks for its employees' profiles to be synchronized to match (nothing else changes on the
 * employee until the worker has done it). Never for an agency or a demo workspace.
 */
export async function setClientBusinessToolsAction(input: unknown) {
  return guard(async () => {
    const user = await requireAgencyOrThrow("super_admin");
    const parsed = switchInput.parse(input);
    const result = await setClientBusinessTools(user, parsed);
    refresh(parsed.orgId);
    return { changed: result.changed, queued: result.sync?.queued.length ?? 0 };
  });
}
