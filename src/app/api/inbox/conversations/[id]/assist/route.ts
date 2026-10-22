import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { assertSameOrigin } from "@/server/auth/session";
import { AppError } from "@/server/errors";
import { suggestReply, summarizeConversation } from "@/server/messaging/inbox-ai";
import { assertInboxEnabled } from "@/server/messaging/inbox-switch";
import { inboxError, inboxJson } from "@/server/messaging/inbox-http";
import { UUID } from "@/server/messaging/access";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * AI help for one conversation: `{ "kind": "insights" }` (summary, next steps, why a person should look) or `{ "kind": "reply" }` (a suggested reply).
 * A route, not a server action, because a model call can take many seconds and server actions run one after another: this must not make Send wait.
 * It returns text for a person to read. It never sends, saves or changes anything.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertInboxEnabled();
    await assertSameOrigin();
    const ctx = await requireOrgContextOrThrow("inbox.reply");
    const { id } = await params;
    if (!UUID.test(id)) throw new AppError("not_found", "Conversation not found.");
    const body = (await request.json().catch(() => null)) as { kind?: unknown } | null;
    if (body?.kind === "insights") return inboxJson(await summarizeConversation(ctx, id));
    if (body?.kind === "reply") return inboxJson(await suggestReply(ctx, id));
    throw new AppError("invalid_input", "Choose what to ask for.");
  } catch (err) {
    return inboxError(err);
  }
}
