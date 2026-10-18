"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { guard } from "@/server/action-guard";
import { resolveCrmActor } from "@/server/crm/request";
import type { CrmActor } from "@/server/crm/actor";
import {
  advanceSwitch, backupBeforeSwitch, cancelSwitch, completeCutover, cutoverSwitch, getProviderSwitchState, getSwitchReviewRows, previewSwitch, readRestOfSwitchStep, retrySwitchStep,
  rollbackSwitch, startSwitchDryRun,
} from "@/server/crm/provider-switch";
import { GHL_MIGRATION_ENTITIES } from "@/lib/crm/ghl-migration";
import { CRM_CAPABILITIES } from "@/lib/crm/types";
import type { Permission } from "@/lib/permissions";

// Server actions for Settings → CRM Provider (the client's own workspace, and the agency's view of it in a support session). Every rule lives
// in src/server/crm/provider-switch.ts: these only resolve the actor (a client member acts on their own workspace; an agency person names
// the client and needs a support session) and validate the arguments.

const uuid = z.string().uuid({ error: "That provider switch isn't valid." });
const orgArg = z.string().uuid().nullable().optional();
const input = z.object({
  to: z.enum(["native", "ghl"], { error: "Choose where the capabilities move." }),
  capabilities: z.array(z.enum(CRM_CAPABILITIES, { error: "That isn't a CRM capability." })).min(1, { error: "Choose at least one capability to move." }).max(CRM_CAPABILITIES.length),
});
const duplicates = z.enum(["update", "review", "skip"], { error: "Choose what happens when a record already exists here." }).optional();
const entity = z.enum(GHL_MIGRATION_ENTITIES, { error: "Choose a migration step." });

/** The CRM layout and every screen show ownership, so a switch refreshes the whole CRM for the client and the agency's view of it. */
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

/** The provider screen's state (anyone in the workspace may look). */
export async function providerSwitchStateAction(orgId: string | null) {
  return act(orgId, "crm.view", (actor) => getProviderSwitchState(actor), { refresh: false });
}

/** What a switch would change, per capability. Read-only: GoHighLevel is only read (GET requests), and nothing is stored. */
export async function previewSwitchAction(orgId: string | null, raw: { to: string; capabilities: string[] }) {
  return act(orgId, "crm.provider.manage", (actor) => previewSwitch(actor, input.parse(raw)), { refresh: false });
}

/** Records the switch and takes the backup (nothing about ownership changes yet). */
export async function backupSwitchAction(orgId: string | null, raw: { to: string; capabilities: string[] }) {
  return act(orgId, "crm.provider.manage", (actor) => backupBeforeSwitch(actor, input.parse(raw)));
}

export async function startSwitchDryRunAction(orgId: string | null, switchId: string, onExisting?: string) {
  return act(orgId, "crm.provider.manage", (actor) => startSwitchDryRun(actor, uuid.parse(switchId), { duplicates: duplicates.parse(onExisting) }));
}

/** Moves a switch forward (progress polling) and returns it. */
export async function advanceSwitchAction(orgId: string | null, switchId: string) {
  return act(orgId, "crm.provider.manage", (actor) => advanceSwitch(actor, uuid.parse(switchId)), { refresh: false });
}

export async function cutoverSwitchAction(orgId: string | null, switchId: string) {
  return act(orgId, "crm.provider.manage", (actor) => cutoverSwitch(actor, uuid.parse(switchId)));
}

export async function completeSwitchAction(orgId: string | null, switchId: string, acknowledge?: boolean) {
  return act(orgId, "crm.provider.manage", (actor) => completeCutover(actor, uuid.parse(switchId), { acknowledge: z.boolean().optional().parse(acknowledge) }));
}

export async function rollbackSwitchAction(orgId: string | null, switchId: string) {
  return act(orgId, "crm.provider.manage", (actor) => rollbackSwitch(actor, uuid.parse(switchId)));
}

export async function cancelSwitchAction(orgId: string | null, switchId: string) {
  return act(orgId, "crm.provider.manage", (actor) => cancelSwitch(actor, uuid.parse(switchId)));
}

export async function retrySwitchStepAction(orgId: string | null, switchId: string, step: string) {
  return act(orgId, "crm.provider.manage", (actor) => retrySwitchStep(actor, uuid.parse(switchId), entity.parse(step)));
}

/** Reads an imported step from GoHighLevel again and imports what was created there since the switch's read (inside the switch). */
export async function readRestSwitchStepAction(orgId: string | null, switchId: string, step: string) {
  return act(orgId, "crm.provider.manage", (actor) => readRestOfSwitchStep(actor, uuid.parse(switchId), entity.parse(step)));
}

/** The records of a switch that need a person (held for review, kept by a rollback, or failed). */
export async function switchReviewRowsAction(orgId: string | null, switchId: string) {
  return act(orgId, "crm.provider.manage", (actor) => getSwitchReviewRows(actor, uuid.parse(switchId)), { refresh: false });
}
