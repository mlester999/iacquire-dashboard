import "server-only";
import { PinnedRequestError } from "@/server/security/pinned-https";
import { OutboundPolicyError, type HttpMethod } from "@/lib/automation-studio/outbound";

// What an answer (or the lack of one) means for a run. The policy that decides what may be sent at all is src/lib/automation-studio/outbound.ts;
// the connection-time protections are in src/server/security/pinned-https.ts.
export * from "@/lib/automation-studio/outbound";

// ---------------------------------------------------------------------------
// Judging an answer
// ---------------------------------------------------------------------------

export type CallStatus = "sent" | "blocked" | "rejected" | "not_sent" | "unknown";

export interface CallJudgement {
  status: CallStatus;
  retryable: boolean;
  /** In words, for the person: no secret, no body. */
  detail: string;
  /** Seconds the other side asked us to wait before trying again, when it said. */
  retryAfterSeconds?: number | null;
}

/**
 * What an answer means for the run. A 2xx is done. An explicit "not now" (408, 425, 429, 503) was not acted on, so it is tried again later. A redirect is
 * never followed, and any other 4xx is a mistake in the step or the connection, which repeating cannot fix. Any other 5xx may have been acted on before
 * it failed: it is only repeated when the step says the other side ignores a repeated request.
 */
export function judgeResponse(method: HttpMethod, status: number, opts: { retryAfterSeconds?: number | null; safeToRepeat?: boolean } = {}): CallJudgement {
  const retryAfterSeconds = opts.retryAfterSeconds ?? null;
  if (status >= 200 && status < 300) return { status: "sent", retryable: false, detail: `The other system answered ${status}.` };
  if (status >= 300 && status < 400) return { status: "rejected", retryable: false, detail: `The other system answered ${status} (a redirect). Redirects aren't followed: use the final address.` };
  if ([408, 425, 429, 503].includes(status)) return { status: "rejected", retryable: true, retryAfterSeconds, detail: `The other system answered ${status} (try again later), so nothing was done there.` };
  if (status >= 500) {
    const repeat = method === "GET" || opts.safeToRepeat === true;
    return repeat
      ? { status: "rejected", retryable: true, retryAfterSeconds, detail: `The other system answered ${status} (a problem on its side).` }
      : { status: "unknown", retryable: false, detail: `The other system answered ${status} (a problem on its side). It may have acted on the request before failing, so it isn't sent again by itself.` };
  }
  return { status: "rejected", retryable: false, detail: `The other system answered ${status}${status === 401 || status === 403 ? " (it refused the credentials: check or rotate the connection's secret)" : status === 404 ? " (not found: check the path)" : ""}.` };
}

const CERT_CODES = /^(CERT_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED|ERR_TLS_|HOSTNAME_MISMATCH|ERR_SSL_)/;

/** What a failure to get an answer means for the run. */
export function judgeFailure(method: HttpMethod, err: unknown, opts: { safeToRepeat?: boolean } = {}): CallJudgement {
  if (err instanceof OutboundPolicyError) return { status: "blocked", retryable: false, detail: err.message };
  if (!(err instanceof PinnedRequestError)) return { status: "unknown", retryable: false, detail: "The request ended without a clear answer, so it isn't sent again by itself." };
  if (err.code === "ERR_IACQUIRE_UNSAFE_ADDRESS" || err.code === "ERR_IACQUIRE_BAD_URL") return { status: "blocked", retryable: false, detail: "That address points to a private or local network (or isn't a valid public https address), so it wasn't called." };
  if (err.phase === "before_send") {
    if (CERT_CODES.test(err.code)) return { status: "not_sent", retryable: false, detail: "The other system's security certificate couldn't be verified, so nothing was sent." };
    if (err.code === "ENOTFOUND") return { status: "not_sent", retryable: true, detail: "The host name couldn't be found, so nothing was sent." };
    return { status: "not_sent", retryable: true, detail: "The connection couldn't be made, so nothing was sent." };
  }
  const repeat = method === "GET" || opts.safeToRepeat === true;
  return repeat
    ? { status: "not_sent", retryable: true, detail: "The request got no answer (it timed out or the connection dropped)." }
    : { status: "unknown", retryable: false, detail: "The request got no answer (it timed out or the connection dropped). It may have reached the other system, so it isn't sent again by itself." };
}
