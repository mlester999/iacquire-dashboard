import "server-only";
import type { Queryable } from "@/server/db";
import { notifyUser, type NotificationInput } from "@/server/notifications";
import type { DemoNotificationKind } from "@/lib/demo/events";

// Tells the people who follow demo prospects up. The recipients are everyone who holds agency.prospects.view right now (agency managers and Super Admins); a notification is
// addressed to the person (not to a client), so it is not tied to any workspace's scope. Nothing here carries a prospect's name, address or words: a title, a fixed sentence and a
// link to the prospect by id, so a notification, which can be emailed, never needs to be erased with the prospect.

export interface ProspectNotice extends Omit<NotificationInput, "kind"> {
  kind: DemoNotificationKind;
}

export async function notifyProspectTeam(db: Queryable, n: ProspectNotice): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    "select u.id from users u where u.status = 'active' and u.platform_role <> 'none' and coalesce(app.user_has_agency_permission(u.id, 'agency.prospects.view'), false) order by u.id",
  );
  let sent = 0;
  for (const r of rows) if (await notifyUser(db, r.id, null, n)) sent += 1;
  return sent;
}
