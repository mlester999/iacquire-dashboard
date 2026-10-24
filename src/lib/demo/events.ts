// The words the demo funnel uses for what happened to a prospect: the timeline's entry kinds (the same list migration 0100 allows) and the notification kinds. Pure, so the agency
// screens and the services share one list and tests/demo-migration.test.ts keeps it in step with the database.

export const DEMO_EVENT_KINDS = [
  "registered", "verified", "accessed", "return_link", "message_blocked", "message_released", "limit_reached", "extended", "expired", "cta_consultation", "cta_buy",
  "consultation_done", "note", "assigned", "blocked", "declined", "reopened", "transcript_viewed", "converted", "erased",
] as const;
export type DemoEventKind = (typeof DEMO_EVENT_KINDS)[number];

/** Plain words for a timeline line. Nothing a prospect typed appears here: those entries show the text separately, to people allowed to read it. */
export const DEMO_EVENT_LABELS: Record<DemoEventKind, string> = {
  registered: "Asked for a demo",
  verified: "Confirmed their email address; the demo window opened",
  accessed: "Opened the demo",
  return_link: "Was sent a new link to come back",
  message_blocked: "A message or its answer was held back by a safety check",
  message_released: "A message was given back because no answer came",
  limit_reached: "Used the last of their demo messages",
  extended: "The demo was extended",
  expired: "The demo window ended",
  cta_consultation: "Asked for a consultation",
  cta_buy: "Pressed Buy now",
  consultation_done: "The consultation was held",
  note: "A note was added",
  assigned: "Was assigned to a team member",
  blocked: "Was blocked",
  declined: "Was marked as not a fit",
  reopened: "Was reopened",
  transcript_viewed: "A team member read the conversation",
  converted: "Became a client workspace",
  erased: "Their details were erased",
};

/** Who did it. A prospect is never a user, so their entries carry no user. */
export type DemoActor = { kind: "prospect" } | { kind: "system" } | { kind: "user"; id: string };

/** The agency notifications. They carry no name, email address or message: only that something happened and where to look. */
export const DEMO_NOTIFICATION_KINDS = ["demo_prospect_verified", "demo_consultation_requested", "demo_purchase_started", "demo_budget_reached"] as const;
export type DemoNotificationKind = (typeof DEMO_NOTIFICATION_KINDS)[number];

/** Keys of a timeline entry's detail that hold text a person typed. An erasure removes them; everything else in a detail is a number, a switch or a fixed word. */
export const DEMO_EVENT_TEXT_KEYS = ["note", "reason", "text"] as const;
