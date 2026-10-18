"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { guard } from "@/server/action-guard";
import { resolveCrmActor } from "@/server/crm/request";
import type { CrmActor } from "@/server/crm/actor";
import { createCallFollowUp, disconnectVoiceConnection, logCall, saveVoiceConnection, updateCall } from "@/server/crm/calls";
import type { Permission } from "@/lib/permissions";

// Server actions for CRM → Calls (/crm/calls) and the Calls section of a contact. Validation and every rule live in
// src/server/crm/calls.ts; these parse input, resolve who is acting and refresh the screens.

const uuid = z.string().uuid({ error: "Choose an item from the list." });
const orgArg = z.string().uuid().nullable().optional();

function refresh(actor: CrmActor) {
  revalidatePath("/crm", "layout");
  if (actor.kind === "agency") revalidatePath(`/admin/clients/${actor.orgId}/crm`, "layout");
}

async function act<T>(orgId: string | null | undefined, permission: Permission, fn: (actor: CrmActor) => Promise<T>) {
  return guard(async () => {
    const actor = await resolveCrmActor(orgArg.parse(orgId) ?? null, permission);
    const out = await fn(actor);
    refresh(actor);
    return out;
  });
}

const followUpSchema = z.object({
  title: z.string().max(400).nullable().optional(),
  dueAt: z.string().max(40).nullable().optional(),
  assigneeId: uuid.nullable().optional(),
});

const logSchema = z.object({
  contactId: uuid,
  direction: z.enum(["inbound", "outbound"], { error: "Choose whether the call was incoming or outgoing." }),
  status: z.enum(["completed", "no_answer", "busy", "voicemail", "failed"], { error: "Choose how the call ended." }),
  startedAt: z.string().min(1, { error: "Enter when the call took place." }).max(40),
  durationSeconds: z.number().int().min(0).max(86_400).nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  disposition: z.string().max(200).nullable().optional(),
  summary: z.string().max(8000).nullable().optional(),
  recordingConsent: z.enum(["unknown", "announced", "granted", "not_recorded"]).optional(),
  recordingUrl: z.string().max(1000).nullable().optional(),
  followUp: followUpSchema.nullable().optional(),
});

export async function logCallAction(orgId: string | null, input: z.input<typeof logSchema>) {
  return act(orgId, "calls.view", (actor) => logCall(actor, logSchema.parse(input)));
}

const updateSchema = z.object({
  notes: z.string().max(8000).nullable().optional(),
  disposition: z.string().max(200).nullable().optional(),
  contactId: uuid.nullable().optional(),
});

export async function updateCallAction(orgId: string | null, id: string, input: z.input<typeof updateSchema>) {
  return act(orgId, "calls.view", (actor) => updateCall(actor, uuid.parse(id), updateSchema.parse(input)));
}

export async function createCallFollowUpAction(orgId: string | null, id: string, input: z.input<typeof followUpSchema> = {}) {
  return act(orgId, "tasks.manage", (actor) => createCallFollowUp(actor, uuid.parse(id), followUpSchema.parse(input)));
}

const connectionSchema = z.object({
  provider: z.enum(["vapi", "retell"], { error: "Choose Vapi or Retell AI." }),
  externalIds: z.union([z.string().max(5000), z.array(z.string().max(200)).max(40)]),
  vapiAuthMode: z.string().max(40).nullable().optional(),
  secret: z.string().max(4000).nullable().optional(),
  storeRecordings: z.boolean(),
  recordingAnnounced: z.boolean().optional(),
});

export async function saveVoiceConnectionAction(orgId: string | null, input: z.input<typeof connectionSchema>) {
  return act(orgId, "calls.view", (actor) => saveVoiceConnection(actor, connectionSchema.parse(input)));
}

export async function disconnectVoiceConnectionAction(orgId: string | null, provider: "vapi" | "retell") {
  return act(orgId, "calls.view", (actor) => disconnectVoiceConnection(actor, z.enum(["vapi", "retell"]).parse(provider)));
}
