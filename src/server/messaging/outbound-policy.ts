import "server-only";
import { env } from "@/server/env";

export const OUTBOUND_DISABLED_REASON = "outbound_disabled";
export const OUTBOUND_DISABLED_DETAIL = "Outbound customer messaging is disabled for this environment. Nothing was sent.";

/** Environment-wide stop for customer-facing channel messages. Unset configurations fail closed through env(). */
export function outboundMessagingDisabled(): { reason: string; detail: string; permanent: true } | null {
  return env().OUTBOUND_MESSAGING_ENABLED ? null : {
    reason: OUTBOUND_DISABLED_REASON,
    detail: OUTBOUND_DISABLED_DETAIL,
    permanent: true,
  };
}
