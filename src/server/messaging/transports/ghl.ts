import "server-only";
import { CHANNELS } from "@/lib/messaging";
import { ghlProvider, type ChannelProvider, type ProviderSendRequest } from "@/server/messaging/provider";
import type { ChannelTransport, TransportName, TransportSendRequest } from "@/server/messaging/transports/types";

// GoHighLevel as a ChannelTransport. The HTTP call, its gate (GHL_WRITES_ENABLED), the official-host pin and the error mapping stay in
// ghlProvider (provider.ts), unchanged, so a GoHighLevel workspace sends exactly what it sent before native transports existed.

/**
 * What send.ts hands a transport, plus our whatsapp_templates.template_id. GoHighLevel addresses a template by that id, while the
 * provider-neutral `template` names it (Meta's way), so the id travels alongside for this transport only.
 */
export interface GhlTransportRequest extends TransportSendRequest {
  templateId?: string | null;
}

/** The provider-neutral request in GoHighLevel's original shape (contact id, from-identity, template id). */
export function toProviderRequest(req: TransportSendRequest): ProviderSendRequest {
  const templateId = (req as GhlTransportRequest).templateId ?? null;
  return {
    orgId: req.orgId,
    channel: req.channel,
    contactRef: req.contactRef ?? "",
    body: req.body,
    subject: req.subject ?? null,
    templateId,
    fromIdentity: req.sender.identity,
    messageId: req.messageId,
    to: req.to,
    sender: req.sender,
    inReplyTo: req.inReplyTo ?? null,
    references: req.references ?? [],
    unsubscribeUrl: req.unsubscribeUrl ?? null,
    template: req.template ?? null,
  };
}

/**
 * Wraps a provider written against the original contract (ghlProvider, or a test recorder) as a transport. Such a provider addresses
 * GoHighLevel contacts, so it requires the contact reference and may carry every channel.
 */
export function transportFromProvider(provider: ChannelProvider): ChannelTransport {
  return {
    // The name is recorded on the message as given, as it always was.
    name: provider.name as TransportName,
    channels: CHANNELS,
    requiresContactRef: true,
    send: (req) => provider.send(toProviderRequest(req)),
  };
}

export const ghlTransport: ChannelTransport = { ...transportFromProvider(ghlProvider), name: "ghl" };
