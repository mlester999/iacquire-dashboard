import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { AppError } from "@/server/errors";
import { listOpenEscalations } from "@/server/messaging/handoff";
import { inboxError, inboxJson, pollAllowed } from "@/server/messaging/inbox-http";

export const dynamic = "force-dynamic";

/**
 * The conversations waiting for a person, as the signed-in person may see them: managers see all of them, everyone else only those they were told
 * about (the same rule as the inbox page). Reading it also applies any owner window that has run out. Read only.
 */
export async function GET() {
  try {
    const ctx = await requireOrgContextOrThrow("inbox.view");
    const allowed = pollAllowed(`escalations:${ctx.user.id}`, 240);
    if (!allowed.ok) throw new AppError("rate_limited", "The inbox is refreshing too quickly. Please wait a moment.", { retryAfterSeconds: allowed.retryAfterSeconds });
    const rows = ctx.can("escalations.respond") || ctx.can("inbox.view_all") ? await listOpenEscalations(ctx) : [];
    return inboxJson(rows.map((e) => ({ ...e, owner_deadline_at: e.owner_deadline_at ? new Date(e.owner_deadline_at).toISOString() : null })));
  } catch (err) {
    return inboxError(err);
  }
}
