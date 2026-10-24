// The rules of the demo funnel, with no database, clock or network in them: the states a prospect moves through, when a demo window is open, how many messages are left, what
// an extension may do, and when a prospect's details are due to be removed. The server (src/server/demo) applies them with the real time passed in; the tests walk every boundary.
//
// The words "window" and "message" mean the same thing here as in the database: a window opens when the address is confirmed and is OVER at the very moment it ends; a message
// is counted when it is sent and given back only if the answer never came.

export const PROSPECT_STATUSES = ["unverified", "active", "expired", "consultation_requested", "purchase_started", "converted", "declined", "blocked"] as const;
export type ProspectStatus = (typeof PROSPECT_STATUSES)[number];

/** The version of the notice a prospect ticks. The wording is counsel's to approve; this says which text was shown. A PROPOSAL until then. */
export const NOTICE_VERSION = "draft-2026-10";

/** An emailed link stops working after this long (and works once). */
export const VERIFICATION_TTL_HOURS = 48;
/** A prospect's session lasts this long. Reading the conversation again after the window is over works until it ends; a new link is sent only while a window is open. */
export const SESSION_DAYS = 7;
/** Someone who never confirmed their address is cleared after this many days. */
export const UNVERIFIED_RETENTION_DAYS = 7;
/** A message that was counted and never answered (the process died) is given back after this long. */
export const RESERVATION_TIMEOUT_MINUTES = 5;
/** The outbox keeps the text of an emailed link (the link is a credential) this long. */
export const LINK_EMAIL_KEEP_MINUTES = 60;
export const MAX_MESSAGE_CHARS = 1000;
export const MAX_REPLY_CHARS = 4000;
export const MIN_REASON_CHARS = 5;
export const MAX_REASON_CHARS = 500;
export const MAX_NOTE_CHARS = 1000;
export const MAX_NAME_CHARS = 120;
export const MAX_BUSINESS_CHARS = 160;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

/**
 * Where a prospect can go from each state. `expired` is also what a window that has ended IS, whether or not the expiry job has recorded it yet (see accessOf). The two
 * call-to-action states are not left when the window ends: they record what the prospect asked for, and access follows the clock. `converted` is final, and only the
 * explicit conversion a Super Admin runs (or, later, a verified payment) reaches it. A blocked or declined prospect stays so until a Super Admin reopens them.
 */
const TRANSITIONS: Record<ProspectStatus, readonly ProspectStatus[]> = {
  unverified: ["active", "declined", "blocked"],
  active: ["expired", "consultation_requested", "purchase_started", "converted", "declined", "blocked"],
  expired: ["active", "consultation_requested", "purchase_started", "converted", "declined", "blocked"],
  consultation_requested: ["purchase_started", "converted", "declined", "blocked"],
  purchase_started: ["consultation_requested", "converted", "declined", "blocked"],
  converted: [],
  declined: ["unverified", "active", "expired", "consultation_requested", "purchase_started", "blocked"],
  blocked: ["unverified", "active", "expired", "consultation_requested", "purchase_started", "declined"],
};

export const canTransition = (from: ProspectStatus, to: ProspectStatus): boolean => TRANSITIONS[from].includes(to);
export const transitionsFrom = (from: ProspectStatus): readonly ProspectStatus[] => TRANSITIONS[from];

export interface ProspectFacts {
  status: ProspectStatus;
  verifiedAt: Date | null;
  windowEndsAt: Date | null;
  messageLimit: number;
  extraMessages: number;
  messagesUsed: number;
  erasedAt: Date | null;
  consultationRequestedAt?: Date | null;
  purchaseStartedAt?: Date | null;
}

/** What a prospect can do right now, from the facts and the clock. */
export type AccessState = "unverified" | "open" | "ended" | "blocked" | "converted" | "erased";

/** A window is open strictly before the moment it ends: at that moment it is already over. */
export const windowIsOpen = (windowEndsAt: Date | null, now: Date): boolean => windowEndsAt !== null && now.getTime() < windowEndsAt.getTime();

export function accessOf(p: ProspectFacts, now: Date): AccessState {
  if (p.erasedAt) return "erased";
  if (p.status === "blocked" || p.status === "declined") return "blocked";
  if (p.status === "converted") return "converted";
  if (p.status === "unverified" || !p.verifiedAt) return "unverified";
  return windowIsOpen(p.windowEndsAt, now) ? "open" : "ended";
}

export const messageAllowance = (p: Pick<ProspectFacts, "messageLimit" | "extraMessages">): number => p.messageLimit + p.extraMessages;
export const messagesLeft = (p: Pick<ProspectFacts, "messageLimit" | "extraMessages" | "messagesUsed">): number => Math.max(0, messageAllowance(p) - p.messagesUsed);

/** The state to show: a window that has ended is "expired" even before the job has said so, and a call to action is kept as the latest thing the prospect asked for. */
export function effectiveStatus(p: ProspectFacts, now: Date): ProspectStatus {
  if (p.status === "active" && accessOf(p, now) === "ended") return "expired";
  return p.status;
}

// ---------------------------------------------------------------------------
// Chatting
// ---------------------------------------------------------------------------

/** Why a message cannot be taken. The order is the order the reasons are tried in: the more final one wins. */
export type ChatRefusal = "closed" | "blocked" | "not_verified" | "window_ended" | "limit_reached";

export function chatRefusalFor(p: ProspectFacts, now: Date): ChatRefusal | null {
  switch (accessOf(p, now)) {
    case "erased":
    case "blocked":
      return "blocked";
    case "converted":
      return "closed";
    case "unverified":
      return "not_verified";
    case "ended":
      return "window_ended";
    default:
      return messagesLeft(p) > 0 ? null : "limit_reached";
  }
}

export const REFUSAL_COPY: Record<ChatRefusal | "ai_off" | "daily_cap" | "rate_limited" | "unavailable" | "invalid", string> = {
  closed: "This demo is closed because you are now a client. Sign in with your invitation.",
  blocked: "This demo is not available.",
  not_verified: "Confirm your email address to start the demo.",
  window_ended: "Your demo window has ended. You can still read your conversation and ask for a consultation.",
  limit_reached: "You have used all of your demo messages. Ask for a consultation to talk to a person.",
  ai_off: "The AI chat is not available right now. The guided tour shows what the AI team does, with sample data.",
  daily_cap: "The demo chat has reached its limit for today. Please try again tomorrow, or ask for a consultation.",
  rate_limited: "You are sending messages too fast. Wait a moment and try again.",
  unavailable: "The demo is temporarily unavailable.",
  invalid: "That message could not be sent.",
};

// ---------------------------------------------------------------------------
// Extending a demo
// ---------------------------------------------------------------------------

/** States a Super Admin may extend: the demo has started and nobody has closed it. */
const EXTENDABLE: readonly ProspectStatus[] = ["active", "expired", "consultation_requested", "purchase_started"];

export interface ExtensionFacts {
  status: ProspectStatus;
  verifiedAt: Date | null;
  windowEndsAt: Date | null;
  extendedHours: number;
  extendedCount: number;
  extraMessages: number;
  erasedAt: Date | null;
}

export interface ExtensionRequest {
  hours: unknown;
  extraMessages: unknown;
  reason: unknown;
}

export interface ExtensionPlan {
  windowEndsAt: Date;
  extendedHours: number;
  extendedCount: number;
  extraMessages: number;
  /** An expired demo that is open again. */
  reactivates: boolean;
  reason: string;
}

const wholeNumber = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && Number.isSafeInteger(v);

/**
 * What an extension does. The caps are totals for the prospect (everything ever added), the reason is required, and an extension of an ended window runs from now, not from
 * its old end (a day added to a window that ended last week would otherwise be over already). Hours add to the end; messages add to the count.
 */
export function planExtension(
  p: ExtensionFacts,
  request: ExtensionRequest,
  caps: { maxExtensionHours: number; maxExtraMessages: number },
  now: Date,
): { ok: true; plan: ExtensionPlan } | { ok: false; message: string } {
  if (p.erasedAt) return { ok: false, message: "This prospect's details were erased, so there is nothing to extend." };
  if (!EXTENDABLE.includes(p.status) || !p.verifiedAt || !p.windowEndsAt) {
    return {
      ok: false,
      message:
        p.status === "unverified" ? "This prospect has not confirmed their address yet, so their demo has not started."
        : p.status === "converted" ? "This prospect is already a client."
        : "This prospect is blocked or declined. Reopen them first.",
    };
  }
  if (!wholeNumber(request.hours) || !wholeNumber(request.extraMessages)) return { ok: false, message: "Hours and messages must be whole numbers, zero or more." };
  const hours = request.hours;
  const extra = request.extraMessages;
  if (hours === 0 && extra === 0) return { ok: false, message: "Add some hours, some messages, or both." };
  const reason = typeof request.reason === "string" ? request.reason.trim().replace(/\s+/g, " ") : "";
  if (reason.length < MIN_REASON_CHARS) return { ok: false, message: "Say why, in a few words. The reason is kept with the extension." };
  if (reason.length > MAX_REASON_CHARS) return { ok: false, message: `The reason can be up to ${MAX_REASON_CHARS} characters.` };
  if (p.extendedHours + hours > caps.maxExtensionHours) {
    const left = Math.max(0, caps.maxExtensionHours - p.extendedHours);
    return { ok: false, message: left === 0 ? "This demo has already had the most extra hours it can have." : `You can add at most ${left} more hour${left === 1 ? "" : "s"} to this demo.` };
  }
  if (p.extraMessages + extra > caps.maxExtraMessages) {
    const left = Math.max(0, caps.maxExtraMessages - p.extraMessages);
    return { ok: false, message: left === 0 ? "This demo has already had the most extra messages it can have." : `You can add at most ${left} more message${left === 1 ? "" : "s"} to this demo.` };
  }
  const open = windowIsOpen(p.windowEndsAt, now);
  if (!open && hours === 0) return { ok: false, message: "The window has ended. Add hours to open it again." };
  const base = open ? p.windowEndsAt.getTime() : now.getTime();
  const endsAt = new Date(base + hours * HOUR_MS);
  return {
    ok: true,
    plan: {
      windowEndsAt: hours > 0 ? endsAt : p.windowEndsAt,
      extendedHours: p.extendedHours + hours,
      extendedCount: p.extendedCount + 1,
      extraMessages: p.extraMessages + extra,
      reactivates: p.status === "expired" && hours > 0,
      reason,
    },
  };
}

// ---------------------------------------------------------------------------
// Reopening
// ---------------------------------------------------------------------------

/** Where a blocked or declined prospect goes back to: what they had reached, or the state their window says. */
export function reopenTarget(p: ProspectFacts, now: Date): ProspectStatus {
  if (!p.verifiedAt || !p.windowEndsAt) return "unverified";
  if (p.purchaseStartedAt) return "purchase_started";
  if (p.consultationRequestedAt) return "consultation_requested";
  return windowIsOpen(p.windowEndsAt, now) ? "active" : "expired";
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

export interface RetentionFacts {
  status: ProspectStatus;
  verifiedAt: Date | null;
  windowEndsAt: Date | null;
  lastSeenAt: Date | null;
  createdAt: Date;
  erasedAt: Date | null;
}

/** The moment the retention clock counts from: the latest of the window's end, the last visit and, for someone who never confirmed, the day they asked. */
export function retentionAnchor(p: Pick<RetentionFacts, "windowEndsAt" | "lastSeenAt" | "createdAt">): Date {
  return new Date(Math.max(p.createdAt.getTime(), p.windowEndsAt?.getTime() ?? 0, p.lastSeenAt?.getTime() ?? 0));
}

/**
 * What the retention job does with a prospect now: remove the row of someone who never confirmed (nothing was ever shown to them), erase the details and conversation of
 * someone whose demo is over for the retention period, or leave them. A converted prospect is a client now and is left alone; so is a blocked one, because the block is the
 * record that keeps them out (an erasure on request still removes it). The period counts whole days from the anchor and is reached exactly at the boundary.
 */
export function retentionAction(p: RetentionFacts, now: Date, retentionDays: number): "delete" | "erase" | null {
  if (p.erasedAt || p.status === "converted" || p.status === "blocked") return null;
  if (!p.verifiedAt) return now.getTime() - p.createdAt.getTime() >= UNVERIFIED_RETENTION_DAYS * DAY_MS ? "delete" : null;
  return now.getTime() - retentionAnchor(p).getTime() >= retentionDays * DAY_MS ? "erase" : null;
}

// ---------------------------------------------------------------------------
// Text a stranger typed
// ---------------------------------------------------------------------------

/** Control characters, zero-width characters and the Unicode bidirectional overrides: removed from everything a prospect types, so a name cannot reverse the text around it. */
function unsafe(code: number, keepNewlines: boolean): boolean {
  if (code === 10 || code === 9) return !keepNewlines;
  if (code < 32 || code === 127) return true;
  return (code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2060 && code <= 0x2064) || (code >= 0x2066 && code <= 0x2069) || code === 0xfeff;
}

function strip(text: string, keepNewlines: boolean): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (!unsafe(code, keepNewlines)) out += text[i];
    else if (code === 10 || code === 9) out += keepNewlines ? text[i] : " ";
  }
  return out;
}

/** A one-line field (name, business): unsafe characters removed, runs of space made one, trimmed. The caller checks the length of the result. */
export function cleanLine(raw: unknown, max: number): string {
  if (typeof raw !== "string") return "";
  // Cut before the work so a huge paste costs nothing; one extra character lets the caller see it was too long.
  return strip(raw.slice(0, max * 4 + 1), false).replace(/ {2,}/g, " ").trim();
}

/** A chat message: unsafe characters removed, lines kept, blank-line runs shortened, trimmed. */
export function cleanMessage(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return strip(raw.slice(0, MAX_MESSAGE_CHARS * 4 + 1).replace(/\r\n?/g, "\n"), true).replace(/\n{3,}/g, "\n\n").trim();
}

/** A reason or note written by staff: one paragraph of plain text. */
export function cleanNote(raw: unknown, max: number): string {
  return cleanLine(raw, max);
}

/** The few campaign tags a landing page may pass along: known keys only, short values, nothing else. */
export function cleanUtm(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof raw !== "object" || raw === null) return out;
  for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "ref"]) {
    const v = (raw as Record<string, unknown>)[key];
    if (typeof v !== "string") continue;
    const clean = cleanLine(v, 100).slice(0, 100);
    if (clean) out[key] = clean;
  }
  return out;
}

/** The key a browser makes for one message so sending it again counts nothing twice. */
export const isClientMessageId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(v);

/** A token handed out by the server: 32 random bytes, URL-safe base64 (43 characters). */
export const isDemoToken = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v);
