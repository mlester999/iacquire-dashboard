"use server";

import { revalidatePath } from "next/cache";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { createResearchRequest, requestCrmImport, retryResearchRequest, reviewLeads, saveTargeting } from "@/server/leads/service";
import { actionError, AppError } from "@/server/errors";
import { saveResearchSourcePolicy, type ResearchSourceKey } from "@/server/leads/research-source-policy";

export type ResearchSourcePolicyActionState = {
  status: "idle" | "success" | "error";
  message: string;
};

function formText(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function formNumber(formData: FormData, key: string): number {
  const raw = formText(formData, key);
  const value = Number(raw);
  if (!raw || !Number.isFinite(value)) throw new AppError("invalid_input", "Enter a number for each request and spend limit.");
  return value;
}

function formList(formData: FormData, key: string): string[] {
  return formText(formData, key).split(/[\n,]/).map((value) => value.trim()).filter(Boolean);
}

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

/** Saves only tenant-scoped source settings. It never starts a research job. */
export async function saveResearchSourcePolicyAction(
  _previousState: ResearchSourcePolicyActionState,
  formData: FormData,
): Promise<ResearchSourcePolicyActionState> {
  try {
    const ctx = await requireOrgContextOrThrow("leads.research");
    const sourceValue = formText(formData, "source");
    if (sourceValue !== "openstreetmap" && sourceValue !== "company_website") {
      throw new AppError("invalid_input", "Choose a supported research source.");
    }
    const source: ResearchSourceKey = sourceValue;
    const settings = {
      enabled: formData.get("enabled") === "true",
      providerFeeUsdPerRequest: source === "company_website" ? 0 : formNumber(formData, "providerFeeUsdPerRequest"),
      perJobRequestCap: formNumber(formData, "perJobRequestCap"),
      perDayRequestCap: formNumber(formData, "perDayRequestCap"),
      perJobSpendCapUsd: formNumber(formData, "perJobSpendCapUsd"),
      perDaySpendCapUsd: formNumber(formData, "perDaySpendCapUsd"),
      activationAcknowledged: formData.get("activationAcknowledged") === "true",
    };
    const sourceConfig = source === "openstreetmap"
      ? {
          endpoint: formText(formData, "endpoint"),
          approvedEndpointHosts: formList(formData, "approvedEndpointHosts"),
          userAgent: formText(formData, "userAgent"),
          bounds: {
            south: formNumber(formData, "boundsSouth"),
            west: formNumber(formData, "boundsWest"),
            north: formNumber(formData, "boundsNorth"),
            east: formNumber(formData, "boundsEast"),
          },
          maxResults: formNumber(formData, "maxResults"),
          timeoutSeconds: formNumber(formData, "timeoutSeconds"),
        }
      : {
          approvedDomains: formList(formData, "approvedDomains"),
          maxRequests: formNumber(formData, "maxRequests"),
        };

    await saveResearchSourcePolicy(ctx, source, { ...settings, sourceConfig });
    revalidatePath("/growth-partner");
    return { status: "success", message: "Settings saved. No discovery was started." };
  } catch (err) {
    return { status: "error", message: actionError(err).error };
  }
}
