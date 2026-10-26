// The fingerprint of a message a person read before sending it. Kept apart from delivery-text.ts because that file is imported by screens (client components), and a browser
// bundle cannot read node:crypto: only server code and tests import this one.
import { canonicalJson } from "@/lib/proposals/doc";
import { sha256Hex } from "@/lib/proposals/hash";
import { DELIVERY_WORDING_VERSION, type DeliveryChannel, type RenderedDelivery } from "@/lib/proposals/delivery-text";

/**
 * The fingerprint of everything the sender is shown: the channel, the subject, the exact text (with the customer's link still a placeholder) and the version of the wording.
 * The server renders the message again when the person confirms and refuses to send if the fingerprint differs, so what goes out is what they read.
 */
export function deliveryWordingHash(channel: DeliveryChannel, message: RenderedDelivery): string {
  return sha256Hex(canonicalJson({ v: 1, wording: DELIVERY_WORDING_VERSION, channel, subject: message.subject, body: message.body }));
}
