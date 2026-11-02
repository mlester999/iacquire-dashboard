"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireFreshUserOrThrow } from "@/server/auth/session";
import { withSystem } from "@/server/db";
import { env } from "@/server/env";
import { AppError, actionError } from "@/server/errors";
import { executePreparation, queuePreparation, retirePreparation, type PreparationOperation } from "@/server/setup/jobs";
import { requestDeprovision, requestFleetSync } from "@/server/workforce/provisioning";

export async function prepareClientAction(orgId: string, operation: PreparationOperation, idempotencyKey: string) {
  try {
    z.string().uuid().parse(orgId);
    const user = await requireFreshUserOrThrow();
    const jobId = await queuePreparation(user, orgId, { operation, idempotencyKey });
    await executePreparation(user, orgId, jobId);
    revalidatePath(`/admin/clients/${orgId}/setup`);
    revalidatePath(`/admin/clients/${orgId}/provisioning`);
    return { ok: true as const };
  } catch (err) { return actionError(err); }
}
export async function retryPreparationAction(orgId: string, jobId: string) {
  try {
    z.string().uuid().parse(orgId);
    const user = await requireFreshUserOrThrow();
    await executePreparation(user, orgId, jobId);
    revalidatePath(`/admin/clients/${orgId}/setup`);
    revalidatePath(`/admin/clients/${orgId}/provisioning`);
    return { ok: true as const };
  } catch (err) { return actionError(err); }
}

export async function retirePreparationAction(orgId: string, jobId: string, input: { reason: string; supersededBy?: string }) {
  try {
    z.string().uuid().parse(orgId);
    const user = await requireFreshUserOrThrow();
    await retirePreparation(user, orgId, jobId, input);
    revalidatePath(`/admin/clients/${orgId}/setup`);
    revalidatePath(`/admin/clients/${orgId}/provisioning`);
    revalidatePath(`/admin/clients/${orgId}/activation`);
    return { ok: true as const };
  } catch (err) { return actionError(err); }
}

/**
 * Contains ONE client employee's runtime profile (its key is replaced and its tools are switched off; nothing is deleted). A Super Admin only, with a reason: the permission is checked
 * here on the server and again by requestDeprovision, which also refuses an agency's or a demo's employee and writes nothing then.
 */
export async function requestDeprovisionAction(orgId: string, agentId: string, reason: string) {
  try {
    z.string().uuid().parse(orgId);
    z.string().uuid().parse(agentId);
    const user = await requireFreshUserOrThrow();
    if (user.platformRole !== "agency_super_admin") throw new AppError("forbidden", "Only a Super Admin can contain an employee's runtime profile.");
    const result = await withSystem((db) => requestDeprovision(db, { orgId, agentId, actorUserId: user.id, reason }));
    revalidatePath(`/admin/clients/${orgId}`);
    revalidatePath(`/admin/clients/${orgId}/provisioning`);
    return { ok: true as const, ...result };
  } catch (err) { return actionError(err); }
}

/** Asks the restricted worker to synchronize every provisioned client employee's profile again. A Super Admin only, with a reason; bounded and safe to repeat. */
export async function requestFleetSyncAction(reason: string) {
  try {
    const user = await requireFreshUserOrThrow();
    if (user.platformRole !== "agency_super_admin") throw new AppError("forbidden", "Only a Super Admin can synchronize the client runtime.");
    const gatewayId = env().HERMES_PROVISIONER_GATEWAY_ID;
    if (!gatewayId) throw new AppError("conflict", "The client runtime is not set up in this deployment.");
    const result = await withSystem((db) => requestFleetSync(db, gatewayId, user.id, reason));
    revalidatePath("/admin/health");
    return { ok: true as const, ...result };
  } catch (err) { return actionError(err); }
}
