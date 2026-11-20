"use server";

import { revalidatePath } from "next/cache";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { addLeadCompanyEvidence, createResearchRequest, requestCrmImport, retryResearchRequest, reviewLeads, saveTargeting } from "@/server/leads/service";
import { actionError, AppError } from "@/server/errors";
import { saveResearchSourcePolicy, type ResearchSourceKey } from "@/server/leads/research-source-policy";
import { LEAD_LIST_MAX_BYTES } from "@/lib/lead-list-upload";
import { saveLeadListUpload } from "@/server/leads/lead-list-upload";
import { isResearchSourceKey } from "@/lib/lead-research-sources";

export type LeadListUploadActionState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "success"; added: number; duplicates: number; disqualified: number; repeated: boolean };

export async function uploadLeadListAction(
  _previousState: LeadListUploadActionState,
  formData: FormData,
): Promise<LeadListUploadActionState> {
  try {
    const ctx = await requireOrgContextOrThrow("leads.research");
    const file = formData.get("leadList");
    if (!(file instanceof File) || !file.size || file.size > LEAD_LIST_MAX_BYTES) {
      throw new AppError("invalid_input", "Choose a CSV of up to 256 KB.");
    }
    let csv: string;
    try {
      csv = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
    } catch {
      throw new AppError("invalid_input", "Save the file as UTF-8 CSV, then try again.");
    }
    const result = await saveLeadListUpload(ctx, csv, formData.get("authorized") === "yes");
    revalidatePath("/leads");
    revalidatePath("/work");
    revalidatePath("/analytics");
    return { status: "success", added: result.added, duplicates: result.duplicates, disqualified: result.disqualified, repeated: result.repeated };
  } catch (err) {
    return { status: "error", message: actionError(err).error };
  }
}

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
    // The Leads workspace is a capability surface of the single client-facing Partner.
    // It must not route new work through the archived Lead Hunter profile.
    const res = await createResearchRequest(ctx, { prompt, campaignType }, { agentRole: "growth_partner" });
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

export type LeadCompanyEvidenceActionState =
  | { status: "idle" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export async function addLeadCompanyEvidenceAction(
  leadId: string,
  _previousState: LeadCompanyEvidenceActionState,
  formData: FormData,
): Promise<LeadCompanyEvidenceActionState> {
  try {
    const ctx = await requireOrgContextOrThrow("leads.review");
    const { qualificationState } = await addLeadCompanyEvidence(ctx, {
      leadId, url: formText(formData, "companyPage"), summary: formText(formData, "companyEvidence"),
      confirmed: formData.get("firstPartyConfirmed") === "yes",
    });
    revalidatePath("/leads");
    return { status: "success", message: qualificationState === "evidence_backed"
      ? "Company evidence saved. Review and approve the lead when ready."
      : "Company evidence saved. Review the possible duplicate before importing." };
  } catch (err) {
    return { status: "error", message: actionError(err).error };
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
    if (!isResearchSourceKey(sourceValue)) {
      throw new AppError("invalid_input", "Choose a supported research source.");
    }
    const source: ResearchSourceKey = sourceValue;
    if (source === "fsa_directory" && formText(formData, "workspaceId") !== ctx.org.orgId) {
      throw new AppError("conflict", "Your active workspace changed. Reload the page before saving this approval.");
    }
    const settings = {
      enabled: formData.get("enabled") === "true",
      providerFeeUsdPerRequest: source === "openstreetmap" ? formNumber(formData, "providerFeeUsdPerRequest") : 0,
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
      : source === "fsa_directory" ? {
          authorityId: formNumber(formData, "authorityId"),
          authorityCode: formText(formData, "authorityCode"),
          authorityName: formText(formData, "authorityName"),
          nameKeyword: formText(formData, "nameKeyword"),
          maxResults: formNumber(formData, "maxResults"),
          approvalExpiresOn: formText(formData, "approvalExpiresOn"),
          rightsAcknowledged: formData.get("rightsAcknowledged") === "true",
        } : {
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
