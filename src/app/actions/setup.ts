"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { submitClientResponse, responseSchema } from "@/server/setup/client";
import { actionError } from "@/server/errors";

/** The only write a client can make to their setup: answer the request the agency opened on a step. */
export async function respondToSetupAction(taskId: string, input: z.input<typeof responseSchema>) {
  try {
    if (!z.string().uuid().safeParse(taskId).success) return { ok: false as const, error: "That setup step wasn't found.", code: "not_found" as const };
    const ctx = await requireOrgContextOrThrow("setup.view");
    const res = await submitClientResponse(ctx, taskId, input);
    revalidatePath("/setup");
    return { ok: true as const, data: { status: res.result.status, revision: res.revision } };
  } catch (err) {
    if (err instanceof z.ZodError) return { ok: false as const, error: err.issues[0]?.message ?? "Check your answer.", code: "invalid_input" as const };
    return actionError(err);
  }
}
