// What the public demo pages say when something is not possible, in plain words. One place, so the pages, the actions and the tests say the same thing. Pure.

export type PublicRefusal =
  | "unavailable"
  | "not_available"
  | "invalid"
  | "rate_limited"
  | "daily_cap"
  | "blocked_domain"
  | "email_failed"
  | "link_invalid"
  | "link_expired"
  | "link_used"
  | "no_session";

export const PUBLIC_COPY: Record<PublicRefusal, string> = {
  unavailable: "The demo is temporarily unavailable. Please try again later.",
  not_available: "The demo is not open right now.",
  invalid: "Please check the details and try again.",
  rate_limited: "Too many tries. Please wait a little and try again.",
  daily_cap: "Today's demo places are taken. Please try again tomorrow.",
  blocked_domain: "Please use your work email address.",
  email_failed: "We could not send the email just now. Please try again in a few minutes.",
  link_invalid: "That link is not valid. Ask for a new one from the demo page.",
  link_expired: "That link has expired. Ask for a new one from the demo page.",
  link_used: "That link was already used. If you are on the same device you may already be in; otherwise ask for a new one.",
  no_session: "Your demo session has ended. Ask for a new link from the demo page.",
};

/** What the form says after any request that passed the checks. It is the same whether or not the address was known, so the form cannot be used to find out who has asked for a demo. */
export const LINK_SENT_COPY = "If this address can open a demo, we have emailed it a link. The link works once and expires in 48 hours.";

/** The few words about a field that failed. */
export const FIELD_COPY = {
  name: "Enter your name.",
  email: "Enter a valid email address.",
  business: "Enter your business name.",
  industry: "Choose the closest industry.",
  consent: "Tick the box to continue.",
} as const;
