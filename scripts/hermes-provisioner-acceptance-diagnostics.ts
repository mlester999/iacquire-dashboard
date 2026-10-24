const safeNodeCodes = new Set([
  "EACCES",
  "EADDRINUSE",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOENT",
  "ENOSPC",
  "EPERM",
  "EROFS",
  "ETIMEDOUT",
  "ERR_DLOPEN_FAILED",
  "ERR_INVALID_ARG_TYPE",
  "ERR_INVALID_URL",
  "ERR_MODULE_NOT_FOUND",
  "ERR_PACKAGE_IMPORT_NOT_DEFINED",
  "ERR_PACKAGE_PATH_NOT_EXPORTED",
  "ERR_REQUIRE_ESM",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_UNKNOWN_FILE_EXTENSION",
  "ERR_UNSUPPORTED_DIR_IMPORT",
]);

const safeErrorNames = new Set([
  "AggregateError",
  "Error",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
]);

const safeSeedStages = new Set([
  "seed_validation",
  "tenant_one_onboarding",
  "tenant_two_onboarding",
  "reviewer_creation",
  "gateway_registration",
  "held_config_review",
  "provisioning_validation",
]);

const safeSeedErrors = new Set([
  "acceptance_already_seeded",
  "acceptance_body_too_large",
  "acceptance_employee_count_mismatch",
  "acceptance_gateway_url_invalid",
  "acceptance_onboarding_answers_rejected",
  "acceptance_onboarding_not_provisionable",
  "acceptance_seed_invalid",
  "AGGREGATE_ERROR_SEED_ERROR",
]);

const safeProvisioningFailureCodes = new Set([
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
  "stale_configuration", "identity_mismatch", "audit_log_unavailable", "worker_internal_error",
]);

const safeProvisioningUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const maxProvisioningAttempts = 3;

const safeProvisioningFailureStage = (code: string) => {
  if (code.startsWith("canary_") || code === "effective_soul_unverified") return "canary_verification";
  if (code.startsWith("profile_create") || code === "profile_conflict") return "profile_creation";
  if (code.startsWith("profile_authentication") || code.startsWith("profile_api_contract") || code === "profile_identity_failed") return "profile_route_verification";
  if (code.startsWith("runtime_tool") || code === "runtime_tool_inventory_incomplete") return "runtime_policy_verification";
  if (code === "lease_expired") return "lease_validation";
  return "provisioning";
};

const safeProvisioningErrorCategory = (code: string) => {
  if (code === "canary_failed") return "unclassified_hermes_run_failure";
  if (code.startsWith("canary_failed_")) return "hermes_run_failure";
  if (code === "effective_soul_unverified") return "soul_challenge_mismatch";
  if (code.startsWith("profile_create")) return "profile_creation_failure";
  if (code.startsWith("profile_authentication") || code.startsWith("profile_api_contract")) return "authenticated_profile_route_failure";
  if (code === "lease_expired") return "lease_expired";
  return code === "unclassified_provisioner_failure" ? code : "provisioner_failure";
};

const safeProvisioningExceptionDetail = (code: string) => {
  if (code === "canary_failed") return "Terminal Hermes run had no allowlisted error code.";
  if (code === "effective_soul_unverified") return "Canary output did not match the one-time challenge.";
  if (code === "canary_events_unavailable") return "Authenticated canary event stream was unavailable.";
  if (code.startsWith("canary_failed_")) return `Hermes canary run reported ${code.slice("canary_failed_".length)}.`;
  return `Allowlisted provisioner failure: ${code}.`;
};

export type SafeProvisioningJobDiagnostic = {
  correlationId: string;
  jobStatus: "failed" | "in_progress";
  stage: string;
  errorCategory: string;
  safeExceptionDetail: string;
  attempt: number;
  maxAttempts: number;
  retryState: "in_progress" | "retry_scheduled" | "retry_exhausted" | "retry_not_scheduled";
};

/** Return bounded acceptance-only job diagnostics; do not forward tenant/profile fields or raw DB details. */
export function safeProvisioningJobDiagnostics(jobs: unknown[]): SafeProvisioningJobDiagnostic[] {
  const diagnostics: SafeProvisioningJobDiagnostic[] = [];
  for (const value of jobs) {
    if (!value || typeof value !== "object") continue;
    const job = value as {
      id?: unknown; status?: unknown; detail?: unknown; attempt_count?: unknown; next_retry_at?: unknown;
    };
    if (typeof job.id !== "string" || !safeProvisioningUuid.test(job.id)) continue;
    if (job.status !== "failed" && job.status !== "in_progress") continue;

    const attempt = Number.isInteger(job.attempt_count)
      ? Math.min(maxProvisioningAttempts, Math.max(0, Number(job.attempt_count)))
      : 0;
    const code = job.status === "failed" ? safeProvisioningFailureCode(job.detail) : "unclassified_provisioner_failure";
    const retryState = job.status === "in_progress"
      ? "in_progress"
      : attempt >= maxProvisioningAttempts
        ? "retry_exhausted"
        : job.next_retry_at
          ? "retry_scheduled"
          : "retry_not_scheduled";

    diagnostics.push({
      correlationId: job.id,
      jobStatus: job.status,
      stage: job.status === "failed" ? safeProvisioningFailureStage(code) : "in_progress",
      errorCategory: job.status === "failed" ? safeProvisioningErrorCategory(code) : "none_recorded",
      safeExceptionDetail: job.status === "failed" ? safeProvisioningExceptionDetail(code) : "No failure recorded yet.",
      attempt,
      maxAttempts: maxProvisioningAttempts,
      retryState,
    });
  }
  return diagnostics.slice(0, 12);
}

const safeDatabaseCodes = new Map([
  ["22P02", "DATABASE_INVALID_VALUE"],
  ["23503", "DATABASE_FOREIGN_KEY_VIOLATION"],
  ["23505", "DATABASE_UNIQUE_VIOLATION"],
  ["23514", "DATABASE_CHECK_VIOLATION"],
  ["42P01", "DATABASE_TABLE_MISSING"],
  ["42703", "DATABASE_COLUMN_MISSING"],
  ["P0001", "DATABASE_RAISED_EXCEPTION"],
]);

export function safeAcceptanceSeedStage(stage: unknown): string {
  return typeof stage === "string" && safeSeedStages.has(stage) ? stage : "unknown_seed_stage";
}

/** Keep only known fixture errors and database codes; never return arbitrary exception text. */
export function safeAcceptanceSeedErrorCode(reason: unknown): string {
  try {
    if (typeof reason === "string" && safeSeedErrors.has(reason)) return reason;
    if (!reason || typeof reason !== "object") return "unclassified_seed_error";

    const candidate = reason as { message?: unknown; code?: unknown; name?: unknown };
    if (typeof candidate.message === "string" && safeSeedErrors.has(candidate.message)) {
      return candidate.message;
    }
    if (typeof candidate.code === "string") {
      const databaseCode = safeDatabaseCodes.get(candidate.code);
      if (databaseCode) return databaseCode;
      if (safeNodeCodes.has(candidate.code)) return `NODE_${candidate.code}`;
    }
    if (candidate.name === "Error") return "unclassified_seed_error";
    if (typeof candidate.name === "string" && safeErrorNames.has(candidate.name)) {
      return `${candidate.name.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()}_SEED_ERROR`;
    }
  } catch {
    return "unclassified_seed_error";
  }
  return "unclassified_seed_error";
}

/** Extract only the worker's persisted allowlisted failure code from its fixed detail template. */
export function safeProvisioningFailureCode(detail: unknown): string {
  if (typeof detail !== "string") return "unclassified_provisioner_failure";
  const match = /^Restricted Hermes profile setup failed \(([a-z_]{1,64})\)\. Review the isolated host result before retrying\.$/.exec(detail);
  return match && safeProvisioningFailureCodes.has(match[1]) ? match[1] : "unclassified_provisioner_failure";
}

/** Keep only bounded failure labels; never return the persisted detail text. */
export function safeProvisioningFailureCodeList(details: unknown[]): string[] {
  return [...new Set(details.map(safeProvisioningFailureCode))].sort().slice(0, 12);
}

/** Return a bounded diagnostic label. Never include exception messages, paths, or secret values. */
export function safeStartupFailureCode(reason: unknown): string {
  let name = "";
  let message = "";
  let code = "";

  try {
    if (reason instanceof Error) {
      name = reason.name;
      message = reason.message;
      const errorCode = (reason as Error & { code?: unknown }).code;
      if (typeof errorCode === "string") code = errorCode;
    } else if (typeof reason === "string") {
      message = reason;
    } else if (typeof reason === "object" && reason !== null) {
      const candidate = reason as { name?: unknown; message?: unknown; code?: unknown };
      if (typeof candidate.name === "string") name = candidate.name;
      if (typeof candidate.message === "string") message = candidate.message;
      if (typeof candidate.code === "string") code = candidate.code;
    }
  } catch {
    return "UNCLASSIFIED_STARTUP_ERROR";
  }

  if (safeNodeCodes.has(code)) return `NODE_${code}`;
  if (/cannot find (?:package|module)/i.test(message)) return "NODE_MODULE_NOT_FOUND";
  if (/read-only file system|EROFS/i.test(message)) return "FILESYSTEM_READ_ONLY";
  if (/EACCES|EPERM|permission denied/i.test(message)) return "FILESYSTEM_PERMISSION";
  if (/ENOENT|no such file or directory/i.test(message)) return "FILE_MISSING";
  if (/EADDRINUSE|address already in use/i.test(message)) return "PORT_IN_USE";
  if (/certificate|\bPEM\b|\bx509\b|\bTLS\b/i.test(message)) return "TLS_CONFIGURATION_ERROR";
  if (/pglite|postgres|database/i.test(message)) return "DATABASE_INITIALIZATION_ERROR";
  if (/cannot read properties|not a function|undefined/i.test(message)) return "APPLICATION_TYPE_ERROR";
  if (safeErrorNames.has(name)) return name.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase();
  return "UNCLASSIFIED_STARTUP_ERROR";
}
