// The customer's link to a proposal: how long it lasts, the three honest levels of "seen", and the words the public page uses. Pure: the server enforces these rules and the page
// only displays their results.
//
// The numbers below are PROPOSED defaults, not decisions the founder has made: they are engineering choices that keep a bearer link short-lived and an emailed code
// hard to guess, and each is one constant here (docs/roadmap/phases-3-to-7/blockers.md lists them for confirmation).

/** A link with no valid-until date stops working this many days after it was sent. */
export const LINK_DEFAULT_DAYS = 90;
/** A link whose proposal has a valid-until date keeps working this many days past it, so a customer who comes late is told the proposal expired instead of "invalid link". */
export const LINK_GRACE_DAYS = 30;
/** No link lives longer than this. */
export const LINK_MAX_DAYS = 400;

const DAY_MS = 86_400_000;

/**
 * When a link stops opening at all. The proposal's own validity is a separate rule, worked out in the workspace's time zone (validityOn); this is only the credential's life,
 * so a margin of a day and a half past the date covers every time zone.
 */
export function linkExpiresAt(sentAt: Date, validUntil: string | null): Date {
  const cap = sentAt.getTime() + LINK_MAX_DAYS * DAY_MS;
  if (!validUntil) return new Date(Math.min(cap, sentAt.getTime() + LINK_DEFAULT_DAYS * DAY_MS));
  const lastDay = Date.parse(`${validUntil}T00:00:00Z`);
  const wanted = Number.isFinite(lastDay) ? lastDay + (LINK_GRACE_DAYS + 1) * DAY_MS + 14 * 3_600_000 : sentAt.getTime() + LINK_DEFAULT_DAYS * DAY_MS;
  return new Date(Math.min(cap, Math.max(sentAt.getTime() + DAY_MS, wanted)));
}

// ---------------------------------------------------------------------------
// The emailed code
// ---------------------------------------------------------------------------

export const CODE_DIGITS = 6;
export const CODE_TTL_MINUTES = 10;
/** Wrong entries one code allows. */
export const CODE_MAX_ATTEMPTS = 5;
/** At least this long between two codes for one link. */
export const CODE_COOLDOWN_SECONDS = 60;
/** The most codes one link can ask for in an hour. */
export const CODE_MAX_PER_LINK_PER_HOUR = 5;
/** A verified session lasts this long after its last use, and never past SESSION_MAX_HOURS from the start. */
export const SESSION_SLIDE_MINUTES = 30;
export const SESSION_MAX_HOURS = 8;
/** The most change requests one link can send in a day. */
export const CHANGE_REQUESTS_PER_DAY = 5;

export const CODE_RE = /^\d{6}$/;

/** A code as a person typed it: spaces and dashes (people write "123 456") dropped. Null when it cannot be a code. */
export function cleanCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const s = input.replace(/[\s-]/g, "");
  return CODE_RE.test(s) ? s : null;
}

/** "maria.santos@example.com" -> "m***@example.com": enough to recognise the address, not enough to learn it. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

// ---------------------------------------------------------------------------
// Three honest levels of "seen"
// ---------------------------------------------------------------------------

export type SeenLevel = "none" | "opened" | "viewed" | "verified";

export interface SeenFacts {
  openCount: number;
  viewedCount: number;
  verifiedAt: Date | string | null;
}

/**
 * The strongest thing that is known. "Opened" is only a request for the page: an email security scanner or a link preview does that too, so it never counts as viewed. "Viewed" is
 * a browser that kept the page open and was used. "Verified" is someone who entered the code emailed to the recipient.
 */
export function seenLevel(f: SeenFacts): SeenLevel {
  if (f.verifiedAt) return "verified";
  if (f.viewedCount > 0) return "viewed";
  if (f.openCount > 0) return "opened";
  return "none";
}

export const SEEN_LABELS: Record<SeenLevel, { label: string; explain: string }> = {
  none: { label: "Not opened", explain: "Nobody has opened the link." },
  opened: { label: "Link opened", explain: "The link was requested. That can be an email security scanner or a link preview rather than the customer, so it does not count as read." },
  viewed: { label: "Viewed in a browser", explain: "The page stayed open in a browser and someone used it. It does not show who, or that it was read." },
  verified: { label: "Opened by someone with the code", explain: "Someone entered the code emailed to the customer's address. That shows control of that mailbox, not who they are." },
};

// ---------------------------------------------------------------------------
// What the public page says
// ---------------------------------------------------------------------------

export type PublicState = "open" | "answered" | "expired" | "withdrawn" | "link_expired" | "unavailable" | "invalid" | "rate_limited" | "disabled";

export const PUBLIC_STATE_TEXT: Record<Exclude<PublicState, "open" | "answered">, { title: string; body: string }> = {
  expired: { title: "This proposal has expired", body: "The date it was valid until has passed, so it can no longer be accepted. Contact the business if you still want to go ahead." },
  withdrawn: { title: "This link is no longer active", body: "The business may have withdrawn this proposal or sent you a newer version. Contact them to ask." },
  link_expired: { title: "This link has expired", body: "For your security, links stop working after a while. Contact the business for a new one." },
  unavailable: { title: "This proposal isn't available right now", body: "Please contact the business directly." },
  invalid: { title: "This link isn't valid", body: "It may have been cut short when it was copied. Open the link straight from the message you received." },
  rate_limited: { title: "One moment, please", body: "This page has been opened many times in a short while. Wait a few minutes, then open it again." },
  disabled: { title: "Proposals are temporarily unavailable", body: "Please try again later, or contact the business directly." },
};

/**
 * Where the signing of a proposal that asks for a signature stands, as far as the customer may be told. none: no signing request exists for this version. preparing: it is being
 * handed to the signing service. sent: the service was asked to email the signer. viewed: the service reports the signer opened it. ended: a request existed and is over without
 * a signature the business accepted (withdrawn, declined, ran out, could not be sent): nothing is waiting for the customer.
 */
export type PublicSigningState = "none" | "preparing" | "sent" | "viewed" | "ended";

export interface PublicSigning {
  state: PublicSigningState;
  /** The signing service's name, as the customer will see it in the email. */
  providerLabel: string | null;
  /** The address the signing service was asked to write to, masked. It can differ from the address the customer confirms with a code. */
  signerEmailMasked: string | null;
  /** A stand-in used in tests and demonstrations: nothing was sent and nothing is binding. */
  simulated: boolean;
}

/** What the customer is told about signing. Never says the proposal is signed (that is the answer panel's job, from a recorded answer) and never invites a signature on this page. */
export function publicSigningText(business: string, s: PublicSigning): string {
  const via = s.providerLabel ?? "a signing service";
  const to = s.signerEmailMasked ? ` (to ${s.signerEmailMasked})` : "";
  const prefix = s.simulated ? "Simulated, for testing: no real document was sent and nothing here is binding. " : "";
  switch (s.state) {
    case "preparing": return `${prefix}${business} is sending a document for you to sign through ${via}${to}. Signing that document is how this proposal is accepted. It can't be accepted on this page.`;
    case "sent": return `${prefix}${business} asked ${via} to email a document for you to sign${to}. Signing that document is how this proposal is accepted. It can't be accepted on this page. If you can't find the email, check your spam folder or contact ${business}.`;
    case "viewed": return `${prefix}${via} reports that the document ${business} sent${to} was opened. Signing it is how this proposal is accepted. It can't be accepted on this page.`;
    case "ended": return `${prefix}No signing document is waiting for you at the moment. Contact ${business} if you want to go ahead.`;
    default: return `${prefix}This proposal is accepted by signing a document, which ${business} sends you. They haven't sent it yet. It can't be accepted on this page. Contact ${business} to go ahead.`;
  }
}

export type DecideOutcome =
  | "accepted" | "declined" | "changes_requested"
  | "already" | "conflict" | "not_verified" | "unavailable" | "expired" | "stale" | "needs_signature" | "needs_note" | "ack_required" | "no_email" | "rate_limited" | "invalid";

export const DECIDE_TEXT: Record<DecideOutcome, { tone: "ok" | "error"; text: string }> = {
  accepted: { tone: "ok", text: "Your acceptance was recorded. The business has been told." },
  declined: { tone: "ok", text: "Your answer was recorded. The business has been told." },
  changes_requested: { tone: "ok", text: "Your request was sent to the business." },
  already: { tone: "ok", text: "Your answer was already recorded." },
  conflict: { tone: "error", text: "This proposal was already answered differently, so nothing changed." },
  not_verified: { tone: "error", text: "Confirm your email address with the code first." },
  unavailable: { tone: "error", text: "This proposal can't be answered right now. Contact the business." },
  expired: { tone: "error", text: "This proposal has expired, so it can no longer be answered." },
  stale: { tone: "error", text: "The proposal changed since you opened this page. Reload to see the current version." },
  needs_signature: { tone: "error", text: "This proposal is accepted by signing the document the business sends you, so it can't be accepted on this page." },
  needs_note: { tone: "error", text: "Say what you would like changed." },
  ack_required: { tone: "error", text: "Tick the box to confirm before accepting." },
  no_email: { tone: "error", text: "The business has no email address on file for you, so this can't be answered here. Contact them." },
  rate_limited: { tone: "error", text: "Too many attempts in a short while. Wait a few minutes, then try again." },
  invalid: { tone: "error", text: "Something in the form wasn't right. Please try again." },
};

export type CodeOutcome = "sent" | "cooldown" | "rate_limited" | "unavailable" | "no_email" | "email_failed" | "invalid" | "verified" | "wrong" | "locked" | "no_code";

export const CODE_TEXT: Record<CodeOutcome, { tone: "ok" | "error"; text: string }> = {
  sent: { tone: "ok", text: "We emailed a 6-digit code. It works for 10 minutes." },
  cooldown: { tone: "error", text: "A code was just sent. Wait a minute before asking for another." },
  rate_limited: { tone: "error", text: "Too many attempts in a short while. Wait a while, then try again." },
  unavailable: { tone: "error", text: "This proposal can't be answered right now. Contact the business." },
  no_email: { tone: "error", text: "The business has no email address on file for you, so a code can't be sent. Contact them." },
  email_failed: { tone: "error", text: "The email couldn't be sent. Try again in a few minutes, or contact the business." },
  invalid: { tone: "error", text: "Enter the 6-digit code from the email." },
  verified: { tone: "ok", text: "Your email address is confirmed." },
  wrong: { tone: "error", text: "That code isn't right." },
  locked: { tone: "error", text: "Too many wrong codes. Ask for a new one." },
  no_code: { tone: "error", text: "That code has expired or was already used. Ask for a new one." },
};
