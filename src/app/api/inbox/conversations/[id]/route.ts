import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { AppError } from "@/server/errors";
import { loadInboxThread } from "@/server/messaging/inbox-sync";
import { assertInboxEnabled } from "@/server/messaging/inbox-switch";
import { inboxError, inboxJson, pollAllowed } from "@/server/messaging/inbox-http";
import { UUID } from "@/server/messaging/access";

export const dynamic = "force-dynamic";

/**
 * One conversation as the thread shows it. A conversation that does not exist, belongs to another workspace, or that the person is not allowed
 * to see all answer the same 404, so the endpoint cannot be used to find out which exist. Read only: opening it does not mark it read.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertInboxEnabled();
    const ctx = await requireOrgContextOrThrow("inbox.view");
    const allowed = pollAllowed(`thread:${ctx.user.id}`, 240);
    if (!allowed.ok) throw new AppError("rate_limited", "The inbox is refreshing too quickly. Please wait a moment.", { retryAfterSeconds: allowed.retryAfterSeconds });
    const { id } = await params;
    const thread = UUID.test(id) ? await loadInboxThread(ctx, id) : null;
    if (!thread) throw new AppError("not_found", "Conversation not found.");
    return inboxJson(thread);
  } catch (err) {
    return inboxError(err);
  }
}
