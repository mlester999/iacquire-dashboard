import "server-only";
import type { Queryable } from "@/server/db";
import type { Channel } from "@/lib/messaging";
import { ghlTransport } from "@/server/messaging/transports/ghl";
import { isNativeTransport, isTransportName, transportWritesEnabled } from "@/server/messaging/transports/policy";
import { TRANSPORT_CHANNEL, TRANSPORT_LABELS, TRANSPORT_NAMES, type CapabilityTest, type ChannelTransport, type NativeTransportName, type TransportName, type TransportSender } from "@/server/messaging/transports/types";

// The transport registry: which ChannelTransport carries a workspace's channel. messaging_channels.provider names it (default 'ghl', so a
// workspace that never chose a native provider keeps GoHighLevel). Native transports are loaded on first use: a GoHighLevel workspace
// never loads them, and if one cannot be loaded the send is refused as "not attempted" (nothing leaves, the reservation is released).

/** Which providers may carry each channel. Mirrors the messaging_channels_provider_channel constraint. */
export const PROVIDERS_FOR_CHANNEL: Record<Channel, readonly TransportName[]> = { email: ["ghl", "resend"], sms: ["ghl", "twilio"], whatsapp: ["ghl", "meta_whatsapp"] };
/** The native provider for each channel. */
export const NATIVE_PROVIDER_FOR: Record<Channel, NativeTransportName> = { email: "resend", sms: "twilio", whatsapp: "meta_whatsapp" };

/**
 * What channel setup hands a provider's capability test (testResendCapability, testTwilioCapability, testMetaWhatsappCapability).
 * The secret is resolved from the credential vault for this one call; a test must never log it, return it or put it in a check detail.
 * The sender is given both as the transport's sender object and flattened, so each provider's test can take the fields it needs.
 */
export interface CapabilityTestInput {
  orgId: string;
  channel: Channel;
  secret: string;
  sender: TransportSender;
  /** What the customer sees: the from-address ("Name <hello@example.com>") or the phone number. */
  senderIdentity: string;
  /** Resend domain id, Twilio Messaging Service SID or number, Meta phone_number_id. */
  senderId: string;
  /** Meta WhatsApp Business Account id, Twilio account SID. */
  accountId: string | null;
  inboundAddress: string | null;
}

export type CapabilityTester = (input: CapabilityTestInput) => Promise<CapabilityTest>;

interface NativeModule {
  transport: ChannelTransport;
  testCapability: CapabilityTester;
}

// Each provider's test takes the subset of CapabilityTestInput it needs; passing the whole input keeps one calling convention here.
const LOADERS: Record<NativeTransportName, () => Promise<NativeModule>> = {
  resend: async () => {
    const m = await import("@/server/messaging/transports/resend");
    return { transport: m.resendTransport, testCapability: (input) => m.testResendCapability(input) };
  },
  twilio: async () => {
    const m = await import("@/server/messaging/transports/twilio");
    return { transport: m.twilioTransport, testCapability: (input) => m.testTwilioCapability(input) };
  },
  meta_whatsapp: async () => {
    const m = await import("@/server/messaging/transports/meta-whatsapp");
    return { transport: m.metaWhatsappTransport, testCapability: (input) => m.testMetaWhatsappCapability(input) };
  },
};

const loaded = new Map<NativeTransportName, Promise<NativeModule>>();

/** Loads a native provider's module once. A failed load is not cached, so a later call tries again. */
export function loadNativeModule(name: NativeTransportName): Promise<NativeModule> {
  let p = loaded.get(name);
  if (!p) {
    p = LOADERS[name]().catch((err: unknown) => {
      loaded.delete(name);
      throw err;
    });
    loaded.set(name, p);
  }
  return p;
}

function lazyNativeTransport(name: NativeTransportName): ChannelTransport {
  return {
    name,
    channels: [TRANSPORT_CHANNEL[name]],
    // Native transports address the number or email address itself, never a CRM contact id.
    requiresContactRef: false,
    async send(req) {
      let real: ChannelTransport;
      try {
        real = (await loadNativeModule(name)).transport;
      } catch {
        console.error("[iacquire] messaging transport could not be loaded", { provider: name });
        return { ok: false, retryable: false, blocked: true, error: `Sending through ${TRANSPORT_LABELS[name]} is not available in this deployment.` };
      }
      if (real.name !== name || !real.channels.includes(req.channel)) {
        return { ok: false, retryable: false, blocked: true, error: `${TRANSPORT_LABELS[name]} cannot send ${req.channel} messages.` };
      }
      return real.send(req);
    },
  };
}

const NATIVE: Record<NativeTransportName, ChannelTransport> = {
  resend: lazyNativeTransport("resend"),
  twilio: lazyNativeTransport("twilio"),
  meta_whatsapp: lazyNativeTransport("meta_whatsapp"),
};

/** The transport for a provider name. Unknown names are a programming error (the database only allows the four). */
export function transportFor(name: TransportName): ChannelTransport {
  if (name === "ghl") return ghlTransport;
  const t = NATIVE[name];
  if (!t) throw new Error(`Unknown messaging transport: ${String(name)}`);
  return t;
}

/** A provider's capability test, for channel setup. */
export async function capabilityTesterFor(name: NativeTransportName): Promise<CapabilityTester> {
  return (await loadNativeModule(name)).testCapability;
}

export interface ChannelRoute {
  channel: Channel;
  provider: TransportName;
  transport: ChannelTransport;
  enabled: boolean;
  sender: TransportSender;
  inboundAddress: string | null;
}

/**
 * The transport and sender configured for a workspace's channel. A channel with no row has never been set up: it is GoHighLevel's
 * (the column default) and switched off.
 */
export async function loadChannelTransport(db: Queryable, orgId: string, channel: Channel): Promise<ChannelRoute> {
  const { rows } = await db.query<{ provider: string; enabled: boolean; sender_identity: string | null; provider_sender_id: string | null; provider_account_id: string | null; credential_id: string | null; inbound_address: string | null }>(
    "select provider, enabled, sender_identity, provider_sender_id, provider_account_id, credential_id, inbound_address from messaging_channels where org_id = $1 and channel = $2",
    [orgId, channel],
  );
  const r = rows[0];
  const provider: TransportName = r && isTransportName(r.provider) ? r.provider : "ghl";
  return {
    channel,
    provider,
    transport: transportFor(provider),
    enabled: r?.enabled ?? false,
    sender: { identity: r?.sender_identity ?? null, senderId: r?.provider_sender_id ?? null, accountId: r?.provider_account_id ?? null, credentialId: r?.credential_id ?? null },
    inboundAddress: r?.inbound_address ?? null,
  };
}

export { TRANSPORT_LABELS, TRANSPORT_NAMES, TRANSPORT_CHANNEL };
export { isNativeTransport, isTransportName, transportWritesEnabled };
export type { CapabilityTest, ChannelTransport, NativeTransportName, TransportName, TransportSender };
