"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { guard } from "@/server/action-guard";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { runLaunchIntent } from "@/server/setup/launch-intents";

// The next step of the guided launch setup, run as the signed-in member. The workspace is the member's own active one; the services re-check the permission each step needs.

const intent = z.enum(["assign_host", "apply_hours", "activate_calendar", "run_checks"], { error: "That step wasn't found." });

export async function runLaunchIntentAction(value: string) {
  return guard(async () => {
    const step = intent.parse(value);
    const ctx = await requireOrgContextOrThrow("setup.view");
    const res = await runLaunchIntent(ctx, step);
    revalidatePath("/setup");
    revalidatePath("/crm", "layout");
    return res;
  });
}
