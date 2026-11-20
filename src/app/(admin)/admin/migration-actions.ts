"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { actionError, AppError } from "@/server/errors";
import { requireAgencyOrThrow, requireAgencyOrgPermissionOrThrow } from "@/server/tenancy/context";
import { prepareApprovedMigrationPlan, previewMigrationPlan, stageMigrationPlan } from "@/server/admin/growth-partner-migration-plan";
import { prepareGrowthPartnerMigrationCandidate, previewGrowthPartnerScheduleMigration } from "@/server/admin/growth-partner-migration";

/** Super Admin-only read of prior-profile schedules and pending work for future reconciliation. */
export async function previewGrowthPartnerScheduleMigrationAction(orgId: string) {
  try {
    const parsedOrgId = z.string().uuid().safeParse(orgId);
    if (!parsedOrgId.success) throw new AppError("invalid_input", "Choose a valid client workspace.");
    await requireAgencyOrThrow("super_admin");
    await requireAgencyOrgPermissionOrThrow(parsedOrgId.data, "agency.workforce.manage");
    return { ok: true as const, data: await previewGrowthPartnerScheduleMigration(parsedOrgId.data) };
  } catch (err) {
    return actionError(err);
  }
}

/** Super Admin-only first stage for a legacy tenant. It creates an inactive identity candidate only. */
export async function prepareGrowthPartnerMigrationCandidateAction(orgId: string) {
  try {
    const parsedOrgId = z.string().uuid().safeParse(orgId);
    if (!parsedOrgId.success) throw new AppError("invalid_input", "Choose a valid client workspace.");
    const admin = await requireAgencyOrThrow("super_admin");
    await requireAgencyOrgPermissionOrThrow(parsedOrgId.data, "agency.workforce.manage");
    const data = await prepareGrowthPartnerMigrationCandidate(parsedOrgId.data, admin.id);
    revalidatePath(`/admin/clients/${parsedOrgId.data}`);
    revalidatePath("/admin/employees");
    return { ok: true as const, data };
  } catch (err) {
    return actionError(err);
  }
}

export async function previewGrowthPartnerMigrationPlanAction(orgId: string) {
  try {
    const parsed = z.string().uuid().safeParse(orgId);
    if (!parsed.success) throw new AppError("invalid_input", "Choose a valid client workspace.");
    const admin = await requireAgencyOrThrow("super_admin");
    return { ok: true as const, data: await previewMigrationPlan(parsed.data, admin.id) };
  } catch (err) {
    return actionError(err);
  }
}

export async function stageGrowthPartnerMigrationPlanAction(orgId: string, digest: string) {
  try {
    const parsed = z.object({ orgId: z.string().uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/) }).safeParse({ orgId, digest });
    if (!parsed.success) throw new AppError("invalid_input", "Refresh the migration plan before staging it.");
    const admin = await requireAgencyOrThrow("super_admin");
    const data = await stageMigrationPlan(parsed.data.orgId, admin.id, parsed.data.digest);
    revalidatePath(`/admin/clients/${parsed.data.orgId}`);
    return { ok: true as const, data };
  } catch (err) {
    return actionError(err);
  }
}


export async function applyApprovedGrowthPartnerMigrationPlanAction(orgId: string, planId: string, digest: string) {
  try {
    const parsed = z.object({
      orgId: z.string().uuid(),
      planId: z.string().uuid(),
      digest: z.string().regex(/^[a-f0-9]{64}$/),
    }).safeParse({ orgId, planId, digest });
    if (!parsed.success) throw new AppError("invalid_input", "Refresh the migration plan before applying preparation.");
    const admin = await requireAgencyOrThrow("super_admin");
    await requireAgencyOrgPermissionOrThrow(parsed.data.orgId, "agency.workforce.manage");
    const data = await prepareApprovedMigrationPlan(parsed.data.orgId, admin.id, { planId: parsed.data.planId, digest: parsed.data.digest });
    revalidatePath(`/admin/clients/${parsed.data.orgId}`);
    revalidatePath("/growth-partner");
    return { ok: true as const, data };
  } catch (err) {
    return actionError(err);
  }
}
