"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { guard } from "@/server/action-guard";
import { AppError } from "@/server/errors";
import { resolveCrmActor } from "@/server/crm/request";
import type { CrmActor } from "@/server/crm/actor";
import type { Permission } from "@/lib/permissions";
import { studioContext } from "@/server/websites/studio-ctx";
import { FORM_KINDS, FORM_PURPOSES } from "@/lib/crm/forms/spec";
import {
  createForm, duplicateForm, getFormVersionPreview, publishForm, restoreFormVersion, saveFormDraft, setFormArchived, unpublishForm, updateFormSettings, validateFormDraft,
  websiteFormOptionsFor,
} from "@/server/crm/forms/definitions";
import { markSubmissionNotSpam, markSubmissionSpam, retryFormSubmission } from "@/server/crm/forms/submissions";

// Server actions for native forms (/crm/forms and the agency's view of it). Every rule lives in the services; these only parse input,
// resolve who is acting and refresh the screens.

const uuid = z.string().uuid();
const orgArg = z.string().uuid().nullable().optional();
const revision = z.number().int().min(1).max(10_000_000);

function refresh(actor: CrmActor) {
  revalidatePath("/crm", "layout");
  if (actor.kind === "agency") revalidatePath(`/admin/clients/${actor.orgId}/crm`, "layout");
}

async function act<T>(orgId: string | null | undefined, permission: Permission, fn: (actor: CrmActor) => Promise<T>, opts: { refresh?: boolean } = {}) {
  return guard(async () => {
    const actor = await resolveCrmActor(orgArg.parse(orgId) ?? null, permission);
    const out = await fn(actor);
    if (opts.refresh !== false) refresh(actor);
    return out;
  });
}

const createSchema = z.object({
  name: z.string().max(200),
  kind: z.enum(FORM_KINDS).optional(),
  purpose: z.enum(FORM_PURPOSES).optional(),
  key: z.string().max(60).nullable().optional(),
  folderId: uuid.nullable().optional(),
});

const settingsSchema = z.object({
  name: z.string().max(200).optional(),
  key: z.string().max(60).optional(),
  kind: z.enum(FORM_KINDS).optional(),
  purpose: z.enum(FORM_PURPOSES).optional(),
  folderId: uuid.nullable().optional(),
  hosted: z.boolean().optional(),
});

/** The builder's draft is checked by the service (readDraft / validateDraft); here it only has to be a reasonably sized object. */
const draftArg = z.unknown().refine((v) => typeof v === "object" && v !== null && !Array.isArray(v), "The form's draft couldn't be read.").refine((v) => JSON.stringify(v).length <= 150_000, "This form is too large to save.");

export async function createFormAction(orgId: string | null, input: z.input<typeof createSchema>) {
  return act(orgId, "forms.manage", (actor) => createForm(actor, createSchema.parse(input)));
}

export async function saveFormDraftAction(orgId: string | null, id: string, input: { draft: unknown; expectedRevision: number }) {
  return act(orgId, "forms.manage", (actor) => saveFormDraft(actor, uuid.parse(id), { draft: draftArg.parse(input?.draft), expectedRevision: revision.parse(input?.expectedRevision) }), { refresh: false });
}

export async function validateFormDraftAction(orgId: string | null, draft: unknown, kind: string) {
  return act(orgId, "crm.view", (actor) => validateFormDraft(actor, draftArg.parse(draft), z.enum(FORM_KINDS).parse(kind)), { refresh: false });
}

export async function publishFormAction(orgId: string | null, id: string, expectedRevision?: number) {
  return act(orgId, "forms.manage", (actor) => publishForm(actor, uuid.parse(id), { expectedRevision: expectedRevision === undefined ? undefined : revision.parse(expectedRevision) }));
}

export async function unpublishFormAction(orgId: string | null, id: string) {
  return act(orgId, "forms.manage", (actor) => unpublishForm(actor, uuid.parse(id)));
}

export async function setFormArchivedAction(orgId: string | null, id: string, archived: boolean) {
  return act(orgId, "forms.manage", (actor) => setFormArchived(actor, uuid.parse(id), z.boolean().parse(archived)));
}

export async function duplicateFormAction(orgId: string | null, id: string, name?: string) {
  return act(orgId, "forms.manage", (actor) => duplicateForm(actor, uuid.parse(id), { name: name === undefined ? undefined : z.string().max(200).parse(name) }));
}

export async function updateFormSettingsAction(orgId: string | null, id: string, input: z.input<typeof settingsSchema>) {
  return act(orgId, "forms.manage", (actor) => updateFormSettings(actor, uuid.parse(id), settingsSchema.parse(input)));
}

export async function restoreFormVersionAction(orgId: string | null, id: string, versionId: string, expectedRevision: number) {
  return act(orgId, "forms.manage", (actor) => restoreFormVersion(actor, uuid.parse(id), uuid.parse(versionId), revision.parse(expectedRevision)));
}

export async function getFormVersionPreviewAction(orgId: string | null, id: string, versionId: string) {
  return act(orgId, "crm.view", (actor) => getFormVersionPreview(actor, uuid.parse(id), uuid.parse(versionId)), { refresh: false });
}

export async function retryFormSubmissionAction(orgId: string | null, id: string) {
  return act(orgId, "contacts.edit", (actor) => retryFormSubmission(actor, uuid.parse(id)));
}

export async function markSubmissionSpamAction(orgId: string | null, id: string, spam: boolean) {
  return act(orgId, "contacts.edit", (actor) => (z.boolean().parse(spam) ? markSubmissionSpam(actor, uuid.parse(id)) : markSubmissionNotSpam(actor, uuid.parse(id))));
}

/**
 * The workspace's forms for the Website Studio's form element: the picker, and the canvas drawing exactly what visitors will see. The
 * workspace is decided by the server (the user's own, or a client the agency user may edit), never the browser.
 */
export async function listWebsiteFormsAction(orgId?: string) {
  return guard(async () => {
    if (orgId !== undefined && !uuid.safeParse(orgId).success) throw new AppError("invalid_input", "That workspace wasn't found.");
    const ctx = await studioContext(orgId, "website.edit");
    return websiteFormOptionsFor(ctx.org.orgId, { agency: ctx.user.platformRole !== "none" });
  });
}
