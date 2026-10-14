"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireFreshUserOrThrow } from "@/server/auth/session";
import { actionError } from "@/server/errors";
import { executePreparation, queuePreparation, retirePreparation, type PreparationOperation } from "@/server/setup/jobs";

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
