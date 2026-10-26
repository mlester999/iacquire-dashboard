import "server-only";
import type { StaffUser } from "@/server/staff-messages/access";
import { inboxStatus } from "@/server/staff-messages/inbox";
import { unreadTotal } from "@/server/staff-messages/snapshot";
import type { MessagesNavState } from "@/lib/staff-messages/nav";

/**
 * What the agency navigation needs about Messages for one person, read from the database for this request: whether the entry is shown at all (the module is on and the person
 * may use it), and the unread total for its badge. Never throws: a failure here must not take the whole admin area down, so it answers "denied" (hidden, no badge) and the
 * page itself still checks everything again.
 */
export async function staffNavState(user: StaffUser): Promise<MessagesNavState> {
  try {
    const status = await inboxStatus(user);
    if (status.access === "ok") return { state: "on", unread: await unreadTotal(user.id) };
    return { state: status.reason === "not_enabled" ? "off" : "denied", unread: 0 };
  } catch {
    return { state: "denied", unread: 0 };
  }
}
