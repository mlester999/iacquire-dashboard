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

/** Why a message was stopped by the proposal's own changes, as recorded on the delivery. */
export const WITHDRAWN_REASON_TEXT: Record<string, string> = {
  proposal_withdrawn: "The proposal was withdrawn before the message went out.",
  proposal_revised: "The proposal was revised, so the message for the earlier version was stopped.",
  link_renewed: "The customer's link was replaced before the message went out, so the message was stopped.",
  answer_recorded: "An answer was recorded by a person before the message went out.",
  proposal_answered: "The customer answered before the message went out.",
  proposal_expired: "The proposal expired before the message went out.",
  privacy_request: "The customer asked for their data to be erased.",
  held_by_person: "A person on your team excluded this customer from automatic messages.",
};

/** What the send chain recorded as the reason a message did not go, in the words the Delivery tab uses. */
export const BLOCKED_REASON_TEXT: Record<string, string> = {
  proposal_link_unavailable: "The proposal can no longer be answered online (it was answered, withdrawn, replaced by a newer version or expired, or its link was closed), so the message was not sent.",
  proposal_changed: "The proposal changed before the message went out, so it was not sent.",
  held_by_person: "A person on your team excluded this customer from automatic messages, so the message was not sent.",
  no_consent: "There is no consent on record for this customer on this channel, so the message was not sent.",
  suppressed: "This customer opted out or the address bounced, so the message was not sent.",
  org_inactive: "The workspace was not active when the message was due, so it was not sent.",
  automation_paused: "Customer messaging was paused when the message was due, so it was not sent.",
  credits: "There were not enough service credits, so the message was not sent.",
  budget: "The monthly spending limit was reached, so the message was not sent.",
  channel_not_ready: "This channel is not set up and enabled, so the message was not sent.",
  contact_unreachable: "There is no address for this customer on this channel, so the message was not sent.",
};

export interface DeliveryFacts {
  channel: DeliveryChannel;
  addressMask: string | null;
  /** The send chain's status for the message; null when the message row is gone. */
  messageStatus: string | null;
  blockedReason: string | null;
  statusDetail: string | null;
  failureKind: string | null;
  sendAfter: Date | string | null;
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
export function describeDelivery(f: DeliveryFacts): DeliveryDescription {
  const word = DELIVERY_CHANNEL_WORDS[f.channel];
  if (f.withdrawnAt) {
    return { state: "withdrawn", label: "Stopped before it was sent", explain: WITHDRAWN_REASON_TEXT[f.withdrawnReason ?? ""] ?? "The message was stopped before it went out.", tone: "neutral", ended: true };
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
    case "blocked": {
      const why = BLOCKED_REASON_TEXT[f.blockedReason ?? ""] ?? (f.blockedReason ? BLOCK_REASON_LABELS[f.blockedReason] : null) ?? f.statusDetail ?? "The message could not be sent.";
      return { state: "blocked", label: "Not sent", explain: why.endsWith(".") ? why : `${why}.`, tone: "warning", ended: true };
    }
    case "failed":
      if (f.failureKind === "unconfirmed") {
        return { state: "failed", label: "Not confirmed", explain: `The ${word} provider did not answer, so the message may or may not have gone. Check with the customer before you send it again.`, tone: "danger", ended: true };
      }
      return { state: "failed", label: "Not sent", explain: `The ${word} provider refused the message${f.statusDetail ? `: ${f.statusDetail.replace(/\.$/, "")}` : ""}. Nothing reached the customer.`, tone: "danger", ended: true };
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
