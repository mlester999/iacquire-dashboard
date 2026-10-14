"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireFreshUserOrThrow } from "@/server/auth/session";
import { actionError } from "@/server/errors";
import { reorderTemplateTasks, updateTemplateTask, type templateTaskSchema } from "@/server/setup/templates";

export async function saveTemplateTaskAction(taskId: string, data: z.input<typeof templateTaskSchema>) {
  try { z.string().uuid().parse(taskId); await updateTemplateTask(await requireFreshUserOrThrow(), taskId, data); revalidatePath("/admin/setup-templates"); return { ok: true as const }; }
  catch (error) { if (error instanceof z.ZodError) return { ok: false as const, error: error.issues[0]?.message ?? "Check the fields." }; return actionError(error); }
}

export async function reorderTemplateAction(templateId: string, ids: string[]) {
  try { z.string().uuid().parse(templateId); await reorderTemplateTasks(await requireFreshUserOrThrow(), templateId, ids); revalidatePath("/admin/setup-templates"); return { ok: true as const }; }
  catch (error) { if (error instanceof z.ZodError) return { ok: false as const, error: "Check the task order." }; return actionError(error); }
}
