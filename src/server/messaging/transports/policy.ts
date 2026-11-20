import "server-only";
import { env } from "@/server/env";
import { OUTBOUND_DISABLED_DETAIL } from "@/server/messaging/outbound-policy";
import { TRANSPORT_NAMES, type NativeTransportName, type TransportName } from "@/server/messaging/transports/types";

/** Narrow untrusted provider values before using them as a transport name. */
export const isTransportName = (value: unknown): value is TransportName =>
  typeof value === "string" && (TRANSPORT_NAMES as readonly string[]).includes(value);

export const isNativeTransport = (value: unknown): value is NativeTransportName =>
  isTransportName(value) && value !== "ghl";

/** Customer messages require the master switch as well as any channel-specific permission. */
export function outboundMessagingEnabled(): boolean {
  return env().OUTBOUND_MESSAGING_ENABLED;
}

/** The exact reason a provider cannot send here. The global customer-message stop takes precedence over the per-provider stop. */
export function transportWritesDisabledReason(name: TransportName): string | null {
  const e = env();
  if (!e.OUTBOUND_MESSAGING_ENABLED) return OUTBOUND_DISABLED_DETAIL;
  let enabled: boolean;
  switch (name) {
    case "ghl":
      enabled = e.GHL_WRITES_ENABLED;
      break;
    case "resend":
      enabled = e.RESEND_WRITES_ENABLED;
      break;
    case "twilio":
      enabled = e.TWILIO_WRITES_ENABLED;
      break;
    case "meta_whatsapp":
      enabled = e.META_WHATSAPP_WRITES_ENABLED;
      break;
  }
  if (enabled) return null;
  const labels: Record<TransportName, string> = { ghl: "GoHighLevel", resend: "Resend", twilio: "Twilio", meta_whatsapp: "WhatsApp (Meta)" };
  return `Sending through ${labels[name]} is switched off for this environment.`;
}

/** The environment kill switch for a provider, including the global customer-message stop. */
export function transportWritesEnabled(name: TransportName): boolean {
  return transportWritesDisabledReason(name) === null;
}
