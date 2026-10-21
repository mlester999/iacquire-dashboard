"use server";

import { revalidatePath } from "next/cache";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { actionError, AppError } from "@/server/errors";
import { dispatchCapabilityJob } from "@/server/workforce/capability-dispatch";
import { deleteSchedule, saveSchedule, setScheduleEnabled } from "@/server/workforce/schedules";
import { deleteTrigger, saveTrigger, setTriggerEnabled } from "@/server/workforce/triggers";
import { createFindingTask } from "@/server/workforce/finding-actions";
import { acknowledgeProactiveReport } from "@/server/workforce/reports";
import { capabilityDefinition } from "@/lib/workforce-capabilities";

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * Starts one reviewed, read-only capability from the AI Work Board. Lead research is deliberately
 * not startable here because it needs a target, location and quantity from the person first.
 */
export async function startReviewAction(capability: string) {
  try {
    const ctx = await requireOrgContextOrThrow("agents.use");
    const definition = capabilityDefinition(capability);
    if (!definition || !definition.workBoardAction) throw new AppError("invalid_input", "That review is not available from the work board.");
    const role = definition.allowedRoles[0];
    if (!role) throw new AppError("invalid_input", "That review has no eligible employee role.");
    const result = await dispatchCapabilityJob(ctx, {
      agentRole: role,
      capability: definition.key,
      title: definition.label,
      input: { sinceDays: 7 },
    });
    revalidatePath("/work");
    return { ok: true as const, data: result };
  } catch (err) {
    return actionError(err);
  }
}

export async function saveScheduleAction(capability: string, cadence: string, businessHours?: unknown, payload?: unknown) {
  try {
    const ctx = await requireOrgContextOrThrow("agents.configure");
    const saved = await saveSchedule(ctx, { capability, cadence, enabled: false, businessHours, payload });
    revalidatePath("/work");
    return { ok: true as const, data: saved };
  } catch (err) {
    return actionError(err);
  }
}

export async function setScheduleEnabledAction(scheduleId: string, enabled: boolean) {
  try {
    if (!UUID.test(scheduleId)) throw new AppError("not_found", "Schedule not found.");
    const ctx = await requireOrgContextOrThrow("agents.configure");
    await setScheduleEnabled(ctx, scheduleId, enabled);
    revalidatePath("/work");
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function createFindingTaskAction(jobId: string, findingKey: string) {
  try {
    if (!UUID.test(jobId)) throw new AppError("not_found", "Work job not found.");
    const ctx = await requireOrgContextOrThrow("tasks.manage");
    const result = await createFindingTask(ctx, { jobId, findingKey: findingKey.slice(0, 80) });
    revalidatePath("/work");
    revalidatePath("/crm/tasks");
    return { ok: true as const, data: result };
  } catch (err) {
    return actionError(err);
  }
}

export async function acknowledgeReportAction(reportId: string) {
  try {
    if (!UUID.test(reportId)) throw new AppError("not_found", "Report not found.");
    const ctx = await requireOrgContextOrThrow("activity.view");
    const result = await acknowledgeProactiveReport(ctx, reportId);
    revalidatePath("/work");
    return { ok: true as const, data: result };
  } catch (err) {
    return actionError(err);
  }
}

export async function saveTriggerAction(eventType: string) {
  try {
    const ctx = await requireOrgContextOrThrow("agents.configure");
    const saved = await saveTrigger(ctx, { eventType, enabled: false });
    revalidatePath("/work");
    return { ok: true as const, data: saved };
  } catch (err) {
    return actionError(err);
  }
}

export async function setTriggerEnabledAction(triggerId: string, enabled: boolean) {
  try {
    if (!UUID.test(triggerId)) throw new AppError("not_found", "Trigger not found.");
    const ctx = await requireOrgContextOrThrow("agents.configure");
    await setTriggerEnabled(ctx, triggerId, enabled);
    revalidatePath("/work");
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function deleteTriggerAction(triggerId: string) {
  try {
    if (!UUID.test(triggerId)) throw new AppError("not_found", "Trigger not found.");
    const ctx = await requireOrgContextOrThrow("agents.configure");
    await deleteTrigger(ctx, triggerId);
    revalidatePath("/work");
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function deleteScheduleAction(scheduleId: string) {
  try {
    if (!UUID.test(scheduleId)) throw new AppError("not_found", "Schedule not found.");
    const ctx = await requireOrgContextOrThrow("agents.configure");
    await deleteSchedule(ctx, scheduleId);
    revalidatePath("/work");
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}
