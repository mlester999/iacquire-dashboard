import { AI_GROWTH_PARTNER_ROLE_KEY, type WorkforceRoleKey } from "@/lib/agents";

export type WorkforceChatOutboundControlIntent =
  | { kind: "none" }
  | { kind: "clarification"; message: string }
  | { kind: "change"; paused: boolean };

const ACTION = /\b(?:pause|stop|suspend|resume|restart|unpause|reactivate)\b/i;
const TOPIC = /\b(?:outbound|campaigns?|outreach)\b/i;
const CLEAR_COMMAND = /^(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(pause|stop|suspend|resume|restart|unpause|reactivate)\s+(?:(?:(?:all|the)\s+)?outbound\s+(?:campaigns|actions|automation)|all\s+campaigns)(?:,?\s+please)?[.!?]*$/i;

/** A single explicit workspace-wide control command; never identifies an individual campaign. */
export function parseWorkforceChatOutboundControlIntent(role: WorkforceRoleKey, content: string): WorkforceChatOutboundControlIntent {
  if (role !== AI_GROWTH_PARTNER_ROLE_KEY) return { kind: "none" };
  const text = content.replace(/\s+/g, " ").trim();
  if (!ACTION.test(text) || !TOPIC.test(text)) return { kind: "none" };

  const command = text.match(CLEAR_COMMAND);
  if (!command) {
    return {
      kind: "clarification",
      message: "I can pause or resume all outbound AI actions for this workspace, but I can't change one named campaign or set an automatic expiry from chat. Send one clear workspace-wide command, such as “Pause outbound campaigns.” No setting was changed.",
    };
  }

  const verb = command[1];
  const paused = !/^(?:resume|restart|unpause|reactivate)$/i.test(verb);
  return { kind: "change", paused };
}
