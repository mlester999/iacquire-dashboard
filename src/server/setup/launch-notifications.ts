import "server-only";
import type { Queryable } from "@/server/db";
import { env } from "@/server/env";

/**
 * Whether a client workspace is told about its launch setup. The notices are: "your setup is 100% ready", "something in your setup needs another look", "your launch setup needs something
 * from you", an alert to iAcquire when a step has waited too long, the owners' notice when a calendar stops (or starts again) verifying, and the daily reminder that a booking still waits for
 * a person to confirm it. They are new, and a client that was already
 * using the product must never receive one it did not expect, so they are OFF unless somebody switches them on:
 *   - a workspace's own setting (the `launch_notifications` feature, set by a Super Admin) wins either way, ON or OFF;
 *   - otherwise the deployment default applies, and that default is off (LAUNCH_NOTIFICATIONS_ENABLED).
 * Only the notices are held back. The ledger of state changes in the audit trail, the setup panel and everything a person sees when they open Setup are not affected.
 */

export const LAUNCH_NOTIFICATIONS_FEATURE = "launch_notifications";

/** Pass the `db` of the transaction the notice is sent from, so the answer and the notice come from the same snapshot. */
export async function launchNotificationsOn(orgId: string, db: Queryable): Promise<boolean> {
  const row = (await db.query<{ enabled: boolean }>("select enabled from org_features where org_id = $1 and feature = $2", [orgId, LAUNCH_NOTIFICATIONS_FEATURE])).rows[0];
  if (row) return row.enabled === true;
  return env().LAUNCH_NOTIFICATIONS_ENABLED;
}
