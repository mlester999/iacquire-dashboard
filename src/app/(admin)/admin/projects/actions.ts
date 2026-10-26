"use server";

import { revalidatePath } from "next/cache";
import { requireAgencyOrThrow } from "@/server/tenancy/context";
import { guard } from "@/server/action-guard";
import {
  addProgressUpdate, assignProject, completeReviewTask, deleteMilestone, postAgencyMessage, recordHandover, saveInternalNotes, saveMilestone,
  saveQuoteDraft, sendQuote, setMilestoneStatus, setProjectTerms, updateProjectStatus, withdrawQuote, type ProjectTermsInput, type QuoteDraftInput,
} from "@/server/projects/agency";
import {
  applyInScopeRevision, classifyChangeOrder, declineChangeOrder, markChangeApplied, pullBackChangeQuote, requestChangeInfo, saveChangeInternalNotes, sendChangeQuote, startChangeReview,
} from "@/server/projects/change-orders";
import { addPrerequisite, removePrerequisite, satisfyPrerequisite, waivePrerequisite, type PrerequisiteInput } from "@/server/projects/prerequisites";
import type { ChangeQuoteInput } from "@/lib/project-change-orders";
import type { MilestoneStatus, ProjectStatus } from "@/lib/projects";

const refresh = (id: string) => {
  revalidatePath(`/admin/projects/${id}`);
  revalidatePath("/admin/projects");
  revalidatePath(`/projects/${id}`);
};

export async function setStatusAction(id: string, change: { status?: ProjectStatus; resume?: boolean; reason?: string }) {
  return guard(async () => {
    await updateProjectStatus(await requireAgencyOrThrow(), id, change);
    refresh(id);
  });
}
export async function assignAction(id: string, assigneeId: string | null) {
  return guard(async () => {
    await assignProject(await requireAgencyOrThrow(), id, assigneeId);
    refresh(id);
  });
}
export async function saveNotesAction(id: string, notes: string) {
  return guard(async () => {
    await saveInternalNotes(await requireAgencyOrThrow(), id, notes);
    refresh(id);
  });
}
export async function agencyMessageAction(id: string, body: string, opts: { internal?: boolean; infoRequest?: boolean }) {
  return guard(async () => {
    await postAgencyMessage(await requireAgencyOrThrow(), id, body, opts);
    refresh(id);
  });
}
export async function progressUpdateAction(id: string, body: string, visibility: "client" | "internal") {
  return guard(async () => {
    await addProgressUpdate(await requireAgencyOrThrow(), id, body, visibility);
    refresh(id);
  });
}
export async function saveMilestoneAction(id: string, input: Parameters<typeof saveMilestone>[2]) {
  return guard(async () => {
    await saveMilestone(await requireAgencyOrThrow(), id, input);
    refresh(id);
  });
}
export async function deleteMilestoneAction(id: string, milestoneId: string) {
  return guard(async () => {
    await deleteMilestone(await requireAgencyOrThrow(), id, milestoneId);
    refresh(id);
  });
}
export async function milestoneStatusAction(id: string, milestoneId: string, status: MilestoneStatus) {
  return guard(async () => {
    await setMilestoneStatus(await requireAgencyOrThrow(), id, milestoneId, status);
    refresh(id);
  });
}
export async function saveQuoteAction(id: string, input: QuoteDraftInput) {
  return guard(async () => {
    const r = await saveQuoteDraft(await requireAgencyOrThrow(), id, input);
    refresh(id);
    return r;
  });
}
export async function sendQuoteAction(id: string, quoteId: string) {
  return guard(async () => {
    await sendQuote(await requireAgencyOrThrow(), id, quoteId);
    refresh(id);
  });
}
export async function withdrawQuoteAction(id: string, quoteId: string) {
  return guard(async () => {
    await withdrawQuote(await requireAgencyOrThrow(), id, quoteId);
    refresh(id);
  });
}
export async function handoverAction(id: string, notes: string, terms: ProjectTermsInput = {}) {
  return guard(async () => {
    await recordHandover(await requireAgencyOrThrow(), id, notes, terms);
    refresh(id);
  });
}
export async function projectTermsAction(id: string, terms: ProjectTermsInput) {
  return guard(async () => {
    await setProjectTerms(await requireAgencyOrThrow(), id, terms);
    refresh(id);
  });
}

// The change list: classify, ask, apply a revision, quote, take a quote back, decline, mark made.
export async function startChangeReviewAction(id: string, changeId: string) {
  return guard(async () => {
    await startChangeReview(await requireAgencyOrThrow(), changeId);
    refresh(id);
  });
}
export async function classifyChangeOrderAction(id: string, changeId: string, input: { classification: "in_scope_revision" | "out_of_scope"; internalNotes?: string | null }) {
  return guard(async () => {
    await classifyChangeOrder(await requireAgencyOrThrow(), changeId, input);
    refresh(id);
  });
}
export async function saveChangeNotesAction(id: string, changeId: string, notes: string, expected?: string | null) {
  return guard(async () => {
    await saveChangeInternalNotes(await requireAgencyOrThrow(), changeId, notes, expected);
    refresh(id);
  });
}
export async function requestChangeInfoAction(id: string, changeId: string, body: string) {
  return guard(async () => {
    await requestChangeInfo(await requireAgencyOrThrow(), changeId, body);
    refresh(id);
  });
}
export async function applyRevisionAction(id: string, changeId: string, note?: string) {
  return guard(async () => {
    await applyInScopeRevision(await requireAgencyOrThrow(), changeId, note);
    refresh(id);
  });
}
export async function sendChangeQuoteAction(id: string, changeId: string, input: ChangeQuoteInput) {
  return guard(async () => {
    const r = await sendChangeQuote(await requireAgencyOrThrow(), changeId, input);
    refresh(id);
    return r;
  });
}
export async function pullBackChangeQuoteAction(id: string, changeId: string) {
  return guard(async () => {
    await pullBackChangeQuote(await requireAgencyOrThrow(), changeId);
    refresh(id);
  });
}
export async function declineChangeOrderAction(id: string, changeId: string, reason: string) {
  return guard(async () => {
    await declineChangeOrder(await requireAgencyOrThrow(), changeId, reason);
    refresh(id);
  });
}
export async function markChangeAppliedAction(id: string, changeId: string, note?: string) {
  return guard(async () => {
    await markChangeApplied(await requireAgencyOrThrow(), changeId, note);
    refresh(id);
  });
}

// What a person confirms before work starts or before handover.
export async function addPrerequisiteAction(id: string, input: PrerequisiteInput) {
  return guard(async () => {
    const r = await addPrerequisite(await requireAgencyOrThrow(), id, input);
    refresh(id);
    return r;
  });
}
export async function satisfyPrerequisiteAction(id: string, prerequisiteId: string, evidence: string) {
  return guard(async () => {
    await satisfyPrerequisite(await requireAgencyOrThrow(), prerequisiteId, evidence);
    refresh(id);
  });
}
export async function waivePrerequisiteAction(id: string, prerequisiteId: string, reason: string) {
  return guard(async () => {
    await waivePrerequisite(await requireAgencyOrThrow(), prerequisiteId, reason);
    refresh(id);
  });
}
export async function removePrerequisiteAction(id: string, prerequisiteId: string) {
  return guard(async () => {
    await removePrerequisite(await requireAgencyOrThrow(), prerequisiteId);
    refresh(id);
  });
}
export async function completeTaskAction(id: string, taskId: string) {
  return guard(async () => {
    await completeReviewTask(await requireAgencyOrThrow(), taskId);
    refresh(id);
  });
}
