// What the public demo pages say about something that just happened, in plain words. The forms work without scripts: they post, and the server sends the person back to the page with
// ONE short word in the address saying how it went. This file turns a word into a notice, and refuses every word it does not know, so an address somebody typed can never put its
// own sentence on the page. A word that claims a state ("your window has ended") is shown only where the record agrees with it (see agrees). Pure.
import { LINK_SENT_COPY, PUBLIC_COPY, type PublicRefusal } from "./copy";
import { REFUSAL_COPY } from "./rules";

export interface Notice {
  tone: "ok" | "error";
  text: string;
}

const own = (o: object, k: string) => Object.hasOwn(o, k);

// ---------------------------------------------------------------------------
// The request page (/demo?r=word)
// ---------------------------------------------------------------------------

/** Words /demo?r= understands: the refusals the form can meet, and the two good outcomes. */
export const START_REFUSALS: readonly PublicRefusal[] = ["unavailable", "not_available", "invalid", "rate_limited", "daily_cap", "blocked_domain", "email_failed", "no_session"];
export const START_WORDS = ["sent", "left", ...START_REFUSALS] as const;
export type StartWord = (typeof START_WORDS)[number];

export const LEFT_COPY = "You have left the demo on this device. Your conversation is kept until it is erased; ask for a new link to come back.";

export function startNotice(word: string | undefined, state: { hasSession: boolean }): Notice | null {
  if (!word || !(START_WORDS as readonly string[]).includes(word)) return null;
  if (word === "sent") return { tone: "ok", text: LINK_SENT_COPY };
  if (word === "left") return { tone: "ok", text: LEFT_COPY };
  // "Your session has ended" only where the browser really has no session.
  if (word === "no_session" && state.hasSession) return null;
  return { tone: "error", text: PUBLIC_COPY[word as PublicRefusal] };
}

/** The form fields a failed request names (field names only, never what was typed). */
export const FORM_FIELDS = ["name", "email", "business", "industry", "consent"] as const;
export type FormField = (typeof FORM_FIELDS)[number];

export function parseFieldWords(raw: string | undefined): FormField[] {
  if (!raw) return [];
  return [...new Set(raw.split(".").filter((f): f is FormField => (FORM_FIELDS as readonly string[]).includes(f)))];
}

export const fieldWords = (fields: readonly string[]): string => fields.filter((f) => (FORM_FIELDS as readonly string[]).includes(f)).join(".");

// ---------------------------------------------------------------------------
// The link's page (/demo/verify?e=word)
// ---------------------------------------------------------------------------

export const VERIFY_REFUSALS: readonly PublicRefusal[] = ["link_invalid", "link_expired", "link_used", "daily_cap", "rate_limited", "not_available", "unavailable"];

export function verifyNotice(word: string | undefined): Notice | null {
  if (!word || !(VERIFY_REFUSALS as readonly string[]).includes(word)) return null;
  return { tone: "error", text: PUBLIC_COPY[word as PublicRefusal] };
}

/** Refusals that leave the emailed link unused (the day was full, a busy moment, the demo closed): the person can open the same link from their email again later. */
const LINK_STILL_GOOD: readonly string[] = ["daily_cap", "rate_limited", "unavailable", "not_available"];
export const linkStillGood = (word: string | undefined): boolean => word !== undefined && LINK_STILL_GOOD.includes(word);

// ---------------------------------------------------------------------------
// The room (/demo/room?m=word&c=word)
// ---------------------------------------------------------------------------

/** Why a message was handed back: it was not counted and the prospect can try again. Kept in step with RELEASE_REASONS in src/server/demo/chat.ts by tests/demo-outcomes.test.ts. */
export const HOLD_REASONS = ["provider_failed", "no_model", "reply_blocked", "input_blocked", "timeout", "internal"] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];

export const HOLD_COPY: Record<HoldReason, string> = {
  provider_failed: "The assistant could not answer just now, so your message was not counted. Please try again.",
  timeout: "The assistant took too long to answer, so your message was not counted. Please try again.",
  internal: "Something went wrong on our side, so your message was not counted. Please try again.",
  no_model: "The AI chat is not available right now, so your message was not counted.",
  reply_blocked: "The assistant's answer was held back by a safety check, so your message was not counted. Try asking in a different way, or ask for a consultation.",
  input_blocked: "That message could not be sent to the assistant, so it was not counted. Ask about the product in your own words.",
};

/** The word for a message that was handed back. */
export const holdWord = (reason: HoldReason): string => `held_${reason}`;

/** Words /demo/room?m= understands. */
export const MESSAGE_REFUSALS = ["limit_reached", "window_ended", "ai_off", "daily_cap", "rate_limited", "unavailable", "invalid", "closed", "blocked", "not_verified"] as const;
export const MESSAGE_WORDS: readonly string[] = [...MESSAGE_REFUSALS, ...HOLD_REASONS.map(holdWord)];

/** What the record says now, to compare a word with. */
export interface RoomFacts {
  access: "unverified" | "open" | "ended" | "blocked" | "converted" | "erased";
  messagesLeft: number;
  chatRefusal: string | null;
  consultationRequested: boolean;
  purchaseStarted: boolean;
}

/**
 * Whether the record agrees with a word that names a state. The address is not a record: "?m=limit_reached" on a room with messages left shows nothing. Words about something that
 * just happened (a held message, a busy moment) name no state and are shown as they are.
 */
export function agrees(word: string, facts: RoomFacts): boolean {
  switch (word) {
    case "limit_reached":
      return facts.access === "open" && facts.messagesLeft === 0;
    case "window_ended":
      return facts.access === "ended";
    case "ai_off":
      return facts.chatRefusal === "ai_off";
    case "closed":
    case "blocked":
    case "not_verified":
      // Whoever was in this state has no room to see; a stray word is never shown.
      return false;
    default:
      return true;
  }
}

export function messageNotice(word: string | undefined, facts: RoomFacts): Notice | null {
  if (!word || !MESSAGE_WORDS.includes(word) || !agrees(word, facts)) return null;
  if (word.startsWith("held_")) return { tone: "error", text: HOLD_COPY[word.slice(5) as HoldReason] };
  return { tone: "error", text: own(REFUSAL_COPY, word) ? REFUSAL_COPY[word as keyof typeof REFUSAL_COPY] : PUBLIC_COPY.unavailable };
}

export const CTA_WORDS = ["consultation", "buy"] as const;
export type CtaWord = (typeof CTA_WORDS)[number];

export const CTA_COPY: Record<CtaWord, string> = {
  consultation: "Thank you. We have told the team you would like to talk to a person.",
  buy: "Thank you. We have told the team you are interested. Online checkout is not open yet, so nothing was charged.",
};

/** The notice for a call to action: only when the record shows the prospect really did ask. */
export function ctaNotice(word: string | undefined, facts: Pick<RoomFacts, "consultationRequested" | "purchaseStarted">): Notice | null {
  if (word === "consultation" && facts.consultationRequested) return { tone: "ok", text: CTA_COPY.consultation };
  if (word === "buy" && facts.purchaseStarted) return { tone: "ok", text: CTA_COPY.buy };
  return null;
}

// ---------------------------------------------------------------------------
// The words of the room itself
// ---------------------------------------------------------------------------

/** The company address a person writes to, to ask for their details to be erased. The same one the sign-in pages offer for help. */
export const PRIVACY_EMAIL = "support@iacquire.ai";

export const ROOM_COPY = {
  sampleBanner: "Sample data only. Nothing in this demo is real, nothing is sent to anyone and nothing is booked.",
  tourHeading: "A guided tour of your AI team",
  tourIntro: "Six AI Employees, each with one job. The examples below are invented for this tour so you can see the idea. They are not results and not a promise of any.",
  chatHeading: "Ask the AI team",
  chatIntro: "This assistant only knows what iAcquire has published. It uses sample data, cannot see any real business, and cannot send, book or charge anything.",
  chatOffHeading: "The AI chat is not open",
  priceHeading: "What it costs",
  setupLabel: "One-time setup",
  planLabel: "Optional monthly plan",
  planNote: "The monthly plan is optional. It is never needed to use your system.",
  consultationHeading: "Talk to a person",
  consultationButton: "Book a consultation",
  consultationNote: "Pressing this tells the iAcquire team you would like to talk.",
  consultationLink: "Open the scheduling page",
  consultationNoLink: "The team will see your request. A scheduling page is not set up yet.",
  buyButton: "I'm ready to buy",
  buyNote: "Online checkout is not open yet. Pressing this tells the team you are interested; nothing is charged and no workspace is created.",
  leaveButton: "Leave the demo on this device",
  erasure: `To have your details erased sooner, email ${PRIVACY_EMAIL}.`,
} as const;
