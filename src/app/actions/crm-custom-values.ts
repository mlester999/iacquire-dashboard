"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { guard } from "@/server/action-guard";
import { resolveCrmActor } from "@/server/crm/request";
import type { CrmActor } from "@/server/crm/actor";
import { createCustomValue, deleteCustomValue, getCustomValue, updateCustomValue } from "@/server/crm/custom-values";
import { CUSTOM_VALUE_LIMITS, CUSTOM_VALUE_TYPES } from "@/lib/crm/custom-values";
import type { Permission } from "@/lib/permissions";

// Server actions for workspace configuration values (/crm/settings/values and the agency's view of it). Every rule lives in the service;
// these only parse input, resolve who is acting and refresh the screens that show values (settings and the template editor).

const uuid = z.string().uuid();
const orgArg = z.string().uuid().nullable().optional();

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

const text = (max: number) => z.string().max(max, `Keep it under ${max.toLocaleString("en-US")} characters.`);

const inputSchema = z.object({
  key: text(CUSTOM_VALUE_LIMITS.key).optional(),
  label: text(200).optional(),
  type: z.enum(CUSTOM_VALUE_TYPES, { error: "Choose a type from the list." }).optional(),
  // The service checks the exact limit after normalizing line endings; this only stops oversized payloads.
  value: text(CUSTOM_VALUE_LIMITS.value + 200).nullable().optional(),
  group: text(200).nullable().optional(),
  required: z.boolean().optional(),
});
const updateSchema = inputSchema.extend({ expectedUpdatedAt: z.string().datetime().optional() });

export async function createCustomValueAction(orgId: string | null, input: unknown) {
  return act(orgId, "fields.manage", (actor) => createCustomValue(actor, inputSchema.parse(input)));
}

export async function updateCustomValueAction(orgId: string | null, id: string, input: unknown) {
  return act(orgId, "fields.manage", (actor) => updateCustomValue(actor, uuid.parse(id), updateSchema.parse(input)));
}

export async function deleteCustomValueAction(orgId: string | null, id: string, confirmUsage = false) {
  return act(orgId, "fields.manage", (actor) => deleteCustomValue(actor, uuid.parse(id), { confirmUsage: z.boolean().parse(confirmUsage) }));
}

/** The latest state of one value (with where it is used), for a dialog that opens after the list was loaded. */
export async function getCustomValueAction(orgId: string | null, id: string) {
  return act(orgId, "crm.view", (actor) => getCustomValue(actor, uuid.parse(id)), { refresh: false });
}
