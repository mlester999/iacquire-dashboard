import "server-only";
import { withUser } from "@/server/db";
import { AppError } from "@/server/errors";
import type { OrgContext } from "@/server/tenancy/context";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The conversation must be one the signed-in person is allowed to see. Visibility is decided by row-level security (inbox.view plus
 * inbox.view_all, or being its owner or assignee), not by this code, so a conversation of another workspace or one the person cannot see is
 * simply "not found": nothing about it is revealed.
 */
export async function assertConversationVisible(ctx: OrgContext, conversationId: string): Promise<void> {
  if (!UUID.test(conversationId)) throw new AppError("not_found", "Conversation not found.");
  const visible = await withUser(ctx.user.id, (db) => db.query("select 1 from conversations where id = $1 and org_id = $2", [conversationId, ctx.org.orgId]));
  if (!visible.rows[0]) throw new AppError("not_found", "Conversation not found.");
}
