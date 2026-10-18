import "server-only";
import { AppError } from "@/server/errors";

/**
 * AQi uses a deliberately small public error vocabulary. Technical provider, credential and
 * infrastructure details stay in the diagnostic object and are only serialized for a Super Admin.
 */
export type AqiErrorCode =
  | "temporarily_unavailable"
  | "response_failed"
  | "connection_interrupted"
  | "rate_limited"
  | "budget_exhausted"
  | "session_expired"
  | "permission_denied"
  | "knowledge_unavailable"
  | "unexpected";

export interface AqiDiagnostic {
  requestId: string;
  category: AqiErrorCode;
  internalCode: string;
  provider: string | null;
  model: string | null;
  reason: string | null;
  retryable: boolean;
}

export interface AqiPublicError {
  code: AqiErrorCode;
  message: string;
  retryable: boolean;
  diagnostic?: AqiDiagnostic;
}

const MESSAGES: Record<AqiErrorCode, { message: string; retryable: boolean }> = {
  temporarily_unavailable: {
    message: "I'm temporarily unavailable. I'm having trouble responding right now. Please try again in a moment. If the issue continues, our support team can help.",
    retryable: true,
  },
  response_failed: {
    message: "I couldn't finish that response. Please try again.",
    retryable: true,
  },
  connection_interrupted: {
    message: "The connection was interrupted. Please try sending your message again.",
    retryable: true,
  },
  rate_limited: {
    message: "I'm receiving a lot of requests right now. Please try again shortly.",
    retryable: true,
  },
  budget_exhausted: {
    message: "AQi has reached its usage limit for now. Please try again later or ask your workspace administrator to review the limit.",
    retryable: false,
  },
  session_expired: {
    message: "Your session has expired. Please sign in again to continue.",
    retryable: false,
  },
  permission_denied: {
    message: "You don't have access to that AQi feature. Ask your workspace administrator if you need help.",
    retryable: false,
  },
  knowledge_unavailable: {
    message: "I couldn't read the approved knowledge for that answer. Please try again in a moment.",
    retryable: true,
  },
  unexpected: {
    message: "I'm temporarily unavailable. I'm having trouble responding right now. Please try again in a moment. If the issue continues, our support team can help.",
    retryable: true,
  },
};

export interface AqiErrorContext {
  requestId: string;
  superAdmin: boolean;
  provider?: string | null;
  model?: string | null;
  reason?: string | null;
}

function diagnosticFor(code: AqiErrorCode, internalCode: string, context: AqiErrorContext): AqiDiagnostic {
  return {
    requestId: context.requestId,
    category: code,
    internalCode,
    provider: context.provider ?? null,
    model: context.model ?? null,
    reason: context.reason ?? null,
    retryable: MESSAGES[code].retryable,
  };
}

export function aqiError(
  code: AqiErrorCode,
  context: AqiErrorContext,
  internalCode: string = code,
): AqiPublicError {
  const base = MESSAGES[code];
  return {
    code,
    message: base.message,
    retryable: base.retryable,
    ...(context.superAdmin ? { diagnostic: diagnosticFor(code, internalCode, context) } : {}),
  };
}

export function classifyAqiError(error: unknown, context: AqiErrorContext): AqiPublicError {
  const internalCode = error instanceof AppError ? error.code : error instanceof Error ? error.name : "unknown";
  let code: AqiErrorCode = "unexpected";
  switch (internalCode) {
    case "rate_limited":
    case "usage_limit":
      code = "rate_limited";
      break;
    case "budget_exhausted":
      code = "budget_exhausted";
      break;
    case "unauthenticated":
      code = "session_expired";
      break;
    case "forbidden":
      code = "permission_denied";
      break;
    case "integration_unavailable":
    case "billing_unavailable":
    case "agent_unavailable":
    case "upstream_error":
      code = "temporarily_unavailable";
      break;
    case "conflict":
      code = "connection_interrupted";
      break;
    case "not_found":
      code = "response_failed";
      break;
    case "invalid_input":
      code = "response_failed";
      break;
    default:
      code = "unexpected";
  }
  return aqiError(code, context, internalCode);
}

export function providerAqiError(
  kind: "unavailable" | "failed" | "interrupted" | "empty",
  context: AqiErrorContext,
): AqiPublicError {
  if (kind === "unavailable") return aqiError("temporarily_unavailable", context, "provider_unavailable");
  if (kind === "interrupted") return aqiError("connection_interrupted", context, "provider_interrupted");
  if (kind === "empty") return aqiError("response_failed", context, "empty_response");
  return aqiError("response_failed", context, "provider_error");
}

/** Safe structured server log. Never include the raw error, headers, credential or provider body. */
export function logAqiError(error: unknown, context: AqiErrorContext): void {
  const internalCode = error instanceof AppError ? error.code : error instanceof Error ? error.name : "unknown";
  console.error("[aqi] request failed", {
    requestId: context.requestId,
    code: internalCode,
    provider: context.provider ?? null,
    model: context.model ?? null,
    reason: context.reason ?? null,
  });
}
