"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { guard } from "@/server/action-guard";
import { resolveCrmActor } from "@/server/crm/request";
import type { CrmActor } from "@/server/crm/actor";
import { archiveSavedReport, createSavedReport, setSavedReportPinned, updateSavedReport } from "@/server/crm/reports/definitions";
import type { Permission } from "@/lib/permissions";
import type { ReportConfig } from "@/components/crm/reports/spec";

// Server actions for CRM Reports (/crm/reports and the agency's view of it): saving, renaming, sharing, pinning and archiving report
// definitions. The report itself is computed on the page from the address bar; every rule lives in the services.

const uuid = z.string().uuid({ error: "That report isn't valid." });
const orgArg = z.string().uuid().nullable().optional();

function refresh(actor: CrmActor) {
  revalidatePath("/crm/reports");
  if (actor.kind === "agency") revalidatePath(`/admin/clients/${actor.orgId}/crm/reports`);
}

async function act<T>(orgId: string | null | undefined, permission: Permission, fn: (actor: CrmActor) => Promise<T>) {
  return guard(async () => {
    const actor = await resolveCrmActor(orgArg.parse(orgId) ?? null, permission);
    const out = await fn(actor);
    refresh(actor);
    return out;
  });
}

const visibility = z.enum(["private", "team"], { error: "Choose who can see this report." });
// The filters and sections are checked in full by the service (reportConfigSchema); here only the outer shape.
const saveSchema = z.object({
  name: z.string().max(200),
  description: z.string().max(1000).nullable().optional(),
  config: z.unknown(),
  visibility: visibility.optional(),
});
const patchSchema = saveSchema.partial();

export async function saveReportAction(orgId: string | null, input: z.input<typeof saveSchema>) {
  return act(orgId, "analytics.view", (actor) => {
    const v = saveSchema.parse(input);
    return createSavedReport(actor, { name: v.name, description: v.description ?? null, config: v.config as ReportConfig, visibility: v.visibility });
  });
}

export async function updateReportAction(orgId: string | null, id: string, patch: z.input<typeof patchSchema>) {
  return act(orgId, "analytics.view", async (actor) => {
    const v = patchSchema.parse(patch);
    await updateSavedReport(actor, uuid.parse(id), {
      ...(v.name !== undefined ? { name: v.name } : {}),
      ...(v.description !== undefined ? { description: v.description } : {}),
      ...(v.config !== undefined ? { config: v.config as ReportConfig } : {}),
      ...(v.visibility !== undefined ? { visibility: v.visibility } : {}),
    });
    return { id };
  });
}

export async function pinReportAction(orgId: string | null, id: string, pinned: boolean) {
  return act(orgId, "analytics.view", async (actor) => {
    await setSavedReportPinned(actor, uuid.parse(id), z.boolean().parse(pinned));
    return { id };
  });
}

export async function archiveReportAction(orgId: string | null, id: string) {
  return act(orgId, "analytics.view", async (actor) => {
    await archiveSavedReport(actor, uuid.parse(id));
    return { id };
  });
}
