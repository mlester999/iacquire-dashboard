"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { decideMigrationPlan } from "@/server/admin/growth-partner-migration-plan";
import { actionError, AppError } from "@/server/errors";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";

export async function decideGrowthPartnerMigrationPlanAction(input: unknown) {
  try {
    const parsed = z.object({
      planId: z.string().uuid(),
      digest: z.string().regex(/^[a-f0-9]{64}$/),
      decision: z.enum(["approved", "declined", "withdrawn"]),
    }).strict().safeParse(input);
    if (!parsed.success) throw new AppError("invalid_input", "Choose a valid migration plan and decision.");
    const ctx = await requireOrgContextOrThrow("approvals.decide_high");
    const data = await decideMigrationPlan(ctx, parsed.data);
    revalidatePath("/growth-partner");
    return { ok: true as const, data };
  } catch (err) {
    return actionError(err);
  }
}
