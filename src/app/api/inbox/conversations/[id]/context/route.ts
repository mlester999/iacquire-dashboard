import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { AppError } from "@/server/errors";
import { getInboxCrmContext } from "@/server/messaging/inbox-context";
import { assertInboxEnabled } from "@/server/messaging/inbox-switch";
import { assertInboxEnabledFor } from "@/server/messaging/inbox-rollout";
import { inboxError, inboxJson, pollAllowed } from "@/server/messaging/inbox-http";
import { UUID } from "@/server/messaging/access";

export const dynamic = "force-dynamic";

/** The CRM side of one conversation (deals, tasks, appointments, notes, calls), limited to what the signed-in person's role may see. Read only. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertInboxEnabled();
    const ctx = await requireOrgContextOrThrow("inbox.view");
    await assertInboxEnabledFor(ctx.org.orgId);
    const allowed = pollAllowed(`context:${ctx.user.id}`, 120);
    if (!allowed.ok) throw new AppError("rate_limited", "The inbox is refreshing too quickly. Please wait a moment.", { retryAfterSeconds: allowed.retryAfterSeconds });
    const { id } = await params;
    if (!UUID.test(id)) throw new AppError("not_found", "Conversation not found.");
    return inboxJson(await getInboxCrmContext(ctx, id));
  } catch (err) {
    return inboxError(err);
  }
}
