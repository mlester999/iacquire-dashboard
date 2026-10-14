"use server";

import { revalidatePath } from "next/cache";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { createResearchRequest, requestCrmImport, retryResearchRequest, reviewLeads, saveTargeting } from "@/server/leads/service";
import { actionError, AppError } from "@/server/errors";

export async function saveTargetingAction(input: unknown) {
  try {
    const ctx = await requireOrgContextOrThrow("leads.research");
    await saveTargeting(ctx, input);
    revalidatePath("/leads");
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function createResearchAction(prompt: string, campaignType: "business" | "influencer") {
  try {
    const ctx = await requireOrgContextOrThrow("leads.research");
    if (campaignType !== "business" && campaignType !== "influencer") throw new AppError("invalid_input", "Unknown campaign type.");
    const res = await createResearchRequest(ctx, { prompt, campaignType });
    revalidatePath("/leads");
    return { ok: true as const, data: res };
  } catch (err) {
    return actionError(err);
  }
}

export async function retryResearchAction(requestId: string) {
  try {
    const ctx = await requireOrgContextOrThrow("leads.research");
    await retryResearchRequest(ctx, requestId);
    revalidatePath("/leads");
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function reviewLeadsAction(ids: string[], decision: "approve" | "reject") {
  try {
    const ctx = await requireOrgContextOrThrow("leads.review");
    const n = await reviewLeads(ctx, ids, decision);
    revalidatePath("/leads");
    return { ok: true as const, data: { updated: n } };
  } catch (err) {
    return actionError(err);
  }
}

export async function requestCrmImportAction(ids: string[]) {
  try {
    const ctx = await requireOrgContextOrThrow("leads.review");
    const id = await requestCrmImport(ctx, ids);
    revalidatePath("/leads");
    revalidatePath("/approvals");
    return { ok: true as const, data: { approvalId: id } };
  } catch (err) {
    return actionError(err);
  }
}
