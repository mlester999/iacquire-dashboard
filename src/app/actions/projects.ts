"use server";

import { revalidatePath } from "next/cache";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { requestMeta } from "@/server/auth/session";
import { hashIp } from "@/server/security/crypto";
import { guard } from "@/server/action-guard";
import { createProjectRequest, decideQuote, markQuoteViewed, postClientMessage, respondToMilestone, type ProjectRequestInput, type QuoteDecision } from "@/server/projects/client";
import {
  createMaintenanceRequest, requestMaintenanceCancellation, requestMaintenanceEnrollment, maintenanceRequestSchema,
} from "@/server/maintenance/service";
import type { z } from "zod";

export async function createProjectRequestAction(input: ProjectRequestInput) {
  return guard(async () => {
    const ctx = await requireOrgContextOrThrow("projects.request");
    const created = await createProjectRequest(ctx, input);
    revalidatePath("/projects");
    return created;
  });
}

export async function postProjectMessageAction(requestId: string, body: string) {
  return guard(async () => {
    const ctx = await requireOrgContextOrThrow("projects.request");
    await postClientMessage(ctx, requestId, body);
    revalidatePath(`/projects/${requestId}`);
  });
}

export async function respondToMilestoneAction(requestId: string, milestoneId: string, decision: "approve" | "request_changes", note?: string) {
  return guard(async () => {
    const ctx = await requireOrgContextOrThrow("projects.request");
    await respondToMilestone(ctx, milestoneId, decision, note);
    revalidatePath(`/projects/${requestId}`);
  });
}

export async function markQuoteViewedAction(requestId: string, quoteId: string) {
  return guard(async () => {
    const ctx = await requireOrgContextOrThrow("projects.view");
    await markQuoteViewed(ctx, quoteId);
    revalidatePath(`/projects/${requestId}`);
  });
}

export async function decideQuoteAction(requestId: string, quoteId: string, decision: QuoteDecision, note?: string) {
  return guard(async () => {
    const ctx = await requireOrgContextOrThrow("projects.view");
    const meta = await requestMeta();
    const result = await decideQuote(ctx, quoteId, decision, note, hashIp(meta.ip));
    revalidatePath(`/projects/${requestId}`);
    revalidatePath("/projects");
    return result;
  });
}

export async function enrollMaintenanceAction(input: { acceptTerms: boolean; note?: string }) {
  return guard(async () => {
    const ctx = await requireOrgContextOrThrow("maintenance.view");
    await requestMaintenanceEnrollment(ctx, input);
    revalidatePath("/maintenance");
  });
}

export async function cancelMaintenanceAction(note?: string) {
  return guard(async () => {
    const ctx = await requireOrgContextOrThrow("maintenance.view");
    await requestMaintenanceCancellation(ctx, note);
    revalidatePath("/maintenance");
  });
}

export async function createMaintenanceRequestAction(input: z.input<typeof maintenanceRequestSchema>) {
  return guard(async () => {
    const ctx = await requireOrgContextOrThrow("maintenance.view");
    const r = await createMaintenanceRequest(ctx, input);
    revalidatePath("/maintenance");
    revalidatePath("/support");
    return r;
  });
}
