import "server-only";
import type { Channel } from "@/lib/messaging";

// The contract every message transport implements: GoHighLevel (the existing one) and the native ones (Resend email, Twilio SMS, Meta
// WhatsApp Business Cloud API). One transport per workspace and channel, named by messaging_channels.provider. A transport only sends; every
// rule about whether a message may go (consent, suppression, quiet hours, human takeover, credits, approval) is decided before it is called,
// in src/server/messaging/send.ts, the same way for every provider.

export type TransportName = "ghl" | "resend" | "twilio" | "meta_whatsapp";
export type NativeTransportName = Exclude<TransportName, "ghl">;
export const TRANSPORT_NAMES: readonly TransportName[] = ["ghl", "resend", "twilio", "meta_whatsapp"];
export const TRANSPORT_CHANNEL: Record<Exclude<TransportName, "ghl">, Channel> = { resend: "email", twilio: "sms", meta_whatsapp: "whatsapp" };
export const TRANSPORT_LABELS: Record<TransportName, string> = { ghl: "GoHighLevel", resend: "Resend", twilio: "Twilio", meta_whatsapp: "WhatsApp Business (Meta)" };

/** The channel's sender as configured for this workspace (messaging_channels). */
export interface TransportSender {
  /** What the customer sees: the from-address, the phone number. */
  identity: string | null;
  /** The provider's id for it: Resend domain id, Twilio Messaging Service SID or number, Meta phone_number_id. */
  senderId: string | null;
  /** Meta WhatsApp Business Account id, Twilio account SID. */
  accountId: string | null;
  /** integration_credentials id of the stored secret. Transports resolve it themselves through the credential vault. */
  credentialId: string | null;
}

export interface TransportSendRequest {
  orgId: string;
  channel: Channel;
  /** Our conversation_messages id. Passed to the provider as the correlation id (Resend tag, Twilio status callback, Meta callback data) and,
   *  where the provider supports it, as the idempotency key, so a status callback that arrives before the send returns is still matched. */
  messageId: string;
  /** The normalized destination: E.164 for SMS and WhatsApp, a lowercase address for email. */
  to: string;
  /** The provider's own contact id, for transports that address contacts rather than numbers (GoHighLevel). */
  contactRef: string | null;
  body: string;
  subject?: string | null;
  /** Email threading: the Message-ID this message answers, and the earlier ones in the thread. */
  inReplyTo?: string | null;
  references?: string[];
  /** Email: a one-click unsubscribe URL (RFC 8058) for marketing messages. */
  unsubscribeUrl?: string | null;
  /** WhatsApp: an approved template by name, with positional parameters. Required outside the customer-service window. */
  template?: { name: string; language: string; params: string[] } | null;
  sender: TransportSender;
}

export type TransportResult =
  | {
      ok: true;
      providerMessageId: string;
      providerConversationId?: string | null;
      /** Email Message-ID the provider assigned, for threading replies. */
      providerThreadRef?: string | null;
      /** Billable units the provider reported at send time (SMS segments), when it does. */
      quantity?: number | null;
    }
  | {
      ok: false;
      /** Safe to try again later (rate limited, provider unavailable before anything was accepted). */
      retryable: boolean;
      /** Short, user-safe description. Never a raw provider payload or a secret. */
      error: string;
      /** Not attempted at all: switched off, not connected, or not configured. */
      blocked?: boolean;
      reconnectRequired?: boolean;
      /** The provider refused because the person opted out (Twilio 21610) or the address is invalid or bouncing. */
      suppress?: "opt_out" | "bounce" | "invalid" | null;
      /** Meta refused a free-form WhatsApp message outside the 24-hour window. */
      windowClosed?: boolean;
    };

export interface ChannelTransport {
  name: TransportName;
  channels: readonly Channel[];
  /** GoHighLevel needs its own contact id; native transports send to the address. */
  requiresContactRef: boolean;
  send(req: TransportSendRequest): Promise<TransportResult>;
}

/** The result of an authenticated capability test. A channel is enabled only after one passes. */
export interface CapabilityTest {
  ok: boolean;
  checkedAt: string;
  /** What was verified, in plain words ("Domain example.com is verified in Resend"). */
  checks: Array<{ label: string; ok: boolean; detail: string }>;
  /** Normalized facts the channel row records. */
  senderIdentity?: string | null;
  senderId?: string | null;
  accountId?: string | null;
  registrationStatus?: "not_required" | "pending" | "approved" | "rejected";
}
