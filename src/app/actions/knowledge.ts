"use server";

import { revalidatePath } from "next/cache";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { listKnowledgeRevisions, restoreKnowledgeRevision, saveKnowledgeSection } from "@/server/knowledge/service";
import { actionError } from "@/server/errors";

export async function saveKnowledgeAction(section: string, content: string) {
  try {
    const ctx = await requireOrgContextOrThrow("knowledge.edit");
    const res = await saveKnowledgeSection(ctx, section, content);
    revalidatePath("/knowledge");
    return { ok: true as const, data: res };
  } catch (err) {
    return actionError(err);
  }
}

export async function loadKnowledgeHistoryAction(section: string) {
  try {
    const ctx = await requireOrgContextOrThrow("knowledge.view");
    return { ok: true as const, data: await listKnowledgeRevisions(ctx, section) };
  } catch (err) {
    return actionError(err);
  }
}

export async function restoreKnowledgeRevisionAction(section: string, revisionId: string) {
  try {
    const ctx = await requireOrgContextOrThrow("knowledge.edit");
    const res = await restoreKnowledgeRevision(ctx, section, revisionId);
    revalidatePath("/knowledge");
    return { ok: true as const, data: { held: res.held } };
  } catch (err) {
    return actionError(err);
  }
}
