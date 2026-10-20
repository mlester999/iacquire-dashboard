import type { AgentStatus } from "@/lib/agents";

/**
 * Where the chat workspace sends people. Every target is an existing route; whether the *viewer* may use it is decided
 * by the destination page (requireOrgContext / permission checks); links that need a permission are simply not rendered
 * for viewers who lack it.
 *
 * Management and chat are different intents. A management click opens the employee's profile; a chat click opens the
 * conversation. Neither silently becomes the other.
 */
export interface ChatNavTargets {
  /** The product home for this kind of workspace. */
  home: string;
  homeLabel: string;
  /** The AI Workforce directory ("management mode"). */
  workforce: string;
  /** This employee's profile (readiness, activity, knowledge, version history). */
  profile: string;
  /** This employee's configuration tab. Only offered to people who may configure employees. */
  manage: string;
  /** This employee's chat. */
  chat: string;
}

export function chatNavTargets(orgKind: string, slug: string): ChatNavTargets {
  const agency = orgKind === "agency";
  return {
    home: agency ? "/admin" : "/overview",
    homeLabel: agency ? "Agency dashboard" : "Dashboard",
    workforce: agency ? "/admin/workforce" : "/workforce",
    profile: `/workforce/${slug}`,
    manage: `/workforce/${slug}?tab=configure`,
    chat: `/chat/${slug}`,
  };
}

/** The one-line readiness caption shown under an employee in the specialist list. */
export function specialistCaption(status: AgentStatus): string {
  return {
    online: "Online",
    busy: "Working now",
    provisioning: "Being set up",
    setup_required: "Setup required",
    offline: "Offline",
    error: "Needs attention",
    disabled: "Paused",
  }[status];
}
