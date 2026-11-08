"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { actionError, AppError } from "@/server/errors";
import { requireAgencyOrThrow, requireAgencyOrgPermissionOrThrow } from "@/server/tenancy/context";
import { prepareGrowthPartnerMigrationCandidate } from "@/server/admin/growth-partner-migration";

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
