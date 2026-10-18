"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { guard } from "@/server/action-guard";
import { resolveCrmActor } from "@/server/crm/request";
import type { CrmActor } from "@/server/crm/actor";
import {
  cloneWorkflow, createFromTemplate, createWorkflow, moveWorkflowToFolder, publishWorkflow, requestWorkflowApproval, saveWorkflowDraft, setWorkflowStatus,
  updateWorkflowSettings,
} from "@/server/crm/workflows/definitions";
import { cancelRun, retryRunStep, skipRunStep, startManualRun, startTestRun } from "@/server/crm/workflows/runs";
import { toTestRunView } from "@/components/crm/workflows/run-format";
import type { Permission } from "@/lib/permissions";

// Server actions for the workflow screens (/crm/workflows and the agency's view of a client's). Every rule (permissions, revision checks,
// validation against the workspace, the owner's approval, what may be switched on) lives in the services; these parse input, resolve who
// is acting, and refresh the screens. Reading needs "See automations"; everything here changes something, so it needs "Build and change
// automations", checked again inside each service.

const uuid = z.string().uuid("That item no longer exists. Reload and try again.");
const orgArg = z.string().uuid().nullable().optional();
const MANAGE: Permission = "workflows.manage";

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

const name = z.string().max(200, "Keep the name to 80 characters.");
const folderId = uuid.nullable().optional();

const createSchema = z.object({ name, folderId, triggerType: z.string().max(60).nullable().optional() });
export async function createWorkflowAction(orgId: string | null, input: z.input<typeof createSchema>) {
  return act(orgId, MANAGE, (actor) => createWorkflow(actor, createSchema.parse(input)));
}

const templateChoice = z.union([
  z.string().max(64),
  z.object({ pipelineId: z.string().max(64), stageId: z.string().max(64) }),
  z.object({ templateId: z.string().max(64), contentHash: z.string().max(64).optional(), channel: z.string().max(16).optional() }),
  z.null(),
]);
const fromTemplateSchema = z.object({ name: name.optional(), folderId, inputs: z.record(z.string().max(40), templateChoice).optional() });
export async function createWorkflowFromTemplateAction(orgId: string | null, key: string, input: z.input<typeof fromTemplateSchema>) {
  return act(orgId, MANAGE, (actor) => createFromTemplate(actor, z.string().max(60).parse(key), fromTemplateSchema.parse(input)));
}

export async function cloneWorkflowAction(orgId: string | null, id: string) {
  return act(orgId, MANAGE, (actor) => cloneWorkflow(actor, uuid.parse(id)));
}

export async function moveWorkflowToFolderAction(orgId: string | null, id: string, folder: string | null) {
  return act(orgId, MANAGE, (actor) => moveWorkflowToFolder(actor, uuid.parse(id), folderId.parse(folder) ?? null));
}

const settingsSchema = z.object({
  name: name.optional(),
  description: z.string().max(2000).nullable().optional(),
  folderId,
  hourlyRunLimit: z.number().int("The hourly limit is a whole number from 1 to 10,000.").min(1, "The hourly limit is a whole number from 1 to 10,000.").max(10_000, "The hourly limit is a whole number from 1 to 10,000.").optional(),
});
export async function updateWorkflowSettingsAction(orgId: string | null, id: string, input: z.input<typeof settingsSchema>) {
  return act(orgId, MANAGE, (actor) => updateWorkflowSettings(actor, uuid.parse(id), settingsSchema.parse(input)));
}

/** Saves the editor's working copy. A save over someone else's newer one is refused (code "conflict"); nothing is overwritten. */
const draftSchema = z.object({ definition: z.unknown(), expectedRevision: z.number().int().min(1) });
export async function saveWorkflowDraftAction(orgId: string | null, id: string, input: z.input<typeof draftSchema>) {
  return act(orgId, MANAGE, (actor) => saveWorkflowDraft(actor, uuid.parse(id), draftSchema.parse(input)));
}

const publishSchema = z.object({ expectedRevision: z.number().int().min(1).optional() });
export async function publishWorkflowAction(orgId: string | null, id: string, input: z.input<typeof publishSchema> = {}) {
  return act(orgId, MANAGE, (actor) => publishWorkflow(actor, uuid.parse(id), publishSchema.parse(input)));
}

/** Asks the owner to approve the published version's exact content (and, with `activate`, to switch the workflow on when they do). */
export async function requestWorkflowApprovalAction(orgId: string | null, id: string, versionId: string, opts: { activate?: boolean } = {}) {
  return act(orgId, MANAGE, (actor) => requestWorkflowApproval(actor, uuid.parse(id), uuid.parse(versionId), { activate: z.boolean().optional().parse(opts.activate) }));
}

const statusSchema = z.enum(["draft", "active", "paused", "archived"]);
export async function setWorkflowStatusAction(orgId: string | null, id: string, status: z.input<typeof statusSchema>) {
  return act(orgId, MANAGE, (actor) => setWorkflowStatus(actor, uuid.parse(id), statusSchema.parse(status)));
}

/** A dry run for one contact: what each step would do. Nothing is sent, called or changed. */
const testSchema = z.object({ contactId: uuid.nullable().optional(), opportunityId: uuid.nullable().optional(), source: z.enum(["draft", "published"]).optional() });
export async function startTestRunAction(orgId: string | null, id: string, input: z.input<typeof testSchema> = {}) {
  return act(orgId, MANAGE, async (actor) => toTestRunView(await startTestRun(actor, uuid.parse(id), testSchema.parse(input))), { refresh: false });
}

/** Starts the published version now for one contact, gated step by step like any run. */
const manualSchema = z.object({ contactId: uuid.nullable().optional(), opportunityId: uuid.nullable().optional() });
export async function startManualRunAction(orgId: string | null, id: string, input: z.input<typeof manualSchema>) {
  return act(orgId, MANAGE, (actor) => startManualRun(actor, uuid.parse(id), manualSchema.parse(input)));
}

export async function cancelRunAction(orgId: string | null, runId: string) {
  return act(orgId, MANAGE, (actor) => cancelRun(actor, uuid.parse(runId)));
}

export async function retryRunStepAction(orgId: string | null, runId: string) {
  return act(orgId, MANAGE, (actor) => retryRunStep(actor, uuid.parse(runId)));
}

export async function skipRunStepAction(orgId: string | null, runId: string) {
  return act(orgId, MANAGE, (actor) => skipRunStep(actor, uuid.parse(runId)));
}
