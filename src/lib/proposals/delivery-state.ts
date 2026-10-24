// How a proposal's message to the customer is described to the team. Pure.
//
// The message itself lives in the send chain (conversation_messages), and its status there is what the provider and the rules said. This turns that into words that claim no more
// than the database holds: "queued", "sent by email to a***@…" (the provider accepted it), "not sent" with the reason. It NEVER says the message was delivered, read or received,
// whatever a provider's callback reported: iAcquire cannot know that the customer saw it, and the three honest levels of "seen" on the link are the only evidence of that.

import { BLOCK_REASON_LABELS } from "@/lib/messaging";
import { DELIVERY_CHANNEL_LABELS, DELIVERY_CHANNEL_WORDS, type DeliveryChannel } from "@/lib/proposals/delivery-text";
import { maskEmail } from "@/lib/proposals/share";

/** "maria@example.com" -> "m***@example.com"; a phone number keeps only its last four digits. */
export function maskAddress(channel: DeliveryChannel, address: string): string {
  if (channel === "email") return maskEmail(address);
  const digits = address.replace(/\D/g, "");
  return digits.length <= 4 ? "***" : `***${digits.slice(-4)}`;
}

export type DeliveryState = "waiting" | "queued" | "sending" | "sent" | "blocked" | "failed" | "withdrawn";
export type DeliveryTone = "neutral" | "success" | "warning" | "danger";

/** The reasons a proposal's own changes stop a queued message with (stored on the delivery, and on the message as its blocked reason). */
export type WithdrawReason = "proposal_withdrawn" | "proposal_revised" | "proposal_link_renewed" | "proposal_answered" | "proposal_expired" | "privacy_request";

/** Why a message was stopped by the proposal's own changes. */
export const WITHDRAWN_REASON_TEXT: Record<WithdrawReason, string> = {
  proposal_withdrawn: "The proposal was withdrawn before the message went out, so it was stopped.",
  proposal_revised: "The proposal was revised, so the message about the earlier version was stopped.",
  proposal_link_renewed: "The customer's link was replaced before the message went out, so the message was stopped.",
  proposal_answered: "The proposal was answered before the message went out, so it was stopped.",
  proposal_expired: "The proposal expired before the message went out, so it was stopped.",
  privacy_request: "The customer asked for their data to be erased, so the message was stopped.",
};

/** What the send chain gave as the reason, without its ending: "There is no consent on record for this customer on this channel". */
const REASON_CORE: Record<string, string> = {
  no_consent: "There is no consent on record for this customer on this channel",
  suppressed: "This customer opted out, or the address bounced",
  held_by_person: "A person on your team excluded this customer from automatic messages",
  org_inactive: "The workspace is not active",
  automation_paused: "Customer messaging is paused",
  credits: "There are not enough service credits",
  budget: "The monthly spending limit has been reached",
  channel_not_ready: "This channel is not set up and enabled",
  contact_unreachable: "There is no address for this customer on this channel",
  identity_unverified: "The customer typed this address or number into the website chat and nobody has confirmed it",
  whatsapp_window_closed: "WhatsApp only allows a free-form message within a day of the customer's last message, and this one needs an approved template",
  rate_not_published: "No usage rate has been published for this channel yet",
  provider_not_enabled: "Sending through this channel's provider is not switched on",
};

/**
 * What differs between the documents a message can carry (a proposal's link, an invoice's link): the words for what stopped a message before it went out, for a link that had
 * stopped working when the message was due, and for the reasons only that document has. Everything else, and above all the rule that a state never says more than the database
 * holds, is shared. A proposal's words are the default.
 */
export interface DeliveryVocab {
  /** Why a message was stopped by the document's own changes, by the reason stored on the delivery. */
  withdrawn: Record<string, string>;
  /** The dispatcher's reason for a message whose link had stopped working when it was due, and what to say about it. */
  linkUnavailable: { reason: string; text: string };
  /** Reasons only this document has, in the same form as the send chain's. */
  reasons: Record<string, string>;
}

const PROPOSAL_VOCAB: DeliveryVocab = {
  withdrawn: WITHDRAWN_REASON_TEXT,
  linkUnavailable: {
    reason: "proposal_link_unavailable",
    text: "The proposal's link had stopped working when the message was due (the proposal was answered, withdrawn, replaced by a newer version or expired, or its link was closed), so it was not sent.",
  },
  reasons: {
    address_differs: "The email address on the proposal is not the one on the customer's record",
    no_customer: "The proposal is not linked to a customer record, so there is no address to send to",
  },
};

const stripEnd = (s: string) => s.replace(/[.!?\s]+$/, "");

function reasonCore(reason: string | null | undefined, detail: string | null | undefined, vocab: DeliveryVocab): string | null {
  if (reason && Object.hasOwn(vocab.reasons, reason)) return vocab.reasons[reason];
  if (reason && Object.hasOwn(REASON_CORE, reason)) return REASON_CORE[reason];
  if (detail && detail.trim()) return stripEnd(detail.trim());
  if (reason && Object.hasOwn(BLOCK_REASON_LABELS, reason)) return BLOCK_REASON_LABELS[reason];
  return null;
}

/** After the fact: why a message did not go. */
export function blockedReasonText(reason: string | null | undefined, detail: string | null | undefined, vocab: DeliveryVocab = PROPOSAL_VOCAB): string {
  if (reason === vocab.linkUnavailable.reason) return vocab.linkUnavailable.text;
  if (reason && Object.hasOwn(vocab.withdrawn, reason)) return vocab.withdrawn[reason];
  const core = reasonCore(reason, detail, vocab);
  return core ? `${core}, so the message was not sent.` : "The message could not be sent.";
}

/** Before sending: why the message cannot be sent now. */
export function refusalReasonText(reason: string | null | undefined, detail: string | null | undefined, vocab: DeliveryVocab = PROPOSAL_VOCAB): string {
  const core = reasonCore(reason, detail, vocab);
  return core ? `${core}, so it can't be sent.` : "It can't be sent right now.";
}

/** What the send chain would do with a message, as the sender is told before confirming. */
export interface VerdictInput {
  allow: boolean;
  reason?: string | null;
  detail?: string | null;
  retryAt?: Date | string | null;
  permanent?: boolean;
}

export interface DeliveryVerdict {
  kind: "ready" | "waiting" | "refused";
  reason: string | null;
  /** One or two plain sentences. Nothing is sent until the sender confirms. */
  text: string;
  /** For "waiting": when sending hours open (ISO). */
  waitingUntil: string | null;
}

export function deliveryVerdict(d: VerdictInput, channel: DeliveryChannel, mask: string | null, vocab: DeliveryVocab = PROPOSAL_VOCAB): DeliveryVerdict {
  const word = DELIVERY_CHANNEL_WORDS[channel];
  const to = mask ? ` to ${mask}` : "";
  if (d.allow) return { kind: "ready", reason: null, text: `Nothing is sent until you confirm. Then it is queued to go by ${word}${to} on the next sending run.`, waitingUntil: null };
  if (d.retryAt && !d.permanent) {
    const until = new Date(d.retryAt).toISOString();
    return { kind: "waiting", reason: d.reason ?? null, text: `Sending hours are closed for this customer right now. If you confirm, it is queued to go by ${word}${to} when they open. Nothing is sent until you confirm.`, waitingUntil: until };
  }
  return { kind: "refused", reason: d.reason ?? null, text: refusalReasonText(d.reason, d.detail, vocab), waitingUntil: null };
}

export interface DeliveryFacts {
  channel: DeliveryChannel;
  addressMask: string | null;
  /** The send chain's status for the message; null when the message row is gone. */
  messageStatus: string | null;
  blockedReason: string | null;
  statusDetail: string | null;
  failureKind: string | null;
  sendAfter: Date | string | null;
  /** When the provider took the message, if it did. A message that fails after that was reported failed by the provider, not refused by it. */
  sentAt?: Date | string | null;
  withdrawnAt: Date | string | null;
  withdrawnReason: string | null;
  now: Date;
}

export interface DeliveryDescription {
  state: DeliveryState;
  /** A few words: "Queued", "Sent by email", "Not sent". */
  label: string;
  /** One or two sentences, plain, claiming nothing the database does not hold. */
  explain: string;
  tone: DeliveryTone;
  /** Nothing is on its way and nothing reached the provider: a new message on this channel may be sent. */
  ended: boolean;
}

const to = (mask: string | null) => (mask ? ` to ${mask}` : "");

/** The state of one delivery, from the facts the send chain holds. */
export function describeDelivery(f: DeliveryFacts, vocab: DeliveryVocab = PROPOSAL_VOCAB): DeliveryDescription {
  const word = DELIVERY_CHANNEL_WORDS[f.channel];
  if (f.withdrawnAt) {
    const why = f.withdrawnReason && Object.hasOwn(vocab.withdrawn, f.withdrawnReason) ? vocab.withdrawn[f.withdrawnReason] : "The message was stopped before it went out.";
    return { state: "withdrawn", label: "Stopped before it was sent", explain: why, tone: "neutral", ended: true };
  }
  switch (f.messageStatus) {
    case null:
      return { state: "withdrawn", label: "Message removed", explain: "The record of this message was removed, so nothing more can be said about it.", tone: "neutral", ended: true };
    case "draft":
    case "queued": {
      const later = f.sendAfter ? new Date(f.sendAfter).getTime() > f.now.getTime() : false;
      if (later) return { state: "waiting", label: "Waiting for sending hours", explain: `Queued to go by ${word}${to(f.addressMask)} when sending hours open. It has not been sent yet.`, tone: "neutral", ended: false };
      return { state: "queued", label: "Queued", explain: `Queued to go by ${word}${to(f.addressMask)}. It has not been sent yet.`, tone: "neutral", ended: false };
    }
    case "sending":
      return { state: "sending", label: "Being sent", explain: `Being handed to the ${word} provider now. The result is not known yet.`, tone: "neutral", ended: false };
    case "sent":
    case "delivered":
    case "read":
      // A provider may later report more than "accepted"; the team is still told no more than that the provider took it.
      return { state: "sent", label: `Sent by ${word}`, explain: `Handed to the ${word} provider${to(f.addressMask)}. That only means the provider accepted it: iAcquire cannot tell you it arrived or that the customer saw it.`, tone: "success", ended: false };
    case "blocked":
      return { state: "blocked", label: "Not sent", explain: blockedReasonText(f.blockedReason, f.statusDetail, vocab), tone: "warning", ended: true };
    case "failed":
      if (f.failureKind === "unconfirmed") {
        return { state: "failed", label: "Not confirmed", explain: `The ${word} provider did not answer, so the message may or may not have gone. Check with the customer before you send it again.`, tone: "danger", ended: true };
      }
      if (f.sentAt) {
        return { state: "failed", label: "Failed after it was sent", explain: `The ${word} provider took the message${to(f.addressMask)} and later reported that it failed${f.statusDetail ? `: ${stripEnd(f.statusDetail)}` : ""}. Check the customer's details before you send it again.`, tone: "danger", ended: true };
      }
      return { state: "failed", label: "Not sent", explain: `The ${word} provider refused the message${f.statusDetail ? `: ${stripEnd(f.statusDetail)}` : ""}. Nothing reached the customer.`, tone: "danger", ended: true };
    default:
      return { state: "queued", label: "Queued", explain: "The message is with the send chain.", tone: "neutral", ended: false };
  }
}

export interface DeliveryView extends DeliveryDescription {
  id: string;
  version: number;
  channel: DeliveryChannel;
  channelLabel: string;
  requestedByName: string | null;
  requestedAt: string;
  addressMask: string | null;
  /** When a waiting message becomes due. Null in every other state. */
  sendAfter: string | null;
  sentAt: string | null;
}

export const channelLabel = (c: DeliveryChannel): string => DELIVERY_CHANNEL_LABELS[c];
