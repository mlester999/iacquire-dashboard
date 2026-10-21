"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { guard } from "@/server/action-guard";
import { resolveCrmActor } from "@/server/crm/request";
import type { CrmActor } from "@/server/crm/actor";
import { publishWorkflow, requestWorkflowApproval, restoreVersionAsDraft, setWorkflowStatus, type PublishResult } from "@/server/crm/workflows/definitions";
import { startTestRun } from "@/server/crm/workflows/runs";
import { saveStudioDraft, startStudioWorkflow } from "@/server/automation-studio/studio";
import { createStudioFromTemplate } from "@/server/automation-studio/templates";
import { createConnection, listConnectionCalls, revokeConnection, rotateConnectionSecret, testConnection } from "@/server/automation-studio/connections";
import { toTestRunView } from "@/components/crm/workflows/run-format";
import type { ChangeSource } from "@/lib/automation-studio/types";
import type { Permission } from "@/lib/permissions";

// Server actions for the Automation Studio screens. Every rule (the plan, permissions, revision checks, validation against the workspace, the
// owner's approval, what may be switched on) lives in the services; these parse input, resolve who is acting, and refresh the screens. A person
// always acts on their own workspace: there is no way to name another one here.

const MANAGE: Permission = "workflows.manage";
const uuid = z.string().uuid("That item no longer exists. Reload and try again.");

async function act<T>(permission: Permission, fn: (actor: CrmActor) => Promise<T>, opts: { refresh?: boolean } = {}) {
  return guard(async () => {
    const actor = await resolveCrmActor(null, permission);
    const out = await fn(actor);
    if (opts.refresh !== false) revalidatePath("/automation-studio", "layout");
    return out;
  });
}

const startSchema = z.object({ prompt: z.string().trim().min(1, "Say what you'd like to automate.").max(4000, "Keep it under 4,000 characters.") });
/** Starts an automation from a sentence. Returns its id; the workspace page answers the stored message. */
export async function startAutomationAction(input: z.input<typeof startSchema>) {
  return act(MANAGE, async (actor) => {
    const { prompt } = startSchema.parse(input);
    const { id } = await startStudioWorkflow(actor, { prompt });
    return { id };
  });
}

/** Starts an empty automation to build by hand. */
export async function startBlankAutomationAction() {
  return act(MANAGE, async (actor) => ({ id: (await startStudioWorkflow(actor, { name: "New automation" })).id }));
}

const sourceSchema = z.enum(["manual", "undo", "redo", "restore"]);
const saveSchema = z.object({ definition: z.unknown(), expectedRevision: z.number().int().min(1), source: sourceSchema.default("manual"), label: z.string().trim().min(1).max(280) });
/** Saves the working copy from the editor (a person's change, an undo or redo). The builder saves its own changes on the server. */
export async function saveStudioDraftAction(id: string, input: z.input<typeof saveSchema>) {
  return act(MANAGE, async (actor) => {
    const d = saveSchema.parse(input);
    return saveStudioDraft(actor, uuid.parse(id), { definition: d.definition, expectedRevision: d.expectedRevision, source: d.source as ChangeSource, label: d.label });
  }, { refresh: false });
}

export interface PublishOutcome {
  published: PublishResult;
  /** What happened to switching on: "on" (it is running), "waiting_for_owner" (the owner must approve it first), "not_requested". */
  activation: "on" | "waiting_for_owner" | "not_requested";
  approvalId: string | null;
}

const publishSchema = z.object({ expectedRevision: z.number().int().min(1).optional(), turnOn: z.boolean().default(false) });
/**
 * Freezes the working copy into a new version and, when asked, switches it on. A version that messages customers, calls an outside system or
 * asks an AI employee waits for the owner to approve exactly that version (Approvals); nothing in this action can skip that.
 */
export async function publishStudioWorkflowAction(id: string, input: z.input<typeof publishSchema> = {}) {
  return act(MANAGE, async (actor): Promise<PublishOutcome> => {
    const d = publishSchema.parse(input);
    const wid = uuid.parse(id);
    const published = await publishWorkflow(actor, wid, { expectedRevision: d.expectedRevision });
    if (!d.turnOn) return { published, activation: "not_requested", approvalId: null };
    if (published.needsApproval) {
      const req = await requestWorkflowApproval(actor, wid, published.versionId, { activate: true });
      if (req.status === "requested" || req.status === "pending") return { published, activation: "waiting_for_owner", approvalId: req.approvalId };
    }
    await setWorkflowStatus(actor, wid, "active");
    return { published, activation: "on", approvalId: null };
  });
}

const statusSchema = z.enum(["active", "paused", "archived", "draft"]);
export async function setStudioWorkflowStatusAction(id: string, status: z.input<typeof statusSchema>) {
  return act(MANAGE, (actor) => setWorkflowStatus(actor, uuid.parse(id), statusSchema.parse(status)));
}

/** Puts an earlier published version's content back into the working copy (the published version keeps running as it was). */
export async function restoreStudioVersionAction(id: string, versionId: string, expectedRevision?: number) {
  return act(MANAGE, async (actor) => {
    const r = await restoreVersionAsDraft(actor, uuid.parse(id), uuid.parse(versionId), { expectedRevision });
    return { revision: r.revision, version: r.version };
  }, { refresh: false });
}

const testSchema = z.object({ contactId: uuid.nullable().optional() });
/** A dry run of the working copy for one contact: what each step would do. Nothing is sent, called or changed. */
export async function testStudioDraftAction(id: string, input: z.input<typeof testSchema> = {}) {
  return act(MANAGE, async (actor) => toTestRunView(await startTestRun(actor, uuid.parse(id), { ...testSchema.parse(input), source: "draft" })), { refresh: false });
}

// ---- Connections (HTTP APIs and Slack webhooks) ----------------------------------------------------------------------------------------
// A secret travels from the form to the server once and is stored encrypted; nothing here ever returns one.

/** Sets up a connection. The input is checked by the service (shape, address policy, plan, permission); the reply holds no secret. */
export async function createConnectionAction(input: unknown) {
  return act(MANAGE, (actor) => createConnection(actor, input));
}

const testConnectionSchema = z.object({ confirmed: z.boolean() });
/** Sends the one test that verifies a connection, only when the person has confirmed exactly what will be sent and where. */
export async function testConnectionAction(id: string, input: z.input<typeof testConnectionSchema>) {
  return act(MANAGE, (actor) => testConnection(actor, uuid.parse(id), testConnectionSchema.parse(input)));
}

const secretSchema = z.string().min(1, "Enter the new value.").max(2000);
export async function rotateConnectionAction(id: string, secret: string) {
  return act(MANAGE, (actor) => rotateConnectionSecret(actor, uuid.parse(id), secretSchema.parse(secret)));
}

export async function revokeConnectionAction(id: string) {
  return act(MANAGE, (actor) => revokeConnection(actor, uuid.parse(id)));
}

/** The recent calls of one connection (host, path, outcome; never contents), for its log. */
export async function connectionCallsAction(id: string) {
  return act("workflows.view", (actor) => listConnectionCalls(actor, uuid.parse(id), 30), { refresh: false });
}

// ---- Ready-made automations ------------------------------------------------------------------------------------------------------------

const templateSchema = z.object({ name: z.string().trim().min(1).max(80).optional(), inputs: z.record(z.string(), z.unknown()).default({}) });
/** Creates an automation from a template with the workspace's own choices. Every choice is checked against the workspace by the service. */
export async function createFromStudioTemplateAction(key: string, input: z.input<typeof templateSchema>) {
  return act(MANAGE, async (actor) => {
    const d = templateSchema.parse(input);
    const { id, issues } = await createStudioFromTemplate(actor, z.string().max(80).parse(key), { name: d.name, inputs: d.inputs });
    return { id, problems: issues.filter((i) => i.level === "error").length };
  });
}
