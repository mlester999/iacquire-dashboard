"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAgencyOrThrow, requireAgencyOrgAccessOrThrow } from "@/server/tenancy/context";
import { actionError } from "@/server/errors";
import { cancelOffboarding, closeBilling, executeDeletion, planDeletion, requestOffboardingAsAgency, shutdownClient } from "@/server/offboarding/service";
import { dismissReview } from "@/server/inactivity/service";
import { clearPolicy, savePolicy } from "@/server/fairuse/service";
import { FAIR_USE_METRICS } from "@/lib/fair-use";

const uuid = z.string().uuid();

async function run<T>(orgId: string | null, fn: (user: Awaited<ReturnType<typeof requireAgencyOrThrow>>) => Promise<T>) {
  try {
    const user = orgId ? await requireAgencyOrgAccessOrThrow(uuid.parse(orgId)) : await requireAgencyOrThrow();
    const data = await fn(user);
    if (orgId) revalidatePath(`/admin/clients/${orgId}/offboarding`);
    revalidatePath("/admin/usage");
    return { ok: true as const, data };
  } catch (err) {
    if (err instanceof z.ZodError) return { ok: false as const, error: err.issues[0]?.message ?? "Check the form.", code: "invalid_input" as const };
    return actionError(err);
  }
}

// Each service call re-checks that the caller is a super admin; staff can look but not act.
export const startOffboardingAction = async (orgId: string, reason: string) => run(orgId, (u) => requestOffboardingAsAgency(u, uuid.parse(orgId), reason.trim() || null));
export const shutdownAction = async (orgId: string, requestId: string, websitePlan: "keep_until_deletion" | "unpublish_now", retentionDays: number) => run(orgId, (u) => shutdownClient(u, uuid.parse(requestId), { websitePlan, retentionDays }));
export const closeBillingAction = async (orgId: string, requestId: string, note: string) => run(orgId, (u) => closeBilling(u, uuid.parse(requestId), note));
export const planDeletionAction = async (orgId: string, requestId: string) => run(orgId, (u) => planDeletion(u, uuid.parse(requestId)));
export const executeDeletionAction = async (orgId: string, requestId: string, confirmName: string, waiveExportReason?: string) => run(orgId, (u) => executeDeletion(u, uuid.parse(requestId), { confirmName, waiveExportReason }));
export const cancelOffboardingAgencyAction = async (orgId: string, note: string) => run(orgId, (u) => cancelOffboarding({ user: u, orgId: uuid.parse(orgId), viaOwner: false }, note));
export const dismissReviewAction = async (reviewId: string, note: string) => run(null, (u) => dismissReview(u, uuid.parse(reviewId), note));

const policyInput = z.object({ orgId: z.string().uuid().nullable(), metric: z.enum(FAIR_USE_METRICS), warn: z.number().int().min(0).nullable(), limit: z.number().int().min(0).nullable(), enforcement: z.enum(["report_only", "block_new"]), note: z.string().max(500).optional() });
export const saveFairUsePolicyAction = async (input: z.input<typeof policyInput>) => run(null, (u) => savePolicy(u, policyInput.parse(input)));
export const clearFairUsePolicyAction = async (id: string) => run(null, (u) => clearPolicy(u, uuid.parse(id)));
