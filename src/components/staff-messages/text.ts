// Words the Messages screens repeat. Kept in one place so a screen cannot say it two ways.

/** What a person who has left the agency team is called (the server uses the same words in the names it sends). */
export const FORMER_NAME_TEXT = "Former team member";

export const CONVERSATION_GONE_TITLE = "This conversation isn't available";
export const CONVERSATION_GONE_TEXT = "You may have left it, been removed from it, or the link may be wrong. If it is a channel open to the team, you can find it under Browse channels.";

export const KIND_LABEL: Record<string, string> = {
  direct: "Direct message",
  group: "Private group",
  "channel:staff": "Channel open to the team",
  "channel:private": "Private channel",
};

export const NOTIFY_LABEL: Record<"all" | "mentions" | "none", string> = {
  all: "Every message",
  mentions: "Only when I am mentioned",
  none: "Nothing",
};
