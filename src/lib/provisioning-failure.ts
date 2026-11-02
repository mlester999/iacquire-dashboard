// What a restricted-provisioner failure means for the retry budget. Pure and import-safe from the server module and from tests; nothing here touches a database.
//
// The host worker reports a short code for every failed attempt. Three kinds of failure need different handling:
//   transient - the model provider, the client gateway or the network was unavailable; nothing is wrong with the tenant, so the attempt is given back and the job waits
//   stale     - the tenant's approved configuration changed while the job ran; the next claim carries the new version, so the attempt is given back and the retry is quick
//   permanent - a defect that retrying will not fix; it spends the three-attempt budget and ends in front of a person
// A transient or stale failure that keeps coming back for a day stops being given back, so no job loops forever.

export const PROVISIONING_FAILURE_CODES = [
  "invalid_manifest", "lease_expired", "soul_digest_mismatch", "policy_digest_mismatch",
  "unsafe_model_config", "invalid_policy_config", "invalid_profile_config", "unsafe_profile_path",
  "profile_file_missing", "unsafe_hermes_home", "agency_profile_found", "profile_state_invalid",
  "profile_ownership_missing", "profile_ownership_conflict", "profile_key_missing", "profile_key_invalid",
  "profile_create_failed", "profile_conflict", "profile_authentication_failed", "profile_api_contract_failed",
  "profile_identity_failed", "canary_tool_isolation_failed", "canary_submission_failed",
  "canary_events_unavailable", "canary_event_invalid", "canary_tool_invoked", "canary_failed",
  "canary_failed_model_authentication_failed", "canary_failed_model_configuration_missing",
  "canary_failed_model_credentials_missing", "canary_failed_model_endpoint_unreachable",
  "canary_failed_model_provider_error", "canary_failed_model_provider_unsupported",
  "canary_failed_model_unavailable", "canary_failed_provider_resolution_failed",
  "canary_incomplete", "effective_soul_unverified", "runtime_tool_policy_unverified",
  "runtime_tool_inventory_incomplete", "invalid_profile", "invalid_profile_route",
  "unsafe_hermes_api_origin", "http_response_too_large", "http_unavailable",
  "stale_configuration", "identity_mismatch",
  "audit_log_unavailable", "worker_internal_error",
  // The Hermes profile watcher rescans every 30 seconds, so a new profile can take longer than the worker waits to appear.
  "profile_gateway_discovery_timeout",
  // The worker's own ceiling on profiles; the portal's claim gate normally keeps a job from ever reaching it.
  "capacity_exceeded",
  // Raised by the portal itself when a returned key already belongs to another live profile.
  "profile_key_reused",
  // Containment of a profile: the gateway did not apply the replaced key and the tools-off policy within the wait (it may only need longer), or it showed a tool still enabled.
  "revoke_not_applied", "revoke_tool_isolation_failed",
  // A worker that has no pinned business tool URL was handed a manifest that carries the client business tier: its own configuration is wrong, and a person must fix it.
  "business_tools_not_enabled",
] as const;

/** Stored for any code the portal does not know. The raw string is never echoed: a misbehaving worker could put anything in it. */
export const UNCLASSIFIED_FAILURE_CODE = "unclassified_worker_failure";

const KNOWN_CODES: ReadonlySet<string> = new Set(PROVISIONING_FAILURE_CODES);

// canary_submission_http_<status>[_<gateway code>]: the status is a three-digit HTTP status or the word "unavailable"; the gateway code is lowercase words joined by underscores.
const CANARY_SUBMISSION_CODE = /^canary_submission_http_(?:[1-5][0-9]{2}|unavailable)(?:_[a-z][a-z0-9]*(?:_[a-z0-9]+)*)?$/;
const MAX_CODE_LENGTH = 100;

/** Known codes stay as they are, `canary_submission_http_*` is kept when well formed, and everything else becomes the single unclassified code. */
export function normalizeProvisioningFailureCode(code: string): string {
  if (typeof code !== "string" || code.length === 0 || code.length > MAX_CODE_LENGTH) return UNCLASSIFIED_FAILURE_CODE;
  if (KNOWN_CODES.has(code)) return code;
  if (CANARY_SUBMISSION_CODE.test(code)) return code;
  return UNCLASSIFIED_FAILURE_CODE;
}

export type ProvisioningFailureClass = "transient" | "stale" | "permanent";

/** Seconds a transient failure waits before the next attempt, and the same for a stale one. */
export const TRANSIENT_RETRY_SECONDS = 300;
export const STALE_RETRY_SECONDS = 30;
/** Past this age a transient or stale failure counts against the budget like any other. */
export const RETRY_GIVE_BACK_MAX_AGE_SECONDS = 24 * 60 * 60;
/** Attempts a job may use (the table's own check allows 0 to 3). */
export const MAX_PROVISIONING_ATTEMPTS = 3;

const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  "http_unavailable",
  "profile_gateway_discovery_timeout",
  "canary_events_unavailable",
  "canary_failed_model_endpoint_unreachable",
  "canary_failed_model_provider_error",
  "canary_failed_model_unavailable",
  "capacity_exceeded",
  // The gateway re-reads a profile on its own schedule, so a containment that was not seen to apply in time is tried again later, like a slow discovery.
  "revoke_not_applied",
]);

/** The class of a failure code, ignoring job age (see `provisioningRetryPlan` for the bound). Unknown codes are permanent: a person should look. */
export function classifyProvisioningFailure(code: string): ProvisioningFailureClass {
  const safe = normalizeProvisioningFailureCode(code);
  if (safe === "stale_configuration") return "stale";
  if (TRANSIENT_CODES.has(safe)) return "transient";
  const submission = /^canary_submission_http_(\d{3}|unavailable)(?:_(.+))?$/.exec(safe);
  if (submission) {
    if (submission[1] === "unavailable") return "transient";
    const status = Number(submission[1]);
    // A gateway answering 409 profile_mismatch is the worker's own discovery wait running out: the same slow rescan as the discovery timeout.
    if (status === 409 && submission[2] === "profile_mismatch") return "transient";
    if (status === 408 || status === 425 || status === 429 || status >= 500) return "transient";
  }
  return "permanent";
}

export interface ProvisioningRetryPlan {
  failureClass: ProvisioningFailureClass;
  /** True when the attempt this failure used is returned to the job. */
  giveBackAttempt: boolean;
  /** Seconds until the next attempt, or null when the job is finished and needs a person. */
  retryAfterSeconds: number | null;
  /** True when a transient or stale failure was too old to be given back. */
  ageBoundReached: boolean;
}

/**
 * What to do with a failed attempt. `attemptCount` is the job's count including the attempt that just failed; `jobAgeSeconds` is how long ago the job was created (read from
 * the database clock, which is the clock the retry time is written with).
 */
export function provisioningRetryPlan(input: { code: string; attemptCount: number; jobAgeSeconds: number }): ProvisioningRetryPlan {
  const classified = classifyProvisioningFailure(input.code);
  const young = Number.isFinite(input.jobAgeSeconds) && input.jobAgeSeconds <= RETRY_GIVE_BACK_MAX_AGE_SECONDS;
  if (classified === "transient" && young) return { failureClass: classified, giveBackAttempt: true, retryAfterSeconds: TRANSIENT_RETRY_SECONDS, ageBoundReached: false };
  if (classified === "stale" && young) return { failureClass: classified, giveBackAttempt: true, retryAfterSeconds: STALE_RETRY_SECONDS, ageBoundReached: false };
  // Everything else spends the budget: 30, 60 and 120 seconds apart, then a person decides.
  const attempt = Math.max(Math.floor(input.attemptCount), 0);
  const retryAfterSeconds = attempt < MAX_PROVISIONING_ATTEMPTS ? 30 * 2 ** Math.max(attempt - 1, 0) : null;
  return { failureClass: classified, giveBackAttempt: false, retryAfterSeconds, ageBoundReached: classified !== "permanent" };
}
