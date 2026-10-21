"use server";

import { revalidatePath } from "next/cache";
import { guard } from "@/server/action-guard";
import { AppError } from "@/server/errors";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import {
  getOnboardingReview,
  readOnboardingWebsite,
  saveOnboardingStep,
  submitOnboarding,
  suggestOnboardingAnswer,
  type SaveStepInput,
} from "@/server/onboarding/service";
import { deleteAsset, setAssetAlt, setAssetVariant } from "@/server/assets/service";
import type { AssistanceOptions } from "@/lib/onboarding/assistance";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function saveOnboardingStepAction(input: SaveStepInput) {
  return guard(async () => {
    const ctx = await requireOrgContextOrThrow("workspace.manage_profile");
    return saveOnboardingStep(ctx, input);
  });
}

export async function suggestOnboardingAnswerAction(questionId: string, options?: AssistanceOptions) {
  return guard(async () => {
    const ctx = await requireOrgContextOrThrow("workspace.manage_profile");
    return suggestOnboardingAnswer(ctx, String(questionId), options);
  });
}

export async function readOnboardingWebsiteAction(url: string) {
  return guard(async () => {
    const ctx = await requireOrgContextOrThrow("workspace.manage_profile");
    return readOnboardingWebsite(ctx, String(url));
  });
}

export async function getOnboardingReviewAction() {
  return guard(async () => {
    const ctx = await requireOrgContextOrThrow("workspace.manage_profile");
    return getOnboardingReview(ctx);
  });
}

export async function submitOnboardingAction() {
  return guard(async () => {
    const ctx = await requireOrgContextOrThrow("workspace.manage_profile");
    const result = await submitOnboarding(ctx);
    revalidatePath("/", "layout");
    return result;
  });
}

export async function deleteAssetAction(id: string) {
  return guard(async () => {
    if (!uuid.test(id)) throw new AppError("invalid_input", "Choose an image.");
    const ctx = await requireOrgContextOrThrow("workspace.manage_profile");
    await deleteAsset(ctx, id);
    return { id };
  });
}

export async function setAssetVariantAction(id: string, variant: string) {
  return guard(async () => {
    if (!uuid.test(id) || (variant !== "original" && variant !== "processed")) throw new AppError("invalid_input", "Choose an image and version.");
    const ctx = await requireOrgContextOrThrow("workspace.manage_profile");
    await setAssetVariant(ctx, id, variant);
    return { id, variant };
  });
}

export async function setAssetAltAction(id: string, altText: string) {
  return guard(async () => {
    if (!uuid.test(id)) throw new AppError("invalid_input", "Choose an image.");
    const ctx = await requireOrgContextOrThrow("workspace.manage_profile");
    await setAssetAlt(ctx, id, String(altText));
    return { id };
  });
}
