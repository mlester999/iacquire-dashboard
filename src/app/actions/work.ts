"use server";

import { revalidatePath } from "next/cache";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { actionError, AppError } from "@/server/errors";
import { dispatchCapabilityJob } from "@/server/workforce/capability-dispatch";
import { capabilityDefinition } from "@/lib/workforce-capabilities";

/**
 * Starts one reviewed, read-only capability from the AI Work Board. Lead research is deliberately
 * not startable here because it needs a target, location and quantity from the person first.
 */
export async function startReviewAction(capability: string) {
  try {
    const ctx = await requireOrgContextOrThrow("agents.use");
    const definition = capabilityDefinition(capability);
    if (!definition || !definition.workBoardAction) throw new AppError("invalid_input", "That review is not available from the work board.");
    const role = definition.allowedRoles[0];
    if (!role) throw new AppError("invalid_input", "That review has no eligible employee role.");
    const result = await dispatchCapabilityJob(ctx, {
      agentRole: role,
      capability: definition.key,
      title: definition.label,
      input: { sinceDays: 7 },
    });
    revalidatePath("/work");
    return { ok: true as const, data: result };
  } catch (err) {
    return actionError(err);
  }
}
