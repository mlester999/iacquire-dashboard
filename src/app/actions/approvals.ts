"use server";

import { revalidatePath } from "next/cache";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { decideApproval, getApprovalEvents, type Decision } from "@/server/approvals/service";
import { actionError, AppError } from "@/server/errors";

export async function decideApprovalAction(approvalId: string, decision: Decision, note?: string) {
  try {
    if (!["approve", "reject", "request_changes"].includes(decision)) throw new AppError("invalid_input", "Unknown decision.");
    const ctx = await requireOrgContextOrThrow("approvals.view");
    const { outcome } = await decideApproval(ctx, approvalId, decision, note);
    revalidatePath("/approvals");
    revalidatePath("/overview");
    return { ok: true as const, data: { outcome } };
  } catch (err) {
    return actionError(err);
  }
}

export async function approvalEventsAction(approvalId: string) {
  try {
    const ctx = await requireOrgContextOrThrow("approvals.view");
    const events = await getApprovalEvents(ctx, approvalId);
    return { ok: true as const, data: events.map((e) => ({ ...e, created_at: new Date(e.created_at).toISOString() })) };
  } catch (err) {
    return actionError(err);
  }
}
