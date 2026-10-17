"use server";

import { revalidatePath } from "next/cache";
import { guard } from "@/server/action-guard";
import { AppError, actionError } from "@/server/errors";
import { studioContext } from "@/server/websites/studio-ctx";
import { deleteAsset, listAssets, setAssetAlt } from "@/server/assets/service";
import {
  PublishBlockedError, createWebsite, getDraft, listVersions, decideApproval, getVersionContent, preflight, publishWebsite, regenerateDraft, restoreVersion, rollbackWebsite, saveDraft, saveVersion,
  submitForApproval, unpublishWebsite,
} from "@/server/websites/service";
import {
  addCustomDomain, approveDomainPurchase, changeSubdomain, checkLive, checkSsl, removeDomain, requestDomainPurchase, setPrimaryDomain, verifyDomain,
} from "@/server/websites/domains";
import { markSubmissionSpam } from "@/server/websites/forms";
import { suggestWithAi } from "@/server/websites/assistant";
import { deleteComponent, listComponents, saveComponent } from "@/server/websites/components";
import { templateUpdateFor } from "@/server/websites/template-update";
import { acquireEditLock, addComment, listComments, releaseEditLock, requestChanges, resolveComment, reviewSummary, setArchived } from "@/server/websites/review";
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

export async function createWebsiteAction(templateKey: string, orgId?: string) {
  return guard(async () => {
    const ctx = await studioContext(orgId, "website.create");
    const res = await createWebsite(ctx, { templateKey: String(templateKey) });
    refresh();
    return res;
  });
}

/** Autosave. A "conflict" code means the site changed elsewhere, so the editor must reload instead of overwriting it. */
export async function saveDraftAction(content: unknown, expectedRevision: number, orgId?: string) {
  return guard(async () => {
    const ctx = await studioContext(orgId, "website.edit");
    return saveDraft(ctx, { content, expectedRevision: int(expectedRevision) });
  });
}

/** Rebuilds the draft from the business details, optionally from a different template. The current draft is kept as a version first. */
export async function regenerateDraftAction(expectedRevision: number, templateKey?: string, orgId?: string) {
  return guard(async () => {
    const ctx = await studioContext(orgId, "website.edit");
    const res = await regenerateDraft(ctx, { expectedRevision: int(expectedRevision), ...(templateKey ? { templateKey: String(templateKey) } : {}) });
    refresh();
    return res;
  });
}

export async function saveVersionAction(note: string, orgId?: string, source?: "checkpoint" | "ai") {
  return guard(async () => {
    const ctx = await studioContext(orgId, "website.edit");
    const res = await saveVersion(ctx, { note: String(note ?? "").slice(0, 300), source: source === "ai" ? "ai" : "checkpoint" });
    refresh();
    return res;
  });
}

export async function restoreVersionAction(versionId: string, expectedRevision: number, orgId?: string) {
  return guard(async () => {
    needUuid(versionId);
    const ctx = await studioContext(orgId, "website.edit");
    const res = await restoreVersion(ctx, { versionId, expectedRevision: int(expectedRevision) });
    refresh();
    return res;
  });
}

/** Lets someone look at an earlier version before deciding to restore it. */
export async function previewVersionAction(versionId: string, orgId?: string) {
  return guard(async () => {
    needUuid(versionId);
    const v = await getVersionContent(await studioContext(orgId, "website.view"), versionId);
    if (!v) throw new AppError("not_found", "That version wasn't found.");
    return v;
  });
}

/** The current draft, for the editor to reload after a restore or a rebuild. */
export async function getDraftAction(orgId?: string) {
  return guard(async () => {
    const d = await getDraft(await studioContext(orgId, "website.view"));
    if (!d) throw new AppError("not_found", "Create your website first.");
    return { content: d.content, revision: d.revision, templateKey: d.templateKey };
  });
}

export async function listVersionsAction(orgId?: string) {
  return guard(async () => listVersions(await studioContext(orgId, "website.view")));
}

export async function listAssetsAction(orgId?: string) {
  return guard(async () => listAssets(await studioContext(orgId, "workspace.view")));
}

export async function setAssetAltAction(id: string, alt: string, orgId?: string) {
  return guard(async () => {
    needUuid(id);
    await setAssetAlt(await studioContext(orgId, "workspace.manage_profile"), id, String(alt ?? ""));
    return {};
  });
}

export async function deleteAssetAction(id: string, orgId?: string) {
  return guard(async () => {
    needUuid(id);
    await deleteAsset(await studioContext(orgId, "workspace.manage_profile"), id);
    return {};
  });
}

export async function preflightAction(orgId?: string) {
  return guard(async () => preflight(await studioContext(orgId, "website.view")));
}

export async function submitForApprovalAction(orgId?: string) {
  try {
    const ctx = await studioContext(orgId, "website.edit");
    const res = await submitForApproval(ctx);
    refresh();
    return { ok: true as const, data: res };
  } catch (err) {
    return blocked(err);
  }
}

export async function decideApprovalAction(approve: boolean, note: string, orgId?: string) {
  return guard(async () => {
    const ctx = await studioContext(orgId, "website.approve");
    await decideApproval(ctx, { approve: approve === true, note: String(note ?? "") });
    refresh();
    return { approved: approve === true };
  });
}

function blocked(err: unknown): { ok: false; error: string; code: string; blockers?: Issue[]; needsAcknowledgement?: Issue[] } {
  if (err instanceof PublishBlockedError) return { ok: false, error: err.message, code: err.code, blockers: err.blockers, needsAcknowledgement: err.needsAcknowledgement };
  return actionError(err);
}

export async function publishAction(acknowledgeClaims: boolean, note: string, orgId?: string) {
  try {
    const ctx = await studioContext(orgId, "website.publish");
    const res = await publishWebsite(ctx, { acknowledgeClaims: acknowledgeClaims === true, note: String(note ?? "").slice(0, 300) });
    refresh();
    return { ok: true as const, data: res };
  } catch (err) {
    return blocked(err);
  }
}

export async function unpublishAction(orgId?: string) {
  return guard(async () => {
    await unpublishWebsite(await studioContext(orgId, "website.publish"));
    refresh();
    return {};
  });
}

export async function rollbackAction(publicationNumber: number, orgId?: string) {
  return guard(async () => {
    const res = await rollbackWebsite(await studioContext(orgId, "website.publish"), { publicationNumber: int(publicationNumber) });
    refresh();
    return res;
  });
}

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

export async function addDomainAction(hostname: string, orgId?: string) {
  return guard(async () => {
    const res = await addCustomDomain(await studioContext(orgId, "website.domains"), { hostname: String(hostname) });
    refresh();
    return res;
  });
}
export async function verifyDomainAction(id: string, orgId?: string) {
  return guard(async () => {
    needUuid(id);
    const res = await verifyDomain(await studioContext(orgId, "website.domains"), id);
    refresh();
    return res;
  });
}
export async function checkSslAction(id: string, orgId?: string) {
  return guard(async () => {
    needUuid(id);
    const res = await checkSsl(await studioContext(orgId, "website.domains"), id);
    refresh();
    return res;
  });
}
export async function checkLiveAction(id: string, orgId?: string) {
  return guard(async () => {
    needUuid(id);
    const res = await checkLive(await studioContext(orgId, "website.domains"), id);
    refresh();
    return res;
  });
}
export async function setPrimaryDomainAction(id: string, orgId?: string) {
  return guard(async () => {
    needUuid(id);
    await setPrimaryDomain(await studioContext(orgId, "website.domains"), id);
    refresh();
    return {};
  });
}
export async function removeDomainAction(id: string, orgId?: string) {
  return guard(async () => {
    needUuid(id);
    await removeDomain(await studioContext(orgId, "website.domains"), id);
    refresh();
    return {};
  });
}
export async function changeSubdomainAction(subdomain: string, orgId?: string) {
  return guard(async () => {
    const res = await changeSubdomain(await studioContext(orgId, "website.domains"), { subdomain: String(subdomain) });
    refresh();
    return res;
  });
}
export async function requestDomainPurchaseAction(hostname: string, orgId?: string) {
  return guard(async () => {
    const res = await requestDomainPurchase(await studioContext(orgId, "website.domains"), { hostname: String(hostname) });
    refresh();
    return res;
  });
}
export async function approveDomainPurchaseAction(id: string, orgId?: string) {
  return guard(async () => {
    needUuid(id);
    await approveDomainPurchase(await studioContext(orgId, "website.approve"), id);
    refresh();
    return {};
  });
}

export async function markEnquirySpamAction(id: string, orgId?: string) {
  return guard(async () => {
    needUuid(id);
    await markSubmissionSpam(await studioContext(orgId, "contacts.edit"), id);
    refresh();
    return {};
  });
}

// ---------------------------------------------------------------------------
// Review, comments, archive and the edit lock
// ---------------------------------------------------------------------------

export async function listCommentsAction(orgId?: string) {
  return guard(async () => listComments(await studioContext(orgId, "website.view")));
}
export async function addCommentAction(body: string, nodeId: string | null, pageSlug: string | null, orgId?: string) {
  return guard(async () => {
    const res = await addComment(await studioContext(orgId, "website.view"), { body: String(body ?? ""), nodeId: nodeId ? String(nodeId) : null, pageSlug: pageSlug ? String(pageSlug) : null });
    refresh();
    return res;
  });
}
export async function resolveCommentAction(id: string, resolved: boolean, orgId?: string) {
  return guard(async () => {
    needUuid(id);
    await resolveComment(await studioContext(orgId, "website.view"), id, resolved === true);
    refresh();
    return {};
  });
}
export async function reviewSummaryAction(orgId?: string) {
  return guard(async () => reviewSummary(await studioContext(orgId, "website.view")));
}
export async function requestChangesAction(note: string, orgId?: string) {
  return guard(async () => {
    await requestChanges(await studioContext(orgId, "website.review"), String(note ?? ""));
    refresh();
    revalidatePath("/admin/website-studio", "layout");
    return {};
  });
}
export async function setArchivedAction(archived: boolean, orgId?: string) {
  return guard(async () => {
    await setArchived(await studioContext(orgId, "website.archive"), archived === true);
    refresh();
    revalidatePath("/admin/website-studio", "layout");
    return {};
  });
}
export async function acquireLockAction(takeOver: boolean, orgId?: string) {
  return guard(async () => acquireEditLock(await studioContext(orgId, "website.edit"), { takeOver: takeOver === true }));
}
export async function releaseLockAction(orgId?: string) {
  return guard(async () => {
    await releaseEditLock(await studioContext(orgId, "website.edit"));
    return {};
  });
}

/**
 * Asks the connected AI provider for suggested edits. Returns null data when none is connected, so the browser falls back to the built-in
 * assistant. What comes back is still only a proposal: the browser checks every edit and nothing is applied without the person's say-so.
 */
export async function suggestEditAction(request: string, brief: unknown, orgId?: string) {
  return guard(async () => {
    const ctx = await studioContext(orgId, "website.edit");
    return suggestWithAi(ctx, { request: String(request ?? ""), brief });
  });
}

export async function listComponentsAction(orgId?: string) {
  return guard(async () => listComponents(await studioContext(orgId, "website.view")));
}

export async function saveComponentAction(name: string, section: unknown, scope: "site" | "agency", orgId?: string) {
  return guard(async () => saveComponent(await studioContext(orgId, "website.view"), { name: String(name ?? ""), section, scope: scope === "agency" ? "agency" : "site" }));
}

export async function deleteComponentAction(id: string, orgId?: string) {
  return guard(async () => {
    needUuid(id);
    await deleteComponent(await studioContext(orgId, "website.view"), id);
    return {};
  });
}

/** Whether the template this website began as has a newer look the owner can choose to take. */
export async function templateUpdateAction(orgId?: string) {
  return guard(async () => templateUpdateFor(await studioContext(orgId, "website.view")));
}
