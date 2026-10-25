"use server";

import { revalidatePath } from "next/cache";
import { actionError } from "@/server/errors";
import { requireWorkforceContextOrThrow } from "@/server/workforce/workspace-access";
import {
  archiveEmployeeKnowledgeEntry,
  assignKnowledgeDocument,
  saveEmployeeKnowledgeEntry,
  unassignKnowledgeDocument,
} from "@/server/workforce/knowledge";
import { reprocessKnowledgeDocument } from "@/server/knowledge/service";

function revalidateEmployee() {
  revalidatePath("/employees");
  revalidatePath("/knowledge");
}

export async function saveEmployeeKnowledgeEntryAction(
  agentId: string,
  input: { id?: string | null; title: string; content: string },
) {
  try {
    const ctx = await requireWorkforceContextOrThrow("knowledge.edit");
    const res = await saveEmployeeKnowledgeEntry(ctx, agentId, input);
    revalidateEmployee();
    return { ok: true as const, data: res };
  } catch (err) {
    return actionError(err);
  }
}

export async function archiveEmployeeKnowledgeEntryAction(agentId: string, entryId: string) {
  try {
    const ctx = await requireWorkforceContextOrThrow("knowledge.edit");
    await archiveEmployeeKnowledgeEntry(ctx, agentId, entryId);
    revalidateEmployee();
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function assignKnowledgeDocumentAction(agentId: string, documentId: string) {
  try {
    const ctx = await requireWorkforceContextOrThrow("knowledge.edit");
    await assignKnowledgeDocument(ctx, agentId, documentId);
    revalidateEmployee();
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function unassignKnowledgeDocumentAction(agentId: string, documentId: string) {
  try {
    const ctx = await requireWorkforceContextOrThrow("knowledge.edit");
    await unassignKnowledgeDocument(ctx, agentId, documentId);
    revalidateEmployee();
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function reprocessKnowledgeDocumentAction(documentId: string) {
  try {
    const ctx = await requireWorkforceContextOrThrow("knowledge.edit");
    const result = await reprocessKnowledgeDocument(ctx, documentId);
    revalidateEmployee();
    return { ok: true as const, data: result };
  } catch (err) {
    return actionError(err);
  }
}
