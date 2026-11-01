"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { z } from "zod";
import { guard } from "@/server/action-guard";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { CALENDAR_NOTICE_COOKIE, CALENDAR_NOTICE_COOKIE_OPTIONS } from "@/server/calendars/connections";
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

/**
 * Clears the one-time notice a calendar sign-in leaves behind, once the Setup page has shown it, so it never appears twice. A server component cannot remove a cookie, so the page
 * asks for this from the browser. It changes nothing but that cookie.
 */
export async function dismissCalendarNoticeAction() {
  return guard(async () => {
    await requireOrgContextOrThrow("setup.view");
    // The path it was set with: a cookie is removed only by naming the path it was set on.
    (await cookies()).delete({ name: CALENDAR_NOTICE_COOKIE, path: CALENDAR_NOTICE_COOKIE_OPTIONS.path });
    return { cleared: true };
  });
}
