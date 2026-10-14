"use server";

import { revalidatePath } from "next/cache";
import { requireAgencyOrThrow } from "@/server/tenancy/context";
import { guard } from "@/server/action-guard";
import {
  addProgressUpdate, assignProject, completeReviewTask, deleteMilestone, postAgencyMessage, recordHandover, saveInternalNotes, saveMilestone,
  saveQuoteDraft, sendQuote, setMilestoneStatus, updateProjectStatus, withdrawQuote, type QuoteDraftInput,
} from "@/server/projects/agency";
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
export async function handoverAction(id: string, notes: string) {
  return guard(async () => {
    await recordHandover(await requireAgencyOrThrow(), id, notes);
    refresh(id);
  });
}
export async function completeTaskAction(id: string, taskId: string) {
  return guard(async () => {
    await completeReviewTask(await requireAgencyOrThrow(), taskId);
    refresh(id);
  });
}
