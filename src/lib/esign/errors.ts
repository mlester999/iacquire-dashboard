// Reading a signing service's refusal, and deciding what to do about it. Pure.
//
// What an HTTP status means is a general convention, not a claim about one service: 401 and 403 are a key the service no longer accepts, 429 is "slow down", 5xx and silence are
// "we do not know what happened". A response this file does not recognise is treated as a plain failure, never as success. The service's own error texts are never repeated to a
// person: they can carry anything.
import type { FailureKind } from "@/lib/social/errors";

export type { FailureKind } from "@/lib/social/errors";
export { isRetryable, retryDelayMs } from "@/lib/social/errors";

export interface Classified {
  kind: FailureKind;
  /** The connection's key no longer works: only connecting again helps. */
  needsAttention: boolean;
  retryAfterSec: number | null;
  /** A short, honest sentence for the person. */
  message: string;
}

/**
 * `sent` says whether the request that failed could already have made something at the service: an upload or a send whose answer never arrived, or came back as a server
 * error. Then the outcome is unknown, and the request must be checked before it is ever sent again.
 */
export function classifyEsignFailure(input: { httpStatus: number | null; sent: boolean; retryAfterHeader?: string | null; providerLabel?: string }): Classified {
  // Every message here starts with the service's name, and the stand-in's label ("the simulated signing service") is written for the middle of a sentence.
  const label = input.providerLabel ?? "The signing service";
  const name = label.charAt(0).toUpperCase() + label.slice(1);
  const retry = input.retryAfterHeader ? Number(input.retryAfterHeader) : NaN;
  const retryAfterSec = Number.isFinite(retry) && retry > 0 ? Math.min(retry, 86_400) : null;
  const s = input.httpStatus;
  if (s === 401) return { kind: "auth", needsAttention: true, retryAfterSec: null, message: `${name} no longer accepts the saved key. Connect it again.` };
  if (s === 403) return { kind: "permission", needsAttention: true, retryAfterSec: null, message: `${name} says this key is not allowed to do that. Check the key's access, then connect it again.` };
  if (s === 429) return { kind: "rate_limited", needsAttention: false, retryAfterSec: retryAfterSec ?? 900, message: `${name} is limiting how often requests can be made. It will try again later.` };
  if (s !== null && s >= 400 && s < 500) return { kind: "invalid_content", needsAttention: false, retryAfterSec: null, message: `${name} refused this request (HTTP ${s}).` };
  if (input.sent) return { kind: "unknown_outcome", needsAttention: false, retryAfterSec, message: `${name} did not confirm whether this was sent. It is being checked and will not be sent again until that is known.` };
  return { kind: "transient", needsAttention: false, retryAfterSec, message: `${name} had a temporary problem. It will try again.` };
}
