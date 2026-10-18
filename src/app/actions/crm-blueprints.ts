"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { guard } from "@/server/action-guard";
import { AppError } from "@/server/errors";
import { requireAgencyOrThrow } from "@/server/tenancy/context";
import { consumeRateLimit, type RateLimitRule } from "@/server/security/rate-limit";
import {
  archiveBlueprint, compareVersions, createBlueprint, createLibraryFolder, deleteLibraryFolder, discardImport, getVersionContent, installStarter,
  previewPackageImport, publishBlueprint, renameLibraryFolder, restoreVersionToDraft, saveDraft, saveImport, unarchiveBlueprint, updateBlueprintDetails,
} from "@/server/crm/blueprints/library";
import { removeGhlTemplateSource, runGhlImport, saveGhlTemplateSource, testGhlTemplateSource } from "@/server/crm/blueprints/ghl";
import { GHL_LOCATION_RE, isProtectedGhlLocation } from "@/lib/crm/blueprints/ghl/inventory";
import { captureFromClient, previewCapture } from "@/server/crm/blueprints/capture";
import { applyBlueprint, getApplication, planApplication, previewApplication, rollbackApplication } from "@/server/crm/blueprints/apply";
import {
  APPLY_STRATEGIES, ASSET_SECTIONS, BLUEPRINT_INDUSTRIES, BLUEPRINT_MAX_BYTES, CONFLICT_DECISIONS, isLogicalId,
} from "@/lib/crm/blueprints/types";

// The agency's CRM Blueprints & Snapshots actions: the library, versions, folders, starters, package and GoHighLevel imports, capture from a
// client, applying to a client and rolling back. Each one checks its input here, then hands the signed-in agency person to the Blueprint
// service, which authorizes the exact step (src/server/crm/blueprints/access.ts → BLUEPRINT_ACTIONS) and, for anything touching one client,
// that person's access to that client, re-checked under a lock inside the write. Nothing here trusts a role, a client or a version the
// browser names.
//
// Naming: every service function `fooBar(user, …args)` has an action `fooBarAction(…args)` with the same arguments, so the editor and the
// apply flow can call them without a second actions module.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (what: string) => z.string().regex(UUID_RE, `That ${what} wasn't found.`);
const blueprintId = id("Blueprint");
const orgId = id("client");
const BLUEPRINT_KEY_RE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const blueprintKey = z.string().regex(BLUEPRINT_KEY_RE, "Use 3 to 64 lower-case letters, digits and dashes for the key (no dash at either end).");
const name = z.string().trim().min(1, "Give it a name.").max(80, "Keep the name to 80 characters.");
const description = z.string().max(1000, "Keep the description to 1,000 characters.");
const industry = z.enum(BLUEPRINT_INDUSTRIES, { message: "Choose an industry." });
const version = z.number().int().min(1, "Choose a published version.").max(100_000, "Choose a published version.");
const versionOrDraft = z.union([z.literal("draft"), version]);
const revision = z.number().int().min(1).max(2_147_483_647);
const folderId = id("folder").nullable();
const logicalId = z.string().refine(isLogicalId, "That item isn't part of this Blueprint.");
const sections = z.array(z.enum(ASSET_SECTIONS)).max(ASSET_SECTIONS.length).refine((s) => new Set(s).size === s.length, "Each section can be chosen once.");
const STARTER_KEY_RE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

/** A read-only GoHighLevel scope. Some are camelCase ("locations/customFields.readonly"). */
const GHL_SCOPE_RE = /^[a-z][A-Za-z0-9./-]{2,60}\.readonly$/;

const refreshLibrary = () => revalidatePath("/admin/crm-blueprints", "layout");
/** A client's CRM changed (apply, rollback): its agency pages, its own CRM, and the library's application counts. */
function refreshClient(org: string) {
  refreshLibrary();
  revalidatePath(`/admin/clients/${org}`, "layout");
  revalidatePath("/crm", "layout");
}

const fail = (message: string): never => {
  throw new AppError("invalid_input", message);
};

// ---------------------------------------------------------------------------
// Library: Blueprints, details, drafts, publishing, archiving
// ---------------------------------------------------------------------------

const createFromSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("blank") }),
  z.strictObject({ kind: z.literal("starter"), starterKey: z.string().regex(STARTER_KEY_RE, "Choose a starter.") }),
  z.strictObject({ kind: z.literal("duplicate"), blueprintId, version: versionOrDraft }),
], { message: "Choose how to start the Blueprint." });

const createSchema = z.strictObject({
  name,
  key: blueprintKey.optional(),
  description: description.optional(),
  industry,
  folderId: folderId.optional(),
  from: createFromSchema,
});

export async function createBlueprintAction(input: z.input<typeof createSchema>) {
  return guard(async () => {
    const data = createSchema.parse(input);
    const res = await createBlueprint(await requireAgencyOrThrow(), data);
    refreshLibrary();
    return res;
  });
}

const detailsSchema = z.strictObject({
  name: name.optional(),
  description: description.optional(),
  industry: industry.optional(),
  folderId: folderId.optional(),
  featured: z.boolean().optional(),
});

export async function updateBlueprintDetailsAction(id: string, input: z.input<typeof detailsSchema>) {
  return guard(async () => {
    const bp = blueprintId.parse(id);
    const data = detailsSchema.parse(input);
    if (!Object.keys(data).length) fail("Nothing to change.");
    const res = await updateBlueprintDetails(await requireAgencyOrThrow(), bp, data);
    refreshLibrary();
    return res;
  });
}

/** Saves the working draft. The content is validated in full by the service (strict schema, references, unsafe content, secrets). */
export async function saveDraftAction(id: string, input: { content: unknown; revision: number }) {
  return guard(async () => {
    const bp = blueprintId.parse(id);
    const rev = revision.parse(input?.revision);
    if (!input || typeof input.content !== "object" || input.content === null || Array.isArray(input.content)) fail("The draft couldn't be read. Reload and try again.");
    if (Buffer.byteLength(JSON.stringify(input.content), "utf8") > BLUEPRINT_MAX_BYTES) fail(`A Blueprint can be at most ${BLUEPRINT_MAX_BYTES / 1000} KB.`);
    const res = await saveDraft(await requireAgencyOrThrow(), bp, { content: input.content as Parameters<typeof saveDraft>[2]["content"], revision: rev });
    refreshLibrary();
    return res;
  });
}

const publishSchema = z.strictObject({
  revision,
  changeSummary: z.string().trim().max(2000, "Keep the change summary to 2,000 characters.").optional(),
});

export async function publishBlueprintAction(id: string, input: z.input<typeof publishSchema>) {
  return guard(async () => {
    const bp = blueprintId.parse(id);
    const data = publishSchema.parse(input);
    const res = await publishBlueprint(await requireAgencyOrThrow(), bp, data);
    refreshLibrary();
    return res;
  });
}

export async function archiveBlueprintAction(id: string) {
  return guard(async () => {
    await archiveBlueprint(await requireAgencyOrThrow(), blueprintId.parse(id));
    refreshLibrary();
    return { archived: true as const };
  });
}

export async function unarchiveBlueprintAction(id: string) {
  return guard(async () => {
    await unarchiveBlueprint(await requireAgencyOrThrow(), blueprintId.parse(id));
    refreshLibrary();
    return { archived: false as const };
  });
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

export async function compareVersionsAction(id: string, from: number | "draft", to: number | "draft") {
  return guard(async () => {
    const bp = blueprintId.parse(id);
    const a = versionOrDraft.parse(from);
    const b = versionOrDraft.parse(to);
    if (a === b) fail("Choose two different versions to compare.");
    return compareVersions(await requireAgencyOrThrow(), bp, a, b);
  });
}

export async function getVersionContentAction(id: string, which: number | "draft") {
  return guard(async () => getVersionContent(await requireAgencyOrThrow(), blueprintId.parse(id), versionOrDraft.parse(which)));
}

/** Copies a published version into the working draft. Nothing published changes and no client is affected. */
export async function restoreVersionToDraftAction(id: string, which: number) {
  return guard(async () => {
    const res = await restoreVersionToDraft(await requireAgencyOrThrow(), blueprintId.parse(id), version.parse(which));
    refreshLibrary();
    return res;
  });
}

// ---------------------------------------------------------------------------
// Library folders and iAcquire starters
// ---------------------------------------------------------------------------

const folderName = z.string().trim().min(1, "Give the folder a name.").max(60, "Keep folder names to 60 characters.");

export async function createLibraryFolderAction(folder: string) {
  return guard(async () => {
    const res = await createLibraryFolder(await requireAgencyOrThrow(), folderName.parse(folder));
    refreshLibrary();
    return res;
  });
}

export async function renameLibraryFolderAction(id: string, folder: string) {
  return guard(async () => {
    await renameLibraryFolder(await requireAgencyOrThrow(), z.string().regex(UUID_RE, "That folder wasn't found.").parse(id), folderName.parse(folder));
    refreshLibrary();
    return { renamed: true as const };
  });
}

/** Deletes a library folder. Blueprints in it stay in the library, unfiled. */
export async function deleteLibraryFolderAction(id: string) {
  return guard(async () => {
    await deleteLibraryFolder(await requireAgencyOrThrow(), z.string().regex(UUID_RE, "That folder wasn't found.").parse(id));
    refreshLibrary();
    return { deleted: true as const };
  });
}

export async function installStarterAction(starterKey: string) {
  return guard(async () => {
    const res = await installStarter(await requireAgencyOrThrow(), z.string().regex(STARTER_KEY_RE, "That starter wasn't found.").parse(starterKey));
    refreshLibrary();
    return res;
  });
}

// ---------------------------------------------------------------------------
// Imports: package files and GoHighLevel
// ---------------------------------------------------------------------------

/**
 * Reads a package file's text (read in the browser with file.text(); never a URL). The size is checked here before anything parses it, and
 * the service checks format, integrity, upgrades, strict validation and unsafe content, then records a previewed import.
 */
export async function previewPackageImportAction(json: string) {
  return guard(async () => {
    if (typeof json !== "string" || !json.trim()) fail("Choose an iAcquire Blueprint package file (.json).");
    const bytes = Buffer.byteLength(json, "utf8");
    if (bytes > BLUEPRINT_MAX_BYTES) fail(`The file is ${Math.ceil(bytes / 1000)} KB; the limit is ${BLUEPRINT_MAX_BYTES / 1000} KB.`);
    const res = await previewPackageImport(await requireAgencyOrThrow(), json);
    refreshLibrary();
    return res;
  });
}

const saveImportSchema = z.strictObject({
  name: name.optional(),
  key: blueprintKey.optional(),
  industry: industry.optional(),
  assetIds: z.array(logicalId).min(1, "Choose at least one asset to keep.").max(5000).optional(),
});

/** Saves a previewed import (package file or GoHighLevel) as a new draft Blueprint. GoHighLevel IDs stay in the import record only. */
export async function saveImportAction(importId: string, input: z.input<typeof saveImportSchema> = {}) {
  return guard(async () => {
    const imp = id("import").parse(importId);
    const res = await saveImport(await requireAgencyOrThrow(), imp, saveImportSchema.parse(input));
    refreshLibrary();
    return res;
  });
}

export async function discardImportAction(importId: string) {
  return guard(async () => {
    await discardImport(await requireAgencyOrThrow(), id("import").parse(importId));
    refreshLibrary();
    return { discarded: true as const };
  });
}

const ghlSourceSchema = z.strictObject({
  label: z.string().trim().min(1, "Name this template sub-account.").max(120, "Keep the name to 120 characters."),
  locationId: z.string().trim().regex(GHL_LOCATION_RE, "Paste the sub-account's location ID (10 to 40 letters and digits)."),
  // Never echoed: the messages below are the only things said about it.
  token: z.string().trim().min(16, "Paste the private integration token.").max(4096, "That doesn't look like a private integration token.").regex(/^\S+$/, "That doesn't look like a private integration token."),
  scopes: z.array(z.string().regex(GHL_SCOPE_RE, "Only read-only scopes can be used.")).min(1, "Choose the read-only scopes the token was given.").max(30),
});

/**
 * Saves an agency-owned template sub-account (where a GoHighLevel snapshot is installed) with a read-only private integration token. The
 * token goes to the credential vault and is never returned, logged or shown again. Client locations and the protected locations are refused.
 */
export async function saveGhlTemplateSourceAction(input: z.input<typeof ghlSourceSchema>) {
  return guard(async () => {
    const data = ghlSourceSchema.parse(input);
    // Aster Homes and the agency's own location (not a tenant) are never read. The service and the database refuse them too.
    if (isProtectedGhlLocation(data.locationId)) fail("That GoHighLevel location is protected and can't be used as an import source.");
    const res = await saveGhlTemplateSource(await requireAgencyOrThrow(), { ...data, scopes: [...new Set(data.scopes)] });
    refreshLibrary();
    return { id: res.id };
  });
}

/**
 * GoHighLevel reads per agency person. An import makes up to 60 read-only requests (and a source check one), so repeated clicks can't
 * flood a location or use up its API allowance. Counted after the input is checked and before anything is read.
 */
const GHL_READ_LIMIT: RateLimitRule = { name: "crm-blueprint:ghl-read", limit: 15, windowSeconds: 600 };

async function limitGhlReads(): Promise<void> {
  const user = await requireAgencyOrThrow();
  const limit = await consumeRateLimit(GHL_READ_LIMIT, user.id);
  if (!limit.allowed) {
    throw new AppError("rate_limited", "Too many GoHighLevel reads in a short time. Please wait a few minutes, then try again.", { retryAfterSeconds: limit.retryAfterSeconds });
  }
}

/** One read-only identity check against the sub-account, recording which read scopes work. */
export async function testGhlTemplateSourceAction(sourceId: string) {
  return guard(async () => {
    const source = id("import source").parse(sourceId);
    await limitGhlReads();
    const res = await testGhlTemplateSource(await requireAgencyOrThrow(), source);
    refreshLibrary();
    return res;
  });
}

/** Removes the source and its stored token from iAcquire. Nothing changes in GoHighLevel. */
export async function removeGhlTemplateSourceAction(sourceId: string) {
  return guard(async () => {
    await removeGhlTemplateSource(await requireAgencyOrThrow(), id("import source").parse(sourceId));
    refreshLibrary();
    return { removed: true as const };
  });
}

const ghlImportSchema = z.strictObject({
  sourceRef: z.string().regex(/^(client|agency):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Choose a GoHighLevel source."),
  includeValues: z.boolean(),
  includePlaceholders: z.boolean(),
});

/** Reads the source through GoHighLevel's documented read-only API (GET only), converts what it exposes, and records a previewed import. */
export async function runGhlImportAction(input: z.input<typeof ghlImportSchema>) {
  return guard(async () => {
    const data = ghlImportSchema.parse(input);
    await limitGhlReads();
    const res = await runGhlImport(await requireAgencyOrThrow(), data);
    refreshLibrary();
    return res;
  });
}

// ---------------------------------------------------------------------------
// Capture from a client's Native CRM (configuration only)
// ---------------------------------------------------------------------------

export async function previewCaptureAction(org: string) {
  return guard(async () => previewCapture(await requireAgencyOrThrow(), orgId.parse(org)));
}

const captureSchema = z.strictObject({
  name,
  key: blueprintKey.optional(),
  description: description.optional(),
  industry,
  sections: sections.min(1, "Choose at least one part of the CRM to capture."),
  assetIds: z.array(logicalId).min(1, "Choose at least one item to capture.").max(5000).optional(),
  includeValues: z.boolean(),
});

/** Creates a new draft Blueprint from the client's configuration. Contacts, messages, appointments, deals, credentials and people never travel. */
export async function captureFromClientAction(org: string, input: z.input<typeof captureSchema>) {
  return guard(async () => {
    const target = orgId.parse(org);
    const res = await captureFromClient(await requireAgencyOrThrow(), target, captureSchema.parse(input));
    refreshLibrary();
    return res;
  });
}

// ---------------------------------------------------------------------------
// Applying to a client, and rolling back
// ---------------------------------------------------------------------------

const optionsSchema = z.strictObject({
  strategy: z.enum(APPLY_STRATEGIES, { message: "Choose how to treat what the client already has." }),
  sections: sections.optional(),
  assetIds: z.array(logicalId).max(5000).optional(),
  decisions: z.record(logicalId, z.enum(CONFLICT_DECISIONS)).optional(),
  // An empty value clears a role an earlier application mapped ("leave it for the client").
  slotMappings: z.record(logicalId, z.union([z.literal(""), z.string().regex(/^[A-Za-z0-9_-]{1,80}$/, "Choose who or what each role maps to.")])).optional(),
});

const planSchema = z.strictObject({ blueprintId, version: version.optional(), options: optionsSchema });

/** Dry run: every proposed change for this client, with a digest. Writes nothing. */
export async function planApplicationAction(org: string, input: z.input<typeof planSchema>) {
  return guard(async () => planApplication(await requireAgencyOrThrow(), orgId.parse(org), planSchema.parse(input)));
}

/** The dry run with everything the confirmation screen shows: the plan, the roles to map with this client's candidates, and the setup that follows. */
export async function previewApplicationAction(org: string, input: z.input<typeof planSchema>) {
  return guard(async () => previewApplication(await requireAgencyOrThrow(), orgId.parse(org), planSchema.parse(input)));
}

const applySchema = z.strictObject({
  blueprintId,
  version,
  options: optionsSchema,
  planDigest: z.string().regex(/^[0-9a-f]{64}$/, "Preview the changes again before confirming."),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,80}$/, "This confirmation can't be identified. Preview again and confirm."),
});

/**
 * Applies the previewed plan. Refused when the workspace changed since the preview (re-planned under a lock); a resubmitted confirmation
 * returns the first result.
 */
export async function applyBlueprintAction(org: string, input: z.input<typeof applySchema>) {
  return guard(async () => {
    const target = orgId.parse(org);
    const res = await applyBlueprint(await requireAgencyOrThrow(), target, applySchema.parse(input), { via: "agency" });
    refreshClient(target);
    return res;
  });
}

/**
 * Rolls back the newest live application of a Blueprint in a workspace: removes what it created that is unchanged and unused, restores what it
 * updated if unchanged, and keeps everything else with a reason.
 */
export async function rollbackApplicationAction(org: string, applicationId: string) {
  return guard(async () => {
    const target = orgId.parse(org);
    const res = await rollbackApplication(await requireAgencyOrThrow(), target, id("application").parse(applicationId));
    refreshClient(target);
    return res;
  });
}

export async function getApplicationAction(org: string, applicationId: string) {
  return guard(async () => getApplication(await requireAgencyOrThrow(), orgId.parse(org), id("application").parse(applicationId)));
}
