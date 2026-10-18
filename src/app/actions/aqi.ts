"use server";

import { revalidatePath } from "next/cache";
import { requireAgencyOrThrow } from "@/server/tenancy/context";
import { actionError } from "@/server/errors";
import {
  archiveAqiKnowledge,
  deleteAqiQuestion,
  previewAqiRetrieval,
  publishAqiConfig,
  saveAqiDraftConfig,
  saveAqiKnowledge,
  saveAqiQuestion,
  testAqiProvider,
} from "@/server/aqi/service";

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
