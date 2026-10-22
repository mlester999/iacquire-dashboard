"use server";

import { revalidatePath } from "next/cache";
import { requireAgencyOrThrow } from "@/server/tenancy/context";
import { guard } from "@/server/action-guard";
import { disableAllWorkspaces, rolloutImpact, setWorkspaceRollout, setWorkspaceRolloutBulk } from "@/server/messaging/inbox-rollout";

// Super Admin only: every call checks the signed-in person's platform role on the server (and so does the service). Nothing here switches a provider on.

const refresh = () => revalidatePath("/admin/inbox-rollout");
const id = (value: string) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error("Choose a valid workspace.");
  return value;
};

/** What is in flight in a workspace, shown before switching its inbox off. Read only. */
export async function rolloutImpactAction(orgId: string) {
  return guard(async () => rolloutImpact(await requireAgencyOrThrow("super_admin"), id(orgId)));
}

export async function setWorkspaceRolloutAction(orgId: string, enabled: boolean, note?: string) {
  return guard(async () => {
    const out = await setWorkspaceRollout(await requireAgencyOrThrow("super_admin"), { orgId: id(orgId), enabled: enabled === true, note: note ?? null });
    refresh();
    return out;
  });
}

export async function setWorkspaceRolloutBulkAction(orgIds: string[], enabled: boolean, note?: string) {
  return guard(async () => {
    if (!Array.isArray(orgIds)) throw new Error("Choose at least one workspace.");
    const out = await setWorkspaceRolloutBulk(await requireAgencyOrThrow("super_admin"), { orgIds: orgIds.map(id), enabled: enabled === true, note: note ?? null });
    refresh();
    return out;
  });
}

/** The rollback control: the new inbox off for every workspace that has it. */
export async function disableAllWorkspacesAction(note?: string) {
  return guard(async () => {
    const out = await disableAllWorkspaces(await requireAgencyOrThrow("super_admin"), note ?? null);
    refresh();
    return out;
  });
}
