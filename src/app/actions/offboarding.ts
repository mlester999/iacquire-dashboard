"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { actionError } from "@/server/errors";
import { cancelOffboarding, requestOffboarding } from "@/server/offboarding/service";

function fail(err: unknown) {
  if (err instanceof z.ZodError) return { ok: false as const, error: err.issues[0]?.message ?? "Check the form.", code: "invalid_input" as const };
  return actionError(err);
}

/** The owner asks to close the workspace. They must type its name, and nothing is switched off by asking. */
export async function requestOffboardingAction(input: { confirmName: string; reason?: string }) {
  try {
    const ctx = await requireOrgContextOrThrow("offboarding.request");
    await requestOffboarding(ctx, { confirmName: z.string().max(200).parse(input.confirmName), reason: z.string().max(500).optional().parse(input.reason) });
    revalidatePath("/settings/data");
    return { ok: true as const };
  } catch (err) {
    return fail(err);
  }
}

/** The owner changes their mind, while nothing has been shut down yet. */
export async function cancelOffboardingOwnerAction(note?: string) {
  try {
    const ctx = await requireOrgContextOrThrow("offboarding.request");
    await cancelOffboarding({ user: { id: ctx.user.id, platformRole: "none" }, orgId: ctx.org.orgId, viaOwner: true }, z.string().max(300).optional().parse(note) ?? "");
    revalidatePath("/settings/data");
    return { ok: true as const };
  } catch (err) {
    return fail(err);
  }
}
