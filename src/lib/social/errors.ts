// Reading a provider's refusal, and deciding what to do about it. Pure.
//
// The Graph API error codes below are the ones its error reference documents for the situations that matter here: an invalid or expired token (190 and its
// subcodes), missing permissions (10, 200-299), rate limiting (4, 17, 32, 613, 80000-80014) and invalid parameters (100). They are read from a response the
// provider sent, never assumed; a response this file does not recognise is treated as a plain failure, never as success. Re-read the current reference
// before connecting a real account.

export type FailureKind = "rate_limited" | "auth" | "permission" | "invalid_content" | "transient" | "unknown_outcome" | "blocked";

export interface ProviderErrorBody {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  is_transient?: boolean;
  fbtrace_id?: string;
}

export interface Classified {
  kind: FailureKind;
  /** The person's account connection no longer works: only reconnecting helps. */
  needsReauth: boolean;
  /** Seconds the provider asked us to wait, when it said. */
  retryAfterSec: number | null;
  /** A short, honest sentence for the person (never the provider's raw response). */
  message: string;
}

const AUTH_SUBCODES = new Set([458, 459, 460, 463, 464, 467]);
const rateCode = (c: number) => c === 4 || c === 17 || c === 32 || c === 613 || (c >= 80000 && c <= 80014);
const permissionCode = (c: number) => c === 10 || c === 3 || (c >= 200 && c <= 299);

/**
 * `sent` says whether the request that failed could already have created something at the provider: a publish request whose answer never arrived, or an
 * answer that was a server error. Then the outcome is unknown, and the post must be checked before it is ever sent again.
 */
export function classifyProviderFailure(input: { httpStatus: number | null; error: ProviderErrorBody | null; sent: boolean; retryAfterHeader?: string | null }): Classified {
  const { httpStatus, error } = input;
  const retry = input.retryAfterHeader ? Number(input.retryAfterHeader) : NaN;
  const retryAfterSec = Number.isFinite(retry) && retry > 0 ? Math.min(retry, 86_400) : null;
  const code = typeof error?.code === "number" ? error.code : null;
  const sub = typeof error?.error_subcode === "number" ? error.error_subcode : null;

  if (code === 190 || (sub !== null && AUTH_SUBCODES.has(sub))) {
    return { kind: "auth", needsReauth: true, retryAfterSec: null, message: "The platform no longer accepts this account's sign-in (it was removed, expired or the password changed). Reconnect the account." };
  }
  if (code !== null && permissionCode(code)) {
    return { kind: "permission", needsReauth: true, retryAfterSec: null, message: "The platform says this account has not given permission for that. Reconnect it and allow the requested access." };
  }
  if (code !== null && rateCode(code)) {
    return { kind: "rate_limited", needsReauth: false, retryAfterSec: retryAfterSec ?? 900, message: "The platform is limiting how often this account can post. It will try again later." };
  }
  if (httpStatus === 429) return { kind: "rate_limited", needsReauth: false, retryAfterSec: retryAfterSec ?? 900, message: "The platform is limiting how often this account can post. It will try again later." };
  if (code === 368) return { kind: "blocked", needsReauth: false, retryAfterSec: null, message: "The platform has temporarily blocked this account from posting. Nothing will be retried until it is lifted." };
  if (code === 100 || (httpStatus !== null && httpStatus >= 400 && httpStatus < 500 && error)) {
    const why = error?.message ? ` The platform said: ${error.message.slice(0, 200)}` : "";
    return { kind: "invalid_content", needsReauth: false, retryAfterSec: null, message: `The platform refused this post.${why}` };
  }
  // A server error or no answer at all. If the request could have created something, the outcome is unknown.
  if (input.sent) return { kind: "unknown_outcome", needsReauth: false, retryAfterSec, message: "The platform did not confirm whether this post went out. It is being checked and will not be sent again until that is known." };
  return { kind: "transient", needsReauth: false, retryAfterSec, message: "The platform had a temporary problem. It will try again." };
}

/** Whether an attempt that ended this way may simply be tried again later. */
export const isRetryable = (k: FailureKind) => k === "transient" || k === "rate_limited";

/**
 * How long to wait before attempt number `attempt` (1-based, the attempt that just failed). Doubling from one minute, capped at an hour; a provider's own
 * "try again in N seconds" wins when it is longer. `jitter` is a number in [0, 1) so the delay can be spread without this function reading a clock or a
 * random source.
 */
export function retryDelayMs(attempt: number, retryAfterSec: number | null, jitter = 0): number {
  const base = Math.min(60_000 * 2 ** Math.max(0, attempt - 1), 3_600_000);
  const spread = Math.round(base * 0.2 * Math.min(Math.max(jitter, 0), 0.999));
  return Math.max(base + spread, (retryAfterSec ?? 0) * 1000);
}

export const FAILURE_LABELS: Record<FailureKind, string> = {
  rate_limited: "The platform is limiting posts",
  auth: "The account needs to be reconnected",
  permission: "A permission is missing",
  invalid_content: "The platform refused the content",
  transient: "A temporary platform problem",
  unknown_outcome: "The result is being checked",
  blocked: "The account is blocked from posting",
};
