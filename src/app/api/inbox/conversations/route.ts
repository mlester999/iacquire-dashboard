import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { AppError } from "@/server/errors";
import { listConversationsPage } from "@/server/messaging/inbox-list";
import { assertInboxEnabled } from "@/server/messaging/inbox-switch";
import { assertInboxEnabledFor } from "@/server/messaging/inbox-rollout";
import { inboxError, inboxJson, pollAllowed } from "@/server/messaging/inbox-http";
import { isInboxSort, isInboxView } from "@/lib/inbox";
import { isChannel } from "@/lib/messaging";

export const dynamic = "force-dynamic";

/** One page of the conversation list for a view, search and sort. Read only; row-level security decides what the person can see. */
export async function GET(request: Request) {
  try {
    assertInboxEnabled();
    const ctx = await requireOrgContextOrThrow("inbox.view");
    await assertInboxEnabledFor(ctx.org.orgId);
    const allowed = pollAllowed(`list:${ctx.user.id}`, 240);
    if (!allowed.ok) throw new AppError("rate_limited", "The inbox is refreshing too quickly. Please wait a moment.", { retryAfterSeconds: allowed.retryAfterSeconds });
    const p = new URL(request.url).searchParams;
    const view = p.get("view");
    const sort = p.get("sort");
    const channel = p.get("channel");
    const limit = Number(p.get("limit"));
    return inboxJson(
      await listConversationsPage(ctx, {
        view: isInboxView(view) ? view : undefined,
        sort: isInboxSort(sort) ? sort : undefined,
        channel: isChannel(channel) ? channel : undefined,
        q: p.get("q") ?? undefined,
        cursor: p.get("cursor"),
        limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
      }),
    );
  } catch (err) {
    return inboxError(err);
  }
}
