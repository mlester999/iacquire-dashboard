"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { guard } from "@/server/action-guard";
import { AppError } from "@/server/errors";
import { requireAgencyOrThrow } from "@/server/tenancy/context";
import { canDoBlueprint, canReachClient } from "@/server/crm/blueprints/access";
import { compareVersions, saveDraft } from "@/server/crm/blueprints/library";
import { applyBlueprint, previewApplication } from "@/server/crm/blueprints/apply";
import { getBlueprintChecklistForOrg } from "@/server/crm/blueprints/checklist";
import { jsonBytes } from "@/lib/crm/blueprints/canonical";
import { changedSections } from "@/lib/crm/blueprints/diff";
import {
  APPLY_STRATEGIES, ASSET_SECTIONS, BLUEPRINT_MAX_BYTES, CONFLICT_DECISIONS, LOGICAL_ID_MAX, isLogicalId,
  type ApplyOptions, type AssetSection, type BlueprintContent,
} from "@/lib/crm/blueprints/types";
import type { ApplyPreview, ApplyResult, SetupChecklist } from "@/lib/crm/blueprints/views";

// The Blueprint editor's save and the Apply-to-client wizard's dry run and confirmation. Every action resolves the signed-in agency person
// on the server and hands them to the library and apply services, which check the step's permission (and, for a client, that person's
// access to that exact client) again inside their own transaction. Nothing here trusts the browser about who may do what.

const uuid = (what: string) => z.string().uuid({ error: `That ${what} wasn't found.` });
const logicalId = z.string().max(LOGICAL_ID_MAX).refine(isLogicalId, "That item isn't part of this Blueprint.");

const optionsSchema = z.strictObject({
  strategy: z.enum(APPLY_STRATEGIES, { error: "Choose how existing items are treated." }),
  sections: z.array(z.enum(ASSET_SECTIONS)).min(1, { error: "Choose at least one section to apply." }).max(ASSET_SECTIONS.length).optional(),
  assetIds: z.array(logicalId).max(5000).optional(),
  decisions: z.record(logicalId, z.enum(CONFLICT_DECISIONS)).optional(),
  // An empty value clears a role an earlier application mapped ("leave it for the client").
  slotMappings: z.record(logicalId, z.union([z.literal(""), z.string().uuid({ error: "That person or connection wasn't found." })])).optional(),
});

const planInput = z.strictObject({
  blueprintId: uuid("Blueprint"),
  version: z.number().int().min(1, { error: "Choose a published version." }),
  options: optionsSchema,
});

const applyInput = planInput.extend({
  planDigest: z.string().regex(/^[0-9a-f]{64}$/, { error: "Preview again before confirming." }),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,80}$/, { error: "This confirmation can't be identified. Preview again and confirm." }),
});

/** Saves the editor's working draft. The content is checked in full by the library (structure, size, references, unsafe content). */
export async function saveBlueprintDraftAction(blueprintId: string, input: { content: unknown; revision: number }) {
  return guard(async () => {
    const id = uuid("Blueprint").parse(blueprintId);
    const revision = z.number().int().min(1).parse(input?.revision);
    if (!input?.content || typeof input.content !== "object" || Array.isArray(input.content)) throw new AppError("invalid_input", "There's nothing to save.");
    const bytes = jsonBytes(input.content);
    if (bytes > BLUEPRINT_MAX_BYTES) {
      throw new AppError("invalid_input", `This Blueprint is ${Math.ceil(bytes / 1000)} KB; a Blueprint can be at most ${BLUEPRINT_MAX_BYTES / 1000} KB.`);
    }
    const user = await requireAgencyOrThrow();
    const res = await saveDraft(user, id, { content: input.content as BlueprintContent, revision });
    revalidatePath("/admin/crm-blueprints", "layout");
    return { revision: res.revision, errors: res.errors.length, warnings: res.warnings.length };
  });
}

/** The dry run: every proposed change for this client, the roles to map with the client's own candidates, and the setup that follows. Writes nothing. */
export async function previewBlueprintApplyAction(orgId: string, input: { blueprintId: string; version: number; options: ApplyOptions }) {
  return guard(async (): Promise<ApplyPreview> => {
    const client = uuid("client").parse(orgId);
    const data = planInput.parse(input);
    const user = await requireAgencyOrThrow();
    return previewApplication(user, client, { blueprintId: data.blueprintId, version: data.version, options: data.options });
  });
}

/**
 * Applies the confirmed plan. The apply service plans again under the workspace lock and refuses when the digest differs (the wizard then
 * previews again); the same idempotency key returns the first result instead of applying twice.
 */
export async function applyBlueprintToClientAction(orgId: string, input: { blueprintId: string; version: number; options: ApplyOptions; planDigest: string; idempotencyKey: string }) {
  return guard(async (): Promise<ApplyResult> => {
    const client = uuid("client").parse(orgId);
    const data = applyInput.parse(input);
    const user = await requireAgencyOrThrow();
    const res = await applyBlueprint(user, client, data, { via: "agency" });
    revalidatePath("/admin/crm-blueprints", "layout");
    revalidatePath(`/admin/clients/${client}`, "layout");
    revalidatePath("/crm", "layout");
    return res;
  });
}

/** The sections a newer version changes compared with the version a client has, for an update review. */
export async function blueprintChangedSectionsAction(blueprintId: string, from: number, to: number) {
  return guard(async (): Promise<AssetSection[]> => {
    const id = uuid("Blueprint").parse(blueprintId);
    const a = z.number().int().min(1).parse(from);
    const b = z.number().int().min(1).parse(to);
    const user = await requireAgencyOrThrow();
    if (a === b) return [];
    return changedSections(await compareVersions(user, id, a, b));
  });
}

/** The client's setup checklist (what its workspace shows as done, on evidence), for the wizard's result. */
export async function clientBlueprintChecklistAction(orgId: string) {
  return guard(async (): Promise<SetupChecklist> => {
    const client = uuid("client").parse(orgId);
    const user = await requireAgencyOrThrow();
    if (!canDoBlueprint(user, "inspect") || !(await canReachClient(user, client))) throw new AppError("not_found", "Client not found.");
    return getBlueprintChecklistForOrg(client);
  });
}
