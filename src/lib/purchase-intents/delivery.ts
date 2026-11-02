// Purchase invitation delivery: what an attempt to put a purchase link in a buyer's hands can be, the plain words the team reads about it, the limits on sending again, and the
// email itself. Pure (no database, no environment), so the screen, the service and a test agree.
//
// The rule that shapes everything here: a purchase link is a bearer credential and only a hash of it is stored. The email's own text therefore carries the link, and the copy the
// outbox keeps (storedText) has the link cut out, so no table and no log ever holds a working link.

import { formatUsdCents } from "@/lib/purchase-intents/rules";

export const DELIVERY_KINDS = ["invitation", "resend", "rotation"] as const;
export type DeliveryKind = (typeof DELIVERY_KINDS)[number];

export const DELIVERY_STATUSES = ["pending", "sent", "delivered", "bounced", "failed", "manual"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export type DeliveryReason = "chosen" | "email_off" | "email_not_configured" | "sender_not_ready" | "provider_refused" | "provider_unreachable";
export const DELIVERY_REASONS: readonly DeliveryReason[] = ["chosen", "email_off", "email_not_configured", "sender_not_ready", "provider_refused", "provider_unreachable"];

export type DeliveryTone = "neutral" | "primary" | "warning" | "success" | "danger";

/** Short labels. "Sent" never means "delivered": that word is kept for the provider's own later notice. */
export const DELIVERY_STATUS_TEXT: Record<DeliveryStatus, string> = {
  pending: "Pending",
  sent: "Sent to the email provider",
  delivered: "Delivered",
  bounced: "Bounced",
  failed: "Failed",
  manual: "Manual sharing required",
};

export const DELIVERY_STATUS_TONE: Record<DeliveryStatus, DeliveryTone> = {
  pending: "neutral",
  sent: "primary",
  delivered: "success",
  bounced: "danger",
  failed: "danger",
  manual: "warning",
};

export const DELIVERY_KIND_TEXT: Record<DeliveryKind, string> = {
  invitation: "First invitation",
  resend: "Sent again with a new link",
  rotation: "New link for hand sharing",
};

export const DELIVERY_REASON_TEXT: Record<DeliveryReason, string> = {
  chosen: "Email was not requested for this link.",
  email_off: "Email delivery is switched off in this environment (EMAIL_PROVIDER is not \"resend\").",
  email_not_configured: "No email provider key is set (RESEND_API_KEY).",
  sender_not_ready: "The sender address is still a placeholder (EMAIL_FROM). Use an address on a domain verified with the email provider.",
  provider_refused: "The email provider refused the message.",
  provider_unreachable: "The email provider could not be reached.",
};

/** How long a delivery may stay "pending" before the page stops waiting for it and says no result was recorded. */
export const PENDING_STALE_MINUTES = 5;

export interface DeliverySummary {
  status: DeliveryStatus;
  reason: DeliveryReason | null;
  recipient: string;
  error: string | null;
}

/** What the team should believe about a delivery, in one honest paragraph. */
export function deliverySentence(d: DeliverySummary, opts: { stale?: boolean } = {}): string {
  const to = d.recipient;
  switch (d.status) {
    case "pending":
      return opts.stale
        ? `No result was recorded for the email to ${to}. Treat it as not sent: send the invitation again, or share a new link by hand.`
        : `The email to ${to} is being sent. If this stays pending, send the invitation again.`;
    case "sent":
      return `The email provider accepted the message for ${to}. That means it left iAcquire, not that it reached the inbox: if it does not arrive, ask the buyer to check spam, or send it again.`;
    case "delivered":
      return `The email provider reported the message delivered to ${to}'s mail server. That is not proof the buyer has read it.`;
    case "bounced":
      return `${to}'s mail server did not accept the message${d.error ? ` (${d.error})` : ""}. Check the address, then send the invitation again or share a new link by hand.`;
    case "failed":
      return `The email to ${to} could not be sent${d.reason ? `: ${DELIVERY_REASON_TEXT[d.reason].replace(/\.$/, "")}` : ""}${d.error ? ` (${d.error})` : ""}. The invitation exists; send it again once that is fixed, or share a new link by hand.`;
    case "manual":
      return `No email was sent. ${d.reason ? DELIVERY_REASON_TEXT[d.reason] : ""} Share the link with ${to} yourself, or fix email delivery and send the invitation again.`.replace(/\s{2,}/g, " ");
  }
}

/** One delivery as the screens show it. The same shape appears on the creation form, the list and the detail page, so they cannot disagree. */
export interface DeliveryView {
  id: string;
  kind: DeliveryKind;
  kindText: string;
  status: DeliveryStatus;
  /** A pending delivery with no result for too long reads "Pending, no result recorded": the page stops waiting for it. */
  statusText: string;
  tone: DeliveryTone;
  reason: DeliveryReason | null;
  recipient: string;
  provider: "resend" | "capture" | "none";
  error: string | null;
  linkExpiresAt: string;
  createdAt: string;
  completedAt: string | null;
  stale: boolean;
  sentence: string;
}

export interface DeliveryRecord {
  id: string;
  kind: DeliveryKind;
  status: DeliveryStatus;
  reason: DeliveryReason | null;
  recipient: string;
  provider: "resend" | "capture" | "none";
  error: string | null;
  linkExpiresAt: Date | string;
  createdAt: Date | string;
  completedAt: Date | string | null;
}

export function toDeliveryView(r: DeliveryRecord, now: Date): DeliveryView {
  const created = new Date(r.createdAt);
  const stale = r.status === "pending" && now.getTime() - created.getTime() > PENDING_STALE_MINUTES * 60_000;
  return {
    id: r.id,
    kind: r.kind,
    kindText: DELIVERY_KIND_TEXT[r.kind],
    status: r.status,
    statusText: stale ? "Pending, no result recorded" : DELIVERY_STATUS_TEXT[r.status],
    tone: stale ? "warning" : DELIVERY_STATUS_TONE[r.status],
    reason: r.reason,
    recipient: r.recipient,
    provider: r.provider,
    error: r.error,
    linkExpiresAt: new Date(r.linkExpiresAt).toISOString(),
    createdAt: created.toISOString(),
    completedAt: r.completedAt ? new Date(r.completedAt).toISOString() : null,
    stale,
    sentence: deliverySentence(r, { stale }),
  };
}

// ---------------------------------------------------------------------------
// Sending again
// ---------------------------------------------------------------------------

/** One new link per minute per purchase: a double press or a retried request must never mint two links, because each new link kills the one just emailed. */
export const RESEND_COOLDOWN_SECONDS = 60;
/** Links made for one purchase in a day (resends and hand-shared rotations together). */
export const MAX_LINK_SENDS_PER_DAY = 6;

export interface SendAgainGate {
  ok: boolean;
  reason?: string;
  retryAfterSeconds?: number;
}

export function canSendAgain(input: { lastAt: Date | null; sendsInLastDay: number }, now: Date): SendAgainGate {
  if (input.lastAt) {
    const waited = (now.getTime() - input.lastAt.getTime()) / 1000;
    if (waited < RESEND_COOLDOWN_SECONDS) {
      const retryAfterSeconds = Math.max(1, Math.ceil(RESEND_COOLDOWN_SECONDS - waited));
      return { ok: false, retryAfterSeconds, reason: `A link was made a moment ago. Wait ${retryAfterSeconds} second${retryAfterSeconds === 1 ? "" : "s"} before making another: each new link replaces the last one.` };
    }
  }
  if (input.sendsInLastDay >= MAX_LINK_SENDS_PER_DAY) {
    return { ok: false, reason: `${MAX_LINK_SENDS_PER_DAY} links were already made for this purchase today. Try again tomorrow, or contact the buyer another way.` };
  }
  return { ok: true };
}

/** A key a browser makes once per press, so a retried request is one request. */
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,64}$/;

// ---------------------------------------------------------------------------
// The email
// ---------------------------------------------------------------------------

export interface InvitationEmailInput {
  kind: Exclude<DeliveryKind, "rotation">;
  buyerName: string;
  company: string;
  reference: string;
  setupFeeCents: number;
  maintenanceSelected: boolean;
  maintenanceMonthlyCents: number;
  expiresAt: string;
  /** The buyer's business time zone: the expiry is written in it, with the zone's short name. */
  timezone: string;
  /** The whole public link, with the token. Present only in memory, for the time it takes to send. */
  link: string;
}

export interface BuiltInvitationEmail {
  subject: string;
  /** What the buyer receives (the plain-text part, and the source the branded HTML is drawn from). Contains the link. */
  text: string;
  /** What the outbox keeps: the same words with the link cut out. */
  storedText: string;
}

export const LINK_NOT_STORED = "[secure link not stored]";

/** Replaces the token of any purchase link in a text, so a copy of it can be kept without being a working credential. */
export function maskPurchaseLinks(text: string): string {
  return text.replace(/(\/purchase\/)[A-Za-z0-9_-]{43}\b/g, `$1${LINK_NOT_STORED}`);
}

/** The buyer's expiry in their own zone ("November 16, 2026 at 6:00 AM CST"); the UTC date if the zone is not one the platform knows. */
export function formatExpiry(iso: string, timezone: string): string {
  const when = new Date(iso);
  try {
    // Explicit parts: dateStyle and timeStyle cannot be combined with a zone name.
    return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: timezone, timeZoneName: "short" }).format(when);
  } catch {
    return `${new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" }).format(when)} (UTC)`;
  }
}

const oneLine = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

export function buildInvitationEmail(i: InvitationEmailInput): BuiltInvitationEmail {
  const company = oneLine(i.company, 80) || "your business";
  const first = oneLine(i.buyerName, 60).split(" ")[0] || "there";
  const maintenance = i.maintenanceSelected
    ? `${formatUsdCents(i.maintenanceMonthlyCents)}/month, selected. It is billed separately: nothing is charged for it now.`
    : `Optional, ${formatUsdCents(i.maintenanceMonthlyCents)}/month. Not selected.`;
  const intro = i.kind === "resend"
    ? `Here is a new secure link for your iAcquireOS purchase for ${company}. It replaces the link we emailed earlier, which no longer works. Nothing is charged until you choose to pay on the payment provider's own page.`
    : `iAcquire has prepared your iAcquireOS launch offer for ${company}. Open the secure link below to review it and confirm when you are ready. Nothing is charged until you choose to pay on the payment provider's own page.`;
  const lines = [
    `Hi ${first},`,
    "",
    intro,
    "",
    `Company: ${company}`,
    `One-time setup: ${formatUsdCents(i.setupFeeCents)}`,
    `Maintenance plan: ${maintenance}`,
    `Reference: ${i.reference}`,
    `Link expires: ${formatExpiry(i.expiresAt, i.timezone)}`,
    "",
    `Review your purchase: ${i.link}`,
    "",
    "This link is private to you. Please do not forward it.",
    "If you were not expecting this email, you can ignore it: nothing happens until you open the link and confirm.",
  ];
  const text = lines.join("\n");
  let origin = "";
  try {
    origin = new URL(i.link).origin;
  } catch {
    origin = "";
  }
  return {
    subject: i.kind === "resend" ? `Your new iAcquireOS purchase link for ${company}` : `Your iAcquireOS purchase invitation for ${company}`,
    text,
    // Every copy of the link is replaced whatever shape it has, and any other purchase link that slipped into the words is masked as well.
    storedText: maskPurchaseLinks(text.split(i.link).join(`${origin}/purchase/${LINK_NOT_STORED}`)),
  };
}
