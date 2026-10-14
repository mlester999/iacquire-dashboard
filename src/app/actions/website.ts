"use server";

import { revalidatePath } from "next/cache";
import { guard } from "@/server/action-guard";
import { AppError, actionError } from "@/server/errors";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import {
  PublishBlockedError, changeTemplate, createWebsite, decideApproval, getVersionContent, preflight, publishWebsite, regenerateDraft, restoreVersion, rollbackWebsite, saveDraft, saveVersion,
  submitForApproval, unpublishWebsite,
} from "@/server/websites/service";
import {
  addCustomDomain, approveDomainPurchase, changeSubdomain, checkLive, checkSsl, removeDomain, requestDomainPurchase, setPrimaryDomain, verifyDomain,
} from "@/server/websites/domains";
import { markSubmissionSpam } from "@/server/websites/forms";
import type { Issue } from "@/lib/website/lint";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const refresh = () => revalidatePath("/website", "layout");
const needUuid = (id: string) => {
  if (!uuid.test(id)) throw new AppError("invalid_input", "That item wasn't found.");
};
const int = (n: unknown) => {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) throw new AppError("invalid_input", "That request wasn't valid. Reload the page and try again.");
  return n;
};

export async function createWebsiteAction(templateKey: string) {
  return guard(async () => {
    const ctx = await requireOrgContextOrThrow("website.edit");
    const res = await createWebsite(ctx, { templateKey: String(templateKey) });
    refresh();
    return res;
  });
}

/** Autosave. A "conflict" code means the site changed elsewhere, so the editor must reload instead of overwriting it. */
export async function saveDraftAction(content: unknown, expectedRevision: number) {
  return guard(async () => {
    const ctx = await requireOrgContextOrThrow("website.edit");
    return saveDraft(ctx, { content, expectedRevision: int(expectedRevision) });
  });
}

export async function changeTemplateAction(templateKey: string, expectedRevision: number) {
  return guard(async () => {
    const ctx = await requireOrgContextOrThrow("website.edit");
    const res = await changeTemplate(ctx, { templateKey: String(templateKey), expectedRevision: int(expectedRevision) });
    refresh();
    return res;
  });
}

export async function regenerateDraftAction(expectedRevision: number) {
  return guard(async () => {
    const ctx = await requireOrgContextOrThrow("website.edit");
    const res = await regenerateDraft(ctx, { expectedRevision: int(expectedRevision) });
    refresh();
    return res;
  });
}

export async function saveVersionAction(note: string) {
  return guard(async () => {
    const ctx = await requireOrgContextOrThrow("website.edit");
    const res = await saveVersion(ctx, { note: String(note ?? "").slice(0, 300) });
    refresh();
    return res;
  });
}

export async function restoreVersionAction(versionId: string, expectedRevision: number) {
  return guard(async () => {
    needUuid(versionId);
    const ctx = await requireOrgContextOrThrow("website.edit");
    const res = await restoreVersion(ctx, { versionId, expectedRevision: int(expectedRevision) });
    refresh();
    return res;
  });
}

/** Lets someone look at an earlier version before deciding to restore it. */
export async function previewVersionAction(versionId: string) {
  return guard(async () => {
    needUuid(versionId);
    const v = await getVersionContent(await requireOrgContextOrThrow("website.view"), versionId);
    if (!v) throw new AppError("not_found", "That version wasn't found.");
    return v;
  });
}

export async function preflightAction() {
  return guard(async () => preflight(await requireOrgContextOrThrow("website.view")));
}

export async function submitForApprovalAction() {
  try {
    const ctx = await requireOrgContextOrThrow("website.edit");
    const res = await submitForApproval(ctx);
    refresh();
    return { ok: true as const, data: res };
  } catch (err) {
    return blocked(err);
  }
}

export async function decideApprovalAction(approve: boolean, note: string) {
  return guard(async () => {
    const ctx = await requireOrgContextOrThrow("website.approve");
    await decideApproval(ctx, { approve: approve === true, note: String(note ?? "") });
    refresh();
    return { approved: approve === true };
  });
}

function blocked(err: unknown): { ok: false; error: string; code: string; blockers?: Issue[]; needsAcknowledgement?: Issue[] } {
  if (err instanceof PublishBlockedError) return { ok: false, error: err.message, code: err.code, blockers: err.blockers, needsAcknowledgement: err.needsAcknowledgement };
  return actionError(err);
}

export async function publishAction(acknowledgeClaims: boolean, note: string) {
  try {
    const ctx = await requireOrgContextOrThrow("website.publish");
    const res = await publishWebsite(ctx, { acknowledgeClaims: acknowledgeClaims === true, note: String(note ?? "").slice(0, 300) });
    refresh();
    return { ok: true as const, data: res };
  } catch (err) {
    return blocked(err);
  }
}

export async function unpublishAction() {
  return guard(async () => {
    await unpublishWebsite(await requireOrgContextOrThrow("website.publish"));
    refresh();
    return {};
  });
}

export async function rollbackAction(publicationNumber: number) {
  return guard(async () => {
    const res = await rollbackWebsite(await requireOrgContextOrThrow("website.publish"), { publicationNumber: int(publicationNumber) });
    refresh();
    return res;
  });
}

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

export async function addDomainAction(hostname: string) {
  return guard(async () => {
    const res = await addCustomDomain(await requireOrgContextOrThrow("website.domains"), { hostname: String(hostname) });
    refresh();
    return res;
  });
}
export async function verifyDomainAction(id: string) {
  return guard(async () => {
    needUuid(id);
    const res = await verifyDomain(await requireOrgContextOrThrow("website.domains"), id);
    refresh();
    return res;
  });
}
export async function checkSslAction(id: string) {
  return guard(async () => {
    needUuid(id);
    const res = await checkSsl(await requireOrgContextOrThrow("website.domains"), id);
    refresh();
    return res;
  });
}
export async function checkLiveAction(id: string) {
  return guard(async () => {
    needUuid(id);
    const res = await checkLive(await requireOrgContextOrThrow("website.domains"), id);
    refresh();
    return res;
  });
}
export async function setPrimaryDomainAction(id: string) {
  return guard(async () => {
    needUuid(id);
    await setPrimaryDomain(await requireOrgContextOrThrow("website.domains"), id);
    refresh();
    return {};
  });
}
export async function removeDomainAction(id: string) {
  return guard(async () => {
    needUuid(id);
    await removeDomain(await requireOrgContextOrThrow("website.domains"), id);
    refresh();
    return {};
  });
}
export async function changeSubdomainAction(subdomain: string) {
  return guard(async () => {
    const res = await changeSubdomain(await requireOrgContextOrThrow("website.domains"), { subdomain: String(subdomain) });
    refresh();
    return res;
  });
}
export async function requestDomainPurchaseAction(hostname: string) {
  return guard(async () => {
    const res = await requestDomainPurchase(await requireOrgContextOrThrow("website.domains"), { hostname: String(hostname) });
    refresh();
    return res;
  });
}
export async function approveDomainPurchaseAction(id: string) {
  return guard(async () => {
    needUuid(id);
    await approveDomainPurchase(await requireOrgContextOrThrow("website.approve"), id);
    refresh();
    return {};
  });
}

export async function markEnquirySpamAction(id: string) {
  return guard(async () => {
    needUuid(id);
    await markSubmissionSpam(await requireOrgContextOrThrow("contacts.edit"), id);
    refresh();
    return {};
  });
}
