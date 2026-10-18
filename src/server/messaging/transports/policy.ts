import "server-only";
import { env } from "@/server/env";
import { TRANSPORT_NAMES, type NativeTransportName, type TransportName } from "@/server/messaging/transports/types";

/** Narrow untrusted provider values before using them as a transport name. */
export const isTransportName = (value: unknown): value is TransportName =>
  typeof value === "string" && (TRANSPORT_NAMES as readonly string[]).includes(value);

export const isNativeTransport = (value: unknown): value is NativeTransportName =>
  isTransportName(value) && value !== "ghl";

/** The environment kill switch for a provider. Off unless explicitly switched on. */
export function transportWritesEnabled(name: TransportName): boolean {
  const e = env();
  switch (name) {
    case "ghl":
      return e.GHL_WRITES_ENABLED;
    case "resend":
      return e.RESEND_WRITES_ENABLED;
    case "twilio":
      return e.TWILIO_WRITES_ENABLED;
    case "meta_whatsapp":
      return e.META_WHATSAPP_WRITES_ENABLED;
  }
}
