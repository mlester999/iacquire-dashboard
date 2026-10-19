"use server";

import { revalidatePath } from "next/cache";
import { requireAgencyOrThrow } from "@/server/tenancy/context";
import { actionError } from "@/server/errors";
import {
  archiveAqiKnowledge,
  deleteAqiQuestion,
  previewAqiRetrieval,
  publishAqiConfig,
  saveAqiBudget,
  saveAqiDraftConfig,
  saveAqiModelPrice,
  saveAqiKnowledge,
  saveAqiQuestion,
  testAqiProvider,
} from "@/server/aqi/service";
import {
  archiveAqiTutorial,
  duplicateAqiTutorial,
  previewAqiTutorialDefinition,
  publishAqiTutorial,
  rollbackAqiTutorial,
  saveAqiTutorialDraft,
} from "@/server/aqi/tutorials";
import {
  archiveAqiKnowledgeDocument,
  createAqiKnowledgeEntryFromDocument,
  reviewAqiKnowledgeEntry,
} from "@/server/aqi/knowledge-documents";

function refresh() {
  revalidatePath("/admin/aqi");
  revalidatePath("/", "layout");
}

export async function saveAqiConfigAction(config: unknown, notes?: string) {
  try {
    const admin = await requireAgencyOrThrow("super_admin");
    const result = await saveAqiDraftConfig(admin, config, notes ?? null);
    refresh();
    return { ok: true as const, data: result };
  } catch (err) {
    return actionError(err);
  }
}

export async function publishAqiConfigAction(versionId: string) {
  try {
    const admin = await requireAgencyOrThrow("super_admin");
    await publishAqiConfig(admin, versionId);
    refresh();
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function saveAqiKnowledgeAction(input: {
  id?: string | null;
  title: string;
  category: string;
  body: string;
  routePrefix?: string | null;
  roles?: string[];
  status?: "draft" | "published" | "archived";
  source?: string;
}) {
  try {
    const admin = await requireAgencyOrThrow("super_admin");
    await saveAqiKnowledge(admin, input);
    refresh();
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function archiveAqiKnowledgeAction(id: string) {
  try {
    const admin = await requireAgencyOrThrow("super_admin");
    await archiveAqiKnowledge(admin, id);
    refresh();
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function saveAqiQuestionAction(input: {
  id?: string | null;
  question: string;
  scope: "global" | "role" | "page";
  role?: string | null;
  routePrefix?: string | null;
  sortOrder?: number;
  enabled?: boolean;
}) {
  try {
    const admin = await requireAgencyOrThrow("super_admin");
    await saveAqiQuestion(admin, input);
    refresh();
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function deleteAqiQuestionAction(id: string) {
  try {
    const admin = await requireAgencyOrThrow("super_admin");
    await deleteAqiQuestion(admin, id);
    refresh();
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function saveAqiBudgetAction(input: { orgId?: string | null; enabled: boolean; monthlyOrgUsd: number; monthlyUserUsd: number }) {
  try {
    const admin = await requireAgencyOrThrow("super_admin");
    await saveAqiBudget(admin, input);
    refresh();
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function saveAqiModelPriceAction(input: { model: string; inputUsdPerMillion: number; outputUsdPerMillion: number; enabled: boolean }) {
  try {
    const admin = await requireAgencyOrThrow("super_admin");
    await saveAqiModelPrice(admin, input);
    refresh();
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function previewAqiRetrievalAction(query: string, pathname: string | null) {
  try {
    const admin = await requireAgencyOrThrow("super_admin");
    return { ok: true as const, data: await previewAqiRetrieval(admin, query, pathname) };
  } catch (err) {
    return actionError(err);
  }
}

export async function testAqiProviderAction(prompt: string, draftConfig?: unknown) {
  try {
    const admin = await requireAgencyOrThrow("super_admin");
    return { ok: true as const, data: await testAqiProvider(admin, prompt, draftConfig) };
  } catch (err) {
    return actionError(err);
  }
}

export async function saveAqiTutorialAction(input: { id?: string | null; slug?: string | null; definition: unknown; notes?: string | null }) {
  try {
    const admin = await requireAgencyOrThrow("super_admin");
    const result = await saveAqiTutorialDraft(admin, input);
    refresh();
    return { ok: true as const, data: result };
  } catch (err) {
    return actionError(err);
  }
}

export async function publishAqiTutorialAction(tutorialId: string, versionId?: string | null) {
  try {
    const admin = await requireAgencyOrThrow("super_admin");
    return { ok: true as const, data: await publishAqiTutorial(admin, tutorialId, versionId ?? null) };
  } catch (err) {
    return actionError(err);
  }
}

export async function archiveAqiTutorialAction(tutorialId: string) {
  try {
    const admin = await requireAgencyOrThrow("super_admin");
    await archiveAqiTutorial(admin, tutorialId);
    refresh();
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function duplicateAqiTutorialAction(tutorialId: string) {
  try {
    const admin = await requireAgencyOrThrow("super_admin");
    const result = await duplicateAqiTutorial(admin, tutorialId);
    refresh();
    return { ok: true as const, data: result };
  } catch (err) {
    return actionError(err);
  }
}

export async function rollbackAqiTutorialAction(tutorialId: string, versionId: string) {
  try {
    const admin = await requireAgencyOrThrow("super_admin");
    return { ok: true as const, data: await rollbackAqiTutorial(admin, tutorialId, versionId) };
  } catch (err) {
    return actionError(err);
  }
}

export async function previewAqiTutorialAction(definition: unknown, role: string) {
  try {
    await requireAgencyOrThrow("super_admin");
    return { ok: true as const, data: previewAqiTutorialDefinition(definition, role) };
  } catch (err) {
    return actionError(err);
  }
}

export async function reviewAqiKnowledgeAction(
  id: string,
  input: { action: "review" | "publish" | "archive"; note?: string | null; freshnessDays?: number | null },
) {
  try {
    const admin = await requireAgencyOrThrow("super_admin");
    await reviewAqiKnowledgeEntry(admin, id, input);
    refresh();
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function createAqiKnowledgeEntryFromDocumentAction(input: {
  documentId: string;
  title: string;
  category: string;
  body?: string | null;
  routePrefix?: string | null;
  roles?: string[];
}) {
  try {
    const admin = await requireAgencyOrThrow("super_admin");
    const result = await createAqiKnowledgeEntryFromDocument(admin, input);
    refresh();
    return { ok: true as const, data: result };
  } catch (err) {
    return actionError(err);
  }
}

export async function archiveAqiKnowledgeDocumentAction(documentId: string) {
  try {
    const admin = await requireAgencyOrThrow("super_admin");
    await archiveAqiKnowledgeDocument(admin, documentId);
    refresh();
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}
