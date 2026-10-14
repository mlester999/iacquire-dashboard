"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAgencyOrThrow } from "@/server/tenancy/context";
import { requireFreshUserOrThrow } from "@/server/auth/session";
import { actionError } from "@/server/errors";
import type { SessionUser } from "@/server/auth/service";
import {
  activateSetup,
  addTaskAttachment,
  addTaskNote,
  createCustomTask,
  markReadyForReview,
  removeTaskAttachment,
  reorderTasks,
  requestClientAction,
  sendBackToSetup,
  setResponsibleStaff,
  setServices,
  setTaskDependencies,
  setTaskHidden,
  updateTaskDetails,
  updateTaskStatus,
  type activationSchema,
  type attachmentSchema,
  type customTaskSchema,
  type detailsSchema,
  type noteSchema,
  type requestSchema,
  type statusSchema,
} from "@/server/setup/agency";
import { attestTask, runAllChecks, verifyTask, type attestSchema } from "@/server/setup/automation";
import type { Section } from "@/lib/setup";

const uuid = z.string().uuid();

/** Every setup action runs as the signed-in agency user; the service re-checks access to the specific client. */
async function run<T>(orgId: string, fn: (admin: SessionUser) => Promise<T>) {
  try {
    if (!uuid.safeParse(orgId).success) return { ok: false as const, error: "Client not found.", code: "not_found" as const };
    const admin = await requireAgencyOrThrow();
    const data = await fn(admin);
    revalidatePath(`/admin/clients/${orgId}/setup`);
    revalidatePath("/admin/clients");
    return { ok: true as const, data };
  } catch (err) {
    if (err instanceof z.ZodError) return { ok: false as const, error: err.issues[0]?.message ?? "Check the form.", code: "invalid_input" as const };
    return actionError(err);
  }
}

export const setTaskStatusAction = async (orgId: string, taskId: string, input: z.input<typeof statusSchema>) =>
  run(orgId, async (a) => ({ revision: (await updateTaskStatus(a, orgId, taskId, input)).revision }));

export const updateTaskDetailsAction = async (orgId: string, taskId: string, input: z.input<typeof detailsSchema>) =>
  run(orgId, async (a) => ({ revision: (await updateTaskDetails(a, orgId, taskId, input)).revision }));

export const requestClientActionAction = async (orgId: string, taskId: string, input: z.input<typeof requestSchema>) =>
  run(orgId, async (a) => ({ revision: (await requestClientAction(a, orgId, taskId, input)).revision }));

export const addTaskNoteAction = async (orgId: string, taskId: string, input: z.input<typeof noteSchema>) =>
  run(orgId, async (a) => ({ revision: (await addTaskNote(a, orgId, taskId, input)).revision }));

export const createCustomTaskAction = async (orgId: string, input: z.input<typeof customTaskSchema>) =>
  run(orgId, async (a) => {
    const r = await createCustomTask(a, orgId, input);
    return { revision: r.revision, taskId: r.result.taskId };
  });

export const reorderTasksAction = async (orgId: string, section: Section, orderedIds: string[]) =>
  run(orgId, async (a) => ({ revision: (await reorderTasks(a, orgId, section === "client" ? "client" : "agency", orderedIds)).revision }));

export const setTaskHiddenAction = async (orgId: string, taskId: string, hidden: boolean) =>
  run(orgId, async (a) => ({ revision: (await setTaskHidden(a, orgId, taskId, hidden)).revision }));

export const setTaskDependenciesAction = async (orgId: string, taskId: string, dependsOn: string[]) =>
  run(orgId, async (a) => ({ revision: (await setTaskDependencies(a, orgId, taskId, dependsOn)).revision }));

export const addTaskAttachmentAction = async (orgId: string, taskId: string, input: z.input<typeof attachmentSchema>) =>
  run(orgId, async (a) => ({ revision: (await addTaskAttachment(a, orgId, taskId, input)).revision }));

export const removeTaskAttachmentAction = async (orgId: string, attachmentId: string) =>
  run(orgId, async (a) => ({ revision: (await removeTaskAttachment(a, orgId, attachmentId)).revision }));

export const setServicesAction = async (orgId: string, services: string[]) => run(orgId, async (a) => ({ revision: (await setServices(a, orgId, services)).revision }));

export const setResponsibleStaffAction = async (orgId: string, userId: string | null) =>
  run(orgId, async (a) => ({ revision: (await setResponsibleStaff(a, orgId, userId)).revision }));

export const verifyTaskAction = async (orgId: string, taskId: string) => run(orgId, (a) => verifyTask(a, orgId, taskId));

export const attestTaskAction = async (orgId: string, taskId: string, input: z.input<typeof attestSchema>) =>
  run(orgId, async (a) => ({ revision: (await attestTask(a, orgId, taskId, input)).revision }));

export const runAllChecksAction = async (orgId: string) =>
  run(orgId, async (a) => {
    const s = await runAllChecks(a, orgId);
    return { passed: s.ran.filter((r) => r.status === "verified").length, failed: s.ran.filter((r) => r.status === "failed").length, total: s.ran.length, completedSteps: s.completedSteps };
  });

export const markReadyForReviewAction = async (orgId: string) => run(orgId, async (a) => ({ revision: (await markReadyForReview(a, orgId)).revision }));

export const sendBackToSetupAction = async (orgId: string, reason: string) => run(orgId, async (a) => ({ revision: (await sendBackToSetup(a, orgId, reason)).revision }));

export const activateSetupAction = async (orgId: string, input: z.input<typeof activationSchema>) =>
  run(orgId, async () => ({ revision: (await activateSetup(await requireFreshUserOrThrow(), orgId, input)).revision }));
