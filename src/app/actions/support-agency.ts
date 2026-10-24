"use server";

import { revalidatePath } from "next/cache";
import type { z } from "zod";
import { requireAgencyOrThrow } from "@/server/tenancy/context";
import {
  agencyPostMessage, assignRequest, changePriority, changeRequestStatus, clearEscalation, escalateRequest, linkRequests, markAgencyRead, mergeRequest, setFeedbackStage,
  type agencyMessageSchema,
} from "@/server/support/agency";
import { adviseEscalation, draftReply, missingInformation, summarizeRequest } from "@/server/support/ai";
import { findSimilarForAgency } from "@/server/support/duplicates";
import { classifyChangeRequest } from "@/server/support/change";
import { setNotificationRule, updateSupportSettings, type SupportSettingsPatch } from "@/server/support/settings";
import { supportAnalytics, type AnalyticsFilters } from "@/server/support/analytics";
import { actionError } from "@/server/errors";
import type { FeedbackStage, TicketPriority, TicketStatus } from "@/lib/support/lifecycle";

// Server actions for the iAcquire team's Requests Management Center. Each one starts from the signed-in agency account and hands off to a
// service that re-reads that person's role, client scope and individual permissions from the database for this exact request, so a
// forged request id, client id or role cannot reach anything the person could not reach from the screen.

function refresh(ticketId?: string) {
  revalidatePath("/admin/support");
  if (ticketId) revalidatePath(`/admin/support/${ticketId}`);
}

async function run<T>(ticketId: string | undefined, fn: (user: Awaited<ReturnType<typeof requireAgencyOrThrow>>) => Promise<T>) {
  try {
    const user = await requireAgencyOrThrow();
    const data = await fn(user);
    refresh(ticketId);
    return { ok: true as const, data };
  } catch (err) {
    return actionError(err);
  }
}

export async function agencyMessageAction(ticketId: string, input: z.input<typeof agencyMessageSchema>) {
  return run(ticketId, (user) => agencyPostMessage(user, ticketId, input));
}
/** `clientNote` is shown to the client; the screen sends none today, and a private remark must go in an internal note instead. */
export async function changeStatusAction(ticketId: string, status: TicketStatus, clientNote?: string) {
  return run(ticketId, (user) => changeRequestStatus(user, ticketId, status, clientNote));
}
export async function setFeedbackStageAction(ticketId: string, stage: FeedbackStage, note?: string) {
  return run(ticketId, (user) => setFeedbackStage(user, ticketId, stage, note));
}
export async function changePriorityAction(ticketId: string, priority: TicketPriority, reason?: string) {
  return run(ticketId, (user) => changePriority(user, ticketId, priority, reason));
}
export async function assignAction(ticketId: string, assigneeId: string | null) {
  return run(ticketId, (user) => assignRequest(user, ticketId, assigneeId));
}
export async function escalateAction(ticketId: string, reason: string) {
  return run(ticketId, (user) => escalateRequest(user, ticketId, reason));
}
/** The team records what kind of change a change request is. Never shown to the client. */
export async function classifyChangeAction(ticketId: string, classification: string, note?: string | null) {
  return run(ticketId, (user) => classifyChangeRequest(user, ticketId, { classification, note }));
}
export async function clearEscalationAction(ticketId: string) {
  return run(ticketId, (user) => clearEscalation(user, ticketId));
}
export async function linkAction(ticketId: string, relatedId: string, kind: "related" | "duplicate_of") {
  return run(ticketId, (user) => linkRequests(user, ticketId, relatedId, kind));
}
export async function mergeAction(ticketId: string, intoId: string) {
  return run(ticketId, (user) => mergeRequest(user, ticketId, intoId));
}
export async function markReadAction(ticketId: string) {
  try {
    const user = await requireAgencyOrThrow();
    await markAgencyRead(user, ticketId);
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

// AI help and advice. Everything returned is shown to the person to read; nothing is sent or changed by it.
export async function summarizeAction(ticketId: string) {
  return run(ticketId, (user) => summarizeRequest(user, ticketId));
}
export async function draftReplyAction(ticketId: string, guidance?: string) {
  return run(undefined, (user) => draftReply(user, ticketId, { guidance }));
}
export async function missingInfoAction(ticketId: string) {
  return run(undefined, (user) => missingInformation(user, ticketId));
}
export async function adviseAction(ticketId: string) {
  return run(undefined, (user) => adviseEscalation(user, ticketId));
}
export async function similarAction(ticketId: string) {
  return run(undefined, (user) => findSimilarForAgency(user, ticketId));
}

export async function updateSettingsAction(patch: SupportSettingsPatch, expectedRevision: number) {
  try {
    const user = await requireAgencyOrThrow();
    const data = await updateSupportSettings(user, patch, expectedRevision);
    revalidatePath("/admin/support/settings");
    revalidatePath("/support");
    return { ok: true as const, data };
  } catch (err) {
    return actionError(err);
  }
}
export async function setNotificationRuleAction(event: string, mode: string) {
  try {
    const user = await requireAgencyOrThrow();
    await setNotificationRule(user, event, mode);
    revalidatePath("/admin/support/settings");
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}
export async function analyticsAction(filters: AnalyticsFilters) {
  return run(undefined, (user) => supportAnalytics(user, filters));
}
