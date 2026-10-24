import "server-only";
import type { Queryable } from "@/server/db";
import { notifyOrgRoles } from "@/server/notifications";

/**
 * The provider refused a connection's saved key (the daily check, or a checkout that was just started): new online payments stop and the owner is told, once a day. Only a
 * connected or already-flagged connection changes; one that is paused, still waiting for its signing secret or disconnected is left as it is. Returns whether the connection
 * is now flagged by this call.
 */
export async function flagRefusedKey(db: Queryable, conn: { id: string; orgId: string }, message: string, now: Date): Promise<boolean> {
  const changed = await db.query(
    "update customer_payment_connections set last_checked_at = $3, last_error = $4, status = 'needs_attention' where id = $1 and org_id = $2 and status in ('connected', 'needs_attention') returning id",
    [conn.id, conn.orgId, now, message.slice(0, 400)],
  );
  if (!changed.rows[0]) return false;
  await notifyOrgRoles(db, conn.orgId, ["owner"], {
    kind: "payment_connection_attention", severity: "warning", title: "Your payment account needs attention",
    body: "The payment provider no longer accepts the saved key, so new online payments are paused until you reconnect it.", link: "/settings/payments", dedupeKey: `payment-connection:${conn.id}:${now.toISOString().slice(0, 10)}`,
  });
  return true;
}
