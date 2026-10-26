// Reactions are a short allow-list of names; the screens draw the pictures. No free text can sit in a reaction, and the list is the same as the database check in 0096
// (tests/staff-messages-rules.test.ts reads the migration and compares). Pure.

export const REACTIONS = [
  { key: "thumbs_up", label: "Thumbs up" },
  { key: "thumbs_down", label: "Thumbs down" },
  { key: "heart", label: "Heart" },
  { key: "laugh", label: "Laugh" },
  { key: "surprised", label: "Surprised" },
  { key: "sad", label: "Sad" },
  { key: "tada", label: "Celebrate" },
  { key: "eyes", label: "Looking" },
  { key: "check", label: "Done" },
  { key: "pray", label: "Thanks" },
  { key: "rocket", label: "Launch" },
  { key: "cross", label: "No" },
] as const;

export type Reaction = (typeof REACTIONS)[number]["key"];

const KEYS: ReadonlySet<string> = new Set(REACTIONS.map((r) => r.key));

export const isReaction = (value: unknown): value is Reaction => typeof value === "string" && KEYS.has(value);

export const reactionLabel = (key: Reaction): string => REACTIONS.find((r) => r.key === key)?.label ?? key;

export interface ReactionCount {
  reaction: Reaction;
  count: number;
  /** Whether the person looking is one of them. */
  mine: boolean;
}

/** The reactions on one message as counts, in the order of the allow-list, with whether the viewer gave each. */
export function tallyReactions(rows: ReadonlyArray<{ reaction: string; userId: string }>, viewerId: string): ReactionCount[] {
  const out: ReactionCount[] = [];
  for (const { key } of REACTIONS) {
    const mine = rows.filter((r) => r.reaction === key);
    if (mine.length) out.push({ reaction: key, count: mine.length, mine: mine.some((r) => r.userId === viewerId) });
  }
  return out;
}
