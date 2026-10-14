"use server";

import { revalidatePath } from "next/cache";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { saveKnowledgeSection } from "@/server/knowledge/service";
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
