"use server";

import { revalidatePath } from "next/cache";
import { guard } from "@/server/action-guard";
import { AppError } from "@/server/errors";
import { requireAgencyOrThrow } from "@/server/tenancy/context";
import {
  createTemplate, deleteDraftTemplate, duplicateTemplate, getTemplateDraft, getTemplateVersionContent, listTemplateVersions, restoreTemplateVersion, saveTemplateDraft, setTemplateStatus, templatePreflight, updateTemplateMeta,
  type TemplateMeta, type TemplateStatus,
} from "@/server/websites/templates";
import { createWebsite } from "@/server/websites/service";
import { setPatternStatus, type PatternStatus } from "@/server/websites/components";
import { studioContext } from "@/server/websites/studio-ctx";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const needUuid = (id: string) => {
  if (!uuid.test(id)) throw new AppError("invalid_input", "That item wasn't found.");
};
const KEY = /^[a-z][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/;
const needKey = (k: string) => {
  if (!KEY.test(k)) throw new AppError("invalid_input", "That template wasn't found.");
};
const STATUSES: TemplateStatus[] = ["draft", "in_review", "published", "hidden", "archived"];
const refresh = () => revalidatePath("/admin/website-studio", "layout");

export async function createTemplateAction(input: { name: string; from: { kind: "blank" } | { kind: "builtin"; key: string } | { kind: "custom"; key: string }; description?: string; industries?: string[]; tags?: string[] }) {
  return guard(async () => {
    const user = await requireAgencyOrThrow();
    if (input.from.kind !== "blank") needKey(input.from.key);
    const res = await createTemplate(user, input);
    refresh();
    return res;
  });
}

export async function duplicateTemplateAction(key: string) {
  return guard(async () => {
    needKey(key);
    const res = await duplicateTemplate(await requireAgencyOrThrow(), key);
    refresh();
    return res;
  });
}

export async function updateTemplateMetaAction(key: string, patch: TemplateMeta) {
  return guard(async () => {
    needKey(key);
    await updateTemplateMeta(await requireAgencyOrThrow(), key, patch);
    refresh();
    return {};
  });
}

export async function setTemplateStatusAction(key: string, status: TemplateStatus, note?: string) {
  return guard(async () => {
    needKey(key);
    if (!STATUSES.includes(status)) throw new AppError("invalid_input", "That status isn't valid.");
    const res = await setTemplateStatus(await requireAgencyOrThrow(), key, status, note);
    refresh();
    return res;
  });
}

export async function saveTemplateDraftAction(id: string, content: unknown, expectedRevision: number) {
  return guard(async () => {
    needUuid(id);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new AppError("invalid_input", "That request wasn't valid. Reload the page and try again.");
    return saveTemplateDraft(await requireAgencyOrThrow(), id, { content, expectedRevision });
  });
}

export async function listTemplateVersionsAction(id: string) {
  return guard(async () => {
    needUuid(id);
    return listTemplateVersions(await requireAgencyOrThrow(), id);
  });
}

export async function restoreTemplateVersionAction(id: string, version: number) {
  return guard(async () => {
    needUuid(id);
    await restoreTemplateVersion(await requireAgencyOrThrow(), id, Number(version));
    refresh();
    return {};
  });
}

export async function deleteDraftTemplateAction(id: string) {
  return guard(async () => {
    needUuid(id);
    await deleteDraftTemplate(await requireAgencyOrThrow(), id);
    refresh();
    return {};
  });
}

/** An assigned agency user starts the first draft of a client's website. */
export async function createWebsiteForClientAction(orgId: string, templateKey: string) {
  return guard(async () => {
    needUuid(orgId);
    const ctx = await studioContext(orgId, "website.create");
    const res = await createWebsite(ctx, { templateKey: String(templateKey) });
    refresh();
    return res;
  });
}

export async function getTemplateDraftAction(id: string) {
  return guard(async () => {
    needUuid(id);
    const t = await getTemplateDraft(await requireAgencyOrThrow(), id);
    return { content: t.content, revision: t.revision, key: t.key, status: t.status, version: t.version };
  });
}

export async function templatePreflightAction(id: string) {
  return guard(async () => {
    needUuid(id);
    return templatePreflight(await requireAgencyOrThrow(), id);
  });
}

export async function getTemplateVersionAction(id: string, version: number) {
  return guard(async () => {
    needUuid(id);
    return { content: await getTemplateVersionContent(await requireAgencyOrThrow(), id, Number(version)) };
  });
}

export async function setPatternStatusAction(id: string, status: PatternStatus) {
  return guard(async () => {
    needUuid(id);
    await setPatternStatus(await requireAgencyOrThrow(), id, status);
    refresh();
    return {};
  });
}
