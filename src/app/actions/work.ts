"use server";

import { revalidatePath } from "next/cache";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { actionError } from "@/server/errors";
import { dispatchCapabilityJob } from "@/server/workforce/capability-dispatch";

/**
 * Starts one on-demand Operations Manager review. This is a person-triggered read of persisted
 * records, not a schedule: no recurring trigger is created and the handler cannot change a
 * business record or contact a provider.
 */
export async function startProactiveReviewAction() {
  try {
    const ctx = await requireOrgContextOrThrow("agents.use");
    const result = await dispatchCapabilityJob(ctx, {
      agentRole: "operations_manager",
      capability: "proactive_review",
      title: "On-demand operations review",
      input: { sinceDays: 7 },
    });
    revalidatePath("/work");
    return { ok: true as const, data: result };
  } catch (err) {
    return actionError(err);
  }
}
