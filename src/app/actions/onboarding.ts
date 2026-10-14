"use server";

import { revalidatePath } from "next/cache";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { completeOnboarding, saveOnboardingProgress } from "@/server/onboarding/service";
import { actionError } from "@/server/errors";

export async function saveOnboardingAction(step: number, data: unknown) {
  try {
    const ctx = await requireOrgContextOrThrow("workspace.manage_profile");
    await saveOnboardingProgress(ctx, step, data);
    return { ok: true as const, data: { savedAt: new Date().toISOString() } };
  } catch (err) {
    return actionError(err);
  }
}

export async function completeOnboardingAction() {
  try {
    const ctx = await requireOrgContextOrThrow("workspace.manage_profile");
    const res = await completeOnboarding(ctx);
    revalidatePath("/", "layout");
    return { ok: true as const, data: res };
  } catch (err) {
    return actionError(err);
  }
}
