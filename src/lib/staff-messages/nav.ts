// What the agency navigation shows for Messages. Decided here, apart from the shell, so the rule can be tested: the entry is for people who may use Messages while it is on, and
// for a Super Admin always (the switch lives on its settings page, so a Super Admin must be able to reach it while the module is off). The badge is the unread total; it is
// never shown for zero, and an entry that is not shown has no badge. Pure.

import { canViewAdminNavigation, type AdminNavigationPolicy } from "@/lib/admin-nav";
import type { Permission } from "@/lib/permissions";
import { badgeText } from "@/lib/staff-messages/unread";

/** "on": the module is on and the person may use it. "off": it is switched off. "denied": the person may not use it (or the state could not be read). */
export interface MessagesNavState {
  state: "on" | "off" | "denied";
  unread: number;
}

export const MESSAGES_NAV_POLICY: AdminNavigationPolicy = { permission: "agency.messages.use" };

/** Whether the Messages entry is shown: through the same navigation policy as every other entry, with the permission counted as held only while the module is on. */
export function showMessagesNav(state: MessagesNavState["state"] | undefined, platformRole: string): boolean {
  const held = new Set<Permission>(state === "on" ? ["agency.messages.use"] : []);
  return canViewAdminNavigation(MESSAGES_NAV_POLICY, platformRole, held) || platformRole === "agency_super_admin";
}

/** The badge on the entry: nothing for zero or when the person has no access, "99+" past 99. */
export function navBadge(state: MessagesNavState["state"] | undefined, unread: number): string | null {
  return state === "on" ? badgeText(unread) : null;
}

/** Spoken label for the entry: the unread count in words, so the badge is not a bare number to a screen reader. */
export function navLabel(unread: number): string {
  if (unread <= 0) return "Messages";
  return unread === 1 ? "Messages, 1 unread" : unread > 99 ? "Messages, more than 99 unread" : `Messages, ${unread} unread`;
}

/** The window event the Messages page raises when its own unread total changes, so the navigation badge follows at once instead of at its next ask. */
export const UNREAD_EVENT = "iaq:staff-messages-unread";
