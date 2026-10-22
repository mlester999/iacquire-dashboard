"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { guard } from "@/server/action-guard";
import { resolveCrmActor } from "@/server/crm/request";
import type { CrmActor } from "@/server/crm/actor";
import { approveDraft, assignCase, closeCase, escalateCase, pauseCase, rejectDraft, resumeCase, retryCase } from "@/server/missed-calls/ops";
import { activatePolicy, savePolicy } from "@/server/missed-calls/policy";
import type { Permission } from "@/lib/permissions";

// Server actions for missed-call recovery (CRM → Calls → Recovery). The rules are in src/server/missed-calls; these parse input, resolve who is acting
// and refresh the screens. Anything that changes who owns a case names the owner version the person was looking at.

const uuid = z.string().uuid({ error: "Choose an item from the list." });
const orgArg = z.string().uuid().nullable().optional();
const version = z.number().int().min(0);

function refresh(actor: CrmActor) {
  revalidatePath("/crm", "layout");
  revalidatePath("/inbox");
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

export async function assignMissedCallAction(orgId: string | null, id: string, userId: string | null, ownerVersion: number) {
  return act(orgId, "calls.view", async (a) => {
    await assignCase(a, uuid.parse(id), userId === null ? null : uuid.parse(userId), version.parse(ownerVersion));
    return true;
  });
}

export async function pauseMissedCallAction(orgId: string | null, id: string, ownerVersion: number) {
  return act(orgId, "calls.view", async (a) => {
    await pauseCase(a, uuid.parse(id), version.parse(ownerVersion));
    return true;
  });
}

export async function resumeMissedCallAction(orgId: string | null, id: string, ownerVersion: number) {
  return act(orgId, "calls.view", async (a) => {
    await resumeCase(a, uuid.parse(id), version.parse(ownerVersion));
    return true;
  });
}

export async function closeMissedCallAction(orgId: string | null, id: string, outcome: "recovered" | "no_recovery" | "canceled", note?: string | null) {
  return act(orgId, "calls.view", async (a) => {
    await closeCase(a, uuid.parse(id), z.enum(["recovered", "no_recovery", "canceled"]).parse(outcome), note ?? undefined);
    return true;
  });
}

export async function retryMissedCallAction(orgId: string | null, id: string) {
  return act(orgId, "calls.view", async (a) => {
    await retryCase(a, uuid.parse(id));
    return true;
  });
}

export async function escalateMissedCallAction(orgId: string | null, id: string) {
  return act(orgId, "calls.view", async (a) => {
    await escalateCase(a, uuid.parse(id));
    return true;
  });
}

export async function approveRecoveryDraftAction(orgId: string | null, caseId: string, actionId: string, input: { body?: string | null; expectedOwnerVersion: number }) {
  return act(orgId, "calls.view", (a) => approveDraft(a, uuid.parse(caseId), uuid.parse(actionId), { body: input.body ?? null, expectedOwnerVersion: version.parse(input.expectedOwnerVersion) }));
}

export async function rejectRecoveryDraftAction(orgId: string | null, caseId: string, actionId: string, ownerVersion: number) {
  return act(orgId, "calls.view", async (a) => {
    await rejectDraft(a, uuid.parse(caseId), uuid.parse(actionId), version.parse(ownerVersion));
    return true;
  });
}

export async function saveRecoveryPolicyAction(orgId: string | null, input: unknown) {
  return act(orgId, "messaging.configure", async (a) => {
    const p = await savePolicy(a, input);
    return { version: p.version };
  });
}

export async function activateRecoveryPolicyAction(orgId: string | null, expectedVersion: number) {
  return act(orgId, "messaging.configure", async (a) => {
    const p = await activatePolicy(a, version.parse(expectedVersion));
    return { version: p.version };
  });
}
