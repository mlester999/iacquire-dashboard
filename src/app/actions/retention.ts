"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { actionError } from "@/server/errors";
import { markCustomer, saveProgram, searchNonCustomers, setProgramEnabled, setRetentionPaused } from "@/server/retention/service";

const uuid = z.string().uuid();

function fail(err: unknown) {
  if (err instanceof z.ZodError) return { ok: false as const, error: err.issues[0]?.message ?? "Check the form.", code: "invalid_input" as const };
  return actionError(err);
}

const saveInput = z.object({
  kind: z.string().max(40),
  steps: z.array(z.object({ key: z.string().max(40), delayDays: z.number().int(), body: z.string().max(1000) })).max(8),
  businessHoursOnly: z.boolean().optional(),
  inactiveDays: z.number().int().nullable().optional(),
});

/** Saves new wording or timing. The result lists anything wrong with it in plain words; a saved edit withdraws the owner's approval. */
export async function saveProgramAction(input: z.input<typeof saveInput>) {
  try {
    const ctx = await requireOrgContextOrThrow("retention.edit");
    const d = saveInput.parse(input);
    const res = await saveProgram(ctx, d.kind, { steps: d.steps, businessHoursOnly: d.businessHoursOnly, inactiveDays: d.inactiveDays });
    revalidatePath("/retention");
    return res.ok ? { ok: true as const } : { ok: false as const, error: res.issues[0]?.message ?? "Check the wording.", code: "invalid_input" as const, issues: res.issues };
  } catch (err) {
    return fail(err);
  }
}

export async function setProgramEnabledAction(kind: string, enabled: boolean) {
  try {
    const ctx = await requireOrgContextOrThrow("retention.view");
    await setProgramEnabled(ctx, z.string().max(40).parse(kind), z.boolean().parse(enabled));
    revalidatePath("/retention");
    return { ok: true as const };
  } catch (err) {
    return fail(err);
  }
}

export async function setRetentionPausedAction(contactId: string, paused: boolean, reason?: string | null) {
  try {
    const ctx = await requireOrgContextOrThrow("retention.view");
    await setRetentionPaused(ctx, uuid.parse(contactId), z.boolean().parse(paused), z.string().max(400).nullish().parse(reason));
    revalidatePath("/retention");
    return { ok: true as const };
  } catch (err) {
    return fail(err);
  }
}

export async function searchCustomersAction(query: string) {
  try {
    const ctx = await requireOrgContextOrThrow("retention.view");
    return { ok: true as const, data: await searchNonCustomers(ctx, z.string().max(80).parse(query)) };
  } catch (err) {
    return fail(err);
  }
}

export async function markCustomerAction(contactId: string) {
  try {
    const ctx = await requireOrgContextOrThrow("retention.view");
    await markCustomer(ctx, uuid.parse(contactId));
    revalidatePath("/retention");
    return { ok: true as const };
  } catch (err) {
    return fail(err);
  }
}
