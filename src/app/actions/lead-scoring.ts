"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { guard } from "@/server/action-guard";
import { resolveCrmActor } from "@/server/crm/request";
import type { CrmActor } from "@/server/crm/actor";
import { backfillUnscored, clearOverride, reassessNow, setOverride } from "@/server/lead-scoring/priority";
import { saveProfile } from "@/server/lead-scoring/profile";
import type { Permission } from "@/lib/permissions";

// Server actions for lead priority: a contact's manual override and re-check, and the workspace's scoring settings. The rules (who may do what, what is
// allowed to score, how often) are in src/server/lead-scoring; these parse input, resolve who is acting and refresh the screens.

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

export async function setPriorityOverrideAction(orgId: string | null, contactId: string, input: unknown) {
  return act(orgId, "contacts.edit", async (actor) => {
    await setOverride(actor, uuid.parse(contactId), input);
    return true;
  });
}

export async function clearPriorityOverrideAction(orgId: string | null, contactId: string) {
  return act(orgId, "contacts.edit", async (actor) => {
    await clearOverride(actor, uuid.parse(contactId));
    return true;
  });
}

export async function reassessLeadAction(orgId: string | null, contactId: string) {
  return act(orgId, "contacts.view", async (actor) => {
    const r = await reassessNow(actor, uuid.parse(contactId));
    return r.outcome;
  });
}

export async function saveScoringProfileAction(orgId: string | null, input: unknown) {
  return act(orgId, "pipelines.manage", async (actor) => {
    const p = await saveProfile(actor, input);
    return { version: p.version };
  });
}

export async function backfillLeadScoresAction(orgId: string | null) {
  return act(orgId, "pipelines.manage", (actor) => backfillUnscored(actor));
}
