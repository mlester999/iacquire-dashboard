import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { AppError } from "@/server/errors";
import { inboxSync } from "@/server/messaging/inbox-sync";
import { assertInboxEnabled } from "@/server/messaging/inbox-switch";
import { assertInboxEnabledFor } from "@/server/messaging/inbox-rollout";
import { inboxError, inboxJson, pollAllowed } from "@/server/messaging/inbox-http";

export const dynamic = "force-dynamic";

/** What changed in the signed-in person's inbox since `since` (see src/server/messaging/inbox-sync.ts). Read only. */
export async function GET(request: Request) {
  try {
    assertInboxEnabled();
    const ctx = await requireOrgContextOrThrow("inbox.view");
    await assertInboxEnabledFor(ctx.org.orgId);
    const allowed = pollAllowed(`sync:${ctx.user.id}`, 240);
    if (!allowed.ok) throw new AppError("rate_limited", "The inbox is refreshing too quickly. Please wait a moment.", { retryAfterSeconds: allowed.retryAfterSeconds });
    const url = new URL(request.url);
    return inboxJson(await inboxSync(ctx, url.searchParams.get("since"), { counts: url.searchParams.get("counts") === "1" }));
  } catch (err) {
    return inboxError(err);
  }
}
