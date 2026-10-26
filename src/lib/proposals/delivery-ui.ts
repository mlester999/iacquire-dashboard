// What the Delivery tab offers and says about sending the customer's link, as plain functions. Pure: the server decides every one of these again and refuses what it should; this
// only keeps the screen from offering what will be refused and from saying more than the record holds.

import { MAX_DELIVERIES_PER_VERSION } from "@/lib/proposals/delivery-text";
import type { DeliveryTone, DeliveryVerdict, DeliveryView } from "@/lib/proposals/delivery-state";

/** The parts of a preview the screen decides on (the server's DeliveryPreview has them all). */
export interface OfferFacts {
  verdict: Pick<DeliveryVerdict, "kind" | "text">;
  standing: Pick<DeliveryView, "label" | "explain" | "channelLabel"> | null;
  remaining: number;
}

export interface Offer {
  /** The Send button is offered. */
  canSend: boolean;
  /** Why it is not, in a sentence the sender can act on. */
  why: string | null;
}

export function offerFor(f: OfferFacts): Offer {
  if (f.standing) return { canSend: false, why: `${f.standing.channelLabel}: ${f.standing.label}. ${f.standing.explain} To send it again, make a new link first.` };
  if (f.remaining <= 0) return { canSend: false, why: `This version has already had ${MAX_DELIVERIES_PER_VERSION} messages. Copy the link and give it to the customer yourself.` };
  if (f.verdict.kind === "refused") return { canSend: false, why: f.verdict.text };
  return { canSend: true, why: null };
}

/** The label of the confirm button: it never says "send" for a message that will wait. */
export const confirmLabelFor = (kind: DeliveryVerdict["kind"]): string => (kind === "waiting" ? "Queue this message" : "Send this message");

/** What the sender is told right after confirming (the server's SendDeliveryResult). Queued is not sent: the message waits for the next sending run, or for sending hours. */
export type SendOutcome =
  | { status: "queued"; waitingUntil: string | null; delivery: Pick<DeliveryView, "channelLabel" | "addressMask"> }
  | { status: "already"; delivery: Pick<DeliveryView, "channelLabel" | "label" | "explain"> }
  | { status: "refused"; text: string };

export function outcomeText(o: SendOutcome, whenText: (iso: string) => string): { tone: "ok" | "info" | "error"; text: string } {
  switch (o.status) {
    case "queued": {
      const to = o.delivery.addressMask ? ` to ${o.delivery.addressMask}` : "";
      return o.waitingUntil
        ? { tone: "ok", text: `Queued to go by ${o.delivery.channelLabel.toLowerCase()}${to} when sending hours open (${whenText(o.waitingUntil)}). It has not been sent yet.` }
        : { tone: "ok", text: `Queued to go by ${o.delivery.channelLabel.toLowerCase()}${to}. It has not been sent yet: it leaves on the next sending run, and the list below shows what happens to it.` };
    }
    case "already": return { tone: "info", text: `Nothing new was sent. ${o.delivery.channelLabel}: ${o.delivery.label}. ${o.delivery.explain}` };
    default: return { tone: "error", text: o.text };
  }
}

/** Colour is never the only signal: every state also has its words. */
export const DELIVERY_BADGE_TONE: Record<DeliveryTone, "neutral" | "success" | "warning" | "danger"> = { neutral: "neutral", success: "success", warning: "warning", danger: "danger" };
