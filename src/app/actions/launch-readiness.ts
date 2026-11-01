"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { z } from "zod";
import { guard } from "@/server/action-guard";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { CALENDAR_NOTICE_COOKIE, CALENDAR_NOTICE_COOKIE_OPTIONS } from "@/server/calendars/connections";
import { AppError } from "@/server/errors";
import { LAUNCH_INTENTS, fingerprintOf, type LaunchReadiness } from "@/lib/launch-readiness";
import { runLaunchIntent } from "@/server/setup/launch-intents";
import { getLaunchReadiness } from "@/server/setup/launch-readiness";

// The next step of the guided launch setup, run as the signed-in member. The workspace is the member's own active one; the services re-check the permission each step needs.

const intent = z.enum(LAUNCH_INTENTS, { error: "That step wasn't found." });

// A server action can be called directly, so what comes with the step is checked here too: a person's id and the digest of the hours that were shown, nothing else.
const params = z.object({ userId: z.string().uuid().optional(), hoursDigest: z.string().regex(/^[a-f0-9]{64}$/, "That approval is not valid. Review the hours and approve them again.").optional() }).strict();

export async function runLaunchIntentAction(value: string, extra?: { userId?: string; hoursDigest?: string }) {
  return guard(async () => {
    const step = intent.parse(value);
    const stepParams = params.parse(extra ?? {});
    const ctx = await requireOrgContextOrThrow("setup.view");
    const res = await runLaunchIntent(ctx, step, stepParams);
    revalidatePath("/setup");
    revalidatePath("/crm", "layout");
    return res;
  });
}

/**
 * The launch state as the signed-in member sees it right now, with its fingerprint, for the panel to poll. It only reads: nothing is recorded and nothing starts (the ledger runs after
 * events, never on a read). The fingerprint changes only when the overall state or a required item's state or owner does, so a panel can announce a change without comparing wording.
 * A workspace that is not a client's has no launch state, so asking is refused instead of answering with nothing.
 */
export async function getLaunchReadinessAction(): Promise<{ readiness: LaunchReadiness; fingerprint: string }> {
  const ctx = await requireOrgContextOrThrow("setup.view");
  const readiness = await getLaunchReadiness(ctx);
  if (!readiness) throw new AppError("not_found", "Launch setup applies to a client workspace.");
  return { readiness, fingerprint: fingerprintOf(readiness) };
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
