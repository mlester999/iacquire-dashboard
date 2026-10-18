"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { guard } from "@/server/action-guard";
import { resolveCrmActor } from "@/server/crm/request";
import type { CrmActor } from "@/server/crm/actor";
import {
  advanceGhlMigration, cancelGhlStep, checkGhlImportAgain, createGhlImportJob, createGhlMigrationRun, getGhlMigrationState, planGhlMigration, rollbackGhlImport, startGhlImport,
} from "@/server/crm/ghl-migration";
import { getImportJob } from "@/server/crm/imports";
import { GHL_MIGRATION_ENTITIES } from "@/lib/crm/ghl-migration";
import type { Permission } from "@/lib/permissions";

// Server actions for the "Migrate from GoHighLevel" panel (Settings → Imports, and the agency's view of it in a support session). Every rule
// lives in src/server/crm/ghl-migration.ts: these only resolve the actor (a client member acts on their own workspace; an agency person
// names the client and needs a support session) and validate the arguments.

const uuid = z.string().uuid({ error: "That migration step isn't valid." });
const orgArg = z.string().uuid().nullable().optional();
const entity = z.enum(GHL_MIGRATION_ENTITIES, { error: "Choose a migration step." });
const duplicates = z.enum(["update", "review", "skip"], { error: "Choose what happens when a record already exists here." }).optional();

function refresh(actor: CrmActor) {
  revalidatePath("/crm/settings/data");
  if (actor.kind === "agency") revalidatePath(`/admin/clients/${actor.orgId}/crm/settings/data`);
}

async function act<T>(orgId: string | null | undefined, permission: Permission, fn: (actor: CrmActor) => Promise<T>, opts: { refresh?: boolean } = {}) {
  return guard(async () => {
    const actor = await resolveCrmActor(orgArg.parse(orgId) ?? null, permission);
    const out = await fn(actor);
    if (opts.refresh !== false) refresh(actor);
    return out;
  });
}

/** A read-only look at what the GoHighLevel location holds (GET requests only; nothing is stored). */
export async function previewGhlMigrationAction(orgId: string | null) {
  return act(orgId, "crm.view", (actor) => planGhlMigration(actor), { refresh: false });
}

export async function ghlMigrationStateAction(orgId: string | null) {
  return act(orgId, "crm.view", (actor) => getGhlMigrationState(actor), { refresh: false });
}

/** Starts the dry run of the steps that still need one (never run, failed, undone, or cancelled before importing anything). */
export async function startGhlDryRunAction(orgId: string | null, onExisting?: "update" | "review" | "skip") {
  return act(orgId, "contacts.import", async (actor) => {
    await createGhlMigrationRun(actor, { duplicates: duplicates.parse(onExisting) });
    return getGhlMigrationState(actor);
  });
}

/** Starts the dry run of one step again: a fresh read of GoHighLevel, or, for a step that stopped while reading, the rest of that read. */
export async function startGhlStepAction(orgId: string | null, step: string, onExisting?: "update" | "review" | "skip") {
  return act(orgId, "contacts.import", async (actor) => {
    await createGhlImportJob(actor, { entity: entity.parse(step), duplicates: duplicates.parse(onExisting) });
    return getGhlMigrationState(actor);
  });
}

/** Moves running steps forward (progress polling) and returns the panel's state. */
export async function advanceGhlMigrationAction(orgId: string | null, jobIds: string[]) {
  return act(orgId, "contacts.import", async (actor) => {
    await advanceGhlMigration(actor, z.array(uuid).max(12).parse(jobIds));
    return getGhlMigrationState(actor);
  }, { refresh: false });
}

/** The real import of one step, after its dry run. Owner only (or a super admin's write session). */
export async function startGhlImportAction(orgId: string | null, jobId: string) {
  return act(orgId, "crm.provider.manage", (actor) => startGhlImport(actor, uuid.parse(jobId)));
}

export async function checkGhlStepAgainAction(orgId: string | null, jobId: string) {
  return act(orgId, "contacts.import", (actor) => checkGhlImportAgain(actor, uuid.parse(jobId)));
}

/** Cancels a step that hasn't finished (a running import: the owner only; cancelGhlStep checks per status). */
export async function cancelGhlStepAction(orgId: string | null, jobId: string) {
  return act(orgId, "contacts.import", (actor) => cancelGhlStep(actor, uuid.parse(jobId)));
}

/** Undoes one imported step (reverse order). Owner only. */
export async function rollbackGhlStepAction(orgId: string | null, jobId: string) {
  return act(orgId, "crm.provider.manage", (actor) => rollbackGhlImport(actor, uuid.parse(jobId)));
}

/** A step's rows that need a look (problems, held for review, notes), for the gap report. */
export async function ghlStepDetailAction(orgId: string | null, jobId: string) {
  return act(orgId, "contacts.import", (actor) => getImportJob(actor, uuid.parse(jobId)), { refresh: false });
}
