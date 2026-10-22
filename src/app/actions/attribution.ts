"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { guard } from "@/server/action-guard";
import { resolveCrmActor } from "@/server/crm/request";
import type { CrmActor } from "@/server/crm/actor";
import { addCost, removeCost } from "@/server/attribution/costs";
import { recordManualTouch } from "@/server/attribution/touches";
import type { Permission } from "@/lib/permissions";

// Server actions for lead attribution: a person's own choice of a contact's source, and campaign costs entered by hand. What each person may do is decided
// in src/server/attribution; these parse input, resolve who is acting and refresh the screens.

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

const sourceSchema = z.object({ source: z.string().max(80), medium: z.string().max(80).nullish(), campaign: z.string().max(120).nullish() });

export async function recordSourceAction(orgId: string | null, contactId: string, input: unknown) {
  return act(orgId, "contacts.edit", async (actor) => {
    const i = sourceSchema.parse(input);
    await recordManualTouch(actor, { contactId: uuid.parse(contactId), source: i.source, medium: i.medium ?? null, campaign: i.campaign ?? null });
    return true;
  });
}

const costSchema = z.object({
  source: z.string().max(80), campaign: z.string().max(120).nullish(), periodStart: z.string(), periodEnd: z.string(), amount: z.number(), currency: z.string().max(3), note: z.string().max(300).nullish(),
});

export async function addCostAction(orgId: string | null, input: unknown) {
  return act(orgId, "analytics.export", async (actor) => {
    const i = costSchema.parse(input);
    const c = await addCost(actor, { ...i, campaign: i.campaign ?? null, note: i.note ?? null });
    return { id: c.id };
  });
}

export async function removeCostAction(orgId: string | null, id: string) {
  return act(orgId, "analytics.export", async (actor) => {
    await removeCost(actor, uuid.parse(id));
    return true;
  });
}
