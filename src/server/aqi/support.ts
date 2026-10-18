import "server-only";
import { withSystem, withUser } from "@/server/db";
import { AppError } from "@/server/errors";
import { createTicket } from "@/server/support/service";
import type { OrgContext } from "@/server/tenancy/context";
import type { AqiViewer } from "@/server/aqi/access";

export interface AqiSupportResult {
  id: string;
  ref: string;
  externalNotification: string;
  existing: boolean;
}

/**
 * Creates a real support request through the existing Support service. Only the client's own AQi
 * conversation can be shared, only after explicit consent, and the transcript is bounded. If the
 * support system or the client's support permission is unavailable, this throws rather than
 * pretending a ticket exists.
 */
export async function createAqiSupportTicket(
  viewer: AqiViewer,
  conversationId: string,
  subjectInput: string,
  consent: boolean,
): Promise<AqiSupportResult> {
  if (consent !== true) throw new AppError("invalid_input", "Explicit consent is required before sharing this conversation.");
  if (!viewer.org) throw new AppError("forbidden", "Support requests are created from a client workspace. Agency staff should use the agency support desk.");
  if (!viewer.can("support.use")) throw new AppError("forbidden", "Your role can't open support requests.");

  const data = await withUser(viewer.user.id, async (db) => {
    const { rows } = await db.query<{ id: string; title: string; page_route: string | null }>(
      `select id, title, page_route from aqi_conversations
       where id = $1 and user_id = $2 and org_id = $3`,
      [conversationId, viewer.user.id, viewer.org!.orgId],
    );
    const conversation = rows[0];
    if (!conversation) throw new AppError("not_found", "That AQi conversation was not found.");
    const messages = await db.query<{ role: "user" | "assistant"; content: string; created_at: Date }>(
      `select role, content, created_at from aqi_messages
       where conversation_id = $1 and status in ('complete','failed','cancelled')
       order by created_at asc limit 30`,
      [conversationId],
    );
    return { conversation, messages: messages.rows };
  });

  const transcript = data.messages
    .filter((message) => message.content.trim())
    .slice(-12)
    .map((message) => `${message.role === "user" ? "User" : "AQi"}: ${message.content.trim()}`)
    .join("\n\n")
    .slice(0, 4200);
  if (!transcript) throw new AppError("invalid_input", "There is no conversation content to share yet.");

  const subject = (subjectInput.trim() || `AQi help: ${data.conversation.title}`).slice(0, 160);
  const existing = await withSystem(async (db) => {
    const { rows } = await db.query<{ id: string; ref: string; external_notification: string }>(
      `select id, ref, external_notification from support_tickets
       where org_id = $1 and created_by = $2 and subject = $3
         and status in ('open','in_progress','waiting_for_client')
         and created_at > now() - interval '10 minutes'
       order by created_at desc limit 1`,
      [viewer.org!.orgId, viewer.user.id, subject],
    );
    return rows[0];
  });
  if (existing) return { id: existing.id, ref: existing.ref, externalNotification: existing.external_notification, existing: true };

  const pageContext = data.conversation.page_route && /^\/[A-Za-z0-9/_-]*$/.test(data.conversation.page_route) ? data.conversation.page_route : "/support";
  const ctx: OrgContext = {
    user: viewer.user,
    org: {
      orgId: viewer.org.orgId,
      name: viewer.org.name,
      slug: "",
      kind: viewer.org.kind,
      status: "active",
      role: viewer.org.role,
      isDemo: false,
      timezone: viewer.user.timezone,
      onboardingCompletedAt: null,
    },
    role: viewer.org.role,
    permissions: viewer.permissions,
    can: viewer.can,
    memberships: [],
  };
  const ticket = await createTicket(ctx, {
    subject,
    message: `The user explicitly agreed to share their AQi conversation.\n\nConversation: ${data.conversation.title}\nPage: ${pageContext}\n\n${transcript}`,
    category: "general",
    priority: "normal",
    pageContext,
  });
  return { id: ticket.id, ref: ticket.ref, externalNotification: ticket.externalNotification, existing: false };
}
